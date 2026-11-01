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

/** Rounds a cost estimate up to the 6 decimals stored, so a reservation never undershoots. */
const ceil6 = (n: number): number => Math.ceil(n * 1e6 - 1e-6) / 1e6;

interface Bucket { tokens: number; costUsd: number; calls: number }

/**
 * Billing ledger: every gateway call becomes a usage record (tokens and cost by
 * task, subagent and model). Before each call the gateway reserves the estimated
 * cost atomically (spent + reserved + estimate <= budget), so parallel subagents of
 * one task cannot all pass the check and overspend; the call that would cross the
 * budget is blocked (automatic cut). The reservation is settled with the real cost.
 */
@Injectable()
export class BillingService {
  budgetBlocks = 0;

  constructor(@Inject(STORE) private readonly store: Store, private readonly bus: EventBus) {}

  /** Reserves the estimate or throws BudgetExceededError. Returns the reserved amount. */
  async reserve(taskId: string, estimatedUsd: number): Promise<number> {
    const amount = ceil6(estimatedUsd);
    const r = await this.store.reserveBudget(taskId, amount);
    if (!r.ok) {
      this.budgetBlocks++;
      throw new BudgetExceededError(taskId, r.spentUsd, r.budgetUsd);
    }
    return amount;
  }

  release(taskId: string, reservedUsd: number): Promise<void> {
    return this.store.releaseBudget(taskId, reservedUsd);
  }

  /** Records usage; `reservedUsd` (from reserve) is settled in the same transaction. */
  async record(input: UsageInput, reservedUsd = 0): Promise<number> {
    const usage: Usage = {
      ...input, id: newId(), createdAt: nowIso(),
      costUsd: round6(input.costUsd), savedUsd: round6(input.savedUsd),
    };
    const spent = await this.store.recordUsage(usage, reservedUsd);
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
