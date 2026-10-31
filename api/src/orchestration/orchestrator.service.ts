import { Logger } from '@nestjs/common';
import { Subtask, Task, TaskStatus } from '../common/types';
import { newId, nowIso, withTimeout } from '../common/util';
import { AgentResult } from '../agents/agent-strategy';
import { BudgetExceededError } from '../billing/billing.service';
import { DurableContext, DurableRuntime } from '../durable/durable-runtime';
import { EventBus } from '../events/event-bus';
import { ContextStore } from '../memory/context-store.service';
import { SharedMemory } from '../memory/shared-memory';
import { Store } from '../persistence/store.port';
import { outboxEvent } from '../tools/tool-invoker.service';
import { Dispatcher } from './dispatcher';
import { loops, MAX_CORRECTION_ROUNDS } from './loops';
import { mergeResults } from './merger';
import { Planner } from './planner';

export type RunOutcome = 'completed' | 'paused' | 'failed' | 'rejected' | 'budget_exceeded';
const ACTIVE: TaskStatus[] = ['queued', 'planning', 'running', 'merging'];
const TERMINAL: TaskStatus[] = ['completed', 'rejected', 'budget_exceeded'];

/**
 * Orchestration loop, written as durable steps:
 *   plan -> dispatch wave 0 -> dispatch wave 1 (parallel) -> review/correction (max 2)
 *   -> human approval gate (durable pause) -> merge -> completed + signed event
 * Re-running a task replays journaled steps for free and continues where it stopped.
 */
export class Orchestrator {
  private readonly log = new Logger(Orchestrator.name);
  private readonly inFlight = new Map<string, Promise<RunOutcome>>();

  constructor(
    private readonly store: Store,
    private readonly runtime: DurableRuntime,
    private readonly planner: Planner,
    private readonly dispatcher: Dispatcher,
    private readonly context: ContextStore,
    private readonly memory: SharedMemory,
    private readonly bus: EventBus,
  ) {}

  /** Fire and forget entry point. Concurrent starts of the same task share one run. */
  start(taskId: string): Promise<RunOutcome> {
    const existing = this.inFlight.get(taskId);
    if (existing) return existing;
    const run = this.run(taskId).finally(() => this.inFlight.delete(taskId));
    this.inFlight.set(taskId, run);
    run.catch((err) => this.log.error(`Tarefa ${taskId}: ${(err as Error).message}`));
    return run;
  }

  isRunning(taskId: string): boolean {
    return this.inFlight.has(taskId);
  }

  /** Crash recovery: resume every task left in an active state. */
  async resumeActive(): Promise<number> {
    const tasks = await this.store.listTasksByStatus(ACTIVE);
    tasks.forEach((t) => void this.start(t.id));
    return tasks.length;
  }

  async run(taskId: string): Promise<RunOutcome> {
    const spec = loops().task;
    try {
      return await withTimeout(this.loop(taskId), spec.timeoutMs, 'tarefa');
    } catch (err) {
      return this.fail(taskId, err as Error);
    }
  }

  private async loop(taskId: string): Promise<RunOutcome> {
    const ctx = this.runtime.context(taskId);
    let task = await this.mustGet(taskId);
    if (TERMINAL.includes(task.status)) return task.status as RunOutcome;
    const L = loops();

    // Loop 1: plan
    task = await this.setStatus(task, 'planning');
    const subtasks = await ctx.run('plan', async () => {
      const planned = await withTimeout(this.planner.plan(task), L.plan.timeoutMs, 'planner');
      const list: Subtask[] = planned.map((p, i) => ({
        id: newId(), taskId, agent: p.agent, title: p.title, status: 'pending', model: null, output: null,
        attempt: 1, position: i, startedAt: null, finishedAt: null,
      }));
      await this.store.saveSubtasks(list);
      return list;
    });
    await this.snapshot(ctx, 'plan', { plan: subtasks.map((s) => ({ agent: s.agent, title: s.title })) });

    // Loop 2: dispatch waves (researchers first, then coders and testers in parallel)
    task = await this.setStatus(task, 'running');
    const results: Record<string, AgentResult> = {};
    const work = subtasks.filter((s) => s.agent !== 'reviewer');
    for (const wave of [['researcher'], ['coder', 'tester']]) {
      const batch = work.filter((s) => wave.includes(s.agent));
      if (!batch.length) continue;
      Object.assign(results, await ctx.run(`dispatch:${wave[0]}:1`, () =>
        this.dispatcher.dispatch(task, batch, { attempt: 1, feedback: null })));
    }
    await this.snapshot(ctx, 'dispatch', { outputs: this.brief(subtasks, results) });

    // Loop 3: review and correction (bounded to MAX_CORRECTION_ROUNDS)
    const reviewer = subtasks.find((s) => s.agent === 'reviewer')!;
    const coders = work.filter((s) => s.agent === 'coder');
    for (let round = 0; ; round++) {
      const review = await ctx.run(`review:${round}`, () =>
        this.dispatcher.runOne(task, reviewer, { attempt: round + 1, feedback: null }));
      results[reviewer.id] = review;
      await this.snapshot(ctx, `review-${round + 1}`, { verdict: review.verdict ?? null });
      if (review.verdict?.approved) break;
      if (round >= MAX_CORRECTION_ROUNDS) {
        throw new Error(`Revisão reprovada após ${MAX_CORRECTION_ROUNDS} rodadas de correção: ${review.verdict?.feedback}`);
      }
      task = await this.store.updateTask(taskId, { correctionRounds: round + 1 });
      this.bus.emit('task.status', taskId, { status: task.status, correctionRounds: round + 1 });
      Object.assign(results, await ctx.run(`correction:${round + 1}`, () =>
        this.dispatcher.dispatch(task, coders, { attempt: round + 2, feedback: review.verdict?.feedback ?? null })));
      await this.snapshot(ctx, `correction-${round + 1}`, { outputs: this.brief(coders, results) });
    }

    // Loop 4: human approval (durable pause)
    if (task.requiresApproval) {
      const approval = await this.store.getApproval(taskId);
      if (!approval || approval.status === 'pending') {
        if (!approval) {
          await this.store.upsertApproval({ taskId, status: 'pending', note: null, requestedAt: nowIso(), resolvedAt: null });
          this.bus.emit('approval.requested', taskId, {});
        }
        await this.setStatus(task, 'awaiting_approval');
        return 'paused';
      }
      if (approval.status === 'rejected') {
        await this.finish(taskId, 'rejected', { error: approval.note ?? 'Rejeitada na aprovação humana' }, 'task.rejected');
        return 'rejected';
      }
    }

    // Loop 5: merge
    task = await this.setStatus(task, 'merging');
    const result = await ctx.run('merge', async () => mergeResults(subtasks, results));
    await this.snapshot(ctx, 'merge', { result });
    await this.finish(taskId, 'completed', { result, error: null }, 'task.completed');
    return 'completed';
  }

  private brief(subtasks: Subtask[], results: Record<string, AgentResult>) {
    return subtasks.filter((s) => results[s.id]).map((s) => ({ agent: s.agent, title: s.title, model: results[s.id].model }));
  }

  private async snapshot(ctx: DurableContext, label: string, extra: Record<string, unknown>) {
    await ctx.run(`snapshot:${label}`, async () => {
      const [task, memory] = await Promise.all([this.mustGet(ctx.executionId), this.memory.list(ctx.executionId)]);
      const s = await this.context.commit(ctx.executionId, label, {
        stage: label, status: task.status, spentUsd: task.spentUsd,
        memory: memory.map((m) => ({ key: m.key, value: m.value })), ...extra,
      });
      return s.version;
    });
  }

  private async fail(taskId: string, err: Error): Promise<RunOutcome> {
    const budget = err instanceof BudgetExceededError;
    const status: TaskStatus = budget ? 'budget_exceeded' : 'failed';
    for (const s of await this.store.listSubtasks(taskId)) {
      if (s.status === 'pending' || s.status === 'running') {
        await this.store.updateSubtask(s.id, { status: 'cancelled', finishedAt: nowIso() });
        this.bus.emit('subtask.status', taskId, { subtaskId: s.id, agent: s.agent, title: s.title, status: 'cancelled' });
      }
    }
    await this.finish(taskId, status, { error: err.message }, budget ? 'task.budget_exceeded' : 'task.failed');
    return budget ? 'budget_exceeded' : 'failed';
  }

  /** Final state and its outbox event are written in one transaction. */
  private async finish(taskId: string, status: TaskStatus, patch: Partial<Task>, eventType: string) {
    const task = await this.store.updateTaskWithEvent(taskId, { ...patch, status },
      outboxEvent(eventType, { taskId, status, ...patch }));
    this.bus.emit('task.status', taskId, { status, error: task.error, spentUsd: task.spentUsd });
    return task;
  }

  private async setStatus(task: Task, status: TaskStatus): Promise<Task> {
    if (task.status === status) return task;
    const updated = await this.store.updateTask(task.id, { status });
    this.bus.emit('task.status', task.id, { status });
    return updated;
  }

  private async mustGet(id: string): Promise<Task> {
    const t = await this.store.getTask(id);
    if (!t) throw new Error(`Tarefa ${id} não encontrada`);
    return t;
  }
}
