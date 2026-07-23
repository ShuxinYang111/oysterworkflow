import { describe, expect, it, vi } from "vitest";
import { terminateWindowsProcessTree } from "../src/process/windows-tree.js";

describe("Windows process-tree termination", () => {
  it("runs taskkill with a bounded whole-tree force request", async () => {
    const execFile = vi.fn(async () => undefined);

    await expect(
      terminateWindowsProcessTree(4_321, 1_234, {
        platform: "win32",
        execFile,
      }),
    ).resolves.toBe(true);

    expect(execFile).toHaveBeenCalledWith(
      "taskkill.exe",
      ["/PID", "4321", "/T", "/F"],
      {
        timeout: 1_234,
        killSignal: "SIGKILL",
        windowsHide: true,
        maxBuffer: 64 * 1024,
      },
    );
  });

  it("returns false when taskkill fails without leaking the error", async () => {
    const execFile = vi.fn(async () => {
      throw new Error("taskkill failed");
    });

    await expect(
      terminateWindowsProcessTree(99, 500, {
        platform: "win32",
        execFile,
      }),
    ).resolves.toBe(false);
    expect(execFile).toHaveBeenCalledOnce();
  });

  it("does not invoke taskkill outside Windows or for an invalid pid", async () => {
    const execFile = vi.fn(async () => undefined);

    await expect(
      terminateWindowsProcessTree(123, 500, {
        platform: "darwin",
        execFile,
      }),
    ).resolves.toBe(false);
    await expect(
      terminateWindowsProcessTree(0, 500, {
        platform: "win32",
        execFile,
      }),
    ).resolves.toBe(false);
    expect(execFile).not.toHaveBeenCalled();
  });
});
