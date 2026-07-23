import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseLooseJson } from "../skill/extract-openclaw-llm-output.js";
import {
  requestOpenAiCompatibleJson,
  type OpenAiCompatibleClientProfile,
  type OpenAiWireApi,
  type OpenClawLlmCallProfiles,
  type OpenClawLlmResponseTimeoutMode,
} from "../skill/extract-openclaw-llm.js";
import type {
  LlmInvocationSummary,
  OpenClawSkill,
} from "../types/contracts.js";
import {
  indexRulePacks,
  loadRulePackCatalog,
  toRulePackCatalogItems,
} from "./rule-pack-catalog.js";
import { writeHarnessPackage } from "./renderer.js";
import {
  buildExecutionProtocolPrompt,
  buildHarnessPlanningPrompt,
} from "./prompts.js";
import {
  type GenerateHarnessResult,
  type HarnessGenerationSummary,
  type HarnessMode,
  type RulePack,
  harnessModeSchema,
} from "./types.js";
import {
  parseAndValidateExecutionProtocol,
  parseAndValidateHarnessPlanning,
} from "./validation.js";

export interface GenerateHarnessOptions {
  skillPath: string;
  outDir?: string;
  projectRoot: string;
  mode?: HarnessMode;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  wireApi?: OpenAiWireApi;
  reasoningEffort?: string;
  responseReadTimeoutMs?: number;
  responseTimeoutMode?: OpenClawLlmResponseTimeoutMode;
  clientProfile?: OpenAiCompatibleClientProfile;
  extraHeaders?: Record<string, string>;
  callProfiles?: OpenClawLlmCallProfiles;
  now?: Date;
}

/**
 * EN: Generates a skill-level harness package from an existing skill JSON.
 * @param options source skill, output path and LLM settings.
 * @returns parsed planning, execution protocol and output summary.
 */
export async function generateHarnessFromSkill(
  options: GenerateHarnessOptions,
): Promise<GenerateHarnessResult> {
  const skillPath = resolve(options.skillPath);
  const skill = JSON.parse(await readFile(skillPath, "utf8")) as OpenClawSkill;
  const mode = harnessModeSchema.parse(options.mode ?? "autonomous");
  const outDir = resolve(options.outDir ?? join(dirname(skillPath), "harness"));
  const generationRecordDir = join(outDir, "generation-record");
  const packageDir = join(outDir, "package");
  await mkdir(generationRecordDir, { recursive: true });
  await mkdir(packageDir, { recursive: true });

  await writeJson(join(generationRecordDir, "generated-skill.json"), skill);

  const rulePacks = await loadRulePackCatalog({
    projectRoot: options.projectRoot,
  });
  const planningPrompt = buildHarnessPlanningPrompt({
    skill,
    rulePackCatalog: toRulePackCatalogItems(rulePacks),
  });
  await writeJson(join(generationRecordDir, "call-01-planning.request.json"), {
    model: requiredText(options.model, "model"),
    mode,
    systemPrompt: planningPrompt.systemPrompt,
    userPrompt: planningPrompt.userPrompt,
  });
  const planningCall = await requestOpenAiCompatibleJson({
    ...buildLlmRequestBase(options, "harness-planning"),
    systemPrompt: planningPrompt.systemPrompt,
    userPrompt: planningPrompt.userPrompt,
    requestLabel: "harness-planning",
    traceRunDir: generationRecordDir,
  });
  await writeJson(join(generationRecordDir, "call-01-planning.response.json"), {
    text: planningCall.text,
    llm: planningCall.llm,
  });
  const planning = parseAndValidateHarnessPlanning(
    parseLooseJson(planningCall.text),
    { skill, rulePacks },
  );
  await writeJson(join(generationRecordDir, "planning.json"), planning);

  const selectedRulePacks = selectRulePacks(
    rulePacks,
    planning.phases.flatMap((phase) => phase.rulePackIds),
  );
  const protocolPrompt = buildExecutionProtocolPrompt({
    skill,
    planning,
    selectedRulePacks,
    mode,
  });
  await writeJson(
    join(generationRecordDir, "call-02-generation.request.json"),
    {
      model: requiredText(options.model, "model"),
      mode,
      systemPrompt: protocolPrompt.systemPrompt,
      userPrompt: protocolPrompt.userPrompt,
    },
  );
  const protocolCall = await requestOpenAiCompatibleJson({
    ...buildLlmRequestBase(options, "harness-generation"),
    systemPrompt: protocolPrompt.systemPrompt,
    userPrompt: protocolPrompt.userPrompt,
    requestLabel: "harness-generation",
    traceRunDir: generationRecordDir,
  });
  await writeJson(
    join(generationRecordDir, "call-02-generation.response.json"),
    {
      text: protocolCall.text,
      llm: protocolCall.llm,
    },
  );
  const executionProtocol = parseAndValidateExecutionProtocol(
    parseLooseJson(protocolCall.text),
    { skill, planning, mode, rulePacks },
  );
  await writeJson(
    join(generationRecordDir, "execution-protocol.json"),
    executionProtocol,
  );

  const generatedAt = (options.now ?? new Date()).toISOString();
  const packageResult = await writeHarnessPackage({
    projectRoot: options.projectRoot,
    packageDir,
    skill,
    planning,
    protocol: executionProtocol,
    selectedRulePacks,
    generatedAt,
  });

  const summary: HarnessGenerationSummary = {
    schemaVersion: "oysterworkflow-harness-generation-summary-v1",
    generatedAt,
    sourceSkillId: skill.skillId,
    mode,
    output: {
      outDir,
      generationRecordDir,
      packageDir,
      skillPath: packageResult.skillPath,
      harnessJsonPath: packageResult.harnessJsonPath,
    },
    llm: combineLlm([planningCall.llm, protocolCall.llm]) ?? undefined,
    warnings: [],
  };
  await writeJson(join(generationRecordDir, "summary.json"), summary);

  return {
    sourceSkill: skill,
    planning,
    executionProtocol,
    harnessIndex: packageResult.harnessIndex,
    summary,
  };
}

function buildLlmRequestBase(
  options: GenerateHarnessOptions,
  profileKey: "harness-planning" | "harness-generation",
) {
  const profile = options.callProfiles?.[profileKey];
  return {
    wireApi: options.wireApi ?? "responses",
    baseUrl: requiredText(options.baseUrl, "baseUrl"),
    apiKey: options.apiKey?.trim() ?? "",
    model: requiredText(options.model, "model"),
    reasoningEffort: profile?.reasoningEffort ?? options.reasoningEffort,
    responseReadTimeoutMs:
      profile?.responseReadTimeoutMs ?? options.responseReadTimeoutMs,
    responseTimeoutMode: options.responseTimeoutMode,
    clientProfile: options.clientProfile,
    extraHeaders: options.extraHeaders,
  };
}

function selectRulePacks(rulePacks: RulePack[], ids: string[]): RulePack[] {
  const index = indexRulePacks(rulePacks);
  const uniqueIds = [...new Set(ids)];
  return uniqueIds.map((id) => {
    const rulePack = index.get(id);
    if (!rulePack) {
      throw new Error(`Selected unknown RulePack: ${id}`);
    }
    return rulePack;
  });
}

function combineLlm(
  items: Array<LlmInvocationSummary | null | undefined>,
): LlmInvocationSummary | null {
  const filtered = items.filter(
    (item): item is LlmInvocationSummary => item !== null && item !== undefined,
  );
  if (filtered.length === 0) {
    return null;
  }
  return filtered.reduce<LlmInvocationSummary>(
    (accumulator, item) => ({
      callCount: accumulator.callCount + item.callCount,
      inputTokens: accumulator.inputTokens + item.inputTokens,
      outputTokens: accumulator.outputTokens + item.outputTokens,
      totalTokens: accumulator.totalTokens + item.totalTokens,
      totalReactionTimeMs:
        accumulator.totalReactionTimeMs + item.totalReactionTimeMs,
    }),
    {
      callCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      totalReactionTimeMs: 0,
    },
  );
}

function requiredText(value: string | undefined, label: string): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  throw new Error(`Harness generation requires ${label}.`);
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
