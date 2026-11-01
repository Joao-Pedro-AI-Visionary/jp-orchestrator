import { publicMessage } from '../common/errors';
import { Subtask, Task } from '../common/types';
import { envNumber, nowIso, withDeadline } from '../common/util';
import { AgentResult, AgentStrategy } from '../agents/agent-strategy';
import { BudgetExceededError } from '../billing/billing.service';
import { EventBus } from '../events/event-bus';
import { GatewayService, TokenLimitError } from '../gateway/gateway.service';
import { SharedMemory } from '../memory/shared-memory';
import { Store } from '../persistence/store.port';
import { StrategyRegistry, UnknownStrategyError } from '../strategy/strategy-registry';
import { ToolInvoker } from '../tools/tool-invoker.service';
import { LoopSpec } from './loops';

export interface DispatchOptions { attempt: number; feedback: string | null; signal?: AbortSignal; team?: Subtask[] }

/** Fails the same way on every attempt: retrying only spends again. */
const deterministic = (err: unknown) => err instanceof TokenLimitError || err instanceof UnknownStrategyError;

/** True when `p` settles within `ms`. The timer is cleared as soon as `p` settles. */
function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), ms); });
  return Promise.race([p.then(() => true, () => true), expired]).finally(() => clearTimeout(timer));
}

/**
 * Dispatch loop: runs one wave of subtasks in parallel through a bounded
 * worker pool (MAX_PARALLEL). Each subagent has its own timeout and one
 * retry. A budget cut or an aborted task signal cancels whatever has not
 * started and stops the wave.
 *
 * A timed out attempt is aborted and the retry starts only once that attempt has
 * really stopped (within one more timeout); an attempt that ignores the abort is not
 * retried, so two attempts of one subagent never run (and spend) at the same time.
 * Deterministic errors (token limit, unknown strategy) are not retried either.
 */
export class Dispatcher {
  readonly maxParallel = envNumber('MAX_PARALLEL', 4);

  constructor(
    private readonly store: Store,
    private readonly agents: StrategyRegistry<AgentStrategy>,
    private readonly gateway: GatewayService,
    private readonly tools: ToolInvoker,
    private readonly memory: SharedMemory,
    private readonly bus: EventBus,
    private readonly spec: LoopSpec,
  ) {}

  async dispatch(task: Task, wave: Subtask[], opts: DispatchOptions): Promise<Record<string, AgentResult>> {
    const results: Record<string, AgentResult> = {};
    const queue = [...wave];
    let abort: Error | null = null;

    const worker = async () => {
      while (queue.length && !abort) {
        const subtask = queue.shift()!;
        try {
          results[subtask.id] = await this.runOne(task, subtask, opts);
        } catch (err) {
          abort = abort ?? (err as Error);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.maxParallel, wave.length) }, worker));

    if (abort) {
      for (const s of queue) await this.setStatus(s, { status: 'cancelled', finishedAt: nowIso() });
      throw abort;
    }
    return results;
  }

  async runOne(task: Task, subtask: Subtask, opts: DispatchOptions): Promise<AgentResult> {
    const agent = this.agents.resolve(subtask.agent);
    let lastError: Error | null = null;
    for (let call = 1; call <= this.spec.maxCalls; call++) {
      opts.signal?.throwIfAborted();
      await this.setStatus(subtask, { status: 'running', attempt: opts.attempt, startedAt: nowIso(), finishedAt: null });
      const inflight: { run?: Promise<AgentResult> } = {};
      try {
        const res = await withDeadline((signal) => (inflight.run = agent.run({
          task, subtask: { ...subtask, attempt: opts.attempt }, attempt: opts.attempt, feedback: opts.feedback,
          gateway: this.gateway, tools: this.tools, memory: this.memory, signal, team: opts.team,
        })), this.spec.timeoutMs, `subagente ${subtask.agent}`, opts.signal);
        await this.setStatus(subtask, { status: 'done', model: res.model, output: res.output, finishedAt: nowIso() });
        return res;
      } catch (err) {
        lastError = err as Error;
        const fatal = err instanceof BudgetExceededError || Boolean(opts.signal?.aborted);
        const stopped = fatal || !inflight.run || (await settlesWithin(inflight.run, this.spec.timeoutMs));
        await this.setStatus(subtask, {
          status: fatal ? 'cancelled' : 'failed', output: publicMessage(err, `subtarefa ${subtask.id} (${subtask.agent})`), finishedAt: nowIso(),
        });
        if (fatal || !stopped || deterministic(err)) throw err;
      }
    }
    throw lastError ?? new Error('subagente falhou');
  }

  private async setStatus(subtask: Subtask, patch: Partial<Subtask>) {
    const updated = await this.store.updateSubtask(subtask.id, patch);
    this.bus.emit('subtask.status', subtask.taskId, {
      subtaskId: subtask.id, agent: subtask.agent, title: subtask.title, status: updated.status,
      model: updated.model, attempt: updated.attempt,
    });
  }
}
