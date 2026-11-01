/** Same limits the API enforces (api/src/orchestration/tasks.controller.ts). Keep both in sync. */
export const LIMITS = {
  titleMin: 3,
  titleMax: 200,
  descriptionMax: 4000,
  budgetMax: 100,
  noteMax: 1000,
} as const;

export type TaskField = "title" | "description" | "budget";

/** Field errors in form order; an empty object means the input is valid. */
export function validateTask(input: { title: string; description: string; budget: string }): Partial<Record<TaskField, string>> {
  const errors: Partial<Record<TaskField, string>> = {};
  const title = input.title.trim();
  if (title.length < LIMITS.titleMin || title.length > LIMITS.titleMax) {
    errors.title = `Informe um título entre ${LIMITS.titleMin} e ${LIMITS.titleMax} caracteres.`;
  }
  const description = input.description.trim();
  if (!description) errors.description = "Descreva o que os subagentes devem fazer.";
  else if (description.length > LIMITS.descriptionMax) errors.description = `A descrição pode ter até ${LIMITS.descriptionMax} caracteres.`;
  const budget = Number(input.budget.replace(",", "."));
  if (!Number.isFinite(budget) || budget <= 0 || budget > LIMITS.budgetMax) {
    errors.budget = `O orçamento deve ser maior que zero e até ${LIMITS.budgetMax} USD.`;
  }
  return errors;
}

/** Idempotency-Key for a draft. crypto.randomUUID only exists in secure contexts (HTTPS, localhost). */
export function newIdempotencyKey(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
