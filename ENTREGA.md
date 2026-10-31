# Entrega JP Orchestrator v0.1.0

STATUS: MVP_OK

Repositório: https://github.com/Joao-Pedro-AI-Visionary/jp-orchestrator

## Árvore (2 níveis)

```
.env.example
CHANGELOG.md
LICENSE
README.md
api
api/.dockerignore
api/Dockerfile
api/eslint.config.mjs
api/package-lock.json
api/package.json
api/src
api/tsconfig.build.json
api/tsconfig.json
docker-compose.yml
docs
docs/api-contract.md
docs/screenshots
e2e
e2e/dashboard.spec.ts
package-lock.json
package.json
playwright.config.ts
scripts
scripts/billing-report.mjs
scripts/budget-check.mjs
scripts/run-loop.mjs
web
web/.dockerignore
web/.env.example
web/.gitignore
web/Dockerfile
web/UX.md
web/app
web/components
web/eslint.config.mjs
web/lib
web/next-env.d.ts
web/next.config.ts
web/package-lock.json
web/package.json
web/postcss.config.mjs
web/public
web/tsconfig.json
web/tsconfig.tsbuildinfo
```

## Arquivos principais

- `api/src/orchestration/orchestrator.service.ts`: loop durável (plan, dispatch paralelo, correção, aprovação, merge)
- `api/src/orchestration/dispatcher.ts`, `planner.ts`, `merger.ts`, `loops.ts`: loops e seus limites
- `api/src/gateway/gateway.service.ts`: AI Gateway (tokens, cache semântico, budget, roteamento, fallback)
- `api/src/strategy/strategy-registry.ts`, `api/src/agents/agents.ts`: Strategy
- `api/src/durable/`: JournalRuntime e adaptador Restate
- `api/src/tools/tool-invoker.service.ts`: Idempotency-Key + outbox
- `api/src/events/signer.ts`, `outbox-relay.service.ts`: eventos assinados HMAC
- `api/src/memory/`: memória compartilhada e contexto versionado
- `api/src/billing/billing.service.ts`, `scripts/`: billing, orçamento e relatórios
- `web/components/`: dashboard Next.js com Motion
- `e2e/dashboard.spec.ts`: e2e Playwright, `docs/screenshots/`: evidências

## Status dos testes (executados em 2026-10-31 no HEAD desta entrega)

- Unitários (jest, API): 8 suítes, 28 testes passando.
- Lint, typecheck e build (API e Web): passando (`npm run prepush`, exit 0).
- Stack real: `docker compose up` com Postgres 17 e Redis 7, `/health` com postgres e redis ativos.
- Loop real (`scripts/run-loop.mjs`): tarefa concluída com pico de 3 subagentes em paralelo; outbox 10/10 entregues, 10 webhooks com assinatura válida.
- E2E Playwright (`e2e/dashboard.spec.ts`): 3/3 passando. Clica em CTA, 3 presets, envio, 4 filtros, card, aprovar, rejeitar, retomar, toggles dos 4 modelos, exportar CSV, fechar aviso; valida cada ação na API (subagentes em paralelo na UI, hash chain dos snapshots, webhook verificado, rodada de correção, corte por orçamento, fallback e retomada pelo journal, acertos de cache, Idempotency-Key, aria-live e movimento reduzido).
- Varredura de segredos (gitleaks): sem vazamentos.

## Limitações conhecidas

- Provedor de modelo é determinístico (MockProvider); provedor real entra como nova Strategy.
- Adaptador Restate preparado, não ligado por padrão.
- O botão "Tentar de novo" dos estados de erro de carregamento não é coberto pelo e2e (exige derrubar a API no meio do teste).
- Revisão independente por outro agente não foi executada nesta etapa.
