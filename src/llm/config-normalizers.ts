export type LlmWireApi = "responses" | "chat-completions";
export type LlmClientProfile = "default" | "openai-js" | "codex-desktop";
export type LlmResponseTimeoutMode = "fixed" | "idle";

/**
 * EN: Normalizes an OpenAI-compatible wire API value.
 * @param value raw wire API value.
 * @param fallback fallback used when the value is unknown.
 * @returns normalized wire API.
 */
export function normalizeLlmWireApi(
  value: LlmWireApi | string | null | undefined,
  fallback: LlmWireApi = "responses",
): LlmWireApi {
  return value === "chat-completions" ? "chat-completions" : fallback;
}

export function normalizeLlmClientProfile(
  value: LlmClientProfile | string | null | undefined,
  fallback: null,
): LlmClientProfile | null;
export function normalizeLlmClientProfile(
  value: LlmClientProfile | string | null | undefined,
  fallback?: LlmClientProfile,
): LlmClientProfile;
/**
 * EN: Normalizes the client profile used for LLM HTTP requests.
 * @param value raw client profile value.
 * @param fallback fallback used when the value is unknown.
 * @returns normalized client profile, or null when requested by the caller.
 */
export function normalizeLlmClientProfile(
  value: LlmClientProfile | string | null | undefined,
  fallback: LlmClientProfile | null = "default",
): LlmClientProfile | null {
  if (
    value === "default" ||
    value === "openai-js" ||
    value === "codex-desktop"
  ) {
    return value;
  }
  return fallback;
}

/**
 * EN: Normalizes response timeout mode.
 * @param value raw timeout mode.
 * @param fallback fallback used when the value is unknown.
 * @returns normalized timeout mode.
 */
export function normalizeLlmResponseTimeoutMode(
  value: LlmResponseTimeoutMode | string | null | undefined,
  fallback: LlmResponseTimeoutMode = "fixed",
): LlmResponseTimeoutMode {
  return value === "idle" ? "idle" : fallback;
}

/**
 * EN: Normalizes reasoning effort; blank values become undefined.
 * @param value raw reasoning effort.
 * @returns trimmed reasoning effort or undefined.
 */
export function normalizeLlmReasoningEffort(
  value: string | null | undefined,
): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * EN: Normalizes positive integer timeout values.
 * @param value raw timeout value.
 * @param fallbackMs fallback timeout in milliseconds.
 * @returns positive integer timeout in milliseconds.
 */
export function normalizeLlmResponseReadTimeoutMs(
  value: number | null | undefined,
  fallbackMs: number,
): number {
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    Number.isFinite(value) &&
    value > 0
  ) {
    return value;
  }
  return fallbackMs;
}
