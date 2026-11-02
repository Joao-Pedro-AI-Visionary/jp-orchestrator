import { throwIfAborted } from '../common/util';
import { Store } from '../persistence/store.port';
import { ContextOptions, DurableContext, DurableRuntime } from './durable-runtime';

/**
 * Local durable runtime: step results journaled in Postgres (step_journal table).
 * Exclusivity comes from the task lease held by the orchestrator. Should two runs
 * still race on a step, the first journaled value wins and both continue with it.
 */
export class JournalRuntime implements DurableRuntime {
  readonly name = 'journal';
  executedSteps = 0;

  constructor(private readonly store: Store) {}

  context(executionId: string, opts: ContextOptions = {}): DurableContext {
    return {
      executionId,
      run: async <T>(stepName: string, fn: () => Promise<T>): Promise<T> => {
        throwIfAborted(opts.signal);
        const done = await this.store.getStep(executionId, stepName);
        if (done) return done.value as T;
        this.executedSteps++;
        const value = await fn();
        throwIfAborted(opts.signal);
        return (await this.store.putStep(executionId, stepName, value ?? null)) as T;
      },
    };
  }
}
