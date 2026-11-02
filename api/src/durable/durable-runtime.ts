/**
 * Durable execution port. The orchestrator loop is written as a sequence of
 * named steps; a step that already completed is never re-executed, its
 * journaled result is returned instead. A crash or a pause (human approval)
 * resumes from the first step without a journal entry.
 *
 * The interface mirrors Restate's handler context (ctx.run(name, fn)), so the
 * loop can move to Restate without changing orchestration code.
 */
export interface DurableContext {
  readonly executionId: string;
  run<T>(stepName: string, fn: () => Promise<T>): Promise<T>;
}

export interface ContextOptions {
  /** Once aborted, no further step starts and no late result is journaled. */
  signal?: AbortSignal;
}

export interface DurableRuntime {
  readonly name: string;
  context(executionId: string, opts?: ContextOptions): DurableContext;
}
