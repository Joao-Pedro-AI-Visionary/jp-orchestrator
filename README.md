<div align="center">

<img src="docs/jpdev-logo.png" alt="Logo JpDev" height="160">

# JP Orchestrator

**por JpDev**

Orquestrador open source de agentes de código: distribui tarefas entre subagentes em paralelo,
com AI Gateway, execução durável, memória compartilhada, contexto versionado e billing por tarefa.

NestJS · TypeScript · Postgres · Redis · Next.js · Motion · Docker Compose · MIT

</div>

---

## Português

### O que é

O JP Orchestrator recebe uma tarefa de engenharia ("criar endpoint REST com testes"), quebra em
subtarefas, roda subagentes especializados em paralelo (pesquisador, coder, tester, revisor),
consolida o resultado e publica um evento assinado quando termina. Cada chamada de modelo passa
por um AI Gateway que prioriza cache e modelos baratos, registra tokens e custo, e corta a tarefa
automaticamente quando o orçamento estoura.

Nesta versão os subagentes usam um provedor de modelo determinístico (`MockProvider`) com latência
configurável. A interface `LlmProvider` é uma Strategy: um provedor real entra como mais uma classe,
sem mexer no orquestrador.

O dashboard em Next.js mostra tudo ao vivo via SSE: subagentes rodando em paralelo, fluxo pelo
gateway (cache, modelo, fallback), custos animados, timeline do contexto versionado, aprovação
humana e webhooks recebidos com assinatura verificada.

![Dashboard](docs/screenshots/02-subagentes-paralelo.png)

### Arquitetura

```mermaid
flowchart LR
  UI[Dashboard Next.js<br/>Motion + SSE] -->|REST + Idempotency-Key| API[TasksController]
  API --> ORC[Orchestrator<br/>loop durável]
  ORC -->|ctx.run step| DR[(DurableRuntime<br/>JournalRuntime / Restate)]
  ORC --> PL[Planner]
  ORC --> DSP[Dispatcher<br/>pool paralelo]
  DSP --> AG{{AgentStrategy<br/>researcher, coder, tester, reviewer}}
  AG --> GW[AI Gateway]
  GW --> TL[limite de tokens]
  GW --> SC[(cache semântico<br/>Redis)]
  GW --> BG[budget guard]
  GW --> RT[roteamento barato primeiro<br/>+ fallback]
  RT --> PR{{LlmProvider Strategy}}
  GW --> BL[(Billing<br/>usage_records)]
  AG --> TI[ToolInvoker<br/>Idempotency-Key]
  TI --> OB[(outbox)]
  AG <--> MEM[(memória compartilhada<br/>Redis)]
  ORC --> CTX[(contexto versionado<br/>snapshots com hash)]
  ORC --> AP[(aprovação humana)]
  ORC -->|estado final + evento na mesma transação| OB
  OB --> RL[OutboxRelay] -->|HMAC X-JP-Signature| WH[Webhook]
  ORC -.eventos ao vivo.-> UI
```

### Patterns e onde estão no código

| Pattern | O que faz | Onde |
|---|---|---|
| AI Gateway | Ponto único das chamadas de modelo: limite de tokens, cache semântico, budget guard, roteamento pelo modelo mais barato do tier, fallback em queda | `api/src/gateway/gateway.service.ts`, `model-catalog.ts`, `semantic-cache.ts` |
| Strategy | Registro por eixo (`StrategyRegistry`), mesmo estilo do strategy-pattern-checkout: agentes, provedores de modelo e ferramentas | `api/src/strategy/strategy-registry.ts`, `agents/agents.ts`, `gateway/llm-provider.ts`, `tools/builtin-tools.ts` |
| Durable execution | Loop escrito como passos nomeados (`ctx.run`); passo concluído nunca roda de novo; retoma após crash ou pausa. Interface pronta para Restate | `api/src/durable/durable-runtime.ts`, `journal.runtime.ts`, `restate.runtime.ts` |
| Idempotency-Key + outbox | `POST /tasks` com `Idempotency-Key`; ferramentas executam uma vez por chave e gravam o evento na mesma transação do resultado | `api/src/tools/tool-invoker.service.ts`, `persistence/pg.store.ts` |
| Aprovação humana durável | Pausa gravada no Postgres; aprovar ou rejeitar retoma o loop pelo journal, mesmo após restart | `api/src/approval/approval.service.ts`, `orchestration/orchestrator.service.ts` |
| Eventos assinados | Webhook com `X-JP-Signature: t=..,v1=HMAC-SHA256`, tolerância de replay, retry com backoff, entrega pelo outbox | `api/src/events/signer.ts`, `outbox-relay.service.ts`, `events.module.ts` |
| Memória compartilhada | Blackboard por tarefa (hash Redis): pesquisador publica, coder e revisor leem | `api/src/memory/shared-memory.ts` |
| Contexto versionado | Snapshots append-only com versão e hash encadeado (`hash = sha256(parentHash + JSON canônico)`), verificação de adulteração | `api/src/memory/context-store.service.ts` |
| Billing e orçamento | Tokens e custo por tarefa, subagente e modelo; corte automático ao estourar; relatório CSV | `api/src/billing/billing.service.ts`, `scripts/` |

### Loops de orquestração

Todo loop é limitado. Nada repete "até passar". Limites configuráveis por variável de ambiente.

| Loop | Objetivo | Critério de saída | Timeout | Limite de chamadas |
|---|---|---|---|---|
| task | Levar a tarefa a um estado final | completed, failed, rejected ou budget_exceeded | `TASK_TIMEOUT_MS` (180 s), com cancelamento real | 1 execução por vez por tarefa, entre réplicas (lease `TASK_LEASE_MS`, 30 s) |
| plan | Quebrar a tarefa em subtarefas | pelo menos 1 subtarefa de trabalho e 1 revisor | `PLAN_TIMEOUT_MS` (15 s) | 1 chamada ao gateway (tier barato) |
| dispatch | Rodar subagentes de cada onda em paralelo (`MAX_PARALLEL`) | todas as subtarefas em done | `SUBAGENT_TIMEOUT_MS` (30 s) por subagente | 2 por subtarefa (1 retry) |
| correction | Revisor aprova ou devolve feedback; coders corrigem | revisão aprovada; falha após 2 rodadas | `REVIEW_TIMEOUT_MS` (30 s) | máximo 2 rodadas de correção |
| approval | Pausa durável até decisão humana | approved ou rejected | sem timeout (pausa persistida) | 0 chamadas de modelo |
| merge | Consolidar saídas e artefatos | resultado único sem duplicatas | `MERGE_TIMEOUT_MS` (10 s) | 0 chamadas de modelo |
| outbox | Entregar eventos assinados | 2xx, ou morto após `OUTBOX_MAX_ATTEMPTS`, ou `expired` após `OUTBOX_MAX_AGE_MS` | `OUTBOX_TIMEOUT_MS` (5 s) por entrega | 5 tentativas, backoff 2^n s, idade máxima = TTL da chave − horizonte (≈ 23 h 56 min) |

Ondas do dispatch: pesquisadores primeiro (alimentam a memória compartilhada), depois coders e
testers em paralelo, depois o revisor.

**Cancelamento e posse da execução.** O timeout da tarefa e o do subagente abortam um `AbortSignal` que chega ao
dispatcher, aos agentes, ao gateway, ao provider (`LlmProvider.complete(..., signal)`) e às ferramentas
(`ctx.signal`). O estado terminal é gravado uma vez só: o store recusa qualquer escrita de status numa tarefa já
final (`UPDATE ... WHERE status NOT IN (terminais)`), e o evento terminal sai na mesma transação, então nunca há
`task.failed` seguido de `task.completed`. Cada execução toma antes um lease da tarefa (`lease_owner`,
`lease_until`, `lease_token` como fencing token), renovado por heartbeat; réplicas que retomam no boot, a varredura
periódica (a cada `TASK_LEASE_MS`) e o `/resume` nunca rodam a mesma tarefa duas vezes. Depois de um timeout o lease
fica preso até a execução cancelada parar (no máximo `ABORT_GRACE_MS`, 5 s), e o `/resume` responde 409 nesse
intervalo. Os ids das subtarefas derivam de (tarefa, posição), então refazer o passo `plan` depois de um crash
reaproveita as mesmas subtarefas e chaves de ferramenta.
Limite conhecido: o fencing por token cobre as escritas em `tasks` (status, estado terminal, evento). As escritas de
subtarefas, snapshots, memória e uso param pelo `AbortSignal`, que um dono que perdeu o lease só percebe no próximo
heartbeat (até `TASK_LEASE_MS` / 3). Deploy a partir da 0.3.x: por substituição, sem misturar versões (ver CHANGELOG).

### Economia de tokens

- Cache antes de qualquer chamada: primeiro o hash exato do prompt, depois o semântico (cosseno >= `CACHE_SIMILARITY`); custa zero e registra a economia.
  O escopo é por tarefa (`tarefa:agente:tier`), e a rodada de correção (`attempt > 1` ou feedback presente) ignora o
  cache: a nova tentativa sempre chega ao modelo, em vez de receber a resposta que acabou de ser reprovada.
- Roteamento pelo modelo mais barato do tier pedido; tiers mais caros só como fallback.
- Limite de tokens de entrada e saída antes de gastar.
- Budget guard por tarefa: a chamada que cruzaria o orçamento é bloqueada e a tarefa vai para `budget_exceeded`.
- Embedding local (hash de palavras e bigramas): a consulta ao cache não chama modelo.

### Garantias de entrega

- **Webhooks (outbox → receptor): at-least-once + dedupe no receptor.** O evento nasce na mesma transação do
  estado que o gerou. O `OutboxRelay` reivindica o evento com um lease de 30 s (`OUTBOX_CLAIM_LEASE_MS`, `FOR UPDATE SKIP LOCKED`) e só
  marca `delivered` depois do 2xx. Se o processo morrer entre o 2xx e essa marca, ou a entrega passar de 30 s, o
  evento é reenviado. Todo envio do mesmo evento leva os mesmos `X-JP-Event-Id` e `Idempotency-Key` (= id do
  evento), com assinatura nova. O receptor deduplica por esse id: `webhook_inbox.event_id` é `UNIQUE` e o insert
  usa `ON CONFLICT DO NOTHING`; a repetição responde 200 com `duplicate: true`. Só deduplica evento com assinatura
  válida e cujo header bate com o `id` assinado no corpo, para uma requisição forjada não "ocupar" o id de um evento real.
- **Ferramentas (`ToolInvoker`): no máximo um resultado por `Idempotency-Key`; efeito externo idempotente pela chave.**
  Antes de executar, grava a linha `started` com lease (`TOOL_LEASE_MS`, padrão 10 s, menor que o timeout de 30 s do
  subagente). O handler recebe `ctx.idempotencyKey` (estável entre tentativas) e `ctx.attempt`, e tem o lease como
  timeout. Resultado e evento `tool.executed` são gravados na mesma transação, protegidos pelo número da tentativa
  (fencing). Se o processo morrer entre o efeito e o commit, a nova tentativa (inclusive a retomada no boot) espera o
  lease vencer, no máximo um lease, e reconcilia rodando o handler de novo com a mesma chave. Por isso, ferramenta com
  efeito externo **precisa** repassar `ctx.idempotencyKey` ao sistema de destino: o handler pode rodar mais de uma vez,
  e é o destino que aplica o efeito uma vez só. Sem isso não existe exactly-once. `attempts` só cresce num takeover
  de lease vencido (crash ou timeout): uma falha limpa do handler libera o lease e a próxima tentativa reaproveita o
  mesmo número, então erros transitórios não consomem `TOOL_MAX_ATTEMPTS`.
- **Horizonte de retry dentro do TTL da chave (verificado no boot).** O receptor e o destino só deduplicam enquanto
  lembram da chave (`IDEMPOTENCY_KEY_TTL_MS`, padrão 24 h). Uma reentrega depois disso aplicaria o efeito de novo, então:
  - o relay marca `dead` com `last_error = 'expired'`, sem enviar, todo evento mais antigo que `OUTBOX_MAX_AGE_MS`,
    checado antes de cada envio. O padrão é `IDEMPOTENCY_KEY_TTL_MS` menos o horizonte do outbox (≈ 23 h 56 min com
    os padrões), então uma queda do relay ou do receptor menor que isso não perde evento;
  - o `ToolInvoker` limita os takeovers de lease a `TOOL_MAX_ATTEMPTS` (padrão 3) e recusa reexecutar uma chamada
    `started` criada há mais de `IDEMPOTENCY_KEY_TTL_MS`; nos dois casos a linha vira `failed` (terminal, com o motivo
    em `error`) e lança `ToolCallRefusedError` sem rodar o handler, agora e em qualquer nova tentativa;
  - o boot falha (`assertRetryHorizon`, `api/src/common/retry-horizon.ts`) se o pior caso do outbox
    (soma dos backoffs + tentativas × (`OUTBOX_TIMEOUT_MS` + `OUTBOX_CLAIM_LEASE_MS`), 205 s no padrão), o das
    ferramentas (`TOOL_MAX_ATTEMPTS` × `TOOL_LEASE_MS`, 30 s) ou o último envio possível de um evento
    (`OUTBOX_MAX_AGE_MS` + `OUTBOX_TIMEOUT_MS` + `OUTBOX_CLAIM_LEASE_MS`) for >= `IDEMPOTENCY_KEY_TTL_MS`,
    ou se algum desses valores não for inteiro positivo.
  Configure `IDEMPOTENCY_KEY_TTL_MS` com o menor TTL de chave entre os receptores e destinos reais. `webhook_inbox`
  e `tool_calls` ainda não são podados, então o receptor de demonstração lembra da chave para sempre.
- Os testes com `crash` no nome simulam a morte do processo nesses dois pontos (`outbox-relay.spec.ts`, `tool-invoker.spec.ts`).
- Migrações SQL em `api/src/persistence/migrations/`, aplicadas no boot uma vez cada (tabela `schema_migrations`).
  O SQL do `PgStore` e as migrações são testados num Postgres real em WASM (PGlite) em `pg.store.spec.ts`.
- Eventos gravados no inbox antes da v0.3.2 não têm `event_id`, então uma reentrega deles não é deduplicada.

### Segurança

- **API key com papéis.** `API_KEYS="chave:papel[:nome],..."`, papéis `viewer` < `operator` < `approver` < `admin`
  (cada um inclui os anteriores). Leitura pede `viewer`; criar e retomar tarefa, `operator`; aprovar e rejeitar,
  `approver`; derrubar modelo do gateway, `admin`. Chave em `X-API-Key` ou `Authorization: Bearer`; o SSE e o CSV
  aceitam também `?api_key=` ou o cookie `jp_api_key`. As chaves ficam só como sha256 em memória.
- **Modo aberto** só com `API_KEYS` vazio **e** `NODE_ENV` diferente de `production` (dev local e testes). Em produção a
  API não sobe sem chaves, com o segredo de assinatura padrão (`dev-secret-change-me`) ou com `CORS_ORIGINS=*`.
- **Aprovador registrado:** quem aprova ou rejeita fica em `approvals.decided_by`, no evento `approval.resolved` e no
  evento assinado `task.completed`/`task.rejected` (`decidedBy`).
- **CORS** só para `CORS_ORIGINS`. **Rate limit** em memória nas rotas que mudam estado (`RATE_LIMIT_MAX` por
  `RATE_LIMIT_WINDOW_MS`, por chave e IP, por réplica: com N réplicas o limite efetivo é N vezes maior; para um limite
  global use o proxy de borda). **Validação:** corpo JSON até `BODY_LIMIT` (413), tipos dos campos checados (400),
  nota de aprovação até 2000 caracteres.
- **Receptor de webhook** devolve 401 e não grava requisição sem assinatura válida.
- **Limite conhecido:** `NEXT_PUBLIC_API_KEY` vai no bundle do navegador. Quem abre o dashboard lê a chave, então sirva o
  dashboard só para quem pode ter aquele papel (rede interna, proxy com SSO). Use uma chave `approver` se o dashboard não
  precisar derrubar modelos (o toggle do gateway pede `admin`). O dashboard manda a chave em `?api_key=` no SSE e no CSV,
  que pode aparecer em logs de proxy; o cookie `jp_api_key` evita isso quando API e dashboard estão no mesmo site.
  Sessão por usuário (OIDC) ainda não existe. O rate limit usa `req.ip`: atrás de proxy, sem `trust proxy`, todos os
  clientes de uma mesma chave dividem o limite.

### Observabilidade

- **Logs JSON**, um objeto por linha (`ts`, `level`, `context`, `msg`), com `taskId` em tudo o que a execução de uma
  tarefa escreve (AsyncLocalStorage), `requestId` (`X-Request-Id`) e `principal` nas linhas de acesso HTTP. A query
  string não vai para o log, então `?api_key=` não vaza. `LOG_FORMAT=text` volta ao formato colorido do Nest.
- **`GET /metrics`** (Prometheus, chave `viewer`): tarefas por status, eventos do outbox por status e `jpo_outbox_dead`,
  chamadas, latência, cache e fallbacks do gateway, chamadas de ferramenta por resultado e requisições HTTP. Lista
  completa em `docs/api-contract.md`. No Prometheus: `authorization: { credentials: <chave viewer> }` no scrape job.
- **`GET /health`** é liveness (sempre 200). **`GET /health/ready`** devolve 503 enquanto um Postgres ou Redis
  configurado não responde; o healthcheck do compose usa o readiness. Em modo memória os dois aparecem como `memory`
  e o dashboard mostra "em memória" em cinza, não como falha.

### Como rodar

Pré-requisitos: Docker com Compose, Node 22.

A imagem da API roda com `NODE_ENV=production`, então o compose exige as chaves e o segredo num `.env`:

```bash
k=$(openssl rand -hex 24)
printf 'API_KEYS=%s:admin:dashboard\nNEXT_PUBLIC_API_KEY=%s\nWEBHOOK_SECRET=%s\n' "$k" "$k" "$(openssl rand -hex 24)" > .env

docker compose up -d --build        # postgres, redis, api (:3001), web (:3000)
open http://localhost:3000

export API_KEY=$k                   # os scripts e o e2e mandam a chave em X-API-Key
npm run loop:run                    # dispara um loop real e mostra o pico de subagentes em paralelo
npm run billing:report              # relatório de consumo em reports/billing-AAAA-MM-DD.md
npm run budget:check -- --warn 0.8  # sai com código 1 se alguma tarefa passou de 80% do orçamento
```

Desenvolvimento local:

```bash
npm run install:all
npm test                            # testes unitários (jest) da API
npm run prepush                     # lint + typecheck + build + testes
npx playwright install chromium && npm run e2e   # e2e contra o stack rodando
```

Sem `DATABASE_URL` e `REDIS_URL` a API roda inteira em memória; sem `API_KEYS` (fora de produção), sem autenticação.
Variáveis em `.env.example`.
Contrato da API em `docs/api-contract.md`. Screenshots do e2e em `docs/screenshots/`.

### Vídeos de demonstração

Gravados com Playwright sobre a stack real (`docker compose up`), sem mocks, e montados com ffmpeg:
`docs/marketing/tiktok-instagram-9x16.mp4`, `docs/marketing/linkedin-1x1.mp4` e `docs/marketing/linkedin-16x9.mp4`.

```bash
node scripts/marketing/record.mjs desktop reports/marketing   # 1600x900, com marcadores de tempo
node scripts/marketing/record.mjs mobile reports/marketing    # 720x1280
node scripts/marketing/build-videos.mjs reports/marketing docs/marketing
```

O ffmpeg do Homebrew não tem `drawtext` nem `libass`: legendas e cartões da marca são PNG renderizados pelo Playwright e aplicados com `overlay`.

### Identidade visual (JpDev)

| Token | Valor | Uso |
|---|---|---|
| `brand` | `#FFC800` | CTA principal, destaques, foco visível, rótulos de seção |
| `brand-soft` | `#FACC15` | hover do CTA, status "Planejando" |
| `ink` | `#0A0A0A` | fundo e texto sobre amarelo (contraste 12,7:1 com o amarelo) |
| `accent` | `#FF7A00` | apoio: aguardando aprovação, integrando, barras por agente |
| `ok` / `bad` | `#5FBF85` / `#F07171` | só status semântico (sucesso / falha) |

Tipografia: Space Grotesk (títulos, via `next/font`) e Inter (texto). O logo é `brand/jpdev-logo.png`,
apenas redimensionado para o topbar (`web/public/jpdev-logo.png`), favicon (`web/app/icon.png`, `apple-icon.png`),
este README e os vídeos. Os vídeos carregam as fontes do Google Fonts no render e o build falha se elas não carregarem.

### Inspiração

O desenho de portões, loops limitados e "teste verde manda" é inspirado conceitualmente no
[VJP Harness](https://github.com/Joao-Pedro-AI-Visionary/vjp-harness). Não há dependência de código.

---

## English

### What it is

JP Orchestrator is an open source orchestrator for coding agents. It splits an engineering task into
subtasks, runs specialized subagents in parallel (researcher, coder, tester, reviewer), merges their
output and emits an HMAC-signed event when done. Every model call goes through an AI Gateway with
token limits, a semantic cache, cheapest-first routing, model fallback and a per-task budget with an
automatic cut. The agent loop is durable (journaled steps, Restate-ready interface), tool calls are
idempotent with a transactional outbox, human approval is a durable pause, subagents share a per-task
memory and the task context is versioned as hash-chained snapshots. A Next.js dashboard shows it all
live over SSE.

This version ships a deterministic `MockProvider`; real providers plug in as another `LlmProvider` strategy.

### Delivery guarantees

- **Webhooks (outbox → receiver): at-least-once delivery + receiver dedupe.** Events are written in the same
  transaction as the state change. The relay claims an event with a 30s lease (`OUTBOX_CLAIM_LEASE_MS`) and marks it `delivered` only after a
  2xx, so a crash between the 2xx and the mark (or a delivery slower than the lease) resends it. Every send of one
  event carries the same `X-JP-Event-Id` and `Idempotency-Key` (the event id). Receivers must dedupe on it; the demo
  receiver does so with a `UNIQUE` `webhook_inbox.event_id` and `ON CONFLICT DO NOTHING`, answering 200 with
  `duplicate: true` on a replay (only for verified events whose header matches the signed body id).
- **Tool calls: one stored result per `Idempotency-Key`; external effects idempotent on that key.** A `started` row
  with a lease (`TOOL_LEASE_MS`, default 10s, below the 30s subagent timeout) is persisted before the handler runs;
  handlers get `ctx.idempotencyKey` and `ctx.attempt` and are bounded by the lease; the result and its outbox event
  commit together, fenced by the attempt. After a crash between the effect and the commit, the retry (including the
  boot resume) waits up to one lease, then re-runs the handler with the same key. The handler may run more than
  once, so tools with external side effects must forward `ctx.idempotencyKey` and let the downstream apply it once.
  `attempts` grows only on an expired-lease takeover; a clean handler failure releases the lease and the retry keeps
  its attempt, so transient errors do not burn `TOOL_MAX_ATTEMPTS`.
- **Cancellation and task ownership.** Task and subagent timeouts abort one `AbortSignal` that reaches the
  dispatcher, agents, gateway, provider and tools. A task reaches a terminal status once (store-level guard), with
  its event in the same transaction. Every run holds a fenced task lease (`TASK_LEASE_MS`, heartbeat), so replicas,
  the resume sweep and `/resume` never run a task twice; `/resume` answers 409 until a cancelled run has stopped
  (at most `ABORT_GRACE_MS`). The cache is scoped per task and bypassed on correction attempts.
- **Retry horizon inside the key TTL (checked at boot).** Receivers and downstreams only dedupe while they remember
  the key (`IDEMPOTENCY_KEY_TTL_MS`, default 24h). The relay marks events older than `OUTBOX_MAX_AGE_MS` (default:
  key TTL minus the outbox horizon, about 23h56m) `dead` with `last_error = 'expired'` without sending them; the
  `ToolInvoker` caps lease takeovers at `TOOL_MAX_ATTEMPTS` (default 3) and refuses to re-run a `started` call created
  more than the key TTL ago (the row becomes terminal `failed`, `ToolCallRefusedError`, handler not run). Startup fails (`assertRetryHorizon`) if the outbox worst case (sum of
  backoffs + attempts × (`OUTBOX_TIMEOUT_MS` + `OUTBOX_CLAIM_LEASE_MS`), 205s by default), the tool worst case
  (`TOOL_MAX_ATTEMPTS` × `TOOL_LEASE_MS`, 30s) or the latest send (`OUTBOX_MAX_AGE_MS` + `OUTBOX_TIMEOUT_MS` +
  `OUTBOX_CLAIM_LEASE_MS`) is >= the key TTL. Set the TTL to the smallest
  key retention among your real receivers and downstreams.
- Tests with `crash` in their name kill the process at both points; they assert the same ids/key are reused and
  that a receiver or downstream honoring the key applies the effect once.

### Security and observability

- **API keys with roles**: `API_KEYS="key:role[:name],..."`, roles `viewer` < `operator` < `approver` < `admin`.
  Reads need `viewer`, creating/resuming tasks `operator`, approve/reject `approver`, taking a gateway model down
  `admin`. Key in `X-API-Key` or `Authorization: Bearer`; SSE and the CSV export also accept `?api_key=` or the
  `jp_api_key` cookie. Open mode (no auth) only with an empty `API_KEYS` outside `NODE_ENV=production`; in production
  the API refuses to boot without keys, with the default signing secret or with `CORS_ORIGINS=*`.
- The approver identity is stored (`approvals.decided_by`) and sent in `approval.resolved` and in the signed
  `task.completed`/`task.rejected` events. CORS is limited to `CORS_ORIGINS`; mutating endpoints are rate limited in
  memory per key and IP (per replica); bodies are capped at `BODY_LIMIT` (413) and field types are checked (400).
  The webhook receiver answers 401 and stores nothing for an unverified request.
- `NEXT_PUBLIC_API_KEY` ships in the browser bundle: only serve the dashboard to people allowed that role.
- JSON logs with `taskId`, `requestId` and `principal`; Prometheus `/metrics` (viewer key); `/health` is liveness,
  `/health/ready` answers 503 while a configured Postgres or Redis is down.

### Run it

```bash
k=$(openssl rand -hex 24)      # the API image runs with NODE_ENV=production: keys and secret are required
printf 'API_KEYS=%s:admin:dashboard\nNEXT_PUBLIC_API_KEY=%s\nWEBHOOK_SECRET=%s\n' "$k" "$k" "$(openssl rand -hex 24)" > .env
docker compose up -d --build   # http://localhost:3000 (UI), http://localhost:3001 (API)
export API_KEY=$k              # scripts and e2e send it as X-API-Key
npm run loop:run               # real orchestration loop with parallel subagents
npm run billing:report         # token and cost report
npm test                       # unit tests
npm run e2e                    # Playwright e2e against the running stack
```

See the pattern table and the loop table above for where each pattern lives in the code.

Demo videos (recorded with Playwright on the real stack, edited with ffmpeg) live in `docs/marketing/`;
`scripts/marketing/record.mjs` and `scripts/marketing/build-videos.mjs` rebuild them.

Brand: JpDev logo (`brand/jpdev-logo.png`, resized only), yellow `#FFC800` and black `#0A0A0A` with orange `#FF7A00`
as support, Space Grotesk for headings and Inter for body text.

### License

MIT, by JpDev.
