import { randomBytes } from 'node:crypto';
import { Logger } from '@nestjs/common';

/** Old fallback published in the repository. Never accepted as a real secret. */
export const DEFAULT_WEBHOOK_SECRET = 'dev-secret-change-me';
export const MIN_SECRET_LENGTH = 32;
const DEV_ORIGINS = ['http://localhost:3000', 'http://127.0.0.1:3000'];

type Env = Record<string, string | undefined>;

export interface RateLimitRule { max: number; windowMs: number }

export interface SecurityConfig {
  apiKey: string;
  host: string;
  corsOrigins: string[];
  rateLimit: RateLimitRule;
  /** Tighter bucket for POST /tasks (every task spends model budget). */
  createTaskLimit: RateLimitRule;
}

const isProduction = (env: Env) => env.NODE_ENV === 'production';
const list = (raw: string | undefined) => (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);

/**
 * Reads and validates the access settings. Fails fast (the API does not boot):
 * - API_KEY missing or shorter than 32 chars, in any environment;
 * - CORS_ORIGIN empty or "*" in production.
 * HOST defaults to 127.0.0.1; the Docker image sets HOST=0.0.0.0.
 */
export function securityConfig(env: Env = process.env): SecurityConfig {
  const apiKey = env.API_KEY?.trim() ?? '';
  if (apiKey.length < MIN_SECRET_LENGTH) {
    throw new Error(`API_KEY ausente ou com menos de ${MIN_SECRET_LENGTH} caracteres: gere uma com "openssl rand -hex 32"`);
  }
  const corsOrigins = list(env.CORS_ORIGIN);
  if (corsOrigins.includes('*')) throw new Error('CORS_ORIGIN não aceita "*": liste as origens permitidas');
  if (!corsOrigins.length && isProduction(env)) throw new Error('CORS_ORIGIN é obrigatório em produção');
  const num = (name: string, fallback: number) => {
    const raw = env[name];
    const n = raw === undefined ? NaN : Number(raw);
    return Number.isInteger(n) && n > 0 ? n : fallback;
  };
  return {
    apiKey,
    host: env.HOST?.trim() || '127.0.0.1',
    corsOrigins: corsOrigins.length ? corsOrigins : DEV_ORIGINS,
    // The dashboard refreshes up to 5 slices every 200ms during a live run (~25 req/s).
    rateLimit: { max: num('RATE_LIMIT_MAX', 1800), windowMs: num('RATE_LIMIT_WINDOW_MS', 60_000) },
    createTaskLimit: { max: num('RATE_LIMIT_TASKS_MAX', 20), windowMs: num('RATE_LIMIT_WINDOW_MS', 60_000) },
  };
}

let ephemeralSecret: string | null = null;

/**
 * HMAC secret for outbox webhooks. In production a missing secret, the old public
 * default or one shorter than 32 chars stops the boot. Outside production the same
 * cases get a random per-process secret (with a warning), so the public default is
 * never used to sign anything.
 */
export function webhookSecret(env: Env = process.env): string {
  const secret = env.WEBHOOK_SECRET?.trim() ?? '';
  const weak = !secret || secret === DEFAULT_WEBHOOK_SECRET || secret.length < MIN_SECRET_LENGTH;
  if (!weak) return secret;
  if (isProduction(env)) {
    throw new Error(`WEBHOOK_SECRET ausente, igual ao valor de exemplo ou com menos de ${MIN_SECRET_LENGTH} caracteres: gere um com "openssl rand -hex 32"`);
  }
  if (!ephemeralSecret) {
    ephemeralSecret = randomBytes(32).toString('hex');
    new Logger('Security').warn('WEBHOOK_SECRET fraco ou ausente: usando um segredo aleatório deste processo (receptores externos não vão validar)');
  }
  return ephemeralSecret;
}

/** Boot-time checks (main.ts): throws before the HTTP server starts. */
export function assertSecurityConfig(env: Env = process.env): SecurityConfig {
  webhookSecret(env);
  return securityConfig(env);
}
