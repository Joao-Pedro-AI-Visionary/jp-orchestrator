"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowRight, CornerDownRight, DatabaseZap, Loader2, Power, PowerOff, Send } from "lucide-react";
import type { Dashboard } from "@/lib/use-dashboard";
import { int, time, usd } from "@/lib/format";
import { EmptyState, ErrorNote, Skeleton } from "./ui";

const TIER_LABEL = { cheap: "econômico", balanced: "equilibrado", premium: "premium" } as const;

export function GatewayPanel({ d }: { d: Dashboard }) {
  const reduce = !!useReducedMotion();
  const s = d.stats;
  const statItems = [
    { label: "Requisições", v: s?.requests, id: "stat-requests" },
    { label: "Cache hits", v: s?.cacheHits, id: "stat-cache" },
    { label: "Fallbacks", v: s?.fallbacks, id: "stat-fallbacks" },
    { label: "Bloqueios de limite de tokens", v: s?.rejectedTokenLimit, id: "stat-token-limit" },
    { label: "Bloqueios de orçamento", v: s?.budgetBlocks, id: "stat-budget" },
  ];
  return (
    <section aria-labelledby="gw-title" className="card p-5" data-testid="gateway-panel">
      <p className="eyebrow">Roteamento</p>
      <h2 id="gw-title" className="mt-1 font-heading text-xl font-bold text-white">
        AI Gateway
      </h2>

      <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
        {statItems.map((i) => (
          <div key={i.id} className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
            <dt className="text-xs text-neutral-400">{i.label}</dt>
            <dd className="mt-1 font-heading text-lg font-bold text-white" data-testid={i.id}>
              {i.v === undefined ? <Skeleton className="h-6 w-10" /> : int(i.v)}
            </dd>
          </div>
        ))}
      </dl>
      {d.errors.stats && (
        <div className="mt-3">
          <ErrorNote text={d.errors.stats} onRetry={d.reloadAll} />
        </div>
      )}

      <h3 className="mt-6 text-sm font-semibold text-neutral-200">Fluxo das chamadas recentes</h3>
      <div className="mt-2" aria-label="Chamadas recentes ao gateway" data-testid="gateway-flow">
        {d.calls.length === 0 ? (
          <EmptyState testId="flow-empty" text="Aguardando chamadas ao gateway. Elas aparecem aqui ao vivo." />
        ) : (
          <ul className="space-y-2">
            <AnimatePresence initial={false}>
              {d.calls.map((c) => (
                <motion.li
                  key={c.key}
                  layout
                  initial={{ opacity: 0, x: reduce ? 0 : -24 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0 }}
                  data-testid="gateway-flow-item"
                  data-cached={String(c.cached)}
                  data-fallback={c.fallbackFrom ? "true" : "false"}
                  className="flex flex-wrap items-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-neutral-200"
                >
                  <span className="inline-flex items-center gap-1 rounded-lg bg-white/10 px-2 py-1">
                    <Send className="size-3" aria-hidden="true" />
                    {c.agent}
                  </span>
                  <ArrowRight className="size-3.5 text-neutral-400" aria-hidden="true" />
                  {c.cached ? (
                    <span className="inline-flex items-center gap-1 rounded-lg bg-ok/10 px-2 py-1 text-ok">
                      <DatabaseZap className="size-3" aria-hidden="true" />
                      cache hit
                    </span>
                  ) : (
                    <>
                      {c.fallbackFrom && (
                        <>
                          <span className="rounded-lg bg-bad/10 px-2 py-1 text-bad line-through">{c.fallbackFrom}</span>
                          <CornerDownRight className="size-3.5 text-accent" aria-label="fallback" />
                        </>
                      )}
                      <span className="rounded-lg bg-brand/10 px-2 py-1 text-brand">{c.model}</span>
                    </>
                  )}
                  <span className="ml-auto tabular-nums text-neutral-400">
                    {int(c.tokens)} tokens · {usd(c.costUsd)} · {time(c.at)}
                  </span>
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        )}
      </div>

      <h3 className="mt-6 text-sm font-semibold text-neutral-200">Modelos</h3>
      <div className="mt-2">
        {d.errors.models && <ErrorNote text={d.errors.models} onRetry={d.reloadAll} />}
        {d.loading.models ? (
          <div className="space-y-2">
            <Skeleton className="h-14" />
            <Skeleton className="h-14" />
          </div>
        ) : d.models.length === 0 && !d.errors.models ? (
          <EmptyState testId="models-empty" text="Nenhum modelo configurado no gateway." />
        ) : (
          <ul className="space-y-2" data-testid="models-list">
            {d.models.map((m) => {
              const busy = !!d.pending[`toggle:${m.id}`];
              return (
                <motion.li
                  key={m.id}
                  layout
                  data-testid="model-item"
                  data-healthy={String(m.healthy)}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2"
                >
                  <div>
                    <p className="flex items-center gap-2 text-sm font-semibold text-white">
                      <span className={`size-2 rounded-full ${m.healthy ? "bg-ok" : "bg-bad"}`} aria-hidden="true" />
                      {m.id}
                      <span className="sr-only">{m.healthy ? "saudável" : "fora do ar"}</span>
                    </p>
                    <p className="text-xs text-neutral-400">
                      {m.provider} · {TIER_LABEL[m.tier]} · entrada {usd(m.inputPer1k)}/1k · saída {usd(m.outputPer1k)}/1k
                    </p>
                  </div>
                  <button type="button" data-testid={`model-toggle-${m.id}`} className="btn" disabled={busy} aria-pressed={!m.healthy} onClick={() => void d.toggleModel(m.id)}>
                    {busy ? <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : m.healthy ? <PowerOff className="size-4" aria-hidden="true" /> : <Power className="size-4" aria-hidden="true" />}
                    {m.healthy ? "Derrubar" : "Restaurar"}
                  </button>
                </motion.li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
