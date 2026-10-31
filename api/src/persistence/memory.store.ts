import {
  Approval, InboxEntry, OutboxEvent, Snapshot, Subtask, Task, ToolCall, Usage,
} from '../common/types';
import { nowIso, round6 } from '../common/util';
import { Store } from './store.port';

const clone = <T>(v: T): T => structuredClone(v);

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

  async saveSubtasks(list: Subtask[]) {
    for (const s of list) this.subtasks.set(s.id, clone(s));
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

  async saveToolCallWithOutbox(call: ToolCall, event: OutboxEvent) {
    const existing = this.toolCalls.get(call.idempotencyKey);
    if (existing) return clone(existing);
    this.toolCalls.set(call.idempotencyKey, clone(call));
    this.outbox.set(event.id, clone(event));
    return clone(call);
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
    this.inbox.unshift(clone(e));
  }

  async listInbox(limit: number) {
    return this.inbox.slice(0, limit).map(clone);
  }
}
