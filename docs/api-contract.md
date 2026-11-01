# Contrato da API (v0.1)

Base: `http://localhost:3001` (o dashboard usa `/api` no próprio domínio, repassado pelo servidor do Next).
JSON em tudo. CORS só para as origens de `CORS_ORIGIN`. Toda rota exige a API key, exceto `GET /health` e
`POST /webhooks/inbox`. Erros internos chegam ao cliente como `Erro interno (ref xxxxxxxx)`; o detalhe fica no log.

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
| GET | /health | | `{ ok: true, postgres, redis, store }`, cada dependência `'up' \| 'down' \| 'disabled'` (`disabled`: não configurada, adaptador em memória) |
| POST | /tasks | `{ title (3–200), description (1–4000), budgetUsd? (0–100, padrão 0.05), requiresApproval?=false }`, header opcional `Idempotency-Key` (até 255) | 201 `Task`. Mesma chave e mesmo corpo dentro de `IDEMPOTENCY_KEY_TTL_MS`: 200 + header `Idempotent-Replay: true`, mesma Task. Mesma chave com outro corpo: 422. Chave longa: 400 |
| GET | /tasks | | `Task[]` (mais recentes primeiro, até 50) |
| GET | /tasks/:id | | `{ task, subtasks: Subtask[], snapshots: Snapshot[], usage: Usage[], approval: Approval \| null, memory: {key,value,agent,at}[], maxCorrectionRounds: number, resumable: bool }` |
| POST | /tasks/:id/approve | `{ note? }` (texto, até 1000; outro tipo: 400) | `Task` (retoma o loop durável). Já resolvida (inclusive por outra requisição concorrente): 409 |
| POST | /tasks/:id/reject | `{ note? }` (idem) | `Task` (status `rejected`). Já resolvida: 409 |
| POST | /tasks/:id/resume | | `Task` (retoma tarefa `failed`/`running` a partir do journal). 409 se a revisão reprovou na última rodada (`resumable: false`) |
| GET | /billing/summary | | `{ totals: {tokens, costUsd, calls, cacheHits, savedUsd}, byModel: {model,tokens,costUsd,calls}[], byAgent: {agent,tokens,costUsd,calls}[], byTask: {taskId,title,status,costUsd,budgetUsd,tokens}[] }` |
| GET | /billing/report.csv | | `text/csv` |
| GET | /gateway/models | | `{ id, provider, tier: 'cheap'\|'balanced'\|'premium', inputPer1k, outputPer1k, healthy }[]` |
| POST | /gateway/models/:id/toggle | | modelo atualizado (simula queda, força fallback) |
| GET | /gateway/stats | | `{ requests, cacheHits, fallbacks, rejectedTokenLimit, budgetBlocks }` |
| POST | /webhooks/inbox | corpo bruto assinado; headers `X-JP-Signature`, `X-JP-Event`, `X-JP-Event-Id`, `Idempotency-Key` | 200 `{ received: true, verified: true, duplicate: bool }` (reentrega do mesmo `X-JP-Event-Id`: `duplicate: true`, não grava de novo). Assinatura ausente ou inválida: 401, nada é gravado |
| GET | /webhooks/inbox | | `{ id, eventId, event, verified, signature, receivedAt, payload }[]` |
| GET | /events | SSE; `?taskId=<uuid>` opcional filtra uma tarefa | cada mensagem `data: { type, taskId, payload, at }`. Acima de `SSE_MAX_PER_CLIENT` (20) conexões por IP ou `SSE_MAX_CONNECTIONS` (200) no total: 429 |

Tipos de evento SSE (mais `heartbeat` a cada 15 s): `task.created`, `task.status`, `subtask.status`, `gateway.call`
(`payload: { model, cached, fallbackFrom?, tokens, costUsd, agent }`), `usage.recorded`,
`snapshot.created`, `approval.requested`, `approval.resolved`, `webhook.delivered`.

## Fluxo

plan -> dispatch (subagentes em paralelo) -> review/correção (máx. 2 rodadas) ->
[aprovação humana, se `requiresApproval`] -> merge -> `completed` + evento `task.completed`
assinado (HMAC) entregue via outbox ao webhook. Entrega at-least-once: o receptor deduplica por `X-JP-Event-Id`
(igual ao `Idempotency-Key`), ver "Garantias de entrega" no README.
