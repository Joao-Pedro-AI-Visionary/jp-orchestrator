import { createHash, randomUUID } from 'node:crypto';

export const newId = (): string => randomUUID();
export const nowIso = (): string => new Date().toISOString();
export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** Rough token estimate (about 4 chars per token). Good enough for budgets and limits. */
export const estimateTokens = (text: string): number => Math.max(1, Math.ceil(text.length / 4));

/** Deterministic JSON: object keys sorted recursively, so equal content gives equal hashes. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} excedeu o timeout de ${ms}ms`);
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export const envNumber = (name: string, fallback: number): number => {
  const raw = process.env[name];
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

export const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;
