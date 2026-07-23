import { describe, expect, it, vi } from "vitest";
import {
  createAuthCallbackQueue,
  isAuthenticationCallbackUrl,
} from "../desktop/auth-callback-queue.js";

describe("desktop authentication callback queue", () => {
  it("waits for authentication initialization before consuming callbacks", async () => {
    const handled: string[] = [];
    const queue = createAuthCallbackQueue({
      handleCallback: async (rawUrl) => {
        handled.push(rawUrl);
      },
    });

    expect(queue.enqueue(callbackUrl("first"))).toBe(true);
    await queue.flush();
    expect(handled).toEqual([]);

    await queue.markReady();
    expect(handled).toEqual([callbackUrl("first")]);
  });

  it("uses one ordered consumer when callbacks arrive from multiple entrypoints", async () => {
    let concurrentHandlers = 0;
    let peakConcurrentHandlers = 0;
    const handled: string[] = [];
    const queue = createAuthCallbackQueue({
      handleCallback: async (rawUrl) => {
        concurrentHandlers += 1;
        peakConcurrentHandlers = Math.max(
          peakConcurrentHandlers,
          concurrentHandlers,
        );
        await Promise.resolve();
        handled.push(new URL(rawUrl).searchParams.get("code") ?? "");
        concurrentHandlers -= 1;
      },
    });

    const ready = queue.markReady();
    queue.enqueue(callbackUrl("first"));
    queue.enqueue(callbackUrl("second"));
    await ready;
    await queue.flush();

    expect(handled).toEqual(["first", "second"]);
    expect(peakConcurrentHandlers).toBe(1);
  });

  it("deduplicates replayed callbacks and continues after one callback fails", async () => {
    const handled: string[] = [];
    const onCallbackError = vi.fn();
    const queue = createAuthCallbackQueue({
      handleCallback: async (rawUrl) => {
        const code = new URL(rawUrl).searchParams.get("code") ?? "";
        if (code === "bad") throw new Error("exchange failed");
        handled.push(code);
      },
      onCallbackError,
    });
    await queue.markReady();

    expect(queue.enqueue(callbackUrl("bad"))).toBe(true);
    expect(queue.enqueue(callbackUrl("bad"))).toBe(false);
    expect(queue.enqueue(callbackUrl("good"))).toBe(true);
    await queue.flush();

    expect(onCallbackError).toHaveBeenCalledOnce();
    expect(handled).toEqual(["good"]);
    expect(queue.enqueue(callbackUrl("bad"))).toBe(true);
    await queue.flush();
    expect(onCallbackError).toHaveBeenCalledTimes(2);
  });

  it("rejects lookalike or malformed callback URLs", () => {
    expect(isAuthenticationCallbackUrl(callbackUrl("ok"))).toBe(true);
    expect(
      isAuthenticationCallbackUrl(
        "oysterworkflow://auth/callback.evil?code=not-ours",
      ),
    ).toBe(false);
    expect(isAuthenticationCallbackUrl("not a url")).toBe(false);
  });
});

function callbackUrl(code: string): string {
  return `oysterworkflow://auth/callback?code=${code}`;
}
