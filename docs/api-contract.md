# Contrato da API (v0.5.0)

Base: `http://localhost:3001`. JSON em tudo. CORS só para as origens de `CORS_ORIGINS`
(padrão fora de produção: `http://localhost:3000`; em produção, nenhuma).

## Autenticação e papéis

Chave em `X-API-Key: <chave>` ou `Authorization: Bearer <chave>`. As chaves vêm de
`API_KEYS="chave:papel[:nome],..."`. Papéis, do menor para o maior (cada um inclui os anteriores):
`viewer` < `operator` < `approver` < `admin`. O `nome` é a identidade gravada na aprovação
(`decidedBy`); sem ele a identidade é `<papel>-<8 hex do sha256 da chave>`.

- Sem chave ou chave desconhecida: **401**. Papel abaixo do exigido: **403**.
- `GET /events` e `GET /billing/report.csv` aceitam também `?api_key=<chave>` ou o cookie `jp_api_key`
  (EventSource e link de download não mandam header). As outras rotas não aceitam chave na URL.
- **Modo aberto:** com `API_KEYS` vazio e `NODE_ENV` diferente de `production`, nenhuma rota exige chave e toda
  requisição é o admin `anonymous`. Com `NODE_ENV=production` e `API_KEYS` vazio a API não sobe.
- **Rate limit:** as rotas marcadas com "limitada" contam `RATE_LIMIT_MAX` (60) requisições por
  `RATE_LIMIT_WINDOW_MS` (60 s), por chave e IP, em memória por réplica. Acima disso: **429** com `Retry-After` (segundos).
- **Corpo:** JSON até `BODY_LIMIT` (64kb); acima disso **413**. Campo com tipo errado: **400** com a lista de erros em `message`.

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
  requestedAt: string; resolvedAt: string | null;
  decidedBy: string | null; } // identidade da chave que decidiu (null enquanto pendente)
type DependencyState = 'up' | 'down' | 'memory'; // memory: não configurado, a API usa o adaptador em memória
```

## Endpoints

| Método | Rota | Papel | Corpo / Header | Resposta |
|---|---|---|---|---|
| GET | /health | público | | Liveness, sempre 200: `{ ok: true, postgres: bool, redis: bool, services: { postgres: DependencyState, redis: DependencyState }, store: 'postgres' \| 'memory' }` |
| GET | /health/ready | público | | Readiness: 200 `{ ready: true, services }`; **503** `{ ready: false, services }` quando um Postgres ou Redis configurado não responde (2 s) |
| GET | /metrics | viewer | | Prometheus (texto 0.0.4), ver "Métricas" abaixo |
| POST | /tasks | operator, limitada | `{ title: string, description: string, budgetUsd?: number \| string = 0.05, requiresApproval?: boolean \| 'true' \| 'false' = false }`, header opcional `Idempotency-Key` (até 200 caracteres ASCII visíveis) | 201 `Task`. Repetição com a mesma chave e o mesmo corpo (normalizado: `"0,05"` = `0.05`, texto aparado): 200 + header `Idempotent-Replay: true`, mesma Task. Mesma chave com **outro corpo: 422**, nada é criado |
| GET | /tasks | viewer | | `Task[]` (mais recentes primeiro, até 50) |
| GET | /tasks/:id | viewer | | `{ task, subtasks: Subtask[], snapshots: Snapshot[], usage: Usage[], approval: Approval \| null, memory: {key,value,agent,at}[] }` |
| POST | /tasks/:id/approve | approver, limitada | `{ note?: string }` (até 2000 caracteres) | `Task` (retoma o loop durável). Grava `decidedBy`. 409 se a tarefa não aguarda aprovação |
| POST | /tasks/:id/reject | approver, limitada | `{ note?: string }` (até 2000 caracteres) | `Task` (status `rejected`). Grava `decidedBy` |
| POST | /tasks/:id/resume | operator, limitada | | `Task` (retoma tarefa `failed` ou ativa sem dono a partir do journal). 409 se outra execução tem o lease da tarefa (inclusive uma execução cancelada por timeout que ainda está parando) ou se o status não permite retomar |
| GET | /billing/summary | viewer | | `{ totals: {tokens, costUsd, calls, cacheHits, savedUsd}, byModel: {model,tokens,costUsd,calls}[], byAgent: {agent,tokens,costUsd,calls}[], byTask: {taskId,title,status,costUsd,budgetUsd,tokens}[] }` |
| GET | /billing/report.csv | viewer (chave também na URL/cookie) | | `text/csv` |
| GET | /gateway/models | viewer | | `{ id, provider, tier: 'cheap'\|'balanced'\|'premium', inputPer1k, outputPer1k, healthy }[]` |
| POST | /gateway/models/:id/toggle | admin, limitada | | modelo atualizado (simula queda, força fallback) |
| GET | /gateway/stats | viewer | | `{ requests, cacheHits, cacheBypasses, fallbacks, rejectedTokenLimit, budgetBlocks }` |
| POST | /webhooks/inbox | público (HMAC) | corpo bruto assinado; headers `X-JP-Signature`, `X-JP-Event`, `X-JP-Event-Id`, `Idempotency-Key` | 200 `{ received: true, verified: true, duplicate: bool }` (reentrega do mesmo `X-JP-Event-Id`: `duplicate: true`, não grava de novo). Assinatura ausente ou inválida: **401** e **nada é gravado** |
| GET | /webhooks/inbox | viewer | | `{ id, eventId, event, verified, signature, receivedAt, payload }[]` |
| GET | /events | viewer (chave também na URL/cookie) | SSE | cada mensagem `data: { type, taskId, payload, at }` |

Todas as respostas trazem `X-Request-Id` (o recebido, se válido, ou um novo), que também aparece nos logs.

Tipos de evento SSE: `task.created`, `task.status`, `subtask.status`, `gateway.call`
(`payload: { model, cached, fallbackFrom?, tokens, costUsd, agent, tier, durationMs }`), `usage.recorded`,
`snapshot.created`, `approval.requested`, `approval.resolved` (`payload: { status, note, decidedBy }`),
`webhook.delivered`. O SSE não tem replay: depois de reconectar, o cliente recarrega o estado (o dashboard faz isso).

Eventos assinados do outbox: `task.completed` (com `decidedBy` quando a tarefa exigiu aprovação), `task.rejected`
(com `decidedBy`), `task.failed`, `task.budget_exceeded`, `tool.executed`.

## Métricas (`GET /metrics`)

| Métrica | Tipo | Labels |
|---|---|---|
| `jpo_tasks` | gauge (lido do store, global) | `status` |
| `jpo_outbox_events` | gauge (global) | `status` (`pending`, `delivered`, `dead`) |
| `jpo_outbox_dead` | gauge (global) | |
| `jpo_gateway_requests_total` | counter | |
| `jpo_gateway_calls_total` | counter | `model`, `cached` |
| `jpo_gateway_cache_hits_total` | counter | |
| `jpo_gateway_fallbacks_total` | counter | `model` (o que caiu) |
| `jpo_gateway_call_duration_seconds` | histogram | `model`, `cached` |
| `jpo_tool_calls_total` | counter | `tool`, `outcome` (`executed`, `replay`, `refused`, `error`) |
| `jpo_tool_call_duration_seconds` | histogram | `tool` |
| `jpo_http_requests_total` | counter | `method`, `route`, `status` |
| `jpo_rate_limited_total` | counter | |

Counters e histogramas são por réplica e zeram no restart (o Prometheus soma entre alvos).

## Fluxo

plan -> dispatch (subagentes em paralelo) -> review/correção (máx. 2 rodadas) ->
[aprovação humana, se `requiresApproval`] -> merge -> `completed` + evento `task.completed`
assinado (HMAC) entregue via outbox ao webhook. Entrega at-least-once: o receptor deduplica por `X-JP-Event-Id`
(igual ao `Idempotency-Key`), ver "Garantias de entrega" no README.
