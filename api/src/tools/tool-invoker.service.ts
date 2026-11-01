import { Inject, Injectable } from '@nestjs/common';
import { OutboxEvent } from '../common/types';
import { STORE, TOOL_REGISTRY } from '../common/tokens';
import { retryConfig } from '../common/retry-horizon';
import { DomainError } from '../common/errors';
import { canonicalJson, newId, nowIso, sha256, sleep, TimeoutError, withTimeout } from '../common/util';
import { Store } from '../persistence/store.port';
import { KeyedStrategy, StrategyRegistry } from '../strategy/strategy-registry';

/** Passed to every handler run. */
export interface ToolContext {
  /**
   * Stable across retries of the same call, including a re-run after a crash.
   * Handlers with external side effects must forward it (e.g. as an
   * Idempotency-Key header) so the downstream system applies the effect once.
   */
  idempotencyKey: string;
  /** 1 on the first run; greater than 1 when a previous attempt crashed or failed. */
  attempt: number;
}

/** A tool a subagent can call. Side effects must be idempotent on ctx.idempotencyKey. */
export interface ToolHandler extends KeyedStrategy {
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<Record<string, unknown>>;
}

/** Another worker kept a live lease on this call for longer than one lease. Retry later. */
export class ToolCallInProgressError extends DomainError {
  constructor(readonly key: string) {
    super(`Ferramenta com Idempotency-Key ${key} ainda em execução`);
  }
}

/** The call ran out of attempts or outlived its idempotency key: re-running it is no longer safe. */
export class ToolCallRefusedError extends DomainError {
  constructor(readonly key: string, reason: string) {
    super(`Ferramenta com Idempotency-Key ${key} recusada: ${reason}`);
  }
}

export interface ToolInvocation {
  taskId: string;
  subtaskId: string | null;
  tool: string;
  args: Record<string, unknown>;
  /** Optional explicit key; default is a hash of (task, subtask, tool, args). */
  idempotencyKey?: string;
}

export const outboxEvent = (type: string, payload: Record<string, unknown>): OutboxEvent => ({
  id: newId(), type, payload, status: 'pending', attempts: 0,
  nextAttemptAt: nowIso(), createdAt: nowIso(), deliveredAt: null, lastError: null,
});

/**
 * Idempotency-Key + transactional outbox for tool calls.
 * 1. Claim: a 'started' row with a lease is persisted before the handler runs.
 * 2. Execute: the handler gets ctx.idempotencyKey and must apply side effects idempotently.
 *    It is bounded by the lease, so the owner gives up before another worker may take over.
 * 3. Complete: result + outbox event are written in one transaction, fenced by the attempt.
 * A retry with the same key returns the stored result. If a process died between
 * the effect and step 3, the retry finds the 'started' row, waits for the lease to
 * expire (at most one lease), then reconciles by re-running the handler with the same key.
 * TOOL_LEASE_MS (default 10s) must stay below SUBAGENT_TIMEOUT_MS (30s) so a resumed
 * subagent can wait out a dead owner's lease.
 * A claim beyond TOOL_MAX_ATTEMPTS, or on a call first started more than
 * IDEMPOTENCY_KEY_TTL_MS ago, is refused (ToolCallRefusedError) without running the handler.
 */
@Injectable()
export class ToolInvoker {
  executions = 0;
  private readonly cfg = retryConfig();
  private readonly leaseMs = this.cfg.toolLeaseMs;

  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(TOOL_REGISTRY) private readonly tools: StrategyRegistry<ToolHandler>,
  ) {}

  static keyFor(inv: ToolInvocation): string {
    return inv.idempotencyKey ?? sha256(canonicalJson([inv.taskId, inv.subtaskId, inv.tool, inv.args]));
  }

  async invoke(inv: ToolInvocation): Promise<{ result: Record<string, unknown>; replay: boolean; key: string }> {
    const key = ToolInvoker.keyFor(inv);
    const existing = await this.store.findToolCall(key);
    if (existing?.status === 'completed') return { result: existing.result!, replay: true, key };

    const handler = this.tools.resolve(inv.tool);
    const claimed = await this.claim(inv, key);
    if ('result' in claimed) return { result: claimed.result, replay: true, key };
    const { attempt } = claimed;
    const refusal = attempt > this.cfg.toolMaxAttempts
      ? `tentativa ${attempt} excede TOOL_MAX_ATTEMPTS (${this.cfg.toolMaxAttempts})`
      : Date.now() - Date.parse(claimed.createdAt) > this.cfg.idempotencyKeyTtlMs
        ? `iniciada em ${claimed.createdAt}, há mais de IDEMPOTENCY_KEY_TTL_MS (${this.cfg.idempotencyKeyTtlMs}ms)`
        : null;
    if (refusal) {
      await this.store.releaseToolCall(key, attempt).catch(() => undefined);
      throw new ToolCallRefusedError(key, refusal);
    }

    this.executions++;
    let result: Record<string, unknown>;
    try {
      result = await withTimeout(handler.execute(inv.args, { idempotencyKey: key, attempt }), this.leaseMs, `ferramenta ${inv.tool}`);
    } catch (err) {
      // A timed out handler may still be running: keep its lease so nobody overlaps it.
      if (!(err instanceof TimeoutError)) await this.store.releaseToolCall(key, attempt).catch(() => undefined);
      throw err;
    }
    const saved = await this.store.completeToolCallWithOutbox(
      key, attempt, result,
      outboxEvent('tool.executed', { taskId: inv.taskId, tool: inv.tool, idempotencyKey: key, result }),
    );
    if (saved.status !== 'completed') throw new ToolCallInProgressError(key);
    return { result: saved.result!, replay: saved.attempts !== attempt, key };
  }

  /**
   * Claims the call, waiting (at most about one lease) while another worker holds a live lease.
   * Returns the attempt number and when the call first started, or the stored result if the call completed meanwhile.
   */
  private async claim(inv: ToolInvocation, key: string): Promise<{ attempt: number; createdAt: string } | { result: Record<string, unknown> }> {
    const deadline = Date.now() + this.leaseMs + 1_000;
    for (;;) {
      const claim = await this.store.claimToolCall({
        idempotencyKey: key, taskId: inv.taskId, subtaskId: inv.subtaskId, tool: inv.tool, args: inv.args, createdAt: nowIso(),
      }, this.leaseMs);
      if (claim) return { attempt: claim.attempts, createdAt: claim.createdAt };
      const current = await this.store.findToolCall(key);
      if (current?.status === 'completed') return { result: current.result! };
      if (Date.now() >= deadline) throw new ToolCallInProgressError(key);
      const leaseLeft = current?.leaseUntil ? Date.parse(current.leaseUntil) - Date.now() : 0;
      await sleep(Math.min(Math.max(leaseLeft + 10, 50), 1_000, Math.max(deadline - Date.now(), 1)));
    }
  }
}
