import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Approval } from '../common/types';
import { STORE } from '../common/tokens';
import { nowIso } from '../common/util';
import { EventBus } from '../events/event-bus';
import { Store } from '../persistence/store.port';

/**
 * Durable human approval. The orchestrator writes a pending approval and
 * stops (state lives in Postgres, not in memory). Resolving it here lets the
 * orchestrator resume from the journal, even after a restart.
 */
@Injectable()
export class ApprovalService {
  constructor(@Inject(STORE) private readonly store: Store, private readonly bus: EventBus) {}

  /** decidedBy: the authenticated principal; persisted with the decision and sent in approval.resolved. */
  async resolve(taskId: string, decision: 'approved' | 'rejected', note: string | null, decidedBy: string | null = null): Promise<Approval> {
    const task = await this.store.getTask(taskId);
    if (!task) throw new NotFoundException(`Tarefa ${taskId} não encontrada`);
    // Atomic pending -> decision (UPDATE ... WHERE status = 'pending'): of two concurrent deciders only one wins.
    const resolved = task.status === 'awaiting_approval' ? await this.store.resolveApproval(taskId, decision, note, nowIso(), decidedBy) : null;
    if (!resolved) throw new ConflictException('Tarefa não está aguardando aprovação');
    this.bus.emit('approval.resolved', taskId, { status: decision, note, decidedBy });
    return resolved;
  }
}
