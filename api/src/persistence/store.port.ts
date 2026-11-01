import {
  Approval, InboxEntry, OutboxEvent, Snapshot, Subtask, Task, ToolCall, Usage,
} from '../common/types';

export type ToolClaim = Pick<ToolCall, 'idempotencyKey' | 'taskId' | 'subtaskId' | 'tool' | 'args' | 'createdAt'>;

/**
 * Persistence port. PgStore is the production adapter; MemoryStore backs unit
 * tests and local runs without Postgres. Methods that must be atomic say so.
 */
export interface Store {
  ping(): Promise<boolean>;

  /** Atomic on idempotencyKey: a repeated key returns the original task with replay=true. */
  createTask(task: Task, idempotencyKey: string | null): Promise<{ task: Task; replay: boolean }>;
  getTask(id: string): Promise<Task | null>;
  listTasks(limit: number): Promise<Task[]>;
  listTasksByStatus(statuses: string[]): Promise<Task[]>;
  updateTask(id: string, patch: Partial<Task>): Promise<Task>;
  /** Atomic: updates the task and enqueues the outbox event in one transaction. */
  updateTaskWithEvent(id: string, patch: Partial<Task>, event: OutboxEvent): Promise<Task>;
  /**
   * Atomic: moves a task that is not yet terminal (completed, failed, rejected,
   * budget_exceeded) to its final state and enqueues the event in one transaction.
   * Returns null, writing nothing, when the task is already terminal: a task
   * never emits two terminal events.
   */
  finishTask(id: string, patch: Partial<Task>, event: OutboxEvent): Promise<Task | null>;

  /**
   * Atomic: takes the run lease when it is free, expired or already held by `owner`
   * (re-entry; the process dedupes its own runs). Only the holder runs the task,
   * across processes and replicas. Taking it from another owner also drops budget
   * reservations left by a previous holder that died mid-call. False for an unknown task.
   */
  acquireTaskLease(taskId: string, owner: string, leaseMs: number): Promise<boolean>;
  /** Extends the lease while `owner` still holds it. False means the lease was lost. */
  renewTaskLease(taskId: string, owner: string, leaseMs: number): Promise<boolean>;
  releaseTaskLease(taskId: string, owner: string): Promise<void>;
  /** True while some runner (any replica) holds an unexpired lease. */
  isTaskLeased(taskId: string): Promise<boolean>;

  /** Idempotent: ids already stored are left untouched. */
  saveSubtasks(subtasks: Subtask[]): Promise<void>;
  updateSubtask(id: string, patch: Partial<Subtask>): Promise<Subtask>;
  listSubtasks(taskId: string): Promise<Subtask[]>;

  getStep(taskId: string, key: string): Promise<{ value: unknown } | null>;
  /**
   * Atomic, first writer wins: journals the step once. When another runner already
   * journaled it, returns inserted=false and the stored value, which callers must use.
   */
  putStep(taskId: string, key: string, value: unknown): Promise<{ inserted: boolean; value: unknown }>;

  upsertApproval(approval: Approval): Promise<Approval>;
  getApproval(taskId: string): Promise<Approval | null>;

  findToolCall(idempotencyKey: string): Promise<ToolCall | null>;
  /**
   * Atomic: inserts a 'started' row holding a lease, or takes over a 'started'
   * row whose lease expired (attempts + 1). Returns the claimed row, or null when
   * the key is completed or still leased by another worker (read it with findToolCall).
   */
  claimToolCall(call: ToolClaim, leaseMs: number): Promise<ToolCall | null>;
  /**
   * Atomic: marks the call completed and enqueues its outbox event in one
   * transaction, only if `attempt` still holds the claim. Returns the stored row
   * (the winner's row when the claim was lost).
   */
  completeToolCallWithOutbox(key: string, attempt: number, result: Record<string, unknown>, event: OutboxEvent): Promise<ToolCall>;
  /** Ends the lease of a failed attempt so a retry can claim the call right away. */
  releaseToolCall(key: string, attempt: number): Promise<void>;

  /** Claims due events (SKIP LOCKED in Postgres) so concurrent relays never double send. */
  claimOutbox(limit: number, leaseMs: number): Promise<OutboxEvent[]>;
  updateOutbox(id: string, patch: Partial<OutboxEvent>): Promise<void>;
  listOutbox(): Promise<OutboxEvent[]>;

  /**
   * Atomic: reserves `amountUsd` only if spent + reserved + amount <= budget.
   * ok=false means the call would cross the budget. A missing task is not guarded.
   */
  reserveBudget(taskId: string, amountUsd: number): Promise<{ ok: boolean; spentUsd: number; budgetUsd: number }>;
  /** Returns an unused reservation (the call failed before costing anything). */
  releaseBudget(taskId: string, amountUsd: number): Promise<void>;
  /**
   * Atomic: inserts usage, increments task spentUsd and settles `reservedUsd` of
   * the reservation made for this call, returning the new spent total.
   */
  recordUsage(usage: Usage, reservedUsd?: number): Promise<number>;
  listUsage(taskId?: string): Promise<Usage[]>;

  addSnapshot(snapshot: Snapshot): Promise<Snapshot>;
  listSnapshots(taskId: string): Promise<Snapshot[]>;

  /** Idempotent on eventId (UNIQUE + ON CONFLICT DO NOTHING). Returns false when the event was already stored. */
  addInbox(entry: InboxEntry): Promise<boolean>;
  listInbox(limit: number): Promise<InboxEntry[]>;
}
