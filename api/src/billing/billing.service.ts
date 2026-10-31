import { Inject, Injectable } from '@nestjs/common';
import { Usage } from '../common/types';
import { STORE } from '../common/tokens';
import { newId, nowIso, round6 } from '../common/util';
import { EventBus } from '../events/event-bus';
import { Store } from '../persistence/store.port';

export class BudgetExceededError extends Error {
  constructor(readonly taskId: string, readonly spentUsd: number, readonly budgetUsd: number) {
    super(`Orçamento estourado: gasto ${spentUsd.toFixed(6)} + estimativa > limite ${budgetUsd.toFixed(6)} USD`);
  }
}

export type UsageInput = Omit<Usage, 'id' | 'createdAt'>;

interface Bucket { tokens: number; costUsd: number; calls: number }

/**
 * Billing ledger: every gateway call becomes a usage record (tokens and cost by
 * task, subagent and model). The budget guard runs before each call and blocks
 * the call that would cross the task budget (automatic cut).
 */
@Injectable()
export class BillingService {
  budgetBlocks = 0;

  constructor(@Inject(STORE) private readonly store: Store, private readonly bus: EventBus) {}

  async assertBudget(taskId: string, estimatedUsd: number): Promise<void> {
    const task = await this.store.getTask(taskId);
    if (!task) return;
    if (task.spentUsd + estimatedUsd > task.budgetUsd) {
      this.budgetBlocks++;
      throw new BudgetExceededError(taskId, task.spentUsd, task.budgetUsd);
    }
  }

  async record(input: UsageInput): Promise<number> {
    const usage: Usage = {
      ...input, id: newId(), createdAt: nowIso(),
      costUsd: round6(input.costUsd), savedUsd: round6(input.savedUsd),
    };
    const spent = await this.store.recordUsage(usage);
    this.bus.emit('usage.recorded', usage.taskId, { ...usage, spentUsd: spent });
    return spent;
  }

  async summary() {
    const [usage, tasks] = await Promise.all([this.store.listUsage(), this.store.listTasks(200)]);
    const group = (key: (u: Usage) => string) => {
      const map = new Map<string, Bucket>();
      for (const u of usage) {
        const b = map.get(key(u)) ?? { tokens: 0, costUsd: 0, calls: 0 };
        b.tokens += u.promptTokens + u.completionTokens;
        b.costUsd = round6(b.costUsd + u.costUsd);
        b.calls++;
        map.set(key(u), b);
      }
      return [...map.entries()].sort((a, b) => b[1].costUsd - a[1].costUsd);
    };
    const tokensByTask = new Map(group((u) => u.taskId));
    return {
      totals: {
        tokens: usage.reduce((s, u) => s + u.promptTokens + u.completionTokens, 0),
        costUsd: round6(usage.reduce((s, u) => s + u.costUsd, 0)),
        calls: usage.length,
        cacheHits: usage.filter((u) => u.cached).length,
        savedUsd: round6(usage.reduce((s, u) => s + u.savedUsd, 0)),
      },
      byModel: group((u) => u.model).map(([model, b]) => ({ model, ...b })),
      byAgent: group((u) => u.agent).map(([agent, b]) => ({ agent, ...b })),
      byTask: tasks.map((t) => ({
        taskId: t.id, title: t.title, status: t.status, costUsd: t.spentUsd, budgetUsd: t.budgetUsd,
        tokens: tokensByTask.get(t.id)?.tokens ?? 0,
      })),
    };
  }

  async csv(): Promise<string> {
    const usage = await this.store.listUsage();
    const header = 'created_at,task_id,subtask_id,agent,model,prompt_tokens,completion_tokens,cost_usd,saved_usd,cached';
    const rows = usage.map((u) => [u.createdAt, u.taskId, u.subtaskId ?? '', u.agent, u.model,
      u.promptTokens, u.completionTokens, u.costUsd.toFixed(6), u.savedUsd.toFixed(6), u.cached].join(','));
    return [header, ...rows].join('\n') + '\n';
  }
}
