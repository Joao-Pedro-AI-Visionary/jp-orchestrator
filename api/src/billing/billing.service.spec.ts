import { newId } from '../common/util';
import { EventBus } from '../events/event-bus';
import { MemoryStore } from '../persistence/memory.store';
import { BillingService, BudgetExceededError, SUMMARY_PAGE_MAX } from './billing.service';

describe('BillingService', () => {
  const setup = async (tasks = 3) => {
    const store = new MemoryStore();
    const ids: string[] = [];
    for (let i = 0; i < tasks; i++) {
      const at = new Date(Date.UTC(2026, 10, 1, 12, i)).toISOString();
      const { task } = await store.createTask({ id: newId(), title: `T${i}`, description: 'd', status: 'running', budgetUsd: 1, spentUsd: 0,
        requiresApproval: false, correctionRounds: 0, result: null, error: null, createdAt: at, updatedAt: at }, null);
      ids.push(task.id);
    }
    return { store, ids, billing: new BillingService(store, new EventBus()) };
  };

  it('summary pages byTask (newest first) and clamps limit and offset; totals cover every task', async () => {
    const { billing, ids } = await setup();
    for (const taskId of ids) {
      await billing.record({ taskId, subtaskId: null, agent: 'coder', model: 'm', promptTokens: 1, completionTokens: 1, costUsd: 0.1, savedUsd: 0, cached: false });
    }
    const page = await billing.summary(2, 1);
    expect(page.page).toEqual({ limit: 2, offset: 1, total: 3 });
    expect(page.byTask.map((t) => t.taskId)).toEqual([ids[1], ids[0]]);
    expect(page.totals).toMatchObject({ calls: 3, costUsd: 0.3, tokens: 6 });
    expect((await billing.summary(10_000, -5)).page).toEqual({ limit: SUMMARY_PAGE_MAX, offset: 0, total: 3 });
    expect((await billing.summary(Number.NaN, Number.NaN)).page).toEqual({ limit: 50, offset: 0, total: 3 });
  });

  it('csv reads the ledger in keyset pages and keeps every row once, in order', async () => {
    const { billing, store, ids } = await setup(1);
    const n = 2_345; // more than two pages of 1000
    for (let i = 0; i < n; i++) {
      await store.recordUsage({ id: newId(), taskId: ids[0], subtaskId: null, agent: 'coder', model: 'm', promptTokens: i, completionTokens: 0,
        costUsd: 0, savedUsd: 0, cached: false, createdAt: new Date(Date.UTC(2026, 10, 1) + i).toISOString() });
    }
    const page = jest.spyOn(store, 'listUsagePage');
    const rows = (await billing.csv()).trim().split('\n').slice(1);
    expect(page).toHaveBeenCalledTimes(3);
    expect(rows).toHaveLength(n);
    expect(rows.map((r) => Number(r.split(',')[5]))).toEqual(Array.from({ length: n }, (_, i) => i));
  });

  it('reserve throws BudgetExceededError with spent + reserved and counts the block; a missing task is not guarded', async () => {
    const { billing, ids } = await setup(1);
    const r = await billing.reserve(ids[0], 0.7);
    await expect(billing.reserve(ids[0], 0.4)).rejects.toMatchObject({ spentUsd: 0.7, budgetUsd: 1 });
    await expect(billing.reserve(ids[0], 0.4)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(billing.budgetBlocks).toBe(2);
    await billing.release(r);
    await expect(billing.reserve(ids[0], 0.4)).resolves.toMatchObject({ amountUsd: 0.4 });
    expect(await billing.reserve(newId(), 99)).toEqual(expect.objectContaining({ id: null }));
    await billing.release(null);
  });
});
