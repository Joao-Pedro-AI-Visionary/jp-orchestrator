import { envNumber } from '../common/util';

/**
 * Every orchestration loop is bounded: objective, exit criterion, timeout and
 * call limit. Nothing here retries "until it passes". Documented in README.
 */
export interface LoopSpec {
  name: string;
  objective: string;
  exitCriteria: string;
  timeoutMs: number;
  maxCalls: number;
  maxCorrectionRounds: number;
}

export const MAX_CORRECTION_ROUNDS = 2;

export const loops = () => ({
  task: {
    name: 'task', objective: 'Levar a tarefa de queued a um estado final',
    exitCriteria: 'completed, failed, rejected ou budget_exceeded',
    timeoutMs: envNumber('TASK_TIMEOUT_MS', 180_000), maxCalls: 1, maxCorrectionRounds: MAX_CORRECTION_ROUNDS,
  },
  plan: {
    name: 'plan', objective: 'Quebrar a tarefa em subtarefas com agente definido',
    exitCriteria: 'plano com pelo menos 1 subtarefa de trabalho e 1 revisor',
    timeoutMs: envNumber('PLAN_TIMEOUT_MS', 15_000), maxCalls: 1, maxCorrectionRounds: 0,
  },
  dispatch: {
    name: 'dispatch', objective: 'Rodar os subagentes de cada onda em paralelo (até MAX_PARALLEL)',
    exitCriteria: 'todas as subtarefas da onda em done; falha após 1 retry por subtarefa',
    timeoutMs: envNumber('SUBAGENT_TIMEOUT_MS', 30_000), maxCalls: 2, maxCorrectionRounds: 0,
  },
  correction: {
    name: 'correction', objective: 'Revisor aprova ou devolve feedback; coders corrigem',
    exitCriteria: 'revisão aprovada; falha se reprovar após 2 rodadas de correção',
    timeoutMs: envNumber('REVIEW_TIMEOUT_MS', 30_000), maxCalls: MAX_CORRECTION_ROUNDS + 1, maxCorrectionRounds: MAX_CORRECTION_ROUNDS,
  },
  approval: {
    name: 'approval', objective: 'Pausar de forma durável até a decisão humana',
    exitCriteria: 'approved (segue para merge) ou rejected (encerra)',
    timeoutMs: 0, maxCalls: 0, maxCorrectionRounds: 0,
  },
  merge: {
    name: 'merge', objective: 'Consolidar saídas e artefatos dos subagentes',
    exitCriteria: 'resultado único com resumo e artefatos sem duplicatas',
    timeoutMs: envNumber('MERGE_TIMEOUT_MS', 10_000), maxCalls: 1, maxCorrectionRounds: 0,
  },
} satisfies Record<string, LoopSpec>);
