"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, downloadBillingCsv, EVENTS_URL } from "./api";
import type {
  BillingSummary,
  GatewayCall,
  GatewayModel,
  GatewayStats,
  Health,
  ServerEvent,
  Task,
  TaskDetail,
  WebhookItem,
} from "./types";

type Slice = "health" | "tasks" | "billing" | "models" | "stats" | "webhooks";
export interface Toast {
  id: number;
  kind: "error" | "success";
  text: string;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : "Erro inesperado.");

const STATUS_ANNOUNCE: Record<string, string> = {
  completed: "concluída",
  failed: "falhou",
  rejected: "rejeitada",
  budget_exceeded: "parou por orçamento",
  awaiting_approval: "aguarda aprovação humana",
};

/**
 * What the screen reader hears: only task-level transitions that ask for attention
 * (finished, failed, waiting for a human). Per-call and per-subagent events and the
 * heartbeat stay silent; the polite region gets at most one coalesced message per window.
 */
function announcement(ev: ServerEvent): string | null {
  if (ev.type === "task.created") return "Nova tarefa criada";
  if (ev.type === "approval.requested") return "Aprovação humana solicitada";
  if (ev.type === "task.status") {
    const label = STATUS_ANNOUNCE[String(ev.payload?.status ?? "")];
    return label ? `Tarefa ${label}` : null;
  }
  return null;
}

const ANNOUNCE_WINDOW_MS = 1500;
// Billing is aggregated on the server, but every open tab polls it: refresh it at most this often.
const BILLING_THROTTLE_MS = 2500;
const THROTTLE_MS = 200;

export interface TaskInput {
  title: string;
  description: string;
  budgetUsd: number;
  requiresApproval: boolean;
}

export function useDashboard() {
  const [health, setHealth] = useState<Health | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [billing, setBilling] = useState<BillingSummary | null>(null);
  const [models, setModels] = useState<GatewayModel[]>([]);
  const [stats, setStats] = useState<GatewayStats | null>(null);
  const [webhooks, setWebhooks] = useState<WebhookItem[]>([]);
  const [loading, setLoading] = useState<Record<Slice, boolean>>({
    health: true,
    tasks: true,
    billing: true,
    models: true,
    stats: true,
    webhooks: true,
  });
  const [errors, setErrors] = useState<Partial<Record<Slice, string>>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailState, setDetailState] = useState<{ id: string; data: TaskDetail } | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [calls, setCalls] = useState<GatewayCall[]>([]);
  const [live, setLive] = useState(false);
  const [liveMessage, setLiveMessage] = useState("");
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [toasts, setToasts] = useState<Toast[]>([]);

  const selectedRef = useRef<string | null>(null);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const seq = useRef(0);
  const announceQueue = useRef<string[]>([]);
  const announceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const pushToast = useCallback((kind: Toast["kind"], text: string) => {
    const id = ++seq.current;
    setToasts((t) => [...t.slice(-3), { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
  }, []);
  const dismissToast = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const run = useCallback(async <T,>(key: Slice, fn: () => Promise<T>, set: (v: T) => void) => {
    try {
      set(await fn());
      setErrors((e) => ({ ...e, [key]: undefined }));
    } catch (err) {
      setErrors((e) => ({ ...e, [key]: errMsg(err) }));
    } finally {
      setLoading((l) => ({ ...l, [key]: false }));
    }
  }, []);

  const refreshHealth = useCallback(() => run("health", api.health, setHealth), [run]);
  const refreshTasks = useCallback(() => run("tasks", api.listTasks, setTasks), [run]);
  const refreshBilling = useCallback(() => run("billing", api.billing, setBilling), [run]);
  const refreshModels = useCallback(() => run("models", api.models, setModels), [run]);
  const refreshStats = useCallback(() => run("stats", api.gatewayStats, setStats), [run]);
  const refreshWebhooks = useCallback(() => run("webhooks", api.webhooks, setWebhooks), [run]);

  const refreshDetail = useCallback(async (id: string) => {
    try {
      const data = await api.getTask(id);
      if (selectedRef.current === id) {
        setDetailState({ id, data });
        setDetailError(null);
      }
    } catch (err) {
      if (selectedRef.current === id) setDetailError(errMsg(err));
    }
  }, []);

  const reloadAll = useCallback(() => {
    void Promise.all([
      refreshHealth(),
      refreshTasks(),
      refreshBilling(),
      refreshModels(),
      refreshStats(),
      refreshWebhooks(),
    ]);
    if (selectedRef.current) void refreshDetail(selectedRef.current);
  }, [refreshHealth, refreshTasks, refreshBilling, refreshModels, refreshStats, refreshWebhooks, refreshDetail]);

  useEffect(() => {
    reloadAll();
    const t = setInterval(() => void refreshHealth(), 15000);
    return () => clearInterval(t);
  }, [reloadAll, refreshHealth]);

  const select = useCallback(
    (id: string | null) => {
      selectedRef.current = id;
      setSelectedId(id);
      setDetailError(null);
      if (id) void refreshDetail(id);
    },
    [refreshDetail],
  );

  useEffect(() => {
    // Throttle, not debounce: under a steady event stream a debounce would only
    // refresh after the stream goes quiet, hiding the live parallel run.
    const schedule = (key: string, fn: () => void, ms = THROTTLE_MS) => {
      if (timers.current.has(key)) return;
      timers.current.set(
        key,
        setTimeout(() => {
          timers.current.delete(key);
          fn();
        }, ms),
      );
    };
    const announce = (text: string) => {
      announceQueue.current.push(text);
      if (announceTimer.current) return;
      announceTimer.current = setTimeout(() => {
        const queued = announceQueue.current;
        announceQueue.current = [];
        announceTimer.current = null;
        const unique = [...new Set(queued)];
        setLiveMessage(queued.length === 1 ? queued[0] : `${queued.length} atualizações: ${unique.join("; ")}`);
      }, ANNOUNCE_WINDOW_MS);
    };
    const es = new EventSource(EVENTS_URL);
    let opened = false;
    es.onopen = () => {
      setLive(true);
      // EventSource reconnects on its own; events sent while it was down are lost, so resync.
      if (opened) reloadAll();
      opened = true;
    };
    es.onerror = () => setLive(false);
    es.onmessage = (msg) => {
      let ev: ServerEvent;
      try {
        ev = JSON.parse(msg.data) as ServerEvent;
      } catch {
        return;
      }
      if (ev.type === "heartbeat") return;
      const spoken = announcement(ev);
      if (spoken) announce(spoken);
      const sel = selectedRef.current;
      const mine = sel !== null && ev.taskId === sel;
      switch (ev.type) {
        case "task.created":
        case "task.status":
          schedule("tasks", () => void refreshTasks());
          schedule("billing", () => void refreshBilling(), BILLING_THROTTLE_MS);
          break;
        case "gateway.call": {
          const p = ev.payload ?? {};
          const call: GatewayCall = {
            key: `${ev.at}-${++seq.current}`,
            model: String(p.model ?? "?"),
            cached: Boolean(p.cached),
            fallbackFrom: typeof p.fallbackFrom === "string" ? p.fallbackFrom : undefined,
            tokens: Number(p.tokens ?? 0),
            costUsd: Number(p.costUsd ?? 0),
            agent: String(p.agent ?? "-"),
            at: ev.at,
          };
          setCalls((c) => [call, ...c].slice(0, 8));
          schedule("stats", () => void refreshStats());
          break;
        }
        case "usage.recorded":
          schedule("billing", () => void refreshBilling(), BILLING_THROTTLE_MS);
          schedule("tasks", () => void refreshTasks());
          break;
        case "webhook.delivered":
          schedule("webhooks", () => void refreshWebhooks());
          break;
        default:
          break;
      }
      if (mine && sel) schedule("detail", () => void refreshDetail(sel));
    };
    const pendingTimers = timers.current;
    return () => {
      es.close();
      pendingTimers.forEach(clearTimeout);
      pendingTimers.clear();
      if (announceTimer.current) clearTimeout(announceTimer.current);
      announceTimer.current = null;
    };
  }, [reloadAll, refreshTasks, refreshBilling, refreshStats, refreshWebhooks, refreshDetail]);

  /** Runs `fn` with `pending[key]` set. Returns false (after a toast) when it threw. */
  const withPending = useCallback(
    async (key: string, fn: () => Promise<void>): Promise<boolean> => {
      setPending((p) => ({ ...p, [key]: true }));
      try {
        await fn();
        return true;
      } catch (err) {
        pushToast("error", errMsg(err));
        return false;
      } finally {
        setPending((p) => ({ ...p, [key]: false }));
      }
    },
    [pushToast],
  );

  /**
   * Resolves to null on success or to the error message, so the form keeps what was typed.
   * The caller owns the Idempotency-Key: reusing it on a retry of the same draft means a
   * request that reached the API but lost its response never creates a second task.
   */
  const createTask = useCallback(
    async (body: TaskInput, idempotencyKey: string): Promise<string | null> => {
      setPending((p) => ({ ...p, create: true }));
      try {
        const task = await api.createTask(body, idempotencyKey);
        pushToast("success", "Tarefa criada. Os subagentes já estão sendo planejados.");
        await refreshTasks();
        select(task.id);
        return null;
      } catch (err) {
        return errMsg(err);
      } finally {
        setPending((p) => ({ ...p, create: false }));
      }
    },
    [pushToast, refreshTasks, select],
  );

  /** Pending state is per task (`approve:<id>`), so acting on one task never locks another. */
  const taskAction = useCallback(
    (id: string, kind: "approve" | "reject" | "resume", note?: string) =>
      withPending(`${kind}:${id}`, async () => {
        if (kind === "approve") await api.approve(id, note);
        else if (kind === "reject") await api.reject(id, note);
        else await api.resume(id);
        pushToast(
          "success",
          kind === "approve" ? "Tarefa aprovada." : kind === "reject" ? "Tarefa rejeitada." : "Tarefa retomada.",
        );
        await Promise.all([refreshTasks(), refreshDetail(id)]);
      }),
    [withPending, pushToast, refreshTasks, refreshDetail],
  );

  const toggleModel = useCallback(
    (id: string) =>
      withPending(`toggle:${id}`, async () => {
        setModels((m) => m.map((x) => (x.id === id ? { ...x, healthy: !x.healthy } : x)));
        try {
          const updated = await api.toggleModel(id);
          setModels((m) => m.map((x) => (x.id === id ? updated : x)));
        } catch (err) {
          setModels((m) => m.map((x) => (x.id === id ? { ...x, healthy: !x.healthy } : x)));
          throw err;
        }
      }),
    [withPending],
  );

  const exportCsv = useCallback(async () => {
    try {
      await downloadBillingCsv();
    } catch (err) {
      pushToast("error", errMsg(err));
    }
  }, [pushToast]);

  const detail = detailState && detailState.id === selectedId ? detailState.data : null;

  return {
    health,
    tasks,
    billing,
    models,
    stats,
    webhooks,
    loading,
    errors,
    selectedId,
    detail,
    detailLoading: selectedId !== null && detail === null && detailError === null,
    detailError,
    calls,
    live,
    liveMessage,
    pending,
    toasts,
    dismissToast,
    select,
    reloadAll,
    createTask,
    taskAction,
    toggleModel,
    exportCsv,
  };
}

export type Dashboard = ReturnType<typeof useDashboard>;
