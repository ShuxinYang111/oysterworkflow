import { join, resolve } from "node:path";
import { z } from "zod";
import {
  discoverOpenClawWorkflows,
  type DiscoverOpenClawWorkflowsOptions,
  type DiscoverOpenClawWorkflowsResult,
} from "../../skill/extract-openclaw-llm.js";
import { resolveExtractSkillLlmOptions } from "./extract-skill-llm.js";

const wireApiSchema = z.enum(["responses", "chat-completions"]);

const discoverWorkflowsArgsSchema = z.object({
  runDir: z.string().min(1),
  out: z.string().min(1).optional(),
  episodeId: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  guidance: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  apiKey: z.string().min(1).optional(),
  baseUrl: z.string().url().optional(),
  wireApi: wireApiSchema.optional(),
  reasoningEffort: z.string().min(1).optional(),
  config: z.string().min(1).optional(),
});

export interface RunDiscoverWorkflowsOptions extends DiscoverOpenClawWorkflowsOptions {
  configPath?: string;
}

/**
 * EN: Thin command adapter that resolves shared LLM config before workflow discovery.
 * @param options workflow discovery options.
 * @returns workflow candidates and discovery artifact path.
 */
export async function runDiscoverWorkflows(
  options: RunDiscoverWorkflowsOptions,
): Promise<DiscoverOpenClawWorkflowsResult> {
  const resolved = await resolveExtractSkillLlmOptions({
    runDir: options.runDir,
    episodeId: options.episodeId,
    skillName: options.skillName,
    generationGuidance: options.generationGuidance,
    model: options.model,
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    wireApi: options.wireApi,
    reasoningEffort: options.reasoningEffort,
    callProfiles: options.callProfiles,
    configPath: options.configPath,
    now: options.now,
    llmClient: options.llmClient,
  });

  return discoverOpenClawWorkflows({
    runDir: resolved.runDir,
    episodeId: resolved.episodeId,
    outPath:
      options.outPath ??
      join(resolve(options.runDir), "workflow-discovery.json"),
    skillName: resolved.skillName,
    generationGuidance: resolved.generationGuidance,
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
    now: resolved.now,
    llmClient: resolved.llmClient,
    userSkillConfig: resolved.userSkillConfig,
  });
}

/**
 * EN: Parses and validates discover-workflows CLI arguments.
 * @param input raw CLI args.
 * @returns typed workflow discovery options.
 */
export function parseDiscoverWorkflowsCliArgs(input: {
  runDir: string;
  out?: string;
  episodeId?: string;
  name?: string;
  guidance?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  wireApi?: "responses" | "chat-completions" | string;
  reasoningEffort?: string;
  config?: string;
}): RunDiscoverWorkflowsOptions {
  const parsed = discoverWorkflowsArgsSchema.parse(input);
  return {
    runDir: parsed.runDir,
    outPath: parsed.out,
    episodeId: parsed.episodeId,
    skillName: parsed.name,
    generationGuidance: parsed.guidance,
    model: parsed.model,
    apiKey: parsed.apiKey,
    baseUrl: parsed.baseUrl,
    wireApi: parsed.wireApi,
    reasoningEffort: parsed.reasoningEffort,
    configPath: parsed.config,
  };
}
