import { AsyncLocalStorage } from 'node:async_hooks';

/** Correlation fields attached to every log line written inside the context. */
export interface LogContext { taskId?: string; requestId?: string; principal?: string }

const storage = new AsyncLocalStorage<LogContext>();

/** Runs fn with these fields merged into the current log context (async work started inside inherits it). */
export function withLogContext<T>(fields: LogContext, fn: () => T): T {
  return storage.run({ ...storage.getStore(), ...fields }, fn);
}

export const currentLogContext = (): LogContext => storage.getStore() ?? {};
