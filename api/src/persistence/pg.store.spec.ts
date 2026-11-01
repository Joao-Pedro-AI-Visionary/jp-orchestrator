import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OutboxEvent, Task } from '../common/types';
import { newId, nowIso } from '../common/util';
import { pglitePool } from '../test-utils/pglite-pool';
import { PgStore } from './pg.store';

const SCHEMA = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
const MIGRATIONS = join(__dirname, 'migrations');
const event = (): OutboxEvent => ({
  id: newId(), type: 'tool.executed', payload: {}, status: 'pending', attempts: 0,
  nextAttemptAt: nowIso(), createdAt: nowIso(), deliveredAt: null, lastError: null,
});

const task = (budgetUsd = 1): Task => ({
  id: newId(), title: 't', description: 'd', status: 'running', budgetUsd, spentUsd: 0, requiresApproval: false,
  correctionRounds: 0, result: null, error: null, createdAt: nowIso(), updatedAt: nowIso(),
});

/** PgStore SQL and migrations on a real Postgres engine (PGlite). */
describe('PgStore (PGlite)', () => {
  let ctx: ReturnType<typeof pglitePool>;
  let store: PgStore;

  beforeEach(async () => {
    ctx = pglitePool();
    await ctx.db.exec(SCHEMA);
    store = new PgStore(ctx.pool);
  });
  afterEach(() => store.close());

  it('migrates a v0.3.1 database once, keeps legacy rows completed and lets old-style inserts stay valid', async () => {
    await ctx.db.exec(`INSERT INTO tool_calls (idempotency_key, task_id, tool, args, result) VALUES ('old', gen_random_uuid(), 't', '{}', '{"x":1}');
      INSERT INTO webhook_inbox (id, event, verified, signature, payload) VALUES (gen_random_uuid(), 'e', true, 's', '{}'), (gen_random_uuid(), 'e', true, 's', '{}');`);
    expect(await store.migrate(MIGRATIONS)).toEqual([
      '0001_webhook_inbox_event_id.sql', '0002_tool_calls_started_lease.sql', '0003_task_lease_budget_reservation.sql',
    ]);
    expect(await store.migrate(MIGRATIONS)).toEqual([]);
    await ctx.db.exec(SCHEMA);
    expect(await store.findToolCall('old')).toMatchObject({ status: 'completed', attempts: 1, result: { x: 1 } });
    // An instance still on v0.3.1 during a rolling deploy inserts without status.
    await ctx.db.exec(`INSERT INTO tool_calls (idempotency_key, task_id, tool, args, result) VALUES ('rolling', gen_random_uuid(), 't', '{}', '{}')`);
    expect((await store.findToolCall('rolling'))?.status).toBe('completed');
    await expect(ctx.db.exec(`INSERT INTO tool_calls (idempotency_key, task_id, tool, args, status) VALUES ('bad', gen_random_uuid(), 't', '{}', 'completed')`))
      .rejects.toThrow(/tool_calls_status_check/);
  });

  it('claims with a lease, takes over an expired or missing lease and fences a stale attempt', async () => {
    await store.migrate(MIGRATIONS);
    const claim = { idempotencyKey: 'k', taskId: newId(), subtaskId: null, tool: 'charge', args: { a: 1 }, createdAt: nowIso() };
    expect(await store.claimToolCall(claim, 60_000)).toMatchObject({ status: 'started', attempts: 1, result: null });
    expect(await store.claimToolCall(claim, 60_000)).toBeNull();

    await ctx.db.exec(`UPDATE tool_calls SET lease_until = now() - interval '1 second' WHERE idempotency_key = 'k'`);
    expect((await store.claimToolCall(claim, 60_000))?.attempts).toBe(2);
    expect(await store.completeToolCallWithOutbox('k', 2, { by: 'fresh' }, event())).toMatchObject({ status: 'completed', result: { by: 'fresh' } });
    expect(await store.completeToolCallWithOutbox('k', 1, { by: 'stale' }, event())).toMatchObject({ attempts: 2, result: { by: 'fresh' } });
    expect(await store.listOutbox()).toHaveLength(1);
    expect(await store.claimToolCall(claim, 60_000)).toBeNull();

    const other = { ...claim, idempotencyKey: 'k2' };
    const createdAt = '2026-10-30T12:00:00.000Z';
    await store.claimToolCall({ ...other, createdAt }, 60_000);
    await ctx.db.exec(`UPDATE tool_calls SET lease_until = NULL WHERE idempotency_key = 'k2'`);
    // A takeover keeps the first created_at: ToolInvoker refuses re-runs past IDEMPOTENCY_KEY_TTL_MS from it.
    expect(await store.claimToolCall(other, 60_000)).toMatchObject({ attempts: 2, createdAt });
    await store.releaseToolCall('k2', 2);
    expect((await store.claimToolCall(other, 60_000))?.attempts).toBe(3);
  });

  it('stores an inbox event id once (UNIQUE + ON CONFLICT DO NOTHING) and never dedupes NULL ids', async () => {
    await store.migrate(MIGRATIONS);
    const entry = (eventId: string | null) => ({ id: newId(), eventId, event: 'task.completed', verified: true, signature: 's', payload: {}, receivedAt: nowIso() });
    expect(await store.addInbox(entry('e1'))).toBe(true);
    expect(await store.addInbox(entry('e1'))).toBe(false);
    expect(await store.addInbox(entry(null))).toBe(true);
    expect(await store.addInbox(entry(null))).toBe(true);
    const inbox = await store.listInbox(50);
    expect(inbox).toHaveLength(3);
    expect(inbox.filter((e) => e.eventId === 'e1')).toHaveLength(1);
  });

  it('leases a task to one owner, renews only for the holder and lets an expired lease be taken over', async () => {
    await store.migrate(MIGRATIONS);
    const { task: t } = await store.createTask(task(), null);
    expect(await store.isTaskLeased(t.id)).toBe(false);
    expect(await store.acquireTaskLease(t.id, 'a', 60_000)).toBe(true);
    expect(await store.acquireTaskLease(t.id, 'b', 60_000)).toBe(false);
    expect(await store.isTaskLeased(t.id)).toBe(true);
    expect(await store.renewTaskLease(t.id, 'b', 60_000)).toBe(false);
    expect(await store.renewTaskLease(t.id, 'a', 60_000)).toBe(true);
    await store.releaseTaskLease(t.id, 'b');
    expect(await store.isTaskLeased(t.id)).toBe(true);

    await ctx.db.exec(`UPDATE tasks SET lease_until = now() - interval '1 second', reserved_usd = 0.5 WHERE id = '${t.id}'`);
    expect(await store.isTaskLeased(t.id)).toBe(false);
    expect(await store.acquireTaskLease(t.id, 'b', 60_000)).toBe(true);
    // The takeover drops the reservation the dead holder left behind.
    expect((await ctx.db.query<{ r: string }>(`SELECT reserved_usd::text AS r FROM tasks WHERE id = '${t.id}'`)).rows[0].r).toBe('0.000000');
    expect(await store.renewTaskLease(t.id, 'a', 60_000)).toBe(false);
    await store.releaseTaskLease(t.id, 'b');
    expect(await store.isTaskLeased(t.id)).toBe(false);
  });

  it('journals a step once: a second writer gets the stored value back', async () => {
    await store.migrate(MIGRATIONS);
    const { task: t } = await store.createTask(task(), null);
    expect(await store.putStep(t.id, 'plan', { ids: ['a'] })).toEqual({ inserted: true, value: { ids: ['a'] } });
    expect(await store.putStep(t.id, 'plan', { ids: ['b'] })).toEqual({ inserted: false, value: { ids: ['a'] } });
    expect(await store.getStep(t.id, 'plan')).toEqual({ value: { ids: ['a'] } });
  });

  it('reserves budget atomically against spent + reserved and settles it with the usage', async () => {
    await store.migrate(MIGRATIONS);
    const { task: t } = await store.createTask(task(0.01), null);
    expect((await store.reserveBudget(t.id, 0.006)).ok).toBe(true);
    expect(await store.reserveBudget(t.id, 0.006)).toMatchObject({ ok: false, spentUsd: 0, budgetUsd: 0.01 });
    const spent = await store.recordUsage({
      id: newId(), taskId: t.id, subtaskId: null, agent: 'coder', model: 'm', promptTokens: 1, completionTokens: 1,
      costUsd: 0.004, savedUsd: 0, cached: false, createdAt: nowIso(),
    }, 0.006);
    expect(spent).toBeCloseTo(0.004, 6);
    expect((await store.reserveBudget(t.id, 0.006)).ok).toBe(true);
    expect((await store.reserveBudget(t.id, 0.000001)).ok).toBe(false);
    await store.releaseBudget(t.id, 0.006);
    expect((await store.reserveBudget(t.id, 0.006)).ok).toBe(true);
    expect((await store.reserveBudget(newId(), 1)).ok).toBe(true); // unknown task: not guarded
  });

  it('finishes a task once: a second terminal write is ignored with no outbox event', async () => {
    await store.migrate(MIGRATIONS);
    const { task: t } = await store.createTask(task(), null);
    expect((await store.finishTask(t.id, { status: 'failed', error: 'timeout' }, event()))?.status).toBe('failed');
    expect(await store.finishTask(t.id, { status: 'completed' }, event())).toBeNull();
    expect((await store.getTask(t.id))!.status).toBe('failed');
    expect(await store.listOutbox()).toHaveLength(1);
    await expect(store.finishTask(newId(), { status: 'failed' }, event())).rejects.toThrow(/não encontrada/);
  });
});
