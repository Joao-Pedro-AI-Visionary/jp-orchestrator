import { OutboxEvent } from '../common/types';
import { MemoryStore } from '../persistence/memory.store';
import { crashOn, ProcessCrash } from '../test-utils/crash';
import { outboxEvent } from '../tools/tool-invoker.service';
import { EventBus } from './event-bus';
import { WebhooksController } from './events.module';
import { HttpPost, OutboxRelay } from './outbox-relay.service';
import { verify } from './signer';

/** Enqueues an event the way production does: in the same transaction as a completed tool call. */
async function enqueue(store: MemoryStore): Promise<OutboxEvent> {
  const ev = outboxEvent('task.completed', { taskId: 't1' });
  await store.claimToolCall({ idempotencyKey: ev.id, taskId: 't1', subtaskId: null, tool: 'x', args: {}, createdAt: ev.createdAt }, 1000);
  await store.completeToolCallWithOutbox(ev.id, 1, {}, ev);
  return ev;
}

describe('OutboxRelay', () => {
  afterEach(() => jest.useRealTimers());

  it('delivers signed events once and marks them delivered', async () => {
    const store = new MemoryStore();
    const sent: { body: string; headers: Record<string, string> }[] = [];
    const post: HttpPost = async (_u, body, headers) => { sent.push({ body, headers }); return { status: 200 }; };
    const relay = new OutboxRelay(store, new EventBus(), post);
    const ev = await enqueue(store);

    expect(await relay.tick()).toBe(1);
    expect(await relay.tick()).toBe(0);
    expect(sent).toHaveLength(1);
    expect(verify(relay.secret, sent[0].body, sent[0].headers['x-jp-signature'])).toBe(true);
    expect(sent[0].headers['x-jp-event-id']).toBe(ev.id);
    expect(sent[0].headers['idempotency-key']).toBe(ev.id);
    expect((await store.listOutbox())[0].status).toBe('delivered');
  });

  it('retries with backoff and goes dead after max attempts', async () => {
    process.env.OUTBOX_MAX_ATTEMPTS = '1';
    const store = new MemoryStore();
    const relay = new OutboxRelay(store, new EventBus(), async () => ({ status: 500 }));
    delete process.env.OUTBOX_MAX_ATTEMPTS;
    await enqueue(store);
    expect(await relay.tick()).toBe(0);
    const [stored] = await store.listOutbox();
    expect(stored.status).toBe('dead');
    expect(stored.lastError).toBe('HTTP 500');
  });

  it('an event older than OUTBOX_MAX_AGE_MS goes dead as expired without being sent', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-31T12:00:00Z') });
    const store = new MemoryStore();
    const sent: string[] = [];
    const relay = new OutboxRelay(store, new EventBus(), async (_u, body) => { sent.push(body); return { status: 200 }; });
    await enqueue(store);

    jest.setSystemTime(Date.now() + 600_001);
    expect(await relay.tick()).toBe(0);
    expect(sent).toHaveLength(0);
    expect((await store.listOutbox())[0]).toMatchObject({ status: 'dead', attempts: 0, lastError: 'expired', deliveredAt: null });
    expect(await relay.tick()).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('crash between webhook 2xx and the delivered mark: redelivery after the lease keeps the same ids and the receiver stores the event once', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-31T12:00:00Z') });
    const db = new MemoryStore();
    const receiverDb = new MemoryStore();
    const bus = new EventBus();
    const sent: Record<string, string>[] = [];
    const responses: { duplicate: boolean; verified: boolean }[] = [];
    // The receiver is another service with its own database and the same shared secret.
    const receiver = new WebhooksController(receiverDb, new OutboxRelay(receiverDb, bus, async () => ({ status: 200 })));
    const post: HttpPost = async (_u, body, headers) => {
      sent.push(headers);
      responses.push(await receiver.receive({ rawBody: Buffer.from(body), headers }));
      return { status: 200 };
    };
    const ev = await enqueue(db);

    // Process A: the webhook answers 2xx, then the process dies before updateOutbox.
    const relayA = new OutboxRelay(crashOn(db, 'updateOutbox'), bus, post);
    await expect(relayA.tick()).rejects.toBeInstanceOf(ProcessCrash);
    expect(sent).toHaveLength(1);
    expect((await db.listOutbox())[0]).toMatchObject({ status: 'pending', attempts: 0 });

    // Process B starts while the 30s lease is still held: nothing is resent.
    const relayB = new OutboxRelay(db, bus, post);
    expect(await relayB.tick()).toBe(0);
    expect(sent).toHaveLength(1);

    // Lease expires: at-least-once resend with the same event id and Idempotency-Key.
    jest.setSystemTime(Date.now() + 30_001);
    expect(await relayB.tick()).toBe(1);
    expect(sent).toHaveLength(2);
    for (const h of sent) {
      expect(h['x-jp-event-id']).toBe(ev.id);
      expect(h['idempotency-key']).toBe(ev.id);
    }
    expect(responses).toEqual([{ received: true, verified: true, duplicate: false }, { received: true, verified: true, duplicate: true }]);
    const inbox = await receiverDb.listInbox(50);
    expect(inbox).toHaveLength(1);
    expect(inbox[0].eventId).toBe(ev.id);
    expect((await db.listOutbox())[0]).toMatchObject({ status: 'delivered', attempts: 1 });
  });
});
