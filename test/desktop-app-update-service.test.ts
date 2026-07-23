import { describe, expect, it, vi } from "vitest";
import {
  createDesktopUpdateService,
  type DesktopUpdaterDriver,
  type DesktopUpdaterInfo,
} from "../desktop/app-update-service.js";
import type { DesktopUpdateProgress } from "../src/desktop-update/contracts.js";

class FakeUpdaterDriver implements DesktopUpdaterDriver {
  checkingListener: () => void = () => undefined;
  availableListener: (info: DesktopUpdaterInfo) => void = () => undefined;
  notAvailableListener: () => void = () => undefined;
  progressListener: (progress: DesktopUpdateProgress) => void = () => undefined;
  downloadedListener: (info: DesktopUpdaterInfo) => void = () => undefined;
  errorListener: (error: Error) => void = () => undefined;
  checkResult: "available" | "current" = "available";
  checkError: Error | null = null;
  downloadError: Error | null = null;
  readonly quitAndInstall = vi.fn();

  onChecking(listener: () => void): void {
    this.checkingListener = listener;
  }

  onUpdateAvailable(listener: (info: DesktopUpdaterInfo) => void): void {
    this.availableListener = listener;
  }

  onUpdateNotAvailable(listener: () => void): void {
    this.notAvailableListener = listener;
  }

  onDownloadProgress(
    listener: (progress: DesktopUpdateProgress) => void,
  ): void {
    this.progressListener = listener;
  }

  onUpdateDownloaded(listener: (info: DesktopUpdaterInfo) => void): void {
    this.downloadedListener = listener;
  }

  onError(listener: (error: Error) => void): void {
    this.errorListener = listener;
  }

  async checkForUpdates(): Promise<void> {
    this.checkingListener();
    if (this.checkError) {
      throw this.checkError;
    }
    if (this.checkResult === "available") {
      this.availableListener({
        version: "0.3.0",
        releaseName: "OysterWorkflow 0.3.0",
        releaseNotes: [{ note: "Improved updates." }, { note: "Bug fixes." }],
        releaseDate: "2026-07-21T18:00:00.000Z",
      });
      return;
    }
    this.notAvailableListener();
  }

  async downloadUpdate(): Promise<void> {
    if (this.downloadError) {
      throw this.downloadError;
    }
    this.progressListener({
      percent: 48.6,
      transferredBytes: 48,
      totalBytes: 100,
      bytesPerSecond: 12,
    });
    this.downloadedListener({ version: "0.3.0" });
  }
}

describe("desktop app update service", () => {
  it("checks, downloads, and installs a signed release through explicit states", async () => {
    const driver = new FakeUpdaterDriver();
    const service = createDesktopUpdateService({
      driver,
      currentVersion: "0.2.2",
      isPackaged: true,
      platform: "darwin",
      now: () => new Date("2026-07-21T19:00:00.000Z"),
    });
    const observedPhases: string[] = [];
    service.subscribe((snapshot) => observedPhases.push(snapshot.phase));

    const available = await service.checkForUpdates();
    expect(available).toMatchObject({
      supported: true,
      phase: "available",
      currentVersion: "0.2.2",
      availableVersion: "0.3.0",
      releaseNotes: "Improved updates.\n\nBug fixes.",
      checkedAt: "2026-07-21T19:00:00.000Z",
    });

    const downloaded = await service.downloadUpdate();
    expect(downloaded).toMatchObject({
      phase: "downloaded",
      progress: { percent: 100 },
    });
    expect(service.beginInstall().phase).toBe("installing");

    service.quitAndInstall();
    expect(driver.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(observedPhases).toEqual(
      expect.arrayContaining([
        "checking",
        "available",
        "downloading",
        "downloaded",
        "installing",
      ]),
    );
  });

  it("reports current when the release channel has no newer version", async () => {
    const driver = new FakeUpdaterDriver();
    driver.checkResult = "current";
    const service = createDesktopUpdateService({
      driver,
      currentVersion: "0.2.2",
      isPackaged: true,
      platform: "win32",
    });

    await expect(service.checkForUpdates()).resolves.toMatchObject({
      phase: "up_to_date",
      availableVersion: null,
    });
  });

  it("does not contact the release channel from development builds", async () => {
    const driver = new FakeUpdaterDriver();
    const checkSpy = vi.spyOn(driver, "checkForUpdates");
    const service = createDesktopUpdateService({
      driver,
      currentVersion: "0.2.2",
      isPackaged: false,
      platform: "darwin",
    });

    await expect(service.checkForUpdates()).resolves.toMatchObject({
      supported: false,
      phase: "unsupported",
    });
    expect(checkSpy).not.toHaveBeenCalled();
  });

  it("keeps an available version retryable after a download failure", async () => {
    const driver = new FakeUpdaterDriver();
    driver.downloadError = new Error("download interrupted");
    const service = createDesktopUpdateService({
      driver,
      currentVersion: "0.2.2",
      isPackaged: true,
      platform: "darwin",
    });

    await service.checkForUpdates();
    await expect(service.downloadUpdate()).rejects.toThrow(
      "download interrupted",
    );
    expect(service.getSnapshot()).toMatchObject({
      phase: "error",
      availableVersion: "0.3.0",
      errorMessage: "download interrupted",
    });
  });

  it("converts GitHub HTML release notes into readable plain text", async () => {
    const driver = new FakeUpdaterDriver();
    const service = createDesktopUpdateService({
      driver,
      currentVersion: "0.2.3-beta.1",
      isPackaged: true,
      platform: "darwin",
    });

    driver.availableListener({
      version: "0.2.3-beta.2",
      releaseNotes:
        "<h2>Beta update</h2><p>Safer &amp; clearer.</p><ul><li>Keep local data</li><li>Show progress</li></ul><script>ignored()</script>",
    });

    expect(service.getSnapshot().releaseNotes).toBe(
      "Beta update\nSafer & clearer.\n- Keep local data\n- Show progress",
    );
  });
});
