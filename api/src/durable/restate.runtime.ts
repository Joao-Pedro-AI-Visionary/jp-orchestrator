import * as http2 from 'node:http2';
import { Logger } from '@nestjs/common';
import * as restate from '@restatedev/restate-sdk';
import * as clients from '@restatedev/restate-sdk-clients';
import { BudgetExceededError } from '../billing/billing.service';
import { envNumber, throwIfAborted, TimeoutError, withTimeout } from '../common/util';
import { RestateConfig } from './durable.config';
import {
  DurableContext, DurableEngine, DurableExecution, DurablePass, ExecutionBody, ExecutionCancelledError, ExecutionRejectedError,
  ExecutionYieldedError,
} from './durable-runtime';

/**
 * Restate adapter. One Restate workflow per task (workflow key = task id):
 *
 *   DurableContext.run(name, fn)  -> ctx.run(name, fn), memoized by name inside the execution
 *   DurableContext.effect(fn)     -> ctx.run (journaled, so a replay takes the same path)
 *   task timeout                  -> ctx.sleep(TASK_TIMEOUT_MS) raced against every step (durable timer)
 *   approval pause                -> durable promise "approval:<n>" (one per pause), resolved by the shared
 *                                    handler `approve`; the loop re-reads the decision from the store, so a
 *                                    signal without a stored decision just pauses again on the next promise
 *   /resume after a failure       -> durable promise "resume:<n>", resolved by the shared handler `resume`
 *   single owner per task         -> Restate runs a workflow's `run` once per key; a duplicate submit
 *                                    is answered "PreviouslyAccepted" and starts nothing
 *   cancellation                  -> one AbortSignal per pass, aborted on the timer, on Restate cancel
 *                                    and when the attempt ends (attemptCompletedSignal)
 *
 * The API serves the workflow on RESTATE_ENDPOINT_PORT; Restate calls it, and the API talks to
 * Restate through the ingress (RESTATE_INGRESS_URL).
 */
export const WORKFLOW_NAME = 'TaskExecution';

/** RestatePromise surface the adapter uses (also implemented by the test fake). */
export type Mappable<T> = Promise<T> & { map<U>(mapper: (value?: T, failure?: restate.TerminalError) => U): Mappable<U> };

/** The subset of restate.WorkflowContext the adapter needs. */
export interface RestateWorkflowCtx {
  readonly key: string;
  run<T>(name: string, action: () => Promise<T>, options: restate.RunOptions<T>): Mappable<T>;
  sleep(duration: number, name?: string): Mappable<void>;
  promise<T>(name: string): { get(): Mappable<T> };
  request(): { readonly attemptCompletedSignal: AbortSignal };
}

/** The subset of restate.WorkflowSharedContext the signal handlers need. */
export interface RestateSharedCtx {
  promise<T>(name: string): { peek(): Promise<T | undefined>; resolve(value?: T): Promise<void> };
}

/** Promise combinator; the SDK's RestatePromise.race in production (it is journaled, so replays are deterministic). */
export type Race = <T>(promises: Mappable<T>[]) => Promise<T>;
const sdkRace: Race = (promises) => restate.RestatePromise.race(promises as unknown as restate.RestatePromise<unknown>[]) as never;

/** How the API reaches Restate (ingress). The SDK client in production, an in-process fake in unit tests. */
export interface RestateIngress {
  submit(key: string): Promise<{ accepted: boolean }>;
  approve(key: string): Promise<void>;
  resume(key: string): Promise<void>;
  closed(key: string): Promise<boolean>;
  ping(): Promise<boolean>;
}

const MAX_SIGNALS = 1_000;
const DEADLINE = 'deadline';

/** Error kinds kept across the journal, so a replayed failure keeps its meaning (budget vs. timeout). */
const KIND_CODE = { budget: 402, timeout: 408, error: 500 } as const;
type Kind = keyof typeof KIND_CODE;

const kindOf = (err: unknown): Kind =>
  err instanceof BudgetExceededError ? 'budget' : err instanceof TimeoutError ? 'timeout' : 'error';

function toTerminal(err: unknown): restate.TerminalError {
  if (err instanceof restate.TerminalError) return err;
  const kind = kindOf(err);
  return new restate.TerminalError((err as Error)?.message ?? String(err), { errorCode: KIND_CODE[kind], metadata: { kind } });
}

/** Rebuilds a journaled failure as the error class the orchestrator understands. */
function revive(err: restate.TerminalError): Error {
  const kind = err.metadata?.kind ?? Object.entries(KIND_CODE).find(([, c]) => c === err.code)?.[0];
  const proto = kind === 'budget' ? BudgetExceededError.prototype : kind === 'timeout' ? TimeoutError.prototype : Error.prototype;
  return Object.assign(Object.create(proto) as Error, { message: err.message, stack: err.stack });
}

class RestatePass implements DurablePass {
  private readonly controller = new AbortController();
  private readonly deadline: Mappable<never>;
  readonly ctx: DurableContext;
  private readonly onAttemptEnd = () => this.controller.abort(new ExecutionYieldedError());

  constructor(private readonly exec: RestateExecution, private readonly timeoutMs: number) {
    const { ctx } = exec;
    // Durable timer: its wake-up time is journaled by Restate, so a retry or a replay after a crash
    // keeps the original deadline instead of starting a new one.
    this.deadline = ctx.sleep(timeoutMs, 'task-timeout').map((_, failure) => {
      if (failure) throw failure; // cancellation reaches the timer too: keep it a cancellation
      throw new restate.TerminalError(`tarefa excedeu o timeout de ${timeoutMs}ms`, { errorCode: 408, metadata: { kind: DEADLINE } });
    });
    exec.attemptSignal.addEventListener('abort', this.onAttemptEnd, { once: true });
    if (exec.attemptSignal.aborted) this.onAttemptEnd();
    this.ctx = {
      executionId: exec.executionId,
      run: async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
        const memo = this.exec.memo;
        if (memo.has(name)) return memo.get(name) as T;
        const value = await this.step(name, fn, true);
        memo.set(name, value);
        return value;
      },
      effect: <T>(label: string, fn: () => Promise<T>): Promise<T> => this.step(label, fn, false),
    };
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  abort(reason: unknown): void {
    this.controller.abort(reason);
  }

  close(): void {
    this.exec.attemptSignal.removeEventListener('abort', this.onAttemptEnd);
  }

  private async step<T>(name: string, fn: () => Promise<T>, terminal: boolean): Promise<T> {
    throwIfAborted(this.signal);
    try {
      return await this.exec.journal(name, fn, terminal, this.deadline);
    } catch (err) {
      if ((err as restate.TerminalError).metadata?.kind === DEADLINE) {
        const timeout = new TimeoutError('tarefa', this.timeoutMs);
        this.controller.abort(timeout); // the in-flight fn (agents, gateway, tools) sees the abort
        throw timeout;
      }
      if (err instanceof ExecutionCancelledError) this.controller.abort(err);
      throw err;
    }
  }
}

/** One workflow invocation (one task). Lives for one attempt; Restate replays it after a crash. */
export class RestateExecution implements DurableExecution {
  /** Step results by name, rebuilt deterministically on replay; a later pass reuses them (name memo). */
  readonly memo = new Map<string, unknown>();
  private resumes = 0;
  private approvals = 0;

  constructor(readonly ctx: RestateWorkflowCtx, private readonly race: Race, private readonly cfg: Pick<RestateConfig, 'resumeWindowMs' | 'effectMaxAttempts'>) {}

  get executionId(): string {
    return this.ctx.key;
  }

  get attemptSignal(): AbortSignal {
    return this.ctx.request().attemptCompletedSignal;
  }

  pass(timeoutMs: number): DurablePass {
    return new RestatePass(this, timeoutMs);
  }

  effect<T>(label: string, fn: () => Promise<T>): Promise<T> {
    return this.journal(label, fn, false);
  }


  async awaitApproval(): Promise<void> {
    await this.signal(this.ctx.promise<boolean>(`approval:${this.approvals++}`).get());
  }

  async awaitResume(): Promise<boolean> {
    const n = this.resumes++;
    return this.signal(this.race([
      this.ctx.promise<boolean>(`resume:${n}`).get().map((_, failure) => { if (failure) throw failure; return true; }),
      this.ctx.sleep(this.cfg.resumeWindowMs, 'resume-window').map((_, failure) => { if (failure) throw failure; return false; }),
    ]));
  }

  /** The failure write: idempotent, so Restate retries it without a cap (with backoff) until the store answers. */
  fail<T>(fn: () => Promise<T>): Promise<T> {
    return this.journal('fail', fn, false, undefined, true);
  }

  /**
   * ctx.run with the failure translated both ways: fn's error is journaled as a TerminalError
   * carrying its kind; within the same attempt the original error object is rethrown, on a replay
   * it is revived from the journal. Steps (agent calls) fail at once, like the journal runtime;
   * effects (idempotent store writes) get a few Restate retries first.
   */
  async journal<T>(name: string, fn: () => Promise<T>, terminal: boolean, deadline?: Mappable<never>, uncapped = false): Promise<T> {
    let original: unknown;
    const action = async (): Promise<T> => {
      try {
        return await fn();
      } catch (err) {
        original = err;
        throw terminal ? toTerminal(err) : err;
      }
    };
    const options: restate.RunOptions<T> = terminal || uncapped ? {} : { maxRetryAttempts: this.cfg.effectMaxAttempts, initialRetryInterval: 200 };
    const run = this.ctx.run(name, action, options);
    try {
      return await (deadline ? this.race<T>([run, deadline]) : run);
    } catch (err) {
      if (err instanceof restate.CancelledError) throw new ExecutionCancelledError();
      if ((err as restate.TerminalError).metadata?.kind === DEADLINE) throw err;
      if (original !== undefined) throw original;
      throw err instanceof restate.TerminalError ? revive(err) : err;
    }
  }

  private async signal<T>(p: Promise<T>): Promise<T> {
    try {
      return await p;
    } catch (err) {
      if (err instanceof restate.CancelledError) throw new ExecutionCancelledError();
      throw err;
    }
  }
}

/** Ingress through the official client (@restatedev/restate-sdk-clients). */
export class SdkIngress implements RestateIngress {
  private readonly rs: clients.Ingress;

  constructor(private readonly cfg: Pick<RestateConfig, 'ingressUrl' | 'ingressToken'>, private readonly definition: TaskWorkflow) {
    this.rs = clients.connect({ url: cfg.ingressUrl, headers: cfg.ingressToken ? { authorization: `Bearer ${cfg.ingressToken}` } : undefined });
  }

  private client(key: string) {
    return this.rs.workflowClient(this.definition, key);
  }

  async submit(key: string) {
    const s = await this.client(key).workflowSubmit();
    return { accepted: s.status === 'Accepted' };
  }

  async approve(key: string) {
    await this.client(key).approve();
  }

  async resume(key: string) {
    await this.client(key).resume();
  }

  /**
   * true when no execution is waiting for this key: finished (successfully or not), purged after its
   * retention, or never submitted (e.g. the task failed under the journal runtime). Only an answer
   * Restate could not give (gateway/unavailable) is an error.
   */
  async closed(key: string) {
    try {
      return (await this.client(key).workflowOutput()).ready;
    } catch (err) {
      if (err instanceof clients.HttpCallError && ![502, 503, 504].includes(err.status)) return true;
      throw err;
    }
  }

  async ping() {
    const res = await withTimeout(fetch(`${this.cfg.ingressUrl}/restate/health`, {
      headers: this.cfg.ingressToken ? { authorization: `Bearer ${this.cfg.ingressToken}` } : {},
    }), 2_000, 'restate');
    return res.ok;
  }
}

/** The workflow definition; handlers forward to the runtime instance. */
function defineWorkflow(rt: RestateRuntime, options?: restate.WorkflowOptions) {
  return restate.workflow({
    name: WORKFLOW_NAME,
    options,
    handlers: {
      run: (ctx: restate.WorkflowContext): Promise<string> => rt.handleRun(ctx),
      approve: restate.handlers.workflow.shared((ctx: restate.WorkflowSharedContext): Promise<void> => RestateRuntime.handleApprove(ctx)),
      resume: restate.handlers.workflow.shared((ctx: restate.WorkflowSharedContext): Promise<void> => RestateRuntime.handleResume(ctx)),
    },
  });
}
type TaskWorkflow = ReturnType<typeof defineWorkflow>;

export interface RestateRuntimeOptions {
  /** Overrides the SDK ingress (tests). */
  ingress?: RestateIngress;
  /** Overrides RestatePromise.race (tests running on the fake context). */
  race?: Race;
  /** Workflow options sent to Restate at registration (e.g. a short inactivityTimeout to force suspensions in tests). */
  workflowOptions?: restate.WorkflowOptions;
}

export class RestateRuntime implements DurableEngine {
  readonly name = 'restate';
  readonly external = true as const;
  readonly definition: TaskWorkflow;
  private readonly log = new Logger('RestateRuntime');
  private readonly ingress: RestateIngress;
  private readonly race: Race;
  private body: ExecutionBody | null = null;
  private server: http2.Http2Server | null = null;
  private readonly sessions = new Set<http2.ServerHttp2Session>();

  constructor(private readonly cfg: RestateConfig, opts: RestateRuntimeOptions = {}) {
    this.definition = defineWorkflow(this, opts.workflowOptions);
    this.ingress = opts.ingress ?? new SdkIngress(cfg, this.definition);
    this.race = opts.race ?? sdkRace;
  }

  bind(body: ExecutionBody): void {
    this.body = body;
  }

  /** Workflow `run`: executes the orchestrator body once per task, under Restate's journal. */
  async handleRun(ctx: RestateWorkflowCtx): Promise<string> {
    if (!this.body) throw new restate.TerminalError('Orquestrador não ligado ao runtime Restate', { errorCode: 503 });
    try {
      return await this.body(ctx.key, new RestateExecution(ctx, this.race, this.cfg));
    } catch (err) {
      // Final for this execution: end the workflow instead of having Restate retry it forever.
      if (err instanceof ExecutionRejectedError || err instanceof ExecutionCancelledError) {
        throw new restate.TerminalError(err.message, { errorCode: err instanceof ExecutionRejectedError ? 404 : 409 });
      }
      throw err;
    }
  }

  /** Shared handler: wakes the current approval pause (approval:<n>, first not resolved yet). */
  static handleApprove(ctx: RestateSharedCtx): Promise<void> {
    return RestateRuntime.resolveNext(ctx, 'approval');
  }

  /** Shared handler: wakes the current /resume wait (resume:<n>, one per failure, in order). */
  static handleResume(ctx: RestateSharedCtx): Promise<void> {
    return RestateRuntime.resolveNext(ctx, 'resume');
  }

  /**
   * Resolves the first `<prefix>:<i>` not resolved yet. Shared handlers run concurrently: when another
   * call resolved the same promise between our peek and resolve, that counts as delivered.
   */
  private static async resolveNext(ctx: RestateSharedCtx, prefix: string): Promise<void> {
    for (let i = 0; i < MAX_SIGNALS; i++) {
      const p = ctx.promise<boolean>(`${prefix}:${i}`);
      if ((await p.peek()) !== undefined) continue;
      try {
        return await p.resolve(true);
      } catch (err) {
        if ((await p.peek()) !== undefined) return;
        throw err;
      }
    }
    throw new restate.TerminalError(`limite de sinais ${prefix} atingido`, { errorCode: 409 });
  }

  submit(executionId: string) {
    return this.ingress.submit(executionId);
  }

  signalApproval(executionId: string) {
    return this.ingress.approve(executionId);
  }

  signalResume(executionId: string) {
    return this.ingress.resume(executionId);
  }

  isClosed(executionId: string) {
    return this.ingress.closed(executionId);
  }

  async ping() {
    try {
      return await this.ingress.ping();
    } catch {
      return false;
    }
  }

  /** Serves the workflow endpoint and, with RESTATE_ADMIN_URL, registers it in Restate. */
  async onApplicationBootstrap(): Promise<void> {
    let endpoint = restate.endpoint().bind(this.definition);
    // durableConfig() only lets this list be empty with RESTATE_ALLOW_UNSIGNED=true outside production
    if (this.cfg.identityKeys.length) endpoint = endpoint.withIdentityV1(...this.cfg.identityKeys);
    const server = http2.createServer(endpoint.http2Handler());
    server.on('session', (session) => {
      this.sessions.add(session);
      session.once('close', () => this.sessions.delete(session));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.cfg.endpointPort, this.cfg.endpointHost, () => { server.off('error', reject); resolve(); });
    });
    this.server = server;
    this.log.log(`Endpoint Restate em ${this.cfg.endpointHost}:${this.cfg.endpointPort} (workflow ${WORKFLOW_NAME}, ingress ${this.cfg.ingressUrl})`);
    if (this.cfg.adminUrl) await this.register(this.cfg.adminUrl);
  }

  /**
   * Shutdown: stop accepting invocations, give the running attempts ABORT_GRACE_MS, then cut them.
   * A cut attempt ends (attemptCompletedSignal), writes nothing more, and Restate retries it on
   * another replica, replaying the journal. Open streams of suspended-to-be invocations would
   * otherwise hold the shutdown until Restate's inactivity timeout.
   */
  async onModuleDestroy(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    for (const s of this.sessions) s.close();
    const grace = setTimeout(() => { for (const s of this.sessions) s.destroy(); }, envNumber('ABORT_GRACE_MS', 5_000));
    await closed;
    clearTimeout(grace);
  }

  private async register(adminUrl: string): Promise<void> {
    const res = await fetch(`${adminUrl}/deployments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // force (RESTATE_REGISTER_FORCE=true, refused in production) overwrites a deployment whose handlers changed: dev loop only
      body: JSON.stringify({ uri: this.cfg.deploymentUrl, force: this.cfg.registerForce }),
    });
    if (!res.ok) throw new Error(`Registro no Restate falhou (${res.status}): ${(await res.text()).slice(0, 300)}`);
    this.log.log(`Deployment ${this.cfg.deploymentUrl} registrado em ${adminUrl}`);
  }
}
