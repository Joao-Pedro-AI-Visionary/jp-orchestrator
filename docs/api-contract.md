# Contrato da API (v0.1)

Base: `http://localhost:3001`. JSON em tudo. CORS liberado para o dashboard.

## Tipos

```ts
type TaskStatus = 'queued' | 'planning' | 'running' | 'awaiting_approval' | 'merging'
  | 'completed' | 'failed' | 'rejected' | 'budget_exceeded';
type SubtaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
type AgentKind = 'researcher' | 'coder' | 'tester' | 'reviewer';

interface Task {
  id: string; title: string; description: string; status: TaskStatus;
  budgetUsd: number; spentUsd: number; requiresApproval: boolean;
  correctionRounds: number; result: { summary: string; artifacts: string[] } | null;
  error: string | null; createdAt: string; updatedAt: string;
}
interface Subtask {
  id: string; taskId: string; agent: AgentKind; title: string; status: SubtaskStatus;
  model: string | null; output: string | null; attempt: number;
  startedAt: string | null; finishedAt: string | null;
}
interface Snapshot { taskId: string; version: number; hash: string; parentHash: string | null;
  label: string; content: Record<string, unknown>; createdAt: string; }
interface Usage { id: string; taskId: string; subtaskId: string | null; agent: string; model: string;
  promptTokens: number; completionTokens: number; costUsd: number; cached: boolean; createdAt: string; }
interface Approval { taskId: string; status: 'pending' | 'approved' | 'rejected'; note: string | null;
  requestedAt: string; resolvedAt: string | null; }
```

## Endpoints

| Método | Rota | Corpo / Header | Resposta |
|---|---|---|---|
| GET | /health | | `{ ok: true, postgres: bool, redis: bool }` |
| POST | /tasks | `{ title, description, budgetUsd?=0.05, requiresApproval?=false }`, header opcional `Idempotency-Key` | 201 `Task` (repetição com a mesma chave: 200 + header `Idempotent-Replay: true`, mesma Task) |
| GET | /tasks | | `Task[]` (mais recentes primeiro, até 50) |
| GET | /tasks/:id | | `{ task, subtasks: Subtask[], snapshots: Snapshot[], usage: Usage[], approval: Approval \| null, memory: {key,value,agent,at}[] }` |
| POST | /tasks/:id/approve | `{ note? }` | `Task` (retoma o loop durável) |
| POST | /tasks/:id/reject | `{ note? }` | `Task` (status `rejected`) |
| POST | /tasks/:id/resume | | `Task` (retoma tarefa `failed`/`running` a partir do journal) |
| GET | /billing/summary | | `{ totals: {tokens, costUsd, calls, cacheHits, savedUsd}, byModel: {model,tokens,costUsd,calls}[], byAgent: {agent,tokens,costUsd,calls}[], byTask: {taskId,title,status,costUsd,budgetUsd,tokens}[] }` |
| GET | /billing/report.csv | | `text/csv` |
| GET | /gateway/models | | `{ id, provider, tier: 'cheap'\|'balanced'\|'premium', inputPer1k, outputPer1k, healthy }[]` |
| POST | /gateway/models/:id/toggle | | modelo atualizado (simula queda, força fallback) |
| GET | /gateway/stats | | `{ requests, cacheHits, fallbacks, rejectedTokenLimit, budgetBlocks }` |
| GET | /webhooks/inbox | | `{ id, event, verified, signature, receivedAt, payload }[]` |
| GET | /events | SSE | cada mensagem `data: { type, taskId, payload, at }` |

Tipos de evento SSE: `task.created`, `task.status`, `subtask.status`, `gateway.call`
(`payload: { model, cached, fallbackFrom?, tokens, costUsd, agent }`), `usage.recorded`,
`snapshot.created`, `approval.requested`, `approval.resolved`, `webhook.delivered`.

## Fluxo

plan -> dispatch (subagentes em paralelo) -> review/correção (máx. 2 rodadas) ->
[aprovação humana, se `requiresApproval`] -> merge -> `completed` + evento `task.completed`
assinado (HMAC) entregue via outbox ao webhook.
