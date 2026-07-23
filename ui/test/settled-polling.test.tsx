import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startSettledPolling, useSettledPolling } from "../src/settled-polling";

afterEach(() => {
  vi.useRealTimers();
});

describe("settled polling", () => {
  it("waits for the active request to settle before scheduling another", async () => {
    vi.useFakeTimers();
    const first = deferred<void>();
    const poll = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(undefined);

    renderHook(() =>
      useSettledPolling({
        enabled: true,
        intervalMs: 2_000,
        restartKey: "connection-a",
        poll,
      }),
    );
    await act(async () => Promise.resolve());
    expect(poll).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(poll).toHaveBeenCalledTimes(1);

    await act(async () => {
      first.resolve();
      await first.promise;
    });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(poll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it("invalidates a previous generation when the polling identity changes", async () => {
    vi.useFakeTimers();
    const oldRequest = deferred<void>();
    const poll = vi
      .fn()
      .mockReturnValueOnce(oldRequest.promise)
      .mockResolvedValue(undefined);
    const { rerender } = renderHook(
      ({ restartKey }) =>
        useSettledPolling({
          enabled: true,
          intervalMs: 100,
          restartKey,
          poll,
        }),
      { initialProps: { restartKey: "old" } },
    );
    await act(async () => Promise.resolve());
    rerender({ restartKey: "new" });
    await act(async () => Promise.resolve());
    expect(poll).toHaveBeenCalledTimes(2);

    await act(async () => {
      oldRequest.resolve();
      await oldRequest.promise;
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(poll).toHaveBeenCalledTimes(3);
  });

  it("stops an imperative loop without scheduling after a late request settles", async () => {
    vi.useFakeTimers();
    const pending = deferred<void>();
    let wasCurrentAfterStop = true;
    const poll = vi.fn(async ({ isCurrent }: { isCurrent: () => boolean }) => {
      await pending.promise;
      wasCurrentAfterStop = isCurrent();
    });
    const controller = startSettledPolling({ intervalMs: 750, poll });
    expect(poll).toHaveBeenCalledTimes(1);

    controller.stop();
    pending.resolve();
    await pending.promise;
    await vi.advanceTimersByTimeAsync(5_000);

    expect(wasCurrentAfterStop).toBe(false);
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it("can preserve an interval's original first-delay behavior", async () => {
    vi.useFakeTimers();
    const poll = vi.fn().mockResolvedValue(undefined);

    renderHook(() =>
      useSettledPolling({
        enabled: true,
        intervalMs: 3_000,
        restartKey: "delayed",
        runImmediately: false,
        poll,
      }),
    );
    expect(poll).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(poll).toHaveBeenCalledTimes(1);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
