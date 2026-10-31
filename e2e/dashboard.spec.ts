import { expect, Page, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

const API = process.env.API_URL ?? 'http://localhost:3001';
const SHOTS = 'docs/screenshots';

interface TaskDetail {
  task: { id: string; status: string; correctionRounds: number; spentUsd: number; budgetUsd: number };
  subtasks: { status: string }[];
  snapshots: { version: number; hash: string; parentHash: string | null }[];
  approval: { status: string } | null;
}

const api = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(`${API}${path}`, init);
  expect(res.ok, `${path} -> HTTP ${res.status}`).toBeTruthy();
  return res.json() as Promise<T>;
};

/** Id of the task currently selected in the panel, read from the most recent card. */
async function latestTaskId(title: string): Promise<string> {
  const tasks = await api<{ id: string; title: string }[]>('/tasks');
  const t = tasks.find((x) => x.title === title);
  expect(t, `tarefa "${title}" deve existir na API`).toBeTruthy();
  return t!.id;
}

async function submitTask(page: Page, title: string, description: string, opts: { approval?: boolean; budget?: string } = {}) {
  await page.getByTestId('task-title-input').fill(title);
  await page.getByTestId('task-desc-input').fill(description);
  await page.getByTestId('task-budget-input').fill(opts.budget ?? '0.05');
  const box = page.getByTestId('task-approval-checkbox');
  if ((await box.isChecked()) !== Boolean(opts.approval)) await box.click();
  await page.getByTestId('task-submit').click();
  await expect(page.getByTestId('panel-title')).toHaveText(title);
  return latestTaskId(title);
}

const panelStatus = (page: Page) => page.getByTestId('panel-status');
const stamp = () => Date.now().toString(36);
/** Random word: keeps prompts far from earlier runs so the semantic cache does not answer them. */
const w = () => Math.random().toString(36).slice(2, 9);

test.beforeAll(async () => {
  // restore every model in case a previous run left one down
  const models = await api<{ id: string; healthy: boolean }[]>('/gateway/models');
  for (const m of models.filter((x) => !x.healthy)) await api(`/gateway/models/${m.id}/toggle`, { method: 'POST' });
});

test('fluxo completo do dashboard: todos os botões executam ações reais', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('brand')).toContainText('JpDev');
  await expect(page.getByTestId('health-postgres')).toContainText(/ativo|ok|online/i);
  await expect(page.getByTestId('health-redis')).toContainText(/ativo|ok|online/i);
  await expect(page.getByTestId('live-indicator')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/01-dashboard.png`, fullPage: true });

  // CTA principal leva ao formulário
  await page.getByTestId('new-task-cta').click();
  await expect(page.getByTestId('task-title-input')).toBeFocused();

  // presets preenchem o formulário (Tesler)
  const titles = new Set<string>();
  for (const i of [0, 1, 2]) {
    await page.getByTestId(`preset-${i}`).click();
    const v = await page.getByTestId('task-title-input').inputValue();
    expect(v.length).toBeGreaterThan(3);
    titles.add(v);
  }
  expect(titles.size).toBe(3);

  // 1) loop real com subagentes em paralelo
  const t1 = `Endpoint ${w()} ${w()} ${w()}`;
  const desc1 = `Pesquisar o padrão de ${w()} ${w()}. Implementar o controller de ${w()} ${w()}. Implementar o repositório de ${w()} ${w()}. Escrever testes de ${w()} ${w()}`;
  const id1 = await submitTask(page, t1, desc1);
  await expect.poll(async () => page.locator('[data-testid="subagent-lane"][data-status="running"]').count(), {
    timeout: 30_000, intervals: [100],
  }).toBeGreaterThanOrEqual(2);
  await page.screenshot({ path: `${SHOTS}/02-subagentes-paralelo.png`, fullPage: true });
  await expect(panelStatus(page)).toHaveText(/Concluída/, { timeout: 90_000 });
  await expect(page.getByTestId('completion-banner')).toBeVisible();
  const d1 = await api<TaskDetail>(`/tasks/${id1}`);
  expect(d1.task.status).toBe('completed');
  expect(d1.subtasks.every((s) => s.status === 'done')).toBe(true);
  expect(d1.snapshots.length).toBeGreaterThanOrEqual(4);
  for (let i = 1; i < d1.snapshots.length; i++) expect(d1.snapshots[i].parentHash).toBe(d1.snapshots[i - 1].hash);
  await expect(page.getByTestId('snapshot-item')).toHaveCount(d1.snapshots.length);
  await expect(page.getByTestId('memory-item').first()).toBeVisible();
  await expect(page.getByTestId('usage-row').first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/03-tarefa-concluida.png`, fullPage: true });

  // webhook assinado chegou e foi verificado
  await expect.poll(async () => {
    const inbox = await api<{ event: string; verified: boolean; payload: { data?: { taskId?: string } } }[]>('/webhooks/inbox');
    return inbox.some((e) => e.event === 'task.completed' && e.verified && e.payload.data?.taskId === id1);
  }, { timeout: 15_000 }).toBe(true);
  await expect(page.getByTestId('webhook-item').first()).toBeVisible();
  await expect(page.getByTestId('webhook-badge').first()).toContainText(/válida/i);

  // 2) loop de correção (revisor reprova, coder corrige)
  const t2 = `Investigar bug no checkout ${stamp()}`;
  const id2 = await submitTask(page, t2, 'Implementar a correção do bug de arredondamento');
  await expect(panelStatus(page)).toHaveText(/Concluída/, { timeout: 90_000 });
  expect((await api<TaskDetail>(`/tasks/${id2}`)).task.correctionRounds).toBe(1);
  await expect(page.getByTestId('correction-rounds')).toContainText('1');

  // 3) aprovação humana: aprovar
  const t3 = `Refatorar módulo de billing ${stamp()}`;
  const id3 = await submitTask(page, t3, 'Implementar a extração do cálculo de custo', { approval: true });
  await expect(panelStatus(page)).toHaveText(/Aguardando aprovação/, { timeout: 90_000 });
  await page.screenshot({ path: `${SHOTS}/04-aprovacao-humana.png`, fullPage: true });
  await page.getByTestId('approval-note').fill('ok, pode integrar');
  await page.getByTestId('approve-btn').click();
  await expect(panelStatus(page)).toHaveText(/Concluída/, { timeout: 60_000 });
  expect((await api<TaskDetail>(`/tasks/${id3}`)).approval?.status).toBe('approved');

  // 4) aprovação humana: rejeitar
  const t4 = `Migrar fila de eventos ${stamp()}`;
  const id4 = await submitTask(page, t4, 'Implementar o consumidor novo', { approval: true });
  await expect(panelStatus(page)).toHaveText(/Aguardando aprovação/, { timeout: 90_000 });
  await page.getByTestId('reject-btn').click();
  await expect(panelStatus(page)).toHaveText(/Rejeitada/, { timeout: 30_000 });
  expect((await api<TaskDetail>(`/tasks/${id4}`)).task.status).toBe('rejected');

  // 5) corte automático por orçamento
  const t5 = `Tarefa com orçamento mínimo ${stamp()}`;
  const id5 = await submitTask(page, t5, 'Implementar tudo de uma vez', { budget: '0.0001' });
  await expect(panelStatus(page)).toHaveText(/Orçamento excedido/, { timeout: 60_000 });
  const d5 = await api<TaskDetail>(`/tasks/${id5}`);
  expect(d5.task.spentUsd).toBeLessThanOrEqual(d5.task.budgetUsd);

  // 6) gateway: derrubar todos os modelos, tarefa falha; restaurar e retomar do journal
  const models = await api<{ id: string }[]>('/gateway/models');
  for (const m of models) await page.getByTestId(`model-toggle-${m.id}`).click();
  await expect.poll(async () => (await api<{ healthy: boolean }[]>('/gateway/models')).every((m) => !m.healthy)).toBe(true);
  const t6 = `Gerar cliente da API ${stamp()}`;
  const id6 = await submitTask(page, t6, 'Implementar o cliente tipado');
  await expect(panelStatus(page)).toHaveText(/Falhou/, { timeout: 60_000 });
  await page.screenshot({ path: `${SHOTS}/05-gateway-modelos-fora.png`, fullPage: true });
  await page.getByTestId('model-toggle-mock-standard').click();
  await expect.poll(async () => (await api<{ id: string; healthy: boolean }[]>('/gateway/models')).find((m) => m.id === 'mock-standard')!.healthy).toBe(true);
  await page.getByTestId('resume-btn').click();
  await expect(panelStatus(page)).toHaveText(/Concluída/, { timeout: 90_000 });
  expect((await api<TaskDetail>(`/tasks/${id6}`)).task.status).toBe('completed');
  const stats = await api<{ fallbacks: number }>('/gateway/stats');
  expect(stats.fallbacks).toBeGreaterThan(0);
  await expect(page.getByTestId('gateway-flow-item').first()).toBeVisible();
  for (const m of models.filter((x) => x.id !== 'mock-standard')) await page.getByTestId(`model-toggle-${m.id}`).click();
  await expect.poll(async () => (await api<{ healthy: boolean }[]>('/gateway/models')).every((m) => m.healthy)).toBe(true);

  // 7) cache semântico: repetir uma tarefa idêntica gera acertos de cache
  const before = await api<{ totals: { cacheHits: number } }>('/billing/summary');
  await submitTask(page, t1, desc1);
  await expect(panelStatus(page)).toHaveText(/Concluída/, { timeout: 90_000 });
  const after = await api<{ totals: { cacheHits: number; savedUsd: number } }>('/billing/summary');
  expect(after.totals.cacheHits).toBeGreaterThan(before.totals.cacheHits);
  await expect(page.getByTestId('kpi-cache')).toHaveAttribute('data-value', String(after.totals.cacheHits), { timeout: 15_000 });

  // 8) filtros da lista
  await page.getByTestId('filter-done').click();
  await expect(page.locator('[data-testid="task-card"]:not([data-status="completed"])')).toHaveCount(0);
  expect(await page.getByTestId('task-card').count()).toBeGreaterThan(0);
  await page.getByTestId('filter-approval').click();
  await expect(page.locator('[data-testid="task-card"]:not([data-status="awaiting_approval"])')).toHaveCount(0);
  await page.getByTestId('filter-running').click();
  await expect(page.locator('[data-testid="task-card"][data-status="completed"]')).toHaveCount(0);
  await page.getByTestId('filter-all').click();
  expect(await page.getByTestId('task-card').count()).toBeGreaterThanOrEqual(7);

  // 9) selecionar outra tarefa pelo card
  await page.locator('[data-testid="task-card"]', { hasText: t4 }).click();
  await expect(page.getByTestId('panel-title')).toHaveText(t4);

  // 10) billing animado e exportação CSV
  await expect(page.getByTestId('bars-model-item').first()).toBeVisible();
  await expect(page.getByTestId('bars-agent-item').first()).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-csv').click()]);
  const csv = readFileSync((await download.path())!, 'utf8');
  expect(csv.split('\n')[0]).toContain('task_id,subtask_id,agent,model');
  expect(csv).toContain(id1);
  await page.getByTestId('billing-panel').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/06-billing-webhooks.png`, fullPage: true });

  // 11) fechar avisos
  const close = page.getByRole('button', { name: 'Fechar aviso' });
  const n = await close.count();
  for (let i = 0; i < n; i++) await close.first().click();
  await expect(close).toHaveCount(0);
});

test('botão "Tentar de novo" recupera a lista após falha de rede', async ({ page }) => {
  // Falha só a primeira leitura de /tasks no navegador; o clique em "Tentar de novo" volta à API real.
  let failed = 0;
  await page.route(`${API}/tasks`, (route) => {
    if (route.request().method() === 'GET' && failed === 0) {
      failed++;
      return route.abort('connectionrefused');
    }
    return route.continue();
  });
  await page.goto('/');
  const error = page.getByTestId('tasks-error');
  await expect(error).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/08-erro-tentar-de-novo.png` });
  await error.getByTestId('retry-button').click();
  await expect(error).toBeHidden();
  const total = (await api<unknown[]>('/tasks')).length;
  if (total > 0) await expect(page.getByTestId('task-card').first()).toBeVisible();
  else await expect(page.getByTestId('tasks-empty')).toBeVisible();
  expect(failed).toBe(1);
});

test('Idempotency-Key no POST /tasks devolve a mesma tarefa', async () => {
  const body = JSON.stringify({ title: `Idempotente ${stamp()}`, description: 'Implementar algo' });
  const headers = { 'content-type': 'application/json', 'Idempotency-Key': `e2e-${stamp()}` };
  const a = await fetch(`${API}/tasks`, { method: 'POST', headers, body });
  const b = await fetch(`${API}/tasks`, { method: 'POST', headers, body });
  expect(a.status).toBe(201);
  expect(b.status).toBe(200);
  expect(b.headers.get('idempotent-replay')).toBe('true');
  expect((await a.json()).id).toBe((await b.json()).id);
});

test('acessibilidade básica: landmarks, região aria-live e movimento reduzido', async ({ browser }) => {
  const ctx = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await page.goto(process.env.WEB_URL ?? 'http://localhost:3000');
  await expect(page.locator('main')).toHaveCount(1);
  await expect(page.locator('header').first()).toBeVisible();
  await expect(page.getByTestId('live-region')).toHaveAttribute('aria-live', /polite|assertive/);
  // regressão: colunas do grid sem min-w-0 alargavam a página no celular
  await expect(page.getByTestId('model-item').first()).toBeVisible();
  const { scroll, client } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(scroll, 'sem rolagem horizontal no celular').toBeLessThanOrEqual(client);
  await page.screenshot({ path: `${SHOTS}/07-mobile-reduced-motion.png`, fullPage: true });
  await ctx.close();
});
