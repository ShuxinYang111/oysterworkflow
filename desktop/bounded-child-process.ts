import type { ChildProcess } from "node:child_process";
import { terminateWindowsProcessTree } from "../src/process/windows-tree.js";

export interface BoundedChildProcessExit {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export interface BoundedChildProcessOptions {
  timeoutMs: number;
  terminateGraceMs?: number;
  killGraceMs?: number;
  timeoutMessage: string;
  signal?: AbortSignal;
  abortMessage?: string;
  platform?: NodeJS.Platform;
  windowsTreeTerminator?: (pid: number, timeoutMs?: number) => Promise<boolean>;
}

const DEFAULT_TERMINATE_GRACE_MS = 2_000;
const DEFAULT_KILL_GRACE_MS = 1_000;

/**
 * EN: Waits for a child and escalates TERM to KILL with a final hard settlement.
 * 中文: 等待子进程退出，并按 TERM、KILL、强制收口的顺序有界升级。
 * @param child spawned child process whose pipes belong to the caller.
 * @param options timeout, grace windows, and user-facing timeout message.
 * @returns the child's close result when it exits before the deadline.
 */
export function waitForBoundedChildProcess(
  child: ChildProcess,
  options: BoundedChildProcessOptions,
): Promise<BoundedChildProcessExit> {
  return new Promise<BoundedChildProcessExit>((resolve, reject) => {
    let settled = false;
    let terminationError: Error | null = null;
    let terminateTimer: NodeJS.Timeout | null = null;
    let killTimer: NodeJS.Timeout | null = null;

    const timeoutError = () => new Error(options.timeoutMessage);
    const clearTimers = () => {
      clearTimeout(timeoutTimer);
      if (terminateTimer) clearTimeout(terminateTimer);
      if (killTimer) clearTimeout(killTimer);
    };
    const destroyPipes = () => {
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
    };
    const sendSignal = (signal: NodeJS.Signals) => {
      try {
        child.kill(signal);
      } catch {
        // EN/CN: A concurrent close is handled by the close event or hard deadline.
      }
    };
    const forceKill = async () => {
      if ((options.platform ?? process.platform) === "win32" && child.pid) {
        try {
          const terminated = await (
            options.windowsTreeTerminator ?? terminateWindowsProcessTree
          )(child.pid);
          if (terminated) {
            return;
          }
        } catch {
          // EN/CN: Fall through to the direct child kill as a last resort.
        }
      }
      sendSignal("SIGKILL");
    };
    const settle = (
      callback: () => void,
      { destroy = false }: { destroy?: boolean } = {},
    ) => {
      if (settled) return;
      settled = true;
      clearTimers();
      child.removeListener("close", handleClose);
      child.removeListener("error", handleError);
      options.signal?.removeEventListener("abort", handleAbort);
      if (destroy) destroyPipes();
      callback();
    };
    const handleClose = (
      exitCode: number | null,
      signal: NodeJS.Signals | null,
    ) => {
      settle(() => {
        if (terminationError) {
          reject(terminationError);
          return;
        }
        resolve({ exitCode, signal });
      });
    };
    const handleError = (error: Error) => {
      settle(() => reject(terminationError ?? error), {
        destroy: true,
      });
    };
    const beginTermination = (error: Error) => {
      if (settled || terminationError) return;
      terminationError = error;
      sendSignal("SIGTERM");
      if (settled) return;
      terminateTimer = setTimeout(() => {
        if (settled) return;
        void forceKill().finally(() => {
          if (settled) return;
          killTimer = setTimeout(() => {
            settle(() => reject(terminationError ?? timeoutError()), {
              destroy: true,
            });
          }, options.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
        });
      }, options.terminateGraceMs ?? DEFAULT_TERMINATE_GRACE_MS);
    };
    const handleAbort = () => {
      beginTermination(
        new Error(
          options.abortMessage ??
            "The child process operation was cancelled. / 子进程操作已取消。",
        ),
      );
    };
    const timeoutTimer = setTimeout(() => {
      beginTermination(timeoutError());
    }, options.timeoutMs);

    child.once("close", handleClose);
    child.once("error", handleError);
    options.signal?.addEventListener("abort", handleAbort, { once: true });
    if (options.signal?.aborted) {
      queueMicrotask(handleAbort);
    }
  });
}
