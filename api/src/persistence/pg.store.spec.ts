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
    expect(await store.migrate(MIGRATIONS)).toEqual(['0001_webhook_inbox_event_id.sql', '0002_tool_calls_started_lease.sql']);
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
    await store.claimToolCall(other, 60_000);
    await ctx.db.exec(`UPDATE tool_calls SET lease_until = NULL WHERE idempotency_key = 'k2'`);
    expect((await store.claimToolCall(other, 60_000))?.attempts).toBe(2);
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
});
