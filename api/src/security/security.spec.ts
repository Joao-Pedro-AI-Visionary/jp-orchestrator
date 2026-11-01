import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../app.module';
import { OutboxRelay } from '../events/outbox-relay.service';
import { configureHttp } from './http-app';
import {
  assertSecurityConfig, DEFAULT_WEBHOOK_SECRET, SecurityConfig, securityConfig, webhookSecret,
} from './security.config';
import { FixedWindowLimiter, SECURITY_CONFIG } from './security.guards';

const KEY = 'k'.repeat(40);
const STRONG = 's'.repeat(40);
const ALLOWED = 'http://localhost:3000';

/** Full AppModule (in-memory adapters) behind a real HTTP listener. */
async function boot(overrides: Partial<SecurityConfig> = {}) {
  const cfg: SecurityConfig = {
    ...securityConfig({ API_KEY: KEY, CORS_ORIGIN: ALLOWED }),
    rateLimit: { max: 1000, windowMs: 60_000 },
    createTaskLimit: { max: 2, windowMs: 60_000 },
    ...overrides,
  };
  const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(SECURITY_CONFIG).useValue(cfg).compile();
  const app = mod.createNestApplication({ rawBody: true, logger: false });
  configureHttp(app, cfg);
  await app.listen(0, '127.0.0.1');
  const url = await app.getUrl();
  return { app, url: url.replace('[::1]', '127.0.0.1') };
}

describe('HTTP access control (C1)', () => {
  let app: INestApplication;
  let url: string;
  const saved = { db: process.env.DATABASE_URL, redis: process.env.REDIS_URL, relay: process.env.OUTBOX_RELAY };

  beforeAll(async () => {
    delete process.env.DATABASE_URL;
    delete process.env.REDIS_URL;
    process.env.OUTBOX_RELAY = 'off';
    ({ app, url } = await boot());
  });
  afterAll(async () => {
    await app.close();
    if (saved.relay === undefined) delete process.env.OUTBOX_RELAY;
    else process.env.OUTBOX_RELAY = saved.relay;
    if (saved.db) process.env.DATABASE_URL = saved.db;
    if (saved.redis) process.env.REDIS_URL = saved.redis;
  });

  it('rejects requests without a valid API key and accepts x-api-key or Bearer', async () => {
    expect((await fetch(`${url}/tasks`)).status).toBe(401);
    expect((await fetch(`${url}/tasks`, { headers: { 'x-api-key': 'wrong' } })).status).toBe(401);
    expect((await fetch(`${url}/gateway/models/mock-mini/toggle`, { method: 'POST' })).status).toBe(401);
    expect((await fetch(`${url}/billing/report.csv`)).status).toBe(401);
    expect((await fetch(`${url}/webhooks/inbox`)).status).toBe(401);
    expect((await fetch(`${url}/tasks`, { headers: { 'x-api-key': KEY } })).status).toBe(200);
    expect((await fetch(`${url}/tasks`, { headers: { authorization: `Bearer ${KEY}` } })).status).toBe(200);
  });

  it('keeps the health probe public', async () => {
    expect((await fetch(`${url}/health`)).status).toBe(200);
  });

  it('accepts ?api_key= only on the SSE stream', async () => {
    expect((await fetch(`${url}/tasks?api_key=${KEY}`)).status).toBe(401);
    expect((await fetch(`${url}/events`)).status).toBe(401);
    const ctrl = new AbortController();
    const sse = await fetch(`${url}/events?api_key=${KEY}`, { signal: ctrl.signal });
    expect(sse.status).toBe(200);
    expect(sse.headers.get('content-type')).toContain('text/event-stream');
    ctrl.abort();
  });

  it('answers CORS only for allowlisted origins', async () => {
    const preflight = (origin: string) => fetch(`${url}/tasks/x/approve`, {
      method: 'OPTIONS',
      headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-api-key' },
    });
    const ok = await preflight(ALLOWED);
    expect(ok.headers.get('access-control-allow-origin')).toBe(ALLOWED);
    expect(ok.headers.get('access-control-allow-headers')).toContain('x-api-key');
    const evil = await preflight('https://evil.example');
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('rate limits POST /tasks with 429 and Retry-After', async () => {
    const post = () => fetch(`${url}/tasks`, { method: 'POST', headers: { 'x-api-key': KEY, 'content-type': 'application/json' }, body: '{}' });
    expect((await post()).status).toBe(400);
    expect((await post()).status).toBe(400);
    const limited = await post();
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    // Other routes have their own (larger) bucket.
    expect((await fetch(`${url}/tasks`, { headers: { 'x-api-key': KEY } })).status).toBe(200);
  });

  it('rate limits every route, before the key check', async () => {
    const small = await boot({ rateLimit: { max: 3, windowMs: 60_000 } });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 4; i++) codes.push((await fetch(`${small.url}/tasks`, { headers: { 'x-api-key': 'guess' } })).status);
      expect(codes).toEqual([401, 401, 401, 429]);
    } finally {
      await small.app.close();
    }
  });
});

describe('FixedWindowLimiter', () => {
  it('allows max hits per window and resets after it', () => {
    const l = new FixedWindowLimiter({ max: 2, windowMs: 1000 });
    expect([l.take('a', 0), l.take('a', 10), l.take('a', 20)]).toEqual([0, 0, 1]);
    expect(l.take('b', 20)).toBe(0);
    expect(l.take('a', 1000)).toBe(0);
  });

  it('stays bounded when every window is still open', () => {
    const l = new FixedWindowLimiter({ max: 1, windowMs: 60_000 }, 2);
    l.take('a', 0); l.take('b', 0); l.take('c', 0);
    expect((l as unknown as { hits: Map<string, unknown> }).hits.size).toBe(2);
  });
});

describe('securityConfig', () => {
  it('requires an API key of at least 32 chars', () => {
    expect(() => securityConfig({})).toThrow(/API_KEY/);
    expect(() => securityConfig({ API_KEY: 'short' })).toThrow(/API_KEY/);
  });

  it('binds to 127.0.0.1 unless HOST is set (the Docker image sets 0.0.0.0)', () => {
    expect(securityConfig({ API_KEY: KEY }).host).toBe('127.0.0.1');
    expect(securityConfig({ API_KEY: KEY, HOST: '0.0.0.0' }).host).toBe('0.0.0.0');
  });

  it('uses a closed CORS allowlist: required in production, never "*"', () => {
    expect(securityConfig({ API_KEY: KEY }).corsOrigins).toEqual(['http://localhost:3000', 'http://127.0.0.1:3000']);
    expect(securityConfig({ API_KEY: KEY, CORS_ORIGIN: 'https://a.example, https://b.example' }).corsOrigins)
      .toEqual(['https://a.example', 'https://b.example']);
    expect(() => securityConfig({ API_KEY: KEY, NODE_ENV: 'production' })).toThrow(/CORS_ORIGIN/);
    expect(() => securityConfig({ API_KEY: KEY, CORS_ORIGIN: '*' })).toThrow(/CORS_ORIGIN/);
  });
});

describe('webhook HMAC secret (H5)', () => {
  const prod = { NODE_ENV: 'production', API_KEY: KEY, CORS_ORIGIN: ALLOWED };

  it('stops the boot in production with a missing, default or short secret', () => {
    expect(() => assertSecurityConfig(prod)).toThrow(/WEBHOOK_SECRET/);
    expect(() => assertSecurityConfig({ ...prod, WEBHOOK_SECRET: DEFAULT_WEBHOOK_SECRET })).toThrow(/WEBHOOK_SECRET/);
    expect(() => assertSecurityConfig({ ...prod, WEBHOOK_SECRET: 'x'.repeat(31) })).toThrow(/WEBHOOK_SECRET/);
    expect(() => assertSecurityConfig({ ...prod, WEBHOOK_SECRET: STRONG })).not.toThrow();
    expect(webhookSecret({ ...prod, WEBHOOK_SECRET: STRONG })).toBe(STRONG);
  });

  it('never signs with the public default outside production either', () => {
    const dev = webhookSecret({ WEBHOOK_SECRET: DEFAULT_WEBHOOK_SECRET });
    expect(dev).not.toBe(DEFAULT_WEBHOOK_SECRET);
    expect(dev).toHaveLength(64);
    expect(webhookSecret({})).toBe(dev);
  });

  it('tests run with a non-default secret', () => {
    const relay = new OutboxRelay({} as never, {} as never, async () => ({ status: 200 }));
    expect(relay.secret).toBe(process.env.WEBHOOK_SECRET);
    expect(relay.secret).not.toBe(DEFAULT_WEBHOOK_SECRET);
    expect(relay.secret.length).toBeGreaterThanOrEqual(32);
  });
});
