import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const systemPreferencesMock = {
  askForMediaAccess: vi.fn(),
  getMediaAccessStatus: vi.fn(),
  isTrustedAccessibilityClient: vi.fn(),
};
const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
  process,
  "platform",
);

vi.mock("electron", () => ({
  systemPreferences: systemPreferencesMock,
}));

describe.sequential("desktop recorder permissions", () => {
  beforeEach(() => {
    vi.resetModules();
    setProcessPlatform("darwin");
    systemPreferencesMock.askForMediaAccess.mockReset();
    systemPreferencesMock.getMediaAccessStatus.mockReset();
    systemPreferencesMock.isTrustedAccessibilityClient.mockReset();
    systemPreferencesMock.askForMediaAccess.mockResolvedValue(true);
    systemPreferencesMock.getMediaAccessStatus.mockReturnValue("granted");
    systemPreferencesMock.isTrustedAccessibilityClient.mockReturnValue(true);
  });

  afterEach(() => {
    vi.clearAllMocks();
    restoreProcessPlatform();
  });

  it("leaves input monitoring for the real recorder to verify without requiring Swift", async () => {
    const { checkDesktopRecorderPermissions } =
      await import("../desktop/permissions.js");
    const result = await checkDesktopRecorderPermissions();

    expect(result.source).toBe("host-app");
    expect(result.allGranted).toBe(false);
    expect(result.canStartRecording).toBe(true);
    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "input-monitoring",
          state: "unknown",
        }),
      ]),
    );
  });

  it("reports screen recording as missing without compiling a runtime probe", async () => {
    systemPreferencesMock.getMediaAccessStatus.mockImplementation((kind) =>
      kind === "screen" ? "denied" : "granted",
    );
    const { checkDesktopRecorderPermissions } =
      await import("../desktop/permissions.js");
    const result = await checkDesktopRecorderPermissions();

    expect(result.canStartRecording).toBe(false);
    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "screen-recording",
          state: "missing",
        }),
      ]),
    );
  });

  it("treats microphone access as missing when macOS denies the packaged app", async () => {
    systemPreferencesMock.getMediaAccessStatus.mockImplementation((kind) =>
      kind === "microphone" ? "denied" : "granted",
    );

    const { checkDesktopRecorderPermissions } =
      await import("../desktop/permissions.js");
    const result = await checkDesktopRecorderPermissions();

    expect(result.allGranted).toBe(false);
    expect(result.canStartRecording).toBe(false);
    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "microphone",
          state: "missing",
        }),
      ]),
    );
  });

  it("requests microphone access from macOS when the status is not determined", async () => {
    systemPreferencesMock.getMediaAccessStatus.mockImplementation((kind) =>
      kind === "microphone" ? "not-determined" : "granted",
    );

    const { requestDesktopMicrophoneAccess } =
      await import("../desktop/permissions.js");
    await expect(requestDesktopMicrophoneAccess()).resolves.toBe(true);
    expect(systemPreferencesMock.askForMediaAccess).toHaveBeenCalledWith(
      "microphone",
    );
  });

  it("does not require the macOS permission gate on Windows", async () => {
    setProcessPlatform("win32");

    const { checkDesktopRecorderPermissions } =
      await import("../desktop/permissions.js");
    const result = await checkDesktopRecorderPermissions();

    expect(result.source).toBe("not-needed");
    expect(result.allGranted).toBe(true);
    expect(result.summary).toBe("");
  });
});

function setProcessPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  });
}

function restoreProcessPlatform(): void {
  if (originalPlatformDescriptor) {
    Object.defineProperty(process, "platform", originalPlatformDescriptor);
  }
}
