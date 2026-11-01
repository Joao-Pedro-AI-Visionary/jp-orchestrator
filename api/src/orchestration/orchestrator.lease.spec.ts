import { LlmProvider, MockProvider } from '../gateway/llm-provider';
import { ModelSpec } from '../gateway/model-catalog';
import { JournalRuntime } from '../durable/journal.runtime';
import { MemoryStore } from '../persistence/memory.store';
import { orchestratorHarness } from '../test-utils/harness';
import { sleep } from '../common/util';
import { Orchestrator } from './orchestrator.service';

const TERMINAL_EVENTS = ['task.completed', 'task.failed', 'task.rejected', 'task.budget_exceeded'];

/** Provider with latency. `cooperative` honors the abort signal; otherwise it ignores it. */
class SlowProvider implements LlmProvider {
  readonly key = 'mock';
  started = 0;
  startedAfterAbort = 0;
  aborted = false;
  private inner = new MockProvider(0);
  constructor(private readonly ms: number, private readonly cooperative = true) {}
  async complete(model: ModelSpec, prompt: string, max: number, signal?: AbortSignal) {
    this.started++;
    if (this.aborted) this.startedAfterAbort++;
    signal?.addEventListener('abort', () => { this.aborted = true; }, { once: true });
    await sleep(this.ms, this.cooperative ? signal : undefined);
    return this.inner.complete(model, prompt, max);
  }
}

async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

const terminalEvents = async (h: ReturnType<typeof orchestratorHarness>, taskId: string) =>
  (await h.store.listOutbox()).filter((e) => e.payload.taskId === taskId && TERMINAL_EVENTS.includes(e.type));

/** A second "replica": its own orchestrator on the same store. */
const replica = (h: ReturnType<typeof orchestratorHarness>) =>
  new Orchestrator(h.store, new JournalRuntime(h.store), (h.orchestrator as unknown as { planner: never }).planner,
    h.dispatcher, h.context, h.memory, h.bus);

describe('Orchestrator task timeout (H1)', () => {
  it.each([
    ['honors the signal', true],
    ['ignores the signal', false],
  ])('aborts the loop when the provider %s: one terminal event, no new calls, guard held until the loop stops', async (_l, cooperative) => {
    const provider = new SlowProvider(60, cooperative);
    const h = orchestratorHarness(provider);
    const task = await h.createTask();

    const outcome = await withEnv({ TASK_TIMEOUT_MS: '100' }, () => h.orchestrator.start(task.id));
    expect(outcome).toBe('failed');
    // When run() returns the loop has stopped and the lease is free again.
    expect(await h.store.isTaskLeased(task.id)).toBe(false);
    const usageAtFail = (await h.store.listUsage(task.id)).length;

    await sleep(400); // a zombie loop would finish and write task.completed in this window
    const t = (await h.store.getTask(task.id))!;
    expect(t.status).toBe('failed');
    expect(t.error).toMatch(/timeout/);
    const events = await terminalEvents(h, task.id);
    expect(events.map((e) => e.type)).toEqual(['task.failed']);
    expect(provider.startedAfterAbort).toBe(0);
    if (cooperative) expect((await h.store.listUsage(task.id)).length).toBe(usageAtFail);
    const subtasks = await h.store.listSubtasks(task.id);
    expect(subtasks.some((s) => s.status === 'running')).toBe(false);
    expect(subtasks.filter((s) => s.agent === 'reviewer').every((s) => s.status === 'cancelled')).toBe(true);
  });

  it('never writes a second terminal state over a finished task', async () => {
    const h = orchestratorHarness();
    const task = await h.createTask();
    expect(await h.orchestrator.run(task.id)).toBe('completed');
    const fail = (h.orchestrator as unknown as { fail(id: string, e: Error): Promise<string> }).fail.bind(h.orchestrator);
    expect(await fail(task.id, new Error('late'))).toBe('completed');
    expect((await terminalEvents(h, task.id)).map((e) => e.type)).toEqual(['task.completed']);
    expect((await h.store.getTask(task.id))!.status).toBe('completed');
  });
});

describe('Orchestrator task lease (H2)', () => {
  it('runs a task once when two replicas start it at the same time', async () => {
    const h = orchestratorHarness(new SlowProvider(10));
    const other = replica(h);
    const task = await h.createTask();

    const outcomes = await Promise.all([h.orchestrator.run(task.id), other.run(task.id)]);
    expect(outcomes.sort()).toEqual(['completed', 'leased']);
    const usage = await h.store.listUsage(task.id);
    expect(usage.filter((u) => u.agent === 'researcher')).toHaveLength(1); // one researcher in the plan, run once
    expect((await h.store.listSubtasks(task.id)).length).toBe(5);
    expect((await terminalEvents(h, task.id)).map((e) => e.type)).toEqual(['task.completed']);
  });

  it('resumeActive only resumes the tasks whose lease it acquires', async () => {
    const h = orchestratorHarness(new SlowProvider(10));
    const other = replica(h);
    const a = await h.createTask();
    const b = await h.createTask();
    expect(await h.store.acquireTaskLease(b.id, 'replica-3', 60_000)).toBe(true);

    const [mine, theirs] = await Promise.all([h.orchestrator.resumeActive(), other.resumeActive()]);
    expect(mine + theirs).toBe(1);
    expect(await h.orchestrator.isRunningAnywhere(b.id)).toBe(true);
    await sleep(10);
    while (await h.store.isTaskLeased(a.id)) await sleep(10);
    expect((await h.store.getTask(a.id))!.status).toBe('completed');
    expect((await h.store.getTask(b.id))!.status).toBe('queued');
    expect((await h.store.listUsage(a.id)).filter((u) => u.agent === 'researcher')).toHaveLength(1);
  });

  it('stops without a terminal event when the lease is lost to another runner', async () => {
    const h = await withEnv({ TASK_LEASE_MS: '90' }, async () => orchestratorHarness(new SlowProvider(40)));
    const task = await h.createTask();
    const run = h.orchestrator.run(task.id);
    await sleep(20);
    await h.store.releaseTaskLease(task.id, h.orchestrator.owner);
    expect(await h.store.acquireTaskLease(task.id, 'intruder', 60_000)).toBe(true);

    expect(await run).toBe('leased');
    expect(await terminalEvents(h, task.id)).toHaveLength(0);
    expect(await h.store.isTaskLeased(task.id)).toBe(true); // still the intruder's
  });

  it('resumeActive and an HTTP start racing in the same process share one run and free the lease', async () => {
    const h = orchestratorHarness(new SlowProvider(10));
    const task = await h.createTask();
    // resumeActive took the lease, then an HTTP approve/resume started the task before resumeActive's start().
    expect(await h.store.acquireTaskLease(task.id, h.orchestrator.owner, 60_000)).toBe(true);
    const http = h.orchestrator.start(task.id);
    const boot = h.orchestrator.start(task.id, true);
    expect(boot).toBe(http);
    expect(await http).toBe('completed');
    expect(await h.store.isTaskLeased(task.id)).toBe(false);
    expect((await terminalEvents(h, task.id)).map((e) => e.type)).toEqual(['task.completed']);
  });

  it('a runner that lost the plan race stores no second set of subtasks', async () => {
    const h = orchestratorHarness();
    const task = await h.createTask();
    await h.store.putStep(task.id, 'plan', []);
    const rt = new JournalRuntime(h.store);
    // Simulates the loser: its step result is discarded in favor of the journaled one.
    expect(await rt.context(task.id).run('plan', async () => [{ id: 'loser' }])).toEqual([]);
    expect(await h.orchestrator.run(task.id)).toBe('failed'); // empty journaled plan: no reviewer
    expect(await h.store.listSubtasks(task.id)).toHaveLength(0);
  });

  it('expires a dead holder lease so another runner can take over', async () => {
    const h = orchestratorHarness();
    const store = h.store;
    expect(await store.acquireTaskLease('missing', 'a', 30)).toBe(false);
    const t = (await h.createTask()).id;
    expect(await store.acquireTaskLease(t, 'a', 30)).toBe(true);
    expect(await store.acquireTaskLease(t, 'a', 30)).toBe(true); // re-entry by the holder
    expect(await store.acquireTaskLease(t, 'b', 30)).toBe(false);
    expect(await store.renewTaskLease(t, 'b', 30)).toBe(false);
    await sleep(40);
    expect(await store.acquireTaskLease(t, 'b', 30)).toBe(true);
    expect(await store.renewTaskLease(t, 'a', 30)).toBe(false);
  });
});

describe('JournalRuntime concurrent step (H2)', () => {
  it('first writer wins and the loser adopts the journaled value', async () => {
    const store = new MemoryStore();
    const rt = new JournalRuntime(store);
    const [a, b] = await Promise.all([
      rt.context('t').run('plan', async () => { await sleep(5); return { ids: ['a'] }; }),
      rt.context('t').run('plan', async () => { await sleep(15); return { ids: ['b'] }; }),
    ]);
    expect(a).toEqual({ ids: ['a'] });
    expect(b).toEqual({ ids: ['a'] });
    expect((await store.getStep('t', 'plan'))!.value).toEqual({ ids: ['a'] });
  });
});
