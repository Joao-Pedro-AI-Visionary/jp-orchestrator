# Changelog

Formato baseado em Keep a Changelog. Versionamento semântico.

## [0.2.0] - 2026-10-31

### Alterado
- UI refinada a partir de shots populares do Dribbble para dashboards de agentes de IA e dev tools
  (AI Agent Analytics, AI Voice Agent Dashboard, OPERATE, Montseract): topbar fixa translúcida,
  rótulos de seção (eyebrow), KPIs com faixa de destaque, fundo pontilhado sutil.
- Listas longas (tarefas, webhooks, faturamento por tarefa) rolam dentro do próprio card, com cabeçalho
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
