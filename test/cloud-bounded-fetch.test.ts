import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeadlineFetch } from "../src/cloud/bounded-fetch.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("deadline fetch", () => {
  it("merges caller cancellation into the signal passed to the underlying fetch", async () => {
    let receivedSignal: AbortSignal | null = null;
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          receivedSignal = init?.signal ?? null;
          receivedSignal?.addEventListener(
            "abort",
            () => reject(receivedSignal?.reason),
            { once: true },
          );
        }),
    ) as unknown as typeof fetch;
    const boundedFetch = createDeadlineFetch({
      timeoutMs: 10_000,
      timeoutMessage: "deadline",
      fetchImpl,
    });
    const caller = new AbortController();
    const request = boundedFetch("https://example.test", {
      signal: caller.signal,
    });

    caller.abort(new DOMException("caller cancelled", "AbortError"));

    await expect(request).rejects.toThrow("caller cancelled");
    expect(receivedSignal).not.toBe(caller.signal);
    expect((receivedSignal as unknown as AbortSignal).aborted).toBe(true);
  });

  it("aborts the underlying fetch when the hard deadline expires", async () => {
    vi.useFakeTimers();
    let receivedSignal: AbortSignal | null = null;
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          receivedSignal = init?.signal ?? null;
          receivedSignal?.addEventListener(
            "abort",
            () => reject(receivedSignal?.reason),
            { once: true },
          );
        }),
    ) as unknown as typeof fetch;
    const boundedFetch = createDeadlineFetch({
      timeoutMs: 25,
      timeoutMessage: "network deadline reached",
      fetchImpl,
    });
    const request = boundedFetch("https://example.test");
    const assertion = expect(request).rejects.toThrow(
      "network deadline reached",
    );

    await vi.advanceTimersByTimeAsync(25);
    await assertion;
    expect((receivedSignal as unknown as AbortSignal).aborted).toBe(true);
  });
});
