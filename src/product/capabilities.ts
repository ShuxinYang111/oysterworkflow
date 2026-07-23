import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeConfig } from "../runtime/config.js";
import type {
  ProductCapabilityProvider,
  ProductCapabilityProviderId,
} from "./contracts.js";
import {
  createComposioCapabilityProviderSnapshot,
  createComposioProviderAdapter,
  type ComposioProviderAdapter,
} from "./composio.js";
import {
  ensureManagedBrowserActCommand,
  readBrowserActCommandVersion,
  runOysterBrowserAction,
  type OysterBrowserCommandResult,
} from "./browser-act.js";
import {
  readChromeDevToolsState,
  readChromeProcessIds,
  restartChromeAfterDebugPermission,
  type ChromeDevToolsState,
} from "./chrome-restart.js";

export const CHROME_CAPABILITY_PROVIDER_ID = "chrome";
export const BROWSER_ACT_CLI_VERSION = "1.0.6";
const CHROME_READINESS_URL = "https://example.com";
const CHROME_READINESS_TIMEOUT_MS = 45_000;
const CHROME_STATE_TIMEOUT_MS = 15_000;
const CHROME_CLEANUP_TIMEOUT_MS = 500;
const CHROME_VERIFY_DEADLINE_MS = 90_000;
const CAPABILITY_SHUTDOWN_DRAIN_TIMEOUT_MS = 1_500;

export interface BrowserCapability {
  open(input: BrowserCapabilityOpenInput): Promise<OysterBrowserCommandResult>;
  navigate(
    input: BrowserCapabilityNavigateInput,
  ): Promise<OysterBrowserCommandResult>;
  state(
    input: BrowserCapabilitySessionInput,
  ): Promise<OysterBrowserCommandResult>;
  click(
    input: BrowserCapabilityIndexedInput,
  ): Promise<OysterBrowserCommandResult>;
  hover(
    input: BrowserCapabilityIndexedInput,
  ): Promise<OysterBrowserCommandResult>;
  input(input: BrowserCapabilityTextInput): Promise<OysterBrowserCommandResult>;
  select(
    input: BrowserCapabilitySelectInput,
  ): Promise<OysterBrowserCommandResult>;
  upload(
    input: BrowserCapabilityUploadInput,
  ): Promise<OysterBrowserCommandResult>;
  keys(input: BrowserCapabilityKeysInput): Promise<OysterBrowserCommandResult>;
  scroll(
    input: BrowserCapabilityScrollInput,
  ): Promise<OysterBrowserCommandResult>;
  wait(input: BrowserCapabilityWaitInput): Promise<OysterBrowserCommandResult>;
  eval(input: BrowserCapabilityEvalInput): Promise<OysterBrowserCommandResult>;
  screenshot(
    input: BrowserCapabilityScreenshotInput,
  ): Promise<OysterBrowserCommandResult>;
  get(input: BrowserCapabilityGetInput): Promise<OysterBrowserCommandResult>;
  networkRequests(
    input: BrowserCapabilityNetworkRequestsInput,
  ): Promise<OysterBrowserCommandResult>;
  networkRequest(
    input: BrowserCapabilityNetworkRequestInput,
  ): Promise<OysterBrowserCommandResult>;
  close(
    input: BrowserCapabilitySessionInput,
  ): Promise<OysterBrowserCommandResult>;
}

export interface BrowserCapabilitySessionInput {
  session: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface BrowserCapabilityOpenInput extends BrowserCapabilitySessionInput {
  url: string;
  browserId?: string;
  allowRestartChrome?: boolean;
}

export interface BrowserCapabilityNavigateInput extends BrowserCapabilitySessionInput {
  url: string;
}

export interface BrowserCapabilityIndexedInput extends BrowserCapabilitySessionInput {
  index: string | number;
}

export interface BrowserCapabilityTextInput extends BrowserCapabilityIndexedInput {
  text: string;
}

export interface BrowserCapabilitySelectInput extends BrowserCapabilityIndexedInput {
  option: string;
}

export interface BrowserCapabilityUploadInput extends BrowserCapabilityIndexedInput {
  filePath: string;
}

export interface BrowserCapabilityKeysInput extends BrowserCapabilitySessionInput {
  keys: string;
}

export interface BrowserCapabilityScrollInput extends BrowserCapabilitySessionInput {
  direction?: "up" | "down";
  amount?: string | number;
}

export interface BrowserCapabilityWaitInput extends BrowserCapabilitySessionInput {
  mode?: "stable" | "selector";
  index?: string | number;
  selector?: string;
  state?: string;
}

export interface BrowserCapabilityEvalInput extends BrowserCapabilitySessionInput {
  script: string;
}

export interface BrowserCapabilityScreenshotInput extends BrowserCapabilitySessionInput {
  path?: string;
  full?: boolean;
}

export interface BrowserCapabilityGetInput extends BrowserCapabilitySessionInput {
  contentType?: "title" | "html" | "markdown" | "text" | "value";
  index?: string | number;
}

export interface BrowserCapabilityNetworkRequestsInput extends BrowserCapabilitySessionInput {
  filter?: string;
  resourceType?: string;
  method?: string;
  status?: string;
  clear?: boolean;
}

export interface BrowserCapabilityNetworkRequestInput extends BrowserCapabilitySessionInput {
  requestId: string | number;
}

export interface CapabilityProvider {
  id: ProductCapabilityProviderId;
  snapshot: (
    options?: CapabilityOperationOptions,
  ) => Promise<ProductCapabilityProvider>;
  prepare: (
    options?: CapabilityOperationOptions,
  ) => Promise<ProductCapabilityProvider>;
  check: (
    options?: CapabilityOperationOptions,
  ) => Promise<ProductCapabilityProvider>;
  shutdown?: () => Promise<void>;
}

export interface CapabilityOperationOptions {
  signal?: AbortSignal;
}

export interface CapabilityProviderRegistry {
  list: (
    options?: CapabilityOperationOptions,
  ) => Promise<ProductCapabilityProvider[]>;
  get: (id: ProductCapabilityProviderId) => CapabilityProvider | null;
  prepare: (
    id: ProductCapabilityProviderId,
    options?: CapabilityOperationOptions,
  ) => Promise<ProductCapabilityProvider>;
  check: (
    id: ProductCapabilityProviderId,
    options?: CapabilityOperationOptions,
  ) => Promise<ProductCapabilityProvider>;
  shutdown?: () => Promise<void>;
}

interface BrowserActBrowserProviderInput {
  commandPath: string | null;
  logDir: string;
}

export class BrowserActBrowserProvider implements BrowserCapability {
  constructor(private readonly providerInput: BrowserActBrowserProviderInput) {}

  open(input: BrowserCapabilityOpenInput) {
    return this.run("open", input);
  }

  navigate(input: BrowserCapabilityNavigateInput) {
    return this.run("navigate", input);
  }

  state(input: BrowserCapabilitySessionInput) {
    return this.run("state", input);
  }

  click(input: BrowserCapabilityIndexedInput) {
    return this.run("click", input);
  }

  hover(input: BrowserCapabilityIndexedInput) {
    return this.run("hover", input);
  }

  input(input: BrowserCapabilityTextInput) {
    return this.run("input", input);
  }

  select(input: BrowserCapabilitySelectInput) {
    return this.run("select", input);
  }

  upload(input: BrowserCapabilityUploadInput) {
    return this.run("upload", input);
  }

  keys(input: BrowserCapabilityKeysInput) {
    return this.run("keys", input);
  }

  scroll(input: BrowserCapabilityScrollInput) {
    return this.run("scroll", input);
  }

  wait(input: BrowserCapabilityWaitInput) {
    return this.run("wait", input);
  }

  eval(input: BrowserCapabilityEvalInput) {
    return this.run("eval", input);
  }

  screenshot(input: BrowserCapabilityScreenshotInput) {
    return this.run("screenshot", input);
  }

  get(input: BrowserCapabilityGetInput) {
    return this.run("get", input);
  }

  networkRequests(input: BrowserCapabilityNetworkRequestsInput) {
    return this.run("network-requests", input);
  }

  networkRequest(input: BrowserCapabilityNetworkRequestInput) {
    return this.run("network-request", input);
  }

  close(input: BrowserCapabilitySessionInput) {
    return this.run("close", input);
  }

  private run(action: string, input: unknown) {
    return runOysterBrowserAction(action, input, {
      browserActCommand: this.providerInput.commandPath ?? undefined,
      logDir: this.providerInput.logDir,
      signal: (input as BrowserCapabilitySessionInput | null)?.signal,
    });
  }
}

/**
 * EN: Creates the product capability registry for optional application providers.
 * 中文: 创建产品层可选应用能力 provider registry。
 * @param runtimeConfig runtime paths used to locate provider-owned sidecars.
 * @returns registry with the currently supported providers.
 */
export function createCapabilityProviderRegistry(
  runtimeConfig: RuntimeConfig,
  input: {
    composioAdapter?: ComposioProviderAdapter;
    restartChromeAfterDebugPermission?: () => Promise<boolean>;
    readChromeDevToolsState?: () => Promise<ChromeDevToolsState | null>;
    readChromeProcessIds?: () => Promise<number[]>;
    delayChromeRetry?: (milliseconds: number) => Promise<void>;
    canRestartChrome?: () => Promise<boolean>;
  } = {},
): CapabilityProviderRegistry {
  const shutdownController = new AbortController();
  const activeOperations = new Set<Promise<unknown>>();
  let shutdownPromise: Promise<void> | null = null;
  const composioAdapter =
    input.composioAdapter ?? createComposioProviderAdapter({ runtimeConfig });
  const providers: CapabilityProvider[] = [
    createChromeCapabilityProvider(runtimeConfig, {
      restartChrome:
        input.restartChromeAfterDebugPermission ??
        restartChromeAfterDebugPermission,
      readDevToolsState:
        input.readChromeDevToolsState ?? readChromeDevToolsState,
      readProcessIds: input.readChromeProcessIds ?? readChromeProcessIds,
      delay: input.delayChromeRetry ?? delayChromeRetry,
      canRestart: input.canRestartChrome ?? (async () => true),
    }),
    {
      id: "composio",
      snapshot: () => composioAdapter.snapshot(),
      prepare: () => composioAdapter.snapshot(),
      check: () => composioAdapter.check(),
      shutdown: async () => undefined,
    },
  ];
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  const runProviderOperation = <T>(
    operation: (options: CapabilityOperationOptions) => Promise<T>,
    options: CapabilityOperationOptions = {},
  ): Promise<T> => {
    if (shutdownController.signal.aborted) {
      return Promise.reject(capabilityShutdownError());
    }
    const scope = createAbortScope([shutdownController.signal, options.signal]);
    const tracked = Promise.resolve()
      .then(() => operation({ signal: scope.signal }))
      .finally(() => {
        scope.dispose();
        activeOperations.delete(tracked);
      });
    activeOperations.add(tracked);
    return tracked;
  };
  return {
    list: (options) =>
      runProviderOperation(
        (operationOptions) =>
          Promise.all(
            providers.map((provider) => provider.snapshot(operationOptions)),
          ),
        options,
      ),
    get: (id) => byId.get(id) ?? null,
    prepare: (id, options) => {
      const provider = byId.get(id);
      if (!provider) {
        return Promise.reject(new Error(`Unknown capability provider: ${id}`));
      }
      return runProviderOperation(
        (operationOptions) => provider.prepare(operationOptions),
        options,
      );
    },
    check: (id, options) => {
      const provider = byId.get(id);
      if (!provider) {
        return Promise.reject(new Error(`Unknown capability provider: ${id}`));
      }
      return runProviderOperation(
        (operationOptions) => provider.check(operationOptions),
        options,
      );
    },
    shutdown: () => {
      if (shutdownPromise) {
        return shutdownPromise;
      }
      shutdownController.abort(capabilityShutdownError());
      shutdownPromise = (async () => {
        await settleWithin(
          Promise.allSettled([
            ...providers.map((provider) => provider.shutdown?.()),
            ...activeOperations,
          ]),
          CAPABILITY_SHUTDOWN_DRAIN_TIMEOUT_MS,
        );
      })();
      return shutdownPromise;
    },
  };
}

/**
 * EN: Returns product-visible default capability rows without probing devices.
 * 中文: 返回不触发设备探测的默认能力状态。
 * @returns default provider state used for fresh or migrated product state.
 */
export function defaultCapabilityProviders(): ProductCapabilityProvider[] {
  return [
    chromeProviderSnapshot({
      status: "not_checked",
      installed: false,
      version: null,
      commandPath: null,
      lastCheckedAt: null,
      lastError: null,
      lastSuccessAt: null,
      detail:
        "Click Check to confirm Chrome can be controlled from this device.",
    }),
    createComposioCapabilityProviderSnapshot({
      configured: false,
      status: "not_checked",
      lastCheckedAt: null,
      lastError: null,
      lastSuccessAt: null,
    }),
  ];
}

function createChromeCapabilityProvider(
  runtimeConfig: RuntimeConfig,
  recovery: {
    restartChrome: () => Promise<boolean>;
    readDevToolsState: () => Promise<ChromeDevToolsState | null>;
    readProcessIds: () => Promise<number[]>;
    delay: (milliseconds: number) => Promise<void>;
    canRestart: () => Promise<boolean>;
  },
): CapabilityProvider {
  const sidecarRoot = join(
    runtimeConfig.hermesRuntimeRoot,
    "sidecars",
    "chrome",
  );
  const logDir = join(sidecarRoot, "logs");
  const commandPath =
    runtimeConfig.browserActCommandPath ??
    process.env.OYSTER_BROWSER_ACT_COMMAND?.trim() ??
    null;
  const browser = new BrowserActBrowserProvider({ commandPath, logDir });
  const shutdownController = new AbortController();
  const activeOperations = new Set<Promise<unknown>>();
  let shutdownPromise: Promise<void> | null = null;

  const runChromeOperation = <T>(
    operation: (signal: AbortSignal, timedOut: () => boolean) => Promise<T>,
    options: CapabilityOperationOptions = {},
    timeoutMs?: number,
  ): Promise<T> => {
    if (shutdownController.signal.aborted) {
      return Promise.reject(capabilityShutdownError());
    }
    const scope = createAbortScope(
      [shutdownController.signal, options.signal],
      timeoutMs,
      timeoutMs
        ? `Chrome capability check exceeded its ${timeoutMs}ms deadline. / Chrome 能力检查超过 ${timeoutMs}ms 总时限。`
        : undefined,
    );
    const tracked = Promise.resolve()
      .then(() => operation(scope.signal, scope.timedOut))
      .finally(() => {
        scope.dispose();
        activeOperations.delete(tracked);
      });
    activeOperations.add(tracked);
    return tracked;
  };

  const snapshot = async (
    signal: AbortSignal,
  ): Promise<ProductCapabilityProvider> => {
    throwIfAborted(signal);
    const version = await readBrowserActCommandVersion(commandPath, { signal });
    const installed = Boolean(version);
    return chromeProviderSnapshot({
      status: "not_checked",
      installed,
      version,
      commandPath,
      lastCheckedAt: null,
      lastError: null,
      lastSuccessAt: null,
      detail:
        "Click Check to confirm Chrome can be controlled from this device.",
    });
  };

  const prepare = async (
    signal: AbortSignal,
  ): Promise<ProductCapabilityProvider> => {
    throwIfAborted(signal);
    await mkdir(logDir, { recursive: true });
    await ensureManagedBrowserActCommand(commandPath, { signal });
    const version = await readBrowserActCommandVersion(commandPath, { signal });
    const installed = Boolean(version);
    return chromeProviderSnapshot({
      status: "not_checked",
      installed,
      version,
      commandPath,
      lastCheckedAt: null,
      lastError: installed
        ? null
        : "The managed browser automation sidecar could not be installed.",
      lastSuccessAt: null,
      detail: installed
        ? "Browser automation is installed. Test it from Applications when you are ready."
        : "Browser automation still needs attention.",
    });
  };

  const check = async (
    signal: AbortSignal,
    timedOut: () => boolean,
  ): Promise<ProductCapabilityProvider> => {
    const checkedAt = new Date().toISOString();
    await mkdir(logDir, { recursive: true });
    let version: string | null = null;
    let installed = false;
    try {
      throwIfAborted(signal);
      await ensureManagedBrowserActCommand(commandPath, { signal });
      version = await readBrowserActCommandVersion(commandPath, { signal });
      installed = Boolean(version);
      const sessionPrefix = `chrome-check-${Date.now()}`;
      const [devToolsBeforeOpen, processIdsBeforeOpen] = await Promise.all([
        recoverWithFallback(() => recovery.readDevToolsState(), signal, null),
        recoverWithFallback(() => recovery.readProcessIds(), signal, []),
      ]);
      let probe = await probeChromeReadiness({
        browser,
        session: `${sessionPrefix}-initial`,
        allowRestartChrome: devToolsBeforeOpen === null,
        signal,
      });
      let restartBlockedByActiveWork = false;
      if (!probe.ok && isChromeWindowBindingFailure(probe.failure)) {
        probe = await retryChromeWindowBinding({
          browser,
          sessionPrefix: `${sessionPrefix}-settle`,
          initialFailure: probe,
          delay: recovery.delay,
          signal,
        });
      }
      if (!probe.ok && isChromeWindowBindingFailure(probe.failure)) {
        const [devToolsAfterOpen, processIdsAfterOpen] = await Promise.all([
          recoverWithFallback(() => recovery.readDevToolsState(), signal, null),
          recoverWithFallback(() => recovery.readProcessIds(), signal, []),
        ]);
        const browserActDidNotRestartChrome = sameProcessIds(
          processIdsBeforeOpen,
          processIdsAfterOpen,
        );
        if (devToolsAfterOpen && browserActDidNotRestartChrome) {
          const canRestart = await recoverWithFallback(
            () => recovery.canRestart(),
            signal,
            false,
          );
          restartBlockedByActiveWork = !canRestart;
          throwIfAborted(signal);
          const restarted = canRestart
            ? await recoverWithFallback(
                () => recovery.restartChrome(),
                signal,
                false,
              )
            : false;
          if (restarted) {
            probe = await retryChromeWindowBinding({
              browser,
              sessionPrefix: `${sessionPrefix}-restarted`,
              initialFailure: probe,
              delay: recovery.delay,
              includeImmediateProbe: true,
              signal,
            });
          }
        }
      }
      if (!probe.ok) {
        return chromeProviderSnapshot({
          status: "unavailable",
          installed,
          version,
          commandPath,
          lastCheckedAt: checkedAt,
          lastError: probe.failure.errorMessage,
          lastSuccessAt: null,
          detail: restartBlockedByActiveWork
            ? "Chrome is currently in use by an active AI Worker. Stop the active run before reconnecting Chrome."
            : probe.phase === "state" &&
                !isChromeWindowBindingFailure(probe.failure)
              ? "Chrome opened, but the page state could not be read. Check again after Chrome finishes loading."
              : chromeOpenFailureDetail(probe.failure),
        });
      }
      return chromeProviderSnapshot({
        status: "ready",
        installed: true,
        version,
        commandPath,
        lastCheckedAt: checkedAt,
        lastError: null,
        lastSuccessAt: checkedAt,
        detail:
          "Chrome is ready for web workflows that need the signed-in browser.",
      });
    } catch (error) {
      if (signal.aborted && !timedOut()) {
        throw abortReason(signal);
      }
      return chromeProviderSnapshot({
        status: "unavailable",
        installed,
        version,
        commandPath,
        lastCheckedAt: checkedAt,
        lastError: error instanceof Error ? error.message : String(error),
        lastSuccessAt: null,
        detail:
          "Chrome could not be checked from this device. Make sure the Chrome helper is installed, then check again.",
      });
    }
  };

  return {
    id: CHROME_CAPABILITY_PROVIDER_ID,
    snapshot: (options) => runChromeOperation(snapshot, options),
    prepare: (options) => runChromeOperation(prepare, options),
    check: (options) =>
      runChromeOperation(check, options, CHROME_VERIFY_DEADLINE_MS),
    shutdown: () => {
      if (shutdownPromise) {
        return shutdownPromise;
      }
      shutdownController.abort(capabilityShutdownError());
      shutdownPromise = settleWithin(
        Promise.allSettled([...activeOperations]),
        CAPABILITY_SHUTDOWN_DRAIN_TIMEOUT_MS,
      ).then(() => undefined);
      return shutdownPromise;
    },
  };
}

/**
 * EN: Keeps the actionable Chrome status separate from raw connector diagnostics.
 * 中文: 将可操作的 Chrome 状态说明与底层连接诊断分开展示。
 * @param result failed managed browser open result.
 * @returns concise product-facing recovery guidance.
 */
function chromeOpenFailureDetail(result: OysterBrowserCommandResult): string {
  if (isChromeWindowBindingFailure(result)) {
    return "Chrome could not bind the signed-in browser window after waiting for startup. Keep Chrome open and reconnect.";
  }
  return "Chrome could not be reached. If Chrome asks to allow remote debugging, approve it and check again.";
}

function isChromeWindowBindingFailure(
  result: OysterBrowserCommandResult | null,
): boolean {
  return /Browser window not found/iu.test(result?.errorMessage ?? "");
}

interface ChromeReadinessProbeSuccess {
  ok: true;
  phase: null;
  failure: null;
}

interface ChromeReadinessProbeFailure {
  ok: false;
  phase: "open" | "state";
  failure: OysterBrowserCommandResult;
}

type ChromeReadinessProbe =
  ChromeReadinessProbeSuccess | ChromeReadinessProbeFailure;

async function probeChromeReadiness(input: {
  browser: BrowserCapability;
  session: string;
  allowRestartChrome: boolean;
  signal: AbortSignal;
}): Promise<ChromeReadinessProbe> {
  try {
    throwIfAborted(input.signal);
    const opened = await input.browser.open({
      session: input.session,
      url: CHROME_READINESS_URL,
      timeoutMs: CHROME_READINESS_TIMEOUT_MS,
      allowRestartChrome: input.allowRestartChrome,
      signal: input.signal,
    });
    if (!opened.ok) {
      return { ok: false, phase: "open", failure: opened };
    }
    const state = await input.browser.state({
      session: input.session,
      timeoutMs: CHROME_STATE_TIMEOUT_MS,
      signal: input.signal,
    });
    if (!state.ok) {
      return { ok: false, phase: "state", failure: state };
    }
    return { ok: true, phase: null, failure: null };
  } finally {
    const cleanupScope = createAbortScope(
      [],
      CHROME_CLEANUP_TIMEOUT_MS,
      "Chrome verification cleanup timed out. / Chrome 检查清理超时。",
    );
    try {
      await input.browser
        .close({
          session: input.session,
          timeoutMs: CHROME_CLEANUP_TIMEOUT_MS,
          signal: cleanupScope.signal,
        })
        .catch(() => undefined);
    } finally {
      cleanupScope.dispose();
    }
  }
}

async function retryChromeWindowBinding(input: {
  browser: BrowserCapability;
  sessionPrefix: string;
  initialFailure: ChromeReadinessProbeFailure;
  delay: (milliseconds: number) => Promise<void>;
  includeImmediateProbe?: boolean;
  signal: AbortSignal;
}): Promise<ChromeReadinessProbe> {
  let probe: ChromeReadinessProbe = input.initialFailure;
  const retryDelays = input.includeImmediateProbe
    ? [0, 750, 1_500]
    : [750, 1_500];
  for (const [index, retryDelay] of retryDelays.entries()) {
    throwIfAborted(input.signal);
    if (retryDelay > 0) {
      await awaitAbortable(input.delay(retryDelay), input.signal);
    }
    probe = await probeChromeReadiness({
      browser: input.browser,
      session: `${input.sessionPrefix}-${index + 1}`,
      allowRestartChrome: false,
      signal: input.signal,
    });
    if (probe.ok || !isChromeWindowBindingFailure(probe.failure)) {
      return probe;
    }
  }
  return probe;
}

function sameProcessIds(left: number[], right: number[]): boolean {
  return (
    left.length > 0 &&
    left.length === right.length &&
    left.every((processId, index) => processId === right[index])
  );
}

function delayChromeRetry(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds);
  });
}

function chromeProviderSnapshot(
  input: Pick<
    ProductCapabilityProvider,
    | "status"
    | "installed"
    | "version"
    | "commandPath"
    | "lastCheckedAt"
    | "lastError"
    | "lastSuccessAt"
    | "detail"
  >,
): ProductCapabilityProvider {
  return {
    id: CHROME_CAPABILITY_PROVIDER_ID,
    kind: "browser",
    label: "Chrome",
    description:
      "Use the signed-in local Chrome session for browser workflows.",
    enabled: true,
    required: false,
    pinnedVersion: BROWSER_ACT_CLI_VERSION,
    ...input,
  };
}

interface AbortScope {
  signal: AbortSignal;
  timedOut: () => boolean;
  dispose: () => void;
}

function createAbortScope(
  signals: Array<AbortSignal | undefined>,
  timeoutMs?: number,
  timeoutMessage?: string,
): AbortScope {
  const controller = new AbortController();
  const listeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
  let didTimeOut = false;
  let timeout: NodeJS.Timeout | null = null;

  for (const signal of signals) {
    if (!signal) {
      continue;
    }
    if (signal.aborted) {
      controller.abort(abortReason(signal));
      break;
    }
    const listener = () => controller.abort(abortReason(signal));
    signal.addEventListener("abort", listener, { once: true });
    listeners.push({ signal, listener });
  }

  if (!controller.signal.aborted && timeoutMs !== undefined) {
    timeout = setTimeout(() => {
      didTimeOut = true;
      const error = new Error(
        timeoutMessage ??
          `Capability operation timed out after ${timeoutMs}ms.`,
      );
      error.name = "TimeoutError";
      controller.abort(error);
    }, timeoutMs);
    timeout.unref?.();
  }

  return {
    signal: controller.signal,
    timedOut: () => didTimeOut,
    dispose: () => {
      if (timeout) {
        clearTimeout(timeout);
      }
      for (const entry of listeners) {
        entry.signal.removeEventListener("abort", entry.listener);
      }
    },
  };
}

function capabilityShutdownError(): Error {
  const error = new Error(
    "Capability provider is shutting down. / 能力提供器正在关闭。",
  );
  error.name = "AbortError";
  return error;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : capabilityShutdownError();
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw abortReason(signal);
  }
}

async function awaitAbortable<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  throwIfAborted(signal);
  let abortListener: (() => void) | null = null;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        abortListener = () => reject(abortReason(signal));
        signal.addEventListener("abort", abortListener, { once: true });
      }),
    ]);
  } finally {
    if (abortListener) {
      signal.removeEventListener("abort", abortListener);
    }
  }
}

async function recoverWithFallback<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
  fallback: T,
): Promise<T> {
  throwIfAborted(signal);
  try {
    return await awaitAbortable(operation(), signal);
  } catch {
    throwIfAborted(signal);
    return fallback;
  }
}

async function settleWithin(
  operation: Promise<unknown>,
  timeoutMs: number,
): Promise<void> {
  let timeout: NodeJS.Timeout | null = null;
  try {
    await Promise.race([
      operation.then(
        () => undefined,
        () => undefined,
      ),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
