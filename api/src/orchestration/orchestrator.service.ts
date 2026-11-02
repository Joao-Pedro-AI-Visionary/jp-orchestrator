import { hostname } from 'node:os';
import { Logger, OnModuleDestroy } from '@nestjs/common';
import { Subtask, Task, TaskLease, TaskStatus, TERMINAL_STATUSES } from '../common/types';
import {
  envNumber, newId, nowIso, runWithTimeout, settleWithin, stableId, throwIfAborted, TimeoutError, untilAborted,
} from '../common/util';
import { AgentResult } from '../agents/agent-strategy';
import { BudgetExceededError } from '../billing/billing.service';
import { DurableContext, DurableRuntime } from '../durable/durable-runtime';
import { EventBus } from '../events/event-bus';
import { ContextStore } from '../memory/context-store.service';
import { SharedMemory } from '../memory/shared-memory';
import { withLogContext } from '../observability/log-context';
import { Store } from '../persistence/store.port';
import { outboxEvent } from '../tools/tool-invoker.service';
import { Dispatcher } from './dispatcher';
import { loops, MAX_CORRECTION_ROUNDS } from './loops';
import { mergeResults } from './merger';
import { Planner } from './planner';

/** 'busy': another owner (replica, or a cancelled run still settling) holds the task lease; nothing ran. */
export type RunOutcome = 'completed' | 'paused' | 'failed' | 'rejected' | 'budget_exceeded' | 'busy';
const ACTIVE: TaskStatus[] = ['queued', 'planning', 'running', 'merging'];

/** The task is leased by another run (here or on another replica). */
export class TaskBusyError extends Error {
  constructor(readonly taskId: string) {
    super(`Tarefa ${taskId} já está em execução`);
  }
}

export class TaskNotResumableError extends Error {
  constructor(readonly taskId: string, readonly status: TaskStatus) {
    super(`Tarefa em ${status} não pode ser retomada`);
  }
}

/** The heartbeat found the lease taken over: stop without writing anything else. */
export class LeaseLostError extends Error {
  constructor(taskId: string) {
    super(`Lease da tarefa ${taskId} perdido para outro dono`);
  }
}

/** The process is shutting down: stop and hand the lease back without failing the task. */
class ShutdownError extends Error {
  constructor() {
    super('processo encerrando');
  }
}

/** A guarded write was refused: the task is already final or its lease moved. */
class WriteRefusedError extends Error {
  constructor(taskId: string) {
    super(`Escrita recusada para a tarefa ${taskId}: estado final ou lease perdido`);
  }
}

export interface OrchestratorOptions {
  /** Lease owner id. Default: host:pid:random, unique per process. */
  ownerId?: string;
  /** TASK_LEASE_MS (30s). The heartbeat renews it every third of it. */
  leaseMs?: number;
  /** ABORT_GRACE_MS (5s): how long a cancelled run may take to stop before its lease is released. */
  abortGraceMs?: number;
}

const outcomeOf = (status: TaskStatus): RunOutcome =>
  TERMINAL_STATUSES.includes(status) ? (status as RunOutcome) : status === 'awaiting_approval' ? 'paused' : 'busy';

/**
 * Orchestration loop, written as durable steps:
 *   plan -> dispatch wave 0 -> dispatch wave 1 (parallel) -> review/correction (max 2)
 *   -> human approval gate (durable pause) -> merge -> completed + signed event
 * Re-running a task replays journaled steps for free and continues where it stopped.
 *
 * Ownership: a run first takes the task lease (store, fenced by token) and renews it
 * with a heartbeat, so replicas resuming on boot, the periodic sweep and /resume never
 * run one task twice. Cancellation: the task timeout aborts one AbortSignal that
 * reaches the dispatcher, agents, gateway, provider and tools. The terminal status is
 * written at once and only once (store guard); the lease is kept until the cancelled
 * run actually stopped (bounded by ABORT_GRACE_MS), so nothing restarts next to it.
 */
export class Orchestrator implements OnModuleDestroy {
  private readonly log = new Logger(Orchestrator.name);
  private readonly inFlight = new Map<string, Promise<RunOutcome>>();
  readonly ownerId: string;
  private readonly leaseMs: number;
  private readonly abortGraceMs: number;
  private sweep: NodeJS.Timeout | null = null;
  private readonly owners = new Map<string, AbortController>();

  constructor(
    private readonly store: Store,
    private readonly runtime: DurableRuntime,
    private readonly planner: Planner,
    private readonly dispatcher: Dispatcher,
    private readonly context: ContextStore,
    private readonly memory: SharedMemory,
    private readonly bus: EventBus,
    opts: OrchestratorOptions = {},
  ) {
    this.ownerId = opts.ownerId ?? `${hostname()}:${process.pid}:${newId().slice(0, 8)}`;
    this.leaseMs = opts.leaseMs ?? envNumber('TASK_LEASE_MS', 30_000);
    this.abortGraceMs = opts.abortGraceMs ?? envNumber('ABORT_GRACE_MS', 5_000);
  }

  /** Fire and forget entry point. Concurrent starts of the same task share one run. */
  start(taskId: string, lease?: TaskLease): Promise<RunOutcome> {
    const existing = this.inFlight.get(taskId);
    if (existing) {
      // The caller holds the lease, so the run in flight cannot own it and ends as 'busy'; run after it.
      if (lease) return existing.catch(() => undefined).then(() => this.start(taskId, lease));
      return existing;
    }
    // Every log line written by this run (and the async work it starts) carries the taskId.
    const run = withLogContext({ taskId }, () => this.run(taskId, lease)).finally(() => this.inFlight.delete(taskId));
    this.inFlight.set(taskId, run);
    run.catch((err) => this.log.error(`Tarefa ${taskId}: ${(err as Error).message}`));
    return run;
  }

  isRunning(taskId: string): boolean {
    return this.inFlight.has(taskId);
  }

  /**
   * Crash recovery: resume every task left in an active state, plus every task still
   * awaiting approval whose approval was already decided (its continuation was lost,
   * e.g. the decision arrived while the paused run still held the lease). Tasks leased
   * elsewhere come back as 'busy' and are retried by the next sweep.
   */
  async resumeActive(): Promise<number> {
    const tasks = await this.store.listTasksByStatus([...ACTIVE, 'awaiting_approval']);
    let started = 0;
    for (const t of tasks) {
      if (t.status === 'awaiting_approval' && (await this.store.getApproval(t.id))?.status === 'pending') continue;
      void this.start(t.id);
      started++;
    }
    return started;
  }

  /** After an approval decision: continue the task once the paused run (if still settling) has let go. */
  async continueAfterApproval(taskId: string): Promise<RunOutcome> {
    await this.inFlight.get(taskId)?.catch(() => undefined);
    return this.start(taskId);
  }

  /** Re-runs resumeActive periodically, so a task whose owner died is picked up once its lease expires. */
  startSweep(intervalMs = this.leaseMs): void {
    this.stopSweep();
    this.sweep = setInterval(() => {
      this.resumeActive().catch((err) => this.log.error(`Varredura de retomada: ${(err as Error).message}`));
    }, intervalMs);
    this.sweep.unref();
  }

  stopSweep(): void {
    if (this.sweep) clearInterval(this.sweep);
    this.sweep = null;
  }

  /** Shutdown: stop every run without failing it and release its lease, so another replica resumes it at once. */
  async onModuleDestroy(): Promise<void> {
    this.stopSweep();
    for (const owner of this.owners.values()) owner.abort(new ShutdownError());
    await Promise.all([...this.inFlight.values()].map((r) => r.catch(() => undefined)));
  }

  /**
   * POST /tasks/:id/resume. Takes the lease before touching the task, so it fails with
   * TaskBusyError while any run (including a cancelled one still stopping) owns it.
   */
  async resume(taskId: string): Promise<Task> {
    if (this.inFlight.has(taskId)) throw new TaskBusyError(taskId);
    const lease = await this.store.acquireTaskLease(taskId, this.ownerId, this.leaseMs);
    if (!lease) throw new TaskBusyError(taskId);
    const task = await this.store.reopenTask(taskId, lease);
    if (!task) {
      await this.store.releaseTaskLease(taskId, lease);
      throw new TaskNotResumableError(taskId, (await this.mustGet(taskId)).status);
    }
    this.bus.emit('task.status', taskId, { status: 'running' });
    void this.start(taskId, lease);
    return task;
  }

  /** Runs the task under its lease. Pass `held` when the caller already acquired it. */
  async run(taskId: string, held?: TaskLease): Promise<RunOutcome> {
    const lease = held ?? await this.store.acquireTaskLease(taskId, this.ownerId, this.leaseMs);
    if (!lease) return 'busy';
    const spec = loops().task;
    // Reservations left by a crashed run would eat the budget forever. Only those older than the task
    // timeout go: a younger one may belong to a call of a cancelled run that is still settling (the
    // lease is released after ABORT_GRACE_MS even if that call ignores its signal). Best effort.
    await this.store.releaseTaskReservations(taskId, spec.timeoutMs)
      .catch((err) => this.log.warn(`Tarefa ${taskId}: reservas órfãs não liberadas: ${(err as Error).message}`));
    const owner = new AbortController();
    this.owners.set(taskId, owner);
    const timer = setTimeout(() => owner.abort(new TimeoutError('tarefa', spec.timeoutMs)), spec.timeoutMs);
    const heartbeat = setInterval(() => {
      this.store.renewTaskLease(taskId, lease, this.leaseMs).then(
        (ok) => { if (!ok) owner.abort(new LeaseLostError(taskId)); },
        () => undefined, // transient store error: the next beat retries, the token still fences
      );
    }, Math.max(10, Math.floor(this.leaseMs / 3)));
    const work = this.loop(taskId, lease, owner.signal);
    try {
      return await untilAborted(work, owner.signal);
    } catch (err) {
      if (err instanceof LeaseLostError || err instanceof ShutdownError) {
        this.log.warn(`Tarefa ${taskId}: ${err.message}`);
        return 'busy';
      }
      owner.abort(err);
      return await this.fail(taskId, err as Error, lease);
    } finally {
      clearTimeout(timer);
      // Keep the lease until the cancelled loop stopped, so /resume or another replica cannot overlap it.
      await settleWithin(work, this.abortGraceMs);
      clearInterval(heartbeat);
      this.owners.delete(taskId);
      await this.store.releaseTaskLease(taskId, lease).catch(() => undefined);
    }
  }

  private async loop(taskId: string, lease: TaskLease, signal: AbortSignal): Promise<RunOutcome> {
    const ctx = this.runtime.context(taskId, { signal });
    let task = await this.mustGet(taskId);
    if (TERMINAL_STATUSES.includes(task.status)) return task.status as RunOutcome;
    const L = loops();
    const setStatus = (t: Task, status: TaskStatus) => this.setStatus(t, status, lease, signal);

    // Loop 1: plan. Ids derive from (task, position): a re-run after a crash between
    // saveSubtasks and the journal entry reuses the same subtasks and tool keys.
    task = await setStatus(task, 'planning');
    const subtasks = await ctx.run('plan', async () => {
      const planned = await runWithTimeout((s) => this.planner.plan(task, s), L.plan.timeoutMs, 'planner', { parent: signal });
      const list: Subtask[] = planned.map((p, i) => ({
        id: stableId(taskId, 'subtask', i), taskId, agent: p.agent, title: p.title, status: 'pending', model: null, output: null,
        attempt: 1, position: i, startedAt: null, finishedAt: null,
      }));
      await this.store.saveSubtasks(list);
      return list;
    });
    await this.snapshot(ctx, 'plan', { plan: subtasks.map((s) => ({ agent: s.agent, title: s.title })) });

    // Loop 2: dispatch waves (researchers first, then coders and testers in parallel)
    task = await setStatus(task, 'running');
    const results: Record<string, AgentResult> = {};
    const work = subtasks.filter((s) => s.agent !== 'reviewer');
    for (const wave of [['researcher'], ['coder', 'tester']]) {
      const batch = work.filter((s) => wave.includes(s.agent));
      if (!batch.length) continue;
      Object.assign(results, await ctx.run(`dispatch:${wave[0]}:1`, () =>
        this.dispatcher.dispatch(task, batch, { attempt: 1, feedback: null, signal })));
    }
    await this.snapshot(ctx, 'dispatch', { outputs: this.brief(subtasks, results) });

    // Loop 3: review and correction (bounded to MAX_CORRECTION_ROUNDS)
    const reviewer = subtasks.find((s) => s.agent === 'reviewer')!;
    const coders = work.filter((s) => s.agent === 'coder');
    for (let round = 0; ; round++) {
      const review = await ctx.run(`review:${round}`, () =>
        this.dispatcher.runOne(task, reviewer, { attempt: round + 1, feedback: null, signal }));
      results[reviewer.id] = review;
      await this.snapshot(ctx, `review-${round + 1}`, { verdict: review.verdict ?? null });
      if (review.verdict?.approved) break;
      if (round >= MAX_CORRECTION_ROUNDS) {
        throw new Error(`Revisão reprovada após ${MAX_CORRECTION_ROUNDS} rodadas de correção: ${review.verdict?.feedback}`);
      }
      throwIfAborted(signal);
      task = this.guarded(taskId, await this.store.updateActiveTask(taskId, { correctionRounds: round + 1 }, lease));
      this.bus.emit('task.status', taskId, { status: task.status, correctionRounds: round + 1 });
      Object.assign(results, await ctx.run(`correction:${round + 1}`, () =>
        this.dispatcher.dispatch(task, coders, { attempt: round + 2, feedback: review.verdict?.feedback ?? null, signal })));
      await this.snapshot(ctx, `correction-${round + 1}`, { outputs: this.brief(coders, results) });
    }

    // Loop 4: human approval (durable pause)
    let decidedBy: string | null = null;
    if (task.requiresApproval) {
      const approval = await this.store.getApproval(taskId);
      if (!approval || approval.status === 'pending') {
        if (!approval) {
          await this.store.upsertApproval({ taskId, status: 'pending', note: null, requestedAt: nowIso(), resolvedAt: null });
          this.bus.emit('approval.requested', taskId, {});
        }
        await setStatus(task, 'awaiting_approval');
        return 'paused';
      }
      decidedBy = approval.decidedBy ?? null;
      if (approval.status === 'rejected') {
        throwIfAborted(signal);
        const done = await this.finish(taskId, 'rejected', { error: approval.note ?? 'Rejeitada na aprovação humana' }, 'task.rejected', lease, { decidedBy });
        return done ? 'rejected' : outcomeOf((await this.mustGet(taskId)).status);
      }
    }

    // Loop 5: merge
    task = await setStatus(task, 'merging');
    const result = await ctx.run('merge', async () => mergeResults(subtasks, results));
    await this.snapshot(ctx, 'merge', { result });
    throwIfAborted(signal);
    const done = await this.finish(taskId, 'completed', { result, error: null }, 'task.completed', lease,
      task.requiresApproval ? { decidedBy } : {});
    return done ? 'completed' : outcomeOf((await this.mustGet(taskId)).status);
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

  /**
   * Terminal failure. The guarded transition happens at most once: when the task is
   * already final (or the lease moved) nothing is written and no second event is emitted.
   */
  private async fail(taskId: string, err: Error, lease: TaskLease): Promise<RunOutcome> {
    const budget = err instanceof BudgetExceededError;
    const status: TaskStatus = budget ? 'budget_exceeded' : 'failed';
    const done = await this.finish(taskId, status, { error: err.message }, budget ? 'task.budget_exceeded' : 'task.failed', lease);
    if (!done) return outcomeOf((await this.mustGet(taskId)).status);
    for (const s of await this.store.listSubtasks(taskId)) {
      if (s.status === 'pending' || s.status === 'running') {
        await this.store.updateSubtask(s.id, { status: 'cancelled', finishedAt: nowIso() });
        this.bus.emit('subtask.status', taskId, { subtaskId: s.id, agent: s.agent, title: s.title, status: 'cancelled' });
      }
    }
    return status as RunOutcome;
  }

  /** Final state and its outbox event (plus extra payload, e.g. the approver) are written in one guarded transaction. Null when refused. */
  private async finish(taskId: string, status: TaskStatus, patch: Partial<Task>, eventType: string, lease: TaskLease, extra: Record<string, unknown> = {}) {
    const task = await this.store.finishTask(taskId, { ...patch, status },
      outboxEvent(eventType, { taskId, status, ...patch, ...extra }), lease);
    if (task) this.bus.emit('task.status', taskId, { status, error: task.error, spentUsd: task.spentUsd });
    return task;
  }

  private async setStatus(task: Task, status: TaskStatus, lease: TaskLease, signal: AbortSignal): Promise<Task> {
    throwIfAborted(signal);
    if (task.status === status) return task;
    const updated = this.guarded(task.id, await this.store.updateActiveTask(task.id, { status }, lease));
    this.bus.emit('task.status', task.id, { status });
    return updated;
  }

  private guarded(taskId: string, task: Task | null): Task {
    if (!task) throw new WriteRefusedError(taskId);
    return task;
  }

  private async mustGet(id: string): Promise<Task> {
    const t = await this.store.getTask(id);
    if (!t) throw new Error(`Tarefa ${id} não encontrada`);
    return t;
  }
}
