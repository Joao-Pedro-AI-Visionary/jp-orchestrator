import { Subtask, Task } from '../common/types';
import { newId, nowIso } from '../common/util';
import { InMemorySharedMemory } from '../memory/shared-memory';
import { gatewayHarness } from '../test-utils/harness';
import { ToolInvoker } from '../tools/tool-invoker.service';
import { AgentContext } from './agent-strategy';
import { ReviewerAgent, TESTS_MARKER } from './agents';

const sub = (agent: Subtask['agent'], position: number, title = `${agent} ${position}`): Subtask => ({
  id: newId(), taskId: 't', agent, title, status: 'pending', model: null, output: null,
  attempt: 1, position, startedAt: null, finishedAt: null,
});

describe('ReviewerAgent evidence (M6)', () => {
  const setup = () => {
    const g = gatewayHarness();
    const memory = new InMemorySharedMemory();
    const task: Task = {
      id: newId(), title: 'x', description: 'd', status: 'running', budgetUsd: 1, spentUsd: 0, requiresApproval: false,
      correctionRounds: 0, result: null, error: null, createdAt: nowIso(), updatedAt: nowIso(),
    };
    const team = [sub('researcher', 0), sub('coder', 1, 'Controller'), sub('coder', 2, 'Repositório'), sub('reviewer', 3)];
    const review = (t?: Subtask[]) => new ReviewerAgent().run({
      task, subtask: team[3], attempt: 1, feedback: null, gateway: g.gateway, tools: undefined as unknown as ToolInvoker, memory, team: t,
    } as AgentContext);
    return { memory, task, team, review };
  };

  it('rejects when shared memory holds no code entry (e.g. lost on a restart)', async () => {
    const { team, review } = setup();
    const { verdict } = await review(team);
    expect(verdict).toMatchObject({ approved: false });
    expect(verdict!.feedback).toMatch(/sem evidência/);
    expect((await review(undefined)).verdict!.approved).toBe(false);
  });

  it('rejects when a coder of the plan left no entry, approves when all are there with tests', async () => {
    const { memory, task, team, review } = setup();
    await memory.write(task.id, 'code:1', `src/a.ts: correção aplicada, ${TESTS_MARKER}`, 'coder');
    const partial = await review(team);
    expect(partial.verdict).toMatchObject({ approved: false });
    expect(partial.verdict!.feedback).toContain('Repositório');
    await memory.write(task.id, 'code:2', `src/b.ts: correção aplicada, ${TESTS_MARKER}`, 'coder');
    expect((await review(team)).verdict).toEqual({ approved: true, feedback: 'Aprovado: mudanças com testes.' });
  });
});
