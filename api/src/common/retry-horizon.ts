import { envNumber } from './util';

/** Every knob that bounds how long a redelivery or retry can still happen. */
export interface RetryConfig {
  /** How long receivers and downstream systems honor an Idempotency-Key. */
  idempotencyKeyTtlMs: number;
  outboxMaxAttempts: number;
  outboxTimeoutMs: number;
  outboxClaimLeaseMs: number;
  /**
   * An outbox event older than this goes dead as 'expired' instead of being sent.
   * Default: IDEMPOTENCY_KEY_TTL_MS minus the outbox horizon (about 23h56m with the
   * defaults), so an outage of the relay or the receiver shorter than that loses nothing.
   */
  outboxMaxAgeMs: number;
  toolLeaseMs: number;
  /** Caps lease takeovers of one tool call. */
  toolMaxAttempts: number;
}

const BASE_DEFAULTS: Omit<RetryConfig, 'outboxMaxAgeMs'> = {
  idempotencyKeyTtlMs: 86_400_000,
  outboxMaxAttempts: 5,
  outboxTimeoutMs: 5_000,
  outboxClaimLeaseMs: 30_000,
  toolLeaseMs: 10_000,
  toolMaxAttempts: 3,
};

/** The latest age at which an event can still be sent so that every resend lands inside the key TTL. */
export const defaultOutboxMaxAgeMs = (c: Omit<RetryConfig, 'outboxMaxAgeMs'>): number =>
  c.idempotencyKeyTtlMs - outboxHorizonMs(c);

export const RETRY_DEFAULTS: RetryConfig = { ...BASE_DEFAULTS, outboxMaxAgeMs: defaultOutboxMaxAgeMs(BASE_DEFAULTS) };

const ENV: Record<keyof RetryConfig, string> = {
  idempotencyKeyTtlMs: 'IDEMPOTENCY_KEY_TTL_MS',
  outboxMaxAttempts: 'OUTBOX_MAX_ATTEMPTS',
  outboxTimeoutMs: 'OUTBOX_TIMEOUT_MS',
  outboxClaimLeaseMs: 'OUTBOX_CLAIM_LEASE_MS',
  outboxMaxAgeMs: 'OUTBOX_MAX_AGE_MS',
  toolLeaseMs: 'TOOL_LEASE_MS',
  toolMaxAttempts: 'TOOL_MAX_ATTEMPTS',
};

/** Reads every knob from the environment. Without OUTBOX_MAX_AGE_MS the max age derives from the resolved TTL and horizon. */
export const retryConfig = (): RetryConfig => {
  const c = { ...RETRY_DEFAULTS };
  for (const k of Object.keys(ENV) as (keyof RetryConfig)[]) c[k] = envNumber(ENV[k], RETRY_DEFAULTS[k]);
  if (process.env.OUTBOX_MAX_AGE_MS === undefined) c.outboxMaxAgeMs = defaultOutboxMaxAgeMs(c);
  return c;
};

/**
 * Worst case between the first and the last send of one outbox event: the backoffs
 * between attempts (2^n s, none after the last) plus, per attempt, a full timeout and
 * a full claim lease (crash after the POST, resent when the lease expires).
 */
export function outboxHorizonMs(c: Pick<RetryConfig, 'outboxMaxAttempts' | 'outboxTimeoutMs' | 'outboxClaimLeaseMs'>): number {
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
  // A batch is sent in parallel and ends within one timeout plus the status writes; the claim lease
  // must outlast that with room to spare (2x), or a second relay re-claims events still being sent.
  if (c.outboxClaimLeaseMs < 2 * c.outboxTimeoutMs) {
    throw new Error(`OUTBOX_CLAIM_LEASE_MS (${c.outboxClaimLeaseMs}ms) deve ser pelo menos 2x OUTBOX_TIMEOUT_MS (${c.outboxTimeoutMs}ms): o lease venceria no meio do envio`);
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
  // The age is checked at claim time; the send that follows can land one timeout plus one claim lease later.
  const lastSend = c.outboxMaxAgeMs + c.outboxTimeoutMs + c.outboxClaimLeaseMs;
  if (lastSend >= c.idempotencyKeyTtlMs) {
    throw new Error(`OUTBOX_MAX_AGE_MS (${c.outboxMaxAgeMs}ms) + OUTBOX_TIMEOUT_MS + OUTBOX_CLAIM_LEASE_MS (${lastSend}ms) >= ${ttl}: um evento expirado ainda seria reenviado`);
  }
}
