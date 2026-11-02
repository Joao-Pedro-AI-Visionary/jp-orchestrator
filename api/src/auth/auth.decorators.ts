import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import { OPEN_PRINCIPAL, Principal, Role } from './auth.config';

export const ROLE_KEY = 'jp:role';
export const PUBLIC_KEY = 'jp:public';
export const QUERY_KEY = 'jp:key-in-query';
export const RATE_LIMIT_KEY = 'jp:rate-limited';

/** Minimum role for the route. Routes without it require 'viewer' (secure by default). */
export const RequireRole = (role: Role) => SetMetadata(ROLE_KEY, role);
/** No API key needed (liveness, readiness, the HMAC verified webhook receiver). */
export const Public = () => SetMetadata(PUBLIC_KEY, true);
/**
 * Also accepts the key as ?api_key= or the jp_api_key cookie, for clients that cannot send
 * headers (EventSource, a download link). Query strings end up in proxy logs: prefer the cookie.
 */
export const KeyInQuery = () => SetMetadata(QUERY_KEY, true);
/** Counts against the per-principal rate limit (mutating endpoints). */
export const RateLimited = () => SetMetadata(RATE_LIMIT_KEY, true);

/** The authenticated principal set by ApiKeyGuard (the 'anonymous' admin in open mode). */
export const CurrentPrincipal = createParamDecorator((_: unknown, ctx: ExecutionContext): Principal =>
  ctx.switchToHttp().getRequest<{ principal?: Principal }>().principal ?? OPEN_PRINCIPAL);
