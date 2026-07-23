import { describe, expect, it, vi } from "vitest";
import {
  restartChromeAfterDebugPermission,
  type ChromeDevToolsState,
} from "../src/product/chrome-restart.js";

describe("Chrome debug permission restart", () => {
  it("does nothing outside macOS", async () => {
    const terminateChromeProcesses = vi.fn(async () => undefined);

    await expect(
      restartChromeAfterDebugPermission({
        platform: "linux",
        terminateChromeProcesses,
      }),
    ).resolves.toBe(false);
    expect(terminateChromeProcesses).not.toHaveBeenCalled();
  });

  it("does nothing until Chrome has published an approved debug endpoint", async () => {
    const terminateChromeProcesses = vi.fn(async () => undefined);

    await expect(
      restartChromeAfterDebugPermission({
        platform: "darwin",
        terminateChromeProcesses,
        readDevToolsState: async () => null,
      }),
    ).resolves.toBe(false);
    expect(terminateChromeProcesses).not.toHaveBeenCalled();
  });

  it("quits and reopens Chrome once, then waits for a new browser endpoint", async () => {
    const before: ChromeDevToolsState = {
      port: 9222,
      browserPath: "/devtools/browser/before",
    };
    const after: ChromeDevToolsState = {
      port: 9222,
      browserPath: "/devtools/browser/after",
    };
    const states = [before, before, after];
    const processIdSnapshots = [[42], [42], [], [84]];
    const terminateChromeProcesses = vi.fn(async () => undefined);
    const launchChrome = vi.fn(async () => undefined);
    const delay = vi.fn(async () => undefined);

    await expect(
      restartChromeAfterDebugPermission({
        platform: "darwin",
        listChromeProcessIds: async () => processIdSnapshots.shift() ?? [84],
        terminateChromeProcesses,
        launchChrome,
        delay,
        readDevToolsState: async () => states.shift() ?? after,
      }),
    ).resolves.toBe(true);
    expect(terminateChromeProcesses).toHaveBeenCalledWith([42]);
    expect(launchChrome).toHaveBeenCalledTimes(1);
    expect(delay).toHaveBeenCalledWith(2_000);
  });

  it("returns false when Chrome cannot be restarted", async () => {
    const terminateChromeProcesses = vi.fn(async () => {
      throw new Error("Chrome did not quit");
    });

    await expect(
      restartChromeAfterDebugPermission({
        platform: "darwin",
        listChromeProcessIds: async () => [42],
        terminateChromeProcesses,
        delay: async () => undefined,
        readDevToolsState: async () => ({
          port: 9222,
          browserPath: "/devtools/browser/before",
        }),
      }),
    ).resolves.toBe(false);
  });

  it("does not launch a second Chrome instance while the old process is still running", async () => {
    const launchChrome = vi.fn(async () => undefined);

    await expect(
      restartChromeAfterDebugPermission({
        platform: "darwin",
        listChromeProcessIds: async () => [42],
        terminateChromeProcesses: async () => undefined,
        launchChrome,
        delay: async () => undefined,
        readDevToolsState: async () => ({
          port: 9222,
          browserPath: "/devtools/browser/before",
        }),
      }),
    ).resolves.toBe(false);
    expect(launchChrome).not.toHaveBeenCalled();
  });
});
