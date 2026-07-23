export const DEFAULT_UI_REQUEST_TIMEOUT_MS = 30_000;

export interface AsyncDeadlineOptions {
  timeoutMs?: number;
  timeoutMessage?: string;
  signal?: AbortSignal | null;
}

/**
 * EN: Runs one async operation with a renderer-owned deadline and abort signal.
 * 中文: 使用 renderer 自己管理的截止时间和取消信号执行异步操作。
 * @param operation operation receiving a signal that aborts when the deadline expires.
 * @param options deadline, error copy, and optional caller cancellation signal.
 * @returns operation result before the deadline.
 */
export async function withAsyncDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: AsyncDeadlineOptions = {},
): Promise<T> {
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
  const controller = new AbortController();
  const timeoutMessage =
    options.timeoutMessage ??
    "The request timed out. Check the local service and try again. / 请求超时，请检查本地服务后重试。";
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let rejectCancellation!: (reason: unknown) => void;

  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });

  const abortFromCaller = () => {
    const reason =
      options.signal?.reason ??
      new DOMException("The request was cancelled.", "AbortError");
    controller.abort(reason);
    rejectCancellation(reason);
  };
  if (options.signal?.aborted) {
    abortFromCaller();
  } else {
    options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  }

  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException(timeoutMessage, "TimeoutError"));
      reject(new Error(timeoutMessage));
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      operation(controller.signal),
      deadline,
      cancellation,
    ]);
  } catch (error) {
    if (timedOut) {
      throw new Error(timeoutMessage);
    }
    throw error;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
}

function normalizeTimeoutMs(value: number | undefined): number {
  if (!Number.isFinite(value) || (value ?? 0) <= 0) {
    return DEFAULT_UI_REQUEST_TIMEOUT_MS;
  }
  return Math.max(1, Math.floor(value!));
}
