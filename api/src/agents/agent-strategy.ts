import { AgentKind, Subtask, Task, Tier } from '../common/types';
import { GatewayService } from '../gateway/gateway.service';
import { SharedMemory } from '../memory/shared-memory';
import { KeyedStrategy } from '../strategy/strategy-registry';
import { ToolInvoker } from '../tools/tool-invoker.service';

export interface AgentContext {
  task: Task;
  subtask: Subtask;
  attempt: number;
  feedback: string | null;
  gateway: GatewayService;
  tools: ToolInvoker;
  memory: SharedMemory;
  /** Aborted on task timeout, subagent timeout or lost lease. */
  signal?: AbortSignal;
  /** Every subtask of the plan, so the reviewer knows which code entries to expect. */
  team?: Subtask[];
}

export interface AgentResult {
  output: string;
  model: string;
  artifacts: string[];
  verdict?: { approved: boolean; feedback: string };
}

/** Strategy for the agent axis: one class per subagent kind, resolved by key. */
export interface AgentStrategy extends KeyedStrategy {
  readonly key: AgentKind;
  /** Minimum model tier; the gateway picks the cheapest model at or above it. */
  readonly tier: Tier;
  run(ctx: AgentContext): Promise<AgentResult>;
}

export const promptFor = (ctx: AgentContext, extra: string[] = []): string => [
  `AGENTE: ${ctx.subtask.agent}`,
  `TAREFA: ${ctx.task.title}`,
  `SUBTAREFA: ${ctx.subtask.title}`,
  ...(ctx.feedback ? [`FEEDBACK: ${ctx.feedback}`, `TENTATIVA: ${ctx.attempt}`] : []),
  ...extra,
].join('\n');

export const call = (ctx: AgentContext, agent: AgentStrategy, prompt: string) =>
  ctx.gateway.complete({ taskId: ctx.task.id, subtaskId: ctx.subtask.id, agent: agent.key, prompt, tier: agent.tier, signal: ctx.signal });
