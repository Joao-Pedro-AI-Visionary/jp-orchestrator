"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Bot, CheckCircle2, CircleDot, FlaskConical, GitCommitVertical, Loader2, Play, RotateCcw, Search, ShieldCheck, ThumbsDown, ThumbsUp } from "lucide-react";
import { useState } from "react";
import type { Dashboard } from "@/lib/use-dashboard";
import type { Subtask, TaskDetail } from "@/lib/types";
import { AGENT_LABEL, SUBTASK_STATUS, TASK_STATUS } from "@/lib/status";
import { int, shortHash, time, usd } from "@/lib/format";
import { EmptyState, ErrorNote, Pill, ProgressBar, Skeleton } from "./ui";

const AGENT_ICON = { researcher: Search, coder: Bot, tester: FlaskConical, reviewer: ShieldCheck } as const;

function Lane({ s, reduce }: { s: Subtask; reduce: boolean }) {
  const tone = SUBTASK_STATUS[s.status];
  const Icon = AGENT_ICON[s.agent] ?? Bot;
  const running = s.status === "running";
  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reduce ? 0 : 0.25 }}
      data-testid="subagent-lane"
      data-status={s.status}
      data-agent={s.agent}
      className={`rounded-2xl border border-white/10 bg-white/[0.03] p-4 ${running && !reduce ? "pulse-glow" : ""}`}
      style={running && reduce ? { boxShadow: `0 0 24px -6px ${tone.glow}` } : undefined}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Icon className="size-5 shrink-0 text-neutral-300" aria-hidden="true" />
          <div>
            <p className="text-sm font-semibold text-white">{s.title}</p>
            <p className="text-xs text-neutral-400">
              {AGENT_LABEL[s.agent] ?? s.agent}
              {s.model ? ` · ${s.model}` : ""} · tentativa {s.attempt}
            </p>
          </div>
        </div>
        <motion.span key={s.status} initial={{ scale: reduce ? 1 : 0.85, opacity: 0.4 }} animate={{ scale: 1, opacity: 1 }}>
          <Pill label={tone.label} text={tone.text} bg={tone.bg} testId="subagent-status" />
        </motion.span>
      </div>
      <div className={`mt-3 h-1.5 w-full rounded-full bg-white/10 ${running ? "shimmer" : ""}`} aria-hidden="true">
        {!running && (
          <div
            className={`h-full rounded-full transition-[width] duration-500 ${s.status === "done" ? "w-full bg-ok" : s.status === "failed" ? "w-full bg-bad" : "w-0"}`}
          />
        )}
      </div>
      {s.output && <p className="mt-3 line-clamp-3 text-xs text-neutral-300">{s.output}</p>}
    </motion.li>
  );
}

function Detail({ d, data }: { d: Dashboard; data: TaskDetail }) {
  const reduce = !!useReducedMotion();
  const [note, setNote] = useState("");
  const { task, subtasks, snapshots, usage, memory, approval } = data;
  const tone = TASK_STATUS[task.status];
  const done = subtasks.filter((s) => s.status === "done").length;
  const sortedSnaps = [...snapshots].sort((a, b) => a.version - b.version);
  const awaiting = task.status === "awaiting_approval";

  return (
    <div className="space-y-6" data-testid="task-panel-content" data-task-id={task.id}>
      <div>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h3 className="font-heading text-2xl font-bold text-white" data-testid="panel-title">
            {task.title}
          </h3>
          <Pill label={tone.label} text={tone.text} bg={tone.bg} testId="panel-status" />
        </div>
        <p className="mt-2 text-sm text-neutral-300">{task.description}</p>
        <p className="mt-3 text-sm text-neutral-300" data-testid="correction-rounds">
          Rodadas de correção: <strong className="text-white">{task.correctionRounds}</strong> de 2
        </p>
      </div>

      {task.status === "completed" && (
        <motion.div
          initial={{ opacity: 0, scale: reduce ? 1 : 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          data-testid="completion-banner"
          className="rounded-2xl border border-ok/40 bg-ok/10 p-4"
          style={{ boxShadow: "0 0 40px -14px rgba(95,191,133,0.6)" }}
        >
          <div className="flex items-center gap-2 font-heading text-lg font-bold text-ok">
            <CheckCircle2 className="size-6" aria-hidden="true" />
            Tarefa concluída
          </div>
          {task.result?.summary && <p className="mt-2 text-sm text-neutral-200">{task.result.summary}</p>}
          {task.result && task.result.artifacts.length > 0 && (
            <ul className="mt-2 list-inside list-disc text-sm text-neutral-300">
              {task.result.artifacts.map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs text-neutral-300">
            Custo final {usd(task.spentUsd)} de {usd(task.budgetUsd)}
          </p>
        </motion.div>
      )}

      {task.error && task.status !== "completed" && <ErrorNote text={task.error} testId="task-error" />}

      {awaiting && (
        <div data-testid="approval-box" className="rounded-2xl border border-accent/40 bg-accent/10 p-4" style={{ boxShadow: "0 0 36px -14px rgba(255,122,0,0.6)" }}>
          <p className="font-semibold text-accent">Aprovação humana necessária</p>
          <label htmlFor="approval-note" className="mt-3 block text-sm text-neutral-200">
            Observação (opcional)
          </label>
          <textarea id="approval-note" data-testid="approval-note" className="field mt-1 min-h-20 py-2" value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="mt-3 flex flex-wrap gap-3">
            <button type="button" data-testid="approve-btn" className="btn" disabled={d.pending.approve || d.pending.reject} onClick={() => void d.taskAction(task.id, "approve", note.trim() || undefined)}>
              {d.pending.approve ? <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <ThumbsUp className="size-4" aria-hidden="true" />}
              Aprovar
            </button>
            <button type="button" data-testid="reject-btn" className="btn" disabled={d.pending.approve || d.pending.reject} onClick={() => void d.taskAction(task.id, "reject", note.trim() || undefined)}>
              {d.pending.reject ? <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <ThumbsDown className="size-4" aria-hidden="true" />}
              Rejeitar
            </button>
          </div>
        </div>
      )}
      {!awaiting && approval && approval.status !== "pending" && (
        <p className="text-sm text-neutral-300" data-testid="approval-resolved">
          Aprovação {approval.status === "approved" ? "concedida" : "negada"}
          {approval.decidedBy ? (
            <>
              {" "}por <strong className="text-white" data-testid="approval-decided-by">{approval.decidedBy}</strong>
            </>
          ) : null}
          {approval.note ? `: ${approval.note}` : "."}
        </p>
      )}

      {task.status === "failed" && (
        <button type="button" data-testid="resume-btn" className="btn" disabled={d.pending.resume} onClick={() => void d.taskAction(task.id, "resume")}>
          {d.pending.resume ? <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <RotateCcw className="size-4" aria-hidden="true" />}
          Retomar
        </button>
      )}

      <section aria-labelledby="lanes-title">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h4 id="lanes-title" className="flex items-center gap-2 font-heading text-lg font-bold text-white">
            <Play className="size-4" aria-hidden="true" />
            Subagentes ao vivo
          </h4>
          <span className="text-sm text-neutral-300" data-testid="subtask-progress-label">
            {done} de {subtasks.length} concluídos
          </span>
        </div>
        <ProgressBar ratio={subtasks.length ? done / subtasks.length : 0} tone="bg-ok" label="Progresso das subtarefas" />
        {subtasks.length === 0 ? (
          <div className="mt-3">
            <EmptyState testId="lanes-empty" text="O plano ainda não gerou subtarefas." />
          </div>
        ) : (
          <ul className="mt-3 grid gap-3 md:grid-cols-2" data-testid="lanes">
            {subtasks.map((s) => (
              <Lane key={s.id} s={s} reduce={reduce} />
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="timeline-title">
        <h4 id="timeline-title" className="mb-3 font-heading text-lg font-bold text-white">
          Linha do tempo do contexto
        </h4>
        {sortedSnaps.length === 0 ? (
          <EmptyState testId="timeline-empty" text="Nenhum snapshot de contexto ainda." />
        ) : (
          <ol className="relative ml-3 border-l-2 border-brand/30" data-testid="timeline">
            <AnimatePresence initial={false}>
              {sortedSnaps.map((sn) => (
                <motion.li
                  key={sn.hash}
                  layout
                  initial={{ opacity: 0, x: reduce ? 0 : -12 }}
                  animate={{ opacity: 1, x: 0 }}
                  data-testid="snapshot-item"
                  data-version={sn.version}
                  className="relative mb-4 ml-6 rounded-xl border border-white/10 bg-white/[0.03] p-3"
                >
                  <GitCommitVertical className="absolute -left-[2.15rem] top-3 size-5 rounded-full bg-[#0a0a0a] text-brand" aria-hidden="true" />
                  <p className="text-sm font-semibold text-white">
                    v{sn.version} · {sn.label}
                  </p>
                  <p className="mt-1 text-xs text-neutral-300">
                    <code className="rounded bg-white/10 px-1.5 py-0.5">{shortHash(sn.hash)}</code>
                    {sn.parentHash ? (
                      <>
                        {" "}
                        vem de <code className="rounded bg-white/10 px-1.5 py-0.5">{shortHash(sn.parentHash)}</code>
                      </>
                    ) : (
                      " (raiz)"
                    )}
                    {" · "}
                    {time(sn.createdAt)}
                  </p>
                </motion.li>
              ))}
            </AnimatePresence>
          </ol>
        )}
      </section>

      <section aria-labelledby="memory-title">
        <h4 id="memory-title" className="mb-3 font-heading text-lg font-bold text-white">
          Memória compartilhada
        </h4>
        {memory.length === 0 ? (
          <EmptyState testId="memory-empty" text="Nenhuma entrada na memória compartilhada." />
        ) : (
          <ul className="space-y-2" data-testid="memory-list">
            {memory.map((m) => (
              <li key={`${m.key}-${m.at}`} data-testid="memory-item" className="rounded-xl border border-white/10 bg-white/[0.03] p-3 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2 font-semibold text-white">
                    <CircleDot className="size-3.5 text-brand" aria-hidden="true" />
                    {m.key}
                  </span>
                  <span className="text-xs text-neutral-400">{m.agent}</span>
                </div>
                <p className="mt-1 break-words text-xs text-neutral-300">{typeof m.value === "string" ? m.value : JSON.stringify(m.value)}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="usage-title">
        <h4 id="usage-title" className="mb-3 font-heading text-lg font-bold text-white">
          Consumo da tarefa
        </h4>
        {usage.length === 0 ? (
          <EmptyState testId="usage-empty" text="Sem consumo registrado ainda." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm" data-testid="usage-table">
              <caption className="sr-only">Consumo por chamada</caption>
              <thead className="text-xs text-neutral-400">
                <tr>
                  <th scope="col" className="py-2 pr-3">Agente</th>
                  <th scope="col" className="py-2 pr-3">Modelo</th>
                  <th scope="col" className="py-2 pr-3 text-right">Tokens</th>
                  <th scope="col" className="py-2 pr-3 text-right">Custo</th>
                  <th scope="col" className="py-2">Cache</th>
                </tr>
              </thead>
              <tbody>
                {usage.map((u) => (
                  <tr key={u.id} data-testid="usage-row" className="border-t border-white/10 text-neutral-200">
                    <td className="py-2 pr-3">{AGENT_LABEL[u.agent] ?? u.agent}</td>
                    <td className="py-2 pr-3">{u.model}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{int(u.promptTokens + u.completionTokens)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{usd(u.costUsd)}</td>
                    <td className="py-2">{u.cached ? "sim" : "não"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

export function TaskPanel({ d }: { d: Dashboard }) {
  return (
    <section id="painel-tarefa" aria-labelledby="panel-title" className="card scroll-mt-4 p-5" data-testid="task-panel">
      <h2 id="panel-title" className="sr-only">
        Tarefa selecionada
      </h2>
      {!d.selectedId ? (
        <EmptyState testId="panel-empty" text="Selecione uma tarefa para acompanhar os subagentes em tempo real." />
      ) : d.detailError ? (
        <ErrorNote text={d.detailError} onRetry={() => d.select(d.selectedId)} testId="panel-error" />
      ) : d.detailLoading || !d.detail ? (
        <div className="space-y-3" data-testid="panel-loading">
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
      ) : (
        <Detail key={d.detail.task.id} d={d} data={d.detail} />
      )}
    </section>
  );
}
