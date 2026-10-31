import { envNumber } from './util';

/** Every knob that bounds how long a redelivery or retry can still happen. */
export interface RetryConfig {
  /** How long receivers and downstream systems honor an Idempotency-Key. */
  idempotencyKeyTtlMs: number;
  outboxMaxAttempts: number;
  outboxTimeoutMs: number;
  outboxClaimLeaseMs: number;
  /** An outbox event older than this goes dead as 'expired' instead of being sent. */
  outboxMaxAgeMs: number;
  toolLeaseMs: number;
  /** Caps lease takeovers of one tool call. */
  toolMaxAttempts: number;
}

export const RETRY_DEFAULTS: RetryConfig = {
  idempotencyKeyTtlMs: 86_400_000,
  outboxMaxAttempts: 5,
  outboxTimeoutMs: 5_000,
  outboxClaimLeaseMs: 30_000,
  outboxMaxAgeMs: 600_000,
  toolLeaseMs: 10_000,
  toolMaxAttempts: 3,
};

const ENV: Record<keyof RetryConfig, string> = {
  idempotencyKeyTtlMs: 'IDEMPOTENCY_KEY_TTL_MS',
  outboxMaxAttempts: 'OUTBOX_MAX_ATTEMPTS',
  outboxTimeoutMs: 'OUTBOX_TIMEOUT_MS',
  outboxClaimLeaseMs: 'OUTBOX_CLAIM_LEASE_MS',
  outboxMaxAgeMs: 'OUTBOX_MAX_AGE_MS',
  toolLeaseMs: 'TOOL_LEASE_MS',
  toolMaxAttempts: 'TOOL_MAX_ATTEMPTS',
};

export const retryConfig = (): RetryConfig => {
  const c = { ...RETRY_DEFAULTS };
  for (const k of Object.keys(ENV) as (keyof RetryConfig)[]) c[k] = envNumber(ENV[k], RETRY_DEFAULTS[k]);
  return c;
};

/**
 * Worst case between the first and the last send of one outbox event: the backoffs
 * between attempts (2^n s, none after the last) plus, per attempt, a full timeout and
 * a full claim lease (crash after the POST, resent when the lease expires).
 */
export function outboxHorizonMs(c: RetryConfig): number {
  let backoffs = 0;
  for (let n = 1; n < c.outboxMaxAttempts; n++) backoffs += 2 ** n * 1000;
  return backoffs + c.outboxMaxAttempts * (c.outboxTimeoutMs + c.outboxClaimLeaseMs);
}

/** Worst case for one tool call: every allowed attempt holds a full lease. */
export const toolHorizonMs = (c: RetryConfig): number => c.toolMaxAttempts * c.toolLeaseMs;

/**
 * Fails fast when a redelivery or retry could outlive the idempotency key, i.e. reach
 * a receiver after it forgot the key and applied the effect again.
 */
export function assertRetryHorizon(c: RetryConfig): void {
  for (const k of Object.keys(ENV) as (keyof RetryConfig)[]) {
    if (!Number.isInteger(c[k]) || c[k] <= 0) throw new Error(`${ENV[k]} deve ser um inteiro positivo (recebido: ${c[k]})`);
  }
  const ttl = `IDEMPOTENCY_KEY_TTL_MS (${c.idempotencyKeyTtlMs}ms)`;
  const outbox = outboxHorizonMs(c);
  if (outbox >= c.idempotencyKeyTtlMs) {
    throw new Error(`Horizonte de reentrega do outbox (${outbox}ms) >= ${ttl}: reduza OUTBOX_MAX_ATTEMPTS, OUTBOX_TIMEOUT_MS ou OUTBOX_CLAIM_LEASE_MS, ou aumente o TTL`);
  }
  const tool = toolHorizonMs(c);
  if (tool >= c.idempotencyKeyTtlMs) {
    throw new Error(`Horizonte de retry das ferramentas (${tool}ms) >= ${ttl}: reduza TOOL_MAX_ATTEMPTS ou TOOL_LEASE_MS, ou aumente o TTL`);
  }
  if (c.outboxMaxAgeMs >= c.idempotencyKeyTtlMs) {
    throw new Error(`OUTBOX_MAX_AGE_MS (${c.outboxMaxAgeMs}ms) >= ${ttl}: um evento expirado ainda seria reenviado`);
  }
}
