import electronUpdater, { type AppUpdater } from "electron-updater";
import type {
  DesktopUpdaterDriver,
  DesktopUpdaterInfo,
} from "./app-update-service.js";

/**
 * EN: Adapts electron-updater to the small driver contract owned by the desktop update service.
 * 中文: 将 electron-updater 适配为桌面更新服务使用的窄接口。
 * @param updater optional updater instance for tests or alternate release channels.
 * @returns configured updater driver with manual download behavior.
 */
export function createElectronUpdaterDriver(
  updater: AppUpdater = electronUpdater.autoUpdater,
): DesktopUpdaterDriver {
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = true;
  updater.allowDowngrade = false;

  return {
    onChecking(listener) {
      updater.on("checking-for-update", listener);
    },
    onUpdateAvailable(listener) {
      updater.on("update-available", (info) => listener(toUpdaterInfo(info)));
    },
    onUpdateNotAvailable(listener) {
      updater.on("update-not-available", () => listener());
    },
    onDownloadProgress(listener) {
      updater.on("download-progress", (progress) =>
        listener({
          percent: progress.percent,
          transferredBytes: progress.transferred,
          totalBytes: progress.total,
          bytesPerSecond: progress.bytesPerSecond,
        }),
      );
    },
    onUpdateDownloaded(listener) {
      updater.on("update-downloaded", (info) => listener(toUpdaterInfo(info)));
    },
    onError(listener) {
      updater.on("error", listener);
    },
    checkForUpdates: () => updater.checkForUpdates(),
    downloadUpdate: () => updater.downloadUpdate(),
    quitAndInstall: () => updater.quitAndInstall(false, true),
  };
}

function toUpdaterInfo(info: {
  version: string;
  releaseName?: string | null;
  releaseNotes?: unknown;
  releaseDate?: string;
}): DesktopUpdaterInfo {
  return {
    version: info.version,
    releaseName: info.releaseName,
    releaseNotes: normalizeDriverReleaseNotes(info.releaseNotes),
    releaseDate: info.releaseDate,
  };
}

function normalizeDriverReleaseNotes(
  value: unknown,
): DesktopUpdaterInfo["releaseNotes"] {
  if (typeof value === "string" || value === null || value === undefined) {
    return value;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  return value.map((entry) => {
    if (typeof entry !== "object" || entry === null || !("note" in entry)) {
      return {};
    }
    return { note: typeof entry.note === "string" ? entry.note : null };
  });
}
