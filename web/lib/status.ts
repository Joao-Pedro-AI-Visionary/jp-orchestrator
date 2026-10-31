import type { SubtaskStatus, TaskStatus } from "./types";

interface Tone {
  label: string;
  text: string;
  bg: string;
  glow: string;
}

export const TASK_STATUS: Record<TaskStatus, Tone> = {
  queued: { label: "Na fila", text: "text-slate-300", bg: "bg-slate-400/10", glow: "rgba(148,163,184,0.25)" },
  planning: { label: "Planejando", text: "text-sky-300", bg: "bg-sky-400/10", glow: "rgba(56,189,248,0.35)" },
  running: { label: "Em execução", text: "text-cyan-300", bg: "bg-cyan-400/10", glow: "rgba(34,211,238,0.4)" },
  awaiting_approval: { label: "Aguardando aprovação", text: "text-amber-300", bg: "bg-amber-400/10", glow: "rgba(251,191,36,0.4)" },
  merging: { label: "Integrando", text: "text-indigo-300", bg: "bg-indigo-400/10", glow: "rgba(129,140,248,0.4)" },
  completed: { label: "Concluída", text: "text-emerald-300", bg: "bg-emerald-400/10", glow: "rgba(52,211,153,0.4)" },
  failed: { label: "Falhou", text: "text-rose-300", bg: "bg-rose-400/10", glow: "rgba(251,113,133,0.4)" },
  rejected: { label: "Rejeitada", text: "text-orange-300", bg: "bg-orange-400/10", glow: "rgba(251,146,60,0.35)" },
  budget_exceeded: { label: "Orçamento excedido", text: "text-rose-300", bg: "bg-rose-400/10", glow: "rgba(251,113,133,0.4)" },
};

export const SUBTASK_STATUS: Record<SubtaskStatus, Tone> = {
  pending: { label: "Pendente", text: "text-slate-300", bg: "bg-slate-400/10", glow: "rgba(148,163,184,0.2)" },
  running: { label: "Executando", text: "text-cyan-300", bg: "bg-cyan-400/10", glow: "rgba(34,211,238,0.5)" },
  done: { label: "Concluído", text: "text-emerald-300", bg: "bg-emerald-400/10", glow: "rgba(52,211,153,0.35)" },
  failed: { label: "Falhou", text: "text-rose-300", bg: "bg-rose-400/10", glow: "rgba(251,113,133,0.4)" },
  cancelled: { label: "Cancelado", text: "text-slate-400", bg: "bg-slate-400/10", glow: "rgba(148,163,184,0.15)" },
};

export const RUNNING_STATUSES: TaskStatus[] = ["queued", "planning", "running", "merging"];

export const AGENT_LABEL: Record<string, string> = {
  researcher: "Pesquisador",
  coder: "Codificador",
  tester: "Testador",
  reviewer: "Revisor",
};
