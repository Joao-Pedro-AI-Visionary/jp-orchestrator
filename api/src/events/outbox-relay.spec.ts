import { MemoryStore } from '../persistence/memory.store';
import { outboxEvent } from '../tools/tool-invoker.service';
import { EventBus } from './event-bus';
import { HttpPost, OutboxRelay } from './outbox-relay.service';
import { verify } from './signer';

describe('OutboxRelay', () => {
  it('delivers signed events once and marks them delivered', async () => {
    const store = new MemoryStore();
    const sent: { body: string; headers: Record<string, string> }[] = [];
    const post: HttpPost = async (_u, body, headers) => { sent.push({ body, headers }); return { status: 200 }; };
    const relay = new OutboxRelay(store, new EventBus(), post);
    const ev = outboxEvent('task.completed', { taskId: 't1' });
    await store.saveToolCallWithOutbox(
      { idempotencyKey: 'k', taskId: 't1', subtaskId: null, tool: 'x', args: {}, result: {}, createdAt: ev.createdAt }, ev);

    expect(await relay.tick()).toBe(1);
    expect(await relay.tick()).toBe(0);
    expect(sent).toHaveLength(1);
    expect(verify(relay.secret, sent[0].body, sent[0].headers['x-jp-signature'])).toBe(true);
    expect((await store.listOutbox())[0].status).toBe('delivered');
  });

  it('retries with backoff and goes dead after max attempts', async () => {
    process.env.OUTBOX_MAX_ATTEMPTS = '1';
    const store = new MemoryStore();
    const relay = new OutboxRelay(store, new EventBus(), async () => ({ status: 500 }));
    delete process.env.OUTBOX_MAX_ATTEMPTS;
    const ev = outboxEvent('task.completed', { taskId: 't1' });
    await store.saveToolCallWithOutbox(
      { idempotencyKey: 'k', taskId: 't1', subtaskId: null, tool: 'x', args: {}, result: {}, createdAt: ev.createdAt }, ev);
    expect(await relay.tick()).toBe(0);
    const [stored] = await store.listOutbox();
    expect(stored.status).toBe('dead');
    expect(stored.lastError).toBe('HTTP 500');
  });
});
