import { ApprovalService } from '../approval/approval.service';
import { sleep } from '../common/util';
import { LlmProvider, MockProvider } from '../gateway/llm-provider';
import { ModelSpec } from '../gateway/model-catalog';
import { MemoryStore } from '../persistence/memory.store';
import { orchestratorHarness } from '../test-utils/harness';
import { FakeRestate, restateTestConfig } from '../test-utils/restate-fake';
import { AnyDurableRuntime } from './durable-runtime';
import { JournalRuntime } from './journal.runtime';
import { RestateRuntime } from './restate.runtime';

/**
 * Behavioral contract every DURABLE_RUNTIME must honor, run through the real Orchestrator:
 * the same scenarios against the journal runtime and the Restate adapter (on FakeRestate,
 * the in-process stand-in for the server; the real server runs in restate.integration.spec.ts).
 */
interface RuntimeUnderTest {
  name: string;
  make(store: MemoryStore): AnyDurableRuntime;
  fake?: FakeRestate;
}

const journal = (): RuntimeUnderTest => ({ name: 'journal', make: (store) => new JournalRuntime(store) });
const restateFake = (): RuntimeUnderTest => {
  const fake = new FakeRestate();
  return {
    name: 'restate',
    fake,
    make: () => {
      const rt = new RestateRuntime(restateTestConfig(), { ingress: fake, race: fake.race });
      fake.attach(rt);
      return rt;
    },
  };
};

/** MockProvider that can fail the reviewer (its prompt carries CODIGO:), or be slow and count aborts. */
class ScriptedProvider implements LlmProvider {
  readonly key = 'mock';
  failReviewer = false;
  aborted = 0;
  private inner = new MockProvider(0);
  constructor(private readonly latencyMs = 0) {}
  async complete(model: ModelSpec, prompt: string, max: number, signal?: AbortSignal) {
    if (this.failReviewer && prompt.includes('CODIGO:')) throw new Error('revisor indisponível');
    if (this.latencyMs) {
      try {
        await sleep(this.latencyMs, signal);
      } catch (err) {
        this.aborted++;
        throw err;
      }
    }
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

function setup(rt: RuntimeUnderTest, provider: LlmProvider = new ScriptedProvider()) {
  const h = orchestratorHarness(provider, { runtime: rt.make });
  const approvals = new ApprovalService(h.store, h.bus);
  const status = async (id: string) => (await h.store.getTask(id))!.status;
  const until = (id: string, s: string) => waitFor(async () => (await status(id)) === s);
  const callsBy = async (id: string, agent: string) => (await h.store.listUsage(id)).filter((u) => u.agent === agent).length;
  const terminalEvents = async () => (await h.store.listOutbox()).map((e) => e.type).filter((t) => t.startsWith('task.'));
  return { ...h, approvals, status, until, callsBy, terminalEvents };
}

describe.each([journal, restateFake])('DurableRuntime contract (%p)', (make) => {
  let rt: RuntimeUnderTest;
  beforeEach(() => { rt = make(); });
  afterEach(() => { delete process.env.TASK_TIMEOUT_MS; });

  it('completed steps are not re-executed when a failed task resumes', async () => {
    const provider = new ScriptedProvider();
    provider.failReviewer = true;
    const h = setup(rt, provider);
    const task = await h.createTask();

    void h.orchestrator.start(task.id);
    await h.until(task.id, 'failed');
    expect((await h.store.getTask(task.id))!.error).toMatch(/revisor indisponível|indispon/i);
    const before = { planner: await h.callsBy(task.id, 'planner'), coder: await h.callsBy(task.id, 'coder'), tester: await h.callsBy(task.id, 'tester') };
    expect(before.planner).toBe(1);

    provider.failReviewer = false;
    await h.orchestrator.resume(task.id);
    await h.until(task.id, 'completed');

    // plan and the dispatch waves came from the journal: no second planner/coder/tester call
    expect(await h.callsBy(task.id, 'planner')).toBe(before.planner);
    expect(await h.callsBy(task.id, 'coder')).toBe(before.coder);
    expect(await h.callsBy(task.id, 'tester')).toBe(before.tester);
    expect(await h.terminalEvents()).toEqual(['task.failed', 'task.completed']);
  });

  it('approval: the task waits durably, then an approval completes it with the approver recorded', async () => {
    const h = setup(rt);
    const task = await h.createTask({ requiresApproval: true });

    void h.orchestrator.start(task.id);
    await h.until(task.id, 'awaiting_approval');
    await sleep(30);
    expect(await h.status(task.id)).toBe('awaiting_approval'); // nothing moves without a decision

    await h.approvals.resolve(task.id, 'approved', 'ok', 'ana');
    await h.orchestrator.continueAfterApproval(task.id);
    await h.until(task.id, 'completed');

    expect(await h.callsBy(task.id, 'planner')).toBe(1);
    const done = (await h.store.listOutbox()).find((e) => e.type === 'task.completed')!;
    expect(done.payload).toMatchObject({ decidedBy: 'ana' });
    expect(await h.terminalEvents()).toEqual(['task.completed']);
  });

  it('approval: a rejection ends the task as rejected with the note', async () => {
    const h = setup(rt);
    const task = await h.createTask({ requiresApproval: true });

    void h.orchestrator.start(task.id);
    await h.until(task.id, 'awaiting_approval');
    await h.approvals.resolve(task.id, 'rejected', 'escopo errado', 'bia');
    await h.orchestrator.continueAfterApproval(task.id);
    await h.until(task.id, 'rejected');

    const t = (await h.store.getTask(task.id))!;
    expect(t.error).toBe('escopo errado');
    expect(t.result).toBeNull();
    expect(await h.terminalEvents()).toEqual(['task.rejected']);
  });

  it('timeout: the task fails once, the in-flight calls see the abort and nothing completes later', async () => {
    process.env.TASK_TIMEOUT_MS = '80';
    const provider = new ScriptedProvider(30);
    const h = setup(rt, provider);
    const task = await h.createTask();

    void h.orchestrator.start(task.id);
    await h.until(task.id, 'failed');
    await waitFor(() => provider.aborted > 0);

    await sleep(150); // a zombie run would complete the task in this window
    const t = (await h.store.getTask(task.id))!;
    expect(t.status).toBe('failed');
    expect(t.error).toMatch(/tarefa excedeu o timeout de 80ms/);
    expect(await h.terminalEvents()).toEqual(['task.failed']);
    const subtasks = await h.store.listSubtasks(task.id);
    expect(subtasks.every((s) => s.status !== 'running' && s.status !== 'pending')).toBe(true);
  });

  it('duplicate starts of the same task run it once', async () => {
    const h = setup(rt);
    const task = await h.createTask();

    await Promise.all([h.orchestrator.start(task.id), h.orchestrator.start(task.id), h.orchestrator.start(task.id)]);
    await h.until(task.id, 'completed');
    await h.orchestrator.start(task.id); // a late duplicate after completion changes nothing
    await sleep(20);

    expect(await h.callsBy(task.id, 'planner')).toBe(1);
    expect(await h.terminalEvents()).toEqual(['task.completed']);
    if (rt.fake) expect(rt.fake.submits).toEqual({ accepted: 1, deduped: 3 });
  });
});
