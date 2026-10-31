import type { SubtaskStatus, TaskStatus } from "./types";

interface Tone {
  label: string;
  text: string;
  bg: string;
  glow: string;
}

export const TASK_STATUS: Record<TaskStatus, Tone> = {
  queued: { label: "Na fila", text: "text-neutral-300", bg: "bg-neutral-400/10", glow: "rgba(163,163,163,0.25)" },
  planning: { label: "Planejando", text: "text-brand-soft", bg: "bg-brand-soft/10", glow: "rgba(250,204,21,0.25)" },
  running: { label: "Em execução", text: "text-brand", bg: "bg-brand/10", glow: "rgba(255,200,0,0.35)" },
  awaiting_approval: { label: "Aguardando aprovação", text: "text-accent", bg: "bg-accent/10", glow: "rgba(255,122,0,0.4)" },
  merging: { label: "Integrando", text: "text-accent", bg: "bg-accent/10", glow: "rgba(255,200,0,0.3)" },
  completed: { label: "Concluída", text: "text-ok", bg: "bg-ok/10", glow: "rgba(95,191,133,0.4)" },
  failed: { label: "Falhou", text: "text-bad", bg: "bg-bad/10", glow: "rgba(240,113,113,0.4)" },
  rejected: { label: "Rejeitada", text: "text-accent", bg: "bg-accent/10", glow: "rgba(255,122,0,0.35)" },
  budget_exceeded: { label: "Orçamento excedido", text: "text-bad", bg: "bg-bad/10", glow: "rgba(240,113,113,0.4)" },
};

export const SUBTASK_STATUS: Record<SubtaskStatus, Tone> = {
  pending: { label: "Pendente", text: "text-neutral-300", bg: "bg-neutral-400/10", glow: "rgba(163,163,163,0.2)" },
  running: { label: "Executando", text: "text-brand", bg: "bg-brand/10", glow: "rgba(255,200,0,0.35)" },
  done: { label: "Concluído", text: "text-ok", bg: "bg-ok/10", glow: "rgba(95,191,133,0.35)" },
  failed: { label: "Falhou", text: "text-bad", bg: "bg-bad/10", glow: "rgba(240,113,113,0.4)" },
  cancelled: { label: "Cancelado", text: "text-neutral-400", bg: "bg-neutral-400/10", glow: "rgba(163,163,163,0.15)" },
};

export const RUNNING_STATUSES: TaskStatus[] = ["queued", "planning", "running", "merging"];

export const AGENT_LABEL: Record<string, string> = {
  researcher: "Pesquisador",
  coder: "Codificador",
  tester: "Testador",
  reviewer: "Revisor",
};
