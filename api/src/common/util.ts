import { createHash, randomUUID } from 'node:crypto';

export const newId = (): string => randomUUID();
export const nowIso = (): string => new Date().toISOString();
export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** UUID-shaped id derived from its parts (version nibble 5), so a re-run of a step gets the same ids. */
export const stableId = (...parts: (string | number)[]): string => {
  const h = sha256(parts.join(':'));
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

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

export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} excedeu o timeout de ${ms}ms`);
  }
}

/** The work was cancelled (task timeout, lease lost or caller gave up). */
export class AbortedError extends Error {
  constructor(reason = 'operação cancelada') {
    super(reason);
  }
}

/** The error an aborted signal carries: its reason when it is an Error, AbortedError otherwise. */
export const abortReason = (signal: AbortSignal): Error =>
  signal.reason instanceof Error ? signal.reason : new AbortedError(signal.reason === undefined ? undefined : String(signal.reason));

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

/** setTimeout as a promise; rejects with the abort reason as soon as the signal aborts. */
export const sleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(abortReason(signal));
  const onAbort = () => { clearTimeout(timer); reject(abortReason(signal!)); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
  signal?.addEventListener('abort', onAbort, { once: true });
});

/** Promise.race against a timer. Does not cancel anything: prefer runWithTimeout for work you own. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export interface RunOptions {
  /** Cancelling the parent cancels this run with the parent's reason. */
  parent?: AbortSignal;
  /** After cancelling, how long to wait for fn to stop before giving up on it (ABORT_GRACE_MS, 5s). */
  graceMs?: number;
}

/**
 * Runs fn with a deadline and real cancellation: on timeout (or parent abort) the
 * signal handed to fn aborts, and the returned promise rejects only after fn has
 * settled (bounded by graceMs). A retry started after the rejection therefore
 * does not overlap the cancelled run, unless fn ignores its signal past the grace.
 */
export async function runWithTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, ms: number, label: string, opts: RunOptions = {}): Promise<T> {
  throwIfAborted(opts.parent);
  const ac = new AbortController();
  const onParent = () => ac.abort(opts.parent!.reason);
  opts.parent?.addEventListener('abort', onParent, { once: true });
  const timer = setTimeout(() => ac.abort(new TimeoutError(label, ms)), ms);
  const work = Promise.resolve().then(() => fn(ac.signal));
  try {
    return await untilAborted(work, ac.signal);
  } catch (err) {
    if (!ac.signal.aborted) throw err;
    const grace = opts.graceMs ?? envNumber('ABORT_GRACE_MS', 5_000);
    if (grace > 0) await settleWithin(work, grace);
    throw abortReason(ac.signal);
  } finally {
    clearTimeout(timer);
    opts.parent?.removeEventListener('abort', onParent);
  }
}

/** The promise's outcome, or a rejection with the abort reason as soon as the signal aborts (the work is not awaited). */
export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  let onAbort: () => void = () => undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([promise, aborted]).finally(() => signal.removeEventListener('abort', onAbort));
}

/** Waits until the promise settles or ms elapse, whichever comes first. Never rejects. */
export async function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    promise.then(() => undefined, () => undefined),
    new Promise<void>((r) => { timer = setTimeout(r, ms); }),
  ]);
  clearTimeout(timer);
}

export const envNumber = (name: string, fallback: number): number => {
  const raw = process.env[name];
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

export const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;
