import { DurableContext, DurableRuntime } from './durable-runtime';

/**
 * Restate adapter (prepared, not wired by default).
 *
 * Mapping when enabling it with the Restate TypeScript SDK:
 *   DurableContext.run(name, fn)  -> restate ctx.run(name, fn)
 *   human approval pause/resume   -> ctx.awakeable() resolved by POST /tasks/:id/approve
 *   executionId                   -> workflow key (task id)
 * Select it with DURABLE_RUNTIME=restate once a handler bridge passes the
 * Restate ctx into fromRestateContext().
 */
export interface RestateLikeContext {
  run<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

export class RestateRuntime implements DurableRuntime {
  readonly name = 'restate';
  private readonly contexts = new Map<string, RestateLikeContext>();

  /** Called by the Restate handler bridge for each invocation. */
  fromRestateContext(executionId: string, ctx: RestateLikeContext): void {
    this.contexts.set(executionId, ctx);
  }

  context(executionId: string): DurableContext {
    const ctx = this.contexts.get(executionId);
    if (!ctx) {
      throw new Error(`Restate não configurado para ${executionId}: registre o handler e chame fromRestateContext()`);
    }
    return { executionId, run: (name, fn) => ctx.run(name, fn) };
  }
}
