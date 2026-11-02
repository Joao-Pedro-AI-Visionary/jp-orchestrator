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

/** A reservation held for one gateway call; id is null when the task does not exist (nothing to guard). */
export interface Reservation { id: string | null; taskId: string; amountUsd: number }

const CSV_PAGE = 1000;
export const SUMMARY_PAGE_MAX = 200;

/**
 * Billing ledger: every gateway call becomes a usage record (tokens and cost by
 * task, subagent and model). Budget guard: before each model call the gateway
 * reserves its worst-case cost atomically in the store (spent + reserved + estimate
 * must fit the budget), settles it with the real cost after the call and releases
 * it when the call fails. Concurrent calls of one task can never overspend together.
 */
@Injectable()
export class BillingService {
  budgetBlocks = 0;

  constructor(@Inject(STORE) private readonly store: Store, private readonly bus: EventBus) {}

  /** Throws BudgetExceededError (nothing reserved) when the call would cross the task budget. */
  async reserve(taskId: string, estimatedUsd: number): Promise<Reservation> {
    const amountUsd = round6(Math.max(0, estimatedUsd));
    const id = newId();
    const res = await this.store.reserveBudget(id, taskId, amountUsd);
    if (!res) return { id: null, taskId, amountUsd };
    if (!res.reserved) {
      this.budgetBlocks++;
      throw new BudgetExceededError(taskId, round6(res.spentUsd + res.reservedUsd), res.budgetUsd);
    }
    return { id, taskId, amountUsd };
  }

  /** The call failed: the reserved amount goes back to the budget. Never throws (it runs on error paths). */
  async release(reservation: Reservation | null): Promise<void> {
    if (reservation?.id) await this.store.releaseBudget(reservation.id).catch(() => undefined);
  }

  /** Records usage; with a reservation, settles it in the same transaction. Returns the new task total. */
  async record(input: UsageInput, reservation: Reservation | null = null): Promise<number> {
    const usage: Usage = {
      ...input, id: newId(), createdAt: nowIso(),
      costUsd: round6(input.costUsd), savedUsd: round6(input.savedUsd),
    };
    const spent = await this.store.recordUsage(usage, reservation?.id ?? null);
    this.bus.emit('usage.recorded', usage.taskId, { ...usage, spentUsd: spent });
    return spent;
  }

  /** Aggregated in the store (GROUP BY); byTask is one page of tasks, newest first. */
  async summary(limit = 50, offset = 0) {
    const pageLimit = Math.min(Math.max(1, Math.trunc(limit) || 50), SUMMARY_PAGE_MAX);
    const pageOffset = Math.max(0, Math.trunc(offset) || 0);
    const [agg, tasks] = await Promise.all([this.store.summarizeUsage(), this.store.listTaskCosts(pageLimit, pageOffset)]);
    return { ...agg, byTask: tasks.items, page: { limit: pageLimit, offset: pageOffset, total: tasks.total } };
  }

  /** Reads usage in keyset pages, so the export never loads the whole ledger in one query. */
  async csv(): Promise<string> {
    const lines = ['created_at,task_id,subtask_id,agent,model,prompt_tokens,completion_tokens,cost_usd,saved_usd,cached'];
    for (let after: Usage | null = null; ;) {
      const page = await this.store.listUsagePage(CSV_PAGE, after);
      for (const u of page) {
        lines.push([u.createdAt, u.taskId, u.subtaskId ?? '', u.agent, u.model,
          u.promptTokens, u.completionTokens, u.costUsd.toFixed(6), u.savedUsd.toFixed(6), u.cached].join(','));
      }
      if (page.length < CSV_PAGE) break;
      after = page[page.length - 1];
    }
    return lines.join('\n') + '\n';
  }
}
