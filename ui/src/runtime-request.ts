import { buildApiUrl, requestAuthenticatedDesktopRuntime } from "./runtime-env";
import {
  DEFAULT_UI_REQUEST_TIMEOUT_MS,
  withAsyncDeadline,
} from "./async-deadline";

interface RuntimeJsonRequestOptions {
  fallbackErrorMessage?: (status: number) => string;
  timeoutMs?: number;
  timeoutMessage?: string;
}

const DEFAULT_ERROR_MESSAGE = (status: number): string =>
  `The local OysterWorkflow service could not complete the request (HTTP ${status}). / 本地 OysterWorkflow 服务未能完成请求（HTTP ${status}）。`;

export class RuntimeRequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "RuntimeRequestError";
    this.status = status;
  }
}

/**
 * EN: Checks a failed Runtime request without parsing user-facing copy.
 * 中文: 不依赖用户文案解析，判断 Runtime 请求是否为指定 HTTP 状态。
 * @param error caught request error.
 * @param status expected HTTP status.
 * @returns whether the error came from that HTTP response status.
 */
export function isRuntimeRequestStatus(
  error: unknown,
  status: number,
): boolean {
  return error instanceof RuntimeRequestError && error.status === status;
}

/**
 * EN: Sends a JSON request to the local Runtime and extracts consistent error messages.
 * @param path runtime API path.
 * @param init fetch options.
 * @param options request-level error formatting options.
 * @returns parsed JSON response body.
 */
export async function runtimeJsonRequest<T>(
  path: string,
  init: RequestInit = {},
  options: RuntimeJsonRequestOptions = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_UI_REQUEST_TIMEOUT_MS;
  const timeoutMessage =
    options.timeoutMessage ??
    "The local OysterWorkflow service did not respond in time. Try again. / 本地 OysterWorkflow 服务响应超时，请重试。";
  const result = await withAsyncDeadline(
    async (deadlineSignal) => {
      const desktopResponse = await requestAuthenticatedDesktopRuntime(
        {
          path,
          method: normalizeMethod(init.method),
          body: normalizeBody(init.body),
        },
        {
          signal: deadlineSignal,
          timeoutMs,
        },
      );
      const response = desktopResponse
        ? {
            ok: desktopResponse.status >= 200 && desktopResponse.status < 300,
            status: desktopResponse.status,
          }
        : await fetch(buildApiUrl(path), {
            ...init,
            headers,
            signal: deadlineSignal,
          });
      const text = desktopResponse
        ? desktopResponse.body
        : await (response as Response).text();
      return { response, text };
    },
    {
      timeoutMs,
      timeoutMessage,
      signal: init.signal,
    },
  );
  const parsed = result.text ? (JSON.parse(result.text) as unknown) : null;

  if (!result.response.ok) {
    throw new RuntimeRequestError(
      readRuntimeErrorMessage(parsed) ??
        options.fallbackErrorMessage?.(result.response.status) ??
        DEFAULT_ERROR_MESSAGE(result.response.status),
      result.response.status,
    );
  }

  return parsed as T;
}

function normalizeMethod(
  value: string | undefined,
): "GET" | "POST" | "PUT" | "PATCH" | "DELETE" {
  const normalized = (value ?? "GET").toUpperCase();
  if (
    normalized !== "GET" &&
    normalized !== "POST" &&
    normalized !== "PUT" &&
    normalized !== "PATCH" &&
    normalized !== "DELETE"
  ) {
    throw new Error(
      `Unsupported local Runtime request method: ${normalized}. / 不支持的本地 Runtime 请求方法：${normalized}。`,
    );
  }
  return normalized;
}

function normalizeBody(value: BodyInit | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error("Desktop Runtime requests require a JSON string body.");
  }
  return value;
}

function readRuntimeErrorMessage(parsed: unknown): string | null {
  if (typeof parsed !== "object" || parsed === null || !("error" in parsed)) {
    return null;
  }
  const message = (parsed as { error?: { message?: unknown } }).error?.message;
  return typeof message === "string" && message.trim() ? message : null;
}
