import { afterEach, describe, expect, it, vi } from "vitest";
import { withAsyncDeadline } from "../src/async-deadline";

const runtimeEnvMock = vi.hoisted(() => ({
  buildApiUrl: vi.fn((path: string) => `http://127.0.0.1:3031${path}`),
  requestAuthenticatedDesktopRuntime: vi.fn(),
}));

vi.mock("../src/runtime-env", () => runtimeEnvMock);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("renderer-owned async deadlines", () => {
  it("rejects an operation that never settles with recoverable bilingual copy", async () => {
    vi.useFakeTimers();
    const request = withAsyncDeadline(
      () => new Promise<never>(() => undefined),
      { timeoutMs: 25, timeoutMessage: "Try again. / 请重试。" },
    );
    const assertion = expect(request).rejects.toThrow("Try again. / 请重试。");

    await vi.advanceTimersByTimeAsync(25);
    await assertion;
  });

  it("times out a stuck Electron IPC request and allows a later retry", async () => {
    vi.useFakeTimers();
    runtimeEnvMock.requestAuthenticatedDesktopRuntime
      .mockReturnValueOnce(new Promise<never>(() => undefined))
      .mockResolvedValueOnce({ status: 200, body: '{"ready":true}' });
    const { runtimeJsonRequest } = await import("../src/runtime-request");

    const first = runtimeJsonRequest<{ ready: boolean }>(
      "/api/slow",
      {},
      {
        timeoutMs: 20,
      },
    );
    const firstAssertion = expect(first).rejects.toThrow(/响应超时/u);
    await vi.advanceTimersByTimeAsync(20);
    await firstAssertion;

    await expect(
      runtimeJsonRequest<{ ready: boolean }>(
        "/api/slow",
        {},
        { timeoutMs: 20 },
      ),
    ).resolves.toEqual({ ready: true });
  });

  it("honors caller cancellation even when an IPC operation ignores its signal", async () => {
    const controller = new AbortController();
    const request = withAsyncDeadline(
      () => new Promise<never>(() => undefined),
      { timeoutMs: 60_000, signal: controller.signal },
    );
    controller.abort(new DOMException("Cancelled by caller", "AbortError"));

    await expect(request).rejects.toThrow("Cancelled by caller");
  });

  it("forwards PATCH through the authenticated desktop Runtime transport", async () => {
    runtimeEnvMock.requestAuthenticatedDesktopRuntime.mockReset();
    runtimeEnvMock.requestAuthenticatedDesktopRuntime.mockResolvedValueOnce({
      status: 200,
      body: '{"saved":true}',
    });
    const { runtimeJsonRequest } = await import("../src/runtime-request");

    await expect(
      runtimeJsonRequest<{ saved: boolean }>(
        "/api/product/workflows/wf/graph",
        {
          method: "PATCH",
          body: '{"expectedRevisionId":"revision-1"}',
        },
      ),
    ).resolves.toEqual({ saved: true });
    expect(
      runtimeEnvMock.requestAuthenticatedDesktopRuntime,
    ).toHaveBeenLastCalledWith(
      {
        path: "/api/product/workflows/wf/graph",
        method: "PATCH",
        body: '{"expectedRevisionId":"revision-1"}',
      },
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
  });

  it("preserves the HTTP status on Runtime errors", async () => {
    runtimeEnvMock.requestAuthenticatedDesktopRuntime.mockReset();
    runtimeEnvMock.requestAuthenticatedDesktopRuntime.mockResolvedValueOnce({
      status: 409,
      body: '{"error":{"message":"Revision changed. / 版本已变化。"}}',
    });
    const { runtimeJsonRequest } = await import("../src/runtime-request");

    await expect(
      runtimeJsonRequest("/api/product/workflows/wf/graph", {
        method: "PATCH",
      }),
    ).rejects.toMatchObject({
      name: "RuntimeRequestError",
      status: 409,
      message: "Revision changed. / 版本已变化。",
    });
  });
});
