"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { Dashboard } from "@/lib/use-dashboard";
import { RUNNING_STATUSES, TASK_STATUS } from "@/lib/status";
import { usd } from "@/lib/format";
import { EmptyState, ErrorNote, Pill, ProgressBar, Skeleton } from "./ui";

type Filter = "all" | "running" | "approval" | "done";
const FILTERS: { id: Filter; label: string; testId: string }[] = [
  { id: "all", label: "Todas", testId: "filter-all" },
  { id: "running", label: "Em execução", testId: "filter-running" },
  { id: "approval", label: "Aguardando aprovação", testId: "filter-approval" },
  { id: "done", label: "Concluídas", testId: "filter-done" },
];

export function TaskList({ d }: { d: Dashboard }) {
  const [filter, setFilter] = useState<Filter>("all");
  const visible = d.tasks.filter((t) => {
    if (filter === "running") return RUNNING_STATUSES.includes(t.status);
    if (filter === "approval") return t.status === "awaiting_approval";
    if (filter === "done") return t.status === "completed";
    return true;
  });

  return (
    <section aria-labelledby="tasks-title" className="card p-5" data-testid="task-list">
      <h2 id="tasks-title" className="font-heading text-xl font-bold text-white">
        Tarefas
      </h2>
      <div role="group" aria-label="Filtrar tarefas" className="mt-3 flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            data-testid={f.testId}
            aria-pressed={filter === f.id}
            onClick={() => setFilter(f.id)}
            className={`btn !min-h-12 ${filter === f.id ? "!border-white/40 !bg-white/15 text-white" : "text-slate-300"}`}
          >
            {f.label}
          </button>
        ))}
      </div>
      <div className="mt-4">
        {d.errors.tasks && <ErrorNote text={d.errors.tasks} onRetry={d.reloadAll} testId="tasks-error" />}
        {d.loading.tasks ? (
          <div className="space-y-3" data-testid="tasks-loading">
            <Skeleton className="h-24" />
            <Skeleton className="h-24" />
          </div>
        ) : visible.length === 0 && !d.errors.tasks ? (
          <EmptyState testId="tasks-empty" text={d.tasks.length === 0 ? "Nenhuma tarefa ainda. Crie a primeira acima." : "Nenhuma tarefa neste filtro."} />
        ) : (
          <ul className="space-y-3">
            <AnimatePresence initial={false}>
              {visible.map((t) => {
                const tone = TASK_STATUS[t.status];
                const selected = d.selectedId === t.id;
                const over = t.budgetUsd > 0 && t.spentUsd / t.budgetUsd > 0.9;
                return (
                  <motion.li key={t.id} layout initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                    <button
                      type="button"
                      data-testid="task-card"
                      data-task-id={t.id}
                      data-status={t.status}
                      aria-pressed={selected}
                      onClick={() => d.select(t.id)}
                      className={`card block min-h-12 w-full p-4 text-left ${selected ? "!border-indigo-300/70" : ""}`}
                      style={{ ["--glow" as string]: tone.glow }}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <span className="font-semibold text-white">{t.title}</span>
                        <Pill label={tone.label} text={tone.text} bg={tone.bg} testId="task-status" />
                      </div>
                      <div className="mt-3 flex items-center gap-3 text-xs text-slate-300">
                        <div className="flex-1">
                          <ProgressBar ratio={t.budgetUsd ? t.spentUsd / t.budgetUsd : 0} tone={over ? "bg-rose-400" : "bg-indigo-400"} label={`Custo de ${t.title} em relação ao orçamento`} />
                        </div>
                        <span className="tabular-nums">
                          {usd(t.spentUsd)} / {usd(t.budgetUsd)}
                        </span>
                      </div>
                    </button>
                  </motion.li>
                );
              })}
            </AnimatePresence>
          </ul>
        )}
      </div>
    </section>
  );
}
