import { newId, nowIso } from '../common/util';
import { MemoryStore } from '../persistence/memory.store';
import { assertRetentionConfig, retentionConfig, RetentionService } from './retention.service';

const DAY = 86_400_000;

describe('RetentionService', () => {
  it('defaults: 7 days of retention, hourly passes; env configurable', () => {
    expect(retentionConfig({})).toEqual({ retentionMs: 7 * DAY, intervalMs: 3_600_000, enabled: true });
    expect(retentionConfig({ RETENTION: 'off', RETENTION_MS: String(2 * DAY) })).toMatchObject({ retentionMs: 2 * DAY, enabled: false });
  });

  it('refuses a retention shorter than the idempotency key TTL (a pruned key could be applied again)', () => {
    const cfg = { retentionMs: DAY - 1, intervalMs: 1000, enabled: true };
    expect(() => assertRetentionConfig(cfg, DAY)).toThrow(/RETENTION_MS \(86399999ms\) < IDEMPOTENCY_KEY_TTL_MS \(86400000ms\)/);
    expect(() => assertRetentionConfig({ ...cfg, retentionMs: DAY }, DAY)).not.toThrow();
    expect(() => assertRetentionConfig({ ...cfg, retentionMs: DAY, intervalMs: 0 }, DAY)).toThrow(/RETENTION_INTERVAL_MS/);
    expect(() => new RetentionService(new MemoryStore(), cfg)).toThrow(/RETENTION_MS/);
  });

  it('prunes what is older than RETENTION_MS and keeps what is still inside the key TTL', async () => {
    const store = new MemoryStore();
    const svc = new RetentionService(store, { retentionMs: DAY, intervalMs: 1000, enabled: false });
    const now = Date.now();
    const at = (ago: number) => new Date(now - ago).toISOString();
    await store.addInbox({ id: newId(), eventId: 'expired', event: 'e', verified: true, signature: 's', payload: {}, receivedAt: at(DAY + 1) });
    await store.addInbox({ id: newId(), eventId: 'in-ttl', event: 'e', verified: true, signature: 's', payload: {}, receivedAt: at(DAY - 60_000) });
    expect(await svc.prune(now)).toEqual({ webhookInbox: 1, toolCalls: 0, stepJournal: 0 });
    expect((await store.listInbox(10)).map((e) => e.eventId)).toEqual(['in-ttl']);
    // A redelivery of the kept event is still deduplicated.
    expect(await store.addInbox({ id: newId(), eventId: 'in-ttl', event: 'e', verified: true, signature: 's', payload: {}, receivedAt: nowIso() })).toBe(false);
  });
});
