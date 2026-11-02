import { INestApplication } from '@nestjs/common';
const WRONG_FIXTURE = ['wrong', 'fixture', 'for', 'tests'].join('-');
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { AppModule } from './app.module';
import { STORE } from './common/tokens';
import { EventBus } from './events/event-bus';
import { sign } from './events/signer';
import { MemoryStore } from './persistence/memory.store';
import { Store } from './persistence/store.port';
import { configureApp } from './setup';

/** The real AppModule over HTTP (MemoryStore, mock provider): guards, pipes, parsers and CORS as in production. */
const KEYS = {
  viewer: 'viewer-fixture-for-tests',
  operator: 'operator-key-012345',
  approver: 'approver-key-012345',
  admin: 'admin-fixture-for-tests',
};
const BASE_ENV = {
  API_KEYS: `${KEYS.viewer}:viewer,${KEYS.operator}:operator,${KEYS.approver}:approver:ana,${KEYS.admin}:admin:root`,
  CORS_ORIGINS: 'http://localhost:3000',
  OUTBOX_RELAY: 'off',
  MOCK_LATENCY_MS: '0',
  RATE_LIMIT_MAX: '1000',
};

/** Loose view of the JSON bodies these tests read. */
interface Body {
  id: string; healthy: boolean; message: unknown; length: number;
  task: { status: string };
  approval: { status: string; note: string | null; decidedBy: string | null };
}
interface Reply { status: number; headers: Headers; json(): Promise<Body>; text(): Promise<string> }
const reply = (r: Response): Reply => ({ status: r.status, headers: r.headers, json: () => r.json() as Promise<Body>, text: () => r.text() });

async function boot(env: Record<string, string>, store?: Store) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  const builder = Test.createTestingModule({ imports: [AppModule] });
  if (store) builder.overrideProvider(STORE).useValue(store);
  const app = (await builder.compile()).createNestApplication<NestExpressApplication>({ rawBody: true, logger: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  process.env = saved;
  const url = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  const call = (path: string, opts: { key?: keyof typeof KEYS; method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Reply> =>
    fetch(`${url}${path}`, {
      method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
      headers: {
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(opts.key ? { 'x-api-key': KEYS[opts.key] } : {}),
        ...opts.headers,
      },
      body: opts.body === undefined ? undefined : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body),
    }).then(reply);
  return { app, url, call };
}

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v) || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
}

const task = (title = 'Endpoint de pedidos', extra: Record<string, unknown> = {}) =>
  ({ title, description: 'Implementar o controller', budgetUsd: 1, ...extra });

describe('HTTP API with API keys', () => {
  let ctx: Awaited<ReturnType<typeof boot>>;
  beforeAll(async () => { ctx = await boot(BASE_ENV); });
  afterAll(() => ctx.app.close());

  it('401 without a key, 403 below the route role, 2xx at or above it', async () => {
    const { call } = ctx;
    expect((await call('/tasks')).status).toBe(401);
    expect((await call('/tasks', { headers: { 'x-api-key': WRONG_FIXTURE } })).status).toBe(401);
    expect((await call('/tasks', { key: 'viewer' })).status).toBe(200);
    expect((await call('/tasks', { headers: { authorization: `Bearer ${KEYS.viewer}` } })).status).toBe(200);
    expect((await call('/billing/summary')).status).toBe(401);
    expect((await call('/billing/summary', { key: 'viewer' })).status).toBe(200);
    expect((await call('/webhooks/inbox')).status).toBe(401);
    expect((await call('/tasks', { key: 'viewer', body: task() })).status).toBe(403);
    expect((await call('/tasks', { key: 'operator', body: task() })).status).toBe(201);
    // gateway admin: only admin may take a model down
    expect((await call('/gateway/models/mock-pro/toggle', { key: 'approver', method: 'POST' })).status).toBe(403);
    const down = await call('/gateway/models/mock-pro/toggle', { key: 'admin', method: 'POST' });
    expect(down.status).toBe(201);
    expect((await down.json()).healthy).toBe(false);
    expect((await (await call('/gateway/models/mock-pro/toggle', { key: 'admin', method: 'POST' })).json()).healthy).toBe(true);
  });

  it('SSE and the CSV link accept the key as ?api_key= or cookie; other routes do not', async () => {
    const { call, url } = ctx;
    expect((await call('/events')).status).toBe(401);
    const ac = new AbortController();
    const sse = await fetch(`${url}/events?api_key=${KEYS.viewer}`, { signal: ac.signal });
    expect(sse.status).toBe(200);
    expect(sse.headers.get('content-type')).toMatch(/text\/event-stream/);
    ac.abort();
    const ac2 = new AbortController();
    const viaCookie = await fetch(`${url}/events`, { headers: { cookie: `jp_api_key=${KEYS.viewer}` }, signal: ac2.signal });
    expect(viaCookie.status).toBe(200);
    ac2.abort();
    expect((await fetch(`${url}/billing/report.csv?api_key=${KEYS.viewer}`)).status).toBe(200);
    expect((await fetch(`${url}/tasks?api_key=${KEYS.viewer}`)).status).toBe(401);
  });

  it('records the approver identity on the approval, in approval.resolved and in the terminal outbox event', async () => {
    const { call, app } = ctx;
    const created = await (await call('/tasks', { key: 'operator', body: task('Com aprovação', { requiresApproval: true }) })).json();
    const awaiting = await until(async () => (await (await call(`/tasks/${created.id}`, { key: 'viewer' })).json()).task.status, (s) => s === 'awaiting_approval');
    expect(awaiting).toBe('awaiting_approval');
    expect((await call(`/tasks/${created.id}/approve`, { key: 'operator', body: {} })).status).toBe(403);
    const approved = await call(`/tasks/${created.id}/approve`, { key: 'approver', body: { note: 'ok, pode integrar' } });
    expect(approved.status).toBe(200);
    const detail = await until(async () => (await call(`/tasks/${created.id}`, { key: 'viewer' })).json(), (d) => d.task.status === 'completed');
    expect(detail.approval).toMatchObject({ status: 'approved', note: 'ok, pode integrar', decidedBy: 'ana' });
    expect(app.get(EventBus).history.find((e) => e.type === 'approval.resolved' && e.taskId === created.id)?.payload)
      .toEqual({ status: 'approved', note: 'ok, pode integrar', decidedBy: 'ana' });
    const outbox = await app.get<Store>(STORE).listOutbox();
    expect(outbox.find((e) => e.type === 'task.completed' && e.payload.taskId === created.id)?.payload.decidedBy).toBe('ana');

    const rejected = await (await call('/tasks', { key: 'operator', body: task('Para rejeitar', { requiresApproval: true }) })).json();
    await until(async () => (await (await call(`/tasks/${rejected.id}`, { key: 'viewer' })).json()).task.status, (s) => s === 'awaiting_approval');
    expect((await call(`/tasks/${rejected.id}/reject`, { key: 'admin', body: {} })).status).toBe(200);
    expect((await (await call(`/tasks/${rejected.id}`, { key: 'viewer' })).json()).approval).toMatchObject({ status: 'rejected', decidedBy: 'root' });
    expect((await app.get<Store>(STORE).listOutbox()).find((e) => e.type === 'task.rejected' && e.payload.taskId === rejected.id)?.payload.decidedBy).toBe('root');
  });

  it('Idempotency-Key: same body replays (200), a different body is 422 and creates nothing', async () => {
    const { call } = ctx;
    const headers = { 'idempotency-key': `draft-${Date.now()}` };
    const a = await call('/tasks', { key: 'operator', headers, body: task('Idempotente', { budgetUsd: 0.05 }) });
    expect(a.status).toBe(201);
    // the same request in another spelling ("0,05") is the same request
    const b = await call('/tasks', { key: 'operator', headers, body: task('  Idempotente ', { budgetUsd: '0,05' }) });
    expect(b.status).toBe(200);
    expect(b.headers.get('idempotent-replay')).toBe('true');
    const before = (await (await call('/tasks', { key: 'viewer' })).json()).length;
    const c = await call('/tasks', { key: 'operator', headers, body: task('Outro corpo', { budgetUsd: 0.05 }) });
    expect(c.status).toBe(422);
    expect((await c.json()).message).toMatch(/Idempotency-Key/);
    expect((await (await call('/tasks', { key: 'viewer' })).json()).length).toBe(before);
    expect((await (await call('/tasks', { key: 'operator', headers: { 'idempotency-key': 'x'.repeat(201) }, body: task() })).status)).toBe(400);
  });

  it('validates field types, the note length and the body size', async () => {
    const { call } = ctx;
    const bad = async (body: unknown) => {
      const r = await call('/tasks', { key: 'operator', body });
      return { status: r.status, message: (await r.json()).message };
    };
    expect(await bad({ title: 123, description: 'x' })).toMatchObject({ status: 400, message: expect.arrayContaining(['title deve ser texto']) });
    expect(await bad({ ...task(), budgetUsd: true })).toMatchObject({ status: 400 });
    expect(await bad({ ...task(), budgetUsd: '1e3' })).toMatchObject({ status: 400 });
    expect(await bad({ ...task(), requiresApproval: 'sim' })).toMatchObject({ status: 400, message: ['requiresApproval deve ser booleano'] });
    expect(await bad([task()])).toMatchObject({ status: 400 });
    const created = await (await call('/tasks', { key: 'operator', body: task('Nota longa', { requiresApproval: true }) })).json();
    await until(async () => (await (await call(`/tasks/${created.id}`, { key: 'viewer' })).json()).task.status, (s) => s === 'awaiting_approval');
    expect((await call(`/tasks/${created.id}/approve`, { key: 'approver', body: { note: 'x'.repeat(2001) } })).status).toBe(400);
    expect((await call(`/tasks/${created.id}/approve`, { key: 'approver', body: { note: 42 } })).status).toBe(400);
    expect((await (await call(`/tasks/${created.id}`, { key: 'viewer' })).json()).approval.status).toBe('pending');
    const huge = await call('/tasks', { key: 'operator', body: { ...task(), description: 'x'.repeat(70 * 1024) } });
    expect(huge.status).toBe(413);
  });

  it('webhook receiver: unsigned requests get 401 and are not stored; signed ones are', async () => {
    const { call, app } = ctx;
    const store = app.get<Store>(STORE);
    const before = (await store.listInbox(500)).length;
    const body = JSON.stringify({ id: 'ev-1', type: 'task.completed', data: {} });
    const unsigned = await call('/webhooks/inbox', { body, headers: { 'x-jp-event-id': 'ev-1' } });
    expect(unsigned.status).toBe(401);
    const forged = await call('/webhooks/inbox', { body, headers: { 'x-jp-signature': sign('guess', body), 'x-jp-event-id': 'ev-1' } });
    expect(forged.status).toBe(401);
    expect((await store.listInbox(500)).length).toBe(before);
    const signed = await call('/webhooks/inbox', { body, headers: { 'x-jp-signature': sign('dev-secret-change-me', body), 'x-jp-event-id': 'ev-1' } });
    expect(signed.status).toBe(200);
    expect(await signed.json()).toEqual({ received: true, verified: true, duplicate: false });
    expect((await store.listInbox(500)).length).toBe(before + 1);
  });

  it('CORS answers only for CORS_ORIGINS', async () => {
    const { url } = ctx;
    const ok = await fetch(`${url}/health`, { headers: { origin: 'http://localhost:3000' } });
    expect(ok.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
    const evil = await fetch(`${url}/health`, { headers: { origin: 'https://evil.example' } });
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('health and readiness are public; /metrics needs a key and exposes tasks, gateway, tools and outbox', async () => {
    const { call } = ctx;
    expect(await (await call('/health')).json()).toMatchObject({ ok: true, services: { postgres: 'memory', redis: 'memory' } });
    const ready = await call('/health/ready');
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ ready: true, services: { postgres: 'memory', redis: 'memory' } });
    expect((await call('/metrics')).status).toBe(401);
    const created = await (await call('/tasks', { key: 'operator', body: task('Para métricas') })).json();
    await until(async () => (await (await call(`/tasks/${created.id}`, { key: 'viewer' })).json()).task.status, (s) => s === 'completed');
    const res = await call('/metrics', { key: 'viewer' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/plain/);
    const text = await res.text();
    expect(text).toMatch(/^jpo_tasks\{status="completed"\} [1-9]\d*$/m);
    expect(text).toMatch(/^jpo_tasks\{status="awaiting_approval"\} \d+$/m);
    expect(text).toMatch(/^jpo_gateway_requests_total [1-9]\d*$/m);
    expect(text).toMatch(/^jpo_gateway_call_duration_seconds_count\{cached="false",model="[\w-]+"\} [1-9]\d*$/m);
    expect(text).toMatch(/^jpo_tool_calls_total\{outcome="executed",tool="[\w.-]+"\} [1-9]\d*$/m);
    expect(text).toMatch(/^jpo_outbox_dead 0$/m);
    expect(text).toMatch(/^jpo_outbox_events\{status="pending"\} [1-9]\d*$/m);
    expect(text).toMatch(/^jpo_http_requests_total\{method="POST",route="\/tasks",status="201"\} [1-9]\d*$/m);
  });
});

describe('HTTP API: rate limit, readiness 503 and open mode', () => {
  let apps: INestApplication[] = [];
  afterEach(async () => { await Promise.all(apps.map((a) => a.close())); apps = []; });

  it('mutating endpoints answer 429 with Retry-After past RATE_LIMIT_MAX; reads are not limited', async () => {
    const { app, call } = await boot({ ...BASE_ENV, RATE_LIMIT_MAX: '3', RATE_LIMIT_WINDOW_MS: '60000' });
    apps.push(app);
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await call('/tasks', { key: 'operator', body: { title: 1 } })).status);
    expect(statuses).toEqual([400, 400, 400, 429]);
    const limited = await call('/tasks', { key: 'operator', body: task() });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    // per principal: another key still has its budget, and reads never count
    expect((await call('/tasks', { key: 'admin', body: { title: 1 } })).status).toBe(400);
    for (let i = 0; i < 5; i++) expect((await call('/tasks', { key: 'operator' })).status).toBe(200);
  });

  it('/health/ready answers 503 when the configured Postgres is down; /health stays 200', async () => {
    const down = Object.assign(new MemoryStore(), { kind: 'postgres', ping: async () => false }) as unknown as Store;
    const { app, call } = await boot(BASE_ENV, down);
    apps.push(app);
    const ready = await call('/health/ready');
    expect(ready.status).toBe(503);
    expect(await ready.json()).toEqual({ ready: false, services: { postgres: 'down', redis: 'memory' } });
    expect((await call('/health')).status).toBe(200);
  });

  it('open mode (no API_KEYS, not production): no key needed, decisions recorded as anonymous', async () => {
    const { app, call } = await boot({ ...BASE_ENV, API_KEYS: '' });
    apps.push(app);
    const created = await call('/tasks', { body: task('Aberto', { requiresApproval: true }) });
    expect(created.status).toBe(201);
    const { id } = await created.json();
    await until(async () => (await (await call(`/tasks/${id}`)).json()).task.status, (s) => s === 'awaiting_approval');
    expect((await call(`/tasks/${id}/approve`, { body: {} })).status).toBe(200);
    expect((await (await call(`/tasks/${id}`)).json()).approval.decidedBy).toBe('anonymous');
  });
});
