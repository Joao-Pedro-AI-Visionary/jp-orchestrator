"use client";

import { forwardRef, useRef, useState } from "react";
import { Loader2, Send } from "lucide-react";
import { LIMITS, newIdempotencyKey, type TaskField, validateTask } from "@/lib/limits";
import type { Dashboard } from "@/lib/use-dashboard";

const PRESETS = [
  {
    label: "Endpoint REST com testes",
    title: "Criar endpoint REST com testes",
    description:
      "Implementar um endpoint REST de listagem paginada com validação de entrada, tratamento de erros e testes automatizados cobrindo o caminho feliz e os casos de erro.",
    budget: 0.05,
    approval: false,
  },
  {
    label: "Refatorar módulo",
    title: "Refatorar módulo de cobrança",
    description:
      "Reduzir acoplamento do módulo de cobrança, extrair responsabilidades em serviços menores e manter a suíte de testes existente passando.",
    budget: 0.08,
    approval: true,
  },
  {
    label: "Investigar bug",
    title: "Investigar bug de timeout intermitente",
    description:
      "Reproduzir o timeout intermitente na fila de processamento, identificar a causa raiz e propor a correção com um teste de regressão.",
    budget: 0.04,
    approval: false,
  },
];

export const NewTaskForm = forwardRef<HTMLInputElement, { d: Dashboard }>(function NewTaskForm({ d }, titleRef) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [budget, setBudget] = useState("0.05");
  const [approval, setApproval] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<TaskField, string>>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const busy = !!d.pending.create;
  const descRef = useRef<HTMLTextAreaElement>(null);
  const budgetRef = useRef<HTMLInputElement>(null);
  // One key per draft: a resend of the same content reuses it (no duplicate task if the
  // first response was lost); it changes only after success or when the content changes.
  const draftKey = useRef<{ content: string; key: string } | null>(null);

  function draftChanged() {
    setServerError(null);
  }

  function focusField(field: TaskField) {
    const el = field === "title" ? (typeof titleRef === "function" ? null : titleRef?.current) : field === "description" ? descRef.current : budgetRef.current;
    el?.focus();
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const errors = validateTask({ title, description, budget });
    setFieldErrors(errors);
    setServerError(null);
    const first = (["title", "description", "budget"] as const).find((f) => errors[f]);
    if (first) return focusField(first);
    const body = {
      title: title.trim(),
      description: description.trim(),
      budgetUsd: Number(budget.replace(",", ".")),
      requiresApproval: approval,
    };
    const content = JSON.stringify(body);
    if (draftKey.current?.content !== content) draftKey.current = { content, key: newIdempotencyKey() };
    const failure = await d.createTask(body, draftKey.current.key);
    if (failure) {
      setServerError(failure);
      return;
    }
    draftKey.current = null;
    setTitle("");
    setDescription("");
    setFieldErrors({});
  }

  const describedBy = (field: TaskField, hint?: string) =>
    [hint, fieldErrors[field] ? `task-${field}-error` : null].filter(Boolean).join(" ") || undefined;
  const fieldError = (field: TaskField) =>
    fieldErrors[field] ? (
      <p id={`task-${field}-error`} data-testid={`task-${field}-error`} className="mt-1 text-sm text-bad">
        {fieldErrors[field]}
      </p>
    ) : null;

  return (
    <section id="nova-tarefa" aria-labelledby="form-title" className="card p-5" data-testid="new-task-section">
      <p className="eyebrow">Criar</p>
      <h2 id="form-title" className="mt-1 font-heading text-xl font-bold text-white">
        Nova tarefa
      </h2>
      <p className="mt-1 text-sm text-neutral-400">Comece por um modelo pronto ou descreva do zero.</p>
      <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="Modelos de tarefa">
        {PRESETS.map((p, i) => (
          <button
            key={p.label}
            type="button"
            data-testid={`preset-${i}`}
            className="btn"
            onClick={() => {
              setTitle(p.title);
              setDescription(p.description);
              setBudget(String(p.budget));
              setApproval(p.approval);
              setFieldErrors({});
              draftChanged();
            }}
          >
            {p.label}
          </button>
        ))}
      </div>
      <form onSubmit={submit} data-testid="new-task-form" className="mt-4 space-y-3" noValidate>
        <div>
          <label htmlFor="task-title" className="mb-1 block text-sm font-medium text-neutral-200">
            Título
          </label>
          <input
            id="task-title"
            ref={titleRef}
            data-testid="task-title-input"
            className="field"
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              draftChanged();
            }}
            placeholder="Ex.: Criar endpoint de relatórios"
            maxLength={LIMITS.titleMax}
            aria-invalid={!!fieldErrors.title}
            aria-describedby={describedBy("title")}
          />
          {fieldError("title")}
        </div>
        <div>
          <label htmlFor="task-desc" className="mb-1 block text-sm font-medium text-neutral-200">
            Descrição
          </label>
          <textarea
            id="task-desc"
            ref={descRef}
            data-testid="task-desc-input"
            className="field min-h-28 py-3"
            value={description}
            onChange={(e) => {
              setDescription(e.target.value);
              draftChanged();
            }}
            placeholder="O que deve ser feito, critérios de aceite e limites."
            maxLength={LIMITS.descriptionMax}
            aria-invalid={!!fieldErrors.description}
            aria-describedby={describedBy("description", "task-desc-count")}
          />
          <p id="task-desc-count" className="mt-1 text-xs text-neutral-400">
            {description.length} de {LIMITS.descriptionMax} caracteres
          </p>
          {fieldError("description")}
        </div>
        <div className="flex flex-wrap items-end gap-4">
          <div className="w-40">
            <label htmlFor="task-budget" className="mb-1 block text-sm font-medium text-neutral-200">
              Orçamento (USD)
            </label>
            <input
              id="task-budget"
              data-testid="task-budget-input"
              ref={budgetRef}
              type="number"
              step="0.01"
              min="0.01"
              max={LIMITS.budgetMax}
              className="field"
              value={budget}
              onChange={(e) => {
                setBudget(e.target.value);
                draftChanged();
              }}
              aria-invalid={!!fieldErrors.budget}
              aria-describedby={describedBy("budget")}
            />
            {fieldError("budget")}
          </div>
          <label htmlFor="task-approval" className="flex min-h-12 cursor-pointer items-center gap-3 text-sm text-neutral-200">
            <input
              id="task-approval"
              data-testid="task-approval-checkbox"
              type="checkbox"
              className="size-6 accent-brand"
              checked={approval}
              onChange={(e) => {
                setApproval(e.target.checked);
                draftChanged();
              }}
            />
            Exigir aprovação humana
          </label>
        </div>
        {Object.keys(fieldErrors).length > 0 && (
          <p role="alert" data-testid="task-form-error" className="text-sm text-bad">
            Revise os campos destacados.
          </p>
        )}
        {serverError && (
          <p role="alert" data-testid="task-form-server-error" className="text-sm text-bad">
            Não foi possível criar a tarefa: {serverError} O que você digitou foi mantido.
          </p>
        )}
        <button type="submit" data-testid="task-submit" className="btn btn-light w-full" disabled={busy} aria-busy={busy}>
          {busy ? <Loader2 className="size-5 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Send className="size-5" aria-hidden="true" />}
          {busy ? "Enviando..." : "Criar tarefa"}
        </button>
      </form>
    </section>
  );
});
