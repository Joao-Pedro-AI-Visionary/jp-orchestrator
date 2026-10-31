// Monta os vídeos de marketing a partir das gravações reais de record.mjs.
// Uso: node scripts/marketing/build-videos.mjs [pasta-das-gravacoes] [pasta-de-saida]
// O ffmpeg do Homebrew não traz drawtext/libass, então legendas e cartões viram PNG (Playwright) + overlay.
import { chromium } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const src = resolve(process.argv[2] ?? 'reports/marketing');
const out = resolve(process.argv[3] ?? 'docs/marketing');
const tmp = join(src, 'overlays');
mkdirSync(tmp, { recursive: true });
mkdirSync(out, { recursive: true });

const FPS = 30;
const INTRO = 2.6;
const OUTRO = 3.2;
const XF = 0.4;
const REPO = 'github.com/Joao-Pedro-AI-Visionary/jp-orchestrator';

// Trechos da gravação: [marcador inicial, marcador final, folga no fim (s), velocidade, legenda]
const SEGMENTS = [
  ['dashboard', 'create', 0, 1, 'Seu time de agentes de código em um painel só'],
  ['create', 'done', 1, 1, 'Uma tarefa vira subagentes em paralelo, ao vivo'],
  ['timeline', 'approval', 0, 1, 'Cada etapa vira um snapshot versionado do contexto'],
  ['approval', 'approved', 0.8, 2, 'Aprovação humana antes do merge'],
  ['gateway', 'billing', 0, 1, 'Um modelo caiu? O gateway faz o fallback'],
  ['billing', 'end', 0, 1, 'Custo por modelo, agente e tarefa, com export CSV'],
];

const FORMATS = [
  { file: 'tiktok-instagram-9x16.mp4', source: 'mobile', W: 1080, H: 1920, caption: { top: 300, size: 50, width: 900 } },
  { file: 'linkedin-1x1.mp4', source: 'desktop', W: 1080, H: 1080, framed: true, caption: { top: 880, size: 40, width: 980 } },
  { file: 'linkedin-16x9.mp4', source: 'desktop', W: 1920, H: 1080, caption: { top: 880, size: 46, width: 1500 } },
];

// aspas simples: o valor vai dentro de style="..."
const FONT = `-apple-system, 'SF Pro Display', 'Helvetica Neue', Arial, sans-serif`;
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const logo = (px) =>
  `<div style="width:${px}px;height:${px}px;border-radius:${px * 0.28}px;background:#6d4aff;display:grid;place-items:center;color:#fff;font-weight:800;font-size:${px * 0.42}px;box-shadow:0 0 ${px * 0.7}px -${px * 0.12}px rgba(109,74,255,.9)">Jp</div>`;
const bg = `background-color:#07080f;background-image:radial-gradient(900px 600px at 20% 0%, rgba(109,74,255,.35), transparent 60%), radial-gradient(700px 500px at 100% 100%, rgba(34,211,238,.14), transparent 60%);`;

function cardHtml(W, H, kind) {
  const s = Math.min(W, H) / 1080;
  const body =
    kind === 'intro'
      ? `${logo(140 * s)}
         <div style="font-size:${120 * s}px;font-weight:800;letter-spacing:-2px;margin-top:${40 * s}px">JpDev</div>
         <div style="font-size:${46 * s}px;color:#c4b5fd;font-weight:600;margin-top:${8 * s}px">JP Orchestrator</div>
         <div style="font-size:${36 * s}px;color:#cbd5e1;margin-top:${36 * s}px;max-width:${W * 0.8}px">Orquestração de agentes de código com custo sob controle</div>`
      : `${logo(110 * s)}
         <div style="font-size:${80 * s}px;font-weight:800;letter-spacing:-1px;margin-top:${36 * s}px">JP Orchestrator</div>
         <div style="font-size:${38 * s}px;color:#cbd5e1;margin-top:${18 * s}px">Código aberto, licença MIT</div>
         <div style="font-size:${30 * s}px;color:#a5b4fc;margin-top:${34 * s}px;padding:${14 * s}px ${26 * s}px;border:1px solid rgba(165,180,252,.45);border-radius:${18 * s}px">${REPO}</div>
         <div style="font-size:${34 * s}px;font-weight:700;margin-top:${48 * s}px;color:#fff">JpDev</div>`;
  return `<body style="margin:0;width:${W}px;height:${H}px;${bg}font-family:${FONT};color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center">${body}</body>`;
}

function captionHtml(W, H, c, text) {
  return `<body style="margin:0;width:${W}px;height:${H}px;background:transparent;font-family:${FONT}">
    <div style="position:absolute;top:${c.top}px;left:50%;transform:translateX(-50%);max-width:${c.width}px;width:max-content;
      padding:${c.size * 0.45}px ${c.size * 0.75}px;border-radius:${c.size * 0.5}px;background:rgba(7,8,15,.86);
      border:2px solid rgba(139,92,246,.75);box-shadow:0 12px 40px -10px rgba(109,74,255,.7);
      color:#fff;font-weight:700;font-size:${c.size}px;line-height:1.25;text-align:center">${esc(text)}</div></body>`;
}

function frameHtml(W, H) {
  return `<body style="margin:0;width:${W}px;height:${H}px;${bg}font-family:${FONT};color:#fff">
    <div style="position:absolute;top:70px;left:50px;display:flex;align-items:center;gap:22px">${logo(84)}
      <div><div style="font-size:52px;font-weight:800;letter-spacing:-1px">JpDev</div>
      <div style="font-size:28px;color:#c4b5fd;font-weight:600">JP Orchestrator</div></div></div></body>`;
}

async function renderPngs(browser, f) {
  const page = await browser.newPage({ viewport: { width: f.W, height: f.H } });
  const shot = async (html, name, transparent = false) => {
    await page.setContent(html);
    const path = join(tmp, `${f.W}x${f.H}-${name}.png`);
    await page.screenshot({ path, omitBackground: transparent });
    return path;
  };
  const r = {
    intro: await shot(cardHtml(f.W, f.H, 'intro'), 'intro'),
    outro: await shot(cardHtml(f.W, f.H, 'outro'), 'outro'),
    captions: [],
  };
  if (f.framed) r.frame = await shot(frameHtml(f.W, f.H), 'frame');
  for (const [i, seg] of SEGMENTS.entries()) r.captions.push(await shot(captionHtml(f.W, f.H, f.caption, seg[4]), `cap${i}`, true));
  await page.close();
  return r;
}

function build(f, png) {
  const m = JSON.parse(readFileSync(join(src, `${f.source}.markers.json`), 'utf8'));
  const inputs = ['-i', join(src, `${f.source}.webm`)];
  const still = (p, t) => inputs.push('-loop', '1', '-framerate', String(FPS), '-t', String(t), '-i', p);
  still(png.intro, INTRO); // 1
  still(png.outro, OUTRO); // 2
  png.captions.forEach((p) => still(p, 1)); // 3..
  const capBase = 3;
  let frameIdx = -1;
  if (png.frame) {
    frameIdx = capBase + png.captions.length;
    still(png.frame, 1);
  }

  const norm = `fps=${FPS},format=yuv420p,setsar=1,settb=AVTB`;
  const parts = [];
  const labels = [];
  const windows = [];
  let t = 0;
  SEGMENTS.forEach(([a, b, pad, speed], i) => {
    const start = m[a];
    const end = Math.min(m[b] + pad, m.end);
    const dur = (end - start) / speed;
    parts.push(`[0:v]trim=start=${start.toFixed(3)}:end=${end.toFixed(3)},setpts=(PTS-STARTPTS)/${speed}[s${i}]`);
    labels.push(`[s${i}]`);
    windows.push([t, t + dur]);
    t += dur;
  });
  const contentDur = t;
  parts.push(`${labels.join('')}concat=n=${labels.length}:v=1:a=0[raw]`);

  // enquadramento por formato
  if (f.source === 'mobile') parts.push(`[raw]scale=${f.W}:${f.H}:flags=lanczos,${norm}[base]`);
  else if (f.framed) {
    const vh = Math.round((f.W * 9) / 16 / 2) * 2;
    parts.push(`[raw]scale=${f.W - 60}:-2:flags=lanczos[vid]`);
    parts.push(`[${frameIdx}:v]loop=-1:1,trim=duration=${contentDur.toFixed(3)},${norm}[fr]`);
    parts.push(`[fr][vid]overlay=30:${Math.round((f.H - vh) / 2) + 30}:shortest=1,${norm}[base]`);
  } else parts.push(`[raw]scale=${f.W}:${f.H}:flags=lanczos,${norm}[base]`);

  let cur = 'base';
  windows.forEach(([a, b], i) => {
    const s = Math.max(0, a + (i === 0 ? XF : 0.1));
    parts.push(`[${capBase + i}:v]loop=-1:1,format=rgba[c${i}]`);
    parts.push(`[${cur}][c${i}]overlay=0:0:shortest=0:eof_action=pass:enable='between(t,${s.toFixed(2)},${(b - 0.1).toFixed(2)})'[o${i}]`);
    cur = `o${i}`;
  });
  parts.push(`[${cur}]trim=duration=${contentDur.toFixed(3)},${norm}[content]`);
  parts.push(`[1:v]${norm}[intro]`, `[2:v]${norm}[outro]`);
  parts.push(`[intro][content]xfade=transition=fade:duration=${XF}:offset=${(INTRO - XF).toFixed(3)}[x1]`);
  parts.push(`[x1][outro]xfade=transition=fade:duration=${XF}:offset=${(INTRO + contentDur - 2 * XF).toFixed(3)}[v]`);

  const total = INTRO + contentDur + OUTRO - 2 * XF;
  const args = [
    '-y', '-v', 'error', ...inputs,
    '-f', 'lavfi', '-t', total.toFixed(3), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
    '-filter_complex', parts.join(';'),
    '-map', '[v]', '-map', `${inputs.filter((x) => x === '-i').length}:a`,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(FPS),
    '-c:a', 'aac', '-b:a', '96k', '-shortest', '-movflags', '+faststart',
    join(out, f.file),
  ];
  const res = spawnSync('ffmpeg', args, { stdio: 'inherit' });
  if (res.status !== 0) throw new Error(`ffmpeg falhou em ${f.file}`);
  console.log(`${f.file}: ${total.toFixed(1)}s`);
}

const browser = await chromium.launch();
for (const f of FORMATS) build(f, await renderPngs(browser, f));
await browser.close();
