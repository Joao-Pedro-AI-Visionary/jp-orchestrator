import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool, PoolClient } from 'pg';
import {
  Approval, InboxEntry, OutboxEvent, Snapshot, Subtask, Task, TaskLease, TERMINAL_STATUSES, ToolCall, Usage,
} from '../common/types';
import { BudgetReservation, PruneResult, Store, TaskCost, ToolClaim, UsageSummary } from './store.port';

type Row = Record<string, unknown>;
const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);
const num = (v: unknown): number => Number(v ?? 0);
const snake = (k: string): string => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const JSON_COLS = new Set(['result', 'payload', 'content', 'args', 'value']);
const REOPENABLE = ['failed', 'queued', 'planning', 'running', 'merging'];
/** Same rule as MemoryStore: a task that may still run or be resumed keeps its journal and tool calls. */
const RETAINED = [...REOPENABLE, 'awaiting_approval'];
const ms = (n: number) => String(Math.max(0, Math.round(n)));

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
  error: (r.error as string) ?? null,
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
  decidedBy: (r.decided_by as string) ?? null,
});

const countRows = (rows: Row[]) => Object.fromEntries(rows.map((r) => [r.status as string, num(r.n)]));

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
  readonly kind = 'postgres' as const;

  constructor(private readonly pool: Pool) {}

  static async connect(url: string): Promise<PgStore> {
    const pool = new Pool({ connectionString: url, max: 10 });
    await pool.query(readFileSync(join(__dirname, 'schema.sql'), 'utf8'));
    const store = new PgStore(pool);
    await store.migrate(join(__dirname, 'migrations'));
    return store;
  }

  /** Applies migrations/*.sql in name order, once each. The advisory lock serializes concurrent boots. */
  async migrate(dir: string): Promise<string[]> {
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    return this.tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(7262001)');
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

  async createTask(t: Task, key: string | null, fingerprint: string | null = null) {
    const ins = await this.pool.query(
      `INSERT INTO tasks (id, title, description, status, budget_usd, spent_usd, requires_approval,
        correction_rounds, result, error, idempotency_key, idempotency_fingerprint, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`,
      [t.id, t.title, t.description, t.status, t.budgetUsd, t.spentUsd, t.requiresApproval,
        t.correctionRounds, null, null, key, key ? fingerprint : null, t.createdAt, t.updatedAt],
    );
    if (ins.rows[0]) return { task: toTask(ins.rows[0]), replay: false, fingerprint: key ? fingerprint : null };
    const existing = await this.pool.query('SELECT * FROM tasks WHERE idempotency_key = $1', [key]);
    return { task: toTask(existing.rows[0]), replay: true, fingerprint: (existing.rows[0].idempotency_fingerprint as string) ?? null };
  }

  async countTasksByStatus() {
    return countRows((await this.pool.query('SELECT status, count(*) AS n FROM tasks GROUP BY status')).rows);
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

  private async patchTask(c: Pool | PoolClient, id: string, patch: Partial<Task>) {
    const { sql, values } = setClause({ ...patch, createdAt: undefined, updatedAt: undefined });
    const r = await c.query(
      `UPDATE tasks SET ${sql ? `${sql}, ` : ''}updated_at = now() WHERE id = $1 RETURNING *`,
      [id, ...values],
    );
    if (!r.rows[0]) throw new Error(`Tarefa ${id} não encontrada`);
    return toTask(r.rows[0]);
  }

  updateTask(id: string, patch: Partial<Task>) {
    return this.patchTask(this.pool, id, patch);
  }

  /** UPDATE ... WHERE status NOT IN terminal [AND lease_owner/lease_token match]. Null when the guard refused. */
  private async guardedPatch(c: Pool | PoolClient, id: string, patch: Partial<Task>, lease?: TaskLease) {
    const { sql, values } = setClause({ ...patch, createdAt: undefined, updatedAt: undefined });
    const params: unknown[] = [id, ...values, [...TERMINAL_STATUSES]];
    let where = `id = $1 AND status <> ALL($${params.length}::text[])`;
    if (lease) {
      params.push(lease.owner, lease.token);
      where += ` AND lease_owner = $${params.length - 1} AND lease_token = $${params.length}`;
    }
    const r = await c.query(`UPDATE tasks SET ${sql ? `${sql}, ` : ''}updated_at = now() WHERE ${where} RETURNING *`, params);
    return r.rows[0] ? toTask(r.rows[0]) : null;
  }

  updateActiveTask(id: string, patch: Partial<Task>, lease?: TaskLease) {
    return this.guardedPatch(this.pool, id, patch, lease);
  }

  finishTask(id: string, patch: Partial<Task>, e: OutboxEvent, lease?: TaskLease) {
    return this.tx(async (c) => {
      const t = await this.guardedPatch(c, id, patch, lease);
      if (t) await this.insertOutbox(c, e);
      return t;
    });
  }

  async reopenTask(id: string, lease: TaskLease) {
    const r = await this.pool.query(
      `UPDATE tasks SET status = 'running', error = NULL, updated_at = now()
       WHERE id = $1 AND status = ANY($2::text[]) AND lease_owner = $3 AND lease_token = $4 RETURNING *`,
      [id, REOPENABLE, lease.owner, lease.token],
    );
    return r.rows[0] ? toTask(r.rows[0]) : null;
  }

  async acquireTaskLease(taskId: string, owner: string, leaseMs: number) {
    const r = await this.pool.query(
      `UPDATE tasks SET lease_owner = $2, lease_until = now() + ($3 || ' milliseconds')::interval, lease_token = lease_token + 1
       WHERE id = $1 AND (lease_owner IS NULL OR lease_until IS NULL OR lease_until <= now())
       RETURNING lease_owner, lease_token`,
      [taskId, owner, ms(leaseMs)],
    );
    return r.rows[0] ? { owner: r.rows[0].lease_owner as string, token: num(r.rows[0].lease_token) } : null;
  }

  async renewTaskLease(taskId: string, lease: TaskLease, leaseMs: number) {
    const r = await this.pool.query(
      `UPDATE tasks SET lease_until = now() + ($4 || ' milliseconds')::interval
       WHERE id = $1 AND lease_owner = $2 AND lease_token = $3`,
      [taskId, lease.owner, lease.token, ms(leaseMs)],
    );
    return r.rowCount === 1;
  }

  async releaseTaskLease(taskId: string, lease: TaskLease) {
    await this.pool.query(
      'UPDATE tasks SET lease_owner = NULL, lease_until = NULL WHERE id = $1 AND lease_owner = $2 AND lease_token = $3',
      [taskId, lease.owner, lease.token],
    );
  }

  async getTaskLease(taskId: string) {
    const r = await this.pool.query(
      'SELECT lease_owner, lease_token, lease_until FROM tasks WHERE id = $1 AND lease_owner IS NOT NULL AND lease_until > now()',
      [taskId],
    );
    const row = r.rows[0];
    return row ? { owner: row.lease_owner as string, token: num(row.lease_token), until: iso(row.lease_until)! } : null;
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
    const ins = await this.pool.query(
      'INSERT INTO step_journal (task_id, step_key, value) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING value',
      [taskId, key, JSON.stringify(value ?? null)],
    );
    if (ins.rows[0]) return ins.rows[0].value;
    return (await this.getStep(taskId, key))?.value ?? null;
  }

  async upsertApproval(a: Approval) {
    const r = await this.pool.query(
      `INSERT INTO approvals (task_id, status, note, requested_at, resolved_at, decided_by) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (task_id) DO UPDATE SET status = EXCLUDED.status, note = EXCLUDED.note, resolved_at = EXCLUDED.resolved_at,
         decided_by = EXCLUDED.decided_by
       RETURNING *`,
      [a.taskId, a.status, a.note, a.requestedAt, a.resolvedAt, a.decidedBy ?? null],
    );
    return toApproval(r.rows[0]);
  }

  async resolveApproval(taskId: string, decision: 'approved' | 'rejected', note: string | null, resolvedAt: string, decidedBy: string | null = null) {
    const r = await this.pool.query(
      `UPDATE approvals SET status = $2, note = $3, resolved_at = $4, decided_by = $5
       WHERE task_id = $1 AND status = 'pending' RETURNING *`,
      [taskId, decision, note, resolvedAt, decidedBy],
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
         SET attempts = tool_calls.attempts + CASE WHEN tool_calls.lease_until IS NULL THEN 0 ELSE 1 END,
             lease_until = EXCLUDED.lease_until
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

  async releaseToolCall(key: string, attempt: number, error?: string) {
    await this.pool.query(
      `UPDATE tool_calls SET lease_until = NULL, error = COALESCE($3, error)
       WHERE idempotency_key = $1 AND status = 'started' AND attempts = $2`,
      [key, attempt, error ?? null],
    );
  }

  async failToolCall(key: string, attempt: number, error: string) {
    await this.pool.query(
      `UPDATE tool_calls SET status = 'failed', error = $3, lease_until = NULL
       WHERE idempotency_key = $1 AND status = 'started' AND attempts = $2`,
      [key, attempt, error],
    );
    return this.findToolCall(key);
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

  async countOutboxByStatus() {
    return countRows((await this.pool.query('SELECT status, count(*) AS n FROM outbox GROUP BY status')).rows);
  }

  async reserveBudget(id: string, taskId: string, amountUsd: number): Promise<BudgetReservation | null> {
    return this.tx(async (c) => {
      // FOR UPDATE serializes concurrent reservations of one task: the check and the increment are one step.
      const cur = await c.query('SELECT spent_usd, reserved_usd, budget_usd FROM tasks WHERE id = $1 FOR UPDATE', [taskId]);
      const row = cur.rows[0];
      if (!row) return null;
      const r = await c.query(
        `UPDATE tasks SET reserved_usd = reserved_usd + $2
         WHERE id = $1 AND spent_usd + reserved_usd + $2 <= budget_usd RETURNING spent_usd, reserved_usd, budget_usd`,
        [taskId, amountUsd],
      );
      if (!r.rows[0]) return { reserved: false, spentUsd: num(row.spent_usd), reservedUsd: num(row.reserved_usd), budgetUsd: num(row.budget_usd) };
      await c.query('INSERT INTO budget_reservations (id, task_id, amount_usd) VALUES ($1,$2,$3)', [id, taskId, amountUsd]);
      return { reserved: true, spentUsd: num(r.rows[0].spent_usd), reservedUsd: num(r.rows[0].reserved_usd), budgetUsd: num(r.rows[0].budget_usd) };
    });
  }

  /** Removes the reservation and gives its amount back to the task, inside the caller's transaction. */
  private async dropReservation(c: PoolClient, id: string) {
    const r = await c.query('DELETE FROM budget_reservations WHERE id = $1 RETURNING task_id, amount_usd', [id]);
    if (r.rows[0]) {
      await c.query('UPDATE tasks SET reserved_usd = GREATEST(reserved_usd - $2, 0) WHERE id = $1', [r.rows[0].task_id, r.rows[0].amount_usd]);
    }
  }

  async releaseBudget(id: string) {
    await this.tx((c) => this.dropReservation(c, id));
  }

  releaseTaskReservations(taskId: string, olderThanMs: number) {
    return this.tx(async (c) => {
      const r = await c.query(
        `DELETE FROM budget_reservations WHERE task_id = $1 AND created_at <= now() - ($2 || ' milliseconds')::interval
         RETURNING amount_usd`,
        [taskId, ms(olderThanMs)],
      );
      const freed = r.rows.reduce((sum, row) => sum + num(row.amount_usd), 0);
      if (freed > 0) await c.query('UPDATE tasks SET reserved_usd = GREATEST(reserved_usd - $2, 0) WHERE id = $1', [taskId, freed]);
      return r.rowCount ?? 0;
    });
  }

  recordUsage(u: Usage, reservationId: string | null = null) {
    return this.tx(async (c) => {
      if (reservationId) await this.dropReservation(c, reservationId);
      await c.query(
        `INSERT INTO usage_records (id, task_id, subtask_id, agent, model, prompt_tokens, completion_tokens, cost_usd, saved_usd, cached, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [u.id, u.taskId, u.subtaskId, u.agent, u.model, u.promptTokens, u.completionTokens, u.costUsd, u.savedUsd, u.cached, u.createdAt],
      );
      const r = await c.query(
        'UPDATE tasks SET spent_usd = spent_usd + $2, updated_at = now() WHERE id = $1 RETURNING spent_usd',
        [u.taskId, u.costUsd],
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

  async listUsagePage(limit: number, after: { createdAt: string; id: string } | null = null) {
    const r = after
      // The cursor comes back as a millisecond ISO string: compare at that precision, or a row
      // with microseconds would sort after its own cursor and be read again on every page.
      ? await this.pool.query(
        `SELECT * FROM usage_records WHERE (date_trunc('milliseconds', created_at), id) > ($2::timestamptz, $3::uuid)
         ORDER BY date_trunc('milliseconds', created_at), id LIMIT $1`, [limit, after.createdAt, after.id])
      : await this.pool.query(`SELECT * FROM usage_records ORDER BY date_trunc('milliseconds', created_at), id LIMIT $1`, [limit]);
    return r.rows.map(toUsage);
  }

  async summarizeUsage(): Promise<UsageSummary> {
    const bucket = (r: Row) => ({ tokens: num(r.tokens), costUsd: num(r.cost_usd), calls: num(r.calls) });
    const agg = 'COALESCE(sum(prompt_tokens + completion_tokens), 0) AS tokens, COALESCE(sum(cost_usd), 0) AS cost_usd, count(*) AS calls';
    const [totals, byModel, byAgent] = await Promise.all([
      this.pool.query(`SELECT ${agg}, count(*) FILTER (WHERE cached) AS cache_hits, COALESCE(sum(saved_usd), 0) AS saved_usd FROM usage_records`),
      this.pool.query(`SELECT model, ${agg} FROM usage_records GROUP BY model ORDER BY cost_usd DESC, model`),
      this.pool.query(`SELECT agent, ${agg} FROM usage_records GROUP BY agent ORDER BY cost_usd DESC, agent`),
    ]);
    const t = totals.rows[0];
    return {
      totals: { ...bucket(t), cacheHits: num(t.cache_hits), savedUsd: num(t.saved_usd) },
      byModel: byModel.rows.map((r) => ({ model: r.model as string, ...bucket(r) })),
      byAgent: byAgent.rows.map((r) => ({ agent: r.agent as string, ...bucket(r) })),
    };
  }

  async listTaskCosts(limit: number, offset: number): Promise<{ items: TaskCost[]; total: number }> {
    const [page, total] = await Promise.all([
      this.pool.query(
        `WITH t AS (SELECT * FROM tasks ORDER BY created_at DESC, id LIMIT $1 OFFSET $2)
         SELECT t.id, t.title, t.status, t.spent_usd, t.budget_usd, COALESCE(u.tokens, 0) AS tokens
         FROM t
         LEFT JOIN (SELECT task_id, sum(prompt_tokens + completion_tokens) AS tokens FROM usage_records
                    WHERE task_id IN (SELECT id FROM t) GROUP BY task_id) u ON u.task_id = t.id
         ORDER BY t.created_at DESC, t.id`,
        [limit, offset],
      ),
      this.pool.query('SELECT count(*) AS n FROM tasks'),
    ]);
    return {
      items: page.rows.map((r) => ({
        taskId: r.id as string, title: r.title as string, status: r.status as string,
        costUsd: num(r.spent_usd), budgetUsd: num(r.budget_usd), tokens: num(r.tokens),
      })),
      total: num(total.rows[0].n),
    };
  }

  pruneBefore(before: string): Promise<PruneResult> {
    return this.tx(async (c) => {
      const inbox = await c.query('DELETE FROM webhook_inbox WHERE received_at < $1', [before]);
      const tools = await c.query(
        `DELETE FROM tool_calls tc WHERE tc.status <> 'started' AND tc.created_at < $1
           AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.id = tc.task_id AND t.status = ANY($2::text[]))`,
        [before, RETAINED],
      );
      const journal = await c.query(
        `DELETE FROM step_journal j WHERE j.created_at < $1
           AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.id = j.task_id AND t.status = ANY($2::text[]))`,
        [before, RETAINED],
      );
      return { webhookInbox: inbox.rowCount ?? 0, toolCalls: tools.rowCount ?? 0, stepJournal: journal.rowCount ?? 0 };
    });
  }

  async addSnapshot(s: Snapshot) {
    await this.pool.query(
      'INSERT INTO context_snapshots (task_id, version, hash, parent_hash, label, content, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [s.taskId, s.version, s.hash, s.parentHash, s.label, JSON.stringify(s.content), s.createdAt],
    );
    return s;
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
