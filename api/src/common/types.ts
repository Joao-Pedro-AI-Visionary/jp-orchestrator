/** Domain types shared by every module. Mirrors docs/api-contract.md. */
export type TaskStatus =
  | 'queued' | 'planning' | 'running' | 'awaiting_approval' | 'merging'
  | 'completed' | 'failed' | 'rejected' | 'budget_exceeded';
/** Final states. The store refuses any status write on a task already in one of them (except an explicit reopen of 'failed'). */
export const TERMINAL_STATUSES: readonly TaskStatus[] = ['completed', 'failed', 'rejected', 'budget_exceeded'];
export type SubtaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
export type AgentKind = 'researcher' | 'coder' | 'tester' | 'reviewer';
export type Tier = 'cheap' | 'balanced' | 'premium';

export interface TaskResult { summary: string; artifacts: string[] }

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  budgetUsd: number;
  spentUsd: number;
  requiresApproval: boolean;
  correctionRounds: number;
  result: TaskResult | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Execution lease on a task: only the owner runs it. token is the fencing token,
 * bumped on every acquisition, so a previous owner's writes are rejected.
 */
export interface TaskLease { owner: string; token: number }

export interface Subtask {
  id: string;
  taskId: string;
  agent: AgentKind;
  title: string;
  status: SubtaskStatus;
  model: string | null;
  output: string | null;
  attempt: number;
  position: number;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface Snapshot {
  taskId: string;
  version: number;
  hash: string;
  parentHash: string | null;
  label: string;
  content: Record<string, unknown>;
  createdAt: string;
}

export interface Usage {
  id: string;
  taskId: string;
  subtaskId: string | null;
  agent: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  savedUsd: number;
  cached: boolean;
  createdAt: string;
}

export interface Approval {
  taskId: string;
  status: 'pending' | 'approved' | 'rejected';
  note: string | null;
  requestedAt: string;
  resolvedAt: string | null;
  /** Identity (API key principal) that approved or rejected; null while pending or in open mode before v0.5.0. */
  decidedBy?: string | null;
}

/**
 * A tool call row. 'started' is written (with a lease) before the handler runs;
 * 'completed' holds the result; 'failed' is terminal (attempts or key TTL exhausted)
 * and holds the reason in error. attempts is the fencing token: only the holder of
 * the current attempt may complete, release or fail the call. It grows only when a
 * claim takes over an expired lease (crash or timeout), not after a clean release.
 */
export interface ToolCall {
  idempotencyKey: string;
  taskId: string;
  subtaskId: string | null;
  tool: string;
  args: Record<string, unknown>;
  status: 'started' | 'completed' | 'failed';
  result: Record<string, unknown> | null;
  error: string | null;
  attempts: number;
  leaseUntil: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface OutboxEvent {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  status: 'pending' | 'delivered' | 'dead';
  attempts: number;
  nextAttemptAt: string;
  createdAt: string;
  deliveredAt: string | null;
  lastError: string | null;
}

export interface InboxEntry {
  id: string;
  /** Sender event id (X-JP-Event-Id). Unique: a redelivery of the same event is not stored twice. */
  eventId: string | null;
  event: string;
  verified: boolean;
  signature: string;
  payload: Record<string, unknown>;
  receivedAt: string;
}

export interface MemoryEntry { key: string; value: string; agent: string; at: string }
