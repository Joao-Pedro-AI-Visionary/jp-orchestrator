import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { HTTP_POST, STORE } from '../common/tokens';
import { envNumber, nowIso, withTimeout } from '../common/util';
import { Store } from '../persistence/store.port';
import { EventBus } from './event-bus';
import { sign } from './signer';

export type HttpPost = (url: string, body: string, headers: Record<string, string>) => Promise<{ status: number }>;

export const fetchPost: HttpPost = async (url, body, headers) => {
  const res = await fetch(url, { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } });
  return { status: res.status };
};

/**
 * Outbox relay loop.
 * Objective: deliver every outbox event to the webhook, signed with HMAC.
 * Exit: event delivered (2xx) or dead after OUTBOX_MAX_ATTEMPTS.
 * Timeout: OUTBOX_TIMEOUT_MS per delivery. Backoff: 2^attempts seconds.
 * At-least-once: receivers dedupe by X-JP-Event-Id.
 */
@Injectable()
export class OutboxRelay implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(OutboxRelay.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  readonly url = process.env.WEBHOOK_URL ?? 'http://localhost:3001/webhooks/inbox';
  readonly secret = process.env.WEBHOOK_SECRET ?? 'dev-secret-change-me';
  private readonly maxAttempts = envNumber('OUTBOX_MAX_ATTEMPTS', 5);
  private readonly timeoutMs = envNumber('OUTBOX_TIMEOUT_MS', 5000);

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

  /** One relay pass. Returns how many events were delivered. */
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let delivered = 0;
    try {
      for (const ev of await this.store.claimOutbox(20, 30_000)) {
        const body = JSON.stringify({ id: ev.id, type: ev.type, createdAt: ev.createdAt, data: ev.payload });
        try {
          const res = await withTimeout(this.post(this.url, body, {
            'x-jp-signature': sign(this.secret, body),
            'x-jp-event': ev.type,
            'x-jp-event-id': ev.id,
          }), this.timeoutMs, 'webhook');
          if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
          await this.store.updateOutbox(ev.id, { status: 'delivered', attempts: ev.attempts + 1, deliveredAt: nowIso(), lastError: null });
          this.bus.emit('webhook.delivered', (ev.payload.taskId as string) ?? null, { eventId: ev.id, type: ev.type });
          delivered++;
        } catch (err) {
          const attempts = ev.attempts + 1;
          const dead = attempts >= this.maxAttempts;
          await this.store.updateOutbox(ev.id, {
            attempts, status: dead ? 'dead' : 'pending', lastError: (err as Error).message,
            nextAttemptAt: new Date(Date.now() + 2 ** attempts * 1000).toISOString(),
          });
          if (dead) this.log.warn(`Evento ${ev.id} (${ev.type}) morto após ${attempts} tentativas`);
        }
      }
    } finally {
      this.running = false;
    }
    return delivered;
  }
}
