import type {
  RuntimeBridgeInfo,
  RuntimeMode,
} from "../../src/runtime/config.js";
import type {
  RecorderPermissionKind,
  RecorderPermissionsResponse,
} from "../../src/lab-api/api-contracts.js";
import type {
  CloudAuthActionResponse,
  CloudAuthState,
  CloudEmailAuthInput,
  CloudIpcRequestOptions,
  CloudSignUpResponse,
  CloudRuntimeRequestInput,
  CloudRuntimeRequestResponse,
  CloudSyncMode,
  CloudSyncResult,
} from "../../src/cloud/contracts.js";
import type { DesktopUpdateSnapshot } from "../../src/desktop-update/contracts.js";
import { withAsyncDeadline } from "./async-deadline";

const DESKTOP_DISPATCH_TIMEOUT_MS = 15_000;
const DESKTOP_PERMISSION_TIMEOUT_MS = 120_000;
let desktopCloudRequestSequence = 0;

interface CancelableDesktopCloudRequestOptions {
  signal?: AbortSignal;
  timeoutMs: number;
}

declare global {
  interface Window {
    oysterworkflow?: {
      runtime?: Partial<RuntimeBridgeInfo>;
      desktop?: {
        openPermissionSettings?: (
          kind: RecorderPermissionKind,
        ) => Promise<void>;
        checkRecorderPermissions?: () => Promise<RecorderPermissionsResponse>;
        requestRecorderPermission?: (
          kind: RecorderPermissionKind,
        ) => Promise<boolean>;
        requestMicrophoneAccess?: () => Promise<boolean>;
        quitAndReopen?: () => Promise<boolean>;
        openExternalUrl?: (url: string) => Promise<void>;
        getUpdateState?: () => Promise<DesktopUpdateSnapshot>;
        checkForUpdates?: () => Promise<DesktopUpdateSnapshot>;
        downloadUpdate?: () => Promise<DesktopUpdateSnapshot>;
        installUpdate?: () => Promise<DesktopUpdateSnapshot>;
        onUpdateStateChanged?: (
          listener: (snapshot: DesktopUpdateSnapshot) => void,
        ) => () => void;
      };
      auth?: {
        getState?: () => Promise<CloudAuthState>;
        signUp?: (input: CloudEmailAuthInput) => Promise<CloudSignUpResponse>;
        signIn?: (
          input: CloudEmailAuthInput,
        ) => Promise<CloudAuthActionResponse>;
        continueWithGoogle?: () => Promise<CloudAuthActionResponse>;
        signOut?: () => Promise<CloudAuthActionResponse>;
        onStateChanged?: (
          listener: (state: CloudAuthState) => void,
        ) => () => void;
        onError?: (listener: (message: string) => void) => () => void;
      };
      cloud?: {
        sync?: (
          mode?: CloudSyncMode,
          options?: CloudIpcRequestOptions,
        ) => Promise<CloudSyncResult>;
        runtimeRequest?: (
          input: CloudRuntimeRequestInput,
        ) => Promise<CloudRuntimeRequestResponse>;
        cancelRequest?: (requestId: string) => void;
      };
    };
  }
}

const EMPTY_BRIDGE: RuntimeBridgeInfo = {
  apiBaseUrl: "",
  platform: "web",
  mode: "dev",
};

/**
 * EN: Reads the read-only Runtime config injected by Electron preload and falls back to an empty config during browser dev.
 * @returns bridge info used by the renderer to call the API.
 */
export function getRuntimeBridgeInfo(): RuntimeBridgeInfo {
  const runtime = window.oysterworkflow?.runtime;
  return {
    apiBaseUrl: normalizeApiBaseUrl(runtime?.apiBaseUrl),
    platform: runtime?.platform ?? EMPTY_BRIDGE.platform,
    mode: normalizeRuntimeMode(runtime?.mode),
  };
}

/**
 * EN: Returns the narrow desktop Auth bridge without exposing session tokens.
 * 中文: 返回不暴露 session token 的桌面 Auth 窄接口。
 */
export function getDesktopAuthBridge(): NonNullable<
  Window["oysterworkflow"]
>["auth"] {
  return window.oysterworkflow?.auth;
}

/**
 * EN: Requests one authenticated control-plane sync from Electron main.
 * 中文: 通过 Electron main 请求一次已认证的控制面同步。
 */
export async function syncDesktopCloudState(
  mode: CloudSyncMode = "pull",
  options: CancelableDesktopCloudRequestOptions = { timeoutMs: 30_000 },
): Promise<CloudSyncResult> {
  const sync = window.oysterworkflow?.cloud?.sync;
  if (typeof sync !== "function") {
    throw new Error("Cloud sync is only available inside the desktop app.");
  }
  return invokeCancelableDesktopCloudRequest(
    (ipcOptions) => sync(mode, ipcOptions),
    options,
  );
}

/**
 * EN: Proxies a local Runtime request through Electron main so the renderer never receives the Supabase token.
 * 中文: 通过 Electron main 代理本地 Runtime 请求，避免 renderer 接触 Supabase token。
 * @param input local API path, method, and optional JSON body.
 * @returns raw local Runtime status and response text, or null outside desktop.
 */
export async function requestAuthenticatedDesktopRuntime(
  input: CloudRuntimeRequestInput,
  options: CancelableDesktopCloudRequestOptions,
): Promise<CloudRuntimeRequestResponse | null> {
  const request = window.oysterworkflow?.cloud?.runtimeRequest;
  if (typeof request !== "function") {
    return null;
  }
  return invokeCancelableDesktopCloudRequest(
    (ipcOptions) => request({ ...input, ...ipcOptions }),
    options,
  );
}

async function invokeCancelableDesktopCloudRequest<T>(
  invoke: (options: CloudIpcRequestOptions) => Promise<T>,
  options: CancelableDesktopCloudRequestOptions,
): Promise<T> {
  if (options.signal?.aborted) {
    throw (
      options.signal.reason ??
      new DOMException("The request was cancelled.", "AbortError")
    );
  }
  const requestId = createDesktopCloudRequestId();
  const cancel = window.oysterworkflow?.cloud?.cancelRequest;
  let rejectCancellation: ((reason?: unknown) => void) | null = null;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const handleAbort = () => {
    cancel?.(requestId);
    rejectCancellation?.(
      options.signal?.reason ??
        new DOMException("The request was cancelled.", "AbortError"),
    );
  };
  options.signal?.addEventListener("abort", handleAbort, { once: true });
  try {
    return await Promise.race([
      invoke({ requestId, timeoutMs: options.timeoutMs }),
      cancellation,
    ]);
  } finally {
    options.signal?.removeEventListener("abort", handleAbort);
  }
}

function createDesktopCloudRequestId(): string {
  desktopCloudRequestSequence += 1;
  return `renderer-${Date.now().toString(36)}-${desktopCloudRequestSequence.toString(36)}`;
}

/**
 * EN: Builds the API URL from the current Runtime bridge info, supporting both absolute base URLs and browser-relative paths.
 * @param path API path starting with `/api/`.
 * @returns URL ready to pass into `fetch`.
 */
export function buildApiUrl(path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const runtime = getRuntimeBridgeInfo();
  if (!runtime.apiBaseUrl) {
    return normalizedPath;
  }
  return new URL(normalizedPath, `${runtime.apiBaseUrl}/`).toString();
}

/**
 * EN: Reports whether the packaged desktop preload can proactively request one recorder permission.
 * @returns true when Electron can ask macOS to prompt for one recorder permission.
 */
export function hasDesktopPermissionRequestBridge(): boolean {
  return (
    typeof window.oysterworkflow?.desktop?.requestRecorderPermission ===
    "function"
  );
}

/**
 * EN: Reports whether the packaged desktop preload can proactively ask macOS for microphone access.
 * @returns true when Electron can request microphone access for the current app identity.
 */
export function hasDesktopMicrophoneRequestBridge(): boolean {
  return (
    typeof window.oysterworkflow?.desktop?.requestMicrophoneAccess ===
    "function"
  );
}

/**
 * EN: Reports whether the packaged app can relaunch itself after macOS permission changes.
 * 中文: 判断桌面应用是否能在 macOS 权限变更后自行重新启动。
 * @returns true when the relaunch bridge is available.
 */
export function hasDesktopQuitAndReopenBridge(): boolean {
  return typeof window.oysterworkflow?.desktop?.quitAndReopen === "function";
}

/**
 * EN: Requests one recorder permission from the packaged desktop host.
 * @param kind permission kind to request.
 * @returns whether the permission is granted after the request attempt.
 */
export async function requestDesktopRecorderPermission(
  kind: RecorderPermissionKind,
): Promise<boolean> {
  const requestPermission =
    window.oysterworkflow?.desktop?.requestRecorderPermission;
  if (typeof requestPermission !== "function") {
    throw new Error(
      "Desktop recorder permission requests are only available inside the packaged desktop app.",
    );
  }
  return withDesktopIpcDeadline(
    () => requestPermission(kind),
    DESKTOP_PERMISSION_TIMEOUT_MS,
    "requesting recorder permission / 请求录制权限",
  );
}

/**
 * EN: Requests microphone access from the packaged desktop host when macOS has not granted it yet.
 * @returns whether microphone access is granted after the request attempt.
 */
export async function requestDesktopMicrophoneAccess(): Promise<boolean> {
  const requestAccess = window.oysterworkflow?.desktop?.requestMicrophoneAccess;
  if (typeof requestAccess !== "function") {
    throw new Error(
      "Desktop microphone access requests are only available inside the packaged desktop app.",
    );
  }
  return withDesktopIpcDeadline(
    requestAccess,
    DESKTOP_PERMISSION_TIMEOUT_MS,
    "requesting microphone permission / 请求麦克风权限",
  );
}

/**
 * EN: Quits and relaunches the packaged app so macOS permission changes can take effect.
 * 中文: 退出并重新启动桌面应用，使 macOS 权限变更生效。
 * @returns when Electron accepts the relaunch request.
 */
export async function quitAndReopenDesktopApp(): Promise<void> {
  const quitAndReopen = window.oysterworkflow?.desktop?.quitAndReopen;
  if (typeof quitAndReopen !== "function") {
    throw new Error(
      "Quit and reopen is only available inside the packaged desktop app.",
    );
  }
  await withDesktopIpcDeadline(
    quitAndReopen,
    DESKTOP_DISPATCH_TIMEOUT_MS,
    "restarting OysterWorkflow / 重启 OysterWorkflow",
  );
}

/**
 * EN: Opens a trusted HTTPS authorization page in the host browser.
 * 中文: 在系统浏览器中打开可信的 HTTPS 授权页面。
 * @param url authorization URL returned by the local Runtime.
 * @returns when the desktop host or browser fallback dispatches the URL.
 */
export async function openExternalUrl(url: string): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
    throw new Error("Only HTTPS external URLs are allowed.");
  }
  const openExternal = window.oysterworkflow?.desktop?.openExternalUrl;
  if (typeof openExternal === "function") {
    await withDesktopIpcDeadline(
      () => openExternal(parsed.toString()),
      DESKTOP_DISPATCH_TIMEOUT_MS,
      "opening the browser / 打开浏览器",
    );
    return;
  }
  const opened = window.open(
    parsed.toString(),
    "_blank",
    "noopener,noreferrer",
  );
  if (!opened) {
    throw new Error("The authorization window was blocked by the browser.");
  }
}

function withDesktopIpcDeadline<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  action: string,
): Promise<T> {
  return withAsyncDeadline(() => operation(), {
    timeoutMs,
    timeoutMessage: `OysterWorkflow timed out while ${action}. Try again. / 操作超时，请重试。`,
  });
}

function normalizeApiBaseUrl(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    return "";
  }
  return value.replace(/\/+$/, "");
}

function normalizeRuntimeMode(value: unknown): RuntimeMode {
  return value === "desktop" || value === "test" ? value : "dev";
}
