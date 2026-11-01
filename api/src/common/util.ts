import { createHash, randomUUID } from 'node:crypto';
import { DomainError } from './errors';

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

/** Waits `ms`; rejects with the abort reason as soon as `signal` aborts. */
export const sleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason);
  const onAbort = () => { clearTimeout(timer); reject(signal!.reason); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
  signal?.addEventListener('abort', onAbort, { once: true });
});

export class TimeoutError extends DomainError {
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

/**
 * Runs `fn` with a signal that aborts after `ms` (or when `parent` aborts). Unlike
 * withTimeout the work is told to stop: `fn` must pass the signal down. The caller
 * still gets the rejection on time if `fn` ignores it.
 */
export async function withDeadline<T>(
  fn: (signal: AbortSignal) => Promise<T>, ms: number, label: string, parent?: AbortSignal,
): Promise<T> {
  const own = new AbortController();
  const signal = parent ? AbortSignal.any([parent, own.signal]) : own.signal;
  const timer = setTimeout(() => own.abort(new TimeoutError(label, ms)), ms);
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  aborted.catch(() => undefined);
  try {
    return await Promise.race([fn(signal), aborted]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

export const envNumber = (name: string, fallback: number): number => {
  const raw = process.env[name];
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

export const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;
