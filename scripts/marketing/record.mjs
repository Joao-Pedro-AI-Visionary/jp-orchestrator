// Grava o produto rodando de verdade (docker compose up) para os vídeos de marketing.
// Uso: node scripts/marketing/record.mjs <desktop|mobile> <pasta-de-saida>
// Saída: <pasta>/<modo>.webm + <pasta>/<modo>.markers.json (segundos desde o início do vídeo).
import { chromium } from '@playwright/test';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const mode = process.argv[2] ?? 'desktop';
const out = process.argv[3] ?? 'reports/marketing';
const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const API = process.env.API_URL ?? 'http://localhost:3001';
// O screencast grava em pixels CSS: vídeo e viewport precisam ter o mesmo tamanho.
const VIEW = mode === 'mobile' ? { width: 720, height: 1280 } : { width: 1600, height: 900 };
const VIDEO = VIEW;
const w = () => Math.random().toString(36).slice(2, 7);

mkdirSync(out, { recursive: true });
const api = async (path, init) => {
  const res = await fetch(`${API}${path}`, init);
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
};
for (const m of (await api('/gateway/models')).filter((x) => !x.healthy)) {
  await api(`/gateway/models/${m.id}/toggle`, { method: 'POST' });
}

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: VIEW,
  isMobile: mode === 'mobile',
  hasTouch: mode === 'mobile',
  recordVideo: { dir: out, size: VIDEO },
});
const t0 = Date.now();
const markers = {};
const mark = (name) => (markers[name] = (Date.now() - t0) / 1000);
const page = await ctx.newPage();
const scrollTo = (testId) =>
  page.getByTestId(testId).evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'start' }));
const status = page.getByTestId('panel-status');

async function submit(title, desc, approval = false) {
  await page.getByTestId('task-title-input').pressSequentially(title, { delay: 35 });
  await page.getByTestId('task-desc-input').fill(desc);
  await page.getByTestId('task-budget-input').fill('0.05');
  const box = page.getByTestId('task-approval-checkbox');
  if ((await box.isChecked()) !== approval) await box.click();
  await page.getByTestId('task-submit').click();
}

await page.goto(WEB);
await page.getByTestId('kpi-cost').waitFor();
mark('dashboard');
await page.waitForTimeout(2500);

mark('create');
await page.getByTestId('new-task-cta').click();
await submit(
  `Endpoint de pedidos ${w()}`,
  `Pesquisar o padrão de pedidos ${w()}. Implementar o controller de pedidos ${w()}. Implementar o repositório ${w()}. Escrever testes de pedidos ${w()}`,
);
if (mode === 'mobile') await scrollTo('task-panel');
await page.locator('[data-testid="subagent-lane"][data-status="running"]').first().waitFor({ timeout: 30_000 });
mark('parallel');
await status.filter({ hasText: /Concluída/ }).waitFor({ timeout: 90_000 });
mark('done');
await page.waitForTimeout(1200);
await page.getByTestId('snapshot-item').first().evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
mark('timeline');
await page.waitForTimeout(2500);

await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
await page.waitForTimeout(600);
mark('approval');
await submit(`Refatorar billing ${w()}`, 'Implementar a extração do cálculo de custo', true);
if (mode === 'mobile') await scrollTo('task-panel');
await status.filter({ hasText: /Aguardando aprovação/ }).waitFor({ timeout: 90_000 });
await page.getByTestId('approve-btn').scrollIntoViewIfNeeded();
await page.waitForTimeout(900);
await page.getByTestId('approval-note').pressSequentially('ok, pode integrar', { delay: 35 });
await page.getByTestId('approve-btn').click();
await status.filter({ hasText: /Concluída/ }).waitFor({ timeout: 60_000 });
mark('approved');
await page.waitForTimeout(1200);

mark('gateway');
await scrollTo('gateway-panel');
await page.waitForTimeout(1000);
await page.getByTestId('model-toggle-mock-standard').click();
await page.waitForTimeout(1500);
await page.getByTestId('model-toggle-mock-standard').click();
await page.waitForTimeout(800);
mark('billing');
await scrollTo('billing-panel');
await page.waitForTimeout(2500);
mark('end');

const video = page.video();
await ctx.close();
await browser.close();
renameSync(await video.path(), join(out, `${mode}.webm`));
writeFileSync(join(out, `${mode}.markers.json`), JSON.stringify(markers, null, 2));
console.log(mode, markers);
