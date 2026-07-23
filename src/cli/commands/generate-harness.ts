import { dirname, resolve } from "node:path";
import { z } from "zod";
import { getProjectRootDir } from "../../io/project-paths.js";
import { generateHarnessFromSkill } from "../../harness/generator.js";
import {
  resolveExtractSkillLlmOptions,
  type RunExtractSkillLlmOptions,
} from "./extract-skill-llm.js";

const generateHarnessArgsSchema = z.object({
  skill: z.string().min(1),
  out: z.string().min(1).optional(),
  mode: z.enum(["autonomous", "collaborative"]).optional(),
  model: z.string().min(1).optional(),
  apiKey: z.string().min(1).optional(),
  baseUrl: z.string().url().optional(),
  wireApi: z.enum(["responses", "chat-completions"]).optional(),
  reasoningEffort: z.string().min(1).optional(),
  config: z.string().min(1).optional(),
});

export interface RunGenerateHarnessOptions extends Pick<
  RunExtractSkillLlmOptions,
  | "model"
  | "apiKey"
  | "baseUrl"
  | "wireApi"
  | "reasoningEffort"
  | "configPath"
  | "responseReadTimeoutMs"
  | "responseTimeoutMode"
  | "clientProfile"
  | "extraHeaders"
  | "callProfiles"
> {
  skillPath: string;
  outDir?: string;
  mode?: "autonomous" | "collaborative";
  now?: Date;
}

/**
 * EN: CLI adapter for generating a harness from an existing skill JSON.
 * @param options skill path, output path and LLM overrides.
 * @returns generated harness result.
 */
export async function runGenerateHarness(options: RunGenerateHarnessOptions) {
  const skillPath = resolve(options.skillPath);
  const resolved = await resolveExtractSkillLlmOptions({
    runDir: dirname(skillPath),
    configPath: options.configPath,
    model: options.model,
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    wireApi: options.wireApi,
    reasoningEffort: options.reasoningEffort,
    responseReadTimeoutMs: options.responseReadTimeoutMs,
    responseTimeoutMode: options.responseTimeoutMode,
    clientProfile: options.clientProfile,
    extraHeaders: options.extraHeaders,
    callProfiles: options.callProfiles,
  });

  return generateHarnessFromSkill({
    skillPath,
    outDir: options.outDir,
    projectRoot: getProjectRootDir(),
    mode: options.mode,
    model: resolved.model,
    apiKey: resolved.apiKey,
    baseUrl: resolved.baseUrl,
    wireApi: resolved.wireApi,
    reasoningEffort: resolved.reasoningEffort,
    responseReadTimeoutMs: resolved.responseReadTimeoutMs,
    responseTimeoutMode: resolved.responseTimeoutMode,
    clientProfile: resolved.clientProfile,
    extraHeaders: resolved.extraHeaders,
    callProfiles: resolved.callProfiles,
    now: options.now,
  });
}

/**
 * EN: Parses Commander options for the generate-harness command.
 * @param input raw CLI option values.
 * @returns typed command options.
 */
export function parseGenerateHarnessCliArgs(input: {
  skill: string;
  out?: string;
  mode?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  wireApi?: string;
  reasoningEffort?: string;
  config?: string;
}): RunGenerateHarnessOptions {
  const parsed = generateHarnessArgsSchema.parse({
    skill: input.skill,
    out: input.out,
    mode: input.mode,
    model: input.model,
    apiKey: input.apiKey,
    baseUrl: input.baseUrl,
    wireApi: input.wireApi,
    reasoningEffort: input.reasoningEffort,
    config: input.config,
  });
  return {
    skillPath: parsed.skill,
    outDir: parsed.out,
    mode: parsed.mode,
    model: parsed.model,
    apiKey: parsed.apiKey,
    baseUrl: parsed.baseUrl,
    wireApi: parsed.wireApi,
    reasoningEffort: parsed.reasoningEffort,
    configPath: parsed.config,
  };
}
