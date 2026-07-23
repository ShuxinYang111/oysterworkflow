import { Buffer } from "node:buffer";
import type { LlmModelsResponse } from "./api-contracts.js";
import { buildLlmRequestHeaders } from "../llm/credentials.js";

export const LLM_MODEL_DISCOVERY_TIMEOUT_MS = 10_000;
const LLM_MODEL_DISCOVERY_MAX_BODY_BYTES = 2 * 1024 * 1024;

type LlmModelFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface DiscoverLlmModelsInput {
  baseUrl: string;
  apiKey: string | null;
  extraHeaders?: Record<string, string>;
}

export interface DiscoverLlmModelsOptions {
  fetchFn?: LlmModelFetch;
  timeoutMs?: number;
}

/**
 * EN: Builds the OpenAI-compatible model-list endpoint from a provider base URL.
 * 中文: 根据服务商 Base URL 构建 OpenAI-compatible 模型列表端点。
 * @param baseUrl user-provided provider base URL.
 * @returns normalized absolute model-list endpoint.
 */
export function buildLlmModelsEndpoint(baseUrl: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(baseUrl.trim());
  } catch {
    throw new Error("Base URL must be a valid absolute URL.");
  }

  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new Error("Base URL must use HTTP or HTTPS.");
  }
  if (endpoint.username || endpoint.password) {
    throw new Error("Base URL must not contain embedded credentials.");
  }
  if (endpoint.search || endpoint.hash) {
    throw new Error("Base URL must not contain a query string or fragment.");
  }

  const normalizedPath = endpoint.pathname.replace(/\/+$/u, "");
  endpoint.pathname = normalizedPath.endsWith("/models")
    ? normalizedPath
    : `${normalizedPath}/models`;
  return endpoint.toString();
}

/**
 * EN: Loads model identifiers from an OpenAI-compatible provider.
 * 中文: 从 OpenAI-compatible 服务商加载模型标识符。
 * @param input provider URL and already resolved optional API key.
 * @param options injectable fetch and timeout controls used by tests and Runtime.
 * @returns endpoint and de-duplicated model identifiers in provider order.
 */
export async function discoverLlmModels(
  input: DiscoverLlmModelsInput,
  options: DiscoverLlmModelsOptions = {},
): Promise<LlmModelsResponse> {
  const endpoint = buildLlmModelsEndpoint(input.baseUrl);
  const timeoutMs = options.timeoutMs ?? LLM_MODEL_DISCOVERY_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const headers = buildLlmRequestHeaders({
    apiKey: input.apiKey,
    extraHeaders: input.extraHeaders,
    baseHeaders: { Accept: "application/json" },
  });

  let response: Response;
  try {
    response = await (options.fetchFn ?? fetch)(endpoint, {
      method: "GET",
      headers,
      redirect: "error",
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeout);
    if (controller.signal.aborted) {
      throw new Error(`Model list request timed out after ${timeoutMs} ms.`);
    }
    throw new Error(`Model list request failed: ${toErrorMessage(error)}`);
  }

  let body: string;
  try {
    const contentLength = Number(response.headers.get("content-length"));
    if (
      Number.isFinite(contentLength) &&
      contentLength > LLM_MODEL_DISCOVERY_MAX_BODY_BYTES
    ) {
      throw new Error("Model list response is too large.");
    }

    body = await response.text();
    if (Buffer.byteLength(body, "utf8") > LLM_MODEL_DISCOVERY_MAX_BODY_BYTES) {
      throw new Error("Model list response is too large.");
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Model list request timed out after ${timeoutMs} ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    const detail = readUpstreamError(body);
    throw new Error(
      `Model list request returned HTTP ${response.status}${detail ? `: ${detail}` : "."}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("Model list response is not valid JSON.");
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.data)) {
    throw new Error(
      "Model list response must contain an OpenAI-compatible data array.",
    );
  }

  const models = Array.from(
    new Set(
      parsed.data.flatMap((entry) => {
        if (!isRecord(entry) || typeof entry.id !== "string") {
          return [];
        }
        const id = entry.id.trim();
        return id ? [id] : [];
      }),
    ),
  );
  return { endpoint, models };
}

function readUpstreamError(body: string): string | null {
  const trimmed = body.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (isRecord(parsed) && isRecord(parsed.error)) {
      const message = parsed.error.message;
      if (typeof message === "string" && message.trim()) {
        return truncateErrorDetail(message.trim());
      }
    }
  } catch {
    // EN: Plain-text upstream errors are handled below.
    // 中文: 纯文本上游错误在下方统一处理。
  }

  return truncateErrorDetail(trimmed);
}

function truncateErrorDetail(value: string): string {
  return value.length > 300 ? `${value.slice(0, 297)}...` : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
