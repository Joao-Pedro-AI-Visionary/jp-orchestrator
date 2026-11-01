import { LlmProvider, MockProvider } from '../gateway/llm-provider';
import { ModelSpec } from '../gateway/model-catalog';
import { orchestratorHarness } from '../test-utils/harness';
import { Planner } from './planner';

/** Mock provider with latency that tracks how many calls run at the same time. */
class ConcurrencyProbe implements LlmProvider {
  readonly key = 'mock';
  active = 0;
  peak = 0;
  private inner = new MockProvider(0);
  async complete(model: ModelSpec, prompt: string, max: number) {
    this.active++;
    this.peak = Math.max(this.peak, this.active);
    await new Promise((r) => setTimeout(r, 30));
    try { return await this.inner.complete(model, prompt, max); } finally { this.active--; }
  }
}

describe('Planner.decompose', () => {
  it('splits clauses by agent kind and always adds the minimal team', () => {
    const plan = Planner.decompose({ title: 'X', description: 'Pesquisar a API. Implementar o handler. Escrever testes' });
    expect(plan.map((p) => p.agent)).toEqual(['researcher', 'coder', 'tester', 'reviewer']);
    const minimal = Planner.decompose({ title: 'X', description: 'ok' });
    expect(minimal.map((p) => p.agent)).toEqual(['researcher', 'coder', 'tester', 'reviewer']);
  });
});

describe('Orchestrator', () => {
  it('runs plan, parallel dispatch, review and merge to completion', async () => {
    const probe = new ConcurrencyProbe();
    const h = orchestratorHarness(probe);
    const task = await h.createTask();

    expect(await h.orchestrator.run(task.id)).toBe('completed');

    const done = (await h.store.getTask(task.id))!;
    expect(done.status).toBe('completed');
    expect(done.result!.artifacts.length).toBeGreaterThan(0);
    const subtasks = await h.store.listSubtasks(task.id);
    expect(subtasks.every((s) => s.status === 'done')).toBe(true);
    expect(probe.peak).toBeGreaterThanOrEqual(3); // 2 coders + 1 tester in the same wave
    expect(await h.context.verifyChain(task.id)).toBe(true);
    expect((await h.store.listSnapshots(task.id)).map((s) => s.label)).toEqual(['plan', 'dispatch', 'review-1', 'merge']);
    expect((await h.memory.list(task.id)).some((m) => m.key.startsWith('research:'))).toBe(true);
    const outbox = await h.store.listOutbox();
    expect(outbox.filter((e) => e.type === 'task.completed')).toHaveLength(1);
    expect(outbox.filter((e) => e.type === 'tool.executed').length).toBeGreaterThan(0);
    const usage = await h.store.listUsage(task.id);
    expect(new Set(usage.map((u) => u.agent))).toEqual(new Set(['researcher', 'coder', 'tester', 'reviewer']));
    expect(done.spentUsd).toBeCloseTo(usage.reduce((s, u) => s + u.costUsd, 0), 6);
  });

  it('runs one correction round when the reviewer rejects, then completes', async () => {
    const h = orchestratorHarness();
    const task = await h.createTask({ title: 'Investigar bug no checkout', description: 'Implementar a correção do bug' });
    expect(await h.orchestrator.run(task.id)).toBe('completed');
    const done = (await h.store.getTask(task.id))!;
    expect(done.correctionRounds).toBe(1);
    const labels = (await h.store.listSnapshots(task.id)).map((s) => s.label);
    expect(labels).toEqual(['plan', 'dispatch', 'review-1', 'correction-1', 'review-2', 'merge']);
  });

  it('pauses durably for human approval and resumes without redoing steps', async () => {
    const h = orchestratorHarness();
    const task = await h.createTask({ requiresApproval: true });
    expect(await h.orchestrator.run(task.id)).toBe('paused');
    expect((await h.store.getTask(task.id))!.status).toBe('awaiting_approval');
    expect((await h.store.getApproval(task.id))!.status).toBe('pending');
    const stepsBefore = h.runtime.executedSteps;
    const usageBefore = (await h.store.listUsage(task.id)).length;

    await h.store.upsertApproval({ ...(await h.store.getApproval(task.id))!, status: 'approved' });
    expect(await h.orchestrator.run(task.id)).toBe('completed');
    expect((await h.store.listUsage(task.id)).length).toBe(usageBefore); // no model call repeated
    expect(h.runtime.executedSteps - stepsBefore).toBe(2); // only merge + its snapshot
  });

  it('ends as rejected when the human rejects', async () => {
    const h = orchestratorHarness();
    const task = await h.createTask({ requiresApproval: true });
    await h.orchestrator.run(task.id);
    await h.store.upsertApproval({ ...(await h.store.getApproval(task.id))!, status: 'rejected', note: 'escopo errado' });
    expect(await h.orchestrator.run(task.id)).toBe('rejected');
    expect((await h.store.getTask(task.id))!.error).toBe('escopo errado');
  });

  it('cuts the task automatically when the budget is exceeded', async () => {
    const h = orchestratorHarness();
    const task = await h.createTask({ budgetUsd: 0.0004 });
    expect(await h.orchestrator.run(task.id)).toBe('budget_exceeded');
    const t = (await h.store.getTask(task.id))!;
    expect(t.status).toBe('budget_exceeded');
    expect(t.spentUsd).toBeLessThanOrEqual(t.budgetUsd);
    const subtasks = await h.store.listSubtasks(task.id);
    expect(subtasks.some((s) => s.status === 'cancelled')).toBe(true);
    expect((await h.store.listOutbox()).some((e) => e.type === 'task.budget_exceeded')).toBe(true);
  });

  it('fails when every model is down and resumes from the journal after recovery', async () => {
    const h = orchestratorHarness();
    const task = await h.createTask();
    for (const m of h.catalog.list()) h.catalog.setHealthy(m.id, false);
    expect(await h.orchestrator.run(task.id)).toBe('failed');
    for (const m of h.catalog.list()) h.catalog.setHealthy(m.id, true);
    expect(await h.orchestrator.run(task.id)).toBe('completed');
  });

  it('does nothing when a finished task is started again', async () => {
    const h = orchestratorHarness();
    const task = await h.createTask();
    await h.orchestrator.run(task.id);
    const calls = (await h.store.listUsage()).length;
    const tools = h.tools.executions;
    expect(await h.orchestrator.run(task.id)).toBe('completed');
    expect((await h.store.listOutbox()).filter((e) => e.type === 'task.completed')).toHaveLength(1);
    expect((await h.store.listUsage()).length).toBe(calls);
    expect(h.tools.executions).toBe(tools);
  });
});
