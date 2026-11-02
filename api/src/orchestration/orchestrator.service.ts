import { hostname } from 'node:os';
import { Logger, OnModuleDestroy } from '@nestjs/common';
import { Subtask, Task, TaskLease, TaskStatus, TERMINAL_STATUSES } from '../common/types';
import {
  envNumber, newId, nowIso, runWithTimeout, settleWithin, stableId, throwIfAborted, TimeoutError, untilAborted,
} from '../common/util';
import { AgentResult } from '../agents/agent-strategy';
import { BudgetExceededError } from '../billing/billing.service';
import {
  AnyDurableRuntime, DurableContext, DurableEngine, DurableExecution, ExecutionCancelledError, ExecutionRejectedError,
  ExecutionYieldedError, isEngine,
} from '../durable/durable-runtime';
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

/**
 * 'busy': another owner (replica, or a cancelled run still settling) holds the task lease; nothing ran.
 * 'submitted': handed to the durable engine (DURABLE_RUNTIME=restate), which runs it on its own.
 */
export type RunOutcome = 'completed' | 'paused' | 'failed' | 'rejected' | 'budget_exceeded' | 'busy' | 'submitted';
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

/** Inputs of one pass of the loop: the step context, its cancellation signal and (journal runtime) the task lease. */
interface LoopEnv { ctx: DurableContext; signal: AbortSignal; lease?: TaskLease }

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
 *
 * With a durable engine (DURABLE_RUNTIME=restate) the same loop runs inside the engine's
 * execution (execute()): the engine owns the task (one execution per task id), the timeout
 * is its durable timer and approval and /resume are signals; there is no lease here.
 */
export class Orchestrator implements OnModuleDestroy {
  private readonly log = new Logger(Orchestrator.name);
  private readonly inFlight = new Map<string, Promise<RunOutcome>>();
  readonly ownerId: string;
  private readonly leaseMs: number;
  private readonly abortGraceMs: number;
  private sweep: NodeJS.Timeout | null = null;
  private readonly owners = new Map<string, AbortController>();
  private readonly engine: DurableEngine | null;

  constructor(
    private readonly store: Store,
    private readonly runtime: AnyDurableRuntime,
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
    this.engine = isEngine(runtime) ? runtime : null;
    this.engine?.bind((taskId, exec) => this.execute(taskId, exec));
  }

  /** Fire and forget entry point. Concurrent starts of the same task share one run. */
  start(taskId: string, lease?: TaskLease): Promise<RunOutcome> {
    if (this.engine) return this.submit(taskId);
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
      if (this.engine) {
        // Idempotent on the engine: a submit of an accepted task is deduped, a decided approval is re-delivered.
        void (t.status === 'awaiting_approval' ? this.signalApproval(t.id) : this.submitOrRecover(t.id));
      } else {
        void this.start(t.id);
      }
      started++;
    }
    return started;
  }

  /** After an approval decision: continue the task once the paused run (if still settling) has let go. */
  async continueAfterApproval(taskId: string): Promise<RunOutcome> {
    if (this.engine) {
      // Never rejects (the approve route fires and forgets): the decision is stored, the sweep re-delivers it.
      if (!(await this.signalApproval(taskId))) return 'submitted';
      // Short bounded wait, so the HTTP answer usually shows the decision applied (rejected, merging...).
      const task = await this.waitWhile(taskId, (t) => t.status === 'awaiting_approval', 5_000);
      return TERMINAL_STATUSES.includes(task.status) ? task.status as RunOutcome : 'submitted';
    }
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
    if (this.engine) return this.resumeOnEngine(taskId, this.engine);
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
    if (this.engine) return this.submit(taskId);
    const local = this.runtime as Exclude<AnyDurableRuntime, DurableEngine>;
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
    const work = this.loop(taskId, { ctx: local.context(taskId, { signal: owner.signal }), signal: owner.signal, lease });
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

  /**
   * One pass of the loop. Every store access that steers it goes through ctx.effect: a plain call
   * on the journal runtime, a journaled one on an engine (so its replay takes the same path).
   */
  private async loop(taskId: string, { ctx, signal, lease }: LoopEnv): Promise<RunOutcome> {
    let task = await ctx.effect('load', () => this.mustGet(taskId));
    if (TERMINAL_STATUSES.includes(task.status)) return task.status as RunOutcome;
    const L = loops();
    const setStatus = (t: Task, status: TaskStatus) => this.setStatus(ctx, t, status, lease, signal);
    const current = async () => outcomeOf((await ctx.effect('reload', () => this.mustGet(taskId))).status);

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
      task = this.guarded(taskId, await ctx.effect(`correction-round:${round + 1}`, async () => {
        const t = await this.store.updateActiveTask(taskId, { correctionRounds: round + 1 }, lease);
        if (t) this.bus.emit('task.status', taskId, { status: t.status, correctionRounds: round + 1 });
        return t;
      }));
      Object.assign(results, await ctx.run(`correction:${round + 1}`, () =>
        this.dispatcher.dispatch(task, coders, { attempt: round + 2, feedback: review.verdict?.feedback ?? null, signal })));
      await this.snapshot(ctx, `correction-${round + 1}`, { outputs: this.brief(coders, results) });
    }

    // Loop 4: human approval (durable pause)
    let decidedBy: string | null = null;
    if (task.requiresApproval) {
      const approval = await ctx.effect('approval', async () => {
        const found = await this.store.getApproval(taskId);
        if (found) return found;
        const pending = { taskId, status: 'pending' as const, note: null, requestedAt: nowIso(), resolvedAt: null };
        await this.store.upsertApproval(pending);
        this.bus.emit('approval.requested', taskId, {});
        return pending;
      });
      if (approval.status === 'pending') {
        await setStatus(task, 'awaiting_approval');
        return 'paused';
      }
      decidedBy = approval.decidedBy ?? null;
      if (approval.status === 'rejected') {
        throwIfAborted(signal);
        const done = await ctx.effect('finish:rejected', () =>
          this.finish(taskId, 'rejected', { error: approval.note ?? 'Rejeitada na aprovação humana' }, 'task.rejected', lease, { decidedBy }));
        return done ? 'rejected' : current();
      }
    }

    // Loop 5: merge
    task = await setStatus(task, 'merging');
    const result = await ctx.run('merge', async () => mergeResults(subtasks, results));
    await this.snapshot(ctx, 'merge', { result });
    throwIfAborted(signal);
    const done = await ctx.effect('finish:completed', () => this.finish(taskId, 'completed', { result, error: null }, 'task.completed', lease,
      task.requiresApproval ? { decidedBy } : {}));
    return done ? 'completed' : current();
  }

  /**
   * Engine body (DURABLE_RUNTIME=restate): runs once per task inside the engine's execution.
   * Each pass is bounded by the durable timer; a pause waits for the approval signal and a
   * failure waits for /resume (the engine keeps the journal, so completed steps are not re-run).
   */
  async execute(taskId: string, exec: DurableExecution): Promise<RunOutcome> {
    return withLogContext({ taskId }, async () => {
      if (!(await exec.effect('exists', async () => !!(await this.store.getTask(taskId))))) {
        throw new ExecutionRejectedError(`Tarefa ${taskId} não encontrada`);
      }
      const spec = loops().task;
      for (;;) {
        const pass = exec.pass(spec.timeoutMs);
        let outcome: RunOutcome;
        let cancelled = false;
        try {
          await pass.ctx.effect('release-reservations', () => this.store.releaseTaskReservations(taskId, spec.timeoutMs).catch(() => 0));
          outcome = await this.loop(taskId, { ctx: pass.ctx, signal: pass.signal });
        } catch (err) {
          if (err instanceof ExecutionYieldedError) throw err; // the attempt is over: Restate resumes it, write nothing
          pass.abort(err);
          cancelled = err instanceof ExecutionCancelledError;
          outcome = await exec.fail(() => this.fail(taskId, err as Error));
        } finally {
          pass.close();
        }
        try {
          if (outcome === 'paused') {
            await exec.awaitApproval();
            continue;
          }
          if (outcome === 'failed' && !cancelled && await exec.awaitResume()) continue;
        } catch (err) {
          if (!(err instanceof ExecutionCancelledError)) throw err;
          return exec.fail(() => this.fail(taskId, err));
        }
        return outcome;
      }
    });
  }

  private async submit(taskId: string): Promise<RunOutcome> {
    try {
      await this.engine!.submit(taskId);
      return 'submitted';
    } catch (err) {
      // The sweep (resumeActive) submits it again; the task stays queued meanwhile.
      this.log.error(`Tarefa ${taskId}: envio ao runtime durável falhou: ${(err as Error).message}`);
      return 'busy';
    }
  }

  /** false when the signal did not get through (logged; the sweep delivers it again). */
  /**
   * Sweep: re-submit an active task (deduped by the engine). An active task whose execution already
   * closed has nobody left to finish it (e.g. a /resume signal raced the end of the resume window): fail it.
   */
  private async submitOrRecover(taskId: string): Promise<void> {
    try {
      const { accepted } = await this.engine!.submit(taskId);
      if (accepted || !(await this.engine!.isClosed(taskId))) return;
      const done = await this.finish(taskId, 'failed', { error: 'Execução durável encerrada sem concluir a tarefa; use /resume' }, 'task.failed', undefined);
      if (done) this.log.warn(`Tarefa ${taskId}: execução durável já encerrada, tarefa marcada como failed`);
    } catch (err) {
      this.log.error(`Tarefa ${taskId}: varredura no runtime durável falhou: ${(err as Error).message}`);
    }
  }

  private async signalApproval(taskId: string): Promise<boolean> {
    try {
      await this.engine!.signalApproval(taskId);
      return true;
    } catch (err) {
      this.log.error(`Tarefa ${taskId}: sinal de aprovação não entregue: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * /resume on an engine: only a failed task whose execution still waits for it. The store
   * transition (fenced by a short lease) decides which concurrent /resume wins; the winner
   * signals the engine once. If the signal does not get through, the task goes back to failed.
   */
  private async resumeOnEngine(taskId: string, engine: DurableEngine): Promise<Task> {
    const before = await this.mustGet(taskId);
    if ([...ACTIVE, 'awaiting_approval'].includes(before.status)) throw new TaskBusyError(taskId);
    if (before.status !== 'failed' || await engine.isClosed(taskId)) throw new TaskNotResumableError(taskId, before.status);
    const lease = await this.store.acquireTaskLease(taskId, this.ownerId, this.leaseMs);
    if (!lease) throw new TaskBusyError(taskId);
    const task = await this.store.reopenTask(taskId, lease).finally(() => this.store.releaseTaskLease(taskId, lease).catch(() => undefined));
    if (!task) throw new TaskNotResumableError(taskId, (await this.mustGet(taskId)).status);
    // Undo the reopen only while nothing ran since (an ambiguous ingress error may still have delivered the signal).
    const rollback = async () => {
      const now = await this.mustGet(taskId);
      if (now.status === 'running' && now.updatedAt === task.updatedAt) await this.store.updateTask(taskId, { status: 'failed', error: before.error });
    };
    try {
      await engine.signalResume(taskId);
    } catch (err) {
      await rollback();
      throw err;
    }
    // The execution may have closed (resume window, cancel) between the check and the signal: nobody consumes it.
    if (await engine.isClosed(taskId)) {
      await rollback();
      throw new TaskNotResumableError(taskId, 'failed');
    }
    this.bus.emit('task.status', taskId, { status: 'running' });
    return task;
  }

  private async waitWhile(taskId: string, cond: (t: Task) => boolean, ms: number): Promise<Task> {
    const end = Date.now() + ms;
    let task = await this.mustGet(taskId);
    while (cond(task) && Date.now() < end) {
      await new Promise((r) => setTimeout(r, 25));
      task = await this.mustGet(taskId);
    }
    return task;
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
  private async fail(taskId: string, err: Error, lease?: TaskLease): Promise<RunOutcome> {
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
  private async finish(taskId: string, status: TaskStatus, patch: Partial<Task>, eventType: string, lease: TaskLease | undefined, extra: Record<string, unknown> = {}) {
    const task = await this.store.finishTask(taskId, { ...patch, status },
      outboxEvent(eventType, { taskId, status, ...patch, ...extra }), lease);
    if (task) this.bus.emit('task.status', taskId, { status, error: task.error, spentUsd: task.spentUsd });
    return task;
  }

  private async setStatus(ctx: DurableContext, task: Task, status: TaskStatus, lease: TaskLease | undefined, signal: AbortSignal): Promise<Task> {
    throwIfAborted(signal);
    if (task.status === status) return task;
    return this.guarded(task.id, await ctx.effect(`status:${status}`, async () => {
      const updated = await this.store.updateActiveTask(task.id, { status }, lease);
      if (updated) this.bus.emit('task.status', task.id, { status });
      return updated;
    }));
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
