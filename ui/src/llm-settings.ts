import type {
  LabLlmAuthMode,
  LabLlmCallProfileKey,
  LabLlmClientProfile,
  LabLlmResponseTimeoutMode,
  LabLlmWireApi,
} from "../../src/lab-api/api-contracts.js";

export type LlmTimeoutConfigOption =
  "streaming-output" | "request-start" | "advanced";
export type LlmProviderPreset = "" | "openai" | "openai-compatible" | "custom";
export type LlmModelPreset =
  "gpt-5.4" | "gpt-5.3-codex" | "gpt-4.1-mini" | "custom";

export const LLM_SIMPLE_TIMEOUT_MS = 180_000;

export const LLM_PROVIDER_PRESET_OPTIONS = [
  { value: "", label: "Not set" },
  { value: "openai", label: "openai" },
  { value: "openai-compatible", label: "openai-compatible" },
  { value: "custom", label: "Custom" },
] as const satisfies ReadonlyArray<{
  value: LlmProviderPreset;
  label: string;
}>;

export const LLM_MODEL_PRESET_OPTIONS = [
  { value: "gpt-5.4", label: "gpt-5.4" },
  { value: "gpt-5.3-codex", label: "gpt-5.3-codex" },
  { value: "gpt-4.1-mini", label: "gpt-4.1-mini" },
  { value: "custom", label: "Custom" },
] as const satisfies ReadonlyArray<{
  value: LlmModelPreset;
  label: string;
}>;

export const LLM_REASONING_EFFORT_OPTIONS = [
  { value: "low", label: "low" },
  { value: "medium", label: "medium" },
  { value: "high", label: "high" },
  { value: "xhigh", label: "xhigh" },
] as const;

export const LLM_CUSTOMIZED_REASONING_OPTION = {
  value: "customized",
  label: "Customized reasoning effort for each call",
} as const;

export type LlmGlobalReasoningOption =
  | (typeof LLM_REASONING_EFFORT_OPTIONS)[number]["value"]
  | typeof LLM_CUSTOMIZED_REASONING_OPTION.value;

export interface LlmCallProfileFormState {
  reasoningEffort: string;
  responseReadTimeoutMs: string;
}

export interface LlmFormState {
  providerPreset: LlmProviderPreset;
  customProvider: string;
  baseUrl: string;
  modelPreset: LlmModelPreset;
  customModel: string;
  wireApi: LabLlmWireApi;
  reasoningEffort: string;
  responseReadTimeoutMs: string;
  responseTimeoutMode: LabLlmResponseTimeoutMode;
  advancedTimeoutConfigEnabled: boolean;
  advancedReasoningConfigEnabled: boolean;
  callProfiles: Record<LabLlmCallProfileKey, LlmCallProfileFormState>;
  clientProfile: "" | LabLlmClientProfile;
  authMode: LabLlmAuthMode;
  apiKey: string;
  apiKeyEnv: string;
  hasStoredApiKey: boolean;
  hasResolvedApiKey: boolean;
}

export const LLM_CLIENT_PROFILE_OPTIONS = [
  { value: "", label: "default" },
  { value: "codex-desktop", label: "dev" },
] as const satisfies ReadonlyArray<{
  value: LlmFormState["clientProfile"];
  label: string;
}>;

export function normalizeLlmClientProfileFormValue(
  value: LabLlmClientProfile | null,
): LlmFormState["clientProfile"] {
  return value === "openai-js" || value === "codex-desktop"
    ? "codex-desktop"
    : "";
}

export function resolveLlmClientProfileValue(
  value: LlmFormState["clientProfile"],
): LabLlmClientProfile | null {
  return value === "codex-desktop" ? "codex-desktop" : null;
}

export function detectLlmProviderPreset(value: string): LlmProviderPreset {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return "";
  }

  return trimmed === "openai" || trimmed === "openai-compatible"
    ? trimmed
    : "custom";
}

export function detectLlmModelPreset(value: string): LlmModelPreset {
  const trimmed = value.trim();
  if (
    trimmed === "gpt-5.4" ||
    trimmed === "gpt-5.3-codex" ||
    trimmed === "gpt-4.1-mini"
  ) {
    return trimmed;
  }

  return "custom";
}

export function resolveLlmProviderValue(form: LlmFormState): string {
  return form.providerPreset === "custom"
    ? form.customProvider.trim()
    : form.providerPreset;
}

export function resolveLlmModelValue(form: LlmFormState): string {
  return form.modelPreset === "custom"
    ? form.customModel.trim()
    : form.modelPreset;
}

export function parseResponseReadTimeoutMs(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const parsed = Number(trimmed);
  if (Number.isInteger(parsed) && Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }

  return null;
}

export function normalizeLlmReasoningEffort(
  value: string | null | undefined,
): string {
  const trimmed = value?.trim() ?? "";
  return LLM_REASONING_EFFORT_OPTIONS.some((option) => option.value === trimmed)
    ? trimmed
    : "high";
}

export function resolveLlmTimeoutConfigOption(
  form: Pick<
    LlmFormState,
    "advancedTimeoutConfigEnabled" | "responseTimeoutMode"
  >,
): LlmTimeoutConfigOption {
  if (form.advancedTimeoutConfigEnabled) {
    return "advanced";
  }

  return form.responseTimeoutMode === "fixed"
    ? "request-start"
    : "streaming-output";
}
