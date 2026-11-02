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
      store.resolveApproval(t.id, 'approved', 'ok', nowIso(), 'ana'),
      store.resolveApproval(t.id, 'rejected', 'não', nowIso(), 'bruno'),
    ]);
    expect(first).toMatchObject({ status: 'approved', note: 'ok', decidedBy: 'ana' });
    expect(second).toBeNull();
    expect(await store.getApproval(t.id)).toMatchObject({ status: 'approved', decidedBy: 'ana' });
    expect(await store.resolveApproval(newId(), 'approved', null, nowIso())).toBeNull();
  });

  it('returns the fingerprint stored with an idempotency key on replay (null for a key stored without one)', async () => {
    const now = nowIso();
    const draft = (): Task => ({ id: newId(), title: 'T', description: 'd', status: 'queued', budgetUsd: 1, spentUsd: 0,
      requiresApproval: false, correctionRounds: 0, result: null, error: null, createdAt: now, updatedAt: now });
    const first = await store.createTask(draft(), 'k1', 'fp-a');
    expect(first).toMatchObject({ replay: false, fingerprint: 'fp-a' });
    const again = await store.createTask(draft(), 'k1', 'fp-b');
    expect(again).toMatchObject({ replay: true, fingerprint: 'fp-a', task: { id: first.task.id } });
    await store.createTask(draft(), 'legacy');
    expect(await store.createTask(draft(), 'legacy', 'fp-c')).toMatchObject({ replay: true, fingerprint: null });
  });

  it('counts tasks and outbox events by status for the metrics endpoint', async () => {
    const t = await seed({ status: 'running' });
    await seed({ status: 'running' });
    await seed({ status: 'completed' });
    await store.finishTask(t.id, { status: 'failed', error: 'x' }, outboxEvent('task.failed', { taskId: t.id }));
    expect(await store.countTasksByStatus()).toEqual({ running: 1, completed: 1, failed: 1 });
    const [ev] = await store.listOutbox();
    await store.updateOutbox(ev.id, { status: 'dead', lastError: 'expired' });
    expect(await store.countOutboxByStatus()).toEqual({ dead: 1 });
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

  it('budget reservation race: of concurrent reservations only those that fit the budget succeed', async () => {
    const t = await seed({ budgetUsd: 0.1 });
    const ids = Array.from({ length: 5 }, () => newId());
    const results = await Promise.all(ids.map((id) => store.reserveBudget(id, t.id, 0.03)));
    expect(results.filter((r) => r!.reserved)).toHaveLength(3); // 3 x 0.03 = 0.09 <= 0.1; a 4th would be 0.12
    expect(results.filter((r) => !r!.reserved)).toHaveLength(2);
    expect(await store.reserveBudget(newId(), newId(), 1)).toBeNull(); // unknown task: nothing to guard
  });

  it('settling a reservation spends the real cost; releasing gives the amount back; both are idempotent', async () => {
    const t = await seed({ budgetUsd: 0.1 });
    const [a, b] = [newId(), newId()];
    expect(await store.reserveBudget(a, t.id, 0.06)).toMatchObject({ reserved: true, reservedUsd: 0.06 });
    expect(await store.reserveBudget(b, t.id, 0.06)).toMatchObject({ reserved: false, reservedUsd: 0.06 });
    await store.recordUsage({ id: newId(), taskId: t.id, subtaskId: null, agent: 'coder', model: 'm', promptTokens: 1, completionTokens: 1,
      costUsd: 0.01, savedUsd: 0, cached: false, createdAt: nowIso() }, a);
    expect((await store.getTask(t.id))!.spentUsd).toBeCloseTo(0.01, 6);
    expect(await store.reserveBudget(b, t.id, 0.06)).toMatchObject({ reserved: true, spentUsd: 0.01, reservedUsd: 0.06 });
    await store.releaseBudget(b);
    await store.releaseBudget(b);
    expect(await store.reserveBudget(newId(), t.id, 0.09)).toMatchObject({ reserved: true, reservedUsd: 0.09 });
    // A young reservation may belong to a call still in flight: kept. Once old enough it is an orphan.
    expect(await store.releaseTaskReservations(t.id, 60_000)).toBe(0);
    expect(await store.reserveBudget(newId(), t.id, 0.09)).toMatchObject({ reserved: false });
    expect(await store.releaseTaskReservations(t.id, 0)).toBe(1);
    expect(await store.reserveBudget(newId(), t.id, 0.09)).toMatchObject({ reserved: true, reservedUsd: 0.09 });
  });

  it('aggregates billing in the store and pages tasks and usage', async () => {
    const [t1, t2] = [await seed(), await seed()];
    const at = (s: number) => new Date(Date.UTC(2026, 10, 1, 12, 0, s)).toISOString();
    const use = (taskId: string, model: string, agent: string, costUsd: number, cached: boolean, s: number) =>
      store.recordUsage({ id: newId(), taskId, subtaskId: null, agent, model, promptTokens: 10, completionTokens: 5, costUsd,
        savedUsd: cached ? 0.5 : 0, cached, createdAt: at(s) });
    await use(t1.id, 'a', 'coder', 0.2, false, 1);
    await use(t1.id, 'b', 'coder', 0.1, false, 2);
    await use(t2.id, 'a', 'tester', 0, true, 3);
    expect(await store.summarizeUsage()).toEqual({
      totals: { tokens: 45, costUsd: 0.3, calls: 3, cacheHits: 1, savedUsd: 0.5 },
      byModel: [{ model: 'a', tokens: 30, costUsd: 0.2, calls: 2 }, { model: 'b', tokens: 15, costUsd: 0.1, calls: 1 }],
      byAgent: [{ agent: 'coder', tokens: 30, costUsd: 0.3, calls: 2 }, { agent: 'tester', tokens: 15, costUsd: 0, calls: 1 }],
    });
    const all = await store.listTaskCosts(10, 0);
    expect(all.total).toBe(2);
    expect(Object.fromEntries(all.items.map((i) => [i.taskId, i.tokens]))).toEqual({ [t1.id]: 30, [t2.id]: 15 });
    const page = await store.listTaskCosts(1, 1);
    expect(page).toMatchObject({ total: 2, items: [expect.objectContaining({ taskId: all.items[1].taskId })] });

    const first = await store.listUsagePage(2);
    expect(first.map((u) => u.createdAt)).toEqual([at(1), at(2)]);
    expect((await store.listUsagePage(2, first[1])).map((u) => u.createdAt)).toEqual([at(3)]);
    expect(await store.summarizeUsage().then((s) => s.totals.calls)).toBe(3);
  });

  it('retention prunes old inbox rows, finished tool calls and journal entries, never those of a task that may still run', async () => {
    const done = await seed({ status: 'completed' });
    const failed = await seed({ status: 'failed' });
    const running = await seed({ status: 'running' });
    for (const t of [done, failed, running]) {
      await store.putStep(t.id, 'plan', { t: t.id });
      const claim = await store.claimToolCall({ idempotencyKey: `k-${t.id}`, taskId: t.id, subtaskId: null, tool: 'x', args: {}, createdAt: nowIso() }, 60_000);
      await store.completeToolCallWithOutbox(claim!.idempotencyKey, 1, { ok: true }, outboxEvent('tool.executed', {}));
    }
    await store.claimToolCall({ idempotencyKey: 'k-started', taskId: done.id, subtaskId: null, tool: 'x', args: {}, createdAt: nowIso() }, 60_000);
    const old = new Date(Date.now() - 3_600_000).toISOString();
    await store.addInbox({ id: newId(), eventId: 'old', event: 'e', verified: true, signature: 's', payload: {}, receivedAt: old });
    await store.addInbox({ id: newId(), eventId: 'new', event: 'e', verified: true, signature: 's', payload: {}, receivedAt: nowIso() });

    // Cutoff 30 min ago: only the old inbox row is older.
    expect(await store.pruneBefore(new Date(Date.now() - 1_800_000).toISOString())).toEqual({ webhookInbox: 1, toolCalls: 0, stepJournal: 0 });
    expect((await store.listInbox(10)).map((e) => e.eventId)).toEqual(['new']);

    // Cutoff in the future: everything is old, but the failed and running tasks keep theirs, and 'started' stays.
    expect(await store.pruneBefore(new Date(Date.now() + 60_000).toISOString())).toEqual({ webhookInbox: 1, toolCalls: 1, stepJournal: 1 });
    expect(await store.findToolCall(`k-${done.id}`)).toBeNull();
    expect(await store.getStep(done.id, 'plan')).toBeNull();
    expect(await store.findToolCall('k-started')).toMatchObject({ status: 'started' });
    for (const t of [failed, running]) {
      expect(await store.findToolCall(`k-${t.id}`)).toMatchObject({ status: 'completed' });
      expect(await store.getStep(t.id, 'plan')).toEqual({ value: { t: t.id } });
    }
  });
});
