"use client";

import { Coins, Cpu, DatabaseZap, PiggyBank, Shuffle } from "lucide-react";
import type { Dashboard } from "@/lib/use-dashboard";
import { int, usd } from "@/lib/format";
import { AnimatedNumber, Skeleton } from "./ui";

export function Kpis({ d }: { d: Dashboard }) {
  const t = d.billing?.totals;
  const items = [
    { id: "kpi-cost", label: "Custo total", icon: Coins, value: t?.costUsd ?? 0, fmt: usd, glow: "rgba(255,200,0,0.35)", ready: !!t },
    { id: "kpi-tokens", label: "Tokens", icon: Cpu, value: t?.tokens ?? 0, fmt: int, glow: "rgba(255,200,0,0.35)", ready: !!t },
    { id: "kpi-cache", label: "Cache hits", icon: DatabaseZap, value: t?.cacheHits ?? 0, fmt: int, glow: "rgba(95,191,133,0.3)", ready: !!t },
    { id: "kpi-saved", label: "Economia (USD)", icon: PiggyBank, value: t?.savedUsd ?? 0, fmt: usd, glow: "rgba(95,191,133,0.3)", ready: !!t },
    { id: "kpi-fallbacks", label: "Fallbacks do gateway", icon: Shuffle, value: d.stats?.fallbacks ?? 0, fmt: int, glow: "rgba(255,122,0,0.3)", ready: !!d.stats },
  ];
  return (
    <section aria-label="Indicadores" data-testid="kpi-row" className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-5">
      {items.map((k) => (
        <div key={k.id} className="card kpi-accent p-3 last:col-span-2 sm:p-4 lg:last:col-span-1" style={{ ["--glow" as string]: k.glow, ["--accent" as string]: k.glow.replace(/0\.\d+\)$/, "1)") }}>
          <div className="eyebrow flex items-center gap-2">
            <k.icon className="size-4 text-neutral-300" aria-hidden="true" />
            {k.label}
          </div>
          <p className="mt-2 font-heading text-xl font-bold tracking-tight text-white sm:mt-3 sm:text-3xl">
            {k.ready ? <AnimatedNumber value={k.value} format={k.fmt} testId={k.id} /> : <Skeleton className="h-7 w-24 sm:h-9" />}
          </p>
        </div>
      ))}
    </section>
  );
}
