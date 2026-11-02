import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { HTTP_POST, STORE } from '../common/tokens';
import { retryConfig } from '../common/retry-horizon';
import { webhookSecret } from '../auth/auth.config';
import { envNumber, nowIso, withTimeout } from '../common/util';
import { OutboxEvent } from '../common/types';
import { Store } from '../persistence/store.port';
import { EventBus } from './event-bus';
import { EVENT_ID_HEADER, sign } from './signer';

export type HttpPost = (url: string, body: string, headers: Record<string, string>) => Promise<{ status: number }>;

export const fetchPost: HttpPost = async (url, body, headers) => {
  const res = await fetch(url, { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } });
  return { status: res.status };
};

/**
 * Outbox relay loop.
 * Objective: deliver every outbox event to the webhook, signed with HMAC.
 * Exit: event delivered (2xx), dead after OUTBOX_MAX_ATTEMPTS, or dead as 'expired'
 * once older than OUTBOX_MAX_AGE_MS (checked before every send).
 * Timeout: OUTBOX_TIMEOUT_MS per delivery. Backoff: 2^attempts seconds.
 * At-least-once: a crash after the POST and before the 'delivered' mark resends the same
 * event once the OUTBOX_CLAIM_LEASE_MS lease (30s) expires. A batch is sent in parallel, so a
 * slow batch cannot outlive the lease (it ends within one OUTBOX_TIMEOUT_MS).
 * Every send carries the same X-JP-Event-Id and Idempotency-Key (the event id);
 * receivers dedupe on it. assertRetryHorizon keeps every resend inside the key TTL.
 */
@Injectable()
export class OutboxRelay implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(OutboxRelay.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  readonly url = process.env.WEBHOOK_URL ?? 'http://localhost:3001/webhooks/inbox';
  /** The public default is refused with NODE_ENV=production (webhookSecret throws). */
  readonly secret = webhookSecret();
  private readonly cfg = retryConfig();
  readonly batchSize = envNumber('OUTBOX_BATCH', 20);

  constructor(
    @Inject(STORE) private readonly store: Store,
    private readonly bus: EventBus,
    @Inject(HTTP_POST) private readonly post: HttpPost,
  ) {}

  onModuleInit() {
    if (process.env.OUTBOX_RELAY === 'off') return;
    this.timer = setInterval(() => void this.tick(), envNumber('OUTBOX_POLL_MS', 500));
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * One relay pass. The claimed batch (OUTBOX_BATCH, 20) is sent in parallel, each send bounded
   * by OUTBOX_TIMEOUT_MS, so the whole pass ends within one timeout and the claim lease
   * (OUTBOX_CLAIM_LEASE_MS, which boot requires to be at least twice the timeout) never expires
   * mid-batch whatever the batch size: no event is resent while its first send is still running.
   * Returns how many events were delivered.
   */
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const batch = await this.store.claimOutbox(this.batchSize, this.cfg.outboxClaimLeaseMs);
      // allSettled: a failed status write must not end the pass (and free `running`) while other sends still run.
      const sent = await Promise.allSettled(batch.map((ev) => this.deliver(ev)));
      const failed = sent.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failed) throw failed.reason;
      return sent.filter((r) => r.status === 'fulfilled' && r.value).length;
    } finally {
      this.running = false;
    }
  }

  private async deliver(ev: OutboxEvent): Promise<boolean> {
    if (Date.now() - Date.parse(ev.createdAt) > this.cfg.outboxMaxAgeMs) {
      await this.store.updateOutbox(ev.id, { status: 'dead', lastError: 'expired' });
      this.log.warn(`Evento ${ev.id} (${ev.type}) expirado: mais antigo que OUTBOX_MAX_AGE_MS, não reenviado`);
      return false;
    }
    const body = JSON.stringify({ id: ev.id, type: ev.type, createdAt: ev.createdAt, data: ev.payload });
    try {
      const res = await withTimeout(this.post(this.url, body, {
        'x-jp-signature': sign(this.secret, body),
        'x-jp-event': ev.type,
        [EVENT_ID_HEADER]: ev.id,
        'idempotency-key': ev.id,
      }), this.cfg.outboxTimeoutMs, 'webhook');
      if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
      await this.store.updateOutbox(ev.id, { status: 'delivered', attempts: ev.attempts + 1, deliveredAt: nowIso(), lastError: null });
      this.bus.emit('webhook.delivered', (ev.payload.taskId as string) ?? null, { eventId: ev.id, type: ev.type });
      return true;
    } catch (err) {
      const attempts = ev.attempts + 1;
      const dead = attempts >= this.cfg.outboxMaxAttempts;
      await this.store.updateOutbox(ev.id, {
        attempts, status: dead ? 'dead' : 'pending', lastError: (err as Error).message,
        nextAttemptAt: new Date(Date.now() + 2 ** attempts * 1000).toISOString(),
      });
      if (dead) this.log.warn(`Evento ${ev.id} (${ev.type}) morto após ${attempts} tentativas`);
      return false;
    }
  }
}
