"use client";

import { Coins, Cpu, DatabaseZap, PiggyBank, Shuffle } from "lucide-react";
import type { Dashboard } from "@/lib/use-dashboard";
import { int, usd } from "@/lib/format";
import { AnimatedNumber, Skeleton } from "./ui";

export function Kpis({ d }: { d: Dashboard }) {
  const t = d.billing?.totals;
  const items = [
    { id: "kpi-cost", label: "Custo total", icon: Coins, value: t?.costUsd ?? 0, fmt: usd, glow: "rgba(109,74,255,0.4)", ready: !!t },
    { id: "kpi-tokens", label: "Tokens", icon: Cpu, value: t?.tokens ?? 0, fmt: int, glow: "rgba(34,211,238,0.3)", ready: !!t },
    { id: "kpi-cache", label: "Cache hits", icon: DatabaseZap, value: t?.cacheHits ?? 0, fmt: int, glow: "rgba(52,211,153,0.3)", ready: !!t },
    { id: "kpi-saved", label: "Economia (USD)", icon: PiggyBank, value: t?.savedUsd ?? 0, fmt: usd, glow: "rgba(52,211,153,0.3)", ready: !!t },
    { id: "kpi-fallbacks", label: "Fallbacks do gateway", icon: Shuffle, value: d.stats?.fallbacks ?? 0, fmt: int, glow: "rgba(251,191,36,0.3)", ready: !!d.stats },
  ];
  return (
    <section aria-label="Indicadores" data-testid="kpi-row" className="grid grid-cols-2 gap-4 lg:grid-cols-5">
      {items.map((k) => (
        <div key={k.id} className="card p-4" style={{ ["--glow" as string]: k.glow }}>
          <div className="flex items-center gap-2 text-sm text-slate-300">
            <k.icon className="size-4" aria-hidden="true" />
            {k.label}
          </div>
          <p className="mt-3 font-heading text-2xl font-bold text-white sm:text-3xl">
            {k.ready ? <AnimatedNumber value={k.value} format={k.fmt} testId={k.id} /> : <Skeleton className="h-9 w-24" />}
          </p>
        </div>
      ))}
    </section>
  );
}
