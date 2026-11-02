import { BudgetExceededError } from '../billing/billing.service';
import { estimateTokens, newId, nowIso, round6 } from '../common/util';
import { LlmProvider, MockProvider } from './llm-provider';
import { costOf } from './model-catalog';
import { gatewayHarness } from '../test-utils/harness';
import { TokenLimitError } from './gateway.service';
import { cosine, embed, InMemorySemanticCache } from './semantic-cache';

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

  it('bypasses the cache on a correction attempt (attempt > 1 or feedback): the retry reaches the model', async () => {
    const h = gatewayHarness();
    await seedTask(h.store);
    const prompt = 'AGENTE: coder\nTAREFA: corrigir bug no login\nSUBTAREFA: aplicar a correção';
    await h.gateway.complete(req(prompt));
    expect((await h.gateway.complete({ ...req(prompt), attempt: 2 })).cached).toBe(false);
    expect((await h.gateway.complete({ ...req(`${prompt}\nFEEDBACK: falta teste\nTENTATIVA: 2`), feedback: 'falta teste', attempt: 2 })).cached).toBe(false);
    expect((await h.gateway.complete({ ...req(prompt), feedback: 'falta teste' })).cached).toBe(false);
    expect(h.gateway.stats).toMatchObject({ cacheHits: 0, cacheBypasses: 3 });
    // The first attempt still hits: bypassed answers were not stored over it.
    expect((await h.gateway.complete(req(prompt))).cached).toBe(true);
  });

  it('scopes the cache per task: another task never gets this task\'s answer', async () => {
    const h = gatewayHarness();
    await seedTask(h.store);
    const now = nowIso();
    await h.store.createTask({ id: 't2', title: 't', description: 'd', status: 'running', budgetUsd: 1, spentUsd: 0,
      requiresApproval: false, correctionRounds: 0, result: null, error: null, createdAt: now, updatedAt: now }, null);
    await h.gateway.complete(req('TAREFA: corrigir login do cliente ACME'));
    const other = await h.gateway.complete({ ...req('TAREFA: corrigir login do cliente ACME'), taskId: 't2' });
    expect(other.cached).toBe(false);
    expect(await h.store.listUsage('t2')).toEqual([expect.objectContaining({ cached: false })]);
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

describe('GatewayService budget reservation', () => {
  const MAX_OUT = 512;
  const estimate = (h: ReturnType<typeof gatewayHarness>, prompt: string, model = 0) =>
    costOf(h.catalog.chainFor('cheap')[model], estimateTokens(prompt), MAX_OUT);

  it('reservation race: concurrent calls that each fit the budget alone but not together -> exactly one runs', async () => {
    const h = gatewayHarness(new MockProvider(20));
    const prompts = ['TAREFA: primeira chamada', 'TAREFA: segunda chamada'];
    await seedTask(h.store, estimate(h, prompts[0]) * 1.5);
    const results = await Promise.allSettled(prompts.map((p) => h.gateway.complete(req(p))));
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toBeInstanceOf(BudgetExceededError);
    expect(await h.store.listUsage('t1')).toHaveLength(1);
    const task = (await h.store.getTask('t1'))!;
    expect(task.spentUsd).toBeLessThanOrEqual(task.budgetUsd);
    expect(h.billing.budgetBlocks).toBe(1);
  });

  it('settles the reservation with the real cost: the budget is free again once the call ended', async () => {
    const h = gatewayHarness();
    await seedTask(h.store);
    await h.gateway.complete(req('TAREFA: liquidar'));
    const task = (await h.store.getTask('t1'))!;
    // Nothing left reserved: the whole remaining budget can be reserved.
    expect(await h.store.reserveBudget(newId(), 't1', round6(task.budgetUsd - task.spentUsd))).toMatchObject({ reserved: true });
  });

  it('fallback: the failed model reservation is released and the next model reserves its own worst case', async () => {
    const h = gatewayHarness();
    const prompt = 'TAREFA: fallback';
    const reserve = jest.spyOn(h.store, 'reserveBudget');
    const release = jest.spyOn(h.store, 'releaseBudget');
    await seedTask(h.store);
    h.catalog.setHealthy('mock-mini', false);
    expect((await h.gateway.complete(req(prompt))).model).toBe('mock-lite');
    expect(reserve.mock.calls.map((c) => c[2])).toEqual([round6(estimate(h, prompt, 0)), round6(estimate(h, prompt, 1))]);
    expect(release).toHaveBeenCalledWith(reserve.mock.calls[0][0]);
    const task = (await h.store.getTask('t1'))!;
    expect(await h.store.reserveBudget(newId(), 't1', round6(task.budgetUsd - task.spentUsd))).toMatchObject({ reserved: true });
  });

  it('a fallback model that would cross the budget is refused before it is called', async () => {
    const h = gatewayHarness();
    const prompt = 'TAREFA: fallback caro';
    await seedTask(h.store, estimate(h, prompt, 0) * 1.01);
    expect(estimate(h, prompt, 1)).toBeGreaterThan(estimate(h, prompt, 0) * 1.01);
    h.catalog.setHealthy('mock-mini', false);
    await expect(h.gateway.complete(req(prompt))).rejects.toBeInstanceOf(BudgetExceededError);
    expect(await h.store.listUsage('t1')).toHaveLength(0);
  });

  it('a provider error that is not an outage releases the reservation', async () => {
    const boom: LlmProvider = { key: 'mock', complete: async () => { throw new Error('500 do provedor'); } };
    const h = gatewayHarness(boom);
    await seedTask(h.store);
    await expect(h.gateway.complete(req('TAREFA: erro'))).rejects.toThrow('500 do provedor');
    expect(await h.store.reserveBudget(newId(), 't1', 1)).toMatchObject({ reserved: true });
  });
});

describe('InMemorySemanticCache', () => {
  it('matches the exact prompt hash before the semantic scan', async () => {
    const cache = new InMemorySemanticCache(1.01); // semantic matching can never pass
    const entry = { text: 'x', model: 'm', promptTokens: 1, completionTokens: 1, costUsd: 0.1 };
    await cache.store('s', 'prompt exato', entry);
    expect(await cache.lookup('s', 'prompt exato')).toEqual({ entry, similarity: 1 });
    expect(await cache.lookup('s', 'prompt exato!')).toBeNull();
    expect(await cache.lookup('outro-escopo', 'prompt exato')).toBeNull();
  });
});

describe('embed', () => {
  it('scores near duplicates high and unrelated text low', () => {
    expect(cosine(embed('criar endpoint de pedidos'), embed('criar endpoint de pedidos'))).toBeCloseTo(1);
    expect(cosine(embed('criar endpoint de pedidos'), embed('investigar vazamento de memória'))).toBeLessThan(0.5);
  });
});
