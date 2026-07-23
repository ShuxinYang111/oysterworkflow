import { describe, expect, it, vi } from "vitest";
import { createDesktopRelaunchCoordinator } from "../desktop/relaunch-coordinator.js";

describe("desktop relaunch coordinator", () => {
  it("waits for graceful quit cleanup before scheduling the new instance", () => {
    let quitting = false;
    let scheduledQuit: (() => void) | null = null;
    const requestQuit = vi.fn(() => {
      quitting = true;
    });
    const relaunch = vi.fn();
    const coordinator = createDesktopRelaunchCoordinator({
      isQuitting: () => quitting,
      requestQuit,
      relaunch,
      scheduleQuit: (callback) => {
        scheduledQuit = callback;
      },
    });

    coordinator.requestRelaunch();
    expect(relaunch).not.toHaveBeenCalled();
    expect(requestQuit).not.toHaveBeenCalled();

    expect(scheduledQuit).not.toBeNull();
    (scheduledQuit as unknown as () => void)();
    expect(requestQuit).toHaveBeenCalledTimes(1);
    expect(relaunch).not.toHaveBeenCalled();

    expect(coordinator.relaunchBeforeExit()).toBe(true);
    expect(relaunch).toHaveBeenCalledTimes(1);
    expect(coordinator.relaunchBeforeExit()).toBe(false);
  });

  it("recovers a macOS reopen that hits the old instance during shutdown", () => {
    let quitting = true;
    const relaunch = vi.fn();
    const coordinator = createDesktopRelaunchCoordinator({
      isQuitting: () => quitting,
      requestQuit: vi.fn(),
      relaunch,
      scheduleQuit: vi.fn(),
    });

    expect(coordinator.recoverSecondInstanceDuringQuit()).toBe(true);
    expect(coordinator.relaunchBeforeExit()).toBe(true);
    expect(relaunch).toHaveBeenCalledTimes(1);

    quitting = false;
    expect(coordinator.recoverSecondInstanceDuringQuit()).toBe(false);
  });

  it("coalesces repeated relaunch requests into one quit", () => {
    const scheduled: Array<() => void> = [];
    const requestQuit = vi.fn();
    const coordinator = createDesktopRelaunchCoordinator({
      isQuitting: () => false,
      requestQuit,
      relaunch: vi.fn(),
      scheduleQuit: (callback) => scheduled.push(callback),
    });

    coordinator.requestRelaunch();
    coordinator.requestRelaunch();
    expect(scheduled).toHaveLength(1);
    scheduled[0]?.();
    expect(requestQuit).toHaveBeenCalledTimes(1);
  });
});
