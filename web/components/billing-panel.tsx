"use client";

import { motion } from "motion/react";
import { Download } from "lucide-react";
import type { Dashboard } from "@/lib/use-dashboard";
import { CSV_URL } from "@/lib/api";
import { TASK_STATUS } from "@/lib/status";
import { int, usd } from "@/lib/format";
import { EmptyState, ErrorNote, Pill, Skeleton } from "./ui";

function Bars({ title, rows, testId, tone }: { title: string; rows: { name: string; cost: number; tokens: number }[]; testId: string; tone: string }) {
  const max = Math.max(...rows.map((r) => r.cost), 0.000001);
  return (
    <div>
      <h3 className="text-sm font-semibold text-slate-200">{title}</h3>
      {rows.length === 0 ? (
        <div className="mt-2">
          <EmptyState text="Sem dados ainda." />
        </div>
      ) : (
        <ul className="mt-2 space-y-3" data-testid={testId}>
          {rows.map((r) => (
            <li key={r.name} data-testid={`${testId}-item`}>
              <div className="flex justify-between text-xs text-slate-300">
                <span>{r.name}</span>
                <span className="tabular-nums">
                  {usd(r.cost)} · {int(r.tokens)} tokens
                </span>
              </div>
              <div className="mt-1 h-2.5 overflow-hidden rounded-full bg-white/10">
                <motion.div className={`h-full rounded-full ${tone}`} initial={{ width: 0 }} animate={{ width: `${(r.cost / max) * 100}%` }} transition={{ duration: 0.7, ease: "easeOut" }} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function BillingPanel({ d }: { d: Dashboard }) {
  const b = d.billing;
  return (
    <section aria-labelledby="bill-title" className="card p-5" data-testid="billing-panel">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="eyebrow">Custos</p>
          <h2 id="bill-title" className="mt-1 font-heading text-xl font-bold text-white">
            Faturamento
          </h2>
        </div>
        <a href={CSV_URL} download data-testid="export-csv" className="btn" aria-label="Exportar relatório de faturamento em CSV">
          <Download className="size-4" aria-hidden="true" />
          Exportar CSV
        </a>
      </div>
      {d.errors.billing && (
        <div className="mt-3">
          <ErrorNote text={d.errors.billing} onRetry={d.reloadAll} testId="billing-error" />
        </div>
      )}
      {d.loading.billing && !b ? (
        <div className="mt-4 space-y-3" data-testid="billing-loading">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
          <Skeleton className="h-24" />
        </div>
      ) : b ? (
        <div className="mt-4 space-y-6">
          <Bars title="Por modelo" testId="bars-model" tone="bg-cyan-400" rows={b.byModel.map((m) => ({ name: m.model, cost: m.costUsd, tokens: m.tokens }))} />
          <Bars title="Por agente" testId="bars-agent" tone="bg-indigo-400" rows={b.byAgent.map((a) => ({ name: a.agent, cost: a.costUsd, tokens: a.tokens }))} />
          <div>
            <h3 className="text-sm font-semibold text-slate-200">Por tarefa</h3>
            {b.byTask.length === 0 ? (
              <div className="mt-2">
                <EmptyState testId="billing-tasks-empty" text="Nenhuma tarefa faturada ainda." />
              </div>
            ) : (
              <div className="scroll-area mt-2 overflow-x-auto">
                <table className="w-full text-left text-sm" data-testid="billing-task-table">
                  <caption className="sr-only">Custo por tarefa</caption>
                  <thead className="sticky top-0 bg-[#0d0f1a] text-xs text-slate-400">
                    <tr>
                      <th scope="col" className="py-2 pr-3">Tarefa</th>
                      <th scope="col" className="py-2 pr-3">Status</th>
                      <th scope="col" className="py-2 pr-3 text-right">Tokens</th>
                      <th scope="col" className="py-2 text-right">Custo / orçamento</th>
                    </tr>
                  </thead>
                  <tbody>
                    {b.byTask.map((t) => {
                      const tone = TASK_STATUS[t.status];
                      return (
                        <tr key={t.taskId} data-testid="billing-task-row" className="border-t border-white/10 text-slate-200">
                          <td className="py-2 pr-3">{t.title}</td>
                          <td className="py-2 pr-3">
                            <Pill label={tone.label} text={tone.text} bg={tone.bg} />
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums">{int(t.tokens)}</td>
                          <td className="py-2 text-right tabular-nums">
                            {usd(t.costUsd)} / {usd(t.budgetUsd)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}
