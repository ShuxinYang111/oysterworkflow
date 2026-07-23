import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { resolveExtractSkillLlmOptions } from "../cli/commands/extract-skill-llm.js";
import {
  applyPlannerOptimizationToSkill,
  applyScenarioGeneralizationToSkill,
  createDefaultOpenAiClient,
  normalizeGeneralizedSkillDraft,
  normalizePlannerOptimizationDraft,
  normalizePredictedReusableScenarios,
  sanitizeScenarioIdentifier,
  summarizeLlmError,
} from "../skill/extract-openclaw-llm.js";
import { runGeneralizationComponent } from "../skill/generalization/index.js";
import { loadPromptSet } from "../skill/prompt-registry.js";
import { buildPromptTemplateVars } from "../skill/prompt-template-vars.js";
import { sliceEventsForWorkflow } from "../skill/workflow-event-slice.js";
import { DEFAULT_USER_SKILL_CONFIG } from "../skill/user-skill-config.js";
import {
  assertWorkflowGraphCompatibility,
  materializeWorkflowGraphArtifacts,
} from "../skill/workflow-graph.js";
import type {
  Episode,
  NormalizedEvent,
  OpenClawSkill,
  SkillExtractionSummary,
  WorkflowCandidate,
} from "../types/contracts.js";
import type {
  LabGeneralizationSummary,
  LabPlannerOptimizationSummary,
  PlannerOptimizationSourceType,
} from "./contracts.js";

export interface RunLabGeneralizationOptions {
  skillPath: string;
  summaryPath: string;
  workflowPath?: string;
  outDir: string;
  configPath?: string;
  now?: Date;
}

export interface RunLabGeneralizationResult {
  outDir: string;
  summaryPath: string;
  summary: LabGeneralizationSummary;
}

export interface RunLabPlannerOptimizationOptions {
  sourceType: PlannerOptimizationSourceType;
  skillPath: string;
  outDir: string;
  configPath?: string;
  now?: Date;
  selectedWorkflowId?: string | null;
}

export interface RunLabPlannerOptimizationResult {
  outDir: string;
  skillPath: string;
  summaryPath: string;
  skill: OpenClawSkill;
  summary: LabPlannerOptimizationSummary;
}

/**
 * EN: Runs the standalone generalization component for one base skill and persists the lab summary file.
 * @param options input skill/summary, optional workflow context, and output directory.
 * @returns generalization summary and artifact paths.
 */
export async function runLabGeneralization(
  options: RunLabGeneralizationOptions,
): Promise<RunLabGeneralizationResult> {
  const skillPath = resolve(options.skillPath);
  const summaryPath = resolve(options.summaryPath);
  const outDir = resolve(options.outDir);
  const skill = await readJsonFile<OpenClawSkill>(skillPath);
  const summary = await readJsonFile<SkillExtractionSummary>(summaryPath);
  const selectedWorkflow = await resolveSelectedWorkflow({
    summary,
    workflowPath: options.workflowPath,
  });
  const events = await loadWorkflowEvents({
    runDir: skill.source.runDir,
    episodeId: skill.source.episodeId,
    workflow: selectedWorkflow,
  });
  if (events.length === 0) {
    throw new Error(
      `Selected workflow produced no events for generalization: ${selectedWorkflow.workflowId}`,
    );
  }

  const resolvedOptions = await resolveExtractSkillLlmOptions({
    runDir: skill.source.runDir,
    outDir,
    configPath: options.configPath,
  });
  const userSkillConfig =
    resolvedOptions.userSkillConfig ?? DEFAULT_USER_SKILL_CONFIG;
  const llmClient =
    resolvedOptions.llmClient ?? createDefaultOpenAiClient(resolvedOptions);
  const promptSet = await loadPromptSet(userSkillConfig.promptSet);
  const templateVars = buildPromptTemplateVars({
    promptSet: promptSet.promptSet,
    granularity: userSkillConfig.granularity,
    promptVersionTag: userSkillConfig.promptVersionTag,
    providedSkillName: skill.skillName,
  });
  const generatedAt = (options.now ?? new Date()).toISOString();
  const componentSummary = await runGeneralizationComponent({
    outDir,
    skill,
    summary,
    events,
    selectedWorkflow,
    promptSet,
    userSkillConfig,
    templateVars,
    now: options.now,
    async executeScenarioPrediction() {
      if (!llmClient.predictReusableScenarios) {
        throw new Error(
          "LLM client does not implement scenario prediction/generalization.",
        );
      }
      const rawResult = await llmClient.predictReusableScenarios({
        skill,
        summary,
        selectedWorkflow,
      });
      return {
        rawResult,
        metrics: llmClient.getLastInvocationMetrics?.() ?? null,
        warnings: llmClient.getLastInvocationWarnings?.() ?? [],
      };
    },
    normalizeScenarios: (rawResult, warnings) =>
      normalizePredictedReusableScenarios(rawResult, warnings),
    async executeScenarioGeneralization(input) {
      if (!llmClient.generalizeSkillForScenario) {
        throw new Error(
          "LLM client does not implement scenario prediction/generalization.",
        );
      }
      const rawResult = await llmClient.generalizeSkillForScenario({
        skill,
        summary,
        selectedWorkflow,
        scenario: input.scenario,
      });
      return {
        rawResult,
        metrics: llmClient.getLastInvocationMetrics?.() ?? null,
        warnings: llmClient.getLastInvocationWarnings?.() ?? [],
      };
    },
    materializeGeneralizedSkill(input) {
      const draft = normalizeGeneralizedSkillDraft({
        rawDraft: input.rawResult,
        events: input.events,
        warnings: input.warnings,
      });
      return applyScenarioGeneralizationToSkill({
        skill: input.skill,
        draft,
        events: input.events,
        scenario: input.scenario,
        generatedAt: input.generatedAt,
        warnings: input.warnings,
      });
    },
    summarizeError: summarizeLlmError,
    sanitizeScenarioIdentifier,
  });

  const variantArtifacts = await Promise.all(
    componentSummary.variants.map(async (variant) => ({
      summary: variant,
      skill: await readJsonFile<OpenClawSkill>(variant.output.skillPath),
    })),
  );
  const persistedSummary: LabGeneralizationSummary = {
    schemaVersion: "lab-generalization-summary-v1",
    generatedAt,
    sourceSkillPath: skillPath,
    sourceSummaryPath: summaryPath,
    selectedWorkflowId:
      summary.selectedWorkflowId ?? selectedWorkflow.workflowId,
    predictedScenariosPath: componentSummary.predictedScenariosPath,
    scenarioCount: componentSummary.scenarioCount,
    variants: componentSummary.variants,
    variantArtifacts,
    ...(componentSummary.llm ? { llm: componentSummary.llm } : {}),
    warnings: componentSummary.warnings,
  };
  const persistedSummaryPath = join(outDir, "summary.json");
  await writeJsonFile(persistedSummaryPath, persistedSummary);

  return {
    outDir,
    summaryPath: persistedSummaryPath,
    summary: persistedSummary,
  };
}

/**
 * EN: Runs planner optimization for one existing skill and persists the optimized skill separately.
 * @param options source skill, source type, and output directory.
 * @returns optimized skill and summary paths.
 */
export async function runLabPlannerOptimization(
  options: RunLabPlannerOptimizationOptions,
): Promise<RunLabPlannerOptimizationResult> {
  const sourceSkillPath = resolve(options.skillPath);
  const outDir = resolve(options.outDir);
  const generatedAt = (options.now ?? new Date()).toISOString();
  const sourceSkill = await readJsonFile<OpenClawSkill>(sourceSkillPath);
  const resolvedOptions = await resolveExtractSkillLlmOptions({
    runDir: sourceSkill.source.runDir,
    outDir,
    configPath: options.configPath,
  });
  const llmClient =
    resolvedOptions.llmClient ?? createDefaultOpenAiClient(resolvedOptions);
  if (!llmClient.optimizeSkillForPlanner) {
    throw new Error("LLM client does not implement planner optimization.");
  }

  const rawPlannerDraft = await llmClient.optimizeSkillForPlanner({
    skill: sourceSkill,
  });
  const warnings = llmClient.getLastInvocationWarnings?.() ?? [];
  const plannerDraft = normalizePlannerOptimizationDraft(rawPlannerDraft);
  const optimizedSkill = applyPlannerOptimizationToSkill({
    skill: sourceSkill,
    draft: plannerDraft,
    runId: sourceSkill.source.runId,
    episodeId: sourceSkill.source.episodeId,
    generatedAt,
  });
  const skillPath = join(outDir, "skill.json");
  const summaryPath = join(outDir, "summary.json");
  const workflowGraphPath = join(outDir, "workflow.json");
  const workflowMarkdownPath = join(outDir, "WORKFLOW.md");
  const workflowRevisionsDir = join(outDir, ".workflow-revisions");
  const summary: LabPlannerOptimizationSummary = {
    schemaVersion: "lab-planner-optimization-summary-v1",
    generatedAt,
    sourceType: options.sourceType,
    sourceSkillPath,
    sourceSkillId: sourceSkill.skillId,
    sourceSkillName: sourceSkill.skillName,
    ...(options.selectedWorkflowId !== undefined
      ? { selectedWorkflowId: options.selectedWorkflowId }
      : {}),
    output: {
      outDir,
      skillPath,
      summaryPath,
      workflowGraphPath,
      workflowMarkdownPath,
      workflowRevisionsDir,
    },
    ...(llmClient.getLastInvocationMetrics?.()
      ? { llm: llmClient.getLastInvocationMetrics?.() ?? undefined }
      : {}),
    warnings,
  };

  await assertWorkflowGraphCompatibility({ skill: optimizedSkill, outDir });
  await writeJsonFile(skillPath, optimizedSkill);
  await materializeWorkflowGraphArtifacts({
    skill: optimizedSkill,
    outDir,
    sourceSkillPath: skillPath,
  });
  await writeJsonFile(summaryPath, summary);

  return {
    outDir,
    skillPath,
    summaryPath,
    skill: optimizedSkill,
    summary,
  };
}

async function resolveSelectedWorkflow(input: {
  summary: SkillExtractionSummary;
  workflowPath?: string;
}): Promise<WorkflowCandidate> {
  const embeddedCandidates = Array.isArray(input.summary.workflowCandidates)
    ? input.summary.workflowCandidates
    : [];
  const candidates =
    embeddedCandidates.length > 0
      ? embeddedCandidates
      : await loadWorkflowCandidates(input.workflowPath);
  if (candidates.length === 0) {
    throw new Error("Failed to resolve selected workflow for generalization.");
  }
  const selectedWorkflowId =
    typeof input.summary.selectedWorkflowId === "string" &&
    input.summary.selectedWorkflowId.length > 0
      ? input.summary.selectedWorkflowId
      : null;
  if (!selectedWorkflowId) {
    return candidates[0] as WorkflowCandidate;
  }
  return (candidates.find(
    (candidate) => candidate.workflowId === selectedWorkflowId,
  ) ?? candidates[0]) as WorkflowCandidate;
}

async function loadWorkflowCandidates(
  workflowPath?: string,
): Promise<WorkflowCandidate[]> {
  if (!workflowPath) {
    return [];
  }
  const raw = await readJsonFile<unknown>(resolve(workflowPath));
  if (isRecord(raw) && Array.isArray(raw.workflowCandidates)) {
    return raw.workflowCandidates as WorkflowCandidate[];
  }
  if (Array.isArray(raw)) {
    return raw as WorkflowCandidate[];
  }
  if (isRecord(raw)) {
    return [raw as unknown as WorkflowCandidate];
  }
  return [];
}

async function loadWorkflowEvents(input: {
  runDir: string;
  episodeId: string;
  workflow: WorkflowCandidate;
}): Promise<NormalizedEvent[]> {
  const episodesPath = join(resolve(input.runDir), "episodes.json");
  const episodes = await readJsonFile<Episode[]>(episodesPath);
  const episode =
    episodes.find((candidate) => candidate.id === input.episodeId) ?? null;
  if (!episode) {
    throw new Error(`Episode not found for skill source: ${input.episodeId}`);
  }
  const allEvents = [...episode.events].sort(
    (left, right) => left.tsMs - right.tsMs,
  );
  return sliceEventsForWorkflow(allEvents, input.workflow);
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw) as T;
}

async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
