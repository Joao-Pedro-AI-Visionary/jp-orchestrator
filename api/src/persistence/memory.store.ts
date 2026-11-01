import {
  Approval, InboxEntry, OutboxEvent, Snapshot, Subtask, Task, ToolCall, Usage,
} from '../common/types';
import { nowIso, round6 } from '../common/util';
import { Store, ToolClaim } from './store.port';

const clone = <T>(v: T): T => structuredClone(v);
const TERMINAL = new Set(['completed', 'failed', 'rejected', 'budget_exceeded']);

/** In-process adapter. Single threaded event loop makes every method atomic. */
export class MemoryStore implements Store {
  private tasks = new Map<string, Task>();
  private idem = new Map<string, string>();
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

  async updateTaskWithEvent(id: string, patch: Partial<Task>, event: OutboxEvent) {
    const t = await this.updateTask(id, patch);
    this.outbox.set(event.id, clone(event));
    return t;
  }

  async finishTask(id: string, patch: Partial<Task>, event: OutboxEvent) {
    const t = this.tasks.get(id);
    if (!t) throw new Error(`Tarefa ${id} não encontrada`);
    if (TERMINAL.has(t.status)) return null;
    return this.updateTaskWithEvent(id, patch, event);
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
