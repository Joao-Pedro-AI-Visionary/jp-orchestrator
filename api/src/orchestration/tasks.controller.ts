import {
  BadRequestException, Body, ConflictException, Controller, Get, Headers, HttpCode, Inject, NotFoundException,
  Param, Post, Res,
} from '@nestjs/common';
import { Task } from '../common/types';
import { SHARED_MEMORY, STORE } from '../common/tokens';
import { newId, nowIso } from '../common/util';
import { ApprovalService } from '../approval/approval.service';
import { EventBus } from '../events/event-bus';
import { SharedMemory } from '../memory/shared-memory';
import { Store } from '../persistence/store.port';
import { Orchestrator, TaskBusyError, TaskNotResumableError } from './orchestrator.service';

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

@Controller('tasks')
export class TasksController {
  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(SHARED_MEMORY) private readonly memory: SharedMemory,
    private readonly orchestrator: Orchestrator,
    private readonly approvals: ApprovalService,
    private readonly bus: EventBus,
  ) {}

  /** Idempotency-Key header: a retried POST returns the same task and never starts a second run. */
  @Post()
  async create(@Body() body: CreateTaskBody, @Headers('idempotency-key') key: string | undefined, @Res({ passthrough: true }) res: ResLike) {
    const input = parseCreateTask(body ?? {});
    const now = nowIso();
    const draft: Task = {
      id: newId(), ...input, status: 'queued', spentUsd: 0, correctionRounds: 0,
      result: null, error: null, createdAt: now, updatedAt: now,
    };
    const { task, replay } = await this.store.createTask(draft, key?.trim() || null);
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

  @Post(':id/approve')
  @HttpCode(200)
  async approve(@Param('id') id: string, @Body() body: { note?: string }) {
    await this.approvals.resolve(id, 'approved', body?.note?.trim() || null);
    void this.orchestrator.continueAfterApproval(id);
    return this.mustGet(id);
  }

  @Post(':id/reject')
  @HttpCode(200)
  async reject(@Param('id') id: string, @Body() body: { note?: string }) {
    await this.approvals.resolve(id, 'rejected', body?.note?.trim() || 'Rejeitada na aprovação humana');
    await this.orchestrator.continueAfterApproval(id);
    return this.mustGet(id);
  }

  /**
   * Resumes a failed (or stuck) task from the step journal. 409 while any run owns the
   * task lease, including a timed out run that is still stopping, here or on another replica.
   */
  @Post(':id/resume')
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
