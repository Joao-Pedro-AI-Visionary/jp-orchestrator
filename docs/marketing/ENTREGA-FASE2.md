# Entrega Fase 2: JP Orchestrator v0.2.0

STATUS: FASE2_OK

Repositório: https://github.com/Joao-Pedro-AI-Visionary/jp-orchestrator (tag `v0.2.0`)

## 1. UI refinada por referências do Dribbble

A busca e o fetch direto do Dribbble foram bloqueados (HTTP 202 vazio). A página pública
`dribbble.com/search/ai-agent-dashboard?s=popular` foi aberta em Chromium headless, sem login.
Shots usados como referência (curtidas no dia 31/10/2026):

| Shot | Autor | Curtidas |
|---|---|---|
| AI Agent website design | Abu Bokkor Siddik | 146 |
| AI Agent Dashboard UI/UX Design | Shasanko Creations | 75 |
| AI Voice Agent Dashboard | Shasanko Das | 71 |
| AI Agent Analytics dashboard | Mostafijur Rahman | 65 |
| OPERATE, SAAS AI teams running dashboard analytics | Taras Migulko | 62 |
| Montseract, Server Monitoring Dashboard | Emura | 41 |

Padrões aplicados (com a lei de UX correspondente):

- Topbar translúcida, fixa só no desktop (Jakob). No celular ela quebraria em 3 linhas e ocuparia 21% da tela.
- Rótulo curto (eyebrow) acima de todo título de seção (Semelhança, Proximidade).
- KPIs com faixa de destaque na cor do indicador (Von Restorff, sem competir com o CTA).
- Listas longas (tarefas, webhooks, faturamento por tarefa) rolam dentro do card no desktop, com
  cabeçalho fixo na tabela (Prägnanz, Miller). A página desktop caiu de ~7.900 px para ~4.100 px.
- Fundo pontilhado sutil e cantos de 18 px (Prägnanz).
- Botão de erro "Tentar de novo" com ícone, alvo de 48 px (Fitts, Pico-Fim).

Corrigido: rolagem horizontal no celular. As colunas do grid não tinham `min-w-0` e se alargavam
pelo AI Gateway (723 px num viewport de 540 px), o que também fazia cliques caírem no lugar errado.

## 2. Vídeos de marketing (stack real)

Gravados com Playwright contra `docker compose up` (Postgres, Redis, API, Web), sem mocks:
criação de tarefa, subagentes em paralelo, timeline de contexto, aprovação humana, derrubar e
restaurar modelo no gateway, faturamento. Montados com ffmpeg (libx264, AAC silencioso, faststart).

| Arquivo | Resolução | Duração | Tamanho |
|---|---|---|---|
| `tiktok-instagram-9x16.mp4` | 1080x1920 | 27,5 s | 8,7 MB |
| `linkedin-1x1.mp4` | 1080x1080 | 27,9 s | 1,7 MB |
| `linkedin-16x9.mp4` | 1920x1080 | 27,9 s | 4,3 MB |

Legendas em pt-BR, marca JpDev na abertura e no encerramento, sem emojis nem travessão longo.
O ffmpeg do Homebrew não tem `drawtext` nem `libass`, então legendas e cartões são PNG gerados
pelo Playwright e aplicados com `overlay`. Para regerar: `scripts/marketing/record.mjs` e
`scripts/marketing/build-videos.mjs` (README, seção "Vídeos de demonstração").

## 3. Verificação

| Portão | Resultado |
|---|---|
| lint (api + web) | ok |
| typecheck (api + web) | ok |
| build (api + web) | ok |
| testes unitários (jest) | 28 de 28 |
| e2e Playwright, stack real | 4 de 4, incluindo "Tentar de novo" e a regressão da rolagem horizontal |
| gate do prepush (sync, segredos, estático, testes) | `PREPUSH_RESULT=ok` |
| revisão independente | 0 blocker; 5 should-fix e 2 nits corrigidos em 1 rodada |

O e2e do "Tentar de novo" bloqueia o SSE e falha só a primeira leitura de `/tasks` no navegador;
o teste exige uma segunda requisição feita pelo clique e a lista vinda da API real.

## Pendências conhecidas

- Nit da revisão não corrigido: o `thead` fixo da tabela de faturamento usa fundo opaco sobre o card translúcido, e a diferença de tom aparece ao rolar.
- Não confirmei que a asserção de rolagem horizontal falharia no código da v0.1.0; a causa foi medida
  no navegador antes da correção (723 px contra 540 px).
- O ranking do Dribbble muda com o tempo; a tabela acima reflete a página no dia da coleta.
