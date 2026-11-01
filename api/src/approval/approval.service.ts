import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Approval } from '../common/types';
import { STORE } from '../common/tokens';
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

  async resolve(taskId: string, decision: 'approved' | 'rejected', note: string | null): Promise<Approval> {
    const task = await this.store.getTask(taskId);
    if (!task) throw new NotFoundException(`Tarefa ${taskId} não encontrada`);
    const approval = await this.store.getApproval(taskId);
    if (!approval || approval.status !== 'pending' || task.status !== 'awaiting_approval') {
      throw new ConflictException('Tarefa não está aguardando aprovação');
    }
    // Conditional write (status still pending): of two concurrent decisions only one wins.
    const resolved = await this.store.resolveApproval(taskId, decision, note);
    if (!resolved) throw new ConflictException('A aprovação já foi resolvida por outra requisição');
    this.bus.emit('approval.resolved', taskId, { status: decision, note });
    return resolved;
  }
}
