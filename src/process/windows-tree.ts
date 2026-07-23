import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_TASKKILL_TIMEOUT_MS = 2_000;
const TASKKILL_MAX_BUFFER_BYTES = 64 * 1024;

interface WindowsTaskkillOptions {
  timeout: number;
  killSignal: NodeJS.Signals;
  windowsHide: boolean;
  maxBuffer: number;
}

type WindowsTaskkillExecutor = (
  file: string,
  args: string[],
  options: WindowsTaskkillOptions,
) => Promise<unknown>;

interface WindowsProcessTreeDependencies {
  platform?: NodeJS.Platform;
  execFile?: WindowsTaskkillExecutor;
}

const defaultTaskkillExecutor: WindowsTaskkillExecutor = async (
  file,
  args,
  options,
) => {
  await execFileAsync(file, args, options);
};

/**
 * EN: Force-terminates a Windows process tree with a bounded taskkill call.
 * 中文: 通过有界 taskkill 调用强制终止 Windows 进程树。
 * @param pid root process identifier owned by the caller.
 * @param timeoutMs maximum time allowed for taskkill to settle.
 * @param dependencies injectable platform and executor used by unit tests.
 * @returns true when taskkill reports success; false for invalid, missing, or failed targets.
 */
export async function terminateWindowsProcessTree(
  pid: number,
  timeoutMs = DEFAULT_TASKKILL_TIMEOUT_MS,
  dependencies: WindowsProcessTreeDependencies = {},
): Promise<boolean> {
  const platform = dependencies.platform ?? process.platform;
  if (platform !== "win32" || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  const boundedTimeoutMs =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.trunc(timeoutMs)
      : DEFAULT_TASKKILL_TIMEOUT_MS;
  try {
    await (dependencies.execFile ?? defaultTaskkillExecutor)(
      "taskkill.exe",
      ["/PID", String(pid), "/T", "/F"],
      {
        timeout: boundedTimeoutMs,
        killSignal: "SIGKILL",
        windowsHide: true,
        maxBuffer: TASKKILL_MAX_BUFFER_BYTES,
      },
    );
    return true;
  } catch {
    return false;
  }
}
