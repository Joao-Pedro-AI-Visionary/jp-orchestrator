"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, EVENTS_URL } from "./api";
import { TASK_STATUS } from "./status";
import type {
  BillingSummary,
  GatewayCall,
  GatewayModel,
  GatewayStats,
  Health,
  ServerEvent,
  Task,
  TaskStatus,
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
  const reloadRef = useRef<() => void>(() => undefined);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const seq = useRef(0);

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
    reloadRef.current = reloadAll;
  }, [reloadAll]);

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
    const schedule = (key: string, fn: () => void) => {
      if (timers.current.has(key)) return;
      timers.current.set(
        key,
        setTimeout(() => {
          timers.current.delete(key);
          fn();
        }, 200),
      );
    };
    const es = new EventSource(EVENTS_URL);
    // Events sent while the stream was down are lost: after a reconnect, refetch everything.
    let dropped = false;
    es.onopen = () => {
      setLive(true);
      if (dropped) {
        dropped = false;
        reloadRef.current();
      }
    };
    es.onerror = () => {
      setLive(false);
      dropped = true;
    };
    es.onmessage = (msg) => {
      let ev: ServerEvent;
      try {
        ev = JSON.parse(msg.data) as ServerEvent;
      } catch {
        return;
      }
      const sel = selectedRef.current;
      const mine = sel !== null && ev.taskId === sel;
      // Screen readers hear only status changes of the selected task, not every event of the stream.
      const status = ev.payload?.status as TaskStatus | undefined;
      if (mine && ev.type === "task.status" && status && TASK_STATUS[status]) {
        setLiveMessage(`Tarefa selecionada: ${TASK_STATUS[status].label}`);
      }
      switch (ev.type) {
        case "task.created":
        case "task.status":
          schedule("tasks", () => void refreshTasks());
          schedule("billing", () => void refreshBilling());
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
          schedule("billing", () => void refreshBilling());
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
    };
  }, [refreshTasks, refreshBilling, refreshStats, refreshWebhooks, refreshDetail]);

  /** Runs fn with its button in the pending state; errors become a toast. Resolves true on success. */
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
   * idempotencyKey belongs to the form draft: a retry of the same draft (lost response,
   * double click) sends the same key and gets the same task instead of a duplicate.
   */
  const createTask = useCallback(
    (body: { title: string; description: string; budgetUsd: number; requiresApproval: boolean }, idempotencyKey: string) =>
      withPending("create", async () => {
        const task = await api.createTask(body, idempotencyKey);
        pushToast("success", "Tarefa criada. Os subagentes já estão sendo planejados.");
        await refreshTasks();
        select(task.id);
      }),
    [withPending, pushToast, refreshTasks, select],
  );

  const taskAction = useCallback(
    (id: string, kind: "approve" | "reject" | "resume", note?: string) =>
      withPending(kind, async () => {
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
  };
}

export type Dashboard = ReturnType<typeof useDashboard>;
