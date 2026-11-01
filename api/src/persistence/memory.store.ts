import {
  Approval, InboxEntry, OutboxEvent, Snapshot, Subtask, Task, TaskLease, TaskStatus, TERMINAL_STATUSES, ToolCall, Usage,
} from '../common/types';
import { nowIso, round6 } from '../common/util';
import { Store, ToolClaim } from './store.port';

const clone = <T>(v: T): T => structuredClone(v);
const REOPENABLE: TaskStatus[] = ['failed', 'queued', 'planning', 'running', 'merging'];

interface LeaseRow { owner: string | null; token: number; until: number }

/** In-process adapter. Single threaded event loop makes every method atomic. */
export class MemoryStore implements Store {
  private tasks = new Map<string, Task>();
  private idem = new Map<string, string>();
  private subtasks = new Map<string, Subtask>();
  private steps = new Map<string, unknown>();
  private approvals = new Map<string, Approval>();
  private leases = new Map<string, LeaseRow>();
  private toolCalls = new Map<string, ToolCall>();
  private outbox = new Map<string, OutboxEvent>();
  private usage: Usage[] = [];
  private snapshots: Snapshot[] = [];
  private inbox: InboxEntry[] = [];

  async ping() { return true; }

  async createTask(task: Task, key: string | null) {
    if (key && this.idem.has(key)) {
      return { task: clone(this.tasks.get(this.idem.get(key)!)!), replay: true };
    }
    this.tasks.set(task.id, clone(task));
    if (key) this.idem.set(key, task.id);
    return { task: clone(task), replay: false };
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

  private holds(taskId: string, lease?: TaskLease) {
    if (!lease) return true;
    const l = this.leases.get(taskId);
    return !!l && l.owner === lease.owner && l.token === lease.token;
  }

  async updateActiveTask(id: string, patch: Partial<Task>, lease?: TaskLease) {
    const t = this.tasks.get(id);
    if (!t) throw new Error(`Tarefa ${id} não encontrada`);
    if (TERMINAL_STATUSES.includes(t.status) || !this.holds(id, lease)) return null;
    return this.updateTask(id, patch);
  }

  async finishTask(id: string, patch: Partial<Task>, event: OutboxEvent, lease?: TaskLease) {
    const t = await this.updateActiveTask(id, patch, lease);
    if (t) this.outbox.set(event.id, clone(event));
    return t;
  }

  async reopenTask(id: string, lease: TaskLease) {
    const t = this.tasks.get(id);
    if (!t || !REOPENABLE.includes(t.status) || !this.holds(id, lease)) return null;
    return this.updateTask(id, { status: 'running', error: null });
  }

  async acquireTaskLease(taskId: string, owner: string, leaseMs: number) {
    if (!this.tasks.has(taskId)) return null;
    const now = Date.now();
    const l = this.leases.get(taskId) ?? { owner: null, token: 0, until: 0 };
    if (l.owner && l.until > now) return null;
    const next = { owner, token: l.token + 1, until: now + leaseMs };
    this.leases.set(taskId, next);
    return { owner, token: next.token };
  }

  async renewTaskLease(taskId: string, lease: TaskLease, leaseMs: number) {
    if (!this.holds(taskId, lease)) return false;
    this.leases.get(taskId)!.until = Date.now() + leaseMs;
    return true;
  }

  async releaseTaskLease(taskId: string, lease: TaskLease) {
    const l = this.leases.get(taskId);
    if (l && this.holds(taskId, lease)) Object.assign(l, { owner: null, until: 0 });
  }

  async getTaskLease(taskId: string) {
    const l = this.leases.get(taskId);
    if (!l?.owner || l.until <= Date.now()) return null;
    return { owner: l.owner, token: l.token, until: new Date(l.until).toISOString() };
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
    if (!this.steps.has(k)) this.steps.set(k, clone(value));
    return clone(this.steps.get(k));
  }

  async upsertApproval(a: Approval) {
    this.approvals.set(a.taskId, clone(a));
    return clone(a);
  }

  async resolveApproval(taskId: string, decision: 'approved' | 'rejected', note: string | null, resolvedAt: string) {
    const a = this.approvals.get(taskId);
    if (!a || a.status !== 'pending') return null;
    Object.assign(a, { status: decision, note, resolvedAt });
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
      const call: ToolCall = { ...clone(claim), status: 'started', result: null, error: null, attempts: 1, leaseUntil, completedAt: null };
      this.toolCalls.set(call.idempotencyKey, call);
      return clone(call);
    }
    if (existing.status !== 'started' || (existing.leaseUntil && Date.parse(existing.leaseUntil) > now)) return null;
    // Only a takeover of an expired lease is a new attempt; a cleanly released call keeps its attempt.
    Object.assign(existing, { attempts: existing.attempts + (existing.leaseUntil ? 1 : 0), leaseUntil });
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

  async releaseToolCall(key: string, attempt: number, error?: string) {
    const c = this.toolCalls.get(key);
    if (c && c.status === 'started' && c.attempts === attempt) Object.assign(c, { leaseUntil: null, error: error ?? c.error });
  }

  async failToolCall(key: string, attempt: number, error: string) {
    const c = this.toolCalls.get(key);
    if (!c) return null;
    if (c.status === 'started' && c.attempts === attempt) Object.assign(c, { status: 'failed', error, leaseUntil: null });
    return clone(c);
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

  async recordUsage(u: Usage) {
    this.usage.push(clone(u));
    const t = this.tasks.get(u.taskId);
    if (!t) return u.costUsd;
    t.spentUsd = round6(t.spentUsd + u.costUsd);
    return t.spentUsd;
  }

  async listUsage(taskId?: string) {
    return this.usage.filter((u) => !taskId || u.taskId === taskId).map(clone);
  }

  async addSnapshot(s: Snapshot) {
    if (this.snapshots.some((x) => x.taskId === s.taskId && x.version === s.version)) {
      throw new Error(`Snapshot v${s.version} já existe para ${s.taskId}`);
    }
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
    return true;
  }

  async listInbox(limit: number) {
    return this.inbox.slice(0, limit).map(clone);
  }
}
