import { Subtask, TaskResult } from '../common/types';
import { AgentResult } from '../agents/agent-strategy';

/** Merge loop: one result per task, artifacts deduplicated, summary ordered by plan position. */
export function mergeResults(subtasks: Subtask[], results: Record<string, AgentResult>): TaskResult {
  const ordered = [...subtasks].sort((a, b) => a.position - b.position).filter((s) => results[s.id]);
  const artifacts = [...new Set(ordered.flatMap((s) => results[s.id].artifacts))].sort();
  const lines = ordered.map((s) => `${s.agent}: ${s.title}`);
  return {
    summary: `${ordered.length} subagentes concluíram. ${lines.join(' | ')}`,
    artifacts,
  };
}
