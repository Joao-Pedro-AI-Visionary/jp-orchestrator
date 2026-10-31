import type {
  BillingSummary,
  GatewayModel,
  GatewayStats,
  Health,
  Task,
  TaskDetail,
  WebhookItem,
} from "./types";

export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001").replace(/\/$/, "");

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function friendly(status: number, detail: string): string {
  switch (status) {
    case 400:
    case 422:
      return detail || "Dados inválidos. Revise os campos e tente novamente.";
    case 401:
      return "Sessão não autorizada.";
    case 403:
      return "Você não tem permissão para esta ação.";
    case 404:
      return "Recurso não encontrado.";
    case 409:
      return detail || "Conflito: o estado atual não permite esta ação.";
    case 0:
      return "Não foi possível falar com a API. Verifique se ela está no ar.";
    default:
      return status >= 500 ? "Erro interno da API. Tente novamente em instantes." : detail || "Falha na requisição.";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch {
    throw new ApiError(friendly(0, ""), 0);
  }
  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { message?: string | string[] };
      detail = Array.isArray(body.message) ? body.message.join("; ") : (body.message ?? "");
    } catch {
      /* corpo sem JSON */
    }
    throw new ApiError(friendly(res.status, detail), res.status);
  }
  return (await res.json()) as T;
}

export const api = {
  health: () => request<Health>("/health"),
  listTasks: () => request<Task[]>("/tasks"),
  getTask: (id: string) => request<TaskDetail>(`/tasks/${encodeURIComponent(id)}`),
  createTask: (
    body: { title: string; description: string; budgetUsd: number; requiresApproval: boolean },
    idempotencyKey: string,
  ) =>
    request<Task>("/tasks", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify(body),
    }),
  approve: (id: string, note?: string) =>
    request<Task>(`/tasks/${encodeURIComponent(id)}/approve`, {
      method: "POST",
      body: JSON.stringify(note ? { note } : {}),
    }),
  reject: (id: string, note?: string) =>
    request<Task>(`/tasks/${encodeURIComponent(id)}/reject`, {
      method: "POST",
      body: JSON.stringify(note ? { note } : {}),
    }),
  resume: (id: string) => request<Task>(`/tasks/${encodeURIComponent(id)}/resume`, { method: "POST" }),
  billing: () => request<BillingSummary>("/billing/summary"),
  models: () => request<GatewayModel[]>("/gateway/models"),
  toggleModel: (id: string) =>
    request<GatewayModel>(`/gateway/models/${encodeURIComponent(id)}/toggle`, { method: "POST" }),
  gatewayStats: () => request<GatewayStats>("/gateway/stats"),
  webhooks: () => request<WebhookItem[]>("/webhooks/inbox"),
};

export const CSV_URL = `${API_URL}/billing/report.csv`;
