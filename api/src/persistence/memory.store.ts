import {
  Approval, InboxEntry, OutboxEvent, Snapshot, Subtask, Task, ToolCall, Usage,
} from '../common/types';
import { envNumber, nowIso, round6 } from '../common/util';
import { IdempotencyClaim, Store, ToolClaim, UsageBucket, UsageSummary } from './store.port';

const clone = <T>(v: T): T => structuredClone(v);
const TERMINAL = new Set(['completed', 'failed', 'rejected', 'budget_exceeded']);
const MAX_INBOX = 500;

/**
 * In-process adapter. Single threaded event loop makes every method atomic.
 * Bounded for long demo runs: past `maxTasks` the oldest finished tasks are dropped
 * with everything that belongs to them (usage included), and the inbox keeps the
 * newest MAX_INBOX entries.
 */
export class MemoryStore implements Store {
  constructor(private readonly maxTasks = envNumber('MEMORY_STORE_MAX_TASKS', 500)) {}

  private tasks = new Map<string, Task>();
  private idem = new Map<string, { taskId: string; bodyHash: string; at: number }>();
  private subtasks = new Map<string, Subtask>();
  private steps = new Map<string, unknown>();
  private approvals = new Map<string, Approval>();
  private toolCalls = new Map<string, ToolCall>();
  private outbox = new Map<string, OutboxEvent>();
  private usage: Usage[] = [];
  private snapshots: Snapshot[] = [];
  private inbox: InboxEntry[] = [];
  private leases = new Map<string, { owner: string; until: number }>();
  private reserved = new Map<string, number>();

  async ping() { return true; }

  async createTask(task: Task, idem: IdempotencyClaim | null) {
    const prev = idem ? this.idem.get(idem.key) : undefined;
    if (idem && prev && Date.now() - prev.at < idem.ttlMs && this.tasks.has(prev.taskId)) {
      return { task: clone(this.tasks.get(prev.taskId)!), replay: true, mismatch: prev.bodyHash !== idem.bodyHash };
    }
    this.tasks.set(task.id, clone(task));
    if (idem) this.idem.set(idem.key, { taskId: task.id, bodyHash: idem.bodyHash, at: Date.now() });
    return { task: clone(task), replay: false, mismatch: false };
  }

  async getTask(id: string) {
    const t = this.tasks.get(id);
    return t ? clone(t) : null;
  }

  async listTasks(limit: number) {
    return [...this.tasks.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit).map(clone);
  }

  async listTasksByStatus(statuses: string[]) {
    return [...this.tasks.values()].filter((t) => statuses.includes(t.status)).map(clone);
  }

  async updateTask(id: string, patch: Partial<Task>) {
    const t = this.tasks.get(id);
    if (!t) throw new Error(`Tarefa ${id} não encontrada`);
    Object.assign(t, patch, { updatedAt: nowIso() });
    return clone(t);
  }

  async updateTaskWithEvent(id: string, patch: Partial<Task>, event: OutboxEvent) {
    const t = await this.updateTask(id, patch);
    this.outbox.set(event.id, clone(event));
    return t;
  }

  async finishTask(id: string, patch: Partial<Task>, event: OutboxEvent) {
    const t = this.tasks.get(id);
    if (!t) throw new Error(`Tarefa ${id} não encontrada`);
    if (TERMINAL.has(t.status)) return null;
    const done = await this.updateTaskWithEvent(id, patch, event);
    this.evict();
    return done;
  }

  /** Drops the oldest finished tasks (and their rows) while over maxTasks. Active tasks stay. */
  private evict() {
    if (this.tasks.size <= this.maxTasks) return;
    const finished = [...this.tasks.values()].filter((t) => TERMINAL.has(t.status))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const t of finished.slice(0, this.tasks.size - this.maxTasks)) {
      this.tasks.delete(t.id);
      this.leases.delete(t.id);
      this.reserved.delete(t.id);
      this.approvals.delete(t.id);
      for (const [k, v] of this.idem) if (v.taskId === t.id) this.idem.delete(k);
      for (const [k, s] of this.subtasks) if (s.taskId === t.id) this.subtasks.delete(k);
      for (const k of this.steps.keys()) if (k.startsWith(`${t.id}:`)) this.steps.delete(k);
      for (const [k, c] of this.toolCalls) if (c.taskId === t.id) this.toolCalls.delete(k);
      for (const [k, e] of this.outbox) if (e.payload.taskId === t.id && e.status !== 'pending') this.outbox.delete(k);
      this.usage = this.usage.filter((u) => u.taskId !== t.id);
      this.snapshots = this.snapshots.filter((x) => x.taskId !== t.id);
    }
  }

  async acquireTaskLease(taskId: string, owner: string, leaseMs: number) {
    if (!this.tasks.has(taskId)) return false;
    const now = Date.now();
    const current = this.leases.get(taskId);
    if (current && current.until > now && current.owner !== owner) return false;
    this.leases.set(taskId, { owner, until: now + leaseMs });
    if (current?.owner !== owner) this.reserved.delete(taskId);
    return true;
  }

  async renewTaskLease(taskId: string, owner: string, leaseMs: number) {
    const current = this.leases.get(taskId);
    if (!current || current.owner !== owner) return false;
    current.until = Date.now() + leaseMs;
    return true;
  }

  async releaseTaskLease(taskId: string, owner: string) {
    if (this.leases.get(taskId)?.owner === owner) this.leases.delete(taskId);
  }

  async isTaskLeased(taskId: string) {
    return (this.leases.get(taskId)?.until ?? 0) > Date.now();
  }

  async saveSubtasks(list: Subtask[]) {
    for (const s of list) if (!this.subtasks.has(s.id)) this.subtasks.set(s.id, clone(s));
  }

  async updateSubtask(id: string, patch: Partial<Subtask>) {
    const s = this.subtasks.get(id);
    if (!s) throw new Error(`Subtarefa ${id} não encontrada`);
    Object.assign(s, patch);
    return clone(s);
  }

  async listSubtasks(taskId: string) {
    return [...this.subtasks.values()]
      .filter((s) => s.taskId === taskId)
      .sort((a, b) => a.position - b.position).map(clone);
  }

  async getStep(taskId: string, key: string) {
    const k = `${taskId}:${key}`;
    return this.steps.has(k) ? { value: clone(this.steps.get(k)) } : null;
  }

  async putStep(taskId: string, key: string, value: unknown) {
    const k = `${taskId}:${key}`;
    if (this.steps.has(k)) return { inserted: false, value: clone(this.steps.get(k)) };
    this.steps.set(k, clone(value));
    return { inserted: true, value };
  }

  async upsertApproval(a: Approval) {
    this.approvals.set(a.taskId, clone(a));
    return clone(a);
  }

  async resolveApproval(taskId: string, status: 'approved' | 'rejected', note: string | null) {
    const a = this.approvals.get(taskId);
    if (!a || a.status !== 'pending') return null;
    Object.assign(a, { status, note, resolvedAt: nowIso() });
    return clone(a);
  }

  async getApproval(taskId: string) {
    const a = this.approvals.get(taskId);
    return a ? clone(a) : null;
  }

  async findToolCall(key: string) {
    const c = this.toolCalls.get(key);
    return c ? clone(c) : null;
  }

  async claimToolCall(claim: ToolClaim, leaseMs: number) {
    const now = Date.now();
    const leaseUntil = new Date(now + leaseMs).toISOString();
    const existing = this.toolCalls.get(claim.idempotencyKey);
    if (!existing) {
      const call: ToolCall = { ...clone(claim), status: 'started', result: null, attempts: 1, leaseUntil, completedAt: null };
      this.toolCalls.set(call.idempotencyKey, call);
      return clone(call);
    }
    if (existing.status !== 'started' || (existing.leaseUntil && Date.parse(existing.leaseUntil) > now)) return null;
    Object.assign(existing, { attempts: existing.attempts + 1, leaseUntil });
    return clone(existing);
  }

  async completeToolCallWithOutbox(key: string, attempt: number, result: Record<string, unknown>, event: OutboxEvent) {
    const c = this.toolCalls.get(key);
    if (!c) throw new Error(`Chamada de ferramenta ${key} não encontrada`);
    if (c.status === 'started' && c.attempts === attempt) {
      Object.assign(c, { status: 'completed', result: clone(result), leaseUntil: null, completedAt: nowIso() });
      this.outbox.set(event.id, clone(event));
    }
    return clone(c);
  }

  async releaseToolCall(key: string, attempt: number) {
    const c = this.toolCalls.get(key);
    if (c && c.status === 'started' && c.attempts === attempt) c.leaseUntil = nowIso();
  }

  async claimOutbox(limit: number, leaseMs: number) {
    const now = Date.now();
    const due = [...this.outbox.values()]
      .filter((e) => e.status === 'pending' && Date.parse(e.nextAttemptAt) <= now)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, limit);
    for (const e of due) e.nextAttemptAt = new Date(now + leaseMs).toISOString();
    return due.map(clone);
  }

  async updateOutbox(id: string, patch: Partial<OutboxEvent>) {
    const e = this.outbox.get(id);
    if (e) Object.assign(e, patch);
  }

  async listOutbox() {
    return [...this.outbox.values()].map(clone);
  }

  async reserveBudget(taskId: string, amountUsd: number) {
    const t = this.tasks.get(taskId);
    if (!t) return { ok: true, spentUsd: 0, budgetUsd: Infinity };
    const reserved = this.reserved.get(taskId) ?? 0;
    if (round6(t.spentUsd + reserved + amountUsd) > t.budgetUsd) return { ok: false, spentUsd: t.spentUsd, budgetUsd: t.budgetUsd };
    this.reserved.set(taskId, round6(reserved + amountUsd));
    return { ok: true, spentUsd: t.spentUsd, budgetUsd: t.budgetUsd };
  }

  async releaseBudget(taskId: string, amountUsd: number) {
    this.reserved.set(taskId, Math.max(0, round6((this.reserved.get(taskId) ?? 0) - amountUsd)));
  }

  async recordUsage(u: Usage, reservedUsd = 0) {
    this.usage.push(clone(u));
    const t = this.tasks.get(u.taskId);
    if (!t) return u.costUsd;
    t.spentUsd = round6(t.spentUsd + u.costUsd);
    if (reservedUsd) await this.releaseBudget(u.taskId, reservedUsd);
    return t.spentUsd;
  }

  async listUsage(taskId?: string) {
    return this.usage.filter((u) => !taskId || u.taskId === taskId).map(clone);
  }

  async usageSummary(taskIds: string[]): Promise<UsageSummary> {
    const group = (key: (u: Usage) => string, only?: Set<string>): UsageBucket[] => {
      const map = new Map<string, UsageBucket>();
      for (const u of this.usage) {
        const k = key(u);
        if (only && !only.has(k)) continue;
        const b = map.get(k) ?? { key: k, tokens: 0, costUsd: 0, calls: 0 };
        b.tokens += u.promptTokens + u.completionTokens;
        b.costUsd = round6(b.costUsd + u.costUsd);
        b.calls++;
        map.set(k, b);
      }
      return [...map.values()];
    };
    return {
      totals: {
        tokens: this.usage.reduce((s, u) => s + u.promptTokens + u.completionTokens, 0),
        costUsd: round6(this.usage.reduce((s, u) => s + u.costUsd, 0)),
        calls: this.usage.length,
        cacheHits: this.usage.filter((u) => u.cached).length,
        savedUsd: round6(this.usage.reduce((s, u) => s + u.savedUsd, 0)),
      },
      byModel: group((u) => u.model),
      byAgent: group((u) => u.agent),
      byTask: group((u) => u.taskId, new Set(taskIds)),
    };
  }

  async addSnapshot(s: Snapshot) {
    if (this.snapshots.some((x) => x.taskId === s.taskId && x.version === s.version)) return null;
    this.snapshots.push(clone(s));
    return clone(s);
  }

  async listSnapshots(taskId: string) {
    return this.snapshots.filter((s) => s.taskId === taskId)
      .sort((a, b) => a.version - b.version).map(clone);
  }

  async addInbox(e: InboxEntry) {
    if (e.eventId && this.inbox.some((x) => x.eventId === e.eventId)) return false;
    this.inbox.unshift(clone(e));
    this.inbox.length = Math.min(this.inbox.length, MAX_INBOX);
    return true;
  }

  async listInbox(limit: number) {
    return this.inbox.slice(0, limit).map(clone);
  }
}
