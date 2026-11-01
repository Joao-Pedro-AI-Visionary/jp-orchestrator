import { OutboxEvent, Task } from '../common/types';
import { newId, nowIso } from '../common/util';
import { assertMemoryStoreAllowed } from '../infrastructure.module';
import { InMemorySharedMemory } from '../memory/shared-memory';
import { MemoryStore } from './memory.store';

const task = (i: number): Task => ({
  id: newId(), title: `t${i}`, description: 'd', status: 'running', budgetUsd: 1, spentUsd: 0, requiresApproval: false,
  correctionRounds: 0, result: null, error: null, createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), updatedAt: nowIso(),
});
const event = (taskId: string): OutboxEvent => ({
  id: newId(), type: 'task.completed', payload: { taskId }, status: 'pending', attempts: 0,
  nextAttemptAt: nowIso(), createdAt: nowIso(), deliveredAt: null, lastError: null,
});

describe('Bounded in-memory adapters (L7)', () => {
  it('drops the oldest finished tasks and their rows past maxTasks, never an active one', async () => {
    const store = new MemoryStore(2);
    const [a, b, c] = [task(1), task(2), task(3)];
    for (const t of [a, b, c]) await store.createTask(t, null);
    await store.recordUsage({ id: newId(), taskId: a.id, subtaskId: null, agent: 'coder', model: 'm', promptTokens: 1, completionTokens: 1, costUsd: 0.1, savedUsd: 0, cached: false, createdAt: nowIso() });
    await store.putStep(a.id, 'plan', []);
    await store.finishTask(b.id, { status: 'completed' }, event(b.id)); // 3 tasks, but a is still active
    expect(await store.getTask(a.id)).not.toBeNull();
    expect(await store.getTask(b.id)).toBeNull();
    await store.finishTask(a.id, { status: 'failed' }, event(a.id));
    expect(await store.getTask(c.id)).not.toBeNull(); // 2 left: nothing more to drop
    await store.createTask(task(4), null);
    await store.finishTask(c.id, { status: 'completed' }, event(c.id));
    expect(await store.getTask(a.id)).toBeNull();
    expect(await store.listUsage(a.id)).toEqual([]);
    expect(await store.getStep(a.id, 'plan')).toBeNull();
  });

  it('keeps the newest inbox entries only', async () => {
    const store = new MemoryStore();
    for (let i = 0; i < 510; i++) {
      await store.addInbox({ id: newId(), eventId: `e${i}`, event: 'x', verified: true, signature: 's', payload: {}, receivedAt: nowIso() });
    }
    const inbox = await store.listInbox(1000);
    expect(inbox).toHaveLength(500);
    expect(inbox[0].eventId).toBe('e509');
  });

  it('shared memory keeps the most recently written tasks', async () => {
    const mem = new InMemorySharedMemory(2);
    await mem.write('a', 'k', 'v', 'x');
    await mem.write('b', 'k', 'v', 'x');
    await mem.write('a', 'k2', 'v', 'x'); // a is now the most recent
    await mem.write('c', 'k', 'v', 'x');
    expect(await mem.list('b')).toEqual([]);
    expect(await mem.list('a')).toHaveLength(2);
    expect(await mem.list('c')).toHaveLength(1);
  });

  it('refuses the in-memory store in production unless explicitly allowed', () => {
    expect(() => assertMemoryStoreAllowed({ NODE_ENV: 'production' })).toThrow(/DATABASE_URL/);
    expect(() => assertMemoryStoreAllowed({ NODE_ENV: 'production', ALLOW_MEMORY_STORE: 'true' })).not.toThrow();
    expect(() => assertMemoryStoreAllowed({ NODE_ENV: 'development' })).not.toThrow();
  });
});
