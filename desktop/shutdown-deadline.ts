export type ShutdownDeadlineResult =
  | { status: "completed" }
  | { status: "failed"; error: unknown }
  | { status: "timed-out" };

/**
 * EN: Waits for desktop cleanup without allowing a stuck Runtime to block an OS-requested restart indefinitely.
 * 中文: 等待桌面端清理，但不允许卡住的 Runtime 无限期阻塞系统发起的重启。
 * @param operation cleanup operation already in progress.
 * @param timeoutMs maximum time allowed for graceful cleanup.
 * @returns the cleanup outcome observed before the deadline.
 */
export async function waitForShutdownDeadline(
  operation: Promise<void>,
  timeoutMs: number,
): Promise<ShutdownDeadlineResult> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const settledOperation = operation.then<
    ShutdownDeadlineResult,
    ShutdownDeadlineResult
  >(
    () => ({ status: "completed" }),
    (error: unknown) => ({ status: "failed", error }),
  );
  const deadline = new Promise<ShutdownDeadlineResult>((resolveDeadline) => {
    timeoutHandle = setTimeout(
      () => resolveDeadline({ status: "timed-out" }),
      timeoutMs,
    );
  });

  const result = await Promise.race([settledOperation, deadline]);
  if (timeoutHandle) {
    clearTimeout(timeoutHandle);
  }
  return result;
}
