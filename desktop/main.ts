import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeImage,
  screen,
  shell,
} from "electron";
import {
  checkDesktopRecorderPermissions,
  requestDesktopMicrophoneAccess,
} from "./permissions.js";
import { createAuthCallbackQueue } from "./auth-callback-queue.js";
import { waitForBoundedChildProcess } from "./bounded-child-process.js";
import { BoundedOutputTail } from "./bounded-output-tail.js";
import {
  publishOysterWorkflowMcpConnection,
  removeOysterWorkflowMcpConnection,
} from "./mcp-connection.js";
import { assertTrustedIpcSender } from "./ipc-security.js";
import { requestLoopbackRuntime } from "./loopback-runtime-client.js";
import {
  buildDesktopRuntimeArgs,
  findFreePort,
  resolveDesktopRuntimePaths,
} from "./runtime-process.js";
import { createDesktopRelaunchCoordinator } from "./relaunch-coordinator.js";
import {
  normalizeRuntimeRequestMethod,
  normalizeRuntimeRequestPath,
  normalizeRuntimeRequestTimeout,
  RuntimeRequestAbortRegistry,
} from "./runtime-request-proxy.js";
import { waitForShutdownDeadline } from "./shutdown-deadline.js";
import {
  captureRuntimeError,
  initializeDesktopErrorMonitoring,
  sendSentryVerificationEvent,
} from "./sentry.js";
import { SupabaseDesktopAuthService } from "./supabase-auth.js";
import { createDesktopUpdateService } from "./app-update-service.js";
import { createElectronUpdaterDriver } from "./electron-updater-driver.js";
import type { RecorderPermissionKind } from "../src/lab-api/api-contracts.js";
import type {
  CloudIpcRequestOptions,
  CloudRuntimeRequestInput,
  CloudRuntimeRequestResponse,
  CloudSyncMode,
} from "../src/cloud/contracts.js";
import { copyJsonAtomic, readJsonWithBackup } from "../src/io/atomic-json.js";
import { terminateWindowsProcessTree } from "../src/process/windows-tree.js";
import {
  RUNTIME_API_SECRET_ENV_NAME,
  toRuntimeBridgeInfo,
} from "../src/runtime/config.js";

let runtimeProcess: ChildProcessWithoutNullStreams | null = null;
let runtimeServerHandle: { close: () => Promise<void> } | null = null;
let isQuitting = false;
let hasCompletedQuitCleanup = false;
let pendingQuitExitCode = 0;
let suppressRuntimeExitDialog = false;
let runtimeShutdownPromise: Promise<void> | null = null;
let mainWindow: BrowserWindow | null = null;
let mainWindowOperationQueue: Promise<void> = Promise.resolve();
let desktopWindowContext: DesktopWindowContext | null = null;
let runtimeReady = false;
let mcpConnectionPaths: string[] = [];
let authService: SupabaseDesktopAuthService | null = null;
const DESKTOP_RUNTIME_SHUTDOWN_TIMEOUT_MS = 8_000;
const DESKTOP_RUNTIME_REQUEST_TIMEOUT_MS = 90_000;
const DESKTOP_CLOUD_SYNC_TIMEOUT_MS = 120_000;
const desktopShutdownController = new AbortController();
const runtimeRequestAbortRegistry = new RuntimeRequestAbortRegistry();
const permissionRequests = new Map<RecorderPermissionKind, Promise<boolean>>();
let permissionRequestQueue: Promise<void> = Promise.resolve();
const STARTUP_LOG_PATH = resolve(resolveDesktopLogRoot(), "startup.log");
const sentryRuntimeConfig = initializeDesktopErrorMonitoring();
const relaunchCoordinator = createDesktopRelaunchCoordinator({
  isQuitting: () => isQuitting,
  requestQuit: () => app.quit(),
  relaunch: () => app.relaunch(),
});
const desktopUpdateService = createDesktopUpdateService({
  driver: createElectronUpdaterDriver(),
  currentVersion: app.getVersion(),
  isPackaged: app.isPackaged,
  platform: process.platform,
});
desktopUpdateService.subscribe((snapshot) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(
      "oysterworkflow:update-state-changed",
      snapshot,
    );
  }
});
const authCallbackQueue = createAuthCallbackQueue({
  handleCallback: async (rawUrl) => {
    await requireAuthService().handleOAuthCallback(rawUrl);
  },
  onCallbackHandled: async () => {
    if (desktopWindowContext && !isQuitting) {
      await createOrShowMainWindow("auth-callback");
    }
  },
  onCallbackError: (error) => {
    const message =
      error instanceof Error ? error.message : "Authentication failed.";
    logStartup("auth callback failed", message);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("oysterworkflow:auth-error", message);
    }
  },
});

interface DesktopWindowContext {
  apiBaseUrl: string;
  runtimeApiSecret: string;
  platform: string;
  mode: string;
  screenpipeBinaryPath: string;
  preloadPath: string;
  packagedUiEntryPath: string;
}

logStartup("desktop main module loaded");
logStartup("desktop error monitoring initialized", {
  enabled: sentryRuntimeConfig.enabled,
  environment: sentryRuntimeConfig.environment,
  release: sentryRuntimeConfig.release,
});
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  logStartup("single instance lock unavailable; quitting second instance");
  app.exit(0);
} else {
  app.on("second-instance", (_event, commandLine) => {
    const authCallbackUrl = commandLine.find((entry) =>
      entry.startsWith("oysterworkflow://auth/callback"),
    );
    if (authCallbackUrl) {
      queueAuthCallback(authCallbackUrl);
    }
    if (relaunchCoordinator.recoverSecondInstanceDuringQuit()) {
      logStartup(
        "second instance arrived during shutdown; queued relaunch after cleanup",
      );
      return;
    }
    if (!desktopWindowContext) {
      logStartup("second instance received before desktop window context");
      return;
    }
    void createOrShowMainWindow("second-instance").catch((error) => {
      logStartup(
        "failed to focus main window from second instance",
        error instanceof Error ? (error.stack ?? error.message) : String(error),
      );
    });
  });
}
app.on("open-url", (event, rawUrl) => {
  event.preventDefault();
  queueAuthCallback(rawUrl);
});
app.on("ready", () => {
  logStartup("Electron ready event emitted");
});
ipcMain.handle(
  "oysterworkflow:open-permission-settings",
  async (event, kind: RecorderPermissionKind) => {
    assertTrustedIpcSender(event, mainWindow);
    const targetUrl = resolvePermissionSettingsUrl(kind);
    logStartup("opening permission settings", {
      kind,
      targetUrl,
    });
    await shell.openExternal(targetUrl);
  },
);
ipcMain.handle(
  "oysterworkflow:open-external-url",
  async (event, rawUrl: string) => {
    assertTrustedIpcSender(event, mainWindow);
    const targetUrl = new URL(rawUrl);
    if (targetUrl.protocol !== "https:") {
      throw new Error("Only HTTPS external URLs are allowed.");
    }
    await shell.openExternal(targetUrl.toString());
  },
);
ipcMain.handle("oysterworkflow:update-get-state", (event) => {
  assertTrustedIpcSender(event, mainWindow);
  return desktopUpdateService.getSnapshot();
});
ipcMain.handle("oysterworkflow:update-check", async (event) => {
  assertTrustedIpcSender(event, mainWindow);
  return desktopUpdateService.checkForUpdates();
});
ipcMain.handle("oysterworkflow:update-download", async (event) => {
  assertTrustedIpcSender(event, mainWindow);
  return desktopUpdateService.downloadUpdate();
});
ipcMain.handle("oysterworkflow:update-install", (event) => {
  assertTrustedIpcSender(event, mainWindow);
  const snapshot = desktopUpdateService.beginInstall();
  setTimeout(() => {
    void installDownloadedDesktopUpdate();
  }, 0);
  return snapshot;
});
ipcMain.handle("oysterworkflow:auth-get-state", async (event) => {
  assertTrustedIpcSender(event, mainWindow);
  return requireAuthService().getState();
});
ipcMain.handle(
  "oysterworkflow:auth-sign-up",
  async (
    event,
    input: { email: string; password: string; displayName?: string },
  ) => {
    assertTrustedIpcSender(event, mainWindow);
    return requireAuthService().signUp(input);
  },
);
ipcMain.handle(
  "oysterworkflow:auth-sign-in",
  async (event, input: { email: string; password: string }) => {
    assertTrustedIpcSender(event, mainWindow);
    return requireAuthService().signIn(input);
  },
);
ipcMain.handle("oysterworkflow:auth-google", async (event) => {
  assertTrustedIpcSender(event, mainWindow);
  return requireAuthService().startGoogleSignIn();
});
ipcMain.handle("oysterworkflow:auth-sign-out", async (event) => {
  assertTrustedIpcSender(event, mainWindow);
  const response = await requireAuthService().signOut();
  await clearRuntimeCloudSession();
  return response;
});
ipcMain.on("oysterworkflow:cloud-cancel-request", (event, requestId) => {
  try {
    assertTrustedIpcSender(event, mainWindow);
    runtimeRequestAbortRegistry.cancel(requestId);
  } catch (error) {
    logStartup(
      "rejected cloud request cancellation",
      error instanceof Error ? error.message : String(error),
    );
  }
});
ipcMain.handle(
  "oysterworkflow:cloud-sync",
  async (
    event,
    mode: CloudSyncMode = "pull",
    options: CloudIpcRequestOptions,
  ) => {
    assertTrustedIpcSender(event, mainWindow);
    const requestLease = runtimeRequestAbortRegistry.acquire(
      options?.requestId,
      desktopShutdownController.signal,
    );
    try {
      const context = desktopWindowContext;
      if (!context || !runtimeReady) {
        throw new Error(
          "The local runtime is still starting. Try sync again shortly.",
        );
      }
      const auth = requireAuthService();
      const authState = auth.getStateSnapshot();
      const accessToken = auth.getAccessTokenSnapshot();
      if (authState.status !== "signed_in" || !authState.user || !accessToken) {
        throw new Error("Sign in before syncing this device.");
      }
      const response = await requestLoopbackRuntime({
        url: new URL("/api/product/cloud/sync", `${context.apiBaseUrl}/`),
        apiSecret: context.runtimeApiSecret,
        timeoutMs: normalizeRuntimeRequestTimeout(
          options?.timeoutMs,
          DESKTOP_CLOUD_SYNC_TIMEOUT_MS,
        ),
        signal: requestLease.signal,
        init: {
          method: "POST",
          headers: {
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            mode,
            authenticatedUser: {
              id: authState.user.id,
              email: authState.user.email,
              displayName: authState.user.displayName,
            },
          }),
        },
      });
      const body = parseRuntimeJsonBody(response.bodyText);
      if (!response.ok) {
        throw new Error(readRuntimeErrorMessage(body, response.status));
      }
      return body;
    } finally {
      requestLease.release();
    }
  },
);
ipcMain.handle(
  "oysterworkflow:cloud-runtime-request",
  async (
    event,
    input: CloudRuntimeRequestInput,
  ): Promise<CloudRuntimeRequestResponse> => {
    assertTrustedIpcSender(event, mainWindow);
    const requestLease = runtimeRequestAbortRegistry.acquire(
      input.requestId,
      desktopShutdownController.signal,
    );
    try {
      const context = desktopWindowContext;
      if (!context || !runtimeReady) {
        throw new Error(
          "The local runtime is still starting. Try again shortly.",
        );
      }
      const path = normalizeRuntimeRequestPath(input.path);
      const method = normalizeRuntimeRequestMethod(input.method);
      const accessToken = requireAuthService().getAccessTokenSnapshot();
      const response = await requestLoopbackRuntime({
        url: new URL(path, `${context.apiBaseUrl}/`),
        apiSecret: context.runtimeApiSecret,
        timeoutMs: normalizeRuntimeRequestTimeout(
          input.timeoutMs,
          DESKTOP_RUNTIME_REQUEST_TIMEOUT_MS,
        ),
        signal: requestLease.signal,
        init: {
          method,
          headers: {
            ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
            ...(input.body ? { "content-type": "application/json" } : {}),
          },
          ...(input.body ? { body: input.body } : {}),
        },
      });
      return {
        status: response.status,
        body: response.bodyText,
      };
    } finally {
      requestLease.release();
    }
  },
);
ipcMain.handle("oysterworkflow:check-recorder-permissions", async (event) => {
  assertTrustedIpcSender(event, mainWindow);
  const permissions = await checkDesktopRecorderPermissions();
  logStartup("checked desktop host permissions", {
    source: permissions.source,
    allGranted: permissions.allGranted,
    canStartRecording: permissions.canStartRecording,
    items: permissions.items.map((item) => ({
      kind: item.kind,
      state: item.state,
    })),
  });
  return permissions;
});
ipcMain.handle("oysterworkflow:request-microphone-access", async (event) => {
  assertTrustedIpcSender(event, mainWindow);
  const granted = await requestRecorderPermissionOnce(
    "microphone",
    requestDesktopMicrophoneAccess,
  );
  logStartup("requested desktop microphone access", { granted });
  return granted;
});
ipcMain.handle(
  "oysterworkflow:request-recorder-permission",
  async (event, kind: RecorderPermissionKind) => {
    assertTrustedIpcSender(event, mainWindow);
    const granted = await requestRecorderPermissionOnce(kind, () =>
      kind === "microphone"
        ? requestDesktopMicrophoneAccess()
        : requestBundledRecorderPermission(kind),
    );
    logStartup("requested desktop recorder permission", { kind, granted });
    return granted;
  },
);
ipcMain.handle("oysterworkflow:quit-and-reopen", (event) => {
  assertTrustedIpcSender(event, mainWindow);
  logStartup("quit and reopen requested by onboarding");
  relaunchCoordinator.requestRelaunch();
  return true;
});
app.on("activate", () => {
  if (isQuitting) {
    return;
  }
  if (!desktopWindowContext) {
    logStartup("deferred activate until desktop window context is ready");
    return;
  }
  void createOrShowMainWindow("activate").catch((error) => {
    logStartup(
      "failed to reopen main window on activate",
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
  });
});

/**
 * EN: Electron main-process entrypoint that prepares the Runtime, waits for health, and opens the desktop window.
 */
async function main(): Promise<void> {
  logStartup("waiting for Electron app readiness");
  await app.whenReady();
  void sendSentryVerificationEvent()
    .then((result) => {
      if (result) {
        logStartup("Sentry verification event completed", result);
      }
    })
    .catch((error) => {
      logStartup(
        "Sentry verification event failed",
        error instanceof Error ? error.message : String(error),
      );
    });
  logStartup("Electron app is ready", {
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    userDataPath: app.getPath("userData"),
    resourcesPath: process.resourcesPath,
  });
  if (process.platform === "darwin") {
    app.setActivationPolicy("regular");
    app.dock?.show();
    logStartup("set macOS activation policy", "regular");
  }
  applyDevelopmentDockIcon();
  registerAuthProtocol();

  const paths = resolveDesktopRuntimePaths({
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    userDataPath: app.getPath("userData"),
    isPackaged: app.isPackaged,
    platform: process.platform,
  });
  mcpConnectionPaths = [
    paths.mcpConnectionPath,
    paths.legacyCodexMcpConnectionPath,
  ];
  logStartup("resolved desktop runtime paths", paths);
  await removePublishedMcpConnections("startup-stale-cleanup");
  await ensureDesktopDefaults(paths);
  logStartup("ensured desktop defaults");

  const apiPort = await findFreePort();
  const runtimeApiSecret = randomBytes(32).toString("base64url");
  const bridgeInfo = toRuntimeBridgeInfo({
    mode: "desktop",
    apiSecret: runtimeApiSecret,
    productSeedMode: "empty",
    apiPort,
    screenpipeBaseUrl: "http://127.0.0.1:3030",
    screenpipeBinaryPath: paths.screenpipeBinaryPath,
    screenpipeWorkDir: dirname(paths.screenpipeBinaryPath),
    hermesCommandPath: paths.hermesCommandPath,
    browserActCommandPath: paths.browserActCommandPath,
    hermesRuntimeRoot: paths.hermesRuntimeRoot,
    hermesProfilesRoot: paths.hermesProfilesRoot,
    hermesSkillsRoot: paths.hermesSkillsRoot,
    screenpipeRecordingPort: 3030,
    screenpipeQueryPortStart: 3031,
    runsRoot: paths.runsRoot,
    llmConfigPath: paths.userLlmConfigPath,
    skillManagerConfigPath: paths.userSkillManagerConfigPath,
    codexEnvPath: paths.codexEnvPath,
    platform: process.platform,
    projectRootDir: app.getAppPath(),
  });
  logStartup("resolved runtime bridge info", bridgeInfo);
  desktopWindowContext = {
    apiBaseUrl: bridgeInfo.apiBaseUrl,
    runtimeApiSecret,
    platform: bridgeInfo.platform,
    mode: bridgeInfo.mode,
    screenpipeBinaryPath: paths.screenpipeBinaryPath,
    preloadPath: join(dirname(fileURLToPath(import.meta.url)), "preload.cjs"),
    packagedUiEntryPath: join(paths.appRootPath, "ui", "dist", "index.html"),
  };
  await createOrShowMainWindow("initial-launch");

  await startDesktopRuntime({
    apiPort,
    apiSecret: runtimeApiSecret,
    paths,
  });

  await waitForRuntimeHealth(bridgeInfo.apiBaseUrl, runtimeApiSecret);
  runtimeReady = true;
  logStartup("runtime health check passed", bridgeInfo.apiBaseUrl);
  await Promise.all(
    mcpConnectionPaths.map((filePath) =>
      publishOysterWorkflowMcpConnection({
        filePath,
        apiBaseUrl: bridgeInfo.apiBaseUrl,
        token: runtimeApiSecret,
        pid: process.pid,
        appVersion: app.getVersion(),
      }),
    ),
  );
  logStartup("published OysterWorkflow MCP runtime connections", {
    canonicalPath: paths.mcpConnectionPath,
    compatibilityPath: paths.legacyCodexMcpConnectionPath,
  });
  await createOrShowMainWindow("runtime-ready");
  setTimeout(() => {
    void initializeDesktopAuth();
    void desktopUpdateService.checkForUpdates().catch((error) => {
      logStartup(
        "background update check failed",
        error instanceof Error ? error.message : String(error),
      );
    });
  }, 0);
}

/**
 * EN: Stops the local Runtime before handing the signed update to electron-updater.
 * 中文: 在把已签名更新交给 electron-updater 前先停止本地 Runtime。
 * @returns when cleanup finishes and the updater has been asked to replace the app.
 */
async function installDownloadedDesktopUpdate(): Promise<void> {
  try {
    isQuitting = true;
    runtimeReady = false;
    desktopShutdownController.abort(
      new Error("OysterWorkflow desktop is installing an update."),
    );
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.hide();
      logStartup("hid main window while preparing update install");
    }
    const result = await waitForShutdownDeadline(
      shutdownRuntime("update-install"),
      DESKTOP_RUNTIME_SHUTDOWN_TIMEOUT_MS,
    );
    if (result.status === "timed-out") {
      logStartup("runtime shutdown deadline reached before update install", {
        timeoutMs: DESKTOP_RUNTIME_SHUTDOWN_TIMEOUT_MS,
      });
    } else if (result.status === "failed") {
      logStartup(
        "runtime shutdown failed before update install",
        result.error instanceof Error
          ? (result.error.stack ?? result.error.message)
          : String(result.error),
      );
    }
    hasCompletedQuitCleanup = true;
    logStartup("installing downloaded desktop update");
    desktopUpdateService.quitAndInstall();
  } catch (error) {
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    logStartup("failed to install downloaded desktop update", message);
    dialog.showErrorBox(
      "OysterWorkflow update failed / OysterWorkflow 更新失败",
      `${message}\n\nPlease download the latest version manually and try again. / 请手动下载最新版本后重试。`,
    );
    hasCompletedQuitCleanup = true;
    app.exit(1);
  }
}

/**
 * EN: Restores cloud authentication in the background so a Keychain prompt cannot block window creation.
 * 中文: 在后台恢复云端登录，避免 Keychain 提示阻塞窗口创建。
 * @returns when auth restoration and queued OAuth callbacks finish, or after the failure is reported.
 */
async function initializeDesktopAuth(): Promise<void> {
  const service = requireAuthService();
  try {
    await service.initialize();
    logStartup("desktop auth initialization completed");
  } catch (error) {
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    logStartup("desktop auth initialization failed", message);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("oysterworkflow:auth-error", message);
    }
  } finally {
    await authCallbackQueue.markReady();
    logStartup("desktop auth callback gate opened");
  }
}

/**
 * EN: Explicitly asks the bundled recorder sidecar to register one macOS permission.
 * 中文: 仅在用户点击后，由包内录制 sidecar 发起对应的 macOS 权限注册请求。
 * @param kind recorder permission selected by the user.
 * @returns whether the sidecar reports the permission as granted after the request.
 */
async function requestBundledRecorderPermission(
  kind: Exclude<RecorderPermissionKind, "microphone">,
): Promise<boolean> {
  if (process.platform !== "darwin") {
    return true;
  }
  const context = desktopWindowContext;
  if (!context) {
    throw new Error("The recorder is still starting. Try again shortly.");
  }

  const child = spawn(
    context.screenpipeBinaryPath,
    ["permissions", "--request", kind, "--json"],
    {
      cwd: dirname(context.screenpipeBinaryPath),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const stdoutTail = new BoundedOutputTail();
  const stderrTail = new BoundedOutputTail();
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutTail.append(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrTail.append(chunk);
  });
  const { exitCode } = await waitForBoundedChildProcess(child, {
    timeoutMs: 120_000,
    signal: desktopShutdownController.signal,
    abortMessage:
      "The permission request was cancelled because OysterWorkflow is closing. / OysterWorkflow 正在退出，权限请求已取消。",
    timeoutMessage:
      "The macOS permission request timed out. Open System Settings and try again. / macOS 权限请求超时，请打开系统设置后重试。",
  });
  const stdout = stdoutTail.text();
  const stderr = stderrTail.text();
  if (exitCode !== 0) {
    throw new Error(
      stderr.trim() ||
        `The recorder permission request exited with code ${String(exitCode)}.`,
    );
  }
  const payloadLine = stdout
    .trim()
    .split("\n")
    .reverse()
    .find((line) => line.trim().startsWith("{"));
  if (!payloadLine) {
    return false;
  }
  try {
    const payload = JSON.parse(payloadLine) as Record<string, string>;
    const responseKey =
      kind === "screen-recording"
        ? "screenRecording"
        : kind === "input-monitoring"
          ? "inputMonitoring"
          : "accessibility";
    return payload[responseKey] === "granted";
  } catch {
    return false;
  }
}

/**
 * EN: Deduplicates equal permission requests and serializes different macOS prompts.
 * 中文: 合并相同权限请求，并串行显示不同的 macOS 权限提示。
 * @param kind requested recorder permission.
 * @param operation explicit user-triggered permission operation.
 * @returns the shared result for this permission request.
 */
function requestRecorderPermissionOnce(
  kind: RecorderPermissionKind,
  operation: () => Promise<boolean>,
): Promise<boolean> {
  const existing = permissionRequests.get(kind);
  if (existing) {
    return existing;
  }

  const request = permissionRequestQueue.then(operation, operation);
  permissionRequests.set(kind, request);
  permissionRequestQueue = request.then(
    () => undefined,
    () => undefined,
  );
  const clearRequest = () => {
    if (permissionRequests.get(kind) === request) {
      permissionRequests.delete(kind);
    }
  };
  void request.then(clearRequest, clearRequest);
  return request;
}

function registerAuthProtocol(): void {
  const protocol = "oysterworkflow";
  const registered =
    process.defaultApp && process.argv[1]
      ? app.setAsDefaultProtocolClient(protocol, process.execPath, [
          resolve(process.argv[1]),
        ])
      : app.setAsDefaultProtocolClient(protocol);
  logStartup("registered auth callback protocol", { protocol, registered });
}

function queueAuthCallback(rawUrl: string): void {
  if (authCallbackQueue.enqueue(rawUrl)) {
    logStartup("queued auth callback");
  }
}

function requireAuthService(): SupabaseDesktopAuthService {
  if (!authService) {
    authService = new SupabaseDesktopAuthService({
      storagePath: join(
        app.getPath("userData"),
        "auth",
        "supabase-session.json",
      ),
      openExternal: async (url) => {
        const target = new URL(url);
        if (target.protocol !== "https:") {
          throw new Error("Only HTTPS authentication pages can be opened.");
        }
        await shell.openExternal(target.toString());
      },
      onStateChanged: (state) => {
        if (state.status === "signed_out") {
          void clearRuntimeCloudSession();
        }
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(
            "oysterworkflow:auth-state-changed",
            state,
          );
        }
      },
    });
    logStartup("created desktop auth service after window startup");
  }
  return authService;
}

async function clearRuntimeCloudSession(): Promise<void> {
  const context = desktopWindowContext;
  if (!context || !runtimeReady) {
    return;
  }
  try {
    await requestLoopbackRuntime({
      url: new URL("/api/product/cloud/session", `${context.apiBaseUrl}/`),
      apiSecret: context.runtimeApiSecret,
      timeoutMs: 5_000,
      signal: desktopShutdownController.signal,
      init: { method: "DELETE" },
    });
  } catch (error) {
    logStartup(
      "failed to clear Runtime cloud session",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function parseRuntimeJsonBody(bodyText: string): unknown {
  if (!bodyText.trim()) {
    return null;
  }
  try {
    return JSON.parse(bodyText) as unknown;
  } catch {
    throw new Error(
      "The local Runtime returned an invalid JSON response. / 本地 Runtime 返回了无效 JSON。",
    );
  }
}

function validateJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected a JSON object.");
  }
  return value as Record<string, unknown>;
}

function readRuntimeErrorMessage(body: unknown, status: number): string {
  if (typeof body === "object" && body !== null && "error" in body) {
    if (typeof body.error === "string") {
      return body.error;
    }
    if (
      typeof body.error === "object" &&
      body.error !== null &&
      "message" in body.error &&
      typeof body.error.message === "string"
    ) {
      return body.error.message;
    }
  }
  return `Cloud sync failed with status ${status}.`;
}

/**
 * EN: Applies the custom Dock icon for local macOS runs so development matches the packaged desktop app.
 * 中文: 在 macOS 本地开发态为 Dock 设置自定义图标，让调试时的桌面外观与打包产物保持一致。
 * @returns {void}
 */
function applyDevelopmentDockIcon(): void {
  if (process.platform !== "darwin" || app.isPackaged) {
    return;
  }

  const iconPath = resolveDevelopmentDockIconPath();
  if (!iconPath) {
    logStartup("development Dock icon not found");
    return;
  }

  const iconImage = nativeImage.createFromPath(iconPath);
  if (iconImage.isEmpty()) {
    logStartup("failed to load development Dock icon", iconPath);
    return;
  }

  app.dock?.setIcon(iconImage);
  logStartup("applied development Dock icon", iconPath);
}

/**
 * EN: Resolves the checked-in PNG icon path used during local macOS Electron runs.
 * 中文: 解析 macOS 本地 Electron 开发态所使用的项目内 PNG 图标路径。
 * @returns {string | null} Existing icon path, or `null` when the asset is unavailable.
 */
function resolveDevelopmentDockIconPath(): string | null {
  const candidates = [
    join(app.getAppPath(), "desktop", "assets", "app-icon.png"),
    resolve(app.getAppPath(), "../../..", "desktop", "assets", "app-icon.png"),
    join(process.cwd(), "desktop", "assets", "app-icon.png"),
  ];
  return candidates.find((iconPath) => existsSync(iconPath)) ?? null;
}

app.on("window-all-closed", () => {
  logStartup("window-all-closed received");
  app.quit();
});

app.on("before-quit", (event) => {
  logStartup("before-quit received");
  if (hasCompletedQuitCleanup) {
    return;
  }
  event.preventDefault();
  if (isQuitting) {
    return;
  }
  isQuitting = true;
  runtimeReady = false;
  desktopShutdownController.abort(
    new Error("OysterWorkflow desktop is shutting down."),
  );
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.hide();
    logStartup("hid main window while desktop runtime shuts down");
  }
  void waitForShutdownDeadline(
    shutdownRuntime("before-quit"),
    DESKTOP_RUNTIME_SHUTDOWN_TIMEOUT_MS,
  )
    .then((result) => {
      if (result.status === "completed") {
        return;
      }
      pendingQuitExitCode = 1;
      if (result.status === "timed-out") {
        logStartup("runtime shutdown deadline reached during before-quit", {
          timeoutMs: DESKTOP_RUNTIME_SHUTDOWN_TIMEOUT_MS,
        });
        return;
      }
      logStartup(
        "runtime shutdown failed during before-quit",
        result.error instanceof Error
          ? (result.error.stack ?? result.error.message)
          : String(result.error),
      );
    })
    .finally(() => {
      if (relaunchCoordinator.relaunchBeforeExit()) {
        logStartup("scheduled relaunch after desktop runtime shutdown");
      }
      hasCompletedQuitCleanup = true;
      app.exit(pendingQuitExitCode);
    });
});

if (hasSingleInstanceLock) {
  void main().catch(async (error) => {
    runtimeReady = false;
    desktopShutdownController.abort(error);
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    logStartup("desktop launch failed", message);
    await shutdownRuntime("launch-failed");
    console.error("[desktop] Failed to launch app:", message);
    dialog.showErrorBox("OysterWorkflow failed to launch", message);
    hasCompletedQuitCleanup = true;
    app.exit(1);
  });
}

function createOrShowMainWindow(reason: string): Promise<BrowserWindow> {
  const operation = mainWindowOperationQueue.then(() =>
    performCreateOrShowMainWindow(reason),
  );
  mainWindowOperationQueue = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}

/**
 * EN: Performs one serialized main-window navigation so activate and restart events cannot abort each other.
 * 中文: 串行执行一次主窗口导航，避免 activate 与重启事件相互取消页面加载。
 * @param reason lifecycle reason used for logging and focus diagnostics.
 * @returns the visible main window after its target page has loaded.
 */
async function performCreateOrShowMainWindow(
  reason: string,
): Promise<BrowserWindow> {
  const context = desktopWindowContext;
  if (!context) {
    throw new Error("Desktop window context is not ready yet.");
  }

  let window = mainWindow;
  if (!window || window.isDestroyed()) {
    window = createMainWindow(context);
  }

  if (runtimeReady) {
    await ensurePackagedUiLoaded(window, context, reason);
  } else {
    await ensureLaunchScreenLoaded(window, reason);
  }

  showAndFocusWindow(window, reason);
  return window;
}

function createMainWindow(context: DesktopWindowContext): BrowserWindow {
  const window = new BrowserWindow({
    title: "OysterWorkflow",
    width: 1440,
    height: 920,
    minWidth: 1180,
    minHeight: 760,
    focusable: true,
    show: false,
    type: "normal",
    webPreferences: {
      preload: context.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [
        `--oysterworkflow-api-base-url=${context.apiBaseUrl}`,
        `--oysterworkflow-platform=${context.platform}`,
        `--oysterworkflow-mode=${context.mode}`,
      ],
    },
  });
  const packagedUiUrl = pathToFileURL(context.packagedUiEntryPath).href;
  window.webContents.on("will-navigate", (event, destinationUrl) => {
    if (destinationUrl === packagedUiUrl) {
      return;
    }
    event.preventDefault();
    logStartup("blocked renderer navigation", destinationUrl);
  });
  window.webContents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    logStartup("blocked renderer window open", url);
    return { action: "deny" };
  });
  mainWindow = window;
  logStartup("created BrowserWindow");
  window.once("closed", () => {
    logStartup("main window closed");
    if (mainWindow === window) {
      mainWindow = null;
    }
  });
  return window;
}

async function ensureLaunchScreenLoaded(
  window: BrowserWindow,
  reason: string,
): Promise<void> {
  const currentUrl = window.webContents.getURL();
  if (currentUrl.startsWith("data:text/html")) {
    return;
  }

  await loadLaunchScreen(window, {
    title: "Starting OysterWorkflow",
    body: "Preparing the desktop runtime and loading the workspace UI...",
  });
  logStartup("loaded launch screen", reason);
}

async function ensurePackagedUiLoaded(
  window: BrowserWindow,
  context: DesktopWindowContext,
  reason: string,
): Promise<void> {
  const currentUrl = window.webContents.getURL();
  const expectedUrl = pathToFileURL(context.packagedUiEntryPath).href;
  if (currentUrl === expectedUrl) {
    return;
  }

  await window.loadFile(context.packagedUiEntryPath);
  logStartup("loaded packaged UI entry", reason);
  void logRendererDiagnostics(window);
}

async function ensureDesktopDefaults(input: {
  bundledLlmConfigPath: string;
  userLlmConfigPath: string;
}): Promise<void> {
  const existing = await readJsonWithBackup(input.userLlmConfigPath, {
    validate: validateJsonObject,
  });
  if (existing) {
    logStartup("user LLM config already exists", input.userLlmConfigPath);
    return;
  }
  await copyJsonAtomic(input.bundledLlmConfigPath, input.userLlmConfigPath, {
    validate: validateJsonObject,
    backup: true,
    mode: 0o600,
  });
  logStartup("copied default LLM config", {
    from: input.bundledLlmConfigPath,
    to: input.userLlmConfigPath,
  });
}

async function waitForRuntimeHealth(
  apiBaseUrl: string,
  apiSecret: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "unknown";

  while (Date.now() < deadline) {
    try {
      const response = await requestLoopbackRuntime({
        url: `${apiBaseUrl}/api/health`,
        apiSecret,
        timeoutMs: Math.max(1, Math.min(2_000, deadline - Date.now())),
        signal: desktopShutdownController.signal,
      });
      if (response.ok) {
        return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 500));
  }

  throw new Error(`Runtime did not become healthy: ${lastError}`);
}

async function startDesktopRuntime(input: {
  apiPort: number;
  apiSecret: string;
  paths: ReturnType<typeof resolveDesktopRuntimePaths>;
}): Promise<void> {
  const runtimeArgs = buildDesktopRuntimeArgs(input);
  suppressRuntimeExitDialog = false;

  if (app.isPackaged) {
    logStartup(
      "starting packaged runtime in-process",
      input.paths.runtimeEntryPath,
    );
    const runtimeModule = (await import(
      pathToFileURL(input.paths.runtimeEntryPath).href
    )) as {
      startRuntimeHttpServer: (input?: {
        argv?: string[];
        configOverrides?: { apiSecret?: string | null };
        errorReporter?: typeof captureRuntimeError;
      }) => Promise<{ close: () => Promise<void> }>;
    };
    runtimeServerHandle = await runtimeModule.startRuntimeHttpServer({
      argv: runtimeArgs,
      configOverrides: { apiSecret: input.apiSecret },
      errorReporter: captureRuntimeError,
    });
    logStartup("packaged runtime started in-process");
    return;
  }

  runtimeProcess = spawn(process.execPath, runtimeArgs, {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      [RUNTIME_API_SECRET_ENV_NAME]: input.apiSecret,
    },
    stdio: "pipe",
    detached: process.platform !== "win32",
  });
  logStartup("spawned runtime process", {
    pid: runtimeProcess.pid ?? null,
    apiPort: input.apiPort,
  });
  runtimeProcess.once("error", (error) => {
    logStartup(
      "runtime process error",
      error instanceof Error ? error.message : String(error),
    );
  });
  runtimeProcess.stdout.on("data", (chunk) => {
    logStartup("runtime stdout", chunk.toString().trim());
    process.stdout.write(`[runtime] ${chunk}`);
  });
  runtimeProcess.stderr.on("data", (chunk) => {
    logStartup("runtime stderr", chunk.toString().trim());
    process.stderr.write(`[runtime] ${chunk}`);
  });
  runtimeProcess.once("exit", (code, signal) => {
    logStartup("runtime process exited", { code, signal, isQuitting });
    void removePublishedMcpConnections("runtime-process-exit").catch(
      (error) => {
        logStartup(
          "failed to remove OysterWorkflow MCP connection after runtime exit",
          error instanceof Error ? error.message : String(error),
        );
      },
    );
    if (isQuitting || suppressRuntimeExitDialog) {
      return;
    }
    dialog.showErrorBox(
      "Runtime exited unexpectedly",
      `Runtime exited before the app finished. code=${code ?? "null"} signal=${signal ?? "null"}`,
    );
  });
}

/**
 * EN: Stops the spawned desktop Runtime once, covering launch failures and app shutdown.
 * @param reason lifecycle reason for observability.
 * @returns when the child process is confirmed stopped or no child exists.
 */
async function shutdownRuntime(reason: string): Promise<void> {
  await removePublishedMcpConnections(reason);
  if (runtimeShutdownPromise) {
    await runtimeShutdownPromise;
    return;
  }

  const child = runtimeProcess;
  const serverHandle = runtimeServerHandle;
  runtimeProcess = null;
  runtimeServerHandle = null;

  if (!child && !serverHandle) {
    return;
  }

  suppressRuntimeExitDialog = true;
  runtimeShutdownPromise = (async () => {
    if (serverHandle) {
      logStartup("closing packaged runtime server", reason);
      await serverHandle.close();
    }
    if (child) {
      await stopRuntimeProcess(child, reason);
    }
  })().finally(() => {
    runtimeShutdownPromise = null;
  });
  await runtimeShutdownPromise;
}

/**
 * EN: Removes private MCP descriptors without exposing their tokens in logs.
 * 中文: 删除 MCP 私有连接文件，日志中不会输出临时密钥。
 * @param reason lifecycle reason for diagnostics.
 * @returns when cleanup completes or no descriptor path has been assigned.
 */
async function removePublishedMcpConnections(reason: string): Promise<void> {
  if (mcpConnectionPaths.length === 0) {
    return;
  }
  await Promise.all(
    mcpConnectionPaths.map((filePath) =>
      removeOysterWorkflowMcpConnection(filePath),
    ),
  );
  logStartup("removed OysterWorkflow MCP runtime connections", {
    reason,
    paths: mcpConnectionPaths,
  });
}

/**
 * EN: Gracefully stops the Runtime child process and escalates to SIGKILL if needed.
 * @param child spawned Runtime child.
 * @param reason lifecycle reason for startup logging.
 * @returns when the process exits or is already gone.
 */
async function stopRuntimeProcess(
  child: ChildProcessWithoutNullStreams,
  reason: string,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    logStartup("runtime process already stopped", {
      reason,
      pid: child.pid ?? null,
      exitCode: child.exitCode,
      signalCode: child.signalCode,
    });
    return;
  }

  logStartup("stopping runtime process", {
    reason,
    pid: child.pid ?? null,
  });

  await new Promise<void>((resolveStop) => {
    let settled = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
    let hardSettleTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      if (hardSettleTimer) {
        clearTimeout(hardSettleTimer);
      }
      child.removeListener("exit", handleExit);
      child.stdout.destroy();
      child.stderr.destroy();
      child.stdin.destroy();
      resolveStop();
    };

    const handleExit = (): void => {
      finish();
    };

    child.once("exit", handleExit);
    const requested = signalRuntimeProcessTree(child, "SIGINT");

    if (!requested) {
      finish();
      return;
    }

    forceKillTimer = setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) {
        finish();
        return;
      }

      logStartup("force killing runtime process", {
        reason,
        pid: child.pid ?? null,
      });
      void forceKillRuntimeProcessTree(child).finally(() => {
        if (settled) {
          return;
        }
        hardSettleTimer = setTimeout(() => {
          logStartup("runtime process kill hard deadline reached", {
            reason,
            pid: child.pid ?? null,
          });
          finish();
        }, 1_000);
      });
    }, 3_000);
  });
}

async function forceKillRuntimeProcessTree(
  child: ChildProcessWithoutNullStreams,
): Promise<boolean> {
  if (process.platform === "win32" && child.pid) {
    try {
      const terminated = await terminateWindowsProcessTree(child.pid);
      if (terminated) {
        return true;
      }
    } catch {
      // EN/CN: Fall through to direct child termination as a last resort.
    }
  }
  return signalRuntimeProcessTree(child, "SIGKILL");
}

function signalRuntimeProcessTree(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
): boolean {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch (error) {
      const errno = error as NodeJS.ErrnoException;
      if (errno.code === "ESRCH") {
        return false;
      }
    }
  }
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}

function showAndFocusWindow(window: BrowserWindow, reason: string): void {
  ensureWindowOnVisibleDisplay(window);
  logStartup("showing window", {
    reason,
    isVisible: window.isVisible(),
    isMinimized: window.isMinimized(),
    bounds: window.getBounds(),
  });
  if (process.platform === "darwin") {
    app.show();
    app.dock?.show();
  }
  if (window.isMinimized()) {
    window.restore();
  }
  window.show();
  app.focus({ steal: true });
  window.setAlwaysOnTop(true, "screen-saver");
  window.moveTop();
  focusWindow(window);
  setTimeout(() => focusWindow(window), 250);
  setTimeout(() => {
    if (window.isDestroyed()) {
      return;
    }
    window.setAlwaysOnTop(false);
    logStartup("released temporary always-on-top focus boost", reason);
  }, 1_000);
  setTimeout(() => logWindowDiagnostics(`post-show ${reason}`), 250);
}

function focusWindow(window: BrowserWindow): void {
  if (window.isDestroyed()) {
    return;
  }
  if (process.platform === "darwin") {
    app.show();
    app.dock?.show();
  }
  app.focus({ steal: true });
  window.moveTop();
  window.focus();
}

function logWindowDiagnostics(reason: string): void {
  const windows = BrowserWindow.getAllWindows();
  logStartup("window diagnostics", {
    reason,
    count: windows.length,
    focused: BrowserWindow.getFocusedWindow()?.id ?? null,
    windows: windows.map((window) => ({
      id: window.id,
      title: window.getTitle(),
      isVisible: window.isVisible(),
      isFocused: window.isFocused(),
      isMinimized: window.isMinimized(),
      isDestroyed: window.isDestroyed(),
      bounds: window.getBounds(),
    })),
  });
}

function ensureWindowOnVisibleDisplay(window: BrowserWindow): void {
  const bounds = window.getBounds();
  const displays = screen.getAllDisplays();
  const isVisibleOnAnyDisplay = displays.some((display) => {
    const area = display.workArea;
    const right = bounds.x + bounds.width;
    const bottom = bounds.y + bounds.height;
    return (
      right > area.x &&
      bounds.x < area.x + area.width &&
      bottom > area.y &&
      bounds.y < area.y + area.height
    );
  });

  if (isVisibleOnAnyDisplay) {
    return;
  }

  const primary = screen.getPrimaryDisplay().workArea;
  const width = Math.min(bounds.width, primary.width);
  const height = Math.min(bounds.height, primary.height);
  window.setBounds({
    x: primary.x + Math.max(0, Math.round((primary.width - width) / 2)),
    y: primary.y + Math.max(0, Math.round((primary.height - height) / 2)),
    width,
    height,
  });
  logStartup("moved window back to visible display", window.getBounds());
}

async function logRendererDiagnostics(window: BrowserWindow): Promise<void> {
  try {
    const diagnostics = await window.webContents.executeJavaScript(
      `(() => {
        const runtime = globalThis.oysterworkflow?.runtime ?? null;
        return {
          href: location.href,
          origin: location.origin,
          hasBridge: Boolean(globalThis.oysterworkflow),
          runtime,
          hasAuthenticatedRuntimeProxy: Boolean(
            globalThis.oysterworkflow?.cloud?.runtimeRequest,
          ),
        };
      })()`,
      true,
    );
    logStartup("renderer diagnostics", diagnostics);
  } catch (error) {
    logStartup(
      "renderer diagnostics failed",
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
  }
}

async function loadLaunchScreen(
  window: BrowserWindow,
  input: {
    title: string;
    body: string;
  },
): Promise<void> {
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(input.title)}</title>
    <style>
      :root {
        color-scheme: light;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background:
          radial-gradient(circle at top, rgba(30, 144, 255, 0.16), transparent 38%),
          linear-gradient(160deg, #f4f7fb 0%, #ffffff 48%, #eef4ff 100%);
        color: #16324f;
      }

      main {
        width: min(520px, calc(100vw - 48px));
        padding: 32px 28px;
        border-radius: 22px;
        background: rgba(255, 255, 255, 0.92);
        box-shadow: 0 18px 50px rgba(17, 34, 68, 0.14);
      }

      h1 {
        margin: 0 0 12px;
        font-size: 24px;
      }

      p {
        margin: 0;
        line-height: 1.6;
        font-size: 15px;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(input.title)}</h1>
      <p>${escapeHtml(input.body)}</p>
    </main>
  </body>
</html>`;
  await window.loadURL(
    `data:text/html;charset=UTF-8,${encodeURIComponent(html)}`,
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function resolvePermissionSettingsUrl(kind: RecorderPermissionKind): string {
  if (process.platform === "win32") {
    switch (kind) {
      case "microphone":
        return "ms-settings:privacy-microphone";
      case "screen-recording":
      case "accessibility":
      case "input-monitoring":
        return "ms-settings:privacy";
    }
  }

  switch (kind) {
    case "screen-recording":
      return "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
    case "accessibility":
      return "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";
    case "input-monitoring":
      return "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent";
    case "microphone":
      return "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";
  }
}

function resolveDesktopLogRoot(): string {
  if (process.platform === "darwin") {
    return resolve(homedir(), "Library", "Logs", "OysterWorkflow");
  }
  if (process.platform === "win32") {
    return resolve(
      process.env.LOCALAPPDATA ??
        process.env.APPDATA ??
        resolve(homedir(), "AppData", "Local"),
      "OysterWorkflow",
      "Logs",
    );
  }
  return resolve(
    process.env.XDG_STATE_HOME ?? resolve(homedir(), ".local", "state"),
    "oysterworkflow",
    "logs",
  );
}

function logStartup(message: string, details?: unknown): void {
  try {
    mkdirSync(dirname(STARTUP_LOG_PATH), { recursive: true });
    const suffix =
      details === undefined
        ? ""
        : ` ${typeof details === "string" ? details : JSON.stringify(details)}`;
    appendFileSync(
      STARTUP_LOG_PATH,
      `[${new Date().toISOString()} pid=${process.pid}] ${message}${suffix}\n`,
      "utf8",
    );
  } catch {
    // EN: Startup logging must never block the app launch path.
  }
}
