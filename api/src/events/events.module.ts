import { Controller, Get, HttpCode, Inject, MessageEvent, Module, Post, Req, Sse, UnauthorizedException } from '@nestjs/common';
import { Observable, interval, map, merge } from 'rxjs';
import { KeyInQuery, Public } from '../auth/auth.decorators';
import { STORE } from '../common/tokens';
import { newId, nowIso } from '../common/util';
import { Store } from '../persistence/store.port';
import { EventBus } from './event-bus';
import { OutboxRelay } from './outbox-relay.service';
import { EVENT_ID_HEADER, SIGNATURE_HEADER, verify } from './signer';

interface RawRequest { rawBody?: Buffer; headers: Record<string, string | string[] | undefined> }

@Controller()
export class EventsController {
  constructor(private readonly bus: EventBus) {}

  /**
   * Live stream for the dashboard (viewer). EventSource cannot send headers, so the key may also
   * come as ?api_key= or the jp_api_key cookie. Heartbeat keeps proxies from closing the connection.
   */
  @Sse('events')
  @KeyInQuery()
  events(): Observable<MessageEvent> {
    const live = this.bus.stream().pipe(map((e) => ({ data: e })));
    const heartbeat = interval(15_000).pipe(map(() => ({ data: { type: 'heartbeat', taskId: null, payload: {}, at: nowIso() } })));
    return merge(live, heartbeat);
  }
}

/**
 * Demo receiver for signed events: verifies the HMAC over the raw body and stores the delivery.
 * A request whose signature does not verify gets 401 and is never stored (no disk filling by
 * unauthenticated callers; the relay retries it, so a secret mismatch shows up as dead events).
 * Idempotent: the relay is at-least-once, so a redelivery (same X-JP-Event-Id) answers 200
 * with duplicate=true and is not stored again. Only an event whose header matches the
 * signed body id is deduped, so a replayed signature with another header id cannot shadow it.
 */
@Controller('webhooks')
export class WebhooksController {
  constructor(@Inject(STORE) private readonly store: Store, private readonly relay: OutboxRelay) {}

  @Post('inbox')
  @Public()
  @HttpCode(200)
  async receive(@Req() req: RawRequest) {
    const raw = req.rawBody?.toString('utf8') ?? '';
    const signature = String(req.headers[SIGNATURE_HEADER] ?? '');
    const verified = verify(this.relay.secret, raw, signature);
    if (!verified) throw new UnauthorizedException('Assinatura inválida: evento não armazenado');
    let payload: Record<string, unknown> = {};
    try { payload = JSON.parse(raw); } catch { payload = { raw }; }
    const headerId = req.headers[EVENT_ID_HEADER];
    const eventId = typeof headerId === 'string' && headerId === payload.id ? headerId : null;
    const stored = await this.store.addInbox({
      id: newId(), eventId, event: String(payload.type ?? req.headers['x-jp-event'] ?? 'unknown'),
      verified, signature, payload, receivedAt: nowIso(),
    });
    return { received: true, verified, duplicate: !stored };
  }

  @Get('inbox')
  inbox() {
    return this.store.listInbox(50);
  }
}

@Module({ controllers: [EventsController, WebhooksController], providers: [OutboxRelay], exports: [OutboxRelay] })
export class EventsModule {}
