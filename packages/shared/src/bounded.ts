/** Raised when a bounded call runs out of time. Its work may still have taken effect. */
export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

/**
 * Stops waiting for `work` once `timeoutMs` passes or `signal` aborts. This
 * ends the wait, not the work itself: a caller holding something the work may
 * still produce (a runtime, say) has to handle that late result.
 */
export function bounded<T>(
  work: Promise<T>,
  options: { timeoutMs?: number; signal?: AbortSignal; message: string },
): Promise<T> {
  const { timeoutMs, signal, message } = options;
  return new Promise<T>((resolve, reject) => {
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => reject(new TimeoutError(message)), timeoutMs);
    const onAbort = () => reject(signal?.reason);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    });
  });
}
