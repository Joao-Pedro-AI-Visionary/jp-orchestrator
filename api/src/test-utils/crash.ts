/** Thrown by a "dead" process. Nothing after it runs, as if the process was killed. */
export class ProcessCrash extends Error {
  constructor(at: string) {
    super(`processo morreu em ${at}`);
  }
}

/**
 * Wraps a store as seen by one process. The first call to `method` kills the
 * process: that call and every later one reject, so no cleanup or failure
 * bookkeeping reaches the store. The wrapped store (the database) survives and
 * a new process can be started on it.
 */
export function crashOn<T extends object>(target: T, method: keyof T & string): T {
  let dead = false;
  return new Proxy(target, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (dead || prop === method) {
          dead = true;
          return Promise.reject(new ProcessCrash(method));
        }
        return value.apply(obj, args);
      };
    },
  });
}
