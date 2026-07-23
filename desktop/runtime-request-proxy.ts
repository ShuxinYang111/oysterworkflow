import type { CloudRuntimeRequestMethod } from "../src/cloud/contracts.js";

const ALLOWED_RUNTIME_REQUEST_METHODS = new Set<CloudRuntimeRequestMethod>([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

/**
 * EN: Validates one renderer-provided HTTP method before proxying it locally.
 * 中文: 在代理到本地 Runtime 前校验 renderer 提供的 HTTP method。
 * @param value untrusted method from the renderer IPC payload.
 * @returns an allow-listed local Runtime request method.
 */
export function normalizeRuntimeRequestMethod(
  value: unknown,
): CloudRuntimeRequestMethod {
  if (value !== undefined && typeof value !== "string") {
    throw new Error(
      "Unsupported local Runtime request method payload. / 本地 Runtime 请求方法格式无效。",
    );
  }
  const normalized = (value ?? "GET").toUpperCase();
  if (
    !ALLOWED_RUNTIME_REQUEST_METHODS.has(
      normalized as CloudRuntimeRequestMethod,
    )
  ) {
    throw new Error(
      `Unsupported local Runtime request method: ${normalized}. / 不支持的本地 Runtime 请求方法：${normalized}。`,
    );
  }
  return normalized as CloudRuntimeRequestMethod;
}

/**
 * EN: Validates renderer-provided paths before Electron main proxies them to the local Runtime.
 * 中文: 在 Electron main 将 renderer 请求代理到本地 Runtime 前校验路径。
 * @param value renderer-provided local API path.
 * @returns normalized path and query string constrained to the local API.
 */
export function normalizeRuntimeRequestPath(value: string): string {
  const normalized = value.trim();
  if (!normalized.startsWith("/api/") || normalized.startsWith("//")) {
    throw new Error("Only local OysterWorkflow API paths are allowed.");
  }
  const parsed = new URL(normalized, "http://127.0.0.1");
  if (parsed.origin !== "http://127.0.0.1") {
    throw new Error("Only local OysterWorkflow API paths are allowed.");
  }
  if (!parsed.pathname.startsWith("/api/")) {
    throw new Error("Only local OysterWorkflow API paths are allowed.");
  }
  return `${parsed.pathname}${parsed.search}`;
}

const RUNTIME_REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;

export function normalizeRuntimeRequestId(value: unknown): string {
  if (typeof value !== "string" || !RUNTIME_REQUEST_ID_PATTERN.test(value)) {
    throw new Error("Invalid local Runtime request identifier.");
  }
  return value;
}

export function normalizeRuntimeRequestTimeout(
  value: unknown,
  fallbackMs: number,
  maximumMs = 900_000,
): number {
  if (!Number.isFinite(fallbackMs) || fallbackMs <= 0) {
    throw new Error("Runtime request timeout fallback must be positive.");
  }
  if (!Number.isFinite(maximumMs) || maximumMs < fallbackMs) {
    throw new Error("Runtime request timeout maximum is invalid.");
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return Math.floor(fallbackMs);
  }
  return Math.min(maximumMs, Math.max(1, Math.floor(value)));
}

export interface RuntimeRequestAbortLease {
  signal: AbortSignal;
  release: () => void;
}

export class RuntimeRequestAbortRegistry {
  private readonly controllers = new Map<string, AbortController>();

  acquire(
    rawRequestId: unknown,
    parentSignal?: AbortSignal,
  ): RuntimeRequestAbortLease {
    const requestId = normalizeRuntimeRequestId(rawRequestId);
    if (this.controllers.has(requestId)) {
      throw new Error(
        "A local Runtime request with this identifier is active.",
      );
    }
    const controller = new AbortController();
    const handleParentAbort = () => controller.abort(parentSignal?.reason);
    if (parentSignal?.aborted) {
      handleParentAbort();
    } else {
      parentSignal?.addEventListener("abort", handleParentAbort, {
        once: true,
      });
    }
    this.controllers.set(requestId, controller);
    let released = false;
    return {
      signal: controller.signal,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        parentSignal?.removeEventListener("abort", handleParentAbort);
        if (this.controllers.get(requestId) === controller) {
          this.controllers.delete(requestId);
        }
      },
    };
  }

  cancel(rawRequestId: unknown, reason?: unknown): boolean {
    const requestId = normalizeRuntimeRequestId(rawRequestId);
    const controller = this.controllers.get(requestId);
    if (!controller) {
      return false;
    }
    controller.abort(
      reason ??
        new Error(
          "Renderer cancelled the local Runtime request. / Renderer 已取消本地 Runtime 请求。",
        ),
    );
    return true;
  }
}
