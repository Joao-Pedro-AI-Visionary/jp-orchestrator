# Entrega Fase 3: JP Orchestrator v0.3.0 (identidade JpDev)

STATUS: FASE3_OK

Repositório: https://github.com/Joao-Pedro-AI-Visionary/jp-orchestrator (tag `v0.3.0`)

Ressalva: a re-execução final do e2e não rodou por falha de infraestrutura (seção 4). O e2e verde
abaixo rodou sobre o mesmo código de app que está no commit.

## 1. Logo real

`brand/jpdev-logo.png` (758x902) só foi redimensionado, sem recriar nem redesenhar:

| Uso | Arquivo | Tamanho |
|---|---|---|
| Topbar (`next/image`, `data-testid="brand-logo"`) | `web/public/jpdev-logo.png` | 161x192 |
| Favicon | `web/app/icon.png` | 64x64 (centralizado com fundo transparente) |
| Apple touch icon | `web/app/apple-icon.png` | 180x180 |
| README | `docs/jpdev-logo.png` | 202x240 |
| Vídeos | embutido em base64 a partir do original | cartões, moldura 1:1, selo |

O `web/public/icon.svg` antigo (quadrado roxo com "Jp") foi removido.

## 2. Paleta

| Token | Valor | Contraste sobre `#0A0A0A` |
|---|---|---|
| `brand` (CTA, foco, eyebrow, destaques) | `#FFC800` | 12,7:1 |
| `brand-soft` (hover, "Planejando") | `#FACC15` | 12,9:1 |
| `accent` (apoio: aprovação, integrando, barras por agente) | `#FF7A00` | 7,6:1 |
| `ok` (status de sucesso) | `#5FBF85` | 8,8:1 |
| `bad` (status de falha) | `#F07171` | 6,9:1 |
| texto secundário (`neutral-400`) | `#A3A3A3` | 7,9:1 |

Saíram: roxo `#6d4aff`, índigo, azul, sky, ciano e verde/emerald neon, inclusive dos brilhos e do shimmer.
Os neutros passaram de `slate` (azulado) para `neutral`. CTA: amarelo com texto preto. Todos os pares ficam acima de AA (4,5:1).

## 3. Tipografia

Space Grotesk (títulos, `font-heading`, tracking -0,02em) e Inter (texto), via `next/font/google`.
Hierarquia: wordmark e títulos de seção em Space Grotesk bold, eyebrow em caixa alta amarela, corpo em Inter.
Nos vídeos as legendas usam Space Grotesk bold com borda amarela e ponto final laranja. O build falha se as fontes não carregarem.

## 4. Verificação

| Portão | Resultado |
|---|---|
| lint (api + web) | ok, no tree final |
| typecheck (api + web) | ok, no tree final |
| build (api + web) | ok, no tree final |
| unit (jest) | 28 de 28, no tree final |
| e2e Playwright, stack real | 4 de 4 às 12:51 (fluxo completo com todos os botões, "Tentar de novo", Idempotency-Key, acessibilidade) |
| e2e novo: logo carregado, favicon HTTP 200, CTA `rgb(255, 200, 0)` | primeiro falhou contra a UI antiga (RED), depois passou |
| gitleaks no diff | sem vazamentos |

Re-execução final do e2e: **[Não verificável]**. O Docker (VM Colima) começou a devolver `input/output error`
no containerd, com o disco do host em 95% (732 MB livres). A API parou de responder na 3001. Depois do e2e verde
só mudaram README, CHANGELOG, `scripts/marketing/build-videos.mjs` e o campo `version` dos `package.json`;
nenhum arquivo servido pela app mudou (mtimes: componentes às 12:49, screenshots do e2e verde às 12:51).
Para recuperar: liberar alguns GB no host, reiniciar o Colima (`colima restart`) e rodar `npm run e2e`.

## 5. Vídeos (regravados na stack real, com a nova UI)

| Arquivo | Resolução | Duração |
|---|---|---|
| `tiktok-instagram-9x16.mp4` | 1080x1920 | 27,6 s |
| `linkedin-1x1.mp4` | 1080x1080 | 27,7 s |
| `linkedin-16x9.mp4` | 1920x1080 | 27,7 s |

O logo aparece na abertura, no encerramento e num selo no canto inferior esquerdo durante todo o conteúdo
(na moldura do 1:1, no topo). Na primeira versão o selo cobria o header do app; foi movido (rodada 2 de 2).

## 6. Screenshots

Os 8 arquivos de `docs/screenshots/` foram regerados pelo e2e verde com a nova identidade.
