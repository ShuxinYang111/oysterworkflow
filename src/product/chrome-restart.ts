import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir, platform as currentPlatform } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CHROME_APPLICATION_PATH = "/Applications/Google Chrome.app";
const CHROME_START_POLL_MS = 500;
const CHROME_START_POLL_ATTEMPTS = 20;
const CHROME_STOP_POLL_ATTEMPTS = 30;
const CHROME_WINDOW_SETTLE_MS = 2_000;
let activeChromeRestart: Promise<boolean> | null = null;

export interface ChromeDevToolsState {
  port: number;
  browserPath: string;
}

export interface ChromeRestartDependencies {
  platform: NodeJS.Platform;
  listChromeProcessIds: () => Promise<number[]>;
  terminateChromeProcesses: (processIds: number[]) => Promise<void>;
  launchChrome: () => Promise<void>;
  readDevToolsState: () => Promise<ChromeDevToolsState | null>;
  delay: (milliseconds: number) => Promise<void>;
}

/**
 * EN: Fully restarts Chrome after the user-approved debug setting was activated without relaunching the existing process.
 * 中文: 当用户批准调试设置但现有 Chrome 进程没有真正重启时，完整重启 Chrome。
 * @param dependencyOverrides injectable system operations used by focused tests.
 * @returns true only when a new Chrome DevTools browser endpoint is observed.
 */
export async function restartChromeAfterDebugPermission(
  dependencyOverrides: Partial<ChromeRestartDependencies> = {},
): Promise<boolean> {
  if (Object.keys(dependencyOverrides).length === 0) {
    if (activeChromeRestart) {
      return activeChromeRestart;
    }
    const operation = restartChromeAfterDebugPermissionInternal({}).finally(
      () => {
        if (activeChromeRestart === operation) {
          activeChromeRestart = null;
        }
      },
    );
    activeChromeRestart = operation;
    return operation;
  }
  return restartChromeAfterDebugPermissionInternal(dependencyOverrides);
}

async function restartChromeAfterDebugPermissionInternal(
  dependencyOverrides: Partial<ChromeRestartDependencies>,
): Promise<boolean> {
  const dependencies: ChromeRestartDependencies = {
    platform: currentPlatform(),
    listChromeProcessIds: readChromeProcessIds,
    terminateChromeProcesses,
    launchChrome,
    readDevToolsState: readChromeDevToolsState,
    delay,
    ...dependencyOverrides,
  };
  if (dependencies.platform !== "darwin") {
    return false;
  }

  const beforeRestart = await dependencies.readDevToolsState();
  if (!beforeRestart) {
    return false;
  }
  const beforeProcessIds = await dependencies.listChromeProcessIds();
  if (beforeProcessIds.length === 0) {
    return false;
  }

  try {
    await dependencies.terminateChromeProcesses(beforeProcessIds);
  } catch {
    return false;
  }

  let chromeStopped = false;
  for (let attempt = 0; attempt < CHROME_STOP_POLL_ATTEMPTS; attempt += 1) {
    await dependencies.delay(CHROME_START_POLL_MS);
    if ((await dependencies.listChromeProcessIds()).length === 0) {
      chromeStopped = true;
      break;
    }
  }
  if (!chromeStopped) {
    return false;
  }

  try {
    await dependencies.launchChrome();
  } catch {
    return false;
  }

  for (let attempt = 0; attempt < CHROME_START_POLL_ATTEMPTS; attempt += 1) {
    await dependencies.delay(CHROME_START_POLL_MS);
    const afterRestart = await dependencies.readDevToolsState();
    if (
      afterRestart &&
      afterRestart.browserPath !== beforeRestart.browserPath
    ) {
      await dependencies.delay(CHROME_WINDOW_SETTLE_MS);
      return true;
    }
  }
  return false;
}

async function launchChrome(): Promise<void> {
  await execFileAsync("/usr/bin/open", ["-a", CHROME_APPLICATION_PATH], {
    timeout: 15_000,
    maxBuffer: 256 * 1024,
  });
}

/**
 * EN: Finds only the main Google Chrome processes, excluding renderer and helper processes.
 * 中文: 仅查找 Google Chrome 主进程，排除 renderer 与 helper 进程。
 * @returns sorted main-process ids for the current user.
 */
export async function readChromeProcessIds(): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync(
      "/usr/bin/pgrep",
      ["-x", "Google Chrome"],
      {
        timeout: 5_000,
        maxBuffer: 64 * 1024,
      },
    );
    return stdout
      .split(/\s+/u)
      .map((value) => Number.parseInt(value, 10))
      .filter((value) => Number.isInteger(value) && value > 0)
      .sort((left, right) => left - right);
  } catch {
    return [];
  }
}

async function terminateChromeProcesses(processIds: number[]): Promise<void> {
  for (const processId of processIds) {
    try {
      process.kill(processId, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        throw error;
      }
    }
  }
}

/**
 * EN: Reads the user-approved Chrome DevTools endpoint published for the active browser process.
 * 中文: 读取当前 Chrome 进程发布的、已经用户批准的 DevTools 端点。
 * @returns active DevTools state, or null when debug mode is not active.
 */
export async function readChromeDevToolsState(): Promise<ChromeDevToolsState | null> {
  const activePortPath = join(
    homedir(),
    "Library",
    "Application Support",
    "Google",
    "Chrome",
    "DevToolsActivePort",
  );
  const contents = await readFile(activePortPath, "utf8").catch(() => "");
  const [portText, browserPath] = contents.trim().split(/\r?\n/u);
  const port = Number.parseInt(portText ?? "", 10);
  if (
    !Number.isInteger(port) ||
    port <= 0 ||
    !/^\/devtools\/browser\//u.test(browserPath ?? "")
  ) {
    return null;
  }
  return { port, browserPath };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds);
  });
}
