import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForShutdownDeadline } from "../desktop/shutdown-deadline.js";

describe("desktop shutdown deadline", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports graceful cleanup that completes before the deadline", async () => {
    await expect(
      waitForShutdownDeadline(Promise.resolve(), 5_000),
    ).resolves.toEqual({ status: "completed" });
  });

  it("releases the OS quit flow when Runtime cleanup remains stuck", async () => {
    vi.useFakeTimers();
    const result = waitForShutdownDeadline(new Promise<void>(() => {}), 5_000);

    await vi.advanceTimersByTimeAsync(5_000);

    await expect(result).resolves.toEqual({ status: "timed-out" });
  });

  it("returns cleanup failures without leaking an unhandled rejection", async () => {
    const error = new Error("runtime close failed");

    await expect(
      waitForShutdownDeadline(Promise.reject(error), 5_000),
    ).resolves.toEqual({ status: "failed", error });
  });
});
