import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Snapshot, Task, Usage } from '../common/types';
import { newId, nowIso } from '../common/util';
import { pglitePool } from '../test-utils/pglite-pool';
import { MemoryStore } from './memory.store';
import { PgStore } from './pg.store';
import { Store } from './store.port';

const SCHEMA = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
const MIGRATIONS = join(__dirname, 'migrations');

const task = (patch: Partial<Task> = {}): Task => ({
  id: newId(), title: 't', description: 'd', status: 'running', budgetUsd: 1, spentUsd: 0, requiresApproval: false,
  correctionRounds: 0, result: null, error: null, createdAt: nowIso(), updatedAt: nowIso(), ...patch,
});

const usage = (taskId: string, patch: Partial<Usage>): Usage => ({
  id: newId(), taskId, subtaskId: null, agent: 'coder', model: 'm1', promptTokens: 10, completionTokens: 5,
  costUsd: 0.001, savedUsd: 0, cached: false, createdAt: nowIso(), ...patch,
});

const snap = (taskId: string, version: number, label: string): Snapshot => ({
  taskId, version, hash: `h${version}${label}`, parentHash: null, label, content: {}, createdAt: nowIso(),
});

/** Same contract on both adapters: MemoryStore and PgStore on a real Postgres engine (PGlite). */
describe.each([
  ['MemoryStore', async () => ({ store: new MemoryStore() as Store, close: async () => undefined })],
  ['PgStore (PGlite)', async () => {
    const { pool } = pglitePool();
    const store = new PgStore(pool);
    await store.migrate(MIGRATIONS, SCHEMA);
    return { store: store as Store, close: () => store.close() };
  }],
])('Store contract: %s', (_name, make) => {
  let store: Store;
  let close: () => Promise<void>;
  beforeEach(async () => ({ store, close } = await make()));
  afterEach(() => close());

  it('resolves a pending approval once: a second, concurrent decision gets null (M7)', async () => {
    const { task: t } = await store.createTask(task({ status: 'awaiting_approval' }), null);
    await store.upsertApproval({ taskId: t.id, status: 'pending', note: null, requestedAt: nowIso(), resolvedAt: null });
    const [a, b] = await Promise.all([
      store.resolveApproval(t.id, 'approved', 'ok'),
      store.resolveApproval(t.id, 'rejected', 'não'),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect((await store.getApproval(t.id))).toMatchObject({ status: a ? 'approved' : 'rejected' });
    expect(await store.resolveApproval(newId(), 'approved', null)).toBeNull();
  });

  it('aggregates usage in the store: totals, by model, by agent and only the asked tasks (M8)', async () => {
    const { task: a } = await store.createTask(task(), null);
    const { task: b } = await store.createTask(task(), null);
    await store.recordUsage(usage(a.id, { model: 'm1', agent: 'coder', costUsd: 0.002 }));
    await store.recordUsage(usage(a.id, { model: 'm2', agent: 'tester', costUsd: 0.003 }));
    await store.recordUsage(usage(b.id, { model: 'm1', agent: 'coder', costUsd: 0, savedUsd: 0.002, cached: true, promptTokens: 0, completionTokens: 0 }));

    const s = await store.usageSummary([a.id]);
    expect(s.totals).toEqual({ tokens: 30, costUsd: 0.005, calls: 3, cacheHits: 1, savedUsd: 0.002 });
    const byKey = (list: { key: string }[]) => Object.fromEntries(list.map((x) => [x.key, x]));
    expect(byKey(s.byModel)).toEqual({
      m1: { key: 'm1', tokens: 15, costUsd: 0.002, calls: 2 },
      m2: { key: 'm2', tokens: 15, costUsd: 0.003, calls: 1 },
    });
    expect(byKey(s.byAgent).coder).toEqual({ key: 'coder', tokens: 15, costUsd: 0.002, calls: 2 });
    expect(s.byTask).toEqual([{ key: a.id, tokens: 30, costUsd: 0.005, calls: 2 }]);
    expect((await store.usageSummary([])).byTask).toEqual([]);
  });

  it('refuses a snapshot version already taken instead of throwing (M1)', async () => {
    const { task: t } = await store.createTask(task(), null);
    expect(await store.addSnapshot(snap(t.id, 1, 'plan'))).not.toBeNull();
    expect(await store.addSnapshot(snap(t.id, 1, 'other'))).toBeNull();
    expect((await store.listSnapshots(t.id)).map((s) => s.label)).toEqual(['plan']);
  });

  it('binds the Idempotency-Key to the body and forgets it after the TTL (L3)', async () => {
    const idem = { key: 'k1', bodyHash: 'h1', ttlMs: 60_000 };
    const first = await store.createTask(task(), idem);
    expect(first).toMatchObject({ replay: false, mismatch: false });
    expect(await store.createTask(task(), idem)).toMatchObject({ replay: true, mismatch: false, task: { id: first.task.id } });
    expect(await store.createTask(task(), { ...idem, bodyHash: 'h2' })).toMatchObject({ replay: true, mismatch: true, task: { id: first.task.id } });

    const old = task({ createdAt: new Date(Date.now() - 120_000).toISOString() });
    const stale = { key: 'k2', bodyHash: 'h1', ttlMs: 1 };
    const created = await store.createTask(old, stale);
    await new Promise((r) => setTimeout(r, 5));
    const again = await store.createTask(task(), stale);
    expect(again).toMatchObject({ replay: false, mismatch: false });
    expect(again.task.id).not.toBe(created.task.id);
    expect(await store.getTask(created.task.id)).not.toBeNull(); // the old task stays, only the key is freed
  });
});

describe('PgStore boot (L8)', () => {
  it('creates the base schema and applies the migrations in one locked transaction, idempotently', async () => {
    const { db, pool } = pglitePool();
    const store = new PgStore(pool);
    const applied = await store.migrate(MIGRATIONS, SCHEMA);
    expect(applied).toContain('0004_idempotency_body_hash.sql');
    expect(await store.migrate(MIGRATIONS, SCHEMA)).toEqual([]);
    const cols = await db.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'tasks' AND column_name = 'idempotency_hash'");
    expect(cols.rows).toHaveLength(1);
    await store.close();
  });

  it('runs the base schema after taking the advisory lock', () => {
    const src = readFileSync(join(__dirname, 'pg.store.ts'), 'utf8');
    const body = src.slice(src.indexOf('async migrate('));
    expect(body.indexOf('pg_advisory_xact_lock')).toBeLessThan(body.indexOf('baseSchema)'));
    expect(src.slice(src.indexOf('static async connect'), src.indexOf('async migrate('))).not.toMatch(/pool\.query\(/);
  });
});
