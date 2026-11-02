import { ApprovalService } from '../approval/approval.service';
import { BudgetExceededError } from '../billing/billing.service';
import { sleep } from '../common/util';
import { LlmProvider, MockProvider } from '../gateway/llm-provider';
import { ModelSpec } from '../gateway/model-catalog';
import { TaskBusyError, TaskNotResumableError } from '../orchestration/orchestrator.service';
import { orchestratorHarness } from '../test-utils/harness';
import { FakeRestate, restateTestConfig } from '../test-utils/restate-fake';
import { RestateConfig } from './durable.config';
import { RestateRuntime } from './restate.runtime';

class SlowProvider implements LlmProvider {
  readonly key = 'mock';
  failReviewer = false;
  private inner = new MockProvider(0);
  constructor(private readonly ms = 0) {}
  async complete(model: ModelSpec, prompt: string, max: number, signal?: AbortSignal) {
    if (this.failReviewer && prompt.includes('CODIGO:')) throw new Error('revisor indisponível');
    if (this.ms) await sleep(this.ms, signal);
    return this.inner.complete(model, prompt, max);
  }
}

async function waitFor(cond: () => Promise<boolean> | boolean, ms = 4_000) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('condição não atingida a tempo');
    await sleep(5);
  }
}

function restateHarness(provider: LlmProvider = new SlowProvider(), cfg: Partial<RestateConfig> = {}) {
  const fake = new FakeRestate();
  const h = orchestratorHarness(provider, {
    runtime: () => {
      const rt = new RestateRuntime(restateTestConfig(cfg), { ingress: fake, race: fake.race });
      fake.attach(rt);
      return rt;
    },
  });
  const status = async (id: string) => (await h.store.getTask(id))!.status;
  const until = (id: string, s: string) => waitFor(async () => (await status(id)) === s);
  const callsBy = async (id: string, agent: string) => (await h.store.listUsage(id)).filter((u) => u.agent === agent).length;
  const terminalEvents = async () => (await h.store.listOutbox()).map((e) => e.type).filter((t) => t.startsWith('task.'));
  return { ...h, fake, approvals: new ApprovalService(h.store, h.bus), status, until, callsBy, terminalEvents };
}

describe('RestateRuntime (FakeRestate)', () => {
  it('a process crash mid-run replays the journal: completed steps are not called again', async () => {
    const h = restateHarness(new SlowProvider(20));
    const task = await h.createTask();

    expect(await h.orchestrator.start(task.id)).toBe('submitted');
    await waitFor(async () => (await h.callsBy(task.id, 'researcher')) > 0);
    h.fake.crash(task.id);
    await h.until(task.id, 'completed');

    expect(h.fake.workflows.get(task.id)!.attempts).toBe(2);
    expect(await h.callsBy(task.id, 'planner')).toBe(1);
    expect(await h.terminalEvents()).toEqual(['task.completed']);
    expect(await h.fake.output(task.id)).toBe('completed');
  });

  it('a crash while awaiting approval replays deterministically and the approval still completes the task', async () => {
    const h = restateHarness();
    const task = await h.createTask({ requiresApproval: true });

    await h.orchestrator.start(task.id);
    await h.until(task.id, 'awaiting_approval');
    h.fake.crash(task.id);
    await sleep(30);
    expect(await h.status(task.id)).toBe('awaiting_approval'); // the replay took the recorded path, no flicker

    await h.approvals.resolve(task.id, 'approved', null, 'ana');
    expect(await h.orchestrator.continueAfterApproval(task.id)).toBe('completed');
    expect(await h.callsBy(task.id, 'planner')).toBe(1);
    expect((await h.store.listOutbox()).filter((e) => e.type === 'approval.requested' || e.type === 'task.completed')).toHaveLength(1);
  });

  it('resumeActive re-delivers a decided approval whose signal was lost (idempotent)', async () => {
    const h = restateHarness();
    const task = await h.createTask({ requiresApproval: true });
    await h.orchestrator.start(task.id);
    await h.until(task.id, 'awaiting_approval');

    await h.approvals.resolve(task.id, 'approved', null, 'ana'); // decision stored, signal never sent
    expect(await h.orchestrator.resumeActive()).toBe(1);
    await h.until(task.id, 'completed');
    await h.orchestrator.resumeActive(); // nothing left: no second delivery, no second run
    expect(await h.terminalEvents()).toEqual(['task.completed']);
  });

  it('an approval signal that does not get through is logged, not thrown; the sweep delivers it later', async () => {
    const h = restateHarness();
    const task = await h.createTask({ requiresApproval: true });
    await h.orchestrator.start(task.id);
    await h.until(task.id, 'awaiting_approval');
    await h.approvals.resolve(task.id, 'approved', null, 'ana');

    jest.spyOn(h.fake, 'approve').mockRejectedValueOnce(new Error('restate fora'));
    await expect(h.orchestrator.continueAfterApproval(task.id)).resolves.toBe('submitted');
    expect(await h.status(task.id)).toBe('awaiting_approval');
    await h.orchestrator.resumeActive();
    await h.until(task.id, 'completed');
  });

  it('an approve signal without a stored decision does not loop: the task pauses again on the next promise', async () => {
    const h = restateHarness();
    const task = await h.createTask({ requiresApproval: true });
    await h.orchestrator.start(task.id);
    await h.until(task.id, 'awaiting_approval');

    await Promise.all([h.fake.approve(task.id), h.fake.approve(task.id)]); // spurious and concurrent: both delivered
    await sleep(50);
    const wf = h.fake.workflows.get(task.id)!;
    const entries = wf.journal.length;
    await sleep(50);
    expect(wf.journal.length).toBe(entries); // parked again, not spinning
    expect(await h.status(task.id)).toBe('awaiting_approval');
    expect(await h.callsBy(task.id, 'planner')).toBe(1);

    await h.approvals.resolve(task.id, 'approved', null, 'ana');
    await h.orchestrator.continueAfterApproval(task.id);
    await h.until(task.id, 'completed');
    expect(await h.terminalEvents()).toEqual(['task.completed']);
  });

  it('an execution for a task that does not exist ends for good (no Restate retries)', async () => {
    const h = restateHarness();
    await h.fake.submit('00000000-0000-4000-8000-000000000000');
    await expect(h.fake.output('00000000-0000-4000-8000-000000000000')).rejects.toThrow(/não encontrada/);
    expect(h.fake.workflows.get('00000000-0000-4000-8000-000000000000')!.attempts).toBe(1);
  });

  it('/resume of a failed task that has no execution in Restate (e.g. failed under the journal runtime) is refused', async () => {
    const h = restateHarness();
    const task = await h.createTask();
    await h.store.updateTask(task.id, { status: 'failed', error: 'antes da troca de runtime' });
    await expect(h.orchestrator.resume(task.id)).rejects.toBeInstanceOf(TaskNotResumableError);
    expect(await h.status(task.id)).toBe('failed');
  });

  it('the sweep fails an active task whose execution already closed (nobody left to finish it)', async () => {
    const provider = new SlowProvider();
    provider.failReviewer = true;
    const h = restateHarness(provider, { resumeWindowMs: 30 });
    const task = await h.createTask();
    await h.orchestrator.start(task.id);
    await waitFor(() => h.fake.closed(task.id));
    await h.store.updateTask(task.id, { status: 'running' }); // e.g. a /resume signal that raced the window

    await h.orchestrator.resumeActive();
    await h.until(task.id, 'failed');
    expect((await h.store.getTask(task.id))!.error).toMatch(/encerrada sem concluir/);
    expect(await h.terminalEvents()).toEqual(['task.failed', 'task.failed']);
  });

  it('a Restate cancel fails the task with the abort propagated, closes the execution and refuses /resume', async () => {
    const provider = new SlowProvider(200);
    const h = restateHarness(provider);
    const task = await h.createTask();

    await h.orchestrator.start(task.id);
    await waitFor(async () => (await h.callsBy(task.id, 'planner')) > 0);
    h.fake.cancel(task.id);
    await h.until(task.id, 'failed');

    expect((await h.store.getTask(task.id))!.error).toMatch(/cancelada/);
    await waitFor(() => h.fake.closed(task.id));
    await expect(h.orchestrator.resume(task.id)).rejects.toBeInstanceOf(TaskNotResumableError);
    expect(await h.terminalEvents()).toEqual(['task.failed']);
  });

  it('/resume: busy while running, refused after the resume window closed', async () => {
    const provider = new SlowProvider(40);
    provider.failReviewer = true;
    const h = restateHarness(provider, { resumeWindowMs: 60 });
    const task = await h.createTask();

    await h.orchestrator.start(task.id);
    await h.until(task.id, 'running');
    await expect(h.orchestrator.resume(task.id)).rejects.toBeInstanceOf(TaskBusyError);
    await h.until(task.id, 'failed');
    await waitFor(() => h.fake.closed(task.id)); // nobody resumed within 60ms
    expect(await h.fake.output(task.id)).toBe('failed');
    await expect(h.orchestrator.resume(task.id)).rejects.toBeInstanceOf(TaskNotResumableError);
  });

  it('two concurrent /resume calls: one wins and the engine gets exactly one resume signal', async () => {
    const provider = new SlowProvider();
    provider.failReviewer = true;
    const h = restateHarness(provider);
    const task = await h.createTask();
    await h.orchestrator.start(task.id);
    await h.until(task.id, 'failed');
    provider.failReviewer = false;

    const results = await Promise.allSettled([h.orchestrator.resume(task.id), h.orchestrator.resume(task.id)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    await h.until(task.id, 'completed');
    const wf = h.fake.workflows.get(task.id)!;
    expect([...wf.promises.keys()].filter((k) => k.startsWith('resume:') && wf.promises.get(k)!.resolved)).toEqual(['resume:0']);
  });

  it('a resume signal that does not get through puts the task back to failed', async () => {
    const provider = new SlowProvider();
    provider.failReviewer = true;
    const h = restateHarness(provider);
    const task = await h.createTask();
    await h.orchestrator.start(task.id);
    await h.until(task.id, 'failed');
    const error = (await h.store.getTask(task.id))!.error;

    jest.spyOn(h.fake, 'resume').mockRejectedValueOnce(new Error('restate fora'));
    await expect(h.orchestrator.resume(task.id)).rejects.toThrow('restate fora');
    expect(await h.store.getTask(task.id)).toMatchObject({ status: 'failed', error });
  });

  it('a journaled failure keeps its kind after a replay (budget stays budget)', async () => {
    const fake = new FakeRestate();
    const rt = new RestateRuntime(restateTestConfig(), { ingress: fake, race: fake.race });
    fake.attach(rt);
    const seen: string[] = [];
    let executions = 0;
    rt.bind(async (_id, exec) => {
      const pass = exec.pass(10_000);
      try {
        await pass.ctx.run('charge', async () => { executions++; throw new BudgetExceededError('t', 2, 1); });
      } catch (err) {
        seen.push(err instanceof BudgetExceededError ? 'budget' : 'other');
      }
      await exec.awaitApproval(); // park the execution so it can be crashed and replayed
      return 'done';
    });

    await fake.submit('t');
    await waitFor(() => seen.length === 1);
    fake.crash('t');
    await waitFor(() => seen.length === 2);
    expect(seen).toEqual(['budget', 'budget']);
    expect(executions).toBe(1);
    await fake.approve('t');
    expect(await fake.output('t')).toBe('done');
  });

  it('fails clearly when the workflow runs before the orchestrator is bound', async () => {
    const fake = new FakeRestate();
    fake.attach(new RestateRuntime(restateTestConfig(), { ingress: fake, race: fake.race }));
    await fake.submit('x');
    await expect(fake.output('x')).rejects.toThrow(/não ligado/);
  });
});
