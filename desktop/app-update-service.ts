import type {
  DesktopUpdateErrorCode,
  DesktopUpdateProgress,
  DesktopUpdateSnapshot,
} from "../src/desktop-update/contracts.js";

export interface DesktopUpdaterInfo {
  version: string;
  releaseName?: string | null;
  releaseNotes?: string | Array<{ note?: string | null }> | null;
  releaseDate?: string | null;
}

export interface DesktopUpdaterDriver {
  onChecking(listener: () => void): void;
  onUpdateAvailable(listener: (info: DesktopUpdaterInfo) => void): void;
  onUpdateNotAvailable(listener: () => void): void;
  onDownloadProgress(listener: (progress: DesktopUpdateProgress) => void): void;
  onUpdateDownloaded(listener: (info: DesktopUpdaterInfo) => void): void;
  onError(listener: (error: Error) => void): void;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(): void;
}

export interface DesktopUpdateService {
  getSnapshot(): DesktopUpdateSnapshot;
  subscribe(listener: (snapshot: DesktopUpdateSnapshot) => void): () => void;
  checkForUpdates(): Promise<DesktopUpdateSnapshot>;
  downloadUpdate(): Promise<DesktopUpdateSnapshot>;
  beginInstall(): DesktopUpdateSnapshot;
  quitAndInstall(): void;
}

interface DesktopUpdateServiceOptions {
  driver: DesktopUpdaterDriver;
  currentVersion: string;
  isPackaged: boolean;
  platform: NodeJS.Platform;
  now?: () => Date;
}

/**
 * EN: Owns the desktop update state machine without exposing Electron APIs to the renderer.
 * 中文: 管理桌面更新状态机，避免向 renderer 暴露 Electron 更新 API。
 * @param options updater driver and host application metadata.
 * @returns update service used by trusted main-process IPC handlers.
 */
export function createDesktopUpdateService(
  options: DesktopUpdateServiceOptions,
): DesktopUpdateService {
  const supported =
    options.isPackaged &&
    (options.platform === "darwin" || options.platform === "win32");
  const listeners = new Set<(snapshot: DesktopUpdateSnapshot) => void>();
  const now = options.now ?? (() => new Date());
  let checkInFlight: Promise<DesktopUpdateSnapshot> | null = null;
  let downloadInFlight: Promise<DesktopUpdateSnapshot> | null = null;
  let activeOperation: "check" | "download" | null = null;
  let snapshot: DesktopUpdateSnapshot = {
    supported,
    phase: supported ? "idle" : "unsupported",
    currentVersion: options.currentVersion,
    availableVersion: null,
    releaseName: null,
    releaseNotes: null,
    releaseDate: null,
    checkedAt: null,
    progress: null,
    errorMessage: null,
    errorCode: null,
  };

  const publish = (patch: Partial<DesktopUpdateSnapshot>): void => {
    snapshot = { ...snapshot, ...patch };
    const next = cloneSnapshot(snapshot);
    listeners.forEach((listener) => listener(next));
  };

  options.driver.onChecking(() => {
    publish({
      phase: "checking",
      progress: null,
      errorMessage: null,
      errorCode: null,
    });
  });
  options.driver.onUpdateAvailable((info) => {
    publish({
      phase: "available",
      availableVersion: info.version,
      releaseName: normalizeOptionalText(info.releaseName),
      releaseNotes: normalizeReleaseNotes(info.releaseNotes),
      releaseDate: normalizeOptionalText(info.releaseDate),
      checkedAt: now().toISOString(),
      progress: null,
      errorMessage: null,
      errorCode: null,
    });
  });
  options.driver.onUpdateNotAvailable(() => {
    publish({
      phase: "up_to_date",
      availableVersion: null,
      releaseName: null,
      releaseNotes: null,
      releaseDate: null,
      checkedAt: now().toISOString(),
      progress: null,
      errorMessage: null,
      errorCode: null,
    });
  });
  options.driver.onDownloadProgress((progress) => {
    publish({
      phase: "downloading",
      progress: normalizeProgress(progress),
      errorMessage: null,
      errorCode: null,
    });
  });
  options.driver.onUpdateDownloaded((info) => {
    publish({
      phase: "downloaded",
      availableVersion: info.version,
      releaseName:
        normalizeOptionalText(info.releaseName) ?? snapshot.releaseName,
      releaseNotes:
        normalizeReleaseNotes(info.releaseNotes) ?? snapshot.releaseNotes,
      releaseDate:
        normalizeOptionalText(info.releaseDate) ?? snapshot.releaseDate,
      progress: snapshot.progress
        ? { ...snapshot.progress, percent: 100 }
        : null,
      errorMessage: null,
      errorCode: null,
    });
  });
  options.driver.onError((error) => {
    publishUpdateError(error, activeOperation === "check");
  });

  const publishCurrentVersion = (): void => {
    publish({
      phase: "up_to_date",
      availableVersion: null,
      releaseName: null,
      releaseNotes: null,
      releaseDate: null,
      checkedAt: now().toISOString(),
      progress: null,
      errorMessage: null,
      errorCode: null,
    });
  };

  const publishUpdateError = (
    error: unknown,
    allowCurrentReleaseFallback: boolean,
  ): boolean => {
    if (
      allowCurrentReleaseFallback &&
      isMissingCurrentReleaseMetadata(error, options.currentVersion)
    ) {
      publishCurrentVersion();
      return true;
    }
    const normalized = normalizeUpdateError(error);
    publish({
      phase: "error",
      checkedAt: now().toISOString(),
      progress: null,
      errorMessage: normalized.message,
      errorCode: normalized.code,
    });
    return false;
  };

  return {
    getSnapshot: () => cloneSnapshot(snapshot),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    checkForUpdates() {
      if (!supported) {
        return Promise.resolve(cloneSnapshot(snapshot));
      }
      if (checkInFlight) {
        return checkInFlight;
      }
      publish({
        phase: "checking",
        progress: null,
        errorMessage: null,
        errorCode: null,
      });
      activeOperation = "check";
      checkInFlight = options.driver
        .checkForUpdates()
        .then(() => cloneSnapshot(snapshot))
        .catch((error: unknown) => {
          if (publishUpdateError(error, true)) {
            return cloneSnapshot(snapshot);
          }
          throw error;
        })
        .finally(() => {
          checkInFlight = null;
          if (activeOperation === "check") {
            activeOperation = null;
          }
        });
      return checkInFlight;
    },
    downloadUpdate() {
      if (!supported) {
        return Promise.resolve(cloneSnapshot(snapshot));
      }
      if (!snapshot.availableVersion) {
        return Promise.reject(
          new Error("Check for an available update before downloading."),
        );
      }
      if (downloadInFlight) {
        return downloadInFlight;
      }
      publish({
        phase: "downloading",
        progress: {
          percent: 0,
          transferredBytes: 0,
          totalBytes: 0,
          bytesPerSecond: 0,
        },
        errorMessage: null,
        errorCode: null,
      });
      activeOperation = "download";
      downloadInFlight = options.driver
        .downloadUpdate()
        .then(() => cloneSnapshot(snapshot))
        .catch((error: unknown) => {
          publishUpdateError(error, false);
          throw error;
        })
        .finally(() => {
          downloadInFlight = null;
          if (activeOperation === "download") {
            activeOperation = null;
          }
        });
      return downloadInFlight;
    },
    beginInstall() {
      if (snapshot.phase !== "downloaded") {
        throw new Error("Download the update before installing it.");
      }
      publish({ phase: "installing", errorMessage: null, errorCode: null });
      return cloneSnapshot(snapshot);
    },
    quitAndInstall() {
      options.driver.quitAndInstall();
    },
  };
}

function normalizeProgress(
  progress: DesktopUpdateProgress,
): DesktopUpdateProgress {
  return {
    percent: Math.min(100, Math.max(0, progress.percent)),
    transferredBytes: Math.max(0, progress.transferredBytes),
    totalBytes: Math.max(0, progress.totalBytes),
    bytesPerSecond: Math.max(0, progress.bytesPerSecond),
  };
}

function normalizeReleaseNotes(
  value: DesktopUpdaterInfo["releaseNotes"],
): string | null {
  if (Array.isArray(value)) {
    return normalizeOptionalText(
      value
        .map((entry) => normalizeReleaseNoteMarkup(entry.note))
        .filter((entry): entry is string => Boolean(entry))
        .join("\n\n"),
    );
  }
  return normalizeOptionalText(normalizeReleaseNoteMarkup(value));
}

/**
 * EN: Converts GitHub's HTML release notes into readable plain text for the settings UI.
 * 中文: 将 GitHub 返回的 HTML 更新说明转换为设置页可读的纯文本。
 * @param value release note content returned by electron-updater.
 * @returns normalized plain text, or null when no text is available.
 */
function normalizeReleaseNoteMarkup(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const withoutUnsafeBlocks = value
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/giu, "")
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<li\b[^>]*>/giu, "- ")
    .replace(
      /<\/(?:address|article|blockquote|div|h[1-6]|li|ol|p|pre|section|ul)>/giu,
      "\n",
    )
    .replace(/<[^>]+>/gu, "");
  return normalizeOptionalText(
    decodeReleaseNoteEntities(withoutUnsafeBlocks)
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .join("\n")
      .replace(/\n{3,}/gu, "\n\n"),
  );
}

function decodeReleaseNoteEntities(value: string): string {
  const namedEntities: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value.replace(
    /&(?:#(\d+)|#x([\da-f]+)|([a-z]+));/giu,
    (
      entity,
      decimal: string | undefined,
      hex: string | undefined,
      named: string | undefined,
    ) => {
      if (decimal) {
        return decodeReleaseNoteCodePoint(Number.parseInt(decimal, 10), entity);
      }
      if (hex) {
        return decodeReleaseNoteCodePoint(Number.parseInt(hex, 16), entity);
      }
      return namedEntities[named?.toLowerCase() ?? ""] ?? entity;
    },
  );
}

function decodeReleaseNoteCodePoint(value: number, fallback: string): string {
  try {
    return String.fromCodePoint(value);
  } catch {
    return fallback;
  }
}

function normalizeOptionalText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized ? normalized.slice(0, 8_000) : null;
}

function normalizeUpdateError(error: unknown): {
  code: DesktopUpdateErrorCode;
  message: string;
} {
  const message = error instanceof Error ? error.message : String(error);
  if (isMissingReleaseMetadata(message)) {
    return {
      code: "release_metadata_unavailable",
      message:
        "The Windows release is temporarily missing update information. Try again later.",
    };
  }
  if (
    /\b(?:ECONNABORTED|ECONNREFUSED|ECONNRESET|ENETUNREACH|ENOTFOUND|ETIMEDOUT)\b|network|timed?\s*out|fetch failed/iu.test(
      message,
    )
  ) {
    return {
      code: "network_unavailable",
      message:
        "OysterWorkflow could not reach the update service. Check your connection and try again.",
    };
  }
  return {
    code: "operation_failed",
    message: "OysterWorkflow could not complete the update operation.",
  };
}

function isMissingCurrentReleaseMetadata(
  error: unknown,
  currentVersion: string,
): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (!isMissingReleaseMetadata(message)) {
    return false;
  }
  const releaseVersion = message.match(
    /\/releases\/download\/v?([^/\s]+)\/latest(?:-[^/\s]+)?\.yml/iu,
  )?.[1];
  return (
    releaseVersion !== undefined &&
    normalizeVersion(releaseVersion) === normalizeVersion(currentVersion)
  );
}

function isMissingReleaseMetadata(message: string): boolean {
  return (
    /Cannot find latest(?:-[^/\s]+)?\.yml/iu.test(message) ||
    /latest(?:-[^/\s]+)?\.yml[\s\S]{0,300}\b404\b/iu.test(message) ||
    /\b404\b[\s\S]{0,300}latest(?:-[^/\s]+)?\.yml/iu.test(message)
  );
}

function normalizeVersion(version: string): string {
  return decodeURIComponent(version).trim().replace(/^v/iu, "");
}

function cloneSnapshot(snapshot: DesktopUpdateSnapshot): DesktopUpdateSnapshot {
  return {
    ...snapshot,
    progress: snapshot.progress ? { ...snapshot.progress } : null,
  };
}
