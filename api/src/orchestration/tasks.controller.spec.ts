import { BadRequestException, ConflictException, UnprocessableEntityException } from '@nestjs/common';
import { ApprovalService } from '../approval/approval.service';
import { nowIso } from '../common/util';
import { orchestratorHarness } from '../test-utils/harness';
import { Orchestrator } from './orchestrator.service';
import { parseNote, TasksController } from './tasks.controller';

const body = { title: 'Criar endpoint', description: 'Implementar o handler', budgetUsd: 0.05, requiresApproval: false };

function setup() {
  const h = orchestratorHarness();
  const started: string[] = [];
  // Real resume rules, no background run.
  const orchestrator = {
    start: async (id: string) => { started.push(id); return 'completed'; },
    canResume: (id: string) => h.orchestrator.canResume(id),
    isRunningAnywhere: async () => false,
  } as unknown as Orchestrator;
  const controller = new TasksController(h.store, h.memory, orchestrator, new ApprovalService(h.store, h.bus), h.bus);
  const res = () => {
    const r = { code: 201, headers: {} as Record<string, string> };
    return { r, res: { status: (c: number) => { r.code = c; }, setHeader: (k: string, v: string) => { r.headers[k] = v; } } };
  };
  return { h, controller, res, started };
}

describe('Approval note (L2)', () => {
  it('accepts a missing or blank note and rejects a non-string or too long one with 400', () => {
    expect(parseNote(undefined)).toBeNull();
    expect(parseNote({})).toBeNull();
    expect(parseNote({ note: '   ' })).toBeNull();
    expect(parseNote({ note: ' ok ' })).toBe('ok');
    expect(() => parseNote({ note: 123 })).toThrow(BadRequestException);
    expect(() => parseNote({ note: 'x'.repeat(1001) })).toThrow(BadRequestException);
  });

  it('answers 400, not 500, to {"note": 123} on approve', async () => {
    const { h, controller } = setup();
    const task = await h.createTask({ status: 'awaiting_approval' });
    await h.store.upsertApproval({ taskId: task.id, status: 'pending', note: null, requestedAt: nowIso(), resolvedAt: null });
    await expect(controller.approve(task.id, { note: 123 })).rejects.toBeInstanceOf(BadRequestException);
    expect((await h.store.getApproval(task.id))!.status).toBe('pending');
  });
});

describe('Idempotency-Key on POST /tasks (L3)', () => {
  it('replays the same body, refuses another body with 422 and a key over 255 chars with 400', async () => {
    const { controller, res, started } = setup();
    const a = res();
    const first = await controller.create(body, 'key-1', a.res);
    const b = res();
    expect(await controller.create(body, ' key-1 ', b.res)).toMatchObject({ id: first.id });
    expect(b.r).toMatchObject({ code: 200, headers: { 'Idempotent-Replay': 'true' } });
    await expect(controller.create({ ...body, title: 'Outro título' }, 'key-1', res().res)).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(controller.create(body, 'k'.repeat(256), res().res)).rejects.toBeInstanceOf(BadRequestException);
    expect(started).toEqual([first.id]);
  });
});

describe('Resume and detail (L5, L13)', () => {
  it('refuses to resume a task whose last review was rejected and says so in the detail', async () => {
    const { h, controller } = setup();
    const task = await h.createTask({ status: 'failed', error: 'Revisão reprovada' });
    await h.store.putStep(task.id, 'review:2', { output: '', model: 'm', artifacts: [], verdict: { approved: false, feedback: 'x' } });
    await expect(controller.resume(task.id)).rejects.toBeInstanceOf(ConflictException);
    expect(await controller.detail(task.id)).toMatchObject({ resumable: false, maxCorrectionRounds: 2 });

    const other = await h.createTask({ status: 'failed', error: 'timeout' });
    expect(await controller.detail(other.id)).toMatchObject({ resumable: true });
    expect(await controller.resume(other.id)).toMatchObject({ status: 'running' });
  });
});
