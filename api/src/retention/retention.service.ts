import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { retryConfig } from '../common/retry-horizon';
import { STORE } from '../common/tokens';
import { envNumber } from '../common/util';
import { PruneResult, Store } from '../persistence/store.port';

export const RETENTION_CONFIG = Symbol('RETENTION_CONFIG');

export interface RetentionConfig {
  /** RETENTION_MS (7 days): rows older than this are pruned. Must be >= IDEMPOTENCY_KEY_TTL_MS. */
  retentionMs: number;
  /** RETENTION_INTERVAL_MS (1 h) between passes. */
  intervalMs: number;
  /** RETENTION=off disables the job. */
  enabled: boolean;
}

export const retentionConfig = (env: NodeJS.ProcessEnv = process.env): RetentionConfig => ({
  retentionMs: envNumber('RETENTION_MS', 7 * 86_400_000, env),
  intervalMs: envNumber('RETENTION_INTERVAL_MS', 3_600_000, env),
  enabled: env.RETENTION !== 'off',
});

/**
 * A pruned row is a forgotten dedupe key: webhook_inbox.event_id, tool_calls.idempotency_key and
 * the step journal all answer "already done" for redeliveries and retries, which can arrive until
 * the idempotency key TTL. Retention shorter than that would apply an effect twice.
 */
export function assertRetentionConfig(c: RetentionConfig, ttlMs = retryConfig().idempotencyKeyTtlMs): void {
  for (const [name, v] of [['RETENTION_MS', c.retentionMs], ['RETENTION_INTERVAL_MS', c.intervalMs]] as const) {
    if (!Number.isInteger(v) || v <= 0) throw new Error(`${name} deve ser um inteiro positivo (recebido: ${v})`);
  }
  if (c.retentionMs < ttlMs) {
    throw new Error(`RETENTION_MS (${c.retentionMs}ms) < IDEMPOTENCY_KEY_TTL_MS (${ttlMs}ms): uma reentrega ainda no prazo da chave seria aplicada de novo`);
  }
}

/**
 * Retention job: every RETENTION_INTERVAL_MS deletes webhook_inbox, finished tool_calls and
 * step_journal rows older than RETENTION_MS. Rows of a task that may still run or be resumed
 * (active, awaiting approval, failed) are kept whatever their age (Store.pruneBefore).
 */
@Injectable()
export class RetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(RetentionService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  readonly cfg: RetentionConfig;

  constructor(@Inject(STORE) private readonly store: Store, @Optional() @Inject(RETENTION_CONFIG) cfg?: RetentionConfig) {
    this.cfg = cfg ?? retentionConfig();
    assertRetentionConfig(this.cfg);
  }

  onModuleInit() {
    if (!this.cfg.enabled) return;
    this.timer = setInterval(() => void this.prune().catch((err) => this.log.error(`Retenção: ${(err as Error).message}`)), this.cfg.intervalMs);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** One pass; `now` is injectable for tests. Null when a pass is already running. */
  async prune(now = Date.now()): Promise<PruneResult | null> {
    if (this.running) return null;
    this.running = true;
    try {
      const out = await this.store.pruneBefore(new Date(now - this.cfg.retentionMs).toISOString());
      if (out.webhookInbox + out.toolCalls + out.stepJournal > 0) this.log.log({ msg: 'Retenção aplicada', ...out });
      return out;
    } finally {
      this.running = false;
    }
  }
}
