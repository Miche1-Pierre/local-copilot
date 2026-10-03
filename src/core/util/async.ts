export class CancelledError extends Error {
  constructor(message = 'Cancelled') {
    super(message);
    this.name = 'CancelledError';
  }
}

export function isCancellation(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'AbortError' || err.name === 'CancelledError' || (err as { code?: string }).code === 'ABORT_ERR';
}

/** Resolves after `ms`, rejects with CancelledError if `signal` aborts first. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CancelledError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CancelledError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** An AbortSignal that aborts as soon as any of the given signals aborts. */
export function anySignal(signals: (AbortSignal | undefined)[]): AbortSignal {
  const present = signals.filter((s): s is AbortSignal => !!s);
  if (present.length === 1) return present[0];
  const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (anyFn) return anyFn(present);
  const controller = new AbortController();
  for (const s of present) {
    if (s.aborted) {
      controller.abort(s.reason);
      break;
    }
    s.addEventListener('abort', () => controller.abort(s.reason), { once: true });
  }
  return controller.signal;
}

/** Runs `fn` at most once per `ms`, always delivering the latest call (trailing edge). */
export function throttle<A extends unknown[]>(fn: (...args: A) => void, ms: number): ((...args: A) => void) & { flush(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: A | undefined;
  let last = 0;
  const run = () => {
    timer = undefined;
    last = Date.now();
    const args = pending;
    pending = undefined;
    if (args) fn(...args);
  };
  const throttled = (...args: A) => {
    pending = args;
    if (timer) return;
    const wait = Math.max(0, ms - (Date.now() - last));
    timer = setTimeout(run, wait);
  };
  throttled.flush = () => {
    if (timer) clearTimeout(timer);
    run();
  };
  return throttled;
}

/** Trailing-edge debounce. */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): ((...args: A) => void) & { cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const debounced = (...args: A) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      fn(...args);
    }, ms);
  };
  debounced.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  return debounced;
}
