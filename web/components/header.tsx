"use client";

import { Activity, Database, Plus, Radio, Server } from "lucide-react";
import Image from "next/image";
import type { Dashboard } from "@/lib/use-dashboard";

function Indicator({ name, ok, testId, icon }: { name: string; ok: boolean | undefined; testId: string; icon: React.ReactNode }) {
  const state = ok === undefined ? "verificando" : ok ? "ativo" : "fora do ar";
  const color = ok === undefined ? "bg-neutral-400" : ok ? "bg-ok" : "bg-bad";
  return (
    <li
      data-testid={testId}
      data-ok={ok === undefined ? "unknown" : String(ok)}
      className="flex min-h-12 items-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-3 text-sm text-neutral-200"
    >
      {icon}
      <span>{name}</span>
      <span className={`size-2 rounded-full ${color}`} aria-hidden="true" />
      <span className="sr-only">{state}</span>
    </li>
  );
}

export function Header({ d, onNewTask }: { d: Dashboard; onNewTask: () => void }) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-4" data-testid="app-header">
      <div className="flex items-center gap-3">
        <Image src="/jpdev-logo.png" alt="" width={48} height={57} priority className="h-14 w-auto" data-testid="brand-logo" />
        <div>
          <p className="font-heading text-2xl font-bold leading-none tracking-tight text-white" data-testid="brand">
            Jp<span className="text-brand">Dev</span>
          </p>
          <p className="mt-1 text-sm text-neutral-400">JP Orchestrator</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <ul aria-label="Saúde dos serviços" className="flex flex-wrap items-center gap-2" data-testid="health">
          <Indicator name="Postgres" ok={d.health?.postgres} testId="health-postgres" icon={<Database className="size-4 text-neutral-400" aria-hidden="true" />} />
          <Indicator name="Redis" ok={d.health?.redis} testId="health-redis" icon={<Server className="size-4 text-neutral-400" aria-hidden="true" />} />
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
