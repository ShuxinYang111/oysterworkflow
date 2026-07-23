import { afterEach, describe, expect, it, vi } from "vitest";

const windowsTreeMocks = vi.hoisted(() => ({
  terminateWindowsProcessTree: vi.fn(),
}));

vi.mock("../src/process/windows-tree.js", () => windowsTreeMocks);

import { signalProcessGroup } from "../src/process/child-process.js";

const originalPlatform = process.platform;

afterEach(() => {
  vi.restoreAllMocks();
  windowsTreeMocks.terminateWindowsProcessTree.mockReset();
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: originalPlatform,
  });
});

describe("shared child-process signaling", () => {
  it("signals a detached process group before the direct child", () => {
    const processKill = vi.spyOn(process, "kill").mockReturnValue(true);
    const child = {
      pid: 42,
      kill: vi.fn().mockReturnValue(true),
    };

    expect(signalProcessGroup(child, "SIGTERM", true)).toBe(true);
    expect(processKill).toHaveBeenCalledWith(-42, "SIGTERM");
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("falls back to the direct child when its process group is gone", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("missing process group");
    });
    const child = {
      pid: 42,
      kill: vi.fn().mockReturnValue(true),
    };

    expect(signalProcessGroup(child, "SIGTERM", true)).toBe(true);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("uses Windows tree termination before direct SIGKILL fallback", async () => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "win32",
    });
    windowsTreeMocks.terminateWindowsProcessTree.mockResolvedValue(false);
    const child = {
      pid: 42,
      kill: vi.fn().mockReturnValue(true),
    };

    expect(signalProcessGroup(child, "SIGKILL", false)).toBe(true);
    await vi.waitFor(() => {
      expect(windowsTreeMocks.terminateWindowsProcessTree).toHaveBeenCalledWith(
        42,
      );
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    });
  });
});
