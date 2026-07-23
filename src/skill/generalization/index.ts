import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { renderPromptTemplate } from "../prompt-registry.js";
import type { LoadedPromptSet } from "../prompt-registry.js";
import type { UserSkillConfig } from "../user-skill-config.js";
import {
  assertWorkflowGraphCompatibility,
  materializeWorkflowGraphArtifacts,
} from "../workflow-graph.js";
import type {
  GeneralizedSkillVariantSummary,
  LlmInvocationSummary,
  NormalizedEvent,
  OpenClawSkill,
  PredictedReuseScenario,
  SkillExtractionSummary,
  SkillGeneralizationSummary,
  WorkflowCandidate,
} from "../../types/contracts.js";

type ScenarioPredictionPromptSection = LoadedPromptSet["scenarioPrediction"];
type ScenarioGeneralizationPromptSection =
  LoadedPromptSet["scenarioGeneralization"];

export const DEFAULT_SCENARIO_PREDICTION_PROMPT_SECTION: NonNullable<ScenarioPredictionPromptSection> =
  {
    system: [
      "You are an AI skill generation engine that learns structured capabilities from real human computer behavior. A concrete skill has already been generated, and your task in this stage is to predict the most likely situations in which the user will reuse it next.",
      "The input will include one already-generated skill JSON.",
      "Predict 1 to 3 likely future reuse scenarios. If only 1 or 2 scenarios are genuinely likely, do not force a third.",
      "The output must be a single JSON object with no extra commentary.",
      "The top-level field must be: scenarios.",
      "scenarios must be an array with 1 to 3 items.",
      "Each scenario must include: scenarioId and nextUseHypothesis.",
    ],
    userPreamble: [],
  };

export const DEFAULT_SCENARIO_GENERALIZATION_PROMPT_SECTION: NonNullable<ScenarioGeneralizationPromptSection> =
  {
    system: [
      "You are an agent skill generalizer that transforms a specific skill into a more reusable one.",
      "The input will include: 1. an already-generated specific skill JSON; 2. a predicted reuse scenario card; 3. related workflow and evidence summaries.",
      "Your task is to generalize the current specific skill into a more reusable but still trustworthy generalized skill based on the scenario card.",
      "You must follow the scenario card's nextUseHypothesis and keep the generalized skill aligned with that predicted reuse context.",
      "Action verbs usually remain invariant. Platforms, tools, and domain usually remain invariant. Time should become relative when context-dependent. Entities, quantities, filters, UI text, and other parameters should be retained or generalized based on the scenario.",
      "When reasoning about outputs, distinguish between a stable container and a temporary instance.",
      "Do not change: schemaVersion, promptSet, skillId, generatedAt, source, executionMode, evidence, assets, failureModes, fallback.",
      "You may rewrite: skillName, shortDescription, description, goal, whenToUse, whenNotToUse, inputs, outputs, prerequisites, steps, successCriteria, examples, tags.",
      "failureModes and fallback are evidence-bound human experience. Preserve them exactly from the source skill and do not invent, expand, or rewrite them during generalization.",
      "Do not turn the generalized skill into a different task, and do not remove the key step skeleton required to reach task closure.",
      "The output must be a single JSON object with no extra commentary.",
    ],
    userPreamble: [
      "Task: generate a generalized skill draft from the specific skill and the scenario card.",
      "promptSet={{promptSet}} granularity={{granularity}}",
      "promptVersionTag={{promptVersionTag}}",
      "Hard requirements:",
      "- Output only a JSON object with no extra commentary.",
      "- Output only the fields that are allowed to change. Do not return schemaVersion, promptSet, skillId, generatedAt, source, executionMode, evidence, assets, failureModes, or fallback.",
      "- The generalized skill must stay consistent with the scenario card.",
      "- If time should be generalized, use relative time expressions rather than keeping this run's absolute date.",
      "- If the output target is a stable platform or container, keep it. If it is only a temporary instance, generalize it into a descriptive target.",
      "- Preserve the key stages from entry to closure in the steps. Do not collapse the process into an empty template.",
    ],
  };

export interface ScenarioPredictionPromptPayload {
  systemPrompt: string;
  userPrompt: string;
}

export interface ScenarioGeneralizationPromptPayload {
  systemPrompt: string;
  userPrompt: string;
}

export interface ScenarioPredictionExecutionResult {
  rawResult: unknown;
  metrics: LlmInvocationSummary | null;
  warnings: string[];
}

export interface ScenarioGeneralizationExecutionResult {
  rawResult: unknown;
  metrics: LlmInvocationSummary | null;
  warnings: string[];
}

export interface RunGeneralizationComponentInput {
  outDir: string;
  skill: OpenClawSkill;
  summary: SkillExtractionSummary;
  events: NormalizedEvent[];
  selectedWorkflow: WorkflowCandidate;
  promptSet: LoadedPromptSet;
  userSkillConfig: UserSkillConfig;
  templateVars: Record<string, string>;
  now?: Date;
  executeScenarioPrediction: (
    payload: ScenarioPredictionPromptPayload,
  ) => Promise<ScenarioPredictionExecutionResult>;
  normalizeScenarios: (
    rawResult: unknown,
    warnings: string[],
  ) => PredictedReuseScenario[];
  executeScenarioGeneralization: (input: {
    scenario: PredictedReuseScenario;
    payload: ScenarioGeneralizationPromptPayload;
  }) => Promise<ScenarioGeneralizationExecutionResult>;
  materializeGeneralizedSkill: (input: {
    rawResult: unknown;
    scenario: PredictedReuseScenario;
    generatedAt: string;
    warnings: string[];
    events: NormalizedEvent[];
    skill: OpenClawSkill;
  }) => OpenClawSkill;
  summarizeError: (error: unknown) => string;
  sanitizeScenarioIdentifier: (value: string) => string;
}

function writeJson(filePath: string, payload: unknown): Promise<void> {
  return writeFile(filePath, JSON.stringify(payload, null, 2) + "\n", "utf8");
}

function pushWarning(warnings: string[], message: string): void {
  if (!warnings.includes(message)) {
    warnings.push(message);
  }
}

function combineInvocationMetrics(
  metrics: Array<LlmInvocationSummary | null>,
): LlmInvocationSummary | null {
  const available = metrics.filter(
    (item): item is LlmInvocationSummary => item !== null,
  );
  if (available.length === 0) {
    return null;
  }

  return available.reduce<LlmInvocationSummary>(
    (accumulator, current) => ({
      callCount: accumulator.callCount + current.callCount,
      inputTokens: accumulator.inputTokens + current.inputTokens,
      outputTokens: accumulator.outputTokens + current.outputTokens,
      totalTokens: accumulator.totalTokens + current.totalTokens,
      totalReactionTimeMs:
        accumulator.totalReactionTimeMs + current.totalReactionTimeMs,
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

/**
 * EN: Builds the prompt payload for scenario prediction.
 * @param input current skill, prompt set, and template variables.
 * @returns system/user prompt text.
 */
export function buildScenarioPredictionPromptPayload(input: {
  skill: OpenClawSkill;
  promptSet: LoadedPromptSet;
  templateVars: Record<string, string>;
}): ScenarioPredictionPromptPayload {
  const promptSection =
    input.promptSet.scenarioPrediction ??
    DEFAULT_SCENARIO_PREDICTION_PROMPT_SECTION;
  const systemPrompt = renderPromptTemplate(
    promptSection.system,
    input.templateVars,
  );
  const userPreamble = renderPromptTemplate(
    promptSection.userPreamble,
    input.templateVars,
  );
  const sections: string[] = [];
  if (userPreamble.trim().length > 0) {
    sections.push(userPreamble);
  }
  sections.push("Current specific skill JSON:");
  sections.push(JSON.stringify(input.skill, null, 2));

  return {
    systemPrompt,
    userPrompt: sections.join("\n"),
  };
}

/**
 * EN: Builds the prompt payload for scenario-conditioned generalization.
 * @param input skill, scenario card, prompt set, and template variables.
 * @returns system/user prompt text.
 */
export function buildScenarioGeneralizationPromptPayload(input: {
  skill: OpenClawSkill;
  scenario: PredictedReuseScenario;
  promptSet: LoadedPromptSet;
  templateVars: Record<string, string>;
}): ScenarioGeneralizationPromptPayload {
  const promptSection =
    input.promptSet.scenarioGeneralization ??
    DEFAULT_SCENARIO_GENERALIZATION_PROMPT_SECTION;
  const systemPrompt = renderPromptTemplate(
    promptSection.system,
    input.templateVars,
  );
  const userPreamble = renderPromptTemplate(
    promptSection.userPreamble,
    input.templateVars,
  );
  const sections: string[] = [];
  if (userPreamble.trim().length > 0) {
    sections.push(userPreamble);
  }
  sections.push("Scenario card:");
  sections.push(JSON.stringify(input.scenario, null, 2));
  sections.push("Current specific skill JSON:");
  sections.push(JSON.stringify(input.skill, null, 2));

  return {
    systemPrompt,
    userPrompt: sections.join("\n"),
  };
}

/**
 * EN: Runs the standalone generalization component, including scenario prediction, per-scenario generalization, and artifact persistence.
 * @param input component input, prompt context, and injected execution/normalization logic.
 * @returns generalization summary.
 */
export async function runGeneralizationComponent(
  input: RunGeneralizationComponentInput,
): Promise<SkillGeneralizationSummary> {
  const warnings: string[] = [];
  const variants: GeneralizedSkillVariantSummary[] = [];
  const stageMetrics: Array<LlmInvocationSummary | null> = [];
  const baseTime = input.now ?? new Date();
  const generalizedRootDir = join(input.outDir, "generalized");
  const predictedScenariosPath = join(input.outDir, "predicted-scenarios.json");

  let scenarios: PredictedReuseScenario[];
  try {
    const predictionPayload = buildScenarioPredictionPromptPayload({
      skill: input.skill,
      promptSet: input.promptSet,
      templateVars: input.templateVars,
    });
    const predictionResult =
      await input.executeScenarioPrediction(predictionPayload);
    stageMetrics.push(predictionResult.metrics);
    warnings.push(...predictionResult.warnings);
    scenarios = input.normalizeScenarios(predictionResult.rawResult, warnings);
    await mkdir(input.outDir, { recursive: true });
    await writeJson(predictedScenariosPath, scenarios);
  } catch (error) {
    pushWarning(
      warnings,
      `Generalization skipped: ${input.summarizeError(error)}`,
    );
    return {
      predictedScenariosPath: null,
      scenarioCount: 0,
      variants,
      ...(combineInvocationMetrics(stageMetrics)
        ? { llm: combineInvocationMetrics(stageMetrics) ?? undefined }
        : {}),
      warnings,
    };
  }

  for (const [index, scenario] of scenarios.entries()) {
    const scenarioWarnings: string[] = [];
    const generatedAt = new Date(baseTime.getTime() + index + 1).toISOString();
    const scenarioDir = join(
      generalizedRootDir,
      `${String(index + 1).padStart(2, "0")}-${input.sanitizeScenarioIdentifier(scenario.scenarioId)}`,
    );
    const skillPath = join(scenarioDir, "skill.json");
    const summaryPath = join(scenarioDir, "summary.json");
    const workflowGraphPath = join(scenarioDir, "workflow.json");
    const workflowMarkdownPath = join(scenarioDir, "WORKFLOW.md");
    const workflowRevisionsDir = join(scenarioDir, ".workflow-revisions");

    try {
      const generalizationPayload = buildScenarioGeneralizationPromptPayload({
        skill: input.skill,
        scenario,
        promptSet: input.promptSet,
        templateVars: input.templateVars,
      });
      const generalizationResult = await input.executeScenarioGeneralization({
        scenario,
        payload: generalizationPayload,
      });
      stageMetrics.push(generalizationResult.metrics);
      scenarioWarnings.push(...generalizationResult.warnings);
      const generalizedSkill = input.materializeGeneralizedSkill({
        rawResult: generalizationResult.rawResult,
        scenario,
        generatedAt,
        warnings: scenarioWarnings,
        events: input.events,
        skill: input.skill,
      });
      const variantSummary: GeneralizedSkillVariantSummary = {
        schemaVersion: "openclaw-generalized-skill-summary-v1",
        generatedAt,
        sourceSkillId: input.skill.skillId,
        scenarioId: scenario.scenarioId,
        nextUseHypothesis: scenario.nextUseHypothesis,
        skillId: generalizedSkill.skillId,
        output: {
          outDir: scenarioDir,
          skillPath,
          summaryPath,
          workflowGraphPath,
          workflowMarkdownPath,
          workflowRevisionsDir,
        },
        ...(generalizationResult.metrics
          ? { llm: generalizationResult.metrics }
          : {}),
        warnings: scenarioWarnings,
      };
      await mkdir(scenarioDir, { recursive: true });
      await assertWorkflowGraphCompatibility({
        skill: generalizedSkill,
        outDir: scenarioDir,
      });
      await writeJson(skillPath, generalizedSkill);
      await materializeWorkflowGraphArtifacts({
        skill: generalizedSkill,
        outDir: scenarioDir,
        sourceSkillPath: skillPath,
      });
      await writeJson(summaryPath, variantSummary);
      variants.push(variantSummary);
    } catch (error) {
      pushWarning(
        warnings,
        `Scenario ${scenario.scenarioId} generalization skipped: ${input.summarizeError(error)}`,
      );
    }
  }

  const llm = combineInvocationMetrics(stageMetrics);
  return {
    predictedScenariosPath,
    scenarioCount: scenarios.length,
    variants,
    ...(llm ? { llm } : {}),
    warnings,
  };
}
