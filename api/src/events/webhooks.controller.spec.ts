import { UnauthorizedException } from '@nestjs/common';
import { MemoryStore } from '../persistence/memory.store';
import { EventBus } from './event-bus';
import { WebhooksController } from './events.module';
import { OutboxRelay } from './outbox-relay.service';
import { sign } from './signer';

describe('WebhooksController.receive', () => {
  const setup = () => {
    const store = new MemoryStore();
    const relay = new OutboxRelay(store, new EventBus(), async () => ({ status: 200 }));
    return { store, relay, controller: new WebhooksController(store, relay) };
  };
  const delivery = (secret: string, id: string, headerId = id, signature?: string) => {
    const body = JSON.stringify({ id, type: 'task.completed', createdAt: '2026-10-31T12:00:00.000Z', data: {} });
    return {
      rawBody: Buffer.from(body),
      headers: { 'x-jp-signature': signature ?? sign(secret, body), 'x-jp-event': 'task.completed', 'x-jp-event-id': headerId },
    };
  };

  it('stores a redelivered event once and answers the replay as a duplicate', async () => {
    const { store, relay, controller } = setup();
    expect(await controller.receive(delivery(relay.secret, 'e1'))).toEqual({ received: true, verified: true, duplicate: false });
    expect(await controller.receive(delivery(relay.secret, 'e1'))).toEqual({ received: true, verified: true, duplicate: true });
    expect(await controller.receive(delivery(relay.secret, 'e2'))).toEqual({ received: true, verified: true, duplicate: false });
    expect((await store.listInbox(50)).map((e) => e.eventId)).toEqual(['e2', 'e1']);
  });

  it('rejects an unsigned or badly signed request with 401 and stores nothing (M2)', async () => {
    const { store, relay, controller } = setup();
    await expect(controller.receive(delivery(relay.secret, 'e1', 'e1', 't=1,v1=bad'))).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(controller.receive(delivery(relay.secret, 'e1', 'e1', ''))).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(controller.receive(delivery('another-secret-0123456789abcdef0123', 'e1'))).rejects.toBeInstanceOf(UnauthorizedException);
    expect(await store.listInbox(50)).toHaveLength(0);
  });

  it('does not dedupe on a mismatched event id header, so it cannot shadow a real event', async () => {
    const { store, relay, controller } = setup();
    expect(await controller.receive(delivery(relay.secret, 'e1', 'other'))).toMatchObject({ verified: true, duplicate: false });
    expect(await controller.receive(delivery(relay.secret, 'e1'))).toEqual({ received: true, verified: true, duplicate: false });
    const inbox = await store.listInbox(50);
    expect(inbox).toHaveLength(2);
    expect(inbox.filter((e) => e.eventId === 'e1')).toHaveLength(1);
  });
});
