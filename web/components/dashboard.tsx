"use client";

import { useRef } from "react";
import { useDashboard } from "@/lib/use-dashboard";
import { Header } from "./header";
import { Kpis } from "./kpis";
import { NewTaskForm } from "./new-task-form";
import { TaskList } from "./task-list";
import { TaskPanel } from "./task-panel";
import { GatewayPanel } from "./gateway-panel";
import { BillingPanel } from "./billing-panel";
import { WebhooksPanel } from "./webhooks-panel";
import { Toasts } from "./toasts";

export function Dashboard() {
  const d = useDashboard();
  const titleRef = useRef<HTMLInputElement>(null);

  function focusForm() {
    document.getElementById("nova-tarefa")?.scrollIntoView({ behavior: "smooth", block: "center" });
    titleRef.current?.focus({ preventScroll: true });
  }

  return (
    <>
    <a href="#conteudo" className="skip-link" data-testid="skip-link">
      Pular para o conteúdo
    </a>
    <div className="topbar">
      <div className="mx-auto max-w-[1400px] px-4 py-3 sm:px-6">
        <Header d={d} onNewTask={focusForm} />
      </div>
    </div>
    <div className="mx-auto flex max-w-[1400px] flex-col gap-6 px-4 py-6 sm:px-6">
      <main className="flex flex-col gap-6 focus:outline-none" id="conteudo" tabIndex={-1}>
        <Kpis d={d} />
        <div className="grid gap-6 lg:grid-cols-12">
          <div className="flex min-w-0 flex-col gap-6 lg:col-span-5">
            <NewTaskForm ref={titleRef} d={d} />
            <TaskList d={d} />
          </div>
          <div className="min-w-0 lg:col-span-7">
            <TaskPanel d={d} />
          </div>
        </div>
        <div className="grid gap-6 xl:grid-cols-12">
          <div className="min-w-0 xl:col-span-6">
            <GatewayPanel d={d} />
          </div>
          <div className="flex min-w-0 flex-col gap-6 xl:col-span-6">
            <BillingPanel d={d} />
            <WebhooksPanel d={d} />
          </div>
        </div>
      </main>
      <footer className="pb-4 text-center text-xs text-neutral-400">JpDev · JP Orchestrator · código aberto</footer>
      <div role="status" aria-live="polite" className="sr-only" data-testid="live-region">
        {d.liveMessage}
      </div>
      <Toasts d={d} />
    </div>
    </>
  );
}
