import type { DesktopUpdateSnapshot } from "../../src/desktop-update/contracts.js";
import { withAsyncDeadline } from "./async-deadline";

const UPDATE_CHECK_TIMEOUT_MS = 90_000;
const UPDATE_INSTALL_DISPATCH_TIMEOUT_MS = 30_000;

/**
 * EN: Reads the latest desktop update snapshot through the restricted preload bridge.
 * 中文: 通过受限 preload bridge 读取最新桌面更新状态。
 * @returns current updater state, or an unsupported state outside the packaged app.
 */
export async function getDesktopUpdateState(): Promise<DesktopUpdateSnapshot> {
  const getState = window.oysterworkflow?.desktop?.getUpdateState;
  if (typeof getState !== "function") {
    return unsupportedDesktopUpdateState();
  }
  return withAsyncDeadline(getState, {
    timeoutMs: UPDATE_INSTALL_DISPATCH_TIMEOUT_MS,
    timeoutMessage:
      "OysterWorkflow timed out while reading update status. / 读取更新状态超时。",
  });
}

/**
 * EN: Subscribes to updater events forwarded by Electron main.
 * 中文: 订阅 Electron main 转发的更新状态事件。
 * @param listener renderer callback for each immutable update snapshot.
 * @returns unsubscribe callback.
 */
export function subscribeDesktopUpdateState(
  listener: (snapshot: DesktopUpdateSnapshot) => void,
): () => void {
  return (
    window.oysterworkflow?.desktop?.onUpdateStateChanged?.(listener) ??
    (() => undefined)
  );
}

/**
 * EN: Requests a signed release check from the packaged desktop host.
 * 中文: 请求打包后的桌面宿主检查已签名发布版本。
 * @returns resulting updater snapshot.
 */
export async function checkForDesktopUpdates(): Promise<DesktopUpdateSnapshot> {
  const check = window.oysterworkflow?.desktop?.checkForUpdates;
  if (typeof check !== "function") {
    return unsupportedDesktopUpdateState();
  }
  return withAsyncDeadline(check, {
    timeoutMs: UPDATE_CHECK_TIMEOUT_MS,
    timeoutMessage:
      "OysterWorkflow timed out while checking for updates. / 检查更新超时。",
  });
}

/**
 * EN: Downloads the available update while progress arrives through updater events.
 * 中文: 下载可用更新，进度由更新事件持续返回。
 * @returns updater snapshot after the download completes.
 */
export async function downloadDesktopUpdate(): Promise<DesktopUpdateSnapshot> {
  const download = window.oysterworkflow?.desktop?.downloadUpdate;
  if (typeof download !== "function") {
    return unsupportedDesktopUpdateState();
  }
  return download();
}

/**
 * EN: Asks Electron main to stop local services and install the downloaded update.
 * 中文: 请求 Electron main 停止本地服务并安装已下载更新。
 * @returns installing snapshot before the application exits.
 */
export async function installDesktopUpdate(): Promise<DesktopUpdateSnapshot> {
  const install = window.oysterworkflow?.desktop?.installUpdate;
  if (typeof install !== "function") {
    return unsupportedDesktopUpdateState();
  }
  return withAsyncDeadline(install, {
    timeoutMs: UPDATE_INSTALL_DISPATCH_TIMEOUT_MS,
    timeoutMessage:
      "OysterWorkflow timed out while preparing the update. / 准备安装更新超时。",
  });
}

export function unsupportedDesktopUpdateState(): DesktopUpdateSnapshot {
  return {
    supported: false,
    phase: "unsupported",
    currentVersion: "",
    availableVersion: null,
    releaseName: null,
    releaseNotes: null,
    releaseDate: null,
    checkedAt: null,
    progress: null,
    errorMessage: null,
    errorCode: null,
  };
}
