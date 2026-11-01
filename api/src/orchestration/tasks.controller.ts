import {
  BadRequestException, Body, ConflictException, Controller, Get, Headers, HttpCode, Inject, NotFoundException,
  Param, Post, Res, UnprocessableEntityException,
} from '@nestjs/common';
import { retryConfig } from '../common/retry-horizon';
import { Task } from '../common/types';
import { SHARED_MEMORY, STORE } from '../common/tokens';
import { canonicalJson, newId, nowIso, sha256 } from '../common/util';
import { ApprovalService } from '../approval/approval.service';
import { EventBus } from '../events/event-bus';
import { SharedMemory } from '../memory/shared-memory';
import { Store } from '../persistence/store.port';
import { MAX_CORRECTION_ROUNDS } from './loops';
import { Orchestrator } from './orchestrator.service';

interface CreateTaskBody { title?: unknown; description?: unknown; budgetUsd?: unknown; requiresApproval?: unknown }
interface ResLike { status(code: number): void; setHeader(name: string, value: string): void }

/** Liberal input (Postel): trims text, accepts "0,05" or 0.05 for budget. */
export function parseCreateTask(body: CreateTaskBody) {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  const budgetRaw = body.budgetUsd === undefined || body.budgetUsd === '' ? 0.05 : Number(String(body.budgetUsd).replace(',', '.'));
  const errors: string[] = [];
  if (title.length < 3 || title.length > 200) errors.push('title deve ter entre 3 e 200 caracteres');
  if (description.length < 1 || description.length > 4000) errors.push('description deve ter entre 1 e 4000 caracteres');
  if (!Number.isFinite(budgetRaw) || budgetRaw <= 0 || budgetRaw > 100) errors.push('budgetUsd deve estar entre 0 e 100');
  if (errors.length) throw new BadRequestException(errors);
  return { title, description, budgetUsd: budgetRaw, requiresApproval: body.requiresApproval === true || body.requiresApproval === 'true' };
}

export const MAX_NOTE_LENGTH = 1000;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

/** Optional approval note: a string up to MAX_NOTE_LENGTH chars, anything else is a 400. */
export function parseNote(body: unknown): string | null {
  const note = (body as { note?: unknown } | null | undefined)?.note;
  if (note === undefined || note === null) return null;
  if (typeof note !== 'string') throw new BadRequestException(['note deve ser texto']);
  const trimmed = note.trim();
  if (trimmed.length > MAX_NOTE_LENGTH) throw new BadRequestException([`note deve ter até ${MAX_NOTE_LENGTH} caracteres`]);
  return trimmed || null;
}

/** Idempotency-Key header: optional, at most MAX_IDEMPOTENCY_KEY_LENGTH chars. */
export function parseIdempotencyKey(raw: string | undefined): string | null {
  const key = raw?.trim();
  if (!key) return null;
  if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new BadRequestException([`Idempotency-Key deve ter até ${MAX_IDEMPOTENCY_KEY_LENGTH} caracteres`]);
  }
  return key;
}

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
   * Idempotency-Key header: a retried POST returns the same task and never starts a
   * second run. The key is bound to the body (another body with the same key is a 422)
   * and honored for IDEMPOTENCY_KEY_TTL_MS.
   */
  @Post()
  async create(@Body() body: CreateTaskBody, @Headers('idempotency-key') rawKey: string | undefined, @Res({ passthrough: true }) res: ResLike) {
    const input = parseCreateTask(body ?? {});
    const key = parseIdempotencyKey(rawKey);
    const now = nowIso();
    const draft: Task = {
      id: newId(), ...input, status: 'queued', spentUsd: 0, correctionRounds: 0,
      result: null, error: null, createdAt: now, updatedAt: now,
    };
    const idem = key ? { key, bodyHash: sha256(canonicalJson(input)), ttlMs: retryConfig().idempotencyKeyTtlMs } : null;
    const { task, replay, mismatch } = await this.store.createTask(draft, idem);
    if (mismatch) throw new UnprocessableEntityException('Idempotency-Key já usada com outro corpo: gere uma nova chave');
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
    const resumable = task.status === 'failed' && (await this.orchestrator.canResume(id));
    return { task, subtasks, snapshots, usage, approval, memory, maxCorrectionRounds: MAX_CORRECTION_ROUNDS, resumable };
  }

  @Post(':id/approve')
  @HttpCode(200)
  async approve(@Param('id') id: string, @Body() body: unknown) {
    await this.approvals.resolve(id, 'approved', parseNote(body));
    void this.orchestrator.start(id);
    return this.mustGet(id);
  }

  @Post(':id/reject')
  @HttpCode(200)
  async reject(@Param('id') id: string, @Body() body: unknown) {
    await this.approvals.resolve(id, 'rejected', parseNote(body) ?? 'Rejeitada na aprovação humana');
    await this.orchestrator.start(id);
    return this.mustGet(id);
  }

  /** Resumes a failed (or stuck) task from the step journal. */
  @Post(':id/resume')
  @HttpCode(200)
  async resume(@Param('id') id: string) {
    const task = await this.mustGet(id);
    const stuck = ['planning', 'running', 'merging', 'queued'].includes(task.status) && !(await this.orchestrator.isRunningAnywhere(id));
    if (task.status !== 'failed' && !stuck) throw new ConflictException(`Tarefa em ${task.status} não pode ser retomada`);
    if (task.status === 'failed' && !(await this.orchestrator.canResume(id))) {
      throw new ConflictException('A revisão reprovou após a última rodada de correção: retomar repetiria o mesmo veredito. Crie uma nova tarefa com o ajuste.');
    }
    const updated = await this.store.updateTask(id, { status: 'running', error: null });
    this.bus.emit('task.status', id, { status: 'running' });
    void this.orchestrator.start(id);
    return updated;
  }

  private async mustGet(id: string) {
    const task = /^[0-9a-f-]{36}$/i.test(id) ? await this.store.getTask(id) : null;
    if (!task) throw new NotFoundException(`Tarefa ${id} não encontrada`);
    return task;
  }
}
