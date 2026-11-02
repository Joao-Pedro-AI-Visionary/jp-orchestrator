export type TaskStatus =
  | "queued"
  | "planning"
  | "running"
  | "awaiting_approval"
  | "merging"
  | "completed"
  | "failed"
  | "rejected"
  | "budget_exceeded";
export type SubtaskStatus = "pending" | "running" | "done" | "failed" | "cancelled";
export type AgentKind = "researcher" | "coder" | "tester" | "reviewer";

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  budgetUsd: number;
  spentUsd: number;
  requiresApproval: boolean;
  correctionRounds: number;
  result: { summary: string; artifacts: string[] } | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface Subtask {
  id: string;
  taskId: string;
  agent: AgentKind;
  title: string;
  status: SubtaskStatus;
  model: string | null;
  output: string | null;
  attempt: number;
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
  cached: boolean;
  createdAt: string;
}
export interface Approval {
  taskId: string;
  status: "pending" | "approved" | "rejected";
  note: string | null;
  requestedAt: string;
  resolvedAt: string | null;
  /** Who approved or rejected (API key identity). */
  decidedBy?: string | null;
}
export interface MemoryEntry {
  key: string;
  value: unknown;
  agent: string;
  at: string;
}
export interface TaskDetail {
  task: Task;
  subtasks: Subtask[];
  snapshots: Snapshot[];
  usage: Usage[];
  approval: Approval | null;
  memory: MemoryEntry[];
}
/** "memory": not configured, the API runs on its in-process adapter (valid, not an outage). */
export type DependencyState = "up" | "down" | "memory";
export interface Health {
  ok: boolean;
  postgres: boolean;
  redis: boolean;
  services?: { postgres: DependencyState; redis: DependencyState };
}
export interface BillingSummary {
  totals: { tokens: number; costUsd: number; calls: number; cacheHits: number; savedUsd: number };
  byModel: { model: string; tokens: number; costUsd: number; calls: number }[];
  byAgent: { agent: string; tokens: number; costUsd: number; calls: number }[];
  byTask: {
    taskId: string;
    title: string;
    status: TaskStatus;
    costUsd: number;
    budgetUsd: number;
    tokens: number;
  }[];
}
export interface GatewayModel {
  id: string;
  provider: string;
  tier: "cheap" | "balanced" | "premium";
  inputPer1k: number;
  outputPer1k: number;
  healthy: boolean;
}
export interface GatewayStats {
  requests: number;
  cacheHits: number;
  fallbacks: number;
  rejectedTokenLimit: number;
  budgetBlocks: number;
}
export interface WebhookItem {
  id: string;
  event: string;
  verified: boolean;
  signature: string;
  receivedAt: string;
  payload: unknown;
}
export interface ServerEvent {
  type: string;
  taskId: string | null;
  payload: Record<string, unknown> | null;
  at: string;
}
export interface GatewayCall {
  key: string;
  model: string;
  cached: boolean;
  fallbackFrom?: string;
  tokens: number;
  costUsd: number;
  agent: string;
  at: string;
}
