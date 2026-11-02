import { AddressInfo, createServer } from 'node:net';
import { ApprovalService } from '../approval/approval.service';
import { sleep } from '../common/util';
import { LlmProvider, MockProvider } from '../gateway/llm-provider';
import { ModelSpec } from '../gateway/model-catalog';
import { orchestratorHarness } from '../test-utils/harness';
import { durableConfig, RestateConfig } from './durable.config';
import { RestateRuntime } from './restate.runtime';

/**
 * Against a real Restate server. Skipped unless RESTATE_INGRESS_URL and RESTATE_ADMIN_URL are set:
 *
 *   npx @restatedev/restate-server@1.8.1        # ingress :8080, admin :9070
 *   RESTATE_INGRESS_URL=http://localhost:8080 RESTATE_ADMIN_URL=http://localhost:9070 \
 *     npm --prefix api test -- restate.integration
 *
 * With Restate in Docker, also set RESTATE_ENDPOINT_PORT and RESTATE_DEPLOYMENT_URL=http://host.docker.internal:<port>.
 *
 * Each run registers this process's endpoint (force, outside production) and uses fresh task ids.
 */
const enabled = !!process.env.RESTATE_INGRESS_URL && !!process.env.RESTATE_ADMIN_URL;

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

const freePort = () => new Promise<number>((resolve) => {
  const srv = createServer().listen(0, '127.0.0.1', () => {
    const { port } = srv.address() as AddressInfo;
    srv.close(() => resolve(port));
  });
});

async function waitFor(cond: () => Promise<boolean> | boolean, ms = 15_000) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('condição não atingida a tempo');
    await sleep(20);
  }
}

(enabled ? describe : describe.skip)('RestateRuntime against a real Restate server', () => {
  jest.setTimeout(60_000);
  let cfg: RestateConfig;
  let runtime: RestateRuntime;
  const provider = new ScriptedProvider();
  let h: ReturnType<typeof orchestratorHarness<RestateRuntime>>;
  let approvals: ApprovalService;

  beforeAll(async () => {
    const port = Number(process.env.RESTATE_ENDPOINT_PORT) || await freePort();
    const parsed = durableConfig({
      // the local test server does not sign requests unless configured to; set RESTATE_IDENTITY_KEYS when it does
      RESTATE_ALLOW_UNSIGNED: process.env.RESTATE_IDENTITY_KEYS ? undefined : 'true',
      ...process.env, DURABLE_RUNTIME: 'restate', RESTATE_ENDPOINT_PORT: String(port), RESTATE_REGISTER_FORCE: 'true',
      RESTATE_DEPLOYMENT_URL: process.env.RESTATE_DEPLOYMENT_URL ?? `http://127.0.0.1:${port}`,
    });
    if (parsed.runtime !== 'restate') throw new Error('config');
    cfg = parsed.restate;
    // short inactivity: every wait (approval, resume) suspends, so each continuation is a real replay
    h = orchestratorHarness(provider, { runtime: () => (runtime = new RestateRuntime(cfg, { workflowOptions: { inactivityTimeout: 200 } })) });
    approvals = new ApprovalService(h.store, h.bus);
    await runtime.onApplicationBootstrap();
  });

  afterAll(async () => {
    await runtime?.onModuleDestroy();
  });

  afterEach(() => {
    delete process.env.TASK_TIMEOUT_MS;
    provider.failReviewer = false;
  });

  const status = async (id: string) => (await h.store.getTask(id))!.status;
  const until = (id: string, s: string) => waitFor(async () => (await status(id)) === s);
  const callsBy = async (id: string, agent: string) => (await h.store.listUsage(id)).filter((u) => u.agent === agent).length;
  const events = async (id: string) => (await h.store.listOutbox()).filter((e) => e.payload.taskId === id).map((e) => e.type).filter((t) => t.startsWith('task.'));

  it('runs a task to completion and answers health', async () => {
    expect(await runtime.ping()).toBe(true);
    const task = await h.createTask();
    expect(await h.orchestrator.start(task.id)).toBe('submitted');
    await until(task.id, 'completed');
    expect(await events(task.id)).toEqual(['task.completed']);
    await waitFor(() => runtime.isClosed(task.id));
  });

  it('dedupes duplicate starts of the same task', async () => {
    const task = await h.createTask();
    const submits = await Promise.all([runtime.submit(task.id), runtime.submit(task.id), runtime.submit(task.id)]);
    expect(submits.filter((s) => s.accepted)).toHaveLength(1);
    await until(task.id, 'completed');
    expect(await callsBy(task.id, 'planner')).toBe(1);
    expect(await events(task.id)).toEqual(['task.completed']);
  });

  it('waits for approval (suspended) and completes after the approve signal, replaying deterministically', async () => {
    const task = await h.createTask({ requiresApproval: true });
    await h.orchestrator.start(task.id);
    await until(task.id, 'awaiting_approval');
    await sleep(600); // past the 200ms inactivity timeout: the invocation suspends
    expect(await status(task.id)).toBe('awaiting_approval');
    await approvals.resolve(task.id, 'approved', null, 'ana');
    await h.orchestrator.continueAfterApproval(task.id);
    await until(task.id, 'completed');
    expect(await callsBy(task.id, 'planner')).toBe(1);
    expect(await events(task.id)).toEqual(['task.completed']);
  });

  it('a rejection ends the task as rejected', async () => {
    const task = await h.createTask({ requiresApproval: true });
    await h.orchestrator.start(task.id);
    await until(task.id, 'awaiting_approval');
    await approvals.resolve(task.id, 'rejected', 'não', 'bia');
    await h.orchestrator.continueAfterApproval(task.id);
    await until(task.id, 'rejected');
    expect(await events(task.id)).toEqual(['task.rejected']);
  });

  it('the durable timer fails a slow task once and aborts its in-flight calls', async () => {
    process.env.TASK_TIMEOUT_MS = '300';
    const slow = new ScriptedProvider(150);
    const s = orchestratorHarness(slow, { store: h.store, runtime: () => runtime });
    const task = await s.createTask();
    // the bound body is the last orchestrator built on this runtime: s
    await s.orchestrator.start(task.id);
    await until(task.id, 'failed');
    expect((await h.store.getTask(task.id))!.error).toMatch(/tarefa excedeu o timeout de 300ms/);
    await waitFor(() => slow.aborted > 0);
    await sleep(400);
    expect(await status(task.id)).toBe('failed');
    expect(await events(task.id)).toEqual(['task.failed']);
    runtime.bind((id, exec) => h.orchestrator.execute(id, exec)); // give the runtime back to h
  });

  it('a failed task resumes from the journal: completed steps are not called again', async () => {
    provider.failReviewer = true;
    const task = await h.createTask();
    await h.orchestrator.start(task.id);
    await until(task.id, 'failed');
    const planner = await callsBy(task.id, 'planner');
    provider.failReviewer = false;
    await h.orchestrator.resume(task.id);
    await until(task.id, 'completed');
    expect(await callsBy(task.id, 'planner')).toBe(planner);
    expect(await events(task.id)).toEqual(['task.failed', 'task.completed']);
  });
});
