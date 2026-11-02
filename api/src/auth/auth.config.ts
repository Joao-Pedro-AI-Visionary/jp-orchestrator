import { createHash } from 'node:crypto';

/** Roles in increasing order of power: each one can do everything the previous ones can. */
export const ROLES = ['viewer', 'operator', 'approver', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export interface Principal {
  /** Stable identity recorded on decisions (approver). Never the key itself. */
  id: string;
  role: Role;
}

export interface AuthConfig {
  /** sha256(key) -> principal. Keys are only kept hashed. */
  keys: Map<string, Principal>;
  /** No keys outside production: every request is an admin named 'anonymous' (local dev and tests). */
  open: boolean;
}

export const OPEN_PRINCIPAL: Principal = { id: 'anonymous', role: 'admin' };
export const DEFAULT_WEBHOOK_SECRET = 'dev-secret-change-me';

export const hashKey = (key: string): string => createHash('sha256').update(key).digest('hex');
export const atLeast = (role: Role, required: Role): boolean => ROLES.indexOf(role) >= ROLES.indexOf(required);
const isProduction = (env: NodeJS.ProcessEnv) => env.NODE_ENV === 'production';

/**
 * API_KEYS="key:role[:name],key2:role2[:name2]". The name is the identity recorded on
 * approvals; without it the identity is "<role>-<first 8 hex of sha256(key)>".
 * Open mode (no auth) only when NODE_ENV is not production and API_KEYS is empty:
 * in production an empty API_KEYS fails the boot.
 */
export function authConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const keys = new Map<string, Principal>();
  const entries = (env.API_KEYS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const entry of entries) {
    const [key, role, name] = entry.split(':').map((s) => s.trim());
    if (!key || key.length < 16) throw new Error('API_KEYS: cada chave precisa ter pelo menos 16 caracteres');
    if (!ROLES.includes(role as Role)) throw new Error(`API_KEYS: papel inválido "${role ?? ''}" (use ${ROLES.join(', ')})`);
    if (name !== undefined && !/^[\w.@-]{1,64}$/.test(name)) throw new Error(`API_KEYS: nome inválido "${name}"`);
    const hash = hashKey(key);
    if (keys.has(hash)) throw new Error('API_KEYS: chave repetida');
    keys.set(hash, { id: name || `${role}-${hash.slice(0, 8)}`, role: role as Role });
  }
  if (!keys.size && isProduction(env)) throw new Error('API_KEYS é obrigatório com NODE_ENV=production');
  return { keys, open: keys.size === 0 };
}

/** The event signing secret; the public default is refused in production. */
export function webhookSecret(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env.WEBHOOK_SECRET || DEFAULT_WEBHOOK_SECRET;
  if (isProduction(env) && (secret === DEFAULT_WEBHOOK_SECRET || secret.length < 16)) {
    throw new Error('WEBHOOK_SECRET precisa ser definido (16+ caracteres, diferente do padrão) com NODE_ENV=production');
  }
  return secret;
}

/** CORS_ORIGINS="https://a,https://b". Default: the local dashboard outside production, no cross origin in production. */
export function corsOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.CORS_ORIGINS ?? env.CORS_ORIGIN;
  if (raw !== undefined) return raw.split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
  return isProduction(env) ? [] : ['http://localhost:3000', 'http://127.0.0.1:3000'];
}

/** Boot check for every security setting: fails fast instead of running half protected. */
export function assertSecurityConfig(env: NodeJS.ProcessEnv = process.env): void {
  authConfig(env);
  webhookSecret(env);
  if (isProduction(env) && corsOrigins(env).includes('*')) throw new Error('CORS_ORIGINS="*" não é permitido com NODE_ENV=production');
}
