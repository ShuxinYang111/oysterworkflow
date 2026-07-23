import { describe, expect, it, vi } from "vitest";
import { requestLoopbackRuntime } from "../desktop/loopback-runtime-client.js";
import { RUNTIME_API_SECRET_HEADER } from "../src/runtime/config.js";

describe("desktop loopback Runtime client", () => {
  it("adds the launch secret and consumes the response body", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );
    const response = await requestLoopbackRuntime({
      url: "http://127.0.0.1:3034/api/health",
      apiSecret: "launch-secret-with-enough-length",
      timeoutMs: 1_000,
      fetchFn,
    });

    expect(response).toMatchObject({
      ok: true,
      status: 200,
      bodyText: '{"ok":true}',
    });
    const headers = new Headers(
      (fetchFn.mock.calls[0]?.[1] as RequestInit).headers,
    );
    expect(headers.get(RUNTIME_API_SECRET_HEADER)).toBe(
      "launch-secret-with-enough-length",
    );
  });

  it("rejects non-loopback destinations before invoking fetch", async () => {
    const fetchFn = vi.fn();
    await expect(
      requestLoopbackRuntime({
        url: "https://attacker.example/api/health",
        apiSecret: "launch-secret-with-enough-length",
        timeoutMs: 1_000,
        fetchFn,
      }),
    ).rejects.toThrow("Only an HTTP loopback Runtime URL is allowed.");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("aborts both fetch and response-body reads at the deadline", async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(init.signal?.reason);
          });
        }),
    );
    const request = requestLoopbackRuntime({
      url: "http://127.0.0.1:3034/api/health",
      apiSecret: "launch-secret-with-enough-length",
      timeoutMs: 50,
      fetchFn: fetchFn as typeof fetch,
    });
    const rejection = expect(request).rejects.toThrow(
      "Local Runtime request timed out after 50 ms.",
    );

    await vi.advanceTimersByTimeAsync(50);
    await rejection;
    vi.useRealTimers();
  });
});
