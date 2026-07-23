import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CloudRuntimeRequestInput,
  CloudRuntimeRequestResponse,
} from "../../src/cloud/contracts.js";
import { requestAuthenticatedDesktopRuntime } from "../src/runtime-env";

afterEach(() => {
  delete window.oysterworkflow;
});

describe("desktop Runtime IPC cancellation", () => {
  it("does not invoke main when the renderer signal was already aborted", async () => {
    const runtimeRequest =
      vi.fn<
        (
          input: CloudRuntimeRequestInput,
        ) => Promise<CloudRuntimeRequestResponse>
      >();
    const cancelRequest = vi.fn();
    window.oysterworkflow = {
      cloud: { runtimeRequest, cancelRequest },
    };
    const controller = new AbortController();
    controller.abort(new DOMException("Cancelled before invoke", "AbortError"));

    await expect(
      requestAuthenticatedDesktopRuntime(
        { path: "/api/product/state" },
        { signal: controller.signal, timeoutMs: 1_000 },
      ),
    ).rejects.toThrow("Cancelled before invoke");
    expect(runtimeRequest).not.toHaveBeenCalled();
    expect(cancelRequest).not.toHaveBeenCalled();
  });

  it("sends the request id to main when an in-flight request is aborted", async () => {
    const pending = deferred<CloudRuntimeRequestResponse>();
    const runtimeRequest = vi.fn(() => pending.promise);
    const cancelRequest = vi.fn();
    window.oysterworkflow = {
      cloud: { runtimeRequest, cancelRequest },
    };
    const controller = new AbortController();
    const request = requestAuthenticatedDesktopRuntime(
      { path: "/api/product/state" },
      { signal: controller.signal, timeoutMs: 1_000 },
    );
    const requestId = runtimeRequest.mock.calls[0]?.[0].requestId;

    controller.abort(new DOMException("Cancelled in flight", "AbortError"));

    await expect(request).rejects.toThrow("Cancelled in flight");
    expect(requestId).toMatch(/^renderer-/u);
    expect(cancelRequest).toHaveBeenCalledWith(requestId);
    pending.resolve({ status: 499, body: "" });
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
