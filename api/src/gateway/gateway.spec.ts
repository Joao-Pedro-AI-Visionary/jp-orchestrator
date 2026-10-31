import { BudgetExceededError } from '../billing/billing.service';
import { nowIso } from '../common/util';
import { gatewayHarness } from '../test-utils/harness';
import { TokenLimitError } from './gateway.service';
import { cosine, embed } from './semantic-cache';

async function seedTask(store: ReturnType<typeof gatewayHarness>['store'], budgetUsd = 1) {
  const now = nowIso();
  await store.createTask({ id: 't1', title: 't', description: 'd', status: 'running', budgetUsd, spentUsd: 0,
    requiresApproval: false, correctionRounds: 0, result: null, error: null, createdAt: now, updatedAt: now }, null);
}

const req = (prompt: string, tier: 'cheap' | 'balanced' | 'premium' = 'cheap') =>
  ({ taskId: 't1', subtaskId: null, agent: 'coder', prompt, tier });

describe('GatewayService', () => {
  it('routes to the cheapest model of the requested tier and bills it', async () => {
    const h = gatewayHarness();
    await seedTask(h.store);
    const res = await h.gateway.complete(req('TAREFA: criar endpoint'));
    expect(res.model).toBe('mock-mini');
    expect(res.costUsd).toBeGreaterThan(0);
    const usage = await h.store.listUsage('t1');
    expect(usage).toHaveLength(1);
    expect((await h.store.getTask('t1'))!.spentUsd).toBeCloseTo(res.costUsd, 6);
  });

  it('serves semantically similar prompts from cache at zero cost', async () => {
    const h = gatewayHarness();
    await seedTask(h.store);
    await h.gateway.complete(req('TAREFA: criar endpoint REST de pedidos com testes'));
    const again = await h.gateway.complete(req('TAREFA: criar endpoint REST de pedidos com testes!'));
    expect(again.cached).toBe(true);
    expect(again.costUsd).toBe(0);
    expect(h.gateway.stats.cacheHits).toBe(1);
    const saved = (await h.store.listUsage('t1')).find((u) => u.cached)!;
    expect(saved.savedUsd).toBeGreaterThan(0);
  });

  it('falls back to the next model when one is down', async () => {
    const h = gatewayHarness();
    await seedTask(h.store);
    h.catalog.setHealthy('mock-mini', false);
    const res = await h.gateway.complete(req('TAREFA: x'));
    expect(res.model).toBe('mock-lite');
    expect(res.fallbackFrom).toBe('mock-mini');
    expect(h.gateway.stats.fallbacks).toBe(1);
  });

  it('degrades to a lower tier when the whole tier is down', async () => {
    const h = gatewayHarness();
    await seedTask(h.store);
    h.catalog.setHealthy('mock-pro', false);
    const res = await h.gateway.complete(req('TAREFA: y', 'premium'));
    expect(res.model).toBe('mock-standard');
  });

  it('rejects prompts above the token limit before spending anything', async () => {
    const h = gatewayHarness();
    await seedTask(h.store);
    await expect(h.gateway.complete(req('x'.repeat(40000)))).rejects.toBeInstanceOf(TokenLimitError);
    expect(await h.store.listUsage()).toHaveLength(0);
  });

  it('blocks the call that would cross the task budget', async () => {
    const h = gatewayHarness();
    await seedTask(h.store, 0.0000001);
    await expect(h.gateway.complete(req('TAREFA: caro', 'premium'))).rejects.toBeInstanceOf(BudgetExceededError);
    expect(h.billing.budgetBlocks).toBe(1);
  });
});

describe('embed', () => {
  it('scores near duplicates high and unrelated text low', () => {
    expect(cosine(embed('criar endpoint de pedidos'), embed('criar endpoint de pedidos'))).toBeCloseTo(1);
    expect(cosine(embed('criar endpoint de pedidos'), embed('investigar vazamento de memória'))).toBeLessThan(0.5);
  });
});
