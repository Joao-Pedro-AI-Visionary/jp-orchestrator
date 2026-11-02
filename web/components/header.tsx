"use client";

import { Activity, Database, Plus, Radio, Server } from "lucide-react";
import Image from "next/image";
import type { Dashboard } from "@/lib/use-dashboard";
import type { DependencyState } from "@/lib/types";

type IndicatorState = DependencyState | "unknown";

const INDICATOR: Record<IndicatorState, { label: string; dot: string; visible: boolean }> = {
  unknown: { label: "verificando", dot: "bg-neutral-400", visible: false },
  up: { label: "ativo", dot: "bg-ok", visible: false },
  down: { label: "fora do ar", dot: "bg-bad", visible: false },
  // In-memory mode is a valid, documented setup: neutral, not an alarm (Von Restorff).
  memory: { label: "em memória", dot: "border border-neutral-400 bg-transparent", visible: true },
};

/** The API's own state for the dependency; older APIs only send the boolean. */
function stateOf(d: Dashboard, name: "postgres" | "redis"): IndicatorState {
  if (!d.health) return "unknown";
  return d.health.services?.[name] ?? (d.health[name] ? "up" : "down");
}

function Indicator({ name, state, testId, icon }: { name: string; state: IndicatorState; testId: string; icon: React.ReactNode }) {
  const tone = INDICATOR[state];
  return (
    <li
      data-testid={testId}
      data-state={state}
      data-ok={state === "unknown" ? "unknown" : String(state === "up")}
      className="flex min-h-12 items-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-3 text-sm text-neutral-200"
    >
      {icon}
      <span>{name}</span>
      <span className={`size-2 rounded-full ${tone.dot}`} aria-hidden="true" />
      <span className={tone.visible ? "text-xs text-neutral-400" : "sr-only"}>{tone.label}</span>
    </li>
  );
}

export function Header({ d, onNewTask }: { d: Dashboard; onNewTask: () => void }) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-4" data-testid="app-header">
      <div className="flex items-center gap-3">
        <Image src="/jpdev-logo.png" alt="" width={48} height={57} priority className="h-14 w-auto" data-testid="brand-logo" />
        <div>
          <h1 className="font-heading text-2xl font-bold leading-none tracking-tight text-white" data-testid="brand">
            Jp<span className="text-brand">Dev</span>
            <span className="sr-only"> JP Orchestrator</span>
          </h1>
          <p className="mt-1 text-sm text-neutral-400">JP Orchestrator</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <ul aria-label="Saúde dos serviços" className="flex flex-wrap items-center gap-2" data-testid="health">
          <Indicator name="Postgres" state={stateOf(d, "postgres")} testId="health-postgres" icon={<Database className="size-4 text-neutral-400" aria-hidden="true" />} />
          <Indicator name="Redis" state={stateOf(d, "redis")} testId="health-redis" icon={<Server className="size-4 text-neutral-400" aria-hidden="true" />} />
          <li
            data-testid="live-indicator"
            data-live={String(d.live)}
            className="flex min-h-12 items-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-3 text-sm text-neutral-200"
          >
            {d.live ? <Radio className="size-4 text-ok" aria-hidden="true" /> : <Activity className="size-4 text-neutral-400" aria-hidden="true" />}
            {d.live ? "Ao vivo" : "Reconectando"}
          </li>
        </ul>
        <button type="button" className="btn btn-brand" data-testid="new-task-cta" onClick={onNewTask}>
          <Plus className="size-5" aria-hidden="true" />
          Nova tarefa
        </button>
      </div>
    </header>
  );
}
