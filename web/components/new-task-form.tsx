"use client";

import { forwardRef, useState } from "react";
import { Loader2, Send } from "lucide-react";
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
  const [localError, setLocalError] = useState<string | null>(null);
  const busy = !!d.pending.create;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const budgetUsd = Number(budget);
    if (title.trim().length < 3) return setLocalError("Informe um título com pelo menos 3 caracteres.");
    if (!description.trim()) return setLocalError("Descreva o que os subagentes devem fazer.");
    if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) return setLocalError("O orçamento deve ser maior que zero.");
    setLocalError(null);
    await d.createTask({ title: title.trim(), description: description.trim(), budgetUsd, requiresApproval: approval });
    setTitle("");
    setDescription("");
  }

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
              setLocalError(null);
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
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Ex.: Criar endpoint de relatórios"
            maxLength={140}
          />
        </div>
        <div>
          <label htmlFor="task-desc" className="mb-1 block text-sm font-medium text-neutral-200">
            Descrição
          </label>
          <textarea
            id="task-desc"
            data-testid="task-desc-input"
            className="field min-h-28 py-3"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="O que deve ser feito, critérios de aceite e limites."
          />
        </div>
        <div className="flex flex-wrap items-end gap-4">
          <div className="w-40">
            <label htmlFor="task-budget" className="mb-1 block text-sm font-medium text-neutral-200">
              Orçamento (USD)
            </label>
            <input
              id="task-budget"
              data-testid="task-budget-input"
              type="number"
              step="0.01"
              min="0.01"
              className="field"
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
            />
          </div>
          <label htmlFor="task-approval" className="flex min-h-12 cursor-pointer items-center gap-3 text-sm text-neutral-200">
            <input
              id="task-approval"
              data-testid="task-approval-checkbox"
              type="checkbox"
              className="size-6 accent-brand"
              checked={approval}
              onChange={(e) => setApproval(e.target.checked)}
            />
            Exigir aprovação humana
          </label>
        </div>
        {localError && (
          <p role="alert" data-testid="task-form-error" className="text-sm text-bad">
            {localError}
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
