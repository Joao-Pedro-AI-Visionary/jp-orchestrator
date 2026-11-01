# Changelog

Formato baseado em Keep a Changelog. Versionamento semântico.

## [Unreleased]

### Auditoria 2026-11-01: achados médios e baixos
- Webhooks: `POST /webhooks/inbox` responde `401` sem assinatura válida e não grava nada (M2).
- Gateway: modelo marcado fora do ar é pulado sem reserva nem chamada (M3); resposta degradada de tier inferior não é
  cacheada no escopo do tier pedido (M9).
- Compose: Postgres e Redis com senha obrigatória (`POSTGRES_PASSWORD`, `REDIS_PASSWORD` + `requirepass`) e portas só em
  `127.0.0.1` (M4).
- SSE: filtro `?taskId=`, limite de conexões por IP e total com `429` (M5).
- Revisor reprova sem evidência do código na memória compartilhada; aviso no boot com Postgres sem Redis (M6).
- Aprovação humana resolvida com escrita condicional (`WHERE status = 'pending'`): decisões concorrentes dão um `409` (M7).
- Billing agregado no banco (`GROUP BY`) e atualizado no máximo a cada 2,5 s pelo dashboard (M8).
- Snapshot de contexto idempotente no replay e commit com nova tentativa em disputa de versão (M1, parcial: ver README).
- Retry de subagente só depois que a tentativa anterior parou; quem ignora o abort não é repetido. Agentes checam o
  sinal antes de cada efeito (M13). Sem retry para limite de tokens e estratégia desconhecida (L5).
- `Idempotency-Key` de tarefa: até 255 caracteres, vinculada ao hash do corpo (`422` se divergir) e esquecida após
  `IDEMPOTENCY_KEY_TTL_MS` (migração `0004`) (L3). Nota de aprovação validada (texto, até 1000) (L2).
- Mensagens de erro públicas por domínio; o resto vira `Erro interno (ref …)` com o detalhe no log (L4).
- "Retomar" recusado (`409`, `resumable: false`) quando a revisão reprovou na última rodada (L5).
- Planner sem a chamada de modelo paga e descartada (L6).
- Store e memória compartilhada em memória limitados; store em memória recusado em produção sem
  `ALLOW_MEMORY_STORE=true` (L7). `schema.sql` aplicado dentro do advisory lock das migrações (L8).
- Cabeçalhos de segurança na API e no web, incluindo CSP com `frame-ancestors 'none'` (L9).
- `/health` diferencia `up`, `down` e `disabled`; detalhe da tarefa expõe `maxCorrectionRounds` e `resumable` (L13).
- Web: formulário não perde o texto quando a criação falha (M10); live region anuncia só transições relevantes, sem
  heartbeat, com coalescência (M11); `Idempotency-Key` por rascunho, com fallback a `crypto.getRandomValues` (M12);
  ressincroniza após reconexão do SSE e "pending" por tarefa (L10); `MotionConfig reducedMotion="user"` e barras de
  billing sem animação com movimento reduzido (L11); limites iguais aos da API, erro por campo com `aria-invalid`,
  `aria-describedby` e foco (L12); KPIs com erro e "Tentar de novo", "não configurado" no header (L13); API via
  `/api` no mesmo domínio, URL resolvida em runtime (`API_INTERNAL_URL`) (L14).

### Segurança
- API exige `API_KEY` em todas as rotas (`x-api-key` ou `Authorization: Bearer`; no SSE `/events` também
  `?api_key=`), exceto `GET /health` e `POST /webhooks/inbox`. O boot falha sem chave ou com chave curta.
- Rate limit por IP (todas as rotas e, mais apertado, `POST /tasks`), com `429` e `Retry-After`.
- Bind em `HOST` (padrão `127.0.0.1`; a imagem Docker usa `0.0.0.0`) e compose publicando API e web só em `127.0.0.1`.
- CORS com allowlist de `CORS_ORIGIN` (obrigatório em produção, sem `*`); antes refletia qualquer origem.
- `WEBHOOK_SECRET` sem fallback público: em produção o boot falha se ausente, igual ao exemplo ou curto (< 32);
  fora de produção usa um segredo aleatório por processo. O compose exige a variável.
- `multer` fixado em 2.5.0 via `overrides` (GHSA-q7qp-rjg7-q26m).
- Dashboard e scripts enviam a chave (`NEXT_PUBLIC_API_KEY` / `API_KEY`); o CSV é baixado via `fetch` com header.

### Corrigido
- Timeout da tarefa aborta o loop de verdade (`AbortSignal` propagado a planner, subagentes, gateway e provedor) e a
  guarda só é liberada quando o loop para. O estado final só é gravado se a tarefa ainda não for terminal
  (`finishTask`), então cada tarefa emite um único evento terminal.
- Execução por tarefa protegida por lease no banco (`tasks.lease_owner`/`lease_until`, renovado por heartbeat):
  duas réplicas não rodam a mesma tarefa, `resumeActive` só retoma as tarefas cujo lease conseguiu e
  `POST /tasks/:id/resume` considera o lease de qualquer réplica. Lease perdido aborta a execução sem evento terminal.
- `putStep` do journal é first-writer-wins: quem perde a corrida usa o valor já gravado, não o próprio.
- Cache semântico com escopo `tenant:tarefa:agente:tier`; antes uma tarefa podia receber a resposta de outra.
- Orçamento com reserva atômica (`tasks.reserved_usd`) antes de cada chamada e de cada fallback, liquidada pelo custo
  real; antes subagentes paralelos passavam todos pelo guard e estouravam o limite.
- Reentregas e retries agora têm horizonte imposto dentro do TTL da chave de idempotência (antes só implícito):
  o boot falha (`assertRetryHorizon`) se o pior caso do outbox (soma dos backoffs + tentativas × (timeout + lease)),
  o das ferramentas (tentativas × lease) ou `OUTBOX_MAX_AGE_MS` for >= `IDEMPOTENCY_KEY_TTL_MS`, ou se algum valor
  não for inteiro positivo.
- `OutboxRelay`: evento mais antigo que `OUTBOX_MAX_AGE_MS` vira `dead` com `last_error = 'expired'` e não é enviado.
- `ToolInvoker`: takeovers de lease limitados a `TOOL_MAX_ATTEMPTS`; chamada `started` criada há mais de
  `IDEMPOTENCY_KEY_TTL_MS` não é reexecutada. Os dois casos lançam `ToolCallRefusedError` sem rodar o handler.

### Adicionado
- Variáveis `IDEMPOTENCY_KEY_TTL_MS` (padrão 86400000 = 24 h), `OUTBOX_MAX_AGE_MS` (600000 = 10 min),
  `OUTBOX_CLAIM_LEASE_MS` (30000, antes fixo no código) e `TOOL_MAX_ATTEMPTS` (3).
- `api/src/common/retry-horizon.ts`: `retryConfig`, `outboxHorizonMs`, `toolHorizonMs` e `assertRetryHorizon` (puras, testadas).

### Testes
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
