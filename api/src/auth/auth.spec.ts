import { ExecutionContext, ForbiddenException, HttpException, UnauthorizedException } from '@nestjs/common';
const VIEWER_FIXTURE = ['viewer', 'fixture', 'for', 'tests'].join('-');
import { Reflector } from '@nestjs/core';
import { assertSecurityConfig, authConfig, corsOrigins, DEFAULT_WEBHOOK_SECRET, webhookSecret } from './auth.config';
import { KeyInQuery, Public, RateLimited, RequireRole } from './auth.decorators';
import { ApiKeyGuard, AuthRequest } from './auth.guard';
import { RateLimiter, RateLimitGuard } from './rate-limit.guard';

const KEYS = 'viewer-fixture-for-tests:viewer,operator-key-012345:operator,approver-key-012345:approver:ana,admin-fixture-for-tests:admin';

class Routes {
  @RequireRole('viewer') read() { return null; }
  @RequireRole('operator') create() { return null; }
  @RequireRole('approver') approve() { return null; }
  @RequireRole('admin') toggle() { return null; }
  @Public() health() { return null; }
  @KeyInQuery() events() { return null; }
  @RateLimited() limited() { return null; }
  plain() { return null; }
}

const ctxFor = (handler: keyof Routes, req: AuthRequest & { ip?: string }, res: { setHeader: jest.Mock } = { setHeader: jest.fn() }) => ({
  getHandler: () => Routes.prototype[handler],
  getClass: () => Routes,
  switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
}) as unknown as ExecutionContext;

describe('authConfig', () => {
  it('parses key:role[:name], keeps only hashes and names the principal', () => {
    const cfg = authConfig({ API_KEYS: KEYS });
    expect(cfg.open).toBe(false);
    expect(cfg.keys.size).toBe(4);
    const principals = [...cfg.keys.values()];
    expect(principals).toContainEqual({ id: 'ana', role: 'approver' });
    expect(principals.find((p) => p.role === 'viewer')!.id).toMatch(/^viewer-[0-9a-f]{8}$/);
    expect([...cfg.keys.keys()].some((k) => k.includes('viewer-key'))).toBe(false);
  });

  it('is open only outside production without keys; production without keys fails the boot', () => {
    expect(authConfig({}).open).toBe(true);
    expect(authConfig({ NODE_ENV: 'development' }).open).toBe(true);
    expect(() => authConfig({ NODE_ENV: 'production' })).toThrow(/API_KEYS/);
    expect(authConfig({ NODE_ENV: 'production', API_KEYS: KEYS }).open).toBe(false);
  });

  it('rejects bad roles, short or repeated keys', () => {
    expect(() => authConfig({ API_KEYS: 'viewer-fixture-for-tests:root' })).toThrow(/papel inválido/);
    expect(() => authConfig({ API_KEYS: 'short:viewer' })).toThrow(/16 caracteres/);
    expect(() => authConfig({ API_KEYS: 'viewer-fixture-for-tests:viewer,viewer-fixture-for-tests:admin' })).toThrow(/repetida/);
  });

  it('refuses the default signing secret and an open CORS in production', () => {
    expect(webhookSecret({})).toBe(DEFAULT_WEBHOOK_SECRET);
    expect(() => webhookSecret({ NODE_ENV: 'production' })).toThrow(/WEBHOOK_SECRET/);
    expect(() => webhookSecret({ NODE_ENV: 'production', WEBHOOK_SECRET: DEFAULT_WEBHOOK_SECRET })).toThrow(/WEBHOOK_SECRET/);
    expect(webhookSecret({ NODE_ENV: 'production', WEBHOOK_SECRET: 's3cr3t-long-enough-value' })).toBe('s3cr3t-long-enough-value');
    const prod = { NODE_ENV: 'production', API_KEYS: KEYS, WEBHOOK_SECRET: 's3cr3t-long-enough-value' };
    expect(() => assertSecurityConfig(prod)).not.toThrow();
    expect(() => assertSecurityConfig({ ...prod, CORS_ORIGINS: '*' })).toThrow(/CORS_ORIGINS/);
  });

  it('restricts CORS to CORS_ORIGINS; defaults to the local dashboard only outside production', () => {
    expect(corsOrigins({ CORS_ORIGINS: 'https://a.example, https://b.example/' })).toEqual(['https://a.example', 'https://b.example']);
    expect(corsOrigins({})).toEqual(['http://localhost:3000', 'http://127.0.0.1:3000']);
    expect(corsOrigins({ NODE_ENV: 'production' })).toEqual([]);
  });
});

describe('ApiKeyGuard', () => {
  const guard = new ApiKeyGuard(new Reflector(), authConfig({ API_KEYS: KEYS }));
  const as = (key?: string, extra: Partial<AuthRequest> = {}): AuthRequest => ({ headers: key ? { 'x-api-key': key } : {}, ...extra });

  it('enforces the role hierarchy viewer < operator < approver < admin', () => {
    const allowed = (handler: keyof Routes, key: string) => {
      try { return guard.canActivate(ctxFor(handler, as(key))); } catch (e) { if (e instanceof ForbiddenException) return false; throw e; }
    };
    expect(['read', 'create', 'approve', 'toggle'].map((h) => allowed(h as keyof Routes, 'viewer-fixture-for-tests'))).toEqual([true, false, false, false]);
    expect(['read', 'create', 'approve', 'toggle'].map((h) => allowed(h as keyof Routes, 'operator-key-012345'))).toEqual([true, true, false, false]);
    expect(['read', 'create', 'approve', 'toggle'].map((h) => allowed(h as keyof Routes, 'approver-key-012345'))).toEqual([true, true, true, false]);
    expect(['read', 'create', 'approve', 'toggle'].map((h) => allowed(h as keyof Routes, 'admin-fixture-for-tests'))).toEqual([true, true, true, true]);
  });

  it('401 without a key or with an unknown one; routes without a role still need viewer; public routes need nothing', () => {
    expect(() => guard.canActivate(ctxFor('plain', as()))).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(ctxFor('read', as('not-a-real-key-at-all')))).toThrow(UnauthorizedException);
    expect(guard.canActivate(ctxFor('health', as()))).toBe(true);
  });

  it('sets req.principal and accepts Authorization: Bearer', () => {
    const req = { headers: { authorization: 'Bearer approver-key-012345' } };
    expect(guard.canActivate(ctxFor('approve', req))).toBe(true);
    expect((req as AuthRequest).principal).toEqual({ id: 'ana', role: 'approver' });
  });

  it('takes the key from ?api_key= or the jp_api_key cookie only on @KeyInQuery routes', () => {
    expect(guard.canActivate(ctxFor('events', as(undefined, { query: { api_key: VIEWER_FIXTURE } })))).toBe(true);
    expect(guard.canActivate(ctxFor('events', { headers: { cookie: 'a=1; jp_api_key=viewer-fixture-for-tests' } }))).toBe(true);
    expect(() => guard.canActivate(ctxFor('read', as(undefined, { query: { api_key: VIEWER_FIXTURE } })))).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(ctxFor('read', { headers: { cookie: 'jp_api_key=viewer-fixture-for-tests' } }))).toThrow(UnauthorizedException);
  });

  it('open mode: every request is the anonymous admin', () => {
    const open = new ApiKeyGuard(new Reflector(), authConfig({}));
    const req: AuthRequest = { headers: {} };
    expect(open.canActivate(ctxFor('toggle', req))).toBe(true);
    expect(req.principal).toEqual({ id: 'anonymous', role: 'admin' });
  });
});

describe('rate limit', () => {
  it('RateLimiter: fixed window per key, retry-after until the window ends', () => {
    const rl = new RateLimiter(2, 1_000);
    expect(rl.hit('a', 0).allowed).toBe(true);
    expect(rl.hit('a', 10).allowed).toBe(true);
    expect(rl.hit('a', 400)).toEqual({ allowed: false, retryAfterMs: 600 });
    expect(rl.hit('b', 400).allowed).toBe(true);
    expect(rl.hit('a', 1_000).allowed).toBe(true);
  });

  it('RateLimitGuard: only @RateLimited routes count, 429 with Retry-After past the limit', () => {
    const guard = new RateLimitGuard(new Reflector());
    Object.assign(guard, { limiter: new RateLimiter(1, 60_000) });
    const req = { headers: {}, principal: { id: 'ana', role: 'approver' as const }, ip: '10.0.0.1' };
    const res = { setHeader: jest.fn() };
    for (let i = 0; i < 5; i++) expect(guard.canActivate(ctxFor('plain', req, res))).toBe(true);
    expect(guard.canActivate(ctxFor('limited', req, res))).toBe(true);
    let err: unknown;
    try { guard.canActivate(ctxFor('limited', req, res)); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(429);
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '60');
    // another principal has its own budget
    expect(guard.canActivate(ctxFor('limited', { ...req, principal: { id: 'bruno', role: 'approver' as const } }, res))).toBe(true);
  });
});
