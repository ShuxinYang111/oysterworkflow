import type { ChildProcess } from "node:child_process";
import { terminateWindowsProcessTree } from "./windows-tree.js";

/**
 * EN: Signals a detached process group, with a bounded Windows tree-kill fallback.
 * 中文: 向分离进程组发送信号，并在 Windows 上回退到有界的进程树终止。
 * @param child spawned child process.
 * @param signal signal to deliver.
 * @param useProcessGroup whether the child owns a detached process group.
 * @returns whether a signal or asynchronous Windows termination was initiated.
 */
export function signalProcessGroup(
  child: Pick<ChildProcess, "pid" | "kill">,
  signal: NodeJS.Signals,
  useProcessGroup: boolean,
): boolean {
  if (process.platform === "win32" && child.pid && signal === "SIGKILL") {
    const killDirectChild = (): void => {
      try {
        child.kill("SIGKILL");
      } catch {
        // EN/CN: The child may exit while Windows process-tree termination settles.
      }
    };
    void terminateWindowsProcessTree(child.pid).then((terminated) => {
      if (!terminated) {
        killDirectChild();
      }
    }, killDirectChild);
    return true;
  }
  if (useProcessGroup && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch {
      // EN/CN: Fall back to the direct child when the process group has exited.
    }
  }
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}
