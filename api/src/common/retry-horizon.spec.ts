import { assertRetryHorizon, defaultOutboxMaxAgeMs, outboxHorizonMs, RETRY_DEFAULTS, retryConfig, RetryConfig, toolHorizonMs } from './retry-horizon';

describe('retry horizon', () => {
  const cfg = (patch: Partial<RetryConfig> = {}): RetryConfig => ({ ...RETRY_DEFAULTS, ...patch });

  it('computes the worst case: sum of backoffs plus attempts * (timeout + lease) for the outbox, attempts * lease for tools', () => {
    // 5 attempts: backoffs 2+4+8+16 s (none after the last), plus 5 * (5 s + 30 s).
    expect(outboxHorizonMs(cfg())).toBe(30_000 + 175_000);
    expect(toolHorizonMs(cfg())).toBe(3 * 10_000);
    expect(outboxHorizonMs(cfg({ outboxMaxAttempts: 1 }))).toBe(35_000);
  });

  it('accepts the defaults; the max age defaults to the key TTL minus the outbox horizon, not 10 min', () => {
    expect(RETRY_DEFAULTS).toMatchObject({ idempotencyKeyTtlMs: 86_400_000, outboxMaxAgeMs: 86_400_000 - 205_000, outboxClaimLeaseMs: 30_000, toolMaxAttempts: 3 });
    expect(defaultOutboxMaxAgeMs(RETRY_DEFAULTS)).toBe(RETRY_DEFAULTS.outboxMaxAgeMs);
    expect(() => assertRetryHorizon(cfg())).not.toThrow();
  });

  it('derives the max age from the configured TTL and horizon unless OUTBOX_MAX_AGE_MS is set', () => {
    process.env.IDEMPOTENCY_KEY_TTL_MS = '3600000';
    process.env.OUTBOX_MAX_ATTEMPTS = '2';
    try {
      // 2 attempts: one 2 s backoff + 2 * (5 s + 30 s) = 72 s of horizon.
      expect(retryConfig().outboxMaxAgeMs).toBe(3_600_000 - 72_000);
      expect(() => assertRetryHorizon(retryConfig())).not.toThrow();
      process.env.OUTBOX_MAX_AGE_MS = '60000';
      expect(retryConfig().outboxMaxAgeMs).toBe(60_000);
    } finally {
      delete process.env.IDEMPOTENCY_KEY_TTL_MS;
      delete process.env.OUTBOX_MAX_ATTEMPTS;
      delete process.env.OUTBOX_MAX_AGE_MS;
    }
  });

  it('counts the send after the age check: max age + timeout + claim lease must stay below the TTL', () => {
    // 86 365 001 + 5 000 + 30 000 = TTL + 1: the last send could land after the receiver forgot the key.
    expect(() => assertRetryHorizon(cfg({ outboxMaxAgeMs: 86_365_001 }))).toThrow(/OUTBOX_MAX_AGE_MS \(86365001ms\)/);
    expect(() => assertRetryHorizon(cfg({ outboxMaxAgeMs: 86_364_999 }))).not.toThrow();
  });

  it('fails fast when a retry horizon or the max age reaches the key TTL', () => {
    expect(() => assertRetryHorizon(cfg({ idempotencyKeyTtlMs: 205_000 }))).toThrow(/outbox.*205000ms.*IDEMPOTENCY_KEY_TTL_MS \(205000ms\)/);
    expect(() => assertRetryHorizon(cfg({ outboxMaxAttempts: 20 }))).toThrow(/OUTBOX_MAX_ATTEMPTS/);
    expect(() => assertRetryHorizon(cfg({ toolMaxAttempts: 9, toolLeaseMs: 10_000_000 }))).toThrow(/ferramentas.*TOOL_MAX_ATTEMPTS/);
    expect(() => assertRetryHorizon(cfg({ outboxMaxAgeMs: 86_400_000 }))).toThrow(/OUTBOX_MAX_AGE_MS \(86400000ms\)/);
  });

  it('requires the claim lease to be at least twice one send: a parallel batch ends within OUTBOX_TIMEOUT_MS', () => {
    expect(() => assertRetryHorizon(cfg({ outboxClaimLeaseMs: 9_999 }))).toThrow(/OUTBOX_CLAIM_LEASE_MS \(9999ms\) deve ser pelo menos 2x OUTBOX_TIMEOUT_MS/);
    expect(() => assertRetryHorizon(cfg({ outboxClaimLeaseMs: 10_000 }))).not.toThrow();
  });

  it('rejects non-positive or fractional values', () => {
    expect(() => assertRetryHorizon(cfg({ outboxMaxAttempts: 0 }))).toThrow(/OUTBOX_MAX_ATTEMPTS deve ser um inteiro positivo/);
    expect(() => assertRetryHorizon(cfg({ toolMaxAttempts: 1.5 }))).toThrow(/TOOL_MAX_ATTEMPTS/);
    expect(() => assertRetryHorizon(cfg({ idempotencyKeyTtlMs: -1 }))).toThrow(/IDEMPOTENCY_KEY_TTL_MS/);
  });

  it('reads the config from the environment', () => {
    process.env.OUTBOX_MAX_AGE_MS = '1000';
    process.env.TOOL_MAX_ATTEMPTS = '2';
    try {
      expect(retryConfig()).toEqual({ ...RETRY_DEFAULTS, outboxMaxAgeMs: 1000, toolMaxAttempts: 2 });
    } finally {
      delete process.env.OUTBOX_MAX_AGE_MS;
      delete process.env.TOOL_MAX_ATTEMPTS;
    }
  });
});
