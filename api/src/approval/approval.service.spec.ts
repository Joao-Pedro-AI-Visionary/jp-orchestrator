import { ConflictException } from '@nestjs/common';
import { orchestratorHarness } from '../test-utils/harness';
import { nowIso } from '../common/util';
import { ApprovalService } from './approval.service';

describe('ApprovalService (M7)', () => {
  it('of an approve and a reject sent at the same time, one wins and the other gets 409', async () => {
    const h = orchestratorHarness();
    const task = await h.createTask({ status: 'awaiting_approval', requiresApproval: true });
    await h.store.upsertApproval({ taskId: task.id, status: 'pending', note: null, requestedAt: nowIso(), resolvedAt: null });
    const svc = new ApprovalService(h.store, h.bus);

    const results = await Promise.allSettled([svc.resolve(task.id, 'approved', null), svc.resolve(task.id, 'rejected', 'não')]);
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0].reason).toBeInstanceOf(ConflictException);
    const decided = (won[0] as PromiseFulfilledResult<{ status: string }>).value.status;
    expect((await h.store.getApproval(task.id))!.status).toBe(decided);
    expect(h.bus.history.filter((e) => e.type === 'approval.resolved')).toHaveLength(1);
  });
});
