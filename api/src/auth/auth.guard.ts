import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { atLeast, AuthConfig, hashKey, OPEN_PRINCIPAL, Principal, Role } from './auth.config';
import { PUBLIC_KEY, QUERY_KEY, ROLE_KEY } from './auth.decorators';

export interface AuthRequest {
  headers: Record<string, string | string[] | undefined>;
  query?: Record<string, unknown>;
  principal?: Principal;
}

export const AUTH_CONFIG = Symbol('AUTH_CONFIG');

const header = (req: AuthRequest, name: string): string | undefined => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

function cookie(req: AuthRequest, name: string): string | undefined {
  for (const part of (header(req, 'cookie') ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) {
      try { return decodeURIComponent(v.join('=')); } catch { return undefined; }
    }
  }
  return undefined;
}

/** The API key sent with the request: X-API-Key or Authorization: Bearer, plus query/cookie when allowed. */
export function presentedKey(req: AuthRequest, allowQuery: boolean): string | undefined {
  const bearer = header(req, 'authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  const key = header(req, 'x-api-key') ?? bearer;
  if (key || !allowQuery) return key?.trim() || undefined;
  const q = req.query?.api_key;
  return (typeof q === 'string' && q) || cookie(req, 'jp_api_key') || undefined;
}

/**
 * Global guard: resolves the API key to a principal (req.principal) and checks the route's
 * minimum role. 401 without a valid key, 403 when the role is too low. In open mode every
 * request is the 'anonymous' admin.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly config: AuthConfig) {}

  canActivate(ctx: ExecutionContext): boolean {
    const targets = [ctx.getHandler(), ctx.getClass()];
    const req = ctx.switchToHttp().getRequest<AuthRequest>();
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets)) return true;
    const required = this.reflector.getAllAndOverride<Role>(ROLE_KEY, targets) ?? 'viewer';
    req.principal = this.authenticate(req, !!this.reflector.getAllAndOverride<boolean>(QUERY_KEY, targets));
    if (!atLeast(req.principal.role, required)) {
      throw new ForbiddenException(`Requer o papel ${required} (atual: ${req.principal.role})`);
    }
    return true;
  }

  authenticate(req: AuthRequest, allowQuery: boolean): Principal {
    if (this.config.open) return OPEN_PRINCIPAL;
    const key = presentedKey(req, allowQuery);
    const principal = key ? this.config.keys.get(hashKey(key)) : undefined;
    if (!principal) throw new UnauthorizedException('API key ausente ou inválida');
    return principal;
  }
}
