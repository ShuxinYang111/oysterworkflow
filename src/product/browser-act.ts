import { spawn } from "node:child_process";
import { access, appendFile, mkdir } from "node:fs/promises";
import { platform } from "node:os";
import { basename, join, resolve } from "node:path";
import { z } from "zod";
import { signalProcessGroup } from "../process/child-process.js";
import { readChromeDevToolsState } from "./chrome-restart.js";

const DEFAULT_BROWSER_ACT_COMMAND = "browser-act";
const BROWSER_ACT_COMMAND_ENV_NAME = "OYSTER_BROWSER_ACT_COMMAND";
const BROWSER_ACT_BROWSER_ID_ENV_NAME = "OYSTER_BROWSER_ACT_BROWSER_ID";
const OYSTER_BROWSER_LOG_DIR_ENV_NAME = "OYSTER_BROWSER_LOG_DIR";
const OYSTER_BROWSER_SESSION_ENV_NAME = "OYSTER_BROWSER_SESSION";
const OYSTER_WORKFLOW_RUN_ID_ENV_NAME = "OYSTER_WORKFLOW_RUN_ID";
const DEFAULT_COMMAND_TIMEOUT_MS = 90_000;
const COMMAND_TERMINATION_GRACE_MS = 300;
const COMMAND_FORCE_SETTLE_MS = 100;
const COMMAND_MAX_OUTPUT_BYTES = 1024 * 1024;
const BROWSER_LIST_RETRY_COUNT = 3;
const BROWSER_LIST_RETRY_DELAY_MS = 750;
const OYSTER_CHROME_DIRECT_BROWSER_NAME = "OysterWorkflow Chrome";
const OYSTER_CHROME_DIRECT_BROWSER_DESCRIPTION =
  "Use the signed-in local Chrome profile for OysterWorkflow browser tasks";
const BROWSER_ACT_MANAGED_INSTALL_TIMEOUT_MS = 600_000;
const chromeDirectSetupPromises = new Map<string, Promise<string>>();

const browserActionSchema = z.enum([
  "open",
  "navigate",
  "state",
  "click",
  "hover",
  "input",
  "select",
  "upload",
  "keys",
  "scroll",
  "wait",
  "eval",
  "screenshot",
  "get",
  "network-requests",
  "network-request",
  "close",
]);

const browserInputSchema = z
  .object({
    runId: z.string().min(1).optional(),
    session: z.string().min(1).optional(),
    browserId: z.string().min(1).optional(),
    url: z.string().min(1).optional(),
    index: z.union([z.string().min(1), z.number().int()]).optional(),
    text: z.string().optional(),
    option: z.string().optional(),
    filePath: z.string().min(1).optional(),
    keys: z.string().min(1).optional(),
    direction: z.enum(["up", "down"]).optional(),
    amount: z
      .union([z.string().min(1), z.number().int().positive()])
      .optional(),
    mode: z.string().min(1).optional(),
    timeoutMs: z.number().int().positive().optional(),
    selector: z.string().min(1).optional(),
    state: z.string().min(1).optional(),
    script: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
    full: z.boolean().optional(),
    contentType: z
      .enum(["title", "html", "markdown", "text", "value"])
      .optional(),
    requestId: z.union([z.string().min(1), z.number().int()]).optional(),
    filter: z.string().min(1).optional(),
    resourceType: z.string().min(1).optional(),
    method: z.string().min(1).optional(),
    status: z.string().min(1).optional(),
    clear: z.boolean().optional(),
    allowRestartChrome: z.boolean().optional(),
  })
  .passthrough();

export type OysterBrowserAction = z.infer<typeof browserActionSchema>;
export type OysterBrowserInput = z.infer<typeof browserInputSchema>;

export interface OysterBrowserCommandResult {
  ok: boolean;
  action: OysterBrowserAction;
  session: string | null;
  browserId: string | null;
  args: string[];
  stdout: string;
  stderr: string;
  exitCode: number | null;
  errorMessage: string | null;
  logPath: string | null;
  diagnosticMessage: string | null;
}

export interface OysterBrowserActionOptions {
  browserActCommand?: string;
  logDir?: string;
  signal?: AbortSignal;
}

export interface BrowserActCommandOptions {
  signal?: AbortSignal;
}

/**
 * EN: Installs the packaged BrowserAct managed runtime before a Worker needs it.
 * 中文: 在 Worker 使用浏览器前准备打包版 BrowserAct managed runtime。
 * @param commandPath configured BrowserAct launcher path.
 * @returns when the managed runtime is ready or the command is an unmanaged override.
 */
export async function ensureManagedBrowserActCommand(
  commandPath: string | null,
  options: BrowserActCommandOptions = {},
): Promise<void> {
  if (!isManagedBrowserActLauncher(commandPath) || !commandPath) {
    return;
  }
  const result = await runBrowserActCommand(
    commandPath,
    ["--oyster-managed-install"],
    {
      timeoutMs: BROWSER_ACT_MANAGED_INSTALL_TIMEOUT_MS,
      signal: options.signal,
    },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr.trim() ||
        `BrowserAct managed installation exited with code ${String(result.exitCode)}. / BrowserAct 托管安装退出码为 ${String(result.exitCode)}。`,
    );
  }
}

/**
 * EN: Reads a BrowserAct version through the same cancellable, bounded runner used by actions.
 * 中文: 通过与动作一致的可取消、有界 runner 读取 BrowserAct 版本。
 * @param commandPath configured BrowserAct launcher or executable.
 * @param options optional cancellation signal.
 * @returns parsed semantic version, or null when the executable is unavailable.
 */
export async function readBrowserActCommandVersion(
  commandPath: string | null,
  options: BrowserActCommandOptions = {},
): Promise<string | null> {
  const command = commandPath ?? DEFAULT_BROWSER_ACT_COMMAND;
  if (commandPath) {
    await access(commandPath).catch(() => {
      throw new Error(`Chrome helper is not installed: ${commandPath}`);
    });
  }
  try {
    const result = await runBrowserActCommand(
      command,
      [
        isManagedBrowserActLauncher(commandPath)
          ? "--oyster-managed-status"
          : "--version",
      ],
      { timeoutMs: 15_000, signal: options.signal },
    );
    if (result.exitCode !== 0) {
      return null;
    }
    return (
      `${result.stdout}\n${result.stderr}`.match(
        /\b(\d+\.\d+\.\d+(?:[-+][a-z0-9.]+)?)\b/iu,
      )?.[1] ?? null
    );
  } catch (error) {
    if (isAbortError(error) || options.signal?.aborted) {
      throw error;
    }
    return null;
  }
}

/**
 * EN: Detects OysterWorkflow's managed BrowserAct launcher without treating user overrides as installers.
 * 中文: 识别 OysterWorkflow 托管启动器，避免把用户自定义命令误当成安装器。
 * @param commandPath configured BrowserAct command path.
 * @returns whether the path is an OysterWorkflow managed launcher.
 */
export function isManagedBrowserActLauncher(
  commandPath: string | null,
): boolean {
  if (!commandPath) {
    return false;
  }
  return (
    basename(commandPath) === "oysterworkflow-browseract" ||
    commandPath.includes("/out/bundled/browseract/browser-act")
  );
}

interface BrowserActCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/**
 * EN: Executes one OysterWorkflow browser action through BrowserAct.
 * 中文: 通过 BrowserAct 执行一个 OysterWorkflow browser action。
 * @param action browser action name exposed to Hermes.
 * @param rawInput action payload parsed from JSON.
 * @returns structured command result for the wrapper CLI and logs.
 */
export async function runOysterBrowserAction(
  action: string,
  rawInput: unknown,
  options: OysterBrowserActionOptions = {},
): Promise<OysterBrowserCommandResult> {
  const parsedAction = browserActionSchema.parse(action);
  const input = browserInputSchema.parse(rawInput ?? {});
  const browserActCommand =
    options.browserActCommand?.trim() ||
    process.env[BROWSER_ACT_COMMAND_ENV_NAME]?.trim() ||
    DEFAULT_BROWSER_ACT_COMMAND;
  const session = resolveSessionName(input);
  const browserId =
    parsedAction === "open"
      ? await resolveChromeDirectBrowserId(
          browserActCommand,
          input,
          options.signal,
        )
      : (input.browserId ??
        process.env[BROWSER_ACT_BROWSER_ID_ENV_NAME] ??
        null);
  const args = buildBrowserActArgs(parsedAction, input, session, browserId);
  const commandResult = await runBrowserActCommand(browserActCommand, args, {
    timeoutMs: input.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
    signal: options.signal,
  });
  const diagnosticMessage = await diagnoseChromeDirectOpenFailure(
    parsedAction,
    browserId,
    commandResult,
  );
  const result: OysterBrowserCommandResult = {
    ok: commandResult.exitCode === 0,
    action: parsedAction,
    session,
    browserId,
    args,
    stdout: commandResult.stdout,
    stderr: commandResult.stderr,
    exitCode: commandResult.exitCode,
    errorMessage:
      commandResult.exitCode === 0
        ? null
        : [
            commandResult.stderr.trim() || commandResult.stdout.trim(),
            diagnosticMessage ? `Diagnostic: ${diagnosticMessage}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
    logPath: null,
    diagnosticMessage,
  };
  result.logPath = await writeOysterBrowserLog(result, options);
  return result;
}

async function diagnoseChromeDirectOpenFailure(
  action: OysterBrowserAction,
  browserId: string | null,
  result: BrowserActCommandResult,
): Promise<string | null> {
  if (action !== "open" || result.exitCode === 0) {
    return null;
  }
  if (
    browserId?.startsWith("direct_local_") !== true ||
    platform() !== "darwin"
  ) {
    return null;
  }
  if (
    /Browser window not found/iu.test(`${result.stderr}\n${result.stdout}`) &&
    Boolean(await readChromeDevToolsState())
  ) {
    return [
      "Chrome remote debugging is active, but the local browser connection could not bind a Chrome window.",
      "OysterWorkflow will fully restart Chrome once after first-time debug approval, then retry the same signed-in browser connection.",
    ].join(" ");
  }
  return [
    "BrowserAct chrome-direct could not attach to the user's default Chrome profile.",
    "Chrome 136+ hardens default-profile remote debugging; use BrowserAct after chrome-direct live attach works, or use a non-default automation profile / Chrome live-session connector.",
  ].join(" ");
}

function resolveSessionName(input: OysterBrowserInput): string | null {
  if (input.session) {
    return input.session;
  }
  if (input.runId) {
    return `oyster-${slugifySession(input.runId)}`;
  }
  const envSession = process.env[OYSTER_BROWSER_SESSION_ENV_NAME]?.trim();
  if (envSession) {
    return envSession;
  }
  const envRunId = process.env[OYSTER_WORKFLOW_RUN_ID_ENV_NAME]?.trim();
  if (envRunId) {
    return `oyster-${slugifySession(envRunId)}`;
  }
  return null;
}

async function resolveChromeDirectBrowserId(
  browserActCommand: string,
  input: OysterBrowserInput,
  signal?: AbortSignal,
): Promise<string> {
  const configured =
    input.browserId ?? process.env[BROWSER_ACT_BROWSER_ID_ENV_NAME];
  if (configured?.trim()) {
    return configured.trim();
  }
  const result = await listBrowserActBrowsersWithRetry(
    browserActCommand,
    signal,
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Unable to list BrowserAct browsers: ${
        result.stderr.trim() || result.stdout.trim()
      }`,
    );
  }
  const browserId = parseChromeDirectBrowserId(result.stdout);
  if (browserId) {
    return browserId;
  }

  return configureChromeDirectBrowser(browserActCommand, signal);
}

/**
 * EN: Creates the local Chrome connection once when BrowserAct has no chrome-direct profile.
 * 中文: 当 BrowserAct 尚无 chrome-direct 配置时，幂等创建本地 Chrome 连接。
 * @param browserActCommand BrowserAct launcher or executable path.
 * @returns the created or concurrently discovered chrome-direct browser id.
 */
async function configureChromeDirectBrowser(
  browserActCommand: string,
  signal?: AbortSignal,
): Promise<string> {
  const existingSetup = chromeDirectSetupPromises.get(browserActCommand);
  if (existingSetup) {
    return awaitWithAbort(existingSetup, signal);
  }

  const setup = createChromeDirectBrowser(browserActCommand, signal).finally(
    () => {
      chromeDirectSetupPromises.delete(browserActCommand);
    },
  );
  chromeDirectSetupPromises.set(browserActCommand, setup);
  return awaitWithAbort(setup, signal);
}

async function createChromeDirectBrowser(
  browserActCommand: string,
  signal?: AbortSignal,
): Promise<string> {
  const result = await runBrowserActCommand(
    browserActCommand,
    [
      "browser",
      "create",
      "--type",
      "chrome-direct",
      "--name",
      OYSTER_CHROME_DIRECT_BROWSER_NAME,
      "--desc",
      OYSTER_CHROME_DIRECT_BROWSER_DESCRIPTION,
    ],
    { timeoutMs: 30_000, signal },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Chrome setup could not be created automatically: ${
        result.stderr.trim() || result.stdout.trim() || "unknown error"
      }`,
    );
  }

  const createdBrowserId = parseChromeDirectBrowserId(result.stdout);
  if (createdBrowserId) {
    return createdBrowserId;
  }

  const refreshed = await listBrowserActBrowsersWithRetry(
    browserActCommand,
    signal,
  );
  const refreshedBrowserId = parseChromeDirectBrowserId(refreshed.stdout);
  if (refreshed.exitCode !== 0 || !refreshedBrowserId) {
    throw new Error(
      "Chrome setup completed, but the local Chrome connection could not be found. Try Set up & check again.",
    );
  }
  return refreshedBrowserId;
}

async function listBrowserActBrowsersWithRetry(
  browserActCommand: string,
  signal?: AbortSignal,
): Promise<BrowserActCommandResult> {
  let lastResult: BrowserActCommandResult | null = null;
  for (let attempt = 1; attempt <= BROWSER_LIST_RETRY_COUNT; attempt += 1) {
    lastResult = await runBrowserActCommand(
      browserActCommand,
      ["browser", "list"],
      {
        timeoutMs: 20_000,
        signal,
      },
    );
    if (
      lastResult.exitCode === 0 &&
      parseChromeDirectBrowserId(lastResult.stdout)
    ) {
      return lastResult;
    }
    if (attempt < BROWSER_LIST_RETRY_COUNT) {
      await delay(BROWSER_LIST_RETRY_DELAY_MS, signal);
    }
  }
  return (
    lastResult ?? {
      stdout: "",
      stderr: "BrowserAct browser list did not run.",
      exitCode: 1,
    }
  );
}

function parseChromeDirectBrowserId(output: string): string | null {
  for (const line of output.split(/\r?\n/u)) {
    if (!/\btype=chrome-direct\b/u.test(line)) {
      continue;
    }
    const id = line.match(/\bid=([^\s]+)/u)?.[1]?.trim();
    if (id) {
      return id;
    }
  }
  return null;
}

function buildBrowserActArgs(
  action: OysterBrowserAction,
  input: OysterBrowserInput,
  session: string | null,
  browserId: string | null,
): string[] {
  if (action === "close") {
    return ["session", "close", requireSession(session, action)];
  }
  const args = ["--session", requireSession(session, action)];
  switch (action) {
    case "open":
      return withOpenRecoveryArgs(
        [
          ...args,
          "browser",
          "open",
          requireBrowserId(browserId),
          requireString(input.url, "url", action),
        ],
        input,
      );
    case "navigate":
      return [...args, "navigate", requireString(input.url, "url", action)];
    case "state":
      return [...args, "state"];
    case "click":
      return [...args, "click", requireIndex(input.index, action)];
    case "hover":
      return [...args, "hover", requireIndex(input.index, action)];
    case "input":
      return [
        ...args,
        "input",
        requireIndex(input.index, action),
        requireDefinedString(input.text, "text", action),
      ];
    case "select":
      return [
        ...args,
        "select",
        requireIndex(input.index, action),
        requireString(input.option, "option", action),
      ];
    case "upload":
      return [
        ...args,
        "upload",
        requireIndex(input.index, action),
        resolve(requireString(input.filePath, "filePath", action)),
      ];
    case "keys":
      return [...args, "keys", requireString(input.keys, "keys", action)];
    case "scroll":
      return buildScrollArgs(args, input);
    case "wait":
      return buildWaitArgs(args, input);
    case "eval":
      return [...args, "eval", requireString(input.script, "script", action)];
    case "screenshot":
      return buildScreenshotArgs(args, input);
    case "get":
      return buildGetArgs(args, input);
    case "network-requests":
      return buildNetworkRequestsArgs(args, input);
    case "network-request":
      return [
        ...args,
        "network",
        "request",
        requireRequestId(input.requestId, action),
      ];
  }
}

function withOpenRecoveryArgs(
  args: string[],
  input: OysterBrowserInput,
): string[] {
  if (input.allowRestartChrome === false) {
    return args;
  }
  return [...args, "--allow-restart-chrome"];
}

function buildScrollArgs(
  baseArgs: string[],
  input: OysterBrowserInput,
): string[] {
  const args = [...baseArgs, "scroll", input.direction ?? "down"];
  if (input.amount !== undefined) {
    args.push("--amount", String(input.amount));
  }
  return args;
}

function buildWaitArgs(
  baseArgs: string[],
  input: OysterBrowserInput,
): string[] {
  if (!input.mode || input.mode === "stable") {
    const args = [...baseArgs, "wait", "stable"];
    if (input.timeoutMs) {
      args.push("--timeout", String(input.timeoutMs));
    }
    return args;
  }
  if (input.mode === "selector") {
    const args = [...baseArgs, "wait"];
    if (input.index !== undefined) {
      args.push("selector", requireIndex(input.index, "wait"));
    } else {
      args.push(
        "--selector",
        requireString(input.selector, "selector", "wait"),
      );
    }
    if (input.state) {
      args.push("--state", input.state);
    }
    if (input.timeoutMs) {
      args.push("--timeout", String(input.timeoutMs));
    }
    return args;
  }
  throw new Error(`Unsupported wait mode: ${input.mode}`);
}

function buildScreenshotArgs(
  baseArgs: string[],
  input: OysterBrowserInput,
): string[] {
  const args = [...baseArgs, "screenshot"];
  if (input.full) {
    args.push("--full");
  }
  if (input.path) {
    args.push(resolve(input.path));
  }
  return args;
}

function buildGetArgs(baseArgs: string[], input: OysterBrowserInput): string[] {
  const contentType = input.contentType ?? "markdown";
  const args = [...baseArgs, "get", contentType];
  if (
    (contentType === "text" || contentType === "value") &&
    input.index !== undefined
  ) {
    args.push(requireIndex(input.index, "get"));
  }
  return args;
}

function buildNetworkRequestsArgs(
  baseArgs: string[],
  input: OysterBrowserInput,
): string[] {
  const args = [...baseArgs, "network", "requests"];
  if (input.filter) {
    args.push("--filter", input.filter);
  }
  if (input.resourceType) {
    args.push("--type", input.resourceType);
  }
  if (input.method) {
    args.push("--method", input.method);
  }
  if (input.status) {
    args.push("--status", input.status);
  }
  if (input.clear) {
    args.push("--clear");
  }
  return args;
}

function requireSession(
  session: string | null,
  action: OysterBrowserAction,
): string {
  if (!session) {
    throw new Error(`oyster-browser ${action} requires "session" or "runId".`);
  }
  return session;
}

function requireBrowserId(browserId: string | null): string {
  if (!browserId) {
    throw new Error("oyster-browser open requires a BrowserAct browser id.");
  }
  return browserId;
}

function requireString(
  value: string | undefined,
  field: string,
  action: OysterBrowserAction,
): string {
  if (!value?.trim()) {
    throw new Error(`oyster-browser ${action} requires "${field}".`);
  }
  return value;
}

function requireDefinedString(
  value: string | undefined,
  field: string,
  action: OysterBrowserAction,
): string {
  if (typeof value !== "string") {
    throw new Error(`oyster-browser ${action} requires "${field}".`);
  }
  return value;
}

function requireIndex(
  value: string | number | undefined,
  action: OysterBrowserAction | "wait" | "get",
): string {
  if (value === undefined) {
    throw new Error(`oyster-browser ${action} requires "index".`);
  }
  return String(value);
}

function requireRequestId(
  value: string | number | undefined,
  action: OysterBrowserAction,
): string {
  if (value === undefined) {
    throw new Error(`oyster-browser ${action} requires "requestId".`);
  }
  return String(value);
}

function runBrowserActCommand(
  command: string,
  args: string[],
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<BrowserActCommandResult> {
  if (options.signal?.aborted) {
    return Promise.reject(browserActAbortError(options.signal));
  }

  return new Promise((resolveRun, rejectRun) => {
    const useProcessGroup = process.platform !== "win32";
    const child = spawn(command, args, {
      detached: useProcessGroup,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let abortFailure: Error | null = null;
    let settled = false;
    let terminationStarted = false;
    let forceKillTimer: NodeJS.Timeout | null = null;
    let forceSettleTimer: NodeJS.Timeout | null = null;

    const clearLifecycle = () => {
      clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (forceSettleTimer) clearTimeout(forceSettleTimer);
      options.signal?.removeEventListener("abort", abortCommand);
    };
    const timeoutDiagnostic = () =>
      `BrowserAct command timed out after ${options.timeoutMs}ms and was terminated.`;
    const resolveOnce = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearLifecycle();
      if (abortFailure) {
        rejectRun(abortFailure);
        return;
      }
      resolveRun({
        stdout,
        stderr: timedOut
          ? [stderr.trimEnd(), timeoutDiagnostic()].filter(Boolean).join("\n")
          : stderr,
        exitCode,
      });
    };
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      clearLifecycle();
      rejectRun(error);
    };
    const killChild = (signal: NodeJS.Signals) => {
      signalProcessGroup(child, signal, useProcessGroup);
    };
    const beginTermination = () => {
      if (settled || terminationStarted) return;
      terminationStarted = true;
      killChild("SIGTERM");
      forceKillTimer = setTimeout(() => {
        if (settled) return;
        killChild("SIGKILL");
        forceSettleTimer = setTimeout(() => {
          if (settled) return;
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
          resolveOnce(null);
        }, COMMAND_FORCE_SETTLE_MS);
        forceSettleTimer.unref?.();
      }, COMMAND_TERMINATION_GRACE_MS);
      forceKillTimer.unref?.();
    };
    const abortCommand = () => {
      if (settled || abortFailure) return;
      abortFailure = browserActAbortError(options.signal);
      beginTermination();
    };
    const terminateWithFailure = (error: Error) => {
      if (settled || abortFailure) return;
      abortFailure = error;
      beginTermination();
    };
    const timeoutTimer = setTimeout(() => {
      if (settled || abortFailure || timedOut) return;
      timedOut = true;
      beginTermination();
    }, options.timeoutMs);
    timeoutTimer.unref?.();
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendBoundedOutput(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendBoundedOutput(stderr, chunk);
    });
    child.stdout.once("error", terminateWithFailure);
    child.stderr.once("error", terminateWithFailure);
    child.once("error", (error) => {
      rejectOnce(error);
    });
    child.once("close", (exitCode) => {
      resolveOnce(exitCode);
    });
    options.signal?.addEventListener("abort", abortCommand, { once: true });
    if (options.signal?.aborted) {
      abortCommand();
    }
  });
}

function appendBoundedOutput(current: string, chunk: Buffer): string {
  const next = `${current}${chunk.toString("utf8")}`;
  if (Buffer.byteLength(next, "utf8") <= COMMAND_MAX_OUTPUT_BYTES) {
    return next;
  }
  return Buffer.from(next, "utf8")
    .subarray(-COMMAND_MAX_OUTPUT_BYTES)
    .toString("utf8")
    .replace(/^\uFFFD/u, "");
}

function browserActAbortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) {
    return signal.reason;
  }
  const error = new Error(
    "BrowserAct command was cancelled. / BrowserAct 命令已取消。",
  );
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function awaitWithAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    throw browserActAbortError(signal);
  }
  let abortListener: (() => void) | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        abortListener = () => reject(browserActAbortError(signal));
        signal.addEventListener("abort", abortListener, { once: true });
      }),
    ]);
  } finally {
    if (abortListener) {
      signal.removeEventListener("abort", abortListener);
    }
  }
}

async function writeOysterBrowserLog(
  result: OysterBrowserCommandResult,
  options: OysterBrowserActionOptions,
): Promise<string | null> {
  const logDir =
    options.logDir?.trim() ??
    process.env[OYSTER_BROWSER_LOG_DIR_ENV_NAME]?.trim();
  if (!logDir) {
    return null;
  }
  await mkdir(logDir, { recursive: true });
  const logPath = join(logDir, "oyster-browser.jsonl");
  await appendFile(
    logPath,
    `${JSON.stringify({
      createdAt: new Date().toISOString(),
      action: result.action,
      session: result.session,
      browserId: result.browserId,
      args: result.args,
      ok: result.ok,
      exitCode: result.exitCode,
      stdoutPreview: result.stdout.slice(0, 2_000),
      stderrPreview: result.stderr.slice(0, 2_000),
      errorMessage: result.errorMessage,
      diagnosticMessage: result.diagnosticMessage,
    })}\n`,
    "utf8",
  );
  return logPath;
}

function slugifySession(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48);
  return normalized || "run";
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(browserActAbortError(signal));
  }
  return new Promise((resolveDelay, rejectDelay) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abortDelay);
      resolveDelay();
    }, ms);
    const abortDelay = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortDelay);
      rejectDelay(browserActAbortError(signal));
    };
    signal?.addEventListener("abort", abortDelay, { once: true });
  });
}
