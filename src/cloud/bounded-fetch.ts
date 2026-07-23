export interface DeadlineFetchOptions {
  timeoutMs: number;
  timeoutMessage: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

/**
 * EN: Wraps fetch with a hard deadline while preserving and merging the caller's AbortSignal.
 * 中文: 为 fetch 增加硬截止时间，同时保留并合并调用方的 AbortSignal。
 * @param options timeout, diagnostic copy, and optional fetch implementation for tests.
 * @returns fetch-compatible function that aborts the underlying network request.
 */
export function createDeadlineFetch(
  options: DeadlineFetchOptions,
): typeof fetch {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("Fetch deadline must be positive.");
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const controller = new AbortController();
    const callerSignal =
      init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const upstreamSignals = Array.from(
      new Set(
        [options.signal, callerSignal].filter((signal): signal is AbortSignal =>
          Boolean(signal),
        ),
      ),
    );
    const abortListeners = new Map<AbortSignal, () => void>();
    for (const signal of upstreamSignals) {
      const abortFromUpstream = () => {
        if (!controller.signal.aborted) {
          controller.abort(
            signal.reason ??
              new DOMException("The request was cancelled.", "AbortError"),
          );
        }
      };
      abortListeners.set(signal, abortFromUpstream);
      if (signal.aborted) {
        abortFromUpstream();
      } else {
        signal.addEventListener("abort", abortFromUpstream, { once: true });
      }
    }
    const timer = setTimeout(() => {
      if (!controller.signal.aborted) {
        const error = new Error(options.timeoutMessage);
        error.name = "TimeoutError";
        controller.abort(error);
      }
    }, Math.floor(options.timeoutMs));
    try {
      return await fetchImpl(input, {
        ...init,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
      for (const [signal, listener] of abortListeners) {
        signal.removeEventListener("abort", listener);
      }
    }
  };
}
