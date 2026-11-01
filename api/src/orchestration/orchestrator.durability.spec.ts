import { AgentContext, AgentResult, AgentStrategy } from '../agents/agent-strategy';
import { sleep } from '../common/util';
import { JournalRuntime } from '../durable/journal.runtime';
import { LlmProvider } from '../gateway/llm-provider';
import { Store } from '../persistence/store.port';
import { StrategyRegistry } from '../strategy/strategy-registry';
import { ProcessCrash } from '../test-utils/crash';
import { orchestratorHarness } from '../test-utils/harness';
import { Dispatcher } from './dispatcher';
import { loops } from './loops';
import { Orchestrator } from './orchestrator.service';

type Harness = ReturnType<typeof orchestratorHarness>;

async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

/** The store as seen by a process that dies right after journaling-to-be `stepKey`: putStep and everything after it reject. */
function dieOnPutStep(target: Store, stepKey: string): Store {
  let dead = false;
  return new Proxy(target, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (dead || (prop === 'putStep' && args[1] === stepKey)) {
          dead = true;
          return Promise.reject(new ProcessCrash(`putStep(${stepKey})`));
        }
        return value.apply(obj, args);
      };
    },
  });
}

const planner = (h: Harness) => (h.orchestrator as unknown as { planner: never }).planner;

describe('Orchestrator durability (M1)', () => {
  it('a crash between the snapshot commit and its journal entry does not append the snapshot twice on replay', async () => {
    const h = orchestratorHarness();
    const task = await h.createTask();
    const dying = dieOnPutStep(h.store, 'snapshot:plan');
    const first = new Orchestrator(dying, new JournalRuntime(dying), planner(h), h.dispatcher, h.context, h.memory, h.bus);
    await expect(first.run(task.id)).rejects.toBeInstanceOf(ProcessCrash);
    expect((await h.store.listSnapshots(task.id)).map((s) => s.label)).toEqual(['plan']);

    await h.store.releaseTaskLease(task.id, first.owner); // the dead process's lease expires
    expect(await h.orchestrator.run(task.id)).toBe('completed');
    const labels = (await h.store.listSnapshots(task.id)).map((s) => s.label);
    expect(labels.filter((l) => l === 'plan')).toHaveLength(1);
    expect(new Set(labels).size).toBe(labels.length);
    expect(await h.context.verifyChain(task.id)).toBe(true);
  });
});

describe('Errors exposed to clients and webhooks (L4)', () => {
  it('replaces an internal error message by a reference id in the task, subtasks and outbox', async () => {
    const leaky: LlmProvider = { key: 'mock', complete: async () => { throw new Error('connect ECONNREFUSED 10.9.8.7:5432 user=jp'); } };
    const h = orchestratorHarness(leaky);
    const task = await h.createTask();
    expect(await h.orchestrator.run(task.id)).toBe('failed');

    const t = (await h.store.getTask(task.id))!;
    expect(t.error).toMatch(/^Erro interno \(ref [0-9a-f]{8}\)/);
    const exposed = JSON.stringify([t, await h.store.listSubtasks(task.id), await h.store.listOutbox(), h.bus.history]);
    expect(exposed).not.toMatch(/10\.9\.8\.7|ECONNREFUSED/);
  });

  it('keeps domain messages (timeout, budget, review) as they are', async () => {
    const h = orchestratorHarness();
    const task = await h.createTask({ budgetUsd: 0.000001 });
    expect(await h.orchestrator.run(task.id)).toBe('budget_exceeded');
    expect((await h.store.getTask(task.id))!.error).toMatch(/^Orçamento estourado/);
  });
});

describe('Retries and resume (L5)', () => {
  it('does not retry a deterministic error (token limit)', async () => {
    const h = await withEnv({ GATEWAY_MAX_PROMPT_TOKENS: '5' }, async () => orchestratorHarness());
    const task = await h.createTask();
    expect(await h.orchestrator.run(task.id)).toBe('failed');
    const starts = h.bus.history.filter((e) => e.type === 'subtask.status' && e.taskId === task.id && e.payload.status === 'running');
    expect(starts).toHaveLength(1);
    expect((await h.store.getTask(task.id))!.error).toMatch(/excede o limite/);
  });

  it('does not offer resume when the reviewer still rejected after the last round', async () => {
    const h = orchestratorHarness();
    const rejected = await h.createTask({ status: 'failed' });
    await h.store.putStep(rejected.id, 'review:2', { output: '', model: 'm', artifacts: [], verdict: { approved: false, feedback: 'x' } });
    const other = await h.createTask({ status: 'failed' });
    await h.store.putStep(other.id, 'review:0', { output: '', model: 'm', artifacts: [], verdict: { approved: false, feedback: 'x' } });
    expect(await h.orchestrator.canResume(rejected.id)).toBe(false);
    expect(await h.orchestrator.canResume(other.id)).toBe(true);
  });
});

/** Researcher stand-in: `plan[i]` is how long call i takes; `cooperative` honors the abort signal. */
class SlowAgent implements AgentStrategy {
  readonly key = 'researcher' as const;
  readonly tier = 'cheap' as const;
  calls = 0;
  active = 0;
  peak = 0;
  constructor(private readonly plan: number[], private readonly cooperative: boolean) {}
  async run(ctx: AgentContext): Promise<AgentResult> {
    const ms = this.plan[this.calls++] ?? 0;
    this.active++;
    this.peak = Math.max(this.peak, this.active);
    try {
      await sleep(ms, this.cooperative ? ctx.signal : undefined);
      return { output: 'ok', model: 'm', artifacts: [] };
    } finally {
      this.active--;
    }
  }
}

describe('Subagent timeout (M13)', () => {
  const setup = async (agent: SlowAgent) => {
    const h = orchestratorHarness();
    const task = await h.createTask();
    const subtask = {
      id: crypto.randomUUID(), taskId: task.id, agent: 'researcher' as const, title: 'r', status: 'pending' as const,
      model: null, output: null, attempt: 1, position: 0, startedAt: null, finishedAt: null,
    };
    await h.store.saveSubtasks([subtask]);
    const spec = { ...loops().dispatch, timeoutMs: 30, maxCalls: 2 };
    const d = new Dispatcher(h.store, new StrategyRegistry<AgentStrategy>('agent', [agent]), h.gateway, h.tools, h.memory, h.bus, spec);
    return { h, task, subtask, d };
  };

  it('retries only after the timed out attempt stopped: never two attempts at once', async () => {
    const agent = new SlowAgent([500, 0], true);
    const { task, subtask, d } = await setup(agent);
    await expect(d.runOne(task, subtask, { attempt: 1, feedback: null })).resolves.toMatchObject({ output: 'ok' });
    expect(agent.calls).toBe(2);
    expect(agent.peak).toBe(1);
  });

  it('does not retry an attempt that ignores the abort and keeps running', async () => {
    const agent = new SlowAgent([300, 0], false);
    const { h, task, subtask, d } = await setup(agent);
    await expect(d.runOne(task, subtask, { attempt: 1, feedback: null })).rejects.toThrow(/timeout/);
    expect(agent.calls).toBe(1);
    expect(agent.peak).toBe(1);
    expect((await h.store.listSubtasks(task.id))[0].status).toBe('failed');
    await sleep(300); // let the zombie finish before the harness goes away
  });
});
