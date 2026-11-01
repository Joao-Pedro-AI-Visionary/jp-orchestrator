import { BudgetExceededError } from '../billing/billing.service';
import { estimateTokens, nowIso, sleep } from '../common/util';
import { gatewayHarness } from '../test-utils/harness';
import { cacheScope } from './gateway.service';
import { LlmProvider, MockProvider } from './llm-provider';
import { costOf, DEFAULT_MODELS, ModelSpec } from './model-catalog';

type H = ReturnType<typeof gatewayHarness>;

async function seed(h: H, id: string, budgetUsd = 1) {
  const now = nowIso();
  await h.store.createTask({ id, title: 't', description: 'd', status: 'running', budgetUsd, spentUsd: 0,
    requiresApproval: false, correctionRounds: 0, result: null, error: null, createdAt: now, updatedAt: now }, null);
}

class SlowProvider implements LlmProvider {
  readonly key = 'mock';
  calls = 0;
  private inner = new MockProvider(0);
  async complete(model: ModelSpec, prompt: string, max: number) {
    this.calls++;
    await sleep(20);
    return this.inner.complete(model, prompt, max);
  }
}

describe('semantic cache scope (H3)', () => {
  it('includes tenant and task in the scope', () => {
    const base = { taskId: 'a', agent: 'coder', tier: 'cheap' as const };
    expect(cacheScope(base)).not.toBe(cacheScope({ ...base, taskId: 'b' }));
    expect(cacheScope({ ...base, tenantId: 'x' })).not.toBe(cacheScope({ ...base, tenantId: 'y' }));
    expect(cacheScope(base)).toBe(cacheScope({ ...base, tenantId: 'default' }));
    expect(cacheScope({ ...base, taskId: 'a:b' })).not.toBe(cacheScope({ ...base, taskId: 'a', agent: 'b:coder' }));
  });

  it('never serves one task (or tenant) the completion cached for another', async () => {
    const h = gatewayHarness();
    await seed(h, 'ta');
    await seed(h, 'tb');
    const prompt = 'TAREFA: criar endpoint REST de pedidos com testes';
    const call = (taskId: string, tenantId?: string) =>
      h.gateway.complete({ taskId, subtaskId: null, agent: 'coder', prompt, tier: 'cheap', tenantId });

    expect((await call('ta')).cached).toBe(false);
    expect((await call('tb')).cached).toBe(false);
    expect((await call('ta', 'other-tenant')).cached).toBe(false);
    expect((await call('ta')).cached).toBe(true);
    expect(h.gateway.stats.cacheHits).toBe(1);
  });
});

describe('atomic budget reservation (H4)', () => {
  const prompt = (i: number) => `TAREFA: chamada paralela numero ${String(i).padStart(2, '0')}`;
  const estimate = costOf(DEFAULT_MODELS[0], estimateTokens(prompt(0)), 512);

  it('lets parallel calls of one task spend at most the budget', async () => {
    const provider = new SlowProvider();
    const h = gatewayHarness(provider);
    const budget = Math.ceil(estimate * 2.5 * 1e6) / 1e6; // room for exactly 2 reservations
    await seed(h, 't1', budget);

    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) =>
      h.gateway.complete({ taskId: 't1', subtaskId: null, agent: `coder-${i}`, prompt: prompt(i), tier: 'cheap' })));

    const ok = results.filter((r) => r.status === 'fulfilled');
    const blocked = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(2);
    expect(blocked.every((r) => (r as PromiseRejectedResult).reason instanceof BudgetExceededError)).toBe(true);
    expect(provider.calls).toBe(2);
    const t = (await h.store.getTask('t1'))!;
    expect(t.spentUsd).toBeLessThanOrEqual(t.budgetUsd);
    expect(h.billing.budgetBlocks).toBe(6);
    // Settled: the reservation of the two finished calls is gone; what is left is budget - spent.
    expect((await h.store.reserveBudget('t1', Math.floor((budget - t.spentUsd) * 1e6) / 1e6)).ok).toBe(true);
  });

  it('returns the reservation when the provider call fails', async () => {
    let fail = true;
    const flaky: LlmProvider = {
      key: 'mock',
      complete: async (m, p, max) => {
        if (fail) { fail = false; throw new Error('conexão caiu'); }
        return new MockProvider(0).complete(m, p, max);
      },
    };
    const h = gatewayHarness(flaky);
    await seed(h, 't1', Math.ceil(estimate * 1.5 * 1e6) / 1e6); // room for one reservation only
    await expect(h.gateway.complete({ taskId: 't1', subtaskId: null, agent: 'coder', prompt: prompt(1), tier: 'cheap' }))
      .rejects.toThrow('conexão caiu');
    expect((await h.gateway.complete({ taskId: 't1', subtaskId: null, agent: 'coder', prompt: prompt(1), tier: 'cheap' })).cached).toBe(false);
  });

  it('checks the budget again before falling back to a pricier model', async () => {
    const h = gatewayHarness();
    await seed(h, 't1', Math.ceil(estimate * 1.5 * 1e6) / 1e6);
    h.catalog.setHealthy('mock-mini', false); // next in chain (mock-lite) costs 2x
    await expect(h.gateway.complete({ taskId: 't1', subtaskId: null, agent: 'coder', prompt: prompt(1), tier: 'cheap' }))
      .rejects.toBeInstanceOf(BudgetExceededError);
    expect((await h.store.getTask('t1'))!.spentUsd).toBe(0);
  });
});
