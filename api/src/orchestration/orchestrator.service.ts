import { hostname } from 'node:os';
import { Logger } from '@nestjs/common';
import { DomainError, publicMessage, ReviewRejectedError } from '../common/errors';
import { Subtask, Task, TaskStatus } from '../common/types';
import { envNumber, newId, nowIso, TimeoutError, withDeadline } from '../common/util';
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

/** 'leased': another runner (this or another replica) holds the task lease; nothing was done. */
export type RunOutcome = 'completed' | 'paused' | 'failed' | 'rejected' | 'budget_exceeded' | 'leased';
const ACTIVE: TaskStatus[] = ['queued', 'planning', 'running', 'merging'];
const TERMINAL: TaskStatus[] = ['completed', 'rejected', 'budget_exceeded'];

/** Expected under replicas, not a bug: a DomainError so it is not logged as an internal error. */
export class LeaseLostError extends DomainError {
  constructor(taskId: string) {
    super(`Lease da tarefa ${taskId} perdido: outro executor assumiu`);
  }
}

type Step = <T>(name: string, fn: () => Promise<T>) => Promise<T>;

/**
 * Orchestration loop, written as durable steps:
 *   plan -> dispatch wave 0 -> dispatch wave 1 (parallel) -> review/correction (max 2)
 *   -> human approval gate (durable pause) -> merge -> completed + signed event
 * Re-running a task replays journaled steps for free and continues where it stopped.
 *
 * One runner per task: a run first takes the task lease in the store (works across
 * replicas), renews it by heartbeat and releases it only after the loop has really
 * stopped. The task timeout aborts an AbortSignal that every step, subagent and
 * model call honors, and the final state is written only while the task is not
 * terminal yet, so a task emits exactly one terminal event.
 */
export class Orchestrator {
  private readonly log = new Logger(Orchestrator.name);
  private readonly inFlight = new Map<string, Promise<RunOutcome>>();
  /** Lease owner id of this process. */
  readonly owner = `${hostname()}:${process.pid}:${newId()}`;
  private readonly leaseMs = envNumber('TASK_LEASE_MS', 30_000);

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
  start(taskId: string, leaseHeld = false): Promise<RunOutcome> {
    const existing = this.inFlight.get(taskId);
    if (existing) return existing;
    const run = this.run(taskId, leaseHeld).finally(() => this.inFlight.delete(taskId));
    this.inFlight.set(taskId, run);
    run.catch((err) => this.log.error(`Tarefa ${taskId}: ${(err as Error).message}`));
    return run;
  }

  isRunning(taskId: string): boolean {
    return this.inFlight.has(taskId);
  }

  /** True while this process or any other replica holds the task lease. */
  async isRunningAnywhere(taskId: string): Promise<boolean> {
    return this.inFlight.has(taskId) || this.store.isTaskLeased(taskId);
  }

  /**
   * A failed task can be resumed unless it failed because the reviewer still rejected
   * after the last correction round: that verdict is journaled, so a resume would
   * replay it and fail the same way.
   */
  async canResume(taskId: string): Promise<boolean> {
    const last = await this.store.getStep(taskId, `review:${MAX_CORRECTION_ROUNDS}`);
    return (last?.value as AgentResult | null)?.verdict?.approved !== false;
  }

  /**
   * Crash recovery: claims the lease of each task left in an active state and
   * resumes only the ones it won. Returns how many were claimed here.
   */
  async resumeActive(): Promise<number> {
    let claimed = 0;
    for (const t of await this.store.listTasksByStatus(ACTIVE)) {
      if (this.inFlight.has(t.id) || !(await this.store.acquireTaskLease(t.id, this.owner, this.leaseMs))) continue;
      claimed++;
      void this.start(t.id, true);
    }
    return claimed;
  }

  async run(taskId: string, leaseHeld = false): Promise<RunOutcome> {
    if (!leaseHeld && !(await this.store.acquireTaskLease(taskId, this.owner, this.leaseMs))) return 'leased';
    const timeoutMs = loops().task.timeoutMs;
    const abort = new AbortController();
    const deadline = setTimeout(() => abort.abort(new TimeoutError('tarefa', timeoutMs)), timeoutMs);
    const heartbeat = setInterval(() => {
      this.store.renewTaskLease(taskId, this.owner, this.leaseMs).then(
        (ok) => { if (!ok) abort.abort(new LeaseLostError(taskId)); },
        (err) => this.log.warn(`Tarefa ${taskId}: falha ao renovar o lease: ${(err as Error).message}`),
      );
    }, Math.max(50, Math.floor(this.leaseMs / 3)));
    deadline.unref();
    heartbeat.unref();
    try {
      // Awaited to the end: the lease is only released once the loop has really stopped.
      return await this.loop(taskId, abort.signal);
    } catch (err) {
      const reason = (abort.signal.aborted ? abort.signal.reason : err) as Error;
      if (reason instanceof LeaseLostError) {
        this.log.warn(reason.message);
        return 'leased';
      }
      return await this.fail(taskId, reason);
    } finally {
      clearTimeout(deadline);
      clearInterval(heartbeat);
      await this.store.releaseTaskLease(taskId, this.owner);
    }
  }

  private async loop(taskId: string, signal: AbortSignal): Promise<RunOutcome> {
    const ctx = this.runtime.context(taskId);
    const step: Step = (name, fn) => {
      signal.throwIfAborted();
      return ctx.run(name, fn);
    };
    let task = await this.mustGet(taskId);
    if (TERMINAL.includes(task.status)) return task.status as RunOutcome;
    const L = loops();

    // Loop 1: plan
    task = await this.setStatus(task, 'planning');
    const subtasks = await step('plan', async () => {
      const planned = await withDeadline((s) => this.planner.plan(task, s), L.plan.timeoutMs, 'planner', signal);
      const list: Subtask[] = planned.map((p, i) => ({
        id: newId(), taskId, agent: p.agent, title: p.title, status: 'pending', model: null, output: null,
        attempt: 1, position: i, startedAt: null, finishedAt: null,
      }));
      return list;
    });
    // Saved from the journaled plan (idempotent on id): a runner that lost the plan race
    // adopts the winner's ids and never stores a second set; a crash before this line replays it.
    await this.store.saveSubtasks(subtasks);
    await this.snapshot(ctx, step, 'plan', { plan: subtasks.map((s) => ({ agent: s.agent, title: s.title })) });

    // Loop 2: dispatch waves (researchers first, then coders and testers in parallel)
    task = await this.setStatus(task, 'running');
    const results: Record<string, AgentResult> = {};
    const work = subtasks.filter((s) => s.agent !== 'reviewer');
    for (const wave of [['researcher'], ['coder', 'tester']]) {
      const batch = work.filter((s) => wave.includes(s.agent));
      if (!batch.length) continue;
      Object.assign(results, await step(`dispatch:${wave[0]}:1`, () =>
        this.dispatcher.dispatch(task, batch, { attempt: 1, feedback: null, signal })));
    }
    await this.snapshot(ctx, step, 'dispatch', { outputs: this.brief(subtasks, results) });

    // Loop 3: review and correction (bounded to MAX_CORRECTION_ROUNDS)
    const reviewer = subtasks.find((s) => s.agent === 'reviewer')!;
    const coders = work.filter((s) => s.agent === 'coder');
    for (let round = 0; ; round++) {
      const review = await step(`review:${round}`, () =>
        this.dispatcher.runOne(task, reviewer, { attempt: round + 1, feedback: null, signal, team: subtasks }));
      results[reviewer.id] = review;
      await this.snapshot(ctx, step, `review-${round + 1}`, { verdict: review.verdict ?? null });
      if (review.verdict?.approved) break;
      if (round >= MAX_CORRECTION_ROUNDS) {
        throw new ReviewRejectedError(MAX_CORRECTION_ROUNDS, review.verdict?.feedback);
      }
      task = await this.store.updateTask(taskId, { correctionRounds: round + 1 });
      this.bus.emit('task.status', taskId, { status: task.status, correctionRounds: round + 1 });
      Object.assign(results, await step(`correction:${round + 1}`, () =>
        this.dispatcher.dispatch(task, coders, { attempt: round + 2, feedback: review.verdict?.feedback ?? null, signal })));
      await this.snapshot(ctx, step, `correction-${round + 1}`, { outputs: this.brief(coders, results) });
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
        signal.throwIfAborted();
        await this.finish(taskId, 'rejected', { error: approval.note ?? 'Rejeitada na aprovação humana' }, 'task.rejected');
        return 'rejected';
      }
    }

    // Loop 5: merge
    task = await this.setStatus(task, 'merging');
    const result = await step('merge', async () => mergeResults(subtasks, results));
    await this.snapshot(ctx, step, 'merge', { result });
    signal.throwIfAborted();
    await this.finish(taskId, 'completed', { result, error: null }, 'task.completed');
    return 'completed';
  }

  private brief(subtasks: Subtask[], results: Record<string, AgentResult>) {
    return subtasks.filter((s) => results[s.id]).map((s) => ({ agent: s.agent, title: s.title, model: results[s.id].model }));
  }

  /**
   * Labels are unique per task. A crash after the commit but before the journal write
   * replays this step: it finds its own snapshot and does not append a second one.
   */
  private async snapshot(ctx: DurableContext, step: Step, label: string, extra: Record<string, unknown>) {
    await step(`snapshot:${label}`, async () => {
      const done = (await this.context.history(ctx.executionId)).find((s) => s.label === label);
      if (done) return done.version;
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
    // Domain message only (timeout, budget, review...): internals go to the log with a ref id.
    const error = publicMessage(err, `tarefa ${taskId}`);
    const done = await this.finish(taskId, status, { error }, budget ? 'task.budget_exceeded' : 'task.failed');
    if (!done) return (await this.mustGet(taskId)).status as RunOutcome;
    return budget ? 'budget_exceeded' : 'failed';
  }

  /**
   * Final state and its outbox event, in one transaction and only while the task is
   * not terminal yet (null otherwise): one terminal event per task.
   */
  private async finish(taskId: string, status: TaskStatus, patch: Partial<Task>, eventType: string) {
    const task = await this.store.finishTask(taskId, { ...patch, status },
      outboxEvent(eventType, { taskId, status, ...patch }));
    if (!task) {
      this.log.warn(`Tarefa ${taskId} já estava em estado final: ${eventType} não emitido`);
      return null;
    }
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
