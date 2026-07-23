import { RUNTIME_API_SECRET_HEADER } from "../src/runtime/config.js";

export interface LoopbackRuntimeRequestInput {
  url: string | URL;
  apiSecret: string;
  timeoutMs: number;
  signal?: AbortSignal;
  init?: RequestInit;
  fetchFn?: typeof fetch;
}

export interface LoopbackRuntimeResponse {
  ok: boolean;
  status: number;
  headers: Headers;
  bodyText: string;
}

/**
 * EN: Performs one authenticated, bounded request to the loopback Runtime and consumes its body before settling.
 * 中文: 向回环 Runtime 发起一次带鉴权且有时限的请求，并在完成前读取响应体。
 * @param input destination, launch secret, deadline, cancellation, and fetch overrides.
 * @returns response status, headers, and text body.
 */
export async function requestLoopbackRuntime(
  input: LoopbackRuntimeRequestInput,
): Promise<LoopbackRuntimeResponse> {
  const url = new URL(input.url);
  assertLoopbackRuntimeUrl(url);
  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) {
    throw new Error("Runtime request timeout must be a positive number.");
  }
  if (!input.apiSecret.trim()) {
    throw new Error("Runtime request secret is unavailable.");
  }

  const controller = new AbortController();
  let timedOut = false;
  const handleParentAbort = () => controller.abort(input.signal?.reason);
  input.signal?.addEventListener("abort", handleParentAbort, { once: true });
  if (input.signal?.aborted) {
    handleParentAbort();
  }
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("Runtime request timed out."));
  }, input.timeoutMs);

  try {
    const headers = new Headers(input.init?.headers);
    headers.set(RUNTIME_API_SECRET_HEADER, input.apiSecret);
    const response = await (input.fetchFn ?? fetch)(url, {
      ...input.init,
      headers,
      signal: controller.signal,
    });
    const bodyText = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      headers: response.headers,
      bodyText,
    };
  } catch (error) {
    if (timedOut) {
      throw new Error(
        `Local Runtime request timed out after ${String(input.timeoutMs)} ms. / 本地 Runtime 请求超时。`,
        { cause: error },
      );
    }
    if (input.signal?.aborted) {
      throw new Error(
        "Local Runtime request was cancelled. / 本地 Runtime 请求已取消。",
        {
          cause: error,
        },
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", handleParentAbort);
  }
}

function assertLoopbackRuntimeUrl(url: URL): void {
  if (
    url.protocol !== "http:" ||
    (url.hostname !== "127.0.0.1" &&
      url.hostname !== "[::1]" &&
      url.hostname !== "::1")
  ) {
    throw new Error("Only an HTTP loopback Runtime URL is allowed.");
  }
}
