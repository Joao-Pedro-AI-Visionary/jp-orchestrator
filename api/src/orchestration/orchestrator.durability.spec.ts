import { newId, sleep, stableId } from '../common/util';
import { LlmProvider, MockProvider } from '../gateway/llm-provider';
import { ModelSpec } from '../gateway/model-catalog';
import { MemoryStore } from '../persistence/memory.store';
import { crashOn, ProcessCrash } from '../test-utils/crash';
import { orchestratorHarness } from '../test-utils/harness';
import { ApprovalService } from '../approval/approval.service';
import { TaskBusyError } from './orchestrator.service';

/** Mock latency per call. `deaf` ignores the abort signal, like a client that cannot be cancelled. */
class SlowProvider implements LlmProvider {
  readonly key = 'mock';
  calls = 0;
  aborted = 0;
  private inner = new MockProvider(0);
  constructor(private readonly ms: number, private readonly deaf = false) {}
  async complete(model: ModelSpec, prompt: string, max: number, signal?: AbortSignal) {
    this.calls++;
    try {
      await sleep(this.ms, this.deaf ? undefined : signal);
    } catch (err) {
      this.aborted++;
      throw err;
    }
    return this.inner.complete(model, prompt, max);
  }
}

async function waitFor(cond: () => Promise<boolean> | boolean, ms = 3_000) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('condição não atingida a tempo');
    await sleep(5);
  }
}

const terminalEvents = async (store: MemoryStore) =>
  (await store.listOutbox()).map((e) => e.type).filter((t) => t.startsWith('task.'));

describe('Orchestrator: cancellation on timeout', () => {
  afterEach(() => {
    delete process.env.TASK_TIMEOUT_MS;
    delete process.env.SUBAGENT_TIMEOUT_MS;
  });

  it('a task timeout aborts the in-flight calls and ends with exactly one terminal event', async () => {
    process.env.TASK_TIMEOUT_MS = '80';
    const provider = new SlowProvider(30);
    const h = orchestratorHarness(provider);
    const task = await h.createTask();

    expect(await h.orchestrator.run(task.id)).toBe('failed');
    const usageAtFail = (await h.store.listUsage(task.id)).length;
    expect(provider.aborted).toBeGreaterThan(0);

    await sleep(150); // a zombie loop would complete the task in this window
    const t = (await h.store.getTask(task.id))!;
    expect(t.status).toBe('failed');
    expect(t.error).toMatch(/tarefa excedeu o timeout de 80ms/);
    expect(await terminalEvents(h.store)).toEqual(['task.failed']);
    expect((await h.store.listUsage(task.id)).length).toBe(usageAtFail);
    const subtasks = await h.store.listSubtasks(task.id);
    expect(subtasks.some((s) => s.status === 'cancelled')).toBe(true);
    expect(subtasks.every((s) => s.status !== 'running' && s.status !== 'pending')).toBe(true);
  });

  it('a run that ignores the signal: failed at once, never completed later, and /resume waits for it to stop (here and on another replica)', async () => {
    process.env.TASK_TIMEOUT_MS = '50';
    const h = orchestratorHarness(new SlowProvider(150, true), { abortGraceMs: 2_000 });
    const task = await h.createTask();

    const run = h.orchestrator.start(task.id);
    await waitFor(async () => (await h.store.getTask(task.id))!.status === 'failed');
    await expect(h.orchestrator.resume(task.id)).rejects.toBeInstanceOf(TaskBusyError);
    const replica = orchestratorHarness(new MockProvider(0), { store: h.store });
    await expect(replica.orchestrator.resume(task.id)).rejects.toBeInstanceOf(TaskBusyError);

    expect(await run).toBe('failed'); // resolves once the zombie stopped
    expect((await h.store.getTask(task.id))!.status).toBe('failed');
    expect(await terminalEvents(h.store)).toEqual(['task.failed']);
    expect(await h.store.getTaskLease(task.id)).toBeNull();

    delete process.env.TASK_TIMEOUT_MS;
    expect((await replica.orchestrator.resume(task.id)).status).toBe('running');
    await waitFor(async () => (await h.store.getTask(task.id))!.status === 'completed');
    expect(await terminalEvents(h.store)).toEqual(['task.failed', 'task.completed']);
  });

  it('a subagent timeout aborts that attempt before the retry starts (no overlap)', async () => {
    process.env.SUBAGENT_TIMEOUT_MS = '40';
    const signals: AbortSignal[] = [];
    let active = 0;
    let peak = 0;
    const inner = new MockProvider(0);
    const provider: LlmProvider = {
      key: 'mock',
      async complete(model, prompt, max, signal) {
        if (!prompt.startsWith('AGENTE: researcher')) return inner.complete(model, prompt, max);
        active++;
        peak = Math.max(peak, active);
        try {
          signals.push(signal!);
          if (signals.length === 1) await new Promise((_, reject) => signal!.addEventListener('abort', () => reject(signal!.reason)));
          return await inner.complete(model, prompt, max);
        } finally {
          active--;
        }
      },
    };
    const h = orchestratorHarness(provider);
    const task = await h.createTask();

    expect(await h.orchestrator.run(task.id)).toBe('completed');
    expect(signals).toHaveLength(2);
    expect(signals[0].aborted).toBe(true);
    expect(signals[0].reason).toMatchObject({ message: expect.stringMatching(/subagente researcher excedeu o timeout de 40ms/) });
    expect(peak).toBe(1);
  });
});

describe('Orchestrator: execution lease', () => {
  it('two replicas resuming on boot run each task once', async () => {
    const a = orchestratorHarness(new SlowProvider(5));
    const b = orchestratorHarness(new SlowProvider(5), { store: a.store });
    const task = await a.createTask();

    await Promise.all([a.orchestrator.resumeActive(), b.orchestrator.resumeActive()]);
    await waitFor(() => !a.orchestrator.isRunning(task.id) && !b.orchestrator.isRunning(task.id));

    expect((await a.store.getTask(task.id))!.status).toBe('completed');
    expect(await terminalEvents(a.store)).toEqual(['task.completed']);
    const usage = await a.store.listUsage(task.id);
    expect(usage.filter((u) => u.subtaskId === null)).toHaveLength(1); // one planner call
    for (const s of await a.store.listSubtasks(task.id)) {
      expect(usage.filter((u) => u.subtaskId === s.id)).toHaveLength(1);
    }
  });

  it('concurrent runs of one task: one runs, the other is busy and does nothing', async () => {
    const a = orchestratorHarness(new SlowProvider(5));
    const b = orchestratorHarness(new SlowProvider(5), { store: a.store });
    const task = await a.createTask();
    const outcomes = await Promise.all([a.orchestrator.run(task.id), b.orchestrator.run(task.id)]);
    expect(outcomes.sort()).toEqual(['busy', 'completed']);
    expect(await terminalEvents(a.store)).toEqual(['task.completed']);
  });

  it('crash after saving the plan: the next owner waits for the lease, takes over and reuses the same subtask ids', async () => {
    const db = new MemoryStore();
    const a = orchestratorHarness(undefined, { store: crashOn(db, 'putStep'), leaseMs: 100 });
    const task = await a.createTask();
    await expect(a.orchestrator.run(task.id)).rejects.toBeInstanceOf(ProcessCrash);
    const planned = await db.listSubtasks(task.id);
    expect(planned.length).toBeGreaterThan(0);
    expect(planned.map((s) => s.id)).toEqual(planned.map((_, i) => stableId(task.id, 'subtask', i)));

    const b = orchestratorHarness(undefined, { store: db, leaseMs: 100 });
    expect(await b.orchestrator.run(task.id)).toBe('busy'); // the dead owner's lease is still live
    await sleep(120);
    expect(await b.orchestrator.run(task.id)).toBe('completed');
    const after = await db.listSubtasks(task.id);
    expect(after.map((s) => s.id)).toEqual(planned.map((s) => s.id));
    expect(after.every((s) => s.status === 'done')).toBe(true);
  });

  it('a lost lease stops the run without a status write or terminal event', async () => {
    const h = orchestratorHarness(new SlowProvider(20), { leaseMs: 60 });
    const task = await h.createTask();
    const run = h.orchestrator.run(task.id);
    await waitFor(async () => (await h.store.getTaskLease(task.id)) !== null);
    // Another owner takes over (e.g. this replica stalled past its lease).
    const lease = (await h.store.getTaskLease(task.id))!;
    await h.store.renewTaskLease(task.id, lease, -1_000);
    expect(await h.store.acquireTaskLease(task.id, 'other-replica', 60_000)).not.toBeNull();

    expect(await run).toBe('busy');
    expect(await terminalEvents(h.store)).toEqual([]);
    expect((await h.store.getTaskLease(task.id))!.owner).toBe('other-replica');
  });

  it('shutdown stops a run without failing it and hands the lease back at once', async () => {
    const a = orchestratorHarness(new SlowProvider(30));
    const b = orchestratorHarness(new MockProvider(0), { store: a.store });
    const task = await a.createTask();
    const run = a.orchestrator.start(task.id);
    await waitFor(async () => (await a.store.getTask(task.id))!.status === 'running');

    await a.orchestrator.onModuleDestroy();
    expect(await run).toBe('busy');
    expect((await a.store.getTask(task.id))!.status).toBe('running');
    expect(await a.store.getTaskLease(task.id)).toBeNull();
    expect(await terminalEvents(a.store)).toEqual([]);

    expect(await b.orchestrator.run(task.id)).toBe('completed');
    expect(await terminalEvents(a.store)).toEqual(['task.completed']);
  });
});

describe('Orchestrator: approval decided while the paused run still holds the lease', () => {
  it('same replica: the continuation waits for the paused run and then completes', async () => {
    const db = new MemoryStore();
    let openGate: () => void = () => undefined;
    const gate = new Promise<void>((r) => { openGate = r; });
    // The paused run is slow to hand back its lease (one slow round trip).
    const slowRelease = new Proxy(db, {
      get(obj, prop, receiver) {
        const v = Reflect.get(obj, prop, receiver);
        if (prop !== 'releaseTaskLease' || typeof v !== 'function') return typeof v === 'function' ? v.bind(obj) : v;
        return async (...args: unknown[]) => { await gate; return v.apply(obj, args); };
      },
    });
    const h = orchestratorHarness(undefined, { store: slowRelease });
    const task = await h.createTask({ requiresApproval: true });
    const paused = h.orchestrator.start(task.id);
    await waitFor(async () => (await db.getTask(task.id))!.status === 'awaiting_approval');
    expect(h.orchestrator.isRunning(task.id)).toBe(true);

    await new ApprovalService(db, h.bus).resolve(task.id, 'approved', null);
    const continued = h.orchestrator.continueAfterApproval(task.id);
    openGate();
    expect(await paused).toBe('paused');
    expect(await continued).toBe('completed');
    expect(await terminalEvents(db)).toEqual(['task.completed']);
  });

  it('other replica: the decision lands while the lease is stuck, and the sweep finishes the task once it expires', async () => {
    const db = new MemoryStore();
    const a = orchestratorHarness(undefined, { store: crashOn(db, 'releaseTaskLease'), leaseMs: 100 });
    const task = await a.createTask({ requiresApproval: true });
    expect(await a.orchestrator.run(task.id)).toBe('paused'); // lease never released: the process died right after

    const b = orchestratorHarness(undefined, { store: db, leaseMs: 100 });
    await new ApprovalService(db, b.bus).resolve(task.id, 'rejected', 'escopo errado');
    expect(await b.orchestrator.continueAfterApproval(task.id)).toBe('busy');
    expect((await db.getTask(task.id))!.status).toBe('awaiting_approval');

    await sleep(120);
    expect(await b.orchestrator.resumeActive()).toBe(1);
    await waitFor(async () => (await db.getTask(task.id))!.status === 'rejected');
    expect((await db.getTask(task.id))!.error).toBe('escopo errado');
    expect(await terminalEvents(db)).toEqual(['task.rejected']);
  });

  it('the sweep leaves a task whose approval is still pending alone', async () => {
    const h = orchestratorHarness();
    const task = await h.createTask({ requiresApproval: true });
    expect(await h.orchestrator.run(task.id)).toBe('paused');
    expect(await h.orchestrator.resumeActive()).toBe(0);
    expect(h.orchestrator.isRunning(task.id)).toBe(false);
  });

  it('a run releases only reservations older than the task timeout: a younger one may still be in flight', async () => {
    const h = orchestratorHarness();
    const task = await h.createTask();
    const release = jest.spyOn(h.store, 'releaseTaskReservations');
    expect(await h.store.reserveBudget(newId(), task.id, task.budgetUsd)).toMatchObject({ reserved: true });
    process.env.TASK_TIMEOUT_MS = '60000';
    try {
      // The young reservation is kept, so the run has no budget left.
      expect(await h.orchestrator.run(task.id)).toBe('budget_exceeded');
    } finally {
      delete process.env.TASK_TIMEOUT_MS;
    }
    expect(release).toHaveBeenCalledWith(task.id, 60_000);
  });
});
