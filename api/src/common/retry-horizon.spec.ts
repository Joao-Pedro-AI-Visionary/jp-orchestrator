import { assertRetryHorizon, outboxHorizonMs, RETRY_DEFAULTS, retryConfig, RetryConfig, toolHorizonMs } from './retry-horizon';

describe('retry horizon', () => {
  const cfg = (patch: Partial<RetryConfig> = {}): RetryConfig => ({ ...RETRY_DEFAULTS, ...patch });

  it('computes the worst case: sum of backoffs plus attempts * (timeout + lease) for the outbox, attempts * lease for tools', () => {
    // 5 attempts: backoffs 2+4+8+16 s (none after the last), plus 5 * (5 s + 30 s).
    expect(outboxHorizonMs(cfg())).toBe(30_000 + 175_000);
    expect(toolHorizonMs(cfg())).toBe(3 * 10_000);
    expect(outboxHorizonMs(cfg({ outboxMaxAttempts: 1 }))).toBe(35_000);
  });

  it('accepts the defaults', () => {
    expect(RETRY_DEFAULTS).toMatchObject({ idempotencyKeyTtlMs: 86_400_000, outboxMaxAgeMs: 600_000, outboxClaimLeaseMs: 30_000, toolMaxAttempts: 3 });
    expect(() => assertRetryHorizon(cfg())).not.toThrow();
  });

  it('fails fast when a retry horizon or the max age reaches the key TTL', () => {
    expect(() => assertRetryHorizon(cfg({ idempotencyKeyTtlMs: 205_000 }))).toThrow(/outbox.*205000ms.*IDEMPOTENCY_KEY_TTL_MS \(205000ms\)/);
    expect(() => assertRetryHorizon(cfg({ outboxMaxAttempts: 20 }))).toThrow(/OUTBOX_MAX_ATTEMPTS/);
    expect(() => assertRetryHorizon(cfg({ toolMaxAttempts: 9, toolLeaseMs: 10_000_000 }))).toThrow(/ferramentas.*TOOL_MAX_ATTEMPTS/);
    expect(() => assertRetryHorizon(cfg({ outboxMaxAgeMs: 86_400_000 }))).toThrow(/OUTBOX_MAX_AGE_MS \(86400000ms\)/);
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
