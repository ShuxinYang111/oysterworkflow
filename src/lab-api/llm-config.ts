import { resolve } from "node:path";
import { z } from "zod";
import type {
  LabLlmAuthMode,
  LabLlmCallProfileKey,
  LabLlmCallProfiles,
  LabLlmCallProfilesUpdateInput,
  LabLlmConfig,
  LabLlmConfigUpdateInput,
  LabLlmModelsInput,
} from "./api-contracts.js";
import {
  LAB_LLM_CALL_PROFILE_KEYS,
  LAB_LLM_DEFAULT_RESPONSE_READ_TIMEOUT_MS,
} from "./api-contracts.js";
import {
  getDefaultLlmConfigPath,
  getLocalLlmConfigPath,
} from "../io/project-paths.js";
import {
  normalizeLlmClientProfile,
  normalizeLlmResponseTimeoutMode,
  normalizeLlmWireApi,
} from "../llm/config-normalizers.js";
import { mapLlmCallProfileKeys } from "../llm/call-profiles.js";
import {
  normalizeLlmCredentialOrigin,
  removeLlmCredentialHeaders,
  shareLlmCredentialOrigin,
} from "../llm/credentials.js";
import { readJsonWithBackup, writeJsonAtomic } from "../io/atomic-json.js";

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DIRECT_API_KEY_ORIGIN_MISMATCH_MESSAGE =
  "Base URL origin changed. Re-enter the direct API key before continuing. / Base URL 来源已变更，请重新输入 API Key 后再继续。";

const wireApiSchema = z.enum(["responses", "chat-completions"]);
const clientProfileSchema = z.enum(["default", "openai-js", "codex-desktop"]);
const responseTimeoutModeSchema = z.enum(["fixed", "idle"]);
const extraHeadersSchema = z.record(z.string().min(1), z.string().min(1));
const storedLlmCallProfileSchema = z
  .object({
    reasoningEffort: z.string().min(1).optional(),
    responseReadTimeoutMs: z.number().int().positive().optional(),
  })
  .passthrough();
const storedLlmCallProfilesSchema = z
  .object(mapLlmCallProfileKeys(() => storedLlmCallProfileSchema.optional()))
  .passthrough();
const storedLlmConfigSchema = z
  .object({
    mode: z.literal("openai-compatible").optional(),
    provider: z.string().min(1).optional(),
    baseUrl: z.string().url(),
    model: z.string().min(1),
    wireApi: wireApiSchema.optional(),
    reasoningEffort: z.string().min(1).optional(),
    responseReadTimeoutMs: z.number().int().positive().optional(),
    responseTimeoutMode: responseTimeoutModeSchema.optional(),
    callProfiles: storedLlmCallProfilesSchema.optional(),
    clientProfile: clientProfileSchema.optional(),
    extraHeaders: extraHeadersSchema.optional(),
    apiKey: z.string().min(1).optional(),
    apiKeyEnv: z.string().min(1).optional(),
  })
  .passthrough();

type StoredLlmConfig = z.infer<typeof storedLlmConfigSchema>;
type StoredLlmCallProfiles = z.infer<typeof storedLlmCallProfilesSchema>;

const DEFAULT_STORED_LLM_CONFIG: StoredLlmConfig = {
  mode: "openai-compatible",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-5.4",
  wireApi: "responses",
  reasoningEffort: "high",
  responseReadTimeoutMs: 180_000,
  responseTimeoutMode: "idle",
};

interface StoredAuthState {
  mode: LabLlmAuthMode;
  apiKey: string | null;
  apiKeyEnv: string | null;
}

export interface ResolvedLabLlmCredentials {
  apiKey: string | null;
  extraHeaders: Record<string, string> | undefined;
}

/**
 * EN: Returns the absolute LLM config path used by the lab UI.
 * @returns absolute config path.
 */
export function getLabLlmConfigPath(): string {
  return getLocalLlmConfigPath();
}

/**
 * EN: Reads the current lab LLM config and converts it into a UI-friendly shape.
 * @param configPath absolute config path.
 * @returns normalized LLM config.
 */
export async function readLabLlmConfig(
  configPath = getLabLlmConfigPath(),
): Promise<LabLlmConfig> {
  const stored = await loadStoredLlmConfig(configPath);
  if (stored) {
    return toLabLlmConfig(stored);
  }

  const fallbackTemplate = shouldUseBundledTemplateFallback(configPath)
    ? await loadStoredLlmConfig(getDefaultLlmConfigPath())
    : null;
  return applyInitialLabLlmConfigDefaults(
    toLabLlmConfig(fallbackTemplate ?? DEFAULT_STORED_LLM_CONFIG),
  );
}

/**
 * EN: Resolves API-key and reserved header credentials under one origin-bound contract.
 * 中文: 在同一个来源绑定契约下解析 API Key 与保留凭据 header。
 * @param input authentication fields submitted by the settings form.
 * @param configPath stored config used for hidden credential reuse.
 * @returns request credentials shared by model discovery and model execution.
 */
export async function resolveLabLlmCredentials(
  input: Pick<
    LabLlmModelsInput,
    "baseUrl" | "authMode" | "apiKey" | "apiKeyEnv"
  >,
  configPath = getLabLlmConfigPath(),
): Promise<ResolvedLabLlmCredentials> {
  const stored = await loadStoredLlmConfig(configPath);
  const canReuseStoredHeaders = Boolean(
    stored && shareLlmCredentialOrigin(stored.baseUrl, input.baseUrl),
  );
  const storedHeaders = canReuseStoredHeaders
    ? stored?.extraHeaders
    : removeLlmCredentialHeaders(stored?.extraHeaders);

  if (input.authMode === "none") {
    return {
      apiKey: null,
      extraHeaders: removeLlmCredentialHeaders(storedHeaders),
    };
  }

  if (input.authMode === "env") {
    const apiKeyEnv = normalizeEnvName(input.apiKeyEnv);
    if (!apiKeyEnv) {
      throw new Error(
        "Environment variable name is required to load available models.",
      );
    }
    const resolved = process.env[apiKeyEnv]?.trim();
    if (!resolved) {
      throw new Error(
        `Environment variable ${apiKeyEnv} does not contain an API key.`,
      );
    }
    return { apiKey: resolved, extraHeaders: storedHeaders };
  }

  const submittedApiKey = normalizeOptionalString(input.apiKey);
  if (submittedApiKey) {
    return { apiKey: submittedApiKey, extraHeaders: storedHeaders };
  }

  const storedApiKey = resolveReusableStoredDirectApiKey(stored, input.baseUrl);
  if (storedApiKey) {
    return { apiKey: storedApiKey, extraHeaders: storedHeaders };
  }

  throw new Error("API key is required to load available models.");
}

/**
 * EN: Updates the lab LLM config while preserving existing advanced fields when possible.
 * @param input config fields submitted by the UI.
 * @param configPath absolute config path.
 * @returns normalized config after persistence.
 */
export async function writeLabLlmConfig(
  input: LabLlmConfigUpdateInput,
  configPath = getLabLlmConfigPath(),
): Promise<LabLlmConfig> {
  const existing = (await loadStoredLlmConfig(configPath)) ??
    (shouldUseBundledTemplateFallback(configPath)
      ? await loadStoredLlmConfig(getDefaultLlmConfigPath())
      : null) ?? {
      ...DEFAULT_STORED_LLM_CONFIG,
    };
  const baseUrl = normalizeRequiredString(input.baseUrl, "baseUrl");
  const provider = normalizeOptionalString(input.provider);
  const reasoningEffort = normalizeOptionalString(input.reasoningEffort);
  const clientProfile = normalizeLlmClientProfile(input.clientProfile, null);
  const responseReadTimeoutMs =
    normalizeOptionalPositiveInteger(input.responseReadTimeoutMs) ??
    normalizeStoredResponseReadTimeoutMs(existing.responseReadTimeoutMs);
  const responseTimeoutMode = normalizeLlmResponseTimeoutMode(
    input.responseTimeoutMode ?? existing.responseTimeoutMode,
  );
  const next: StoredLlmConfig = {
    ...existing,
    mode: "openai-compatible",
    baseUrl,
    model: normalizeRequiredString(input.model, "model"),
    wireApi: normalizeLlmWireApi(input.wireApi),
    responseReadTimeoutMs,
    responseTimeoutMode,
  };
  const originChanged = !shareLlmCredentialOrigin(existing.baseUrl, baseUrl);
  const retainedExtraHeaders =
    input.authMode === "none" || originChanged
      ? removeLlmCredentialHeaders(existing.extraHeaders)
      : existing.extraHeaders;
  if (retainedExtraHeaders) {
    next.extraHeaders = retainedExtraHeaders;
  } else {
    delete next.extraHeaders;
  }

  if (provider) {
    next.provider = provider;
  } else {
    delete next.provider;
  }

  if (reasoningEffort) {
    next.reasoningEffort = reasoningEffort;
  } else {
    delete next.reasoningEffort;
  }

  if (clientProfile) {
    next.clientProfile = clientProfile;
  } else {
    delete next.clientProfile;
  }

  const callProfiles = mergeStoredCallProfiles(
    existing.callProfiles,
    input.callProfiles,
  );
  if (callProfiles) {
    next.callProfiles = callProfiles;
  } else {
    delete next.callProfiles;
  }

  switch (input.authMode) {
    case "direct": {
      const submittedApiKey = normalizeOptionalString(input.apiKey);
      const apiKey =
        submittedApiKey ??
        resolveReusableStoredDirectApiKey(existing, baseUrl) ??
        null;
      if (!apiKey) {
        throw new Error("Direct API key is required when auth mode is direct.");
      }
      next.apiKey = apiKey;
      delete next.apiKeyEnv;
      break;
    }
    case "env": {
      const apiKeyEnv = normalizeEnvName(input.apiKeyEnv);
      if (!apiKeyEnv) {
        throw new Error(
          "Environment variable name is required when auth mode is env.",
        );
      }
      next.apiKey = buildEnvPlaceholder(apiKeyEnv);
      next.apiKeyEnv = apiKeyEnv;
      break;
    }
    case "none":
      delete next.apiKey;
      delete next.apiKeyEnv;
      break;
    default:
      throw new Error(`Unsupported auth mode: ${input.authMode}`);
  }

  await writeJsonAtomic(configPath, next, {
    mode: 0o600,
    backup: true,
    validate: (value) => storedLlmConfigSchema.parse(value),
  });
  return toLabLlmConfig(next);
}

async function loadStoredLlmConfig(
  configPath: string,
): Promise<StoredLlmConfig | null> {
  try {
    return await readJsonWithBackup(configPath, {
      validate: (value) => storedLlmConfigSchema.parse(value),
    });
  } catch (error) {
    throw new Error(
      `Invalid LLM config at ${configPath}: ${toErrorMessage(error)}`,
    );
  }
}

function toLabLlmConfig(input: StoredLlmConfig): LabLlmConfig {
  const authState = resolveStoredAuthState(input);

  return {
    provider: normalizeOptionalString(input.provider),
    baseUrl: input.baseUrl,
    model: input.model,
    wireApi: normalizeLlmWireApi(input.wireApi),
    reasoningEffort: normalizeOptionalString(input.reasoningEffort),
    responseReadTimeoutMs: normalizeStoredResponseReadTimeoutMs(
      input.responseReadTimeoutMs,
    ),
    responseTimeoutMode: normalizeLlmResponseTimeoutMode(
      input.responseTimeoutMode,
    ),
    callProfiles: toLabLlmCallProfiles(input.callProfiles),
    clientProfile: normalizeLlmClientProfile(input.clientProfile, null),
    authMode: authState.mode,
    apiKeyEnv: authState.apiKeyEnv,
    hasStoredApiKey: authState.mode === "direct" && Boolean(authState.apiKey),
    hasResolvedApiKey:
      authState.mode === "direct"
        ? Boolean(authState.apiKey)
        : authState.mode === "env"
          ? Boolean(
              authState.apiKeyEnv && process.env[authState.apiKeyEnv]?.trim(),
            )
          : false,
  };
}

/**
 * EN: Applies the preferred first-open form defaults before any local config is saved.
 * @param config normalized config derived from fallback defaults.
 * @returns config adjusted for the initial settings experience.
 */
function applyInitialLabLlmConfigDefaults(config: LabLlmConfig): LabLlmConfig {
  return {
    ...config,
    authMode: "direct",
    apiKeyEnv: null,
    hasStoredApiKey: false,
    hasResolvedApiKey: false,
  };
}

function resolveStoredAuthState(input: StoredLlmConfig): StoredAuthState {
  const directApiKey = normalizeOptionalString(input.apiKey);
  const apiKeyEnv =
    normalizeEnvName(input.apiKeyEnv) ??
    resolveEnvPlaceholderName(directApiKey) ??
    null;

  if (apiKeyEnv) {
    return {
      mode: "env",
      apiKey: null,
      apiKeyEnv,
    };
  }

  if (directApiKey) {
    return {
      mode: "direct",
      apiKey: directApiKey,
      apiKeyEnv: null,
    };
  }

  return {
    mode: "none",
    apiKey: null,
    apiKeyEnv: null,
  };
}

/**
 * EN: Reuses a hidden direct key only when the requested endpoint remains on the stored origin.
 * 中文: 仅当请求端点仍属于已保存来源时，才复用未暴露给渲染进程的 direct key。
 * @param stored persisted LLM config that owns the hidden credential.
 * @param requestedBaseUrl endpoint requested by the current save or model-list action.
 * @returns the reusable direct key, or null when no direct key is stored.
 */
function resolveReusableStoredDirectApiKey(
  stored: StoredLlmConfig | null,
  requestedBaseUrl: string,
): string | null {
  if (!stored) {
    return null;
  }
  const storedAuth = resolveStoredAuthState(stored);
  if (storedAuth.mode !== "direct" || !storedAuth.apiKey) {
    return null;
  }
  if (
    normalizeLlmCredentialOrigin(stored.baseUrl) !==
    normalizeLlmCredentialOrigin(requestedBaseUrl)
  ) {
    throw new Error(DIRECT_API_KEY_ORIGIN_MISMATCH_MESSAGE);
  }
  return storedAuth.apiKey;
}

/**
 * EN: Normalizes an HTTP(S) provider URL to the origin used as the credential boundary.
 * 中文: 将 HTTP(S) 服务地址规范化为用于凭据隔离的 origin。
 * @param baseUrl provider URL from stored config or the current request.
 * @returns normalized scheme, host, and effective port.
 */
function shouldUseBundledTemplateFallback(configPath: string): boolean {
  return resolve(configPath) === resolve(getLocalLlmConfigPath());
}

function resolveEnvPlaceholderName(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const match = value.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
  return match?.[1] ?? null;
}

function buildEnvPlaceholder(envName: string): string {
  return `\${${envName}}`;
}

function toLabLlmCallProfiles(
  callProfiles: StoredLlmCallProfiles | undefined,
): LabLlmCallProfiles {
  return Object.fromEntries(
    LAB_LLM_CALL_PROFILE_KEYS.map((key) => [
      key,
      {
        reasoningEffort: readStoredCallProfileReasoningEffort(
          callProfiles?.[key],
        ),
        responseReadTimeoutMs: readStoredCallProfileResponseReadTimeoutMs(
          callProfiles?.[key],
        ),
      },
    ]),
  ) as LabLlmCallProfiles;
}

function mergeStoredCallProfiles(
  existing: StoredLlmCallProfiles | undefined,
  updates: LabLlmCallProfilesUpdateInput | null | undefined,
): StoredLlmCallProfiles | undefined {
  if (!updates) {
    return existing;
  }

  const nextProfiles: Record<
    string,
    Record<string, unknown>
  > = Object.fromEntries(
    Object.entries(existing ?? {}).map(([key, value]) => [
      key,
      { ...(asRecord(value) ?? {}) },
    ]),
  );

  for (const key of LAB_LLM_CALL_PROFILE_KEYS) {
    if (!(key in updates)) {
      continue;
    }
    applyStoredCallProfileUpdate(nextProfiles, key, updates[key]);
  }

  return Object.keys(nextProfiles).length > 0
    ? (nextProfiles as StoredLlmCallProfiles)
    : undefined;
}

function applyStoredCallProfileUpdate(
  nextProfiles: Record<string, Record<string, unknown>>,
  key: LabLlmCallProfileKey,
  update: LabLlmCallProfilesUpdateInput[LabLlmCallProfileKey],
): void {
  const hasReasoningEffort =
    update !== undefined &&
    Object.prototype.hasOwnProperty.call(update, "reasoningEffort");
  const hasResponseReadTimeoutMs =
    update !== undefined &&
    Object.prototype.hasOwnProperty.call(update, "responseReadTimeoutMs");
  const reasoningEffort = normalizeOptionalString(update?.reasoningEffort);
  const responseReadTimeoutMs = normalizeOptionalPositiveInteger(
    update?.responseReadTimeoutMs,
  );
  const previous = nextProfiles[key] ?? {};
  const nextProfile = { ...previous };

  if (hasReasoningEffort) {
    if (reasoningEffort) {
      nextProfile.reasoningEffort = reasoningEffort;
    } else {
      delete nextProfile.reasoningEffort;
    }
  }

  if (hasResponseReadTimeoutMs) {
    if (responseReadTimeoutMs !== null) {
      nextProfile.responseReadTimeoutMs = responseReadTimeoutMs;
    } else {
      delete nextProfile.responseReadTimeoutMs;
    }
  }

  if (Object.keys(nextProfile).length > 0) {
    nextProfiles[key] = nextProfile;
  } else {
    delete nextProfiles[key];
  }
}

function normalizeRequiredString(value: string, fieldName: string): string {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    throw new Error(`${fieldName} is required.`);
  }
  return normalized;
}

function normalizeOptionalString(
  value: string | null | undefined,
): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeOptionalPositiveInteger(
  value: number | null | undefined,
): number | null {
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    Number.isFinite(value) &&
    value > 0
  ) {
    return value;
  }
  return null;
}

function normalizeEnvName(value: string | null | undefined): string | null {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return null;
  }
  if (!ENV_NAME_PATTERN.test(normalized)) {
    throw new Error(`Invalid environment variable name: ${normalized}`);
  }
  return normalized;
}

function readStoredCallProfileReasoningEffort(value: unknown): string | null {
  const profile = asRecord(value);
  return normalizeOptionalString(
    typeof profile?.reasoningEffort === "string"
      ? profile.reasoningEffort
      : undefined,
  );
}

function readStoredCallProfileResponseReadTimeoutMs(
  value: unknown,
): number | null {
  const profile = asRecord(value);
  return normalizeOptionalPositiveInteger(
    typeof profile?.responseReadTimeoutMs === "number"
      ? profile.responseReadTimeoutMs
      : undefined,
  );
}

function normalizeStoredResponseReadTimeoutMs(
  value: number | undefined,
): number {
  return (
    normalizeOptionalPositiveInteger(value) ??
    LAB_LLM_DEFAULT_RESPONSE_READ_TIMEOUT_MS
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
