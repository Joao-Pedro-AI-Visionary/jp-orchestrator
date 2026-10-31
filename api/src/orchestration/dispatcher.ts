import { Subtask, Task } from '../common/types';
import { envNumber, nowIso, withTimeout } from '../common/util';
import { AgentResult, AgentStrategy } from '../agents/agent-strategy';
import { BudgetExceededError } from '../billing/billing.service';
import { EventBus } from '../events/event-bus';
import { GatewayService } from '../gateway/gateway.service';
import { SharedMemory } from '../memory/shared-memory';
import { Store } from '../persistence/store.port';
import { StrategyRegistry } from '../strategy/strategy-registry';
import { ToolInvoker } from '../tools/tool-invoker.service';
import { LoopSpec } from './loops';

export interface DispatchOptions { attempt: number; feedback: string | null }

/**
 * Dispatch loop: runs one wave of subtasks in parallel through a bounded
 * worker pool (MAX_PARALLEL). Each subagent has its own timeout and one
 * retry. A budget cut cancels whatever has not started and stops the wave.
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
      await this.setStatus(subtask, { status: 'running', attempt: opts.attempt, startedAt: nowIso(), finishedAt: null });
      try {
        const res = await withTimeout(
          agent.run({ task, subtask: { ...subtask, attempt: opts.attempt }, attempt: opts.attempt, feedback: opts.feedback,
            gateway: this.gateway, tools: this.tools, memory: this.memory }),
          this.spec.timeoutMs, `subagente ${subtask.agent}`,
        );
        await this.setStatus(subtask, { status: 'done', model: res.model, output: res.output, finishedAt: nowIso() });
        return res;
      } catch (err) {
        lastError = err as Error;
        const fatal = err instanceof BudgetExceededError;
        await this.setStatus(subtask, {
          status: fatal ? 'cancelled' : 'failed', output: lastError.message, finishedAt: nowIso(),
        });
        if (fatal) throw err;
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
