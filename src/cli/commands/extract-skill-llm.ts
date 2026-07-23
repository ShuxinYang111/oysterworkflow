import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import {
  getDefaultUserSkillConfigPath,
  getPreferredLlmConfigPath,
} from "../../io/project-paths.js";
import {
  extractOpenClawSkillLlm,
  type ExtractOpenClawSkillLlmComponents,
  type OpenClawLlmCallProfiles,
  type ExtractOpenClawSkillLlmOptions,
  type ExtractOpenClawSkillLlmResult,
  type OpenAiWireApi,
} from "../../skill/extract-openclaw-llm.js";
import {
  DEFAULT_USER_SKILL_CONFIG,
  type UserSkillConfig,
  userSkillConfigSchema,
} from "../../skill/user-skill-config.js";
import { loadWorkflowFamilyCatalog } from "../../skill/workflow-learning.js";
import {
  LLM_CALL_PROFILE_KEYS,
  mapLlmCallProfileKeys,
} from "../../llm/call-profiles.js";
const DEFAULT_USER_SKILL_CONFIG_PATH = getDefaultUserSkillConfigPath();

const wireApiSchema = z.enum(["responses", "chat-completions"]);
const clientProfileSchema = z.enum(["default", "openai-js", "codex-desktop"]);
const responseTimeoutModeSchema = z.enum(["fixed", "idle"]);
const extraHeadersSchema = z.record(z.string().min(1), z.string().min(1));
const llmCallProfileSchema = z.object({
  reasoningEffort: z.string().min(1).optional(),
  responseReadTimeoutMs: z.number().int().positive().optional(),
});
const llmCallProfilesSchema = z
  .object(mapLlmCallProfileKeys(() => llmCallProfileSchema.optional()))
  .strict()
  .optional();

export { LLM_CALL_PROFILE_KEYS };
const llmComponentsSchema = z
  .object({
    workflowCandidateGeneration: z
      .object({
        enabled: z.boolean().optional(),
      })
      .optional(),
    workflowFamilyMatching: z
      .object({
        enabled: z.boolean().optional(),
      })
      .optional(),
    workflowMergeProposal: z
      .object({
        enabled: z.boolean().optional(),
      })
      .optional(),
    generalization: z
      .object({
        enabled: z.boolean().optional(),
      })
      .optional(),
    plannerOptimization: z
      .object({
        enabled: z.boolean().optional(),
      })
      .optional(),
  })
  .optional();
// EN: Validation schema for `oysterworkflow extract-skill-llm` arguments.
const extractSkillLlmArgsSchema = z.object({
  runDir: z.string().min(1),
  out: z.string().min(1).optional(),
  episodeId: z.string().min(1).optional(),
  workflowId: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  guidance: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  apiKey: z.string().min(1).optional(),
  baseUrl: z.string().url().optional(),
  wireApi: wireApiSchema.optional(),
  reasoningEffort: z.string().min(1).optional(),
  enableGeneralization: z.boolean().optional(),
  enablePlannerOptimization: z.boolean().optional(),
  workflowFamilyCatalog: z.string().min(1).optional(),
  config: z.string().min(1).optional(),
});
// EN: LLM config file schema (OpenAI-compatible mode).
const llmConfigFileSchema = z
  .object({
    mode: z.literal("openai-compatible").optional(),
    provider: z.string().min(1).optional(),
    baseUrl: z.string().url(),
    model: z.string().min(1),
    wireApi: wireApiSchema.optional(),
    reasoningEffort: z.string().min(1).optional(),
    responseReadTimeoutMs: z.number().int().positive().optional(),
    responseTimeoutMode: responseTimeoutModeSchema.optional(),
    clientProfile: clientProfileSchema.optional(),
    extraHeaders: extraHeadersSchema.optional(),
    components: llmComponentsSchema,
    apiKey: z.string().min(1).optional(),
    apiKeyEnv: z.string().min(1).optional(),
    callProfiles: llmCallProfilesSchema,
    workflowFamilyCatalogPath: z.string().min(1).optional(),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    if ("enableCallC" in value) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "enableCallC has been removed. Use components.plannerOptimization.enabled instead.",
        path: ["enableCallC"],
      });
    }
  });

type LlmConfigFile = z.infer<typeof llmConfigFileSchema>;

export interface RunExtractSkillLlmOptions extends ExtractOpenClawSkillLlmOptions {
  configPath?: string;
  workflowFamilyCatalogPath?: string;
}

function mergeExtractSkillLlmComponents(
  configComponents: ExtractOpenClawSkillLlmComponents | undefined,
  cliComponents: ExtractOpenClawSkillLlmComponents | undefined,
): ExtractOpenClawSkillLlmComponents | undefined {
  const workflowCandidateGenerationEnabled =
    cliComponents?.workflowCandidateGeneration?.enabled ??
    configComponents?.workflowCandidateGeneration?.enabled;
  const workflowFamilyMatchingEnabled =
    cliComponents?.workflowFamilyMatching?.enabled ??
    configComponents?.workflowFamilyMatching?.enabled;
  const workflowMergeProposalEnabled =
    cliComponents?.workflowMergeProposal?.enabled ??
    configComponents?.workflowMergeProposal?.enabled;
  const generalizationEnabled =
    cliComponents?.generalization?.enabled ??
    configComponents?.generalization?.enabled;
  const plannerOptimizationEnabled =
    cliComponents?.plannerOptimization?.enabled ??
    configComponents?.plannerOptimization?.enabled;

  if (
    workflowCandidateGenerationEnabled === undefined &&
    workflowFamilyMatchingEnabled === undefined &&
    workflowMergeProposalEnabled === undefined &&
    generalizationEnabled === undefined &&
    plannerOptimizationEnabled === undefined
  ) {
    return undefined;
  }

  return {
    ...(workflowCandidateGenerationEnabled !== undefined
      ? {
          workflowCandidateGeneration: {
            enabled: workflowCandidateGenerationEnabled,
          },
        }
      : {}),
    ...(workflowFamilyMatchingEnabled !== undefined
      ? {
          workflowFamilyMatching: {
            enabled: workflowFamilyMatchingEnabled,
          },
        }
      : {}),
    ...(workflowMergeProposalEnabled !== undefined
      ? {
          workflowMergeProposal: {
            enabled: workflowMergeProposalEnabled,
          },
        }
      : {}),
    ...(generalizationEnabled !== undefined
      ? { generalization: { enabled: generalizationEnabled } }
      : {}),
    ...(plannerOptimizationEnabled !== undefined
      ? {
          plannerOptimization: {
            enabled: plannerOptimizationEnabled,
          },
        }
      : {}),
  };
}

/**
 * EN: Thin command adapter that resolves config precedence before invoking the LLM extractor.
 * @param options LLM extraction options (run path, model/API fields, config file, etc.).
 * @returns generated skill/summary and artifact paths.
 */
export async function runExtractSkillLlm(
  options: RunExtractSkillLlmOptions,
): Promise<ExtractOpenClawSkillLlmResult> {
  const resolvedOptions = await resolveExtractSkillLlmOptions(options);
  return extractOpenClawSkillLlm(resolvedOptions);
}

/**
 * EN: Resolves effective LLM settings with precedence (CLI > config file > extractor defaults).
 * @param options command-layer input options.
 * @returns options object ready for extractor invocation.
 */
export async function resolveExtractSkillLlmOptions(
  options: RunExtractSkillLlmOptions,
): Promise<ExtractOpenClawSkillLlmOptions> {
  const configPath = resolve(options.configPath ?? getPreferredLlmConfigPath());
  const configRequired = typeof options.configPath === "string";
  const fileConfig = await loadLlmConfigFile(configPath, configRequired);
  const userSkillConfig = await loadUserSkillConfigFile(
    DEFAULT_USER_SKILL_CONFIG_PATH,
  );
  const workflowFamilyCatalogPath =
    options.workflowFamilyCatalogPath ?? fileConfig?.workflowFamilyCatalogPath;
  const workflowFamilyCatalog = workflowFamilyCatalogPath
    ? await loadWorkflowFamilyCatalog(resolve(workflowFamilyCatalogPath))
    : null;

  return {
    runDir: options.runDir,
    outDir: options.outDir,
    episodeId: options.episodeId,
    workflowId: options.workflowId,
    workflowCandidates: options.workflowCandidates,
    workflowFamilyCards:
      options.workflowFamilyCards ?? workflowFamilyCatalog?.families,
    workflowFamilyGraphs:
      options.workflowFamilyGraphs ?? workflowFamilyCatalog?.graphs,
    workflowFamilyGraphPaths:
      options.workflowFamilyGraphPaths ?? workflowFamilyCatalog?.graphPaths,
    selectedWorkflow: options.selectedWorkflow,
    onProgress: options.onProgress,
    skillName: options.skillName,
    generationGuidance: options.generationGuidance,
    now: options.now,
    llmClient: options.llmClient,
    model: options.model ?? fileConfig?.model,
    apiKey: options.apiKey ?? resolveApiKeyFromConfig(fileConfig),
    baseUrl: options.baseUrl ?? fileConfig?.baseUrl,
    wireApi: options.wireApi ?? fileConfig?.wireApi,
    reasoningEffort: options.reasoningEffort ?? fileConfig?.reasoningEffort,
    responseReadTimeoutMs:
      options.responseReadTimeoutMs ?? fileConfig?.responseReadTimeoutMs,
    responseTimeoutMode:
      options.responseTimeoutMode ?? fileConfig?.responseTimeoutMode,
    clientProfile: options.clientProfile ?? fileConfig?.clientProfile,
    extraHeaders: options.extraHeaders ?? fileConfig?.extraHeaders,
    components: mergeExtractSkillLlmComponents(
      fileConfig?.components,
      options.components,
    ),
    callProfiles:
      options.callProfiles ?? resolveCallProfilesFromConfig(fileConfig),
    userSkillConfig,
  };
}

/**
 * EN: Loads and validates LLM config file; returns null if default path is missing, throws for missing explicit path.
 * @param configPath absolute config file path.
 * @param required whether file is required (when `--config` is provided).
 * @returns validated config object or null.
 */
async function loadLlmConfigFile(
  configPath: string,
  required: boolean,
): Promise<LlmConfigFile | null> {
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code === "ENOENT" && !required) {
      return null;
    }
    throw new Error(
      `Failed to read LLM config file at ${configPath}: ${toErrorMessage(error)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid JSON in LLM config file at ${configPath}: ${toErrorMessage(error)}`,
    );
  }

  try {
    return llmConfigFileSchema.parse(parsed);
  } catch (error) {
    throw new Error(
      `Invalid LLM config schema at ${configPath}: ${toErrorMessage(error)}`,
    );
  }
}

/**
 * EN: Loads and validates user-skill config file; returns defaults when missing.
 * @param configPath absolute config file path.
 * @returns validated config object.
 */
async function loadUserSkillConfigFile(
  configPath: string,
): Promise<UserSkillConfig> {
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") {
      return DEFAULT_USER_SKILL_CONFIG;
    }
    throw new Error(
      `Failed to read user skill config file at ${configPath}: ${toErrorMessage(error)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid JSON in user skill config file at ${configPath}: ${toErrorMessage(error)}`,
    );
  }

  try {
    return userSkillConfigSchema.parse(parsed);
  } catch (error) {
    throw new Error(
      `Invalid user skill config schema at ${configPath}: ${toErrorMessage(error)}`,
    );
  }
}

/**
 * EN: Resolves API key from config (supports plain key, `${ENV_NAME}` placeholder, and `apiKeyEnv`).
 * @param config loaded config.
 * @returns resolved key, an empty string for explicit keyless config, or undefined when no config exists.
 */
function resolveApiKeyFromConfig(
  config: LlmConfigFile | null,
): string | undefined {
  if (!config) {
    return undefined;
  }

  const direct = resolveApiKeyPlaceholder(config.apiKey);
  if (direct) {
    return direct;
  }

  if (
    typeof config.apiKeyEnv === "string" &&
    config.apiKeyEnv.trim().length > 0
  ) {
    const envName = config.apiKeyEnv.trim();
    const envValue = process.env[envName];
    if (typeof envValue === "string" && envValue.trim().length > 0) {
      return envValue.trim();
    }
  }

  // EN: An existing keyless config is an explicit choice and must not fall back to ambient OPENAI_API_KEY.
  // 中文: 已存在的无密钥配置是显式选择，不能再意外回退到进程里的 OPENAI_API_KEY。
  return "";
}

/**
 * EN: Resolves per-call LLM profiles from config file; returns undefined when absent.
 * @param config loaded config.
 * @returns per-call profile config or undefined.
 */
function resolveCallProfilesFromConfig(
  config: LlmConfigFile | null,
): OpenClawLlmCallProfiles | undefined {
  return config?.callProfiles;
}

/**
 * EN: Resolves `${ENV_NAME}` placeholder; returns original text when not placeholder.
 * @param value apiKey field from config.
 * @returns resolved key or undefined.
 */
function resolveApiKeyPlaceholder(
  value: string | undefined,
): string | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  const envMatch = trimmed.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
  if (!envMatch) {
    return trimmed;
  }

  const envName = envMatch[1];
  const envValue = process.env[envName];
  if (typeof envValue === "string" && envValue.trim().length > 0) {
    return envValue.trim();
  }

  return undefined;
}

/**
 * EN: Parses and validates extract-skill-llm CLI arguments.
 * @param input raw CLI input values (primarily strings).
 * @returns typed LLM extraction options.
 */
export function parseExtractSkillLlmCliArgs(input: {
  runDir: string;
  out?: string;
  episodeId?: string;
  workflowId?: string;
  name?: string;
  guidance?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  wireApi?: OpenAiWireApi | string;
  reasoningEffort?: string;
  enableGeneralization?: boolean;
  enablePlannerOptimization?: boolean;
  workflowFamilyCatalog?: string;
  config?: string;
}): RunExtractSkillLlmOptions {
  const parsed = extractSkillLlmArgsSchema.parse(input);
  const components = buildCliComponents({
    enableGeneralization: parsed.enableGeneralization,
    enablePlannerOptimization: parsed.enablePlannerOptimization,
  });

  return {
    runDir: parsed.runDir,
    outDir: parsed.out,
    episodeId: parsed.episodeId,
    workflowId: parsed.workflowId,
    skillName: parsed.name,
    generationGuidance: parsed.guidance,
    model: parsed.model,
    apiKey: parsed.apiKey,
    baseUrl: parsed.baseUrl,
    wireApi: parsed.wireApi,
    reasoningEffort: parsed.reasoningEffort,
    workflowFamilyCatalogPath: parsed.workflowFamilyCatalog,
    ...(components ? { components } : {}),
    configPath: parsed.config,
  };
}

function buildCliComponents(input: {
  enableGeneralization?: boolean;
  enablePlannerOptimization?: boolean;
}): ExtractOpenClawSkillLlmComponents | undefined {
  if (
    input.enableGeneralization === undefined &&
    input.enablePlannerOptimization === undefined
  ) {
    return undefined;
  }

  return {
    ...(input.enableGeneralization !== undefined
      ? { generalization: { enabled: input.enableGeneralization } }
      : {}),
    ...(input.enablePlannerOptimization !== undefined
      ? {
          plannerOptimization: {
            enabled: input.enablePlannerOptimization,
          },
        }
      : {}),
  };
}

/**
 * EN: Converts unknown error to string.
 * @param error unknown error value.
 * @returns readable error text.
 */
function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
