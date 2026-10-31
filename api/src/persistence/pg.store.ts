import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool, PoolClient } from 'pg';
import {
  Approval, InboxEntry, OutboxEvent, Snapshot, Subtask, Task, ToolCall, Usage,
} from '../common/types';
import { Store } from './store.port';

type Row = Record<string, unknown>;
const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);
const num = (v: unknown): number => Number(v ?? 0);
const snake = (k: string): string => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const JSON_COLS = new Set(['result', 'payload', 'content', 'args', 'value']);

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
    await pool.query(readFileSync(join(__dirname, 'schema.sql'), 'utf8'));
    return new PgStore(pool);
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

  async createTask(t: Task, key: string | null) {
    const ins = await this.pool.query(
      `INSERT INTO tasks (id, title, description, status, budget_usd, spent_usd, requires_approval,
        correction_rounds, result, error, idempotency_key, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`,
      [t.id, t.title, t.description, t.status, t.budgetUsd, t.spentUsd, t.requiresApproval,
        t.correctionRounds, null, null, key, t.createdAt, t.updatedAt],
    );
    if (ins.rows[0]) return { task: toTask(ins.rows[0]), replay: false };
    const existing = await this.pool.query('SELECT * FROM tasks WHERE idempotency_key = $1', [key]);
    return { task: toTask(existing.rows[0]), replay: true };
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

  updateTaskWithEvent(id: string, patch: Partial<Task>, e: OutboxEvent) {
    return this.tx(async (c) => {
      const t = await this.patchTask(c, id, patch);
      await this.insertOutbox(c, e);
      return t;
    });
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
    await this.pool.query(
      'INSERT INTO step_journal (task_id, step_key, value) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
      [taskId, key, JSON.stringify(value ?? null)],
    );
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

  async getApproval(taskId: string) {
    const r = await this.pool.query('SELECT * FROM approvals WHERE task_id = $1', [taskId]);
    return r.rows[0] ? toApproval(r.rows[0]) : null;
  }

  async findToolCall(key: string) {
    const r = await this.pool.query('SELECT * FROM tool_calls WHERE idempotency_key = $1', [key]);
    const row = r.rows[0];
    return row ? {
      idempotencyKey: row.idempotency_key, taskId: row.task_id, subtaskId: row.subtask_id,
      tool: row.tool, args: row.args, result: row.result, createdAt: iso(row.created_at)!,
    } : null;
  }

  async saveToolCallWithOutbox(call: ToolCall, e: OutboxEvent) {
    const inserted = await this.tx(async (c) => {
      const r = await c.query(
        `INSERT INTO tool_calls (idempotency_key, task_id, subtask_id, tool, args, result, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING idempotency_key`,
        [call.idempotencyKey, call.taskId, call.subtaskId, call.tool, JSON.stringify(call.args), JSON.stringify(call.result), call.createdAt],
      );
      if (r.rowCount) await this.insertOutbox(c, e);
      return Boolean(r.rowCount);
    });
    return inserted ? call : (await this.findToolCall(call.idempotencyKey))!;
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

  recordUsage(u: Usage) {
    return this.tx(async (c) => {
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
    await this.pool.query(
      'INSERT INTO webhook_inbox (id, event, verified, signature, payload, received_at) VALUES ($1,$2,$3,$4,$5,$6)',
      [e.id, e.event, e.verified, e.signature, JSON.stringify(e.payload), e.receivedAt],
    );
  }

  async listInbox(limit: number) {
    const r = await this.pool.query('SELECT * FROM webhook_inbox ORDER BY received_at DESC LIMIT $1', [limit]);
    return r.rows.map((row) => ({
      id: row.id, event: row.event, verified: row.verified, signature: row.signature,
      payload: row.payload, receivedAt: iso(row.received_at)!,
    }));
  }
}
