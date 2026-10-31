import { Store } from '../persistence/store.port';
import { DurableContext, DurableRuntime } from './durable-runtime';

/** Local durable runtime: step results journaled in Postgres (step_journal table). */
export class JournalRuntime implements DurableRuntime {
  readonly name = 'journal';
  executedSteps = 0;

  constructor(private readonly store: Store) {}

  context(executionId: string): DurableContext {
    return {
      executionId,
      run: async <T>(stepName: string, fn: () => Promise<T>): Promise<T> => {
        const done = await this.store.getStep(executionId, stepName);
        if (done) return done.value as T;
        this.executedSteps++;
        const value = await fn();
        await this.store.putStep(executionId, stepName, value ?? null);
        return value;
      },
    };
  }
}
