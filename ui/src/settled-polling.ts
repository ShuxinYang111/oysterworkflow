import { useEffect, useRef } from "react";

export interface SettledPollContext {
  isCurrent: () => boolean;
}

export interface SettledPollingOptions {
  enabled: boolean;
  intervalMs: number;
  restartKey: string;
  runImmediately?: boolean;
  poll: (context: SettledPollContext) => Promise<void>;
}

export interface SettledPollingController {
  stop: () => void;
}

/**
 * EN: Starts an imperative non-overlapping poll loop and invalidates late work when stopped.
 * 中文: 启动命令式非重入轮询，并在停止后使迟到任务失效。
 * @param options cadence and async poll callback.
 * @returns controller used to stop future polls and invalidate the current one.
 */
export function startSettledPolling(
  options: Pick<
    SettledPollingOptions,
    "intervalMs" | "poll" | "runImmediately"
  >,
): SettledPollingController {
  let stopped = false;
  let timer: number | null = null;
  const isCurrent = () => !stopped;
  const run = async () => {
    try {
      await options.poll({ isCurrent });
    } catch {
      // EN/CN: Callers own user-facing errors; keep the scheduler recoverable.
    } finally {
      if (isCurrent()) {
        timer = window.setTimeout(() => void run(), options.intervalMs);
      }
    }
  };
  if (options.runImmediately === false) {
    timer = window.setTimeout(() => void run(), options.intervalMs);
  } else {
    void run();
  }
  return {
    stop: () => {
      stopped = true;
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    },
  };
}

/**
 * EN: Polls again only after the previous request settles and invalidates late generations.
 * 中文: 仅在上一轮请求结束后再次轮询，并使旧代次的迟到响应失效。
 * @param options enablement, cadence, restart identity, and poll callback.
 * @returns void.
 */
export function useSettledPolling(options: SettledPollingOptions): void {
  const pollRef = useRef(options.poll);
  pollRef.current = options.poll;
  const generationRef = useRef(0);

  useEffect(() => {
    generationRef.current += 1;
    const generation = generationRef.current;
    if (!options.enabled) {
      return;
    }

    const controller = startSettledPolling({
      intervalMs: options.intervalMs,
      runImmediately: options.runImmediately,
      poll: ({ isCurrent }) =>
        pollRef.current({
          isCurrent: () => isCurrent() && generationRef.current === generation,
        }),
    });

    return () => {
      generationRef.current += 1;
      controller.stop();
    };
  }, [
    options.enabled,
    options.intervalMs,
    options.restartKey,
    options.runImmediately,
  ]);
}
