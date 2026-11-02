import { envNumber } from '../common/util';

export type DurableRuntimeName = 'journal' | 'restate' | 'temporal';

export interface RestateConfig {
  /** RESTATE_INGRESS_URL (required): where the API submits and signals executions. */
  ingressUrl: string;
  /** RESTATE_ENDPOINT_PORT (9080): port of the service endpoint Restate calls. */
  endpointPort: number;
  /** RESTATE_ENDPOINT_HOST (0.0.0.0): bind address of that endpoint; 127.0.0.1 when Restate runs on the same host. */
  endpointHost: string;
  /** RESTATE_ADMIN_URL (optional): when set, the API registers its endpoint on boot. */
  adminUrl: string | null;
  /** RESTATE_DEPLOYMENT_URL: address Restate uses to reach this endpoint (default http://localhost:<port>). */
  deploymentUrl: string;
  /**
   * RESTATE_IDENTITY_KEYS: publickeyv1_... keys; only requests signed by Restate are accepted. Required,
   * unless RESTATE_ALLOW_UNSIGNED=true (local dev only; refused in production).
   */
  identityKeys: string[];
  /** RESTATE_REGISTER_FORCE=true: the self-registration overwrites an existing deployment (dev loop; refused in production). */
  registerForce: boolean;
  /** RESTATE_INGRESS_TOKEN: sent as Bearer to the ingress (Restate Cloud or an auth proxy). */
  ingressToken: string | null;
  /** RESTATE_RESUME_WINDOW_MS (7 days): how long a failed execution waits for /resume before closing. */
  resumeWindowMs: number;
  /** RESTATE_EFFECT_MAX_ATTEMPTS (3): retries of a store write before it fails the task. */
  effectMaxAttempts: number;
}

export type DurableConfig = { runtime: 'journal' } | { runtime: 'restate'; restate: RestateConfig };

/** Misconfiguration found at boot. The process must not start with a half-configured runtime. */
export class DurableConfigError extends Error {
  constructor(message: string) {
    super(`DURABLE_RUNTIME inválido: ${message}`);
  }
}

const RUNTIMES: DurableRuntimeName[] = ['journal', 'restate', 'temporal'];

function url(env: NodeJS.ProcessEnv, name: string, required: true): string;
function url(env: NodeJS.ProcessEnv, name: string, required: false): string | null;
function url(env: NodeJS.ProcessEnv, name: string, required: boolean): string | null {
  const raw = env[name]?.trim();
  if (!raw) {
    if (required) throw new DurableConfigError(`${name} é obrigatório com DURABLE_RUNTIME=restate`);
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new DurableConfigError(`${name} não é uma URL válida`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new DurableConfigError(`${name} deve ser http(s)`);
  return raw.replace(/\/+$/, '');
}

/** Reads and validates DURABLE_RUNTIME and its settings. Throws DurableConfigError on misconfiguration. */
export function durableConfig(env: NodeJS.ProcessEnv = process.env): DurableConfig {
  const runtime = (env.DURABLE_RUNTIME?.trim() || 'journal') as DurableRuntimeName;
  if (!RUNTIMES.includes(runtime)) throw new DurableConfigError(`"${runtime}" (use ${RUNTIMES.join(' | ')})`);
  if (runtime === 'journal') return { runtime };
  if (runtime === 'temporal') {
    throw new DurableConfigError('"temporal" foi avaliado e não está implementado nesta versão (ver docs/durable-runtime.md); use journal ou restate');
  }
  const ingressUrl = url(env, 'RESTATE_INGRESS_URL', true);
  const endpointPort = envNumber('RESTATE_ENDPOINT_PORT', 9080, env);
  if (!Number.isInteger(endpointPort) || endpointPort < 1 || endpointPort > 65535) {
    throw new DurableConfigError('RESTATE_ENDPOINT_PORT deve ser uma porta TCP');
  }
  const identityKeys = (env.RESTATE_IDENTITY_KEYS ?? '').split(',').map((k) => k.trim()).filter(Boolean);
  const badKey = identityKeys.find((k) => !k.startsWith('publickeyv1_'));
  if (badKey) throw new DurableConfigError('RESTATE_IDENTITY_KEYS aceita só chaves publickeyv1_...');
  const production = env.NODE_ENV === 'production';
  const allowUnsigned = env.RESTATE_ALLOW_UNSIGNED === 'true';
  if (allowUnsigned && production) throw new DurableConfigError('RESTATE_ALLOW_UNSIGNED não é aceito em produção');
  if (identityKeys.length === 0 && !allowUnsigned) {
    throw new DurableConfigError(
      'RESTATE_IDENTITY_KEYS é obrigatório: sem ela qualquer um que alcance o endpoint executa handlers (só em dev local: RESTATE_ALLOW_UNSIGNED=true)');
  }
  const registerForce = env.RESTATE_REGISTER_FORCE === 'true';
  if (registerForce && production) throw new DurableConfigError('RESTATE_REGISTER_FORCE não é aceito em produção');
  const resumeWindowMs = envNumber('RESTATE_RESUME_WINDOW_MS', 7 * 24 * 3_600_000, env);
  const effectMaxAttempts = envNumber('RESTATE_EFFECT_MAX_ATTEMPTS', 3, env);
  if (!(resumeWindowMs > 0)) throw new DurableConfigError('RESTATE_RESUME_WINDOW_MS deve ser > 0');
  if (!(effectMaxAttempts >= 1)) throw new DurableConfigError('RESTATE_EFFECT_MAX_ATTEMPTS deve ser >= 1');
  return {
    runtime,
    restate: {
      ingressUrl,
      endpointPort,
      endpointHost: env.RESTATE_ENDPOINT_HOST?.trim() || '0.0.0.0',
      adminUrl: url(env, 'RESTATE_ADMIN_URL', false),
      deploymentUrl: url(env, 'RESTATE_DEPLOYMENT_URL', false) ?? `http://localhost:${endpointPort}`,
      identityKeys,
      registerForce,
      ingressToken: env.RESTATE_INGRESS_TOKEN?.trim() || null,
      resumeWindowMs,
      effectMaxAttempts,
    },
  };
}
