import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { envNumber } from '../common/util';
import { metrics } from '../observability/metrics';
import { RATE_LIMIT_KEY } from './auth.decorators';
import { AuthRequest } from './auth.guard';

/**
 * Fixed window counter per key, in memory (per replica: N replicas allow N times the limit).
 * Good enough to stop a runaway client; a shared limit needs Redis or the edge proxy.
 */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(readonly max: number, readonly windowMs: number) {}

  /** Counts one hit. retryAfterMs > 0 when the key is over the limit in the current window. */
  hit(key: string, now = Date.now()): { allowed: boolean; retryAfterMs: number } {
    if (this.windows.size > 10_000) this.prune(now);
    let w = this.windows.get(key);
    if (!w || now - w.start >= this.windowMs) {
      w = { start: now, count: 0 };
      this.windows.set(key, w);
    }
    w.count++;
    return w.count <= this.max ? { allowed: true, retryAfterMs: 0 } : { allowed: false, retryAfterMs: w.start + this.windowMs - now };
  }

  private prune(now: number) {
    for (const [k, w] of this.windows) if (now - w.start >= this.windowMs) this.windows.delete(k);
  }
}

interface RateRequest extends AuthRequest { ip?: string; socket?: { remoteAddress?: string } }
interface RateResponse { setHeader(name: string, value: string): void }

/** Applies RATE_LIMIT_MAX hits per RATE_LIMIT_WINDOW_MS to routes marked @RateLimited, keyed by principal and IP. */
@Injectable()
export class RateLimitGuard implements CanActivate {
  readonly limiter = new RateLimiter(envNumber('RATE_LIMIT_MAX', 60), envNumber('RATE_LIMIT_WINDOW_MS', 60_000));

  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    if (!this.reflector.getAllAndOverride<boolean>(RATE_LIMIT_KEY, [ctx.getHandler(), ctx.getClass()])) return true;
    const req = ctx.switchToHttp().getRequest<RateRequest>();
    const key = `${req.principal?.id ?? '-'}|${req.ip ?? req.socket?.remoteAddress ?? '-'}`;
    const { allowed, retryAfterMs } = this.limiter.hit(key);
    if (allowed) return true;
    metrics.inc('jpo_rate_limited_total');
    ctx.switchToHttp().getResponse<RateResponse>().setHeader('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
    throw new HttpException('Limite de requisições excedido, tente mais tarde', HttpStatus.TOO_MANY_REQUESTS);
  }
}
