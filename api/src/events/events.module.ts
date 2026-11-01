import {
  BadRequestException, Controller, Get, HttpCode, HttpException, HttpStatus, Inject, MessageEvent, Module, Post, Query, Req, Sse,
  UnauthorizedException,
} from '@nestjs/common';
import { Observable, filter, interval, map, merge } from 'rxjs';
import { STORE } from '../common/tokens';
import { envNumber, newId, nowIso } from '../common/util';
import { Store } from '../persistence/store.port';
import { EventBus } from './event-bus';
import { OutboxRelay } from './outbox-relay.service';
import { EVENT_ID_HEADER, SIGNATURE_HEADER, verify } from './signer';
import { AllowQueryApiKey, Public } from '../security/security.guards';

interface RawRequest { rawBody?: Buffer; headers: Record<string, string | string[] | undefined> }
interface ClientRequest { ip?: string; socket?: { remoteAddress?: string } }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Live stream for the dashboard (API key required, see security.guards).
 * - `?taskId=<uuid>` narrows the stream to one task (heartbeats still flow).
 * - Open streams are capped per client IP (SSE_MAX_PER_CLIENT) and in total
 *   (SSE_MAX_CONNECTIONS); past the cap the request gets 429.
 * The bus is in process: with several replicas each stream only carries the events
 * of the replica it is connected to.
 */
@Controller()
export class EventsController {
  private readonly perClient = new Map<string, number>();
  private open = 0;
  private readonly maxPerClient = envNumber('SSE_MAX_PER_CLIENT', 20);
  private readonly maxTotal = envNumber('SSE_MAX_CONNECTIONS', 200);

  constructor(private readonly bus: EventBus) {}

  /** Heartbeat keeps proxies from closing the connection. */
  @AllowQueryApiKey()
  @Sse('events')
  events(@Req() req: ClientRequest, @Query('taskId') taskId?: string): Observable<MessageEvent> {
    if (taskId !== undefined && !UUID.test(taskId)) throw new BadRequestException(['taskId deve ser um UUID']);
    const client = req.ip ?? req.socket?.remoteAddress ?? 'unknown';
    if (this.open >= this.maxTotal || (this.perClient.get(client) ?? 0) >= this.maxPerClient) {
      throw new HttpException('Conexões de eventos demais: feche outras abas do dashboard', HttpStatus.TOO_MANY_REQUESTS);
    }
    const live = this.bus.stream().pipe(filter((e) => !taskId || e.taskId === taskId), map((e) => ({ data: e })));
    const heartbeat = interval(15_000).pipe(map(() => ({ data: { type: 'heartbeat', taskId: null, payload: {}, at: nowIso() } })));
    return new Observable<MessageEvent>((sub) => {
      this.open++;
      this.perClient.set(client, (this.perClient.get(client) ?? 0) + 1);
      const inner = merge(live, heartbeat).subscribe(sub);
      return () => {
        inner.unsubscribe();
        this.open--;
        const left = (this.perClient.get(client) ?? 1) - 1;
        if (left > 0) this.perClient.set(client, left);
        else this.perClient.delete(client);
      };
    });
  }
}

/**
 * Demo receiver for signed events: verifies the HMAC over the raw body and stores the delivery.
 * A missing or invalid signature is a 401 and nothing is stored, so anonymous requests
 * cannot grow the inbox or show up next to real events. Body size is bounded by the
 * JSON parser limit (100 kB) and requests by the global rate limit.
 * Idempotent: the relay is at-least-once, so a redelivery (same X-JP-Event-Id) answers 200
 * with duplicate=true and is not stored again. Only an event whose header matches the
 * signed body id is deduped.
 */
@Controller('webhooks')
export class WebhooksController {
  constructor(@Inject(STORE) private readonly store: Store, private readonly relay: OutboxRelay) {}

  /** Public: authenticated by the HMAC signature, not by the API key. */
  @Public()
  @Post('inbox')
  @HttpCode(200)
  async receive(@Req() req: RawRequest) {
    const raw = req.rawBody?.toString('utf8') ?? '';
    const signature = String(req.headers[SIGNATURE_HEADER] ?? '');
    if (!verify(this.relay.secret, raw, signature)) throw new UnauthorizedException('Assinatura ausente ou inválida');
    let payload: Record<string, unknown> = {};
    try { payload = JSON.parse(raw); } catch { payload = { raw }; }
    const headerId = req.headers[EVENT_ID_HEADER];
    const eventId = typeof headerId === 'string' && headerId === payload.id ? headerId : null;
    const stored = await this.store.addInbox({
      id: newId(), eventId, event: String(payload.type ?? req.headers['x-jp-event'] ?? 'unknown'),
      verified: true, signature, payload, receivedAt: nowIso(),
    });
    return { received: true, verified: true, duplicate: !stored };
  }

  @Get('inbox')
  inbox() {
    return this.store.listInbox(50);
  }
}

@Module({ controllers: [EventsController, WebhooksController], providers: [OutboxRelay], exports: [OutboxRelay] })
export class EventsModule {}
