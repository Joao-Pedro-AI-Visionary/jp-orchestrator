import {
  BadRequestException, Body, ConflictException, Controller, Get, Headers, HttpCode, Inject, NotFoundException,
  Param, Post, Res, UnprocessableEntityException,
} from '@nestjs/common';
import { Principal } from '../auth/auth.config';
import { CurrentPrincipal, RateLimited, RequireRole } from '../auth/auth.decorators';
import { Task } from '../common/types';
import { SHARED_MEMORY, STORE } from '../common/tokens';
import { canonicalJson, newId, nowIso, sha256 } from '../common/util';
import { ApprovalService } from '../approval/approval.service';
import { EventBus } from '../events/event-bus';
import { SharedMemory } from '../memory/shared-memory';
import { Store } from '../persistence/store.port';
import { Orchestrator, TaskBusyError, TaskNotResumableError } from './orchestrator.service';

interface CreateTaskBody { title?: unknown; description?: unknown; budgetUsd?: unknown; requiresApproval?: unknown }
interface ResLike { status(code: number): void; setHeader(name: string, value: string): void }

export const NOTE_MAX = 2000;
export const IDEMPOTENCY_KEY_MAX = 200;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Liberal on format (Postel: trims text, accepts "0,05" or 0.05 for budget, "true" for a
 * boolean), strict on type: a field of the wrong type is a 400, never coerced to a default.
 */
export function parseCreateTask(body: unknown) {
  if (!isObject(body)) throw new BadRequestException(['o corpo deve ser um objeto JSON']);
  const b = body as CreateTaskBody;
  const errors: string[] = [];
  if (typeof b.title !== 'string') errors.push('title deve ser texto');
  if (typeof b.description !== 'string') errors.push('description deve ser texto');
  const title = typeof b.title === 'string' ? b.title.trim() : '';
  const description = typeof b.description === 'string' ? b.description.trim() : '';
  if (typeof b.title === 'string' && (title.length < 3 || title.length > 200)) errors.push('title deve ter entre 3 e 200 caracteres');
  if (typeof b.description === 'string' && (description.length < 1 || description.length > 4000)) errors.push('description deve ter entre 1 e 4000 caracteres');
  let budgetUsd = 0.05;
  if (b.budgetUsd !== undefined && b.budgetUsd !== '') {
    budgetUsd = typeof b.budgetUsd === 'number' ? b.budgetUsd
      : typeof b.budgetUsd === 'string' && /^\s*\d+([.,]\d+)?\s*$/.test(b.budgetUsd) ? Number(b.budgetUsd.trim().replace(',', '.')) : NaN;
    if (!Number.isFinite(budgetUsd) || budgetUsd <= 0 || budgetUsd > 100) errors.push('budgetUsd deve ser um número entre 0 e 100');
  }
  const ra = b.requiresApproval;
  if (ra !== undefined && typeof ra !== 'boolean' && ra !== 'true' && ra !== 'false') errors.push('requiresApproval deve ser booleano');
  if (errors.length) throw new BadRequestException(errors);
  return { title, description, budgetUsd, requiresApproval: ra === true || ra === 'true' };
}

/** Optional decision note: text up to NOTE_MAX characters; blank means none. */
export function parseNote(body: unknown): string | null {
  if (body === undefined || body === null) return null;
  if (!isObject(body)) throw new BadRequestException(['o corpo deve ser um objeto JSON']);
  if (body.note === undefined || body.note === null) return null;
  if (typeof body.note !== 'string') throw new BadRequestException(['note deve ser texto']);
  const note = body.note.trim();
  if (note.length > NOTE_MAX) throw new BadRequestException([`note deve ter no máximo ${NOTE_MAX} caracteres`]);
  return note || null;
}

export function parseIdempotencyKey(raw: string | undefined): string | null {
  const key = raw?.trim();
  if (!key) return null;
  if (key.length > IDEMPOTENCY_KEY_MAX || !/^[\x21-\x7e]+$/.test(key)) {
    throw new BadRequestException([`Idempotency-Key deve ter até ${IDEMPOTENCY_KEY_MAX} caracteres ASCII visíveis`]);
  }
  return key;
}

/** Fingerprint of the normalized body: "0,05" and 0.05 are the same request. */
export const requestFingerprint = (input: ReturnType<typeof parseCreateTask>): string => sha256(canonicalJson(input));

@Controller('tasks')
export class TasksController {
  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(SHARED_MEMORY) private readonly memory: SharedMemory,
    private readonly orchestrator: Orchestrator,
    private readonly approvals: ApprovalService,
    private readonly bus: EventBus,
  ) {}

  /**
   * Idempotency-Key header: a retried POST returns the same task and never starts a second run.
   * The same key with a different body is a client bug (or a key collision): 422, nothing created.
   */
  @Post()
  @RequireRole('operator')
  @RateLimited()
  async create(@Body() body: unknown, @Headers('idempotency-key') rawKey: string | undefined, @Res({ passthrough: true }) res: ResLike) {
    const input = parseCreateTask(body);
    const key = parseIdempotencyKey(rawKey);
    const fingerprint = requestFingerprint(input);
    const now = nowIso();
    const draft: Task = {
      id: newId(), ...input, status: 'queued', spentUsd: 0, correctionRounds: 0,
      result: null, error: null, createdAt: now, updatedAt: now,
    };
    const { task, replay, fingerprint: stored } = await this.store.createTask(draft, key, fingerprint);
    if (replay && stored !== null && stored !== fingerprint) {
      throw new UnprocessableEntityException('Idempotency-Key já usada com outro corpo de requisição');
    }
    if (replay) {
      res.status(200);
      res.setHeader('Idempotent-Replay', 'true');
      return task;
    }
    this.bus.emit('task.created', task.id, { title: task.title });
    void this.orchestrator.start(task.id);
    return task;
  }

  @Get()
  list() {
    return this.store.listTasks(50);
  }

  @Get(':id')
  async detail(@Param('id') id: string) {
    const task = await this.mustGet(id);
    const [subtasks, snapshots, usage, approval, memory] = await Promise.all([
      this.store.listSubtasks(id), this.store.listSnapshots(id), this.store.listUsage(id),
      this.store.getApproval(id), this.memory.list(id),
    ]);
    return { task, subtasks, snapshots, usage, approval, memory };
  }

  /** Approver (or admin) only; the principal is recorded as decidedBy. */
  @Post(':id/approve')
  @RequireRole('approver')
  @RateLimited()
  @HttpCode(200)
  async approve(@Param('id') id: string, @Body() body: unknown, @CurrentPrincipal() who: Principal) {
    const note = parseNote(body);
    await this.mustGet(id);
    await this.approvals.resolve(id, 'approved', note, who.id);
    void this.orchestrator.continueAfterApproval(id);
    return this.mustGet(id);
  }

  @Post(':id/reject')
  @RequireRole('approver')
  @RateLimited()
  @HttpCode(200)
  async reject(@Param('id') id: string, @Body() body: unknown, @CurrentPrincipal() who: Principal) {
    const note = parseNote(body) ?? 'Rejeitada na aprovação humana';
    await this.mustGet(id);
    await this.approvals.resolve(id, 'rejected', note, who.id);
    await this.orchestrator.continueAfterApproval(id);
    return this.mustGet(id);
  }

  /**
   * Resumes a failed (or stuck) task from the step journal. 409 while any run owns the
   * task lease, including a timed out run that is still stopping, here or on another replica.
   */
  @Post(':id/resume')
  @RequireRole('operator')
  @RateLimited()
  @HttpCode(200)
  async resume(@Param('id') id: string) {
    await this.mustGet(id);
    try {
      return await this.orchestrator.resume(id);
    } catch (err) {
      if (err instanceof TaskBusyError || err instanceof TaskNotResumableError) throw new ConflictException(err.message);
      throw err;
    }
  }

  private async mustGet(id: string) {
    const task = /^[0-9a-f-]{36}$/i.test(id) ? await this.store.getTask(id) : null;
    if (!task) throw new NotFoundException(`Tarefa ${id} não encontrada`);
    return task;
  }
}
