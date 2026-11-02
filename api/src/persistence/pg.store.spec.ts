import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OutboxEvent } from '../common/types';
import { newId, nowIso } from '../common/util';
import { pglitePool } from '../test-utils/pglite-pool';
import { PgStore } from './pg.store';

const SCHEMA = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
const MIGRATIONS = join(__dirname, 'migrations');
const event = (): OutboxEvent => ({
  id: newId(), type: 'tool.executed', payload: {}, status: 'pending', attempts: 0,
  nextAttemptAt: nowIso(), createdAt: nowIso(), deliveredAt: null, lastError: null,
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
    expect(await store.migrate(MIGRATIONS)).toEqual(['0001_webhook_inbox_event_id.sql', '0002_tool_calls_started_lease.sql', '0003_task_lease_tool_failed.sql', '0004_approver_idempotency_fingerprint.sql', '0005_budget_reservations_retention.sql']);
    expect(await store.migrate(MIGRATIONS)).toEqual([]);
    await ctx.db.exec(SCHEMA);
    expect(await store.findToolCall('old')).toMatchObject({ status: 'completed', attempts: 1, result: { x: 1 } });
    // An instance still on v0.3.1 during a rolling deploy inserts without status.
    await ctx.db.exec(`INSERT INTO tool_calls (idempotency_key, task_id, tool, args, result) VALUES ('rolling', gen_random_uuid(), 't', '{}', '{}')`);
    expect((await store.findToolCall('rolling'))?.status).toBe('completed');
    await expect(ctx.db.exec(`INSERT INTO tool_calls (idempotency_key, task_id, tool, args, status) VALUES ('bad', gen_random_uuid(), 't', '{}', 'completed')`))
      .rejects.toThrow(/tool_calls_status_check/);
  });

  it('claims with a lease, takes over an expired lease, re-claims a released one without a new attempt and fences a stale attempt', async () => {
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
    await ctx.db.exec(`UPDATE tool_calls SET lease_until = now() - interval '1 second' WHERE idempotency_key = 'k2'`);
    // A takeover keeps the first created_at: ToolInvoker refuses re-runs past IDEMPOTENCY_KEY_TTL_MS from it.
    expect(await store.claimToolCall(other, 60_000)).toMatchObject({ attempts: 2, createdAt });
    // A clean failure releases the lease (NULL): the retry claims the same attempt.
    await store.releaseToolCall('k2', 2, 'upstream 503');
    expect(await store.claimToolCall(other, 60_000)).toMatchObject({ attempts: 2, error: 'upstream 503' });
    expect(await store.claimToolCall(other, 60_000)).toBeNull();

    // Terminal failure is fenced by attempt and never claimed again.
    expect(await store.failToolCall('k2', 1, 'stale')).toMatchObject({ status: 'started' });
    expect(await store.failToolCall('k2', 2, 'refused')).toMatchObject({ status: 'failed', error: 'refused', leaseUntil: null });
    expect(await store.claimToolCall(other, 60_000)).toBeNull();
    await expect(ctx.db.exec(`INSERT INTO tool_calls (idempotency_key, task_id, tool, args, status) VALUES ('f', gen_random_uuid(), 't', '{}', 'failed')`)).resolves.toBeDefined();
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

  it('usage keyset pages are exact even for rows stored with microseconds in the same millisecond', async () => {
    await store.migrate(MIGRATIONS);
    const taskId = newId();
    await ctx.db.exec(`INSERT INTO usage_records (id, task_id, agent, model, prompt_tokens, completion_tokens, cost_usd, created_at) VALUES
      (gen_random_uuid(), '${taskId}', 'a', 'm', 1, 0, 0, '2026-11-01T12:00:00.000100Z'),
      (gen_random_uuid(), '${taskId}', 'a', 'm', 2, 0, 0, '2026-11-01T12:00:00.000200Z'),
      (gen_random_uuid(), '${taskId}', 'a', 'm', 3, 0, 0, '2026-11-01T12:00:00.000300Z')`);
    const seen: number[] = [];
    let after: Awaited<ReturnType<PgStore['listUsagePage']>>[number] | null = null;
    for (let i = 0; i < 10; i++) {
      const page = await store.listUsagePage(1, after);
      if (!page.length) break;
      seen.push(page[0].promptTokens);
      after = page[0];
    }
    expect(seen.sort()).toEqual([1, 2, 3]);
  });
});
