import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Task } from '../common/types';
import { newId, nowIso } from '../common/util';
import { pglitePool } from '../test-utils/pglite-pool';
import { outboxEvent } from '../tools/tool-invoker.service';
import { MemoryStore } from './memory.store';
import { PgStore } from './pg.store';
import { Store } from './store.port';

const SCHEMA = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
const MIGRATIONS = join(__dirname, 'migrations');

const adapters: [string, () => Promise<{ store: Store; close: () => Promise<void> }>][] = [
  ['MemoryStore', async () => ({ store: new MemoryStore(), close: async () => undefined })],
  ['PgStore (PGlite)', async () => {
    const ctx = pglitePool();
    await ctx.db.exec(SCHEMA);
    const store = new PgStore(ctx.pool);
    await store.migrate(MIGRATIONS);
    return { store, close: () => store.close() };
  }],
];

/** Guards both adapters must enforce the same way: terminal transitions, task lease, approval, journal. */
describe.each(adapters)('Store contract: %s', (_name, make) => {
  let store: Store;
  let close: () => Promise<void>;
  beforeEach(async () => ({ store, close } = await make()));
  afterEach(() => close());

  const seed = async (patch: Partial<Task> = {}) => {
    const now = nowIso();
    const { task } = await store.createTask({
      id: newId(), title: 'T', description: 'd', status: 'running', budgetUsd: 1, spentUsd: 0, requiresApproval: false,
      correctionRounds: 0, result: null, error: null, createdAt: now, updatedAt: now, ...patch,
    }, null);
    return task;
  };

  it('reaches a terminal status once: a second finish writes nothing and enqueues no second event', async () => {
    const t = await seed();
    expect(await store.finishTask(t.id, { status: 'failed', error: 'timeout' }, outboxEvent('task.failed', {}))).toMatchObject({ status: 'failed' });
    expect(await store.finishTask(t.id, { status: 'completed', error: null }, outboxEvent('task.completed', {}))).toBeNull();
    expect(await store.updateActiveTask(t.id, { status: 'merging' })).toBeNull();
    expect((await store.getTask(t.id))!).toMatchObject({ status: 'failed', error: 'timeout' });
    expect((await store.listOutbox()).map((e) => e.type)).toEqual(['task.failed']);
  });

  it('task lease: one owner at a time, fencing token bumps on takeover, stale owner writes are refused', async () => {
    const t = await seed();
    const a = (await store.acquireTaskLease(t.id, 'replica-a', 60_000))!;
    expect(a).toMatchObject({ owner: 'replica-a' });
    expect(await store.acquireTaskLease(t.id, 'replica-b', 60_000)).toBeNull();
    expect(await store.getTaskLease(t.id)).toMatchObject({ owner: 'replica-a', token: a.token });
    expect(await store.renewTaskLease(t.id, a, 60_000)).toBe(true);
    expect(await store.updateActiveTask(t.id, { status: 'merging' }, a)).toMatchObject({ status: 'merging' });

    // A's lease lapses (crash without release): B takes over with a new token.
    expect(await store.renewTaskLease(t.id, a, -1_000)).toBe(true);
    const b = (await store.acquireTaskLease(t.id, 'replica-b', 60_000))!;
    expect(b.token).toBeGreaterThan(a.token);
    expect(await store.renewTaskLease(t.id, a, 60_000)).toBe(false);
    expect(await store.updateActiveTask(t.id, { status: 'running' }, a)).toBeNull();
    expect(await store.finishTask(t.id, { status: 'completed' }, outboxEvent('task.completed', {}), a)).toBeNull();
    expect(await store.listOutbox()).toHaveLength(0);

    await store.releaseTaskLease(t.id, a); // stale release is a no-op
    expect(await store.getTaskLease(t.id)).toMatchObject({ owner: 'replica-b' });
    await store.releaseTaskLease(t.id, b);
    expect(await store.getTaskLease(t.id)).toBeNull();
    expect(await store.acquireTaskLease(t.id, 'replica-a', 60_000)).toMatchObject({ token: b.token + 1 });
  });

  it('reopens a failed task only for the lease holder, and never a completed one', async () => {
    const failed = await seed({ status: 'failed', error: 'x' });
    const lease = (await store.acquireTaskLease(failed.id, 'o', 60_000))!;
    expect(await store.reopenTask(failed.id, { ...lease, token: lease.token + 1 })).toBeNull();
    expect(await store.reopenTask(failed.id, lease)).toMatchObject({ status: 'running', error: null });
    const done = await seed({ status: 'completed' });
    expect(await store.reopenTask(done.id, (await store.acquireTaskLease(done.id, 'o', 60_000))!)).toBeNull();
  });

  it('resolves an approval atomically: only the first decision wins', async () => {
    const t = await seed({ status: 'awaiting_approval' });
    await store.upsertApproval({ taskId: t.id, status: 'pending', note: null, requestedAt: nowIso(), resolvedAt: null });
    const [first, second] = await Promise.all([
      store.resolveApproval(t.id, 'approved', 'ok', nowIso()),
      store.resolveApproval(t.id, 'rejected', 'não', nowIso()),
    ]);
    expect(first).toMatchObject({ status: 'approved', note: 'ok' });
    expect(second).toBeNull();
    expect(await store.getApproval(t.id)).toMatchObject({ status: 'approved' });
    expect(await store.resolveApproval(newId(), 'approved', null, nowIso())).toBeNull();
  });

  it('journals the first value of a step and hands it to a late writer', async () => {
    const t = await seed();
    expect(await store.putStep(t.id, 'plan', { by: 'first' })).toEqual({ by: 'first' });
    expect(await store.putStep(t.id, 'plan', { by: 'second' })).toEqual({ by: 'first' });
    expect((await store.getStep(t.id, 'plan'))!.value).toEqual({ by: 'first' });
  });

  it('keeps an existing subtask when the plan is saved again', async () => {
    const t = await seed();
    const sub = { id: newId(), taskId: t.id, agent: 'coder' as const, title: 'a', status: 'pending' as const, model: null, output: null, attempt: 1, position: 0, startedAt: null, finishedAt: null };
    await store.saveSubtasks([sub]);
    await store.updateSubtask(sub.id, { status: 'done' });
    await store.saveSubtasks([{ ...sub, title: 'b' }]);
    expect(await store.listSubtasks(t.id)).toEqual([expect.objectContaining({ id: sub.id, title: 'a', status: 'done' })]);
  });
});
