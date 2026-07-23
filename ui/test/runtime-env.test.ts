import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildApiUrl,
  getRuntimeBridgeInfo,
  hasDesktopPermissionRequestBridge,
  hasDesktopMicrophoneRequestBridge,
  hasDesktopQuitAndReopenBridge,
  openExternalUrl,
  requestDesktopRecorderPermission,
  requestDesktopMicrophoneAccess,
  quitAndReopenDesktopApp,
} from "../src/runtime-env";

describe("runtime env bridge", () => {
  afterEach(() => {
    delete window.oysterworkflow;
  });

  it("falls back to relative api paths when no preload bridge is present", () => {
    expect(getRuntimeBridgeInfo()).toEqual({
      apiBaseUrl: "",
      platform: "web",
      mode: "dev",
    });
    expect(buildApiUrl("/api/sessions")).toBe("/api/sessions");
  });

  it("builds absolute api URLs from the injected desktop bridge", () => {
    window.oysterworkflow = {
      runtime: {
        apiBaseUrl: "http://127.0.0.1:39321/",
        platform: "darwin",
        mode: "desktop",
      },
      desktop: {
        openPermissionSettings: async () => undefined,
        checkRecorderPermissions: async () => ({
          checkedAt: "2026-04-06T00:00:00.000Z",
          allGranted: true,
          canStartRecording: true,
          source: "host-app",
          summary: "ok",
          items: [],
        }),
        requestRecorderPermission: async () => true,
        requestMicrophoneAccess: async () => true,
        quitAndReopen: async () => true,
      },
    };

    expect(getRuntimeBridgeInfo()).toEqual({
      apiBaseUrl: "http://127.0.0.1:39321",
      platform: "darwin",
      mode: "desktop",
    });
    expect(hasDesktopPermissionRequestBridge()).toBe(true);
    expect(hasDesktopMicrophoneRequestBridge()).toBe(true);
    expect(hasDesktopQuitAndReopenBridge()).toBe(true);
    expect(buildApiUrl("/api/sessions")).toBe(
      "http://127.0.0.1:39321/api/sessions",
    );
  });

  it("opens Composio OAuth URLs through the desktop host and rejects non-HTTPS URLs", async () => {
    const openExternalUrlMock = vi.fn(async () => undefined);
    window.oysterworkflow = {
      desktop: {
        openExternalUrl: openExternalUrlMock,
      },
    };

    await expect(
      openExternalUrl("https://connect.composio.dev/conn-test"),
    ).resolves.toBeUndefined();
    expect(openExternalUrlMock).toHaveBeenCalledWith(
      "https://connect.composio.dev/conn-test",
    );
    await expect(
      openExternalUrl("http://connect.composio.dev/conn-test"),
    ).rejects.toThrow("Only HTTPS external URLs are allowed.");
  });

  it("calls the desktop host bridge when proactively requesting one recorder permission", async () => {
    const requestRecorderPermissionMock = vi.fn(async () => true);
    window.oysterworkflow = {
      runtime: {
        apiBaseUrl: "http://127.0.0.1:39321/",
        platform: "darwin",
        mode: "desktop",
      },
      desktop: {
        openPermissionSettings: async () => undefined,
        checkRecorderPermissions: async () => ({
          checkedAt: "2026-04-06T00:00:00.000Z",
          allGranted: false,
          canStartRecording: false,
          source: "host-app",
          summary: "needs screen recording",
          items: [],
        }),
        requestRecorderPermission: requestRecorderPermissionMock,
        requestMicrophoneAccess: async () => true,
      },
    };

    await expect(
      requestDesktopRecorderPermission("screen-recording"),
    ).resolves.toBe(true);
    expect(requestRecorderPermissionMock).toHaveBeenCalledWith(
      "screen-recording",
    );
  });

  it("calls the desktop host bridge when proactively requesting microphone access", async () => {
    const requestMicrophoneAccessMock = vi.fn(async () => true);
    window.oysterworkflow = {
      runtime: {
        apiBaseUrl: "http://127.0.0.1:39321/",
        platform: "darwin",
        mode: "desktop",
      },
      desktop: {
        openPermissionSettings: async () => undefined,
        checkRecorderPermissions: async () => ({
          checkedAt: "2026-04-06T00:00:00.000Z",
          allGranted: false,
          canStartRecording: false,
          source: "host-app",
          summary: "needs microphone",
          items: [],
        }),
        requestRecorderPermission: async () => true,
        requestMicrophoneAccess: requestMicrophoneAccessMock,
      },
    };

    await expect(requestDesktopMicrophoneAccess()).resolves.toBe(true);
    expect(requestMicrophoneAccessMock).toHaveBeenCalledTimes(1);
  });

  it("calls the desktop host bridge when quitting and reopening after permission changes", async () => {
    const quitAndReopenMock = vi.fn(async () => true);
    window.oysterworkflow = {
      desktop: {
        quitAndReopen: quitAndReopenMock,
      },
    };

    await expect(quitAndReopenDesktopApp()).resolves.toBeUndefined();
    expect(quitAndReopenMock).toHaveBeenCalledTimes(1);
  });
});
