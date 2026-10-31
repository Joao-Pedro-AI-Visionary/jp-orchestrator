# Entrega: narração dos vídeos de marketing (v0.3.1)

STATUS: NARRACAO_OK

## Saídas

| Arquivo | Resolução | Duração | Áudio | Loudness |
|---|---|---|---|---|
| `tiktok-instagram-9x16-narrado.mp4` | 1080x1920 | 40,8 s | AAC 48 kHz estéreo, 160 kb/s | -15,9 LUFS |
| `linkedin-1x1-narrado.mp4` | 1080x1080 | 44,1 s | AAC 48 kHz estéreo, 160 kb/s | -16,0 LUFS |
| `linkedin-16x9-narrado.mp4` | 1920x1080 | 43,1 s | AAC 48 kHz estéreo, 160 kb/s | -16,5 LUFS |

Conferido com `ffprobe`: cada arquivo tem uma faixa de vídeo h264 e uma de áudio aac, com a mesma duração.
`blackdetect` não achou quadro preto. Os vídeos originais sem narração continuam iguais.

## Vozes testadas e escolha

Mesmo texto de teste com pergunta, exclamação e pausas, gerado nas três vozes neurais pt-BR do edge-tts
e na Luciana do macOS. Medi a variação de entonação (F0 por autocorrelação) e a duração:

| Voz | Duração | Faixa de F0 (p5 a p95) | Desvio |
|---|---|---|---|
| pt-BR-ThalitaMultilingualNeural | 10,1 s | 13,0 semitons | 4,1 st |
| pt-BR-AntonioNeural | 11,9 s | 17,0 semitons | 5,6 st |
| pt-BR-FranciscaNeural | 9,8 s | 12,7 semitons | 3,6 st |
| Luciana (macOS) | 10,4 s | 7,9 semitons | 2,3 st |

Escolhida: **pt-BR-ThalitaMultilingualNeural**. Motivos:
- É da geração Multilingual, com estilos "Warm, Casual, Cheerful" e entonação mais variada que a Francisca.
- O Antonio mediu faixa maior, mas em voz grave o rastreador por autocorrelação tende a errar oitava, então
  esse número superestima a expressividade. Ele também fala uns 18% mais devagar, o que alongaria cada cena.
- A Luciana do macOS teve a entonação mais plana (2,3 st), soando robótica perto das neurais.

Limite: a escolha usa métricas objetivas e as características documentadas das vozes. Não houve audição
humana neste ambiente; vale ouvir os três arquivos antes de publicar.

O edge-tts 7.2.3 não aceita SSML customizado: o texto passa por `xml.sax.saxutils.escape` e entra no SSML que a
própria biblioteca monta (`mkssml`), então `<break>` e `<prosody>` virariam texto lido.
Pausas e ritmo vieram da pontuação do roteiro (vírgula, ponto, reticências, pergunta), do parâmetro `--rate`
(+4% no TikTok, 0% no LinkedIn) e de respiros fixos entre as cenas.

## Roteiros

Um por formato, em `scripts/marketing/narracao.json`. Oito falas por vídeo, uma por cena:
abertura, painel, subagentes, snapshot, aprovação, gateway, custo e encerramento.
O TikTok tem tom mais informal e gancho em pergunta; o 1:1 é mais institucional; o 16:9 abre com uma pergunta.

## Sincronização

`node scripts/marketing/build-videos.mjs --narrar` gera um mp3 por cena e calcula o tempo mínimo de tela de
cada uma: respiro de 0,15 s, fala e mais 0,45 s (mais a duração do fade nas cenas de borda). Quando a gravação
é mais curta, a cena é estendida congelando o último quadro (`tpad=stop_mode=clone`), com a legenda ainda
na tela. Nada foi cortado nem acelerado. Abertura e encerramento são cartões estáticos e só ganham duração.
As transições continuam em fade de 0,4 s.

Linha do tempo do 9:16 (os outros dois seguem o mesmo esquema, tabela completa no log do build):

| Cena | Tela | Fala |
|---|---|---|
| abertura | 0,00 a 4,70 s | 0,15 a 3,85 s |
| painel | 4,30 a 8,94 s | 4,85 a 8,49 s |
| subagentes | 8,94 a 15,43 s | 9,09 a 14,42 s |
| snapshot | 15,43 a 19,96 s | 15,58 a 19,06 s |
| aprovação | 19,96 a 23,20 s | 20,11 a 22,75 s |
| gateway | 23,20 a 28,19 s | 23,35 a 27,74 s |
| custo | 28,19 a 34,95 s | 28,34 a 34,10 s |
| encerramento | 34,55 a 40,75 s | 35,10 a 39,95 s |

Em todos os vídeos cada fala começa e termina dentro da própria cena e nenhuma fala invade a seguinte.
O `silencedetect` confirma um respiro de aproximadamente 1 s entre as cenas.

## Música de fundo

Não incluída (era opcional). Sem uma trilha licenciada no repositório, preferi não sintetizar uma base genérica.

## Ferramentas

edge-tts 7.2.3 (via `uv tool`), ffmpeg do Homebrew (amix, adelay, loudnorm, tpad, xfade), ffprobe,
Playwright (cartões e legendas) e numpy 2.3.4 só na medição de entonação.
