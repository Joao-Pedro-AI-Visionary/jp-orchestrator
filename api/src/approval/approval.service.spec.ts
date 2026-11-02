import { ConflictException } from '@nestjs/common';
import { nowIso } from '../common/util';
import { EventBus } from '../events/event-bus';
import { MemoryStore } from '../persistence/memory.store';
import { ApprovalService } from './approval.service';

describe('ApprovalService', () => {
  const setup = async () => {
    const store = new MemoryStore();
    const now = nowIso();
    await store.createTask({ id: 't1', title: 't', description: 'd', status: 'awaiting_approval', budgetUsd: 1, spentUsd: 0,
      requiresApproval: true, correctionRounds: 0, result: null, error: null, createdAt: now, updatedAt: now }, null);
    await store.upsertApproval({ taskId: 't1', status: 'pending', note: null, requestedAt: now, resolvedAt: null });
    const bus = new EventBus();
    const resolved: unknown[] = [];
    bus.stream().subscribe((e) => { if (e.type === 'approval.resolved') resolved.push(e.payload); });
    return { store, service: new ApprovalService(store, bus), resolved };
  };

  it('two concurrent decisions: exactly one wins, the other gets 409 and emits nothing', async () => {
    const { store, service, resolved } = await setup();
    const results = await Promise.allSettled([
      service.resolve('t1', 'approved', 'ok'),
      service.resolve('t1', 'rejected', 'não'),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);
    expect(await store.getApproval('t1')).toMatchObject({ status: 'approved', note: 'ok' });
    expect(resolved).toEqual([{ status: 'approved', note: 'ok' }]);
  });

  it('refuses a decision when the task is not awaiting approval', async () => {
    const { store, service } = await setup();
    await store.updateTask('t1', { status: 'running' });
    await expect(service.resolve('t1', 'approved', null)).rejects.toBeInstanceOf(ConflictException);
    expect((await store.getApproval('t1'))!.status).toBe('pending');
  });
});
