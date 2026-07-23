import type {
  ProductHermesProviderConnectionStatus,
  ProductHermesProviderHealth,
} from "./contracts.js";

export const OYSTERWORKFLOW_PROVIDER_STATUS_MARKER =
  "OYSTERWORKFLOW_PROVIDER_STATUS";

/**
 * EN: Builds the default provider health object used before Hermes has emitted provider telemetry.
 * 中文: 构建默认 provider 健康状态，用于 Hermes 尚未上报 provider 遥测之前。
 * @returns neutral provider health state for product storage and UI.
 */
export function defaultHermesProviderHealth(): ProductHermesProviderHealth {
  return {
    status: "unknown",
    kind: null,
    recoverability: null,
    provider: null,
    model: null,
    message: null,
    retryable: null,
    retryCount: null,
    maxRetries: null,
    statusCode: null,
    checkedAt: null,
  };
}

/**
 * EN: Converts untrusted persisted or protocol data into the stable product contract.
 * 中文: 将不可信的持久化数据或协议数据转换为稳定的产品契约。
 * @param value value read from storage or Hermes protocol output.
 * @returns normalized provider health object safe to store and render.
 */
export function normalizeHermesProviderHealth(
  value: unknown,
): ProductHermesProviderHealth {
  const fallback = defaultHermesProviderHealth();
  if (!isRecord(value)) {
    return fallback;
  }
  return {
    status: normalizeStatus(value.status),
    kind: nullableString(value.kind),
    recoverability: nullableString(value.recoverability),
    provider: nullableString(value.provider),
    model: nullableString(value.model),
    message: nullableString(value.message),
    retryable: nullableBoolean(value.retryable),
    retryCount: nullableFiniteNumber(value.retryCount),
    maxRetries: nullableFiniteNumber(value.maxRetries),
    statusCode: nullableFiniteNumber(value.statusCode),
    checkedAt: nullableString(value.checkedAt),
  };
}

/**
 * EN: Parses Hermes provider status protocol lines emitted by the OysterWorkflow plugin.
 * 中文: 解析 OysterWorkflow 插件发出的 Hermes provider 状态协议行。
 * @param line one stdout or stderr line from the Hermes process.
 * @returns provider health event when the line contains a valid status payload.
 */
export function parseHermesProviderStatusLine(
  line: string,
): ProductHermesProviderHealth | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith(OYSTERWORKFLOW_PROVIDER_STATUS_MARKER)) {
    return null;
  }
  const jsonText = trimmed
    .slice(OYSTERWORKFLOW_PROVIDER_STATUS_MARKER.length)
    .trim();
  if (!jsonText.startsWith("{")) {
    return null;
  }
  try {
    return normalizeHermesProviderHealth(JSON.parse(jsonText));
  } catch {
    return null;
  }
}

/**
 * EN: Extracts all provider status events from a Hermes output chunk.
 * 中文: 从 Hermes 输出片段中抽取所有 provider 状态事件。
 * @param output raw stdout or stderr text.
 * @returns provider health events found in the output.
 */
export function parseHermesProviderStatusEvents(
  output: string,
): ProductHermesProviderHealth[] {
  return output
    .split(/\r?\n/u)
    .map(parseHermesProviderStatusLine)
    .filter((event): event is ProductHermesProviderHealth => Boolean(event));
}

/**
 * EN: Removes provider status protocol lines before user-facing run event rendering.
 * 中文: 在渲染给用户看的 run event 前移除 provider 状态协议行。
 * @param output raw Hermes output.
 * @returns output without provider status protocol lines.
 */
export function stripHermesProviderStatusLines(output: string): string {
  return output
    .split(/\r?\n/u)
    .filter(
      (line) => !line.trim().startsWith(OYSTERWORKFLOW_PROVIDER_STATUS_MARKER),
    )
    .join("\n");
}

/**
 * EN: Converts a successful readiness probe into product provider health.
 * 中文: 将成功的 readiness 探测转换为产品层 provider 健康状态。
 * @param input provider and model identifiers from resolved Hermes config.
 * @returns connected provider health state.
 */
export function connectedHermesProviderHealth(input: {
  provider: string | null;
  model: string | null;
  checkedAt: string;
}): ProductHermesProviderHealth {
  return normalizeHermesProviderHealth({
    status: "connected",
    provider: input.provider,
    model: input.model,
    message: "LLM provider responded successfully.",
    checkedAt: input.checkedAt,
  });
}

/**
 * EN: Converts an unsuccessful readiness probe or process error into provider health.
 * 中文: 将失败的 readiness 探测或进程错误转换为 provider 健康状态。
 * @param input provider, model, and diagnostic message.
 * @returns degraded provider health state.
 */
export function degradedHermesProviderHealth(input: {
  provider: string | null;
  model: string | null;
  kind?: string | null;
  recoverability?: string | null;
  message: string | null;
  checkedAt: string;
}): ProductHermesProviderHealth {
  return normalizeHermesProviderHealth({
    status: "degraded",
    kind: input.kind ?? "llm_provider_unavailable",
    recoverability: input.recoverability ?? "unknown",
    provider: input.provider,
    model: input.model,
    message:
      input.message ??
      "LLM provider could not be reached. Check provider credentials and network connectivity.",
    retryable: null,
    checkedAt: input.checkedAt,
  });
}

function normalizeStatus(
  value: unknown,
): ProductHermesProviderConnectionStatus {
  if (value === "connected" || value === "degraded") {
    return value;
  }
  return "unknown";
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function nullableBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function nullableFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
