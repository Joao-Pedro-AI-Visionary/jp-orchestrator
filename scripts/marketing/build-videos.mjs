// Monta os vídeos de marketing a partir das gravações reais de record.mjs.
// Uso: node scripts/marketing/build-videos.mjs [pasta-das-gravacoes] [pasta-de-saida]
// O ffmpeg do Homebrew não traz drawtext/libass, então legendas e cartões viram PNG (Playwright) + overlay.
// --narrar: gera a fala de cada cena (edge-tts, roteiro em narracao.json) e grava <nome>-narrado.mp4.
// Cena mais curta que a fala ganha tempo congelando o último quadro (tpad), sem corte seco.
import { chromium } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const NARRAR = process.argv.includes('--narrar');
const [srcArg, outArg] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const src = resolve(srcArg ?? 'reports/marketing');
const out = resolve(outArg ?? 'docs/marketing');
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
  { file: 'tiktok-instagram-9x16.mp4', source: 'mobile', W: 1080, H: 1920, caption: { top: 300, size: 54, width: 940 }, badge: { top: 1740, left: 40, h: 120 } },
  { file: 'linkedin-1x1.mp4', source: 'desktop', W: 1080, H: 1080, framed: true, caption: { top: 880, size: 42, width: 980 } },
  { file: 'linkedin-16x9.mp4', source: 'desktop', W: 1920, H: 1080, caption: { top: 880, size: 48, width: 1500 }, badge: { top: 950, left: 30, h: 96 } },
];

// Identidade JpDev: logo real (brand/jpdev-logo.png, só redimensionado), amarelo/preto, laranja de apoio.
// Tipografia: Space Grotesk (títulos) + Inter (texto). Aspas simples: o valor vai dentro de style="...".
const DISPLAY = `'Space Grotesk', sans-serif`;
const TEXT = `'Inter', sans-serif`;
const FONTS_CSS = 'https://fonts.googleapis.com/css2?family=Inter:wght@500;600;700&family=Space+Grotesk:wght@600;700&display=block';
const Y = '#FFC800';
const INK = '#0A0A0A';
const ORANGE = '#FF7A00';
const LOGO = `data:image/png;base64,${readFileSync(resolve('brand/jpdev-logo.png')).toString('base64')}`;
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const logo = (h) => `<img src="${LOGO}" style="height:${h}px;width:auto;display:block" alt="">`;
const wordmark = (px) =>
  `<span style="font-family:${DISPLAY};font-weight:700;letter-spacing:-0.02em;font-size:${px}px;color:#fff">Jp<span style="color:${Y}">Dev</span></span>`;
const bg = `background-color:${INK};background-image:radial-gradient(900px 600px at 20% 0%, rgba(255,200,0,.16), transparent 60%), radial-gradient(700px 500px at 100% 100%, rgba(255,122,0,.08), transparent 60%);`;
const page = (W, H, style, body) =>
  `<html><head><link rel="stylesheet" href="${FONTS_CSS}"></head><body style="margin:0;width:${W}px;height:${H}px;${style}font-family:${TEXT};color:#fff">${body}</body></html>`;

function cardHtml(W, H, kind) {
  const s = Math.min(W, H) / 1080;
  const body =
    kind === 'intro'
      ? `${logo(300 * s)}
         <div style="margin-top:${30 * s}px">${wordmark(120 * s)}</div>
         <div style="font-family:${DISPLAY};font-size:${48 * s}px;color:${Y};font-weight:700;margin-top:${8 * s}px">JP Orchestrator</div>
         <div style="font-size:${34 * s}px;color:#d4d4d4;font-weight:500;margin-top:${30 * s}px;max-width:${W * 0.8}px">Orquestração de agentes de código com custo sob controle</div>`
      : `${logo(240 * s)}
         <div style="font-family:${DISPLAY};font-size:${80 * s}px;font-weight:700;letter-spacing:-0.02em;margin-top:${30 * s}px">JP Orchestrator</div>
         <div style="font-size:${36 * s}px;color:#d4d4d4;font-weight:500;margin-top:${16 * s}px">Código aberto, licença MIT</div>
         <div style="font-size:${30 * s}px;font-weight:700;color:${INK};background:${Y};margin-top:${34 * s}px;padding:${14 * s}px ${26 * s}px;border-radius:${18 * s}px">${REPO}</div>
         <div style="margin-top:${40 * s}px">${wordmark(40 * s)}</div>`;
  return page(W, H, `${bg}display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;`, body);
}

// Legenda + selo do logo no canto: a marca fica visível durante todo o conteúdo.
function captionHtml(W, H, c, text, badge) {
  const b = badge
    ? `<div style="position:absolute;top:${badge.top}px;left:${badge.left}px;display:flex;align-items:center;gap:${badge.h * 0.25}px;padding:${badge.h * 0.12}px ${badge.h * 0.3}px ${badge.h * 0.12}px ${badge.h * 0.15}px;border-radius:${badge.h * 0.3}px;background:rgba(10,10,10,.82);border:2px solid rgba(255,200,0,.6)">${logo(badge.h)}${wordmark(badge.h * 0.42)}</div>`
    : '';
  return page(W, H, 'background:transparent;', `${b}
    <div style="position:absolute;top:${c.top}px;left:50%;transform:translateX(-50%);max-width:${c.width}px;width:max-content;
      padding:${c.size * 0.45}px ${c.size * 0.75}px;border-radius:${c.size * 0.4}px;background:rgba(10,10,10,.9);
      border:3px solid ${Y};box-shadow:0 12px 40px -12px rgba(255,200,0,.55);
      font-family:${DISPLAY};color:#fff;font-weight:700;font-size:${c.size}px;line-height:1.2;letter-spacing:-0.01em;text-align:center">${esc(text)}<span style="color:${ORANGE}">.</span></div>`);
}

function frameHtml(W, H) {
  return page(W, H, bg, `<div style="position:absolute;top:50px;left:50px;display:flex;align-items:center;gap:22px">${logo(120)}
      <div>${wordmark(56)}
      <div style="font-family:${DISPLAY};font-size:30px;color:${Y};font-weight:700">JP Orchestrator</div></div></div>`);
}

async function renderPngs(browser, f) {
  const page = await browser.newPage({ viewport: { width: f.W, height: f.H } });
  const shot = async (html, name, transparent = false) => {
    await page.setContent(html, { waitUntil: 'networkidle' });
    const ok = await page.evaluate(async () => {
      const faces = ["700 40px 'Space Grotesk'", "500 20px 'Inter'", "700 20px 'Inter'"];
      await Promise.all(faces.map((f) => document.fonts.load(f)));
      await document.fonts.ready;
      return faces.every((f) => document.fonts.check(f));
    });
    if (!ok) throw new Error('fontes da marca (Space Grotesk/Inter) não carregaram');
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
  for (const [i, seg] of SEGMENTS.entries()) r.captions.push(await shot(captionHtml(f.W, f.H, f.caption, seg[4], f.badge), `cap${i}`, true));
  await page.close();
  return r;
}

// Narração: um mp3 por cena. LEAD = respiro antes da fala, GAP = respiro depois.
const LEAD = 0.15;
const GAP = 0.45;
const probe = (p) =>
  Number(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', p]).stdout.toString());
function narrate(f) {
  const cfg = JSON.parse(readFileSync(resolve('scripts/marketing/narracao.json'), 'utf8'));
  const r = cfg.roteiros[f.file];
  const dir = join(src, 'narr', f.file.replace('.mp4', ''));
  mkdirSync(dir, { recursive: true });
  return r.falas.map((text, i) => {
    const path = join(dir, `${i}-${cfg.cenas[i]}.mp3`);
    const res = spawnSync('edge-tts', ['-v', cfg.voice, `--rate=${r.rate}`, '-t', text, '--write-media', path]);
    if (res.status !== 0) throw new Error(`edge-tts falhou na cena ${i}: ${res.stderr}`);
    return { path, dur: probe(path) };
  });
}

function build(f, png, voz) {
  const m = JSON.parse(readFileSync(join(src, `${f.source}.markers.json`), 'utf8'));
  const n = SEGMENTS.length;
  // tempo mínimo de tela que cada cena precisa para a fala caber inteira
  const intro = voz ? Math.max(INTRO, LEAD + voz[0].dur + GAP + XF) : INTRO;
  const outro = voz ? Math.max(OUTRO, XF + LEAD + voz[n + 1].dur + 0.8) : OUTRO;
  const inputs = ['-i', join(src, `${f.source}.webm`)];
  const still = (p, t) => inputs.push('-loop', '1', '-framerate', String(FPS), '-t', String(t), '-i', p);
  still(png.intro, intro); // 1
  still(png.outro, outro); // 2
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
    const base = (end - start) / speed;
    const need = voz ? (i === 0 ? XF : 0) + LEAD + voz[i + 1].dur + GAP + (i === n - 1 ? XF : 0) : 0;
    const hold = Math.max(0, need - base);
    const dur = base + hold;
    const freeze = hold > 0 ? `,tpad=stop_mode=clone:stop_duration=${hold.toFixed(3)}` : '';
    parts.push(`[0:v]trim=start=${start.toFixed(3)}:end=${end.toFixed(3)},setpts=(PTS-STARTPTS)/${speed}${freeze}[s${i}]`);
    labels.push(`[s${i}]`);
    windows.push([t, t + dur]);
    t += dur;
  });
  const contentDur = t;
  parts.push(`${labels.join('')}concat=n=${labels.length}:v=1:a=0[raw]`);

  // enquadramento por formato
  if (f.source === 'mobile') parts.push(`[raw]scale=${f.W}:${f.H}:flags=lanczos,${norm}[base]`);
  else if (f.framed) {
    const vw = f.W - 60;
    const vh = Math.round((vw * 9) / 16 / 2) * 2;
    parts.push(`[raw]scale=${vw}:${vh}:flags=lanczos[vid]`);
    parts.push(`[${frameIdx}:v]loop=-1:1,trim=duration=${contentDur.toFixed(3)},${norm}[fr]`);
    parts.push(`[fr][vid]overlay=30:${Math.round((f.H - vh) / 2)}:shortest=1,${norm}[base]`);
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
  parts.push(`[intro][content]xfade=transition=fade:duration=${XF}:offset=${(intro - XF).toFixed(3)}[x1]`);
  parts.push(`[x1][outro]xfade=transition=fade:duration=${XF}:offset=${(intro + contentDur - 2 * XF).toFixed(3)}[v]`);

  const total = intro + contentDur + outro - 2 * XF;
  const nIn = inputs.filter((x) => x === '-i').length;
  let audio = `${nIn}:a`;
  if (voz) {
    // início de cada fala na linha do tempo final: abertura, cenas do conteúdo, encerramento
    const at = [LEAD, ...windows.map(([a], i) => intro - XF + a + (i === 0 ? XF : 0) + LEAD), intro + contentDur - 2 * XF + XF + LEAD];
    voz.forEach((v, i) => {
      const ms = Math.round(at[i] * 1000);
      parts.push(`[${nIn + 1 + i}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${ms}|${ms}[a${i}]`);
    });
    const cfg = JSON.parse(readFileSync(resolve('scripts/marketing/narracao.json'), 'utf8'));
    const ends = [intro, ...windows.map(([, b]) => intro - XF + b), intro + contentDur - 2 * XF + outro];
    const starts = [0, ...windows.map(([a]) => intro - XF + a), intro + contentDur - 2 * XF];
    voz.forEach((v, i) => console.log(`  ${cfg.cenas[i].padEnd(12)} cena ${starts[i].toFixed(2)}-${ends[i].toFixed(2)}s  fala ${at[i].toFixed(2)}-${(at[i] + v.dur).toFixed(2)}s`));
    parts.push(`[${nIn}:a]${voz.map((_, i) => `[a${i}]`).join('')}amix=inputs=${voz.length + 1}:normalize=0:duration=first,loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[aout]`);
    audio = '[aout]';
  }
  const file = voz ? f.file.replace('.mp4', '-narrado.mp4') : f.file;
  const args = [
    '-y', '-v', 'error', ...inputs,
    '-f', 'lavfi', '-t', total.toFixed(3), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
    ...(voz ? voz.flatMap((v) => ['-i', v.path]) : []),
    '-filter_complex', parts.join(';'),
    '-map', '[v]', '-map', audio,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(FPS),
    '-c:a', 'aac', '-b:a', voz ? '160k' : '96k', '-shortest', '-movflags', '+faststart',
    join(out, file),
  ];
  const res = spawnSync('ffmpeg', args, { stdio: 'inherit' });
  if (res.status !== 0) throw new Error(`ffmpeg falhou em ${file}`);
  console.log(`${file}: ${total.toFixed(1)}s`);
}

const browser = await chromium.launch();
for (const f of FORMATS) build(f, await renderPngs(browser, f), NARRAR ? narrate(f) : null);
await browser.close();
