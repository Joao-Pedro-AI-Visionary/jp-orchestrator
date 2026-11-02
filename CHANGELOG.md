# Changelog

Formato baseado em Keep a Changelog. Versionamento semântico.

## [Unreleased]

## [0.4.0] - 2026-11-01

### Corrigido
- **Timeout da tarefa agora cancela o trabalho.** Antes, `withTimeout` só fazia `Promise.race`: a tarefa virava
  `failed`, o loop continuava e depois gravava `completed`, com dois eventos terminais no webhook. Agora um
  `AbortSignal` vai do orquestrador ao dispatcher, aos agentes (`AgentContext.signal`), ao gateway
  (`GatewayRequest.signal`), ao provider (`LlmProvider.complete(..., signal)`) e às ferramentas (`ToolContext.signal`).
  O timeout do subagente aborta a tentativa e o retry só começa depois que ela parou (`runWithTimeout`, com
  `ABORT_GRACE_MS` como limite).
- **Transição terminal única no store.** `finishTask`/`updateActiveTask` (`UPDATE ... WHERE status NOT IN (terminais)`
  no Postgres, a mesma regra no `MemoryStore`): `fail`/`finish` numa tarefa já final não gravam nada nem emitem um
  segundo evento terminal. Uma tarefa `failed` só volta a rodar via `/resume` (`reopenTask`).
- **`/resume` não roda ao lado de um zumbi.** Toma o lease da tarefa antes de reabrir; responde 409 enquanto outra
  execução tem o lease, inclusive uma execução cancelada que ainda está parando, aqui ou em outra réplica.
- **Lease de execução por tarefa** (`lease_owner`, `lease_until`, `lease_token` como fencing token, heartbeat a cada
  1/3 de `TASK_LEASE_MS`). `resumeActive` em várias réplicas, a varredura periódica e o `/resume` não executam a
  mesma tarefa duas vezes; escritas de um dono anterior são recusadas pelo token. Lease perdido interrompe a execução
  sem escrever mais nada.
- **Passo `plan` determinístico:** ids das subtarefas derivados de (tarefa, posição) (`stableId`); `saveSubtasks`
  mantém a linha existente. Um crash entre `saveSubtasks` e o journal não duplica subtarefas nem muda as chaves das
  ferramentas. `putStep` devolve o valor já gravado (o primeiro escritor vence).
- **Cache do gateway:** ignorado (nem lido nem gravado) na rodada de correção (`attempt > 1` ou feedback presente), que
  antes recebia a resposta já reprovada; escopo por tarefa (`tarefa:agente:tier`) em vez de `agente:tier`; hash exato
  do prompt consultado antes da varredura semântica (memória e Redis).
- **`OUTBOX_MAX_AGE_MS` padrão** passou de 10 min para `IDEMPOTENCY_KEY_TTL_MS` − horizonte do outbox
  (86 195 000 ms com os padrões), recalculado a partir do TTL e do horizonte configurados. Antes, uma queda de mais
  de 10 min do relay ou do receptor descartava eventos terminais como `expired`.
- `assertRetryHorizon` agora conta o envio que acontece depois da checagem de idade:
  `OUTBOX_MAX_AGE_MS + OUTBOX_TIMEOUT_MS + OUTBOX_CLAIM_LEASE_MS` precisa ficar abaixo do TTL.
- **`tool_calls.attempts` só cresce em takeover de lease vencido.** Uma falha limpa do handler libera o lease
  (`lease_until = NULL`, erro em `error`) e a nova tentativa reaproveita o número, então erros transitórios e
  `/resume` não esgotam `TOOL_MAX_ATTEMPTS`. Handler com timeout ou abortado mantém o lease (efeito incerto).
- **Estado terminal `failed` em `tool_calls`:** recusa por `TOOL_MAX_ATTEMPTS` ou pelo TTL grava `failed` com o
  motivo; toda chamada seguinte com a mesma chave é recusada na hora, em vez de a linha ficar `started` para sempre.
- **Aprovação decidida enquanto a execução pausada ainda segura o lease** não deixa mais a tarefa presa em
  `awaiting_approval`: `/approve` e `/reject` esperam a execução pausada soltar (`continueAfterApproval`), e a
  varredura também retoma tarefas `awaiting_approval` cuja aprovação já foi decidida (caso do lease preso em outra réplica).
- **Shutdown** interrompe as execuções sem marcá-las como `failed` e devolve o lease na hora, para outra réplica
  retomar sem esperar o lease vencer.
- **Aprovação atômica:** `resolveApproval` (`UPDATE approvals ... WHERE status = 'pending' RETURNING`); de duas
  decisões concorrentes só uma vence, a outra recebe 409.
- Reentregas e retries agora têm horizonte imposto dentro do TTL da chave de idempotência (antes só implícito):
  o boot falha (`assertRetryHorizon`) se o pior caso do outbox (soma dos backoffs + tentativas × (timeout + lease)),
  o das ferramentas (tentativas × lease) ou o último envio possível (`OUTBOX_MAX_AGE_MS` + timeout + lease do claim)
  for >= `IDEMPOTENCY_KEY_TTL_MS`, ou se algum valor não for inteiro positivo.
- `OutboxRelay`: evento mais antigo que `OUTBOX_MAX_AGE_MS` vira `dead` com `last_error = 'expired'` e não é enviado.
- `ToolInvoker`: takeovers de lease limitados a `TOOL_MAX_ATTEMPTS`; chamada `started` criada há mais de
  `IDEMPOTENCY_KEY_TTL_MS` não é reexecutada. Os dois casos lançam `ToolCallRefusedError` sem rodar o handler.

### Atualização (leia antes do deploy)
- Instâncias 0.3.x não usam o lease nem a guarda terminal. Num rolling deploy com uma 0.3.x ainda executando, uma
  0.4.0 que sobe pode retomar a mesma tarefa em paralelo. Faça o deploy por substituição (Recreate) ou drene as 0.3.x
  antes (`RESUME_ON_BOOT=off` e sem tráfego), e só então suba as 0.4.0.

### Adicionado
- Migração `0003_task_lease_tool_failed.sql`: colunas de lease em `tasks`; `tool_calls.error` e `failed` na
  constraint de status.
- Variáveis `TASK_LEASE_MS` (padrão 30000; também o intervalo da varredura de retomada) e `ABORT_GRACE_MS` (5000).
- `Orchestrator.resume`, `startSweep`/`stopSweep`, resultado `busy` quando outro dono tem o lease;
  `GatewayService.stats.cacheBypasses`.
- `.github/workflows/ci.yml`: `install:all`, lint, typecheck, build e testes em push e PR (Node 22).
- Variáveis `IDEMPOTENCY_KEY_TTL_MS` (padrão 86400000 = 24 h), `OUTBOX_MAX_AGE_MS` (derivado; ver Corrigido),
  `OUTBOX_CLAIM_LEASE_MS` (30000, antes fixo no código) e `TOOL_MAX_ATTEMPTS` (3).
- `api/src/common/retry-horizon.ts`: `retryConfig`, `outboxHorizonMs`, `toolHorizonMs` e `assertRetryHorizon` (puras, testadas).

### Testes
- `orchestrator.durability.spec.ts`: timeout aborta e emite um único evento terminal; execução que ignora o sinal
  não completa depois e bloqueia `/resume` (local e em outra réplica) até parar; timeout de subagente sem
  sobreposição com o retry; duas réplicas em `resumeActive` executam a tarefa uma vez; takeover depois de crash
  reaproveita os mesmos ids de subtarefa; lease perdido para a execução sem escrever.
- `store.contract.spec.ts` (MemoryStore e PgStore/PGlite): transição terminal única, lease com fencing, `reopenTask`,
  aprovação atômica, journal com primeiro escritor vencendo, `saveSubtasks` idempotente.
- Gateway: bypass na correção, escopo por tarefa, hash exato antes do semântico; rodada de correção sem cache.
- Ferramentas: falhas limpas não consomem tentativas, `failed` terminal recusado na hora, abort mantém o lease.
- `approval.service.spec.ts`: duas decisões concorrentes, só uma vence. Outbox: evento atrasado 1 h ainda é entregue.
- `retry-horizon.spec.ts` (cálculo e validação), evento expirado sem chamada HTTP, teto de `TOOL_MAX_ATTEMPTS`,
  recusa após o TTL e `created_at` preservado no takeover (PGlite).

## [0.3.2] - 2026-10-31

### Corrigido
- Receptor de webhooks (`POST /webhooks/inbox`) idempotente: deduplica por `X-JP-Event-Id` (`webhook_inbox.event_id`
  `UNIQUE` + `ON CONFLICT DO NOTHING`) e responde 200 com `duplicate: true` na reentrega. Antes, cada reenvio do
  relay at-least-once virava uma linha nova.
- `ToolInvoker` executava o handler antes de persistir qualquer coisa: um crash entre o efeito e o commit perdia o
  registro e a nova tentativa executava sem nenhuma chave em comum. Agora grava `started` com lease antes de executar,
  reconcilia na nova tentativa (espera o lease vencer, no máximo um lease, e reexecuta com a mesma chave) e conclui
  com fencing pela tentativa. O handler tem o lease como timeout.

### Adicionado
- Header `Idempotency-Key` (= id do evento) em toda entrega do `OutboxRelay`, igual em todas as reentregas.
- `ToolHandler.execute(args, ctx)` com `ctx.idempotencyKey` e `ctx.attempt`; `ToolCallInProgressError` quando outro
  worker mantém o lease por mais de um lease. Variável `TOOL_LEASE_MS` (padrão 10000, abaixo de `SUBAGENT_TIMEOUT_MS`).
- Migrações SQL versionadas (`api/src/persistence/migrations/`, tabela `schema_migrations`):
  `0001_webhook_inbox_event_id.sql` e `0002_tool_calls_started_lease.sql`. Linhas antigas de `tool_calls` viram `completed`
  e o default de `status` continua `completed`, para uma instância v0.3.1 em deploy gradual gravar linhas válidas.
  Eventos recebidos antes da migração ficam com `event_id` nulo e não são deduplicados.
- Seção "Garantias de entrega" / "Delivery guarantees" no README.

### Testes
- Testes de crash (morte do processo entre efeito e marca/commit) no relay e no invoker, e testes do receptor idempotente.
- `pg.store.spec.ts`: SQL do `PgStore` e migrações num Postgres real em WASM (`@electric-sql/pglite` 0.5.14, devDependency
  pinada). O PGlite usa `import()` dinâmico, por isso `npm test` da API roda o Jest com `--experimental-vm-modules`.
  É uma conexão só: valida a semântica do SQL, não a concorrência entre conexões.

## [0.3.1] - 2026-10-31

### Adicionado
- Versões narradas em português do Brasil dos 3 vídeos de marketing (`*-narrado.mp4`), com a voz neural
  `pt-BR-ThalitaMultilingualNeural` (edge-tts 7.2.3) e um roteiro por formato em `scripts/marketing/narracao.json`.
- `build-videos.mjs --narrar`: gera a fala de cada cena e estende a cena congelando o último quadro quando a fala
  é mais longa que a gravação, sem corte seco. Áudio normalizado em -16 LUFS.

## [0.3.0] - 2026-10-31

### Alterado
- Identidade visual alinhada à marca JpDev: logo real (`brand/jpdev-logo.png`, só redimensionado) no topbar,
  favicon (`app/icon.png`, `app/apple-icon.png`), README e vídeos.
- Paleta amarelo `#FFC800` + preto `#0A0A0A`, laranja `#FF7A00` só como apoio. Removidos roxo, índigo, azul, ciano
  e verde neon; sucesso/falha usam `ok`/`bad` discretos. Neutros passaram de `slate` (azulado) para `neutral`.
  Contraste AA conferido: menor par texto/fundo é 6,9:1.
- Tipografia: Space Grotesk nos títulos e Inter no texto (`next/font`), com tracking negativo nos títulos.
- Vídeos de marketing regravados na stack real com a nova identidade: cartões com o logo, legendas em
  Space Grotesk com borda amarela e selo do logo durante todo o conteúdo. O build falha se as fontes não carregarem.

### Testes
- e2e confere o logo carregado (`naturalWidth > 0`), o favicon servido (HTTP 200) e o CTA na cor da marca.

## [0.2.0] - 2026-10-31

### Alterado
- UI refinada a partir de shots populares do Dribbble para dashboards de agentes de IA e dev tools
  (AI Agent Analytics, AI Voice Agent Dashboard, OPERATE, Montseract): topbar translúcida fixa no desktop,
  rótulos de seção (eyebrow), KPIs com faixa de destaque, fundo pontilhado sutil.
- No desktop, listas longas (tarefas, webhooks, faturamento por tarefa) rolam dentro do próprio card, com cabeçalho
  fixo na tabela: a página desktop caiu de ~7.900 px para ~4.100 px de altura.
- Botão de erro passou a "Tentar de novo", com ícone e `data-testid="retry-button"`.

### Corrigido
- Rolagem horizontal no celular: colunas do grid sem `min-w-0` se alargavam pelo conteúdo do AI Gateway
  (723 px num viewport de 540 px).

### Adicionado
- E2E do botão "Tentar de novo" (falha de rede simulada na primeira leitura de `/tasks`, recuperação na API real).
- E2E de regressão: sem rolagem horizontal no celular.
- Vídeos de marketing 9:16, 1:1 e 16:9 em `docs/marketing/`, gravados na stack real, e os scripts que os geram.

## [0.1.0] - 2026-10-31

### Adicionado
- API NestJS com orquestrador durável: planner, dispatcher paralelo em ondas, loop de correção (máximo 2 rodadas), merge.
- AI Gateway: limite de tokens, cache semântico (Redis), budget guard, roteamento pelo modelo mais barato, fallback.
- Strategy registry para agentes, provedores de modelo e ferramentas.
- Durable execution com journal no Postgres e adaptador preparado para Restate.
- Idempotency-Key em `POST /tasks` e nas ferramentas, com outbox transacional.
- Aprovação humana durável (aprovar, rejeitar, retomar).
- Eventos assinados com HMAC entregues por webhook, com retry e backoff.
- Memória compartilhada entre subagentes e contexto versionado com hash encadeado.
- Billing por tarefa, subagente e modelo, export CSV e scripts `billing-report`, `budget-check`, `run-loop`.
- Dashboard Next.js com Motion: subagentes ao vivo, fluxo do gateway, billing, timeline de contexto, webhooks.
- Docker Compose (Postgres, Redis, API, Web), testes unitários (jest) e e2e (Playwright).
