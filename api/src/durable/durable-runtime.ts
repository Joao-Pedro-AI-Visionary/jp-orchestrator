/**
 * Durable execution port. The orchestrator loop is written as a sequence of
 * named steps; a step that already completed is never re-executed, its
 * journaled result is returned instead. A crash or a pause (human approval)
 * resumes from the first step without a journal entry.
 *
 * Two shapes implement it, selected by DURABLE_RUNTIME (see durable.config.ts):
 *  - a local runtime (journal): the Orchestrator drives each run itself (task lease,
 *    heartbeat, in-process timeout, approval as "pause and re-run");
 *  - an engine (restate): the runtime schedules the execution, guarantees one owner per
 *    task, keeps the timeout as a durable timer and waits for approval/resume signals.
 */
export interface DurableContext {
  readonly executionId: string;
  /** Named step: runs once per execution; a later call with the same name returns the recorded result. */
  run<T>(stepName: string, fn: () => Promise<T>): Promise<T>;
  /**
   * A side effect outside the step journal (status writes, reads that steer the loop). The journal
   * runtime just calls fn: every run re-reads the store. An engine that replays its handler records
   * the result, so a replay takes the same path, while a later pass (after approval or /resume)
   * calls fn again.
   */
  effect<T>(label: string, fn: () => Promise<T>): Promise<T>;
}

export interface ContextOptions {
  /** Once aborted, no further step starts and no late result is journaled. */
  signal?: AbortSignal;
}

/** Local runtime: the Orchestrator owns the run (lease, heartbeat, timeout). */
export interface DurableRuntime {
  readonly name: string;
  context(executionId: string, opts?: ContextOptions): DurableContext;
}

/** One stretch of an execution under the task timeout (before approval, after it, after a /resume). */
export interface DurablePass {
  readonly ctx: DurableContext;
  /** Aborted on the durable timeout, on cancellation and when the current attempt ends. */
  readonly signal: AbortSignal;
  /** Stops in-flight work of this pass (e.g. the sibling calls of a failed step). */
  abort(reason: unknown): void;
  close(): void;
}

/** Handle the engine gives the orchestrator for one execution (one task). */
export interface DurableExecution {
  readonly executionId: string;
  /** Starts a pass bounded by a durable timer of timeoutMs. */
  pass(timeoutMs: number): DurablePass;
  /** Journaled side effect outside any pass (no timeout). */
  effect<T>(label: string, fn: () => Promise<T>): Promise<T>;
  /** The failure write (idempotent): retried until the store answers, so the task never stays non-final. */
  fail<T>(fn: () => Promise<T>): Promise<T>;
  /** Durable wait for the approval signal. The task timeout does not run while waiting. */
  awaitApproval(): Promise<void>;
  /** Durable wait for /resume after a failure. false when the resume window closed first. */
  awaitResume(): Promise<boolean>;
}

/** The orchestrator body an engine runs per execution. Returns the run outcome. */
export type ExecutionBody = (executionId: string, exec: DurableExecution) => Promise<string>;

/**
 * Runtime that schedules executions itself. The engine guarantees a single owner per
 * execution id (task id): a duplicate submit attaches to the execution already accepted.
 */
export interface DurableEngine {
  readonly name: string;
  readonly external: true;
  bind(body: ExecutionBody): void;
  /** Starts the execution once per id. accepted=false: it was already accepted earlier (deduped). */
  submit(executionId: string): Promise<{ accepted: boolean }>;
  /** Delivers the approval decision (already persisted in the store). Idempotent. */
  signalApproval(executionId: string): Promise<void>;
  /** Wakes an execution waiting after a failure. Call once per reopen of the task. */
  signalResume(executionId: string): Promise<void>;
  /** The execution finished for good (its output is recorded): it can no longer be resumed. */
  isClosed(executionId: string): Promise<boolean>;
  /** The engine answers (readiness). */
  ping(): Promise<boolean>;
}

export type AnyDurableRuntime = DurableRuntime | DurableEngine;

export const isEngine = (rt: AnyDurableRuntime): rt is DurableEngine => (rt as DurableEngine).external === true;

/** The current attempt of an engine execution ended (suspension, retry, shutdown): stop and write nothing. */
export class ExecutionYieldedError extends Error {
  constructor() {
    super('tentativa encerrada pelo runtime durável');
  }
}

/** This execution must not run (e.g. its task does not exist): the engine ends it for good, no retries. */
export class ExecutionRejectedError extends Error {}

/** The execution was cancelled through the engine (operator cancel): fail the task, no /resume wait. */
export class ExecutionCancelledError extends Error {
  constructor() {
    super('Execução cancelada no runtime durável');
  }
}
