import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool, PoolClient } from 'pg';
import {
  Approval, InboxEntry, OutboxEvent, Snapshot, Subtask, Task, ToolCall, Usage,
} from '../common/types';
import { IdempotencyClaim, Store, ToolClaim, UsageBucket, UsageSummary } from './store.port';

type Row = Record<string, unknown>;
const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);
const num = (v: unknown): number => Number(v ?? 0);
const snake = (k: string): string => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const JSON_COLS = new Set(['result', 'payload', 'content', 'args', 'value']);
const TERMINAL_SQL = "('completed', 'failed', 'rejected', 'budget_exceeded')";

const toTask = (r: Row): Task => ({
  id: r.id as string,
  title: r.title as string,
  description: r.description as string,
  status: r.status as Task['status'],
  budgetUsd: num(r.budget_usd),
  spentUsd: num(r.spent_usd),
  requiresApproval: r.requires_approval as boolean,
  correctionRounds: num(r.correction_rounds),
  result: (r.result as Task['result']) ?? null,
  error: (r.error as string) ?? null,
  createdAt: iso(r.created_at)!,
  updatedAt: iso(r.updated_at)!,
});

const toSubtask = (r: Row): Subtask => ({
  id: r.id as string,
  taskId: r.task_id as string,
  agent: r.agent as Subtask['agent'],
  title: r.title as string,
  status: r.status as Subtask['status'],
  model: (r.model as string) ?? null,
  output: (r.output as string) ?? null,
  attempt: num(r.attempt),
  position: num(r.position),
  startedAt: iso(r.started_at),
  finishedAt: iso(r.finished_at),
});

const toOutbox = (r: Row): OutboxEvent => ({
  id: r.id as string,
  type: r.event_type as string,
  payload: r.payload as Record<string, unknown>,
  status: r.status as OutboxEvent['status'],
  attempts: num(r.attempts),
  nextAttemptAt: iso(r.next_attempt_at)!,
  createdAt: iso(r.created_at)!,
  deliveredAt: iso(r.delivered_at),
  lastError: (r.last_error as string) ?? null,
});

const toToolCall = (r: Row): ToolCall => ({
  idempotencyKey: r.idempotency_key as string,
  taskId: r.task_id as string,
  subtaskId: (r.subtask_id as string) ?? null,
  tool: r.tool as string,
  args: r.args as Record<string, unknown>,
  status: r.status as ToolCall['status'],
  result: (r.result as Record<string, unknown>) ?? null,
  attempts: num(r.attempts),
  leaseUntil: iso(r.lease_until),
  createdAt: iso(r.created_at)!,
  completedAt: iso(r.completed_at),
});

const toUsage = (r: Row): Usage => ({
  id: r.id as string,
  taskId: r.task_id as string,
  subtaskId: (r.subtask_id as string) ?? null,
  agent: r.agent as string,
  model: r.model as string,
  promptTokens: num(r.prompt_tokens),
  completionTokens: num(r.completion_tokens),
  costUsd: num(r.cost_usd),
  savedUsd: num(r.saved_usd),
  cached: r.cached as boolean,
  createdAt: iso(r.created_at)!,
});

const toApproval = (r: Row): Approval => ({
  taskId: r.task_id as string,
  status: r.status as Approval['status'],
  note: (r.note as string) ?? null,
  requestedAt: iso(r.requested_at)!,
  resolvedAt: iso(r.resolved_at),
});

/** Builds "col = $n" pairs from a camelCase patch. */
function setClause(patch: Record<string, unknown>, rename: Record<string, string> = {}, start = 2) {
  const cols: string[] = [];
  const values: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || k === 'id') continue;
    const col = rename[k] ?? snake(k);
    values.push(JSON_COLS.has(col) && v !== null ? JSON.stringify(v) : v);
    cols.push(`${col} = $${start + values.length - 1}`);
  }
  return { sql: cols.join(', '), values };
}

/** Postgres adapter. Transactions guard the outbox and idempotency invariants. */
export class PgStore implements Store {
  constructor(private readonly pool: Pool) {}

  static async connect(url: string): Promise<PgStore> {
    const pool = new Pool({ connectionString: url, max: 10 });
    const store = new PgStore(pool);
    await store.migrate(join(__dirname, 'migrations'), readFileSync(join(__dirname, 'schema.sql'), 'utf8'));
    return store;
  }

  /**
   * Applies the idempotent base schema (when given) and then migrations/*.sql in name
   * order, once each, all under one advisory lock: concurrent boots never race on
   * CREATE TABLE IF NOT EXISTS.
   */
  async migrate(dir: string, baseSchema?: string): Promise<string[]> {
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    return this.tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(7262001)');
      if (baseSchema) await c.query(baseSchema);
      await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
      const done = new Set((await c.query('SELECT version FROM schema_migrations')).rows.map((r) => r.version as string));
      const applied: string[] = [];
      for (const f of files.filter((x) => !done.has(x))) {
        await c.query(readFileSync(join(dir, f), 'utf8'));
        await c.query('INSERT INTO schema_migrations (version) VALUES ($1)', [f]);
        applied.push(f);
      }
      return applied;
    });
  }

  async close() { await this.pool.end(); }

  private async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    } finally {
      c.release();
    }
  }

  async ping() {
    try { await this.pool.query('SELECT 1'); return true; } catch { return false; }
  }

  createTask(t: Task, idem: IdempotencyClaim | null) {
    return this.tx(async (c) => {
      // A key past its TTL is forgotten (the task stays): the same key may create a new task.
      if (idem) {
        await c.query(
          `UPDATE tasks SET idempotency_key = NULL
           WHERE idempotency_key = $1 AND created_at <= now() - ($2 || ' milliseconds')::interval`,
          [idem.key, String(idem.ttlMs)],
        );
      }
      const ins = await c.query(
        `INSERT INTO tasks (id, title, description, status, budget_usd, spent_usd, requires_approval,
          correction_rounds, result, error, idempotency_key, idempotency_hash, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`,
        [t.id, t.title, t.description, t.status, t.budgetUsd, t.spentUsd, t.requiresApproval,
          t.correctionRounds, null, null, idem?.key ?? null, idem?.bodyHash ?? null, t.createdAt, t.updatedAt],
      );
      if (ins.rows[0]) return { task: toTask(ins.rows[0]), replay: false, mismatch: false };
      const existing = (await c.query('SELECT * FROM tasks WHERE idempotency_key = $1', [idem!.key])).rows[0];
      const hash = existing.idempotency_hash as string | null;
      return { task: toTask(existing), replay: true, mismatch: hash !== null && hash !== idem!.bodyHash };
    });
  }

  async getTask(id: string) {
    const r = await this.pool.query('SELECT * FROM tasks WHERE id = $1', [id]);
    return r.rows[0] ? toTask(r.rows[0]) : null;
  }

  async listTasks(limit: number) {
    const r = await this.pool.query('SELECT * FROM tasks ORDER BY created_at DESC LIMIT $1', [limit]);
    return r.rows.map(toTask);
  }

  async listTasksByStatus(statuses: string[]) {
    const r = await this.pool.query('SELECT * FROM tasks WHERE status = ANY($1)', [statuses]);
    return r.rows.map(toTask);
  }

  private async patchTask(c: Pool | PoolClient, id: string, patch: Partial<Task>, where = '') {
    const { sql, values } = setClause({ ...patch, createdAt: undefined, updatedAt: undefined });
    const r = await c.query(
      `UPDATE tasks SET ${sql ? `${sql}, ` : ''}updated_at = now() WHERE id = $1 ${where} RETURNING *`,
      [id, ...values],
    );
    if (!r.rows[0]) {
      if (where) return null;
      throw new Error(`Tarefa ${id} não encontrada`);
    }
    return toTask(r.rows[0]);
  }

  async updateTask(id: string, patch: Partial<Task>) {
    return (await this.patchTask(this.pool, id, patch))!;
  }

  updateTaskWithEvent(id: string, patch: Partial<Task>, e: OutboxEvent) {
    return this.tx(async (c) => {
      const t = (await this.patchTask(c, id, patch))!;
      await this.insertOutbox(c, e);
      return t;
    });
  }

  async finishTask(id: string, patch: Partial<Task>, e: OutboxEvent) {
    const done = await this.tx(async (c) => {
      const t = await this.patchTask(c, id, patch, `AND status NOT IN ${TERMINAL_SQL}`);
      if (t) await this.insertOutbox(c, e);
      return t;
    });
    if (!done && !(await this.getTask(id))) throw new Error(`Tarefa ${id} não encontrada`);
    return done;
  }

  async acquireTaskLease(taskId: string, owner: string, leaseMs: number) {
    const r = await this.pool.query(
      `UPDATE tasks SET lease_owner = $2, lease_until = now() + ($3 || ' milliseconds')::interval,
         reserved_usd = CASE WHEN lease_owner = $2 THEN reserved_usd ELSE 0 END
       WHERE id = $1 AND (lease_until IS NULL OR lease_until <= now() OR lease_owner = $2) RETURNING id`,
      [taskId, owner, String(leaseMs)],
    );
    return r.rows.length === 1;
  }

  async renewTaskLease(taskId: string, owner: string, leaseMs: number) {
    const r = await this.pool.query(
      `UPDATE tasks SET lease_until = now() + ($3 || ' milliseconds')::interval WHERE id = $1 AND lease_owner = $2 RETURNING id`,
      [taskId, owner, String(leaseMs)],
    );
    return r.rows.length === 1;
  }

  async releaseTaskLease(taskId: string, owner: string) {
    await this.pool.query('UPDATE tasks SET lease_owner = NULL, lease_until = NULL WHERE id = $1 AND lease_owner = $2', [taskId, owner]);
  }

  async isTaskLeased(taskId: string) {
    const r = await this.pool.query('SELECT lease_until > now() AS leased FROM tasks WHERE id = $1', [taskId]);
    return r.rows[0]?.leased === true;
  }

  private insertOutbox(c: PoolClient, e: OutboxEvent) {
    return c.query(
      'INSERT INTO outbox (id, event_type, payload, status, attempts, next_attempt_at, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [e.id, e.type, JSON.stringify(e.payload), e.status, e.attempts, e.nextAttemptAt, e.createdAt],
    );
  }

  async saveSubtasks(list: Subtask[]) {
    await this.tx(async (c) => {
      for (const s of list) {
        await c.query(
          `INSERT INTO subtasks (id, task_id, agent, title, status, model, output, attempt, position, started_at, finished_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (id) DO NOTHING`,
          [s.id, s.taskId, s.agent, s.title, s.status, s.model, s.output, s.attempt, s.position, s.startedAt, s.finishedAt],
        );
      }
    });
  }

  async updateSubtask(id: string, patch: Partial<Subtask>) {
    const { sql, values } = setClause({ ...patch, taskId: undefined });
    const r = await this.pool.query(`UPDATE subtasks SET ${sql} WHERE id = $1 RETURNING *`, [id, ...values]);
    if (!r.rows[0]) throw new Error(`Subtarefa ${id} não encontrada`);
    return toSubtask(r.rows[0]);
  }

  async listSubtasks(taskId: string) {
    const r = await this.pool.query('SELECT * FROM subtasks WHERE task_id = $1 ORDER BY position', [taskId]);
    return r.rows.map(toSubtask);
  }

  async getStep(taskId: string, key: string) {
    const r = await this.pool.query('SELECT value FROM step_journal WHERE task_id = $1 AND step_key = $2', [taskId, key]);
    return r.rows[0] ? { value: r.rows[0].value } : null;
  }

  async putStep(taskId: string, key: string, value: unknown) {
    // ON CONFLICT waits for a concurrent writer; the follow-up SELECT (new snapshot) sees its row.
    const ins = await this.pool.query(
      'INSERT INTO step_journal (task_id, step_key, value) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING task_id',
      [taskId, key, JSON.stringify(value ?? null)],
    );
    if (ins.rows.length) return { inserted: true, value };
    const stored = await this.getStep(taskId, key);
    return { inserted: false, value: stored?.value ?? null };
  }

  async upsertApproval(a: Approval) {
    const r = await this.pool.query(
      `INSERT INTO approvals (task_id, status, note, requested_at, resolved_at) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (task_id) DO UPDATE SET status = EXCLUDED.status, note = EXCLUDED.note, resolved_at = EXCLUDED.resolved_at
       RETURNING *`,
      [a.taskId, a.status, a.note, a.requestedAt, a.resolvedAt],
    );
    return toApproval(r.rows[0]);
  }

  async resolveApproval(taskId: string, status: 'approved' | 'rejected', note: string | null) {
    const r = await this.pool.query(
      `UPDATE approvals SET status = $2, note = $3, resolved_at = now()
       WHERE task_id = $1 AND status = 'pending' RETURNING *`,
      [taskId, status, note],
    );
    return r.rows[0] ? toApproval(r.rows[0]) : null;
  }

  async getApproval(taskId: string) {
    const r = await this.pool.query('SELECT * FROM approvals WHERE task_id = $1', [taskId]);
    return r.rows[0] ? toApproval(r.rows[0]) : null;
  }

  async findToolCall(key: string) {
    const r = await this.pool.query('SELECT * FROM tool_calls WHERE idempotency_key = $1', [key]);
    return r.rows[0] ? toToolCall(r.rows[0]) : null;
  }

  async claimToolCall(call: ToolClaim, leaseMs: number) {
    const r = await this.pool.query(
      `INSERT INTO tool_calls (idempotency_key, task_id, subtask_id, tool, args, status, attempts, lease_until, created_at)
       VALUES ($1,$2,$3,$4,$5,'started',1, now() + ($6 || ' milliseconds')::interval, $7)
       ON CONFLICT (idempotency_key) DO UPDATE
         SET attempts = tool_calls.attempts + 1, lease_until = EXCLUDED.lease_until
         WHERE tool_calls.status = 'started' AND (tool_calls.lease_until IS NULL OR tool_calls.lease_until <= now())
       RETURNING *`,
      [call.idempotencyKey, call.taskId, call.subtaskId, call.tool, JSON.stringify(call.args), String(leaseMs), call.createdAt],
    );
    return r.rows[0] ? toToolCall(r.rows[0]) : null;
  }

  async completeToolCallWithOutbox(key: string, attempt: number, result: Record<string, unknown>, e: OutboxEvent) {
    const won = await this.tx(async (c) => {
      const r = await c.query(
        `UPDATE tool_calls SET status = 'completed', result = $3, lease_until = NULL, completed_at = now()
         WHERE idempotency_key = $1 AND status = 'started' AND attempts = $2 RETURNING *`,
        [key, attempt, JSON.stringify(result)],
      );
      if (r.rows[0]) await this.insertOutbox(c, e);
      return r.rows[0] ? toToolCall(r.rows[0]) : null;
    });
    if (won) return won;
    const current = await this.findToolCall(key);
    if (!current) throw new Error(`Chamada de ferramenta ${key} não encontrada`);
    return current;
  }

  async releaseToolCall(key: string, attempt: number) {
    await this.pool.query(
      `UPDATE tool_calls SET lease_until = now() WHERE idempotency_key = $1 AND status = 'started' AND attempts = $2`,
      [key, attempt],
    );
  }

  async claimOutbox(limit: number, leaseMs: number) {
    const r = await this.pool.query(
      `UPDATE outbox SET next_attempt_at = now() + ($2 || ' milliseconds')::interval
       WHERE id IN (SELECT id FROM outbox WHERE status = 'pending' AND next_attempt_at <= now()
                    ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED)
       RETURNING *`,
      [limit, String(leaseMs)],
    );
    return r.rows.map(toOutbox);
  }

  async updateOutbox(id: string, patch: Partial<OutboxEvent>) {
    const { sql, values } = setClause(patch, { type: 'event_type' });
    if (sql) await this.pool.query(`UPDATE outbox SET ${sql} WHERE id = $1`, [id, ...values]);
  }

  async listOutbox() {
    const r = await this.pool.query('SELECT * FROM outbox ORDER BY created_at DESC LIMIT 200');
    return r.rows.map(toOutbox);
  }

  async reserveBudget(taskId: string, amountUsd: number) {
    const r = await this.pool.query(
      `UPDATE tasks SET reserved_usd = reserved_usd + $2
       WHERE id = $1 AND spent_usd + reserved_usd + $2 <= budget_usd RETURNING spent_usd, budget_usd`,
      [taskId, amountUsd],
    );
    if (r.rows[0]) return { ok: true, spentUsd: num(r.rows[0].spent_usd), budgetUsd: num(r.rows[0].budget_usd) };
    const t = await this.pool.query('SELECT spent_usd, budget_usd FROM tasks WHERE id = $1', [taskId]);
    if (!t.rows[0]) return { ok: true, spentUsd: 0, budgetUsd: Infinity };
    return { ok: false, spentUsd: num(t.rows[0].spent_usd), budgetUsd: num(t.rows[0].budget_usd) };
  }

  async releaseBudget(taskId: string, amountUsd: number) {
    await this.pool.query('UPDATE tasks SET reserved_usd = GREATEST(reserved_usd - $2, 0) WHERE id = $1', [taskId, amountUsd]);
  }

  recordUsage(u: Usage, reservedUsd = 0) {
    return this.tx(async (c) => {
      await c.query(
        `INSERT INTO usage_records (id, task_id, subtask_id, agent, model, prompt_tokens, completion_tokens, cost_usd, saved_usd, cached, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [u.id, u.taskId, u.subtaskId, u.agent, u.model, u.promptTokens, u.completionTokens, u.costUsd, u.savedUsd, u.cached, u.createdAt],
      );
      const r = await c.query(
        `UPDATE tasks SET spent_usd = spent_usd + $2, reserved_usd = GREATEST(reserved_usd - $3, 0), updated_at = now()
         WHERE id = $1 RETURNING spent_usd`,
        [u.taskId, u.costUsd, reservedUsd],
      );
      return num(r.rows[0]?.spent_usd ?? u.costUsd);
    });
  }

  async listUsage(taskId?: string) {
    const r = taskId
      ? await this.pool.query('SELECT * FROM usage_records WHERE task_id = $1 ORDER BY created_at', [taskId])
      : await this.pool.query('SELECT * FROM usage_records ORDER BY created_at');
    return r.rows.map(toUsage);
  }

  async usageSummary(taskIds: string[]): Promise<UsageSummary> {
    const sums = 'sum(prompt_tokens + completion_tokens) AS tokens, sum(cost_usd) AS cost, count(*) AS calls';
    const bucket = (r: Row): UsageBucket => ({ key: r.key as string, tokens: num(r.tokens), costUsd: num(r.cost), calls: num(r.calls) });
    const [totals, byModel, byAgent, byTask] = await Promise.all([
      this.pool.query(`SELECT coalesce(sum(prompt_tokens + completion_tokens), 0) AS tokens, coalesce(sum(cost_usd), 0) AS cost,
        count(*) AS calls, count(*) FILTER (WHERE cached) AS hits, coalesce(sum(saved_usd), 0) AS saved FROM usage_records`),
      this.pool.query(`SELECT model AS key, ${sums} FROM usage_records GROUP BY model`),
      this.pool.query(`SELECT agent AS key, ${sums} FROM usage_records GROUP BY agent`),
      taskIds.length
        ? this.pool.query(`SELECT task_id::text AS key, ${sums} FROM usage_records WHERE task_id = ANY($1::uuid[]) GROUP BY task_id`, [taskIds])
        : Promise.resolve({ rows: [] as Row[] }),
    ]);
    const t = totals.rows[0];
    return {
      totals: { tokens: num(t.tokens), costUsd: num(t.cost), calls: num(t.calls), cacheHits: num(t.hits), savedUsd: num(t.saved) },
      byModel: byModel.rows.map(bucket),
      byAgent: byAgent.rows.map(bucket),
      byTask: byTask.rows.map(bucket),
    };
  }

  async addSnapshot(s: Snapshot) {
    const r = await this.pool.query(
      `INSERT INTO context_snapshots (task_id, version, hash, parent_hash, label, content, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (task_id, version) DO NOTHING`,
      [s.taskId, s.version, s.hash, s.parentHash, s.label, JSON.stringify(s.content), s.createdAt],
    );
    return r.rowCount === 1 ? s : null;
  }

  async listSnapshots(taskId: string) {
    const r = await this.pool.query('SELECT * FROM context_snapshots WHERE task_id = $1 ORDER BY version', [taskId]);
    return r.rows.map((row) => ({
      taskId: row.task_id, version: row.version, hash: row.hash, parentHash: row.parent_hash,
      label: row.label, content: row.content, createdAt: iso(row.created_at)!,
    }));
  }

  async addInbox(e: InboxEntry) {
    const r = await this.pool.query(
      `INSERT INTO webhook_inbox (id, event_id, event, verified, signature, payload, received_at) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (event_id) DO NOTHING`,
      [e.id, e.eventId, e.event, e.verified, e.signature, JSON.stringify(e.payload), e.receivedAt],
    );
    return r.rowCount === 1;
  }

  async listInbox(limit: number) {
    const r = await this.pool.query('SELECT * FROM webhook_inbox ORDER BY received_at DESC LIMIT $1', [limit]);
    return r.rows.map((row) => ({
      id: row.id, eventId: row.event_id ?? null, event: row.event, verified: row.verified, signature: row.signature,
      payload: row.payload, receivedAt: iso(row.received_at)!,
    }));
  }
}
