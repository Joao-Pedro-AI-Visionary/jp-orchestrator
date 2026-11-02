import { CancelledError, RunOptions, TerminalError } from '@restatedev/restate-sdk';
import { RestateConfig } from '../durable/durable.config';
import { Mappable, RestateIngress, RestateRuntime, RestateSharedCtx, RestateWorkflowCtx } from '../durable/restate.runtime';

/**
 * In-process stand-in for a Restate server, for unit tests (the official test harness,
 * @restatedev/restate-sdk-testcontainers, needs Docker). It reproduces the semantics the
 * adapter relies on:
 *  - a positional journal per workflow key; a new attempt replays it and fails loudly on
 *    non-determinism (an operation that does not match the recorded one);
 *  - ctx.run executes only when its entry has no result; results go through JSON (like the
 *    SDK serde); a TerminalError is journaled, other errors are retried (maxRetryAttempts);
 *  - durable sleeps keep their wake-up time across attempts; durable promises live per key
 *    and can be resolved before anyone waits; the race winner is journaled;
 *  - one `run` per key (a second submit is "PreviouslyAccepted"); cancel rejects what the
 *    attempt is waiting on with CancelledError; crash() ends the attempt (attemptCompletedSignal)
 *    and starts a new one that replays the journal, while the old attempt's work is ignored.
 * The real server is exercised by restate.integration.spec.ts.
 */
type Settled = { ok: true; value: unknown } | { ok: false; error: { message: string; code: number; metadata?: Record<string, string> } };

interface Entry {
  kind: 'run' | 'sleep' | 'get' | 'race';
  name: string;
  result?: Settled;
  wakeAt?: number;
  timer?: NodeJS.Timeout;
  subscribed?: boolean;
  waiters: (() => void)[];
}

interface DurablePromiseState { resolved: boolean; value?: unknown; listeners: (() => void)[] }

const ATTEMPT = Symbol('attempt');
type Tagged<T> = Mappable<T> & { [ATTEMPT]?: Attempt };

const serde = (v: unknown) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const failure = (err: unknown): Settled => {
  const t = err instanceof TerminalError ? err : new TerminalError((err as Error)?.message ?? String(err));
  return { ok: false, error: { message: t.message, code: t.code, metadata: t.metadata } };
};
const toError = (e: Extract<Settled, { ok: false }>['error']): Error =>
  e.code === 409 && e.message === 'Cancelled' ? new CancelledError() : new TerminalError(e.message, { errorCode: e.code, metadata: e.metadata });

function mappable<T>(p: Promise<T>, attempt: Attempt): Tagged<T> {
  const m = p as Tagged<T>;
  m[ATTEMPT] = attempt;
  m.map = <U>(mapper: (value?: T, failure?: TerminalError) => U) => {
    const derived = p.then((v) => mapper(v), (err) => {
      if (err instanceof TerminalError) return mapper(undefined, err);
      throw err;
    });
    derived.catch(() => undefined); // like the SDK: nothing is "unhandled" until someone awaits it
    return mappable(derived, attempt);
  };
  return m;
}

class Workflow {
  readonly journal: Entry[] = [];
  readonly promises = new Map<string, DurablePromiseState>();
  attempt: Attempt | null = null;
  attempts = 0;
  done = false;
  submitted = false;
  output: Promise<string>;
  private settle!: { resolve: (v: string) => void; reject: (e: unknown) => void };

  constructor(readonly key: string) {
    this.output = new Promise<string>((resolve, reject) => { this.settle = { resolve, reject }; });
    this.output.catch(() => undefined);
  }

  durable(name: string): DurablePromiseState {
    let d = this.promises.get(name);
    if (!d) this.promises.set(name, d = { resolved: false, listeners: [] });
    return d;
  }

  finish(ok: boolean, value: unknown) {
    this.done = true;
    if (ok) this.settle.resolve(value as string); else this.settle.reject(value);
  }
}

class Attempt {
  private cursor = 0;
  readonly controller = new AbortController();
  private readonly pending = new Set<(err: unknown) => void>();

  constructor(readonly wf: Workflow) {}

  get alive() {
    return this.wf.attempt === this && !this.controller.signal.aborted;
  }

  end() {
    this.controller.abort();
  }

  cancel() {
    for (const reject of [...this.pending]) reject(new CancelledError());
  }

  private context: RestateWorkflowCtx | null = null;

  get ctx(): RestateWorkflowCtx {
    return this.context ??= this.build();
  }

  private build = (): RestateWorkflowCtx => ({
    key: this.wf.key,
    request: () => ({ attemptCompletedSignal: this.controller.signal }),
    run: <T>(name: string, action: () => Promise<T>, options: RunOptions<T>) => {
      const e = this.next('run', name);
      if (!e.result) void this.execute(e, action, options.maxRetryAttempts ?? Infinity);
      return this.promiseFor<T>(e);
    },
    sleep: (ms: number, name = 'sleep') => {
      const e = this.next('sleep', name);
      if (e.wakeAt === undefined) e.wakeAt = Date.now() + ms;
      if (!e.result && !e.timer) {
        e.timer = setTimeout(() => this.complete(e, { ok: true, value: undefined }), Math.max(0, e.wakeAt - Date.now()));
        e.timer.unref();
      }
      return this.promiseFor<void>(e);
    },
    promise: <T>(name: string) => ({
      get: () => {
        const e = this.next('get', name);
        const d = this.wf.durable(name);
        if (!e.result && !e.subscribed) {
          e.subscribed = true;
          const deliver = () => this.complete(e, { ok: true, value: serde(d.value) });
          if (d.resolved) deliver(); else d.listeners.push(deliver);
        }
        return this.promiseFor<T>(e);
      },
    }),
  });

  race<T>(promises: Mappable<T>[]): Promise<T> {
    const e = this.next('race', '');
    if (e.result?.ok) return promises[e.result.value as number];
    const indexed = promises.map((p, i) => p.then(() => i, () => i));
    return mappable(new Promise<T>((resolve, reject) => {
      this.pending.add(reject);
      void Promise.race(indexed).then((winner) => {
        if (!this.alive) return; // abandoned attempt: never settles, like a suspended handler
        if (!e.result) e.result = { ok: true, value: winner };
        this.pending.delete(reject);
        promises[winner].then(resolve, reject);
      });
    }), this);
  }

  private next(kind: Entry['kind'], name: string): Entry {
    const i = this.cursor++;
    const recorded = this.wf.journal[i];
    if (recorded) {
      if (recorded.kind !== kind || recorded.name !== name) {
        throw new Error(`Não determinismo na entrada ${i}: journal tem ${recorded.kind}:${recorded.name}, replay pediu ${kind}:${name}`);
      }
      return recorded;
    }
    const e: Entry = { kind, name, waiters: [] };
    this.wf.journal.push(e);
    return e;
  }

  private async execute<T>(e: Entry, action: () => Promise<T>, maxRetries: number) {
    for (let retries = 0; ; retries++) {
      try {
        const value = await action();
        if (this.alive) this.complete(e, { ok: true, value: serde(value) });
        return;
      } catch (err) {
        if (!this.alive) return;
        if (err instanceof TerminalError || retries >= maxRetries) return this.complete(e, failure(err));
        await new Promise((r) => setTimeout(r, 1));
      }
    }
  }

  private complete(e: Entry, result: Settled) {
    if (e.result) return;
    e.result = result;
    for (const w of e.waiters.splice(0)) w();
  }

  private promiseFor<T>(e: Entry): Tagged<T> {
    return mappable(new Promise<T>((resolve, reject) => {
      const deliver = () => {
        this.pending.delete(reject);
        if (!this.alive) return; // abandoned attempt: never settles, like a suspended handler
        const r = e.result!;
        if (r.ok) resolve(r.value as T); else reject(toError(r.error));
      };
      this.pending.add(reject);
      if (e.result) queueMicrotask(deliver); else e.waiters.push(deliver);
    }), this);
  }
}

export class FakeRestate implements RestateIngress {
  readonly workflows = new Map<string, Workflow>();
  submits = { accepted: 0, deduped: 0 };
  private runtime: RestateRuntime | null = null;

  /** RestatePromise.race stand-in: journaled through the attempt that created the promises. */
  readonly race = <T>(promises: Mappable<T>[]): Promise<T> => {
    const attempt = (promises[0] as Tagged<T>)[ATTEMPT];
    if (!attempt) throw new Error('race fora de um contexto do FakeRestate');
    return attempt.race(promises);
  };

  attach(runtime: RestateRuntime): this {
    this.runtime = runtime;
    return this;
  }

  private wf(key: string) {
    let wf = this.workflows.get(key);
    if (!wf) this.workflows.set(key, wf = new Workflow(key));
    return wf;
  }

  async submit(key: string) {
    const wf = this.wf(key);
    if (wf.submitted) {
      this.submits.deduped++;
      return { accepted: false };
    }
    wf.submitted = true;
    this.submits.accepted++;
    this.startAttempt(wf);
    return { accepted: true };
  }

  async approve(key: string) {
    await RestateRuntime.handleApprove(this.shared(key));
  }

  async resume(key: string) {
    await RestateRuntime.handleResume(this.shared(key));
  }

  /** Like SdkIngress.closed: nothing waits for this key (finished, or never submitted / purged = 404). */
  async closed(key: string) {
    const wf = this.workflows.get(key);
    return !wf?.submitted || wf.done;
  }

  async ping() {
    return true;
  }

  /** Process crash: the current attempt is dropped and Restate replays the journal in a new one. */
  crash(key: string) {
    const wf = this.workflows.get(key)!;
    wf.attempt?.end();
    this.startAttempt(wf);
  }

  /** Restate cancel (CLI/admin API): what the handler awaits rejects with CancelledError. */
  cancel(key: string) {
    this.workflows.get(key)?.attempt?.cancel();
  }

  output(key: string): Promise<string> {
    return this.workflows.get(key)!.output;
  }

  private shared(key: string): RestateSharedCtx {
    const wf = this.wf(key);
    return {
      promise: <T>(name: string) => ({
        peek: async () => {
          await new Promise((r) => setImmediate(r));
          const d = wf.durable(name);
          return (d.resolved ? serde(d.value) : undefined) as T | undefined;
        },
        resolve: async (value?: T) => {
          await new Promise((r) => setImmediate(r));
          const d = wf.durable(name);
          if (d.resolved) throw new TerminalError(`promise ${name} já resolvida`, { errorCode: 409 });
          d.resolved = true;
          d.value = serde(value);
          for (const l of d.listeners.splice(0)) l();
        },
      }),
    };
  }

  private startAttempt(wf: Workflow) {
    const attempt = new Attempt(wf);
    wf.attempt = attempt;
    wf.attempts++;
    Promise.resolve()
      .then(() => this.runtime!.handleRun(attempt.ctx))
      .then((v) => { if (attempt.alive) { attempt.end(); wf.finish(true, v); } },
        (err) => {
          if (!attempt.alive) return;
          attempt.end();
          if (err instanceof TerminalError) wf.finish(false, err);
          else setTimeout(() => this.startAttempt(wf), 5); // Restate retries a non-terminal failure
        });
  }
}

/** RestateConfig for unit tests (nothing listens on these addresses). */
export const restateTestConfig = (patch: Partial<RestateConfig> = {}): RestateConfig => ({
  ingressUrl: 'http://restate.test', endpointPort: 9080, endpointHost: '127.0.0.1', adminUrl: null, deploymentUrl: 'http://localhost:9080',
  identityKeys: [], registerForce: false, ingressToken: null, resumeWindowMs: 60_000, effectMaxAttempts: 3, ...patch,
});
