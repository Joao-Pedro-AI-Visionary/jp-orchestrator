import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { request as httpRequest, IncomingMessage } from 'node:http';
import { AppModule } from '../app.module';
import { sleep } from '../common/util';
import { configureHttp } from '../security/http-app';
import { SecurityConfig, securityConfig } from '../security/security.config';
import { SECURITY_CONFIG } from '../security/security.guards';
import { EventBus } from './event-bus';

const KEY = 'k'.repeat(40);

/** Opens a stream and resolves once the status line is in; `chunks` keeps the body. */
function open(url: string, path: string) {
  return new Promise<{ res: IncomingMessage; chunks: string[]; close: () => void }>((resolve, reject) => {
    const req = httpRequest(`${url}${path}`, { headers: { 'x-api-key': KEY, accept: 'text/event-stream' } }, (res) => {
      const chunks: string[] = [];
      res.setEncoding('utf8');
      res.on('data', (c: string) => chunks.push(c));
      res.on('error', () => undefined);
      resolve({ res, chunks, close: () => req.destroy() });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('HTTP: SSE scope and limits (M5), security headers (L9), health (L13)', () => {
  let app: INestApplication;
  let url: string;
  const saved = { ...process.env };

  beforeAll(async () => {
    delete process.env.DATABASE_URL;
    delete process.env.REDIS_URL;
    process.env.OUTBOX_RELAY = 'off';
    process.env.SSE_MAX_PER_CLIENT = '2';
    const cfg: SecurityConfig = { ...securityConfig({ API_KEY: KEY }), rateLimit: { max: 1000, windowMs: 60_000 } };
    const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(SECURITY_CONFIG).useValue(cfg).compile();
    app = mod.createNestApplication({ rawBody: true, logger: false });
    configureHttp(app, cfg);
    await app.listen(0, '127.0.0.1');
    url = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  });
  afterAll(async () => {
    await app.close();
    process.env = saved;
  });

  it('caps open streams per client with 429 and frees the slot when one closes', async () => {
    const a = await open(url, '/events');
    const b = await open(url, '/events');
    expect([a.res.statusCode, b.res.statusCode]).toEqual([200, 200]);
    const c = await open(url, '/events');
    expect(c.res.statusCode).toBe(429);
    c.close();
    a.close();
    await sleep(100);
    const d = await open(url, '/events');
    expect(d.res.statusCode).toBe(200);
    b.close();
    d.close();
    await sleep(50);
  });

  it('narrows the stream to one task with ?taskId= and validates it', async () => {
    const bad = await open(url, '/events?taskId=nope');
    expect(bad.res.statusCode).toBe(400);
    bad.close();
    const mine = '11111111-1111-4111-8111-111111111111';
    const s = await open(url, `/events?taskId=${mine}`);
    expect(s.res.statusCode).toBe(200);
    const bus = app.get(EventBus);
    bus.emit('task.status', '22222222-2222-4222-8222-222222222222', { status: 'running' });
    bus.emit('task.status', mine, { status: 'completed' });
    await sleep(100);
    const data = s.chunks.join('');
    expect(data).toContain(mine);
    expect(data).not.toContain('22222222-2222');
    s.close();
    await sleep(50);
  });

  it('sends security headers and no x-powered-by', async () => {
    const res = await fetch(`${url}/tasks`, { headers: { 'x-api-key': KEY } });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('x-powered-by')).toBeNull();
  });

  it('reports a dependency that is not configured as disabled, not down', async () => {
    const res = await fetch(`${url}/health`);
    expect(await res.json()).toMatchObject({ ok: true, postgres: 'disabled', redis: 'disabled', store: 'MemoryStore' });
  });

  it('answers 401 to an unsigned webhook (M2)', async () => {
    const res = await fetch(`${url}/webhooks/inbox`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"id":"x"}' });
    expect(res.status).toBe(401);
    const inbox = await fetch(`${url}/webhooks/inbox`, { headers: { 'x-api-key': KEY } });
    expect(await inbox.json()).toEqual([]);
  });
});
