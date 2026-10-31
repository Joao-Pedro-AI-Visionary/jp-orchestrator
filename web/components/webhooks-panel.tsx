"use client";

import { AnimatePresence, motion } from "motion/react";
import { ShieldAlert, ShieldCheck } from "lucide-react";
import type { Dashboard } from "@/lib/use-dashboard";
import { time } from "@/lib/format";
import { EmptyState, ErrorNote, Skeleton } from "./ui";

export function WebhooksPanel({ d }: { d: Dashboard }) {
  return (
    <section aria-labelledby="wh-title" className="card p-5" data-testid="webhooks-panel">
      <h2 id="wh-title" className="font-heading text-xl font-bold text-white">
        Webhooks recebidos
      </h2>
      <p className="mt-1 text-sm text-slate-400">Eventos assinados com HMAC e verificados no recebimento.</p>
      <div className="mt-4">
        {d.errors.webhooks && <ErrorNote text={d.errors.webhooks} onRetry={d.reloadAll} />}
        {d.loading.webhooks ? (
          <div className="space-y-2">
            <Skeleton className="h-14" />
            <Skeleton className="h-14" />
          </div>
        ) : d.webhooks.length === 0 && !d.errors.webhooks ? (
          <EmptyState testId="webhooks-empty" text="Nenhum webhook recebido ainda. Conclua uma tarefa para gerar o primeiro." />
        ) : (
          <ul className="space-y-2" data-testid="webhooks-list">
            <AnimatePresence initial={false}>
              {d.webhooks.map((w) => (
                <motion.li
                  key={w.id}
                  layout
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  data-testid="webhook-item"
                  data-verified={String(w.verified)}
                  className="rounded-xl border border-white/10 bg-white/[0.03] p-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-white">{w.event}</span>
                    <span
                      data-testid="webhook-badge"
                      className={`inline-flex items-center gap-1 rounded-full border border-white/10 px-2.5 py-1 text-xs font-semibold ${w.verified ? "bg-emerald-400/10 text-emerald-300" : "bg-rose-400/10 text-rose-300"}`}
                    >
                      {w.verified ? <ShieldCheck className="size-3.5" aria-hidden="true" /> : <ShieldAlert className="size-3.5" aria-hidden="true" />}
                      {w.verified ? "assinatura válida" : "assinatura inválida"}
                    </span>
                  </div>
                  <p className="mt-1 truncate text-xs text-slate-400">
                    <code>{w.signature}</code> · {time(w.receivedAt)}
                  </p>
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        )}
      </div>
    </section>
  );
}
