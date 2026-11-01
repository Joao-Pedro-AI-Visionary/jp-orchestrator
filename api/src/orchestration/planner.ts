import { AgentKind, Task } from '../common/types';

export interface PlannedSubtask { agent: AgentKind; title: string; wave: number }

const MAX_WORK_SUBTASKS = 6;
export const WAVE: Record<AgentKind, number> = { researcher: 0, coder: 1, tester: 1, reviewer: 2 };

const classify = (clause: string): AgentKind => {
  if (/\btest|teste|cobertura|e2e/i.test(clause)) return 'tester';
  if (/pesquis|investig|analis|levant|research|entend/i.test(clause)) return 'researcher';
  return 'coder';
};

/**
 * Planner loop. Splits the description into clauses, classifies each one by
 * agent kind and guarantees the minimal team: a researcher (wave 0), at least
 * one coder and one tester (wave 1, parallel) and a reviewer (wave 2).
 * Deterministic and free: no model call. A model-backed planner can replace plan()
 * as long as it validates the answer and falls back to decompose().
 */
export class Planner {
  static decompose(task: Pick<Task, 'title' | 'description'>): PlannedSubtask[] {
    const clauses = task.description
      .split(/[\n.;]+|\s+e\s+(?=[a-záéíóú]+r\b)/i)
      .map((c) => c.trim().replace(/^[-*\d.)\s]+/, ''))
      .filter((c) => c.length > 3)
      .slice(0, MAX_WORK_SUBTASKS);

    const work: PlannedSubtask[] = clauses.map((title) => {
      const agent = classify(title);
      return { agent, title: title[0].toUpperCase() + title.slice(1), wave: WAVE[agent] };
    });
    if (!work.some((w) => w.agent === 'researcher')) work.unshift({ agent: 'researcher', title: `Levantar contexto de ${task.title}`, wave: 0 });
    if (!work.some((w) => w.agent === 'coder')) work.push({ agent: 'coder', title: `Implementar ${task.title}`, wave: 1 });
    if (!work.some((w) => w.agent === 'tester')) work.push({ agent: 'tester', title: `Testar ${task.title}`, wave: 1 });
    work.push({ agent: 'reviewer', title: 'Revisar mudanças', wave: 2 });
    return work.sort((a, b) => a.wave - b.wave);
  }

  async plan(task: Task, signal?: AbortSignal): Promise<PlannedSubtask[]> {
    signal?.throwIfAborted();
    return Planner.decompose(task);
  }
}
