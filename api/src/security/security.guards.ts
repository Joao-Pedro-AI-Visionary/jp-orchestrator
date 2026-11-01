import {
  CanActivate, ExecutionContext, HttpException, HttpStatus, Inject, Injectable, SetMetadata, UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { timingSafeEqual } from 'node:crypto';
import { sha256 } from '../common/util';
import { RateLimitRule, SecurityConfig } from './security.config';

export const SECURITY_CONFIG = Symbol('SECURITY_CONFIG');
const PUBLIC = 'jp:public';
const QUERY_KEY = 'jp:query-key';

/** Route without API key (health probe, HMAC-signed webhook receiver). */
export const Public = () => SetMetadata(PUBLIC, true);
/** Also accepts ?api_key= (EventSource cannot send headers). Use only on GET streams. */
export const AllowQueryApiKey = () => SetMetadata(QUERY_KEY, true);

interface ReqLike {
  method: string;
  path?: string;
  url?: string;
  ip?: string;
  socket?: { remoteAddress?: string };
  headers: Record<string, string | string[] | undefined>;
  query?: Record<string, unknown>;
}
interface ResLike { setHeader(name: string, value: string): void }

const header = (req: ReqLike, name: string) => {
  const v = req.headers[name];
  return typeof v === 'string' ? v : Array.isArray(v) ? v[0] : undefined;
};

/** Constant time comparison (hashing first so the lengths always match). */
export const safeEqual = (a: string, b: string) =>
  timingSafeEqual(Buffer.from(sha256(a), 'hex'), Buffer.from(sha256(b), 'hex'));

export function presentedKey(req: ReqLike, allowQuery: boolean): string | null {
  const direct = header(req, 'x-api-key');
  if (direct) return direct.trim();
  const auth = header(req, 'authorization');
  const bearer = auth?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (bearer) return bearer.trim();
  const q = req.query?.api_key;
  if (allowQuery && typeof q === 'string' && q) return q;
  return null;
}

/** Global guard: every route needs the API key, except the ones marked @Public(). */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, @Inject(SECURITY_CONFIG) private readonly cfg: SecurityConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, targets)) return true;
    const allowQuery = Boolean(this.reflector.getAllAndOverride<boolean>(QUERY_KEY, targets));
    const key = presentedKey(context.switchToHttp().getRequest<ReqLike>(), allowQuery);
    if (!key || !safeEqual(key, this.cfg.apiKey)) throw new UnauthorizedException('API key ausente ou inválida');
    return true;
  }
}

/**
 * Fixed window counter per client IP (in process). Runs before the API key guard,
 * so it also throttles key guessing. With several replicas each one counts alone;
 * put a shared limiter (gateway, Redis) in front for a global limit.
 */
export class FixedWindowLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly rule: RateLimitRule, private readonly maxKeys = 10_000) {}

  /** Returns 0 when allowed, otherwise the seconds until the window resets. */
  take(key: string, now = Date.now()): number {
    if (this.hits.size >= this.maxKeys) {
      for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
      // Still full: drop the oldest window so the map stays bounded.
      if (this.hits.size >= this.maxKeys) this.hits.delete(this.hits.keys().next().value!);
    }
    let entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + this.rule.windowMs };
      this.hits.set(key, entry);
    }
    if (entry.count >= this.rule.max) return Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    entry.count++;
    return 0;
  }
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly all: FixedWindowLimiter;
  private readonly createTask: FixedWindowLimiter;

  constructor(@Inject(SECURITY_CONFIG) cfg: SecurityConfig) {
    this.all = new FixedWindowLimiter(cfg.rateLimit);
    this.createTask = new FixedWindowLimiter(cfg.createTaskLimit);
  }

  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const req = http.getRequest<ReqLike>();
    const client = req.ip ?? req.socket?.remoteAddress ?? 'unknown';
    const path = (req.path ?? req.url ?? '').split('?')[0].replace(/\/+$/, '');
    let wait = this.all.take(client);
    if (!wait && req.method === 'POST' && path === '/tasks') wait = this.createTask.take(client);
    if (wait) {
      http.getResponse<ResLike>().setHeader('Retry-After', String(wait));
      throw new HttpException('Muitas requisições: tente novamente em instantes', HttpStatus.TOO_MANY_REQUESTS);
    }
    return true;
  }
}
