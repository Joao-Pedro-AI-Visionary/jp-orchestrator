import {
  Approval, InboxEntry, OutboxEvent, Snapshot, Subtask, Task, TaskLease, ToolCall, Usage,
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
  /** Unguarded patch (no status or lease check). The orchestrator uses the guarded methods below. */
  updateTask(id: string, patch: Partial<Task>): Promise<Task>;
  /**
   * Atomic and guarded: patches the task only while it is not in a terminal status
   * and, when a lease is given, only while that lease still holds (fencing).
   * Returns null when the guard refused the write.
   */
  updateActiveTask(id: string, patch: Partial<Task>, lease?: TaskLease): Promise<Task | null>;
  /**
   * Atomic terminal transition: same guard as updateActiveTask, and the outbox event is
   * enqueued in the same transaction only if the transition happened. A task reaches a
   * terminal status once, so it emits exactly one terminal event. Null when refused.
   */
  finishTask(id: string, patch: Partial<Task>, event: OutboxEvent, lease?: TaskLease): Promise<Task | null>;
  /** Atomic: a failed (or stuck active) task goes back to running, fenced by the caller's lease. Null when refused. */
  reopenTask(id: string, lease: TaskLease): Promise<Task | null>;

  /**
   * Atomic: takes the execution lease when nobody holds a live one, bumping the fencing
   * token. Null while another owner holds it (one run per task across replicas).
   */
  acquireTaskLease(taskId: string, owner: string, leaseMs: number): Promise<TaskLease | null>;
  /** Heartbeat: extends the lease only while this owner and token still hold it. */
  renewTaskLease(taskId: string, lease: TaskLease, leaseMs: number): Promise<boolean>;
  releaseTaskLease(taskId: string, lease: TaskLease): Promise<void>;
  /** The live (unexpired) lease, if any. */
  getTaskLease(taskId: string): Promise<(TaskLease & { until: string }) | null>;

  /** Inserts subtasks; an id that already exists is kept as is (re-running the plan step is harmless). */
  saveSubtasks(subtasks: Subtask[]): Promise<void>;
  updateSubtask(id: string, patch: Partial<Subtask>): Promise<Subtask>;
  listSubtasks(taskId: string): Promise<Subtask[]>;

  getStep(taskId: string, key: string): Promise<{ value: unknown } | null>;
  /** First writer wins: returns the journaled value, which is the caller's own only if it inserted first. */
  putStep(taskId: string, key: string, value: unknown): Promise<unknown>;

  upsertApproval(approval: Approval): Promise<Approval>;
  /** Atomic: pending -> decision. Null when the approval is missing or already decided. */
  resolveApproval(taskId: string, decision: 'approved' | 'rejected', note: string | null, resolvedAt: string): Promise<Approval | null>;
  getApproval(taskId: string): Promise<Approval | null>;

  findToolCall(idempotencyKey: string): Promise<ToolCall | null>;
  /**
   * Atomic: inserts a 'started' row holding a lease, re-claims a cleanly released one
   * (lease null, same attempt) or takes over a 'started' row whose lease expired
   * (attempts + 1). Returns the claimed row, or null when the key is completed,
   * failed or still leased by another worker (read it with findToolCall).
   */
  claimToolCall(call: ToolClaim, leaseMs: number): Promise<ToolCall | null>;
  /**
   * Atomic: marks the call completed and enqueues its outbox event in one
   * transaction, only if `attempt` still holds the claim. Returns the stored row
   * (the winner's row when the claim was lost).
   */
  completeToolCallWithOutbox(key: string, attempt: number, result: Record<string, unknown>, event: OutboxEvent): Promise<ToolCall>;
  /** Clean failure: clears the lease (and records the error) so a retry claims the same attempt right away. */
  releaseToolCall(key: string, attempt: number, error?: string): Promise<void>;
  /** Terminal: the call will never run again. Fenced by attempt; returns the stored row. */
  failToolCall(key: string, attempt: number, error: string): Promise<ToolCall | null>;

  /** Claims due events (SKIP LOCKED in Postgres) so concurrent relays never double send. */
  claimOutbox(limit: number, leaseMs: number): Promise<OutboxEvent[]>;
  updateOutbox(id: string, patch: Partial<OutboxEvent>): Promise<void>;
  listOutbox(): Promise<OutboxEvent[]>;

  /** Atomic: inserts usage and increments task spentUsd, returning the new total. */
  recordUsage(usage: Usage): Promise<number>;
  listUsage(taskId?: string): Promise<Usage[]>;

  addSnapshot(snapshot: Snapshot): Promise<Snapshot>;
  listSnapshots(taskId: string): Promise<Snapshot[]>;

  /** Idempotent on eventId (UNIQUE + ON CONFLICT DO NOTHING). Returns false when the event was already stored. */
  addInbox(entry: InboxEntry): Promise<boolean>;
  listInbox(limit: number): Promise<InboxEntry[]>;
}
