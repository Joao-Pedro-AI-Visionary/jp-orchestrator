import { Inject, Injectable } from '@nestjs/common';
import { DomainError } from '../common/errors';
import { Usage } from '../common/types';
import { STORE } from '../common/tokens';
import { newId, nowIso, round6 } from '../common/util';
import { EventBus } from '../events/event-bus';
import { Store, UsageBucket } from '../persistence/store.port';

export class BudgetExceededError extends DomainError {
  constructor(readonly taskId: string, readonly spentUsd: number, readonly budgetUsd: number) {
    super(`Orçamento estourado: gasto ${spentUsd.toFixed(6)} + estimativa > limite ${budgetUsd.toFixed(6)} USD`);
  }
}

export type UsageInput = Omit<Usage, 'id' | 'createdAt'>;

/** Rounds a cost estimate up to the 6 decimals stored, so a reservation never undershoots. */
const ceil6 = (n: number): number => Math.ceil(n * 1e6 - 1e-6) / 1e6;

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

  /** Aggregated by the store (GROUP BY in Postgres): the cost no longer grows with every call ever made. */
  async summary() {
    const tasks = await this.store.listTasks(200);
    const agg = await this.store.usageSummary(tasks.map((t) => t.id));
    const sorted = (list: UsageBucket[]) => [...list].sort((a, b) => b.costUsd - a.costUsd)
      .map(({ key, ...b }) => ({ key, tokens: b.tokens, costUsd: round6(b.costUsd), calls: b.calls }));
    const tokensByTask = new Map(agg.byTask.map((b) => [b.key, b.tokens]));
    return {
      totals: { ...agg.totals, costUsd: round6(agg.totals.costUsd), savedUsd: round6(agg.totals.savedUsd) },
      byModel: sorted(agg.byModel).map(({ key, ...b }) => ({ model: key, ...b })),
      byAgent: sorted(agg.byAgent).map(({ key, ...b }) => ({ agent: key, ...b })),
      byTask: tasks.map((t) => ({
        taskId: t.id, title: t.title, status: t.status, costUsd: t.spentUsd, budgetUsd: t.budgetUsd,
        tokens: tokensByTask.get(t.id) ?? 0,
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
