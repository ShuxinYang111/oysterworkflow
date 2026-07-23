import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import {
  createDefaultOpenAiClient,
  type ExtractOpenClawSkillLlmOptions,
  type OpenClawLlmCallProfiles,
  type OpenClawLlmClient,
  type OpenAiCompatibleClientProfile,
  type OpenAiWireApi,
} from "../../skill/extract-openclaw-llm.js";
import type {
  LlmInvocationSummary,
  OpenClawSkill,
  PredictedReuseScenario,
  SkillExtractionSummary,
  WorkflowCandidate,
} from "../../types/contracts.js";
import { resolveExtractSkillLlmOptions } from "./extract-skill-llm.js";

const replayCallSchema = z.enum([
  "planner-optimization",
  "scenario-prediction",
  "scenario-generalization",
]);
const wireApiSchema = z.enum(["responses", "chat-completions"]);

const replayLlmCallArgsSchema = z.object({
  call: replayCallSchema,
  skillPath: z.string().min(1),
  summaryPath: z.string().min(1).optional(),
  workflowPath: z.string().min(1).optional(),
  predictedScenariosPath: z.string().min(1).optional(),
  scenarioPath: z.string().min(1).optional(),
  scenarioId: z.string().min(1).optional(),
  out: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  apiKey: z.string().min(1).optional(),
  baseUrl: z.string().url().optional(),
  wireApi: wireApiSchema.optional(),
  reasoningEffort: z.string().min(1).optional(),
  config: z.string().min(1).optional(),
});

type ReplayCallName = z.infer<typeof replayCallSchema>;

export interface RunReplayLlmCallOptions {
  call: ReplayCallName;
  skillPath: string;
  summaryPath?: string;
  workflowPath?: string;
  predictedScenariosPath?: string;
  scenarioPath?: string;
  scenarioId?: string;
  outDir?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  wireApi?: OpenAiWireApi;
  reasoningEffort?: string;
  clientProfile?: OpenAiCompatibleClientProfile;
  extraHeaders?: Record<string, string>;
  callProfiles?: OpenClawLlmCallProfiles;
  now?: Date;
  llmClient?: OpenClawLlmClient;
  configPath?: string;
}

export interface ReplayLlmCallResult {
  call: ReplayCallName;
  outDir: string;
  resultPath: string;
  reportPath: string;
  traceDir: string;
  rawResult: unknown;
  metrics: LlmInvocationSummary | null;
  warnings: string[];
  selectedWorkflow: WorkflowCandidate | null;
  scenario: PredictedReuseScenario | null;
}

interface ReplayLlmCallReport {
  schemaVersion: "oysterworkflow-replay-llm-call-v1";
  generatedAt: string;
  call: ReplayCallName;
  promptSet: string | null;
  input: {
    skillPath: string;
    summaryPath: string | null;
    workflowPath: string | null;
    predictedScenariosPath: string | null;
    scenarioPath: string | null;
    scenarioId: string | null;
  };
  context: {
    skillId: string;
    skillName: string;
    selectedWorkflowId: string | null;
    scenarioId: string | null;
  };
  output: {
    outDir: string;
    resultPath: string;
    traceDir: string;
  };
  llm: LlmInvocationSummary | null;
  warnings: string[];
}

/**
 * EN: Replays one specific LLM call so prompt tweaks can be compared quickly against the same context.
 * @param options replay config (call name, existing skill/summary/scenario paths, and LLM overrides).
 * @returns replay result, trace directory, and persisted report paths.
 */
export async function runReplayLlmCall(
  options: RunReplayLlmCallOptions,
): Promise<ReplayLlmCallResult> {
  const outDir = resolve(
    options.outDir ?? buildDefaultReplayOutDir(options.call, options.now),
  );
  await mkdir(outDir, { recursive: true });

  const resolved = await resolveExtractSkillLlmOptions({
    runDir: outDir,
    outDir,
    model: options.model,
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    wireApi: options.wireApi,
    reasoningEffort: options.reasoningEffort,
    clientProfile: options.clientProfile,
    extraHeaders: options.extraHeaders,
    callProfiles: options.callProfiles,
    now: options.now,
    llmClient: options.llmClient,
    configPath: options.configPath,
  });

  const llmClient =
    resolved.llmClient ??
    createDefaultOpenAiClient(resolved as ExtractOpenClawSkillLlmOptions);
  const skillPath = resolve(options.skillPath);
  const skill = await loadSkill(skillPath);
  const summaryPath = resolveSummaryPath({
    call: options.call,
    skillPath,
    summaryPath: options.summaryPath,
    predictedScenariosPath: options.predictedScenariosPath,
    scenarioPath: options.scenarioPath,
  });
  const summary = summaryPath ? await loadSummary(summaryPath) : null;
  const generatedAt = (resolved.now ?? options.now ?? new Date()).toISOString();

  let selectedWorkflow: WorkflowCandidate | null = null;
  let scenario: PredictedReuseScenario | null = null;
  let rawResult: unknown;

  if (options.call === "planner-optimization") {
    rawResult = await llmClient.optimizeSkillForPlanner?.({ skill });
    if (!llmClient.optimizeSkillForPlanner) {
      throw new Error("LLM client does not implement planner-optimization.");
    }
  } else if (options.call === "scenario-prediction") {
    const replaySummary =
      summary ??
      buildReplaySummaryFromSkill({
        skill,
        outDir,
        generatedAt,
      });
    selectedWorkflow =
      summary !== null
        ? await resolveWorkflowContext({
            summary: replaySummary,
            workflowPath: options.workflowPath,
          })
        : buildReplayWorkflowFromSkill(skill);
    rawResult = await llmClient.predictReusableScenarios?.({
      skill,
      summary: replaySummary,
      selectedWorkflow,
    });
    if (!llmClient.predictReusableScenarios) {
      throw new Error("LLM client does not implement scenario-prediction.");
    }
  } else {
    const replaySummary =
      summary ??
      buildReplaySummaryFromSkill({
        skill,
        outDir,
        generatedAt,
      });
    selectedWorkflow =
      summary !== null
        ? await resolveWorkflowContext({
            summary: replaySummary,
            workflowPath: options.workflowPath,
          })
        : buildReplayWorkflowFromSkill(skill);
    scenario = await resolveScenarioContext({
      summary: replaySummary,
      predictedScenariosPath: options.predictedScenariosPath,
      scenarioPath: options.scenarioPath,
      scenarioId: options.scenarioId,
    });
    rawResult = await llmClient.generalizeSkillForScenario?.({
      skill,
      summary: replaySummary,
      selectedWorkflow,
      scenario,
    });
    if (!llmClient.generalizeSkillForScenario) {
      throw new Error("LLM client does not implement scenario-generalization.");
    }
  }

  const normalizedWarnings = llmClient.getLastInvocationWarnings?.() ?? [];
  const metrics = llmClient.getLastInvocationMetrics?.() ?? null;
  const resultPath = join(outDir, `${options.call}-result.json`);
  const reportPath = join(outDir, "report.json");
  const traceDir = join(outDir, "llm-trace");

  await writeJson(resultPath, rawResult ?? null);
  const report: ReplayLlmCallReport = {
    schemaVersion: "oysterworkflow-replay-llm-call-v1",
    generatedAt,
    call: options.call,
    promptSet: resolved.userSkillConfig?.promptSet ?? null,
    input: {
      skillPath,
      summaryPath,
      workflowPath: options.workflowPath ? resolve(options.workflowPath) : null,
      predictedScenariosPath: options.predictedScenariosPath
        ? resolve(options.predictedScenariosPath)
        : (summary?.generalization?.predictedScenariosPath ?? null),
      scenarioPath: options.scenarioPath ? resolve(options.scenarioPath) : null,
      scenarioId: options.scenarioId ?? null,
    },
    context: {
      skillId: skill.skillId,
      skillName: skill.skillName,
      selectedWorkflowId: selectedWorkflow?.workflowId ?? null,
      scenarioId: scenario?.scenarioId ?? null,
    },
    output: {
      outDir,
      resultPath,
      traceDir,
    },
    llm: metrics,
    warnings: normalizedWarnings,
  };
  await writeJson(reportPath, report);

  return {
    call: options.call,
    outDir,
    resultPath,
    reportPath,
    traceDir,
    rawResult,
    metrics,
    warnings: normalizedWarnings,
    selectedWorkflow,
    scenario,
  };
}

/**
 * EN: Parses and validates replay-llm-call CLI arguments.
 * @param input raw CLI input.
 * @returns typed single-call replay options.
 */
export function parseReplayLlmCallCliArgs(input: {
  call: ReplayCallName | string;
  skillPath: string;
  summaryPath?: string;
  workflowPath?: string;
  predictedScenariosPath?: string;
  scenarioPath?: string;
  scenarioId?: string;
  out?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  wireApi?: OpenAiWireApi | string;
  reasoningEffort?: string;
  config?: string;
}): RunReplayLlmCallOptions {
  const parsed = replayLlmCallArgsSchema.parse(input);
  return {
    call: parsed.call,
    skillPath: parsed.skillPath,
    summaryPath: parsed.summaryPath,
    workflowPath: parsed.workflowPath,
    predictedScenariosPath: parsed.predictedScenariosPath,
    scenarioPath: parsed.scenarioPath,
    scenarioId: parsed.scenarioId,
    outDir: parsed.out,
    model: parsed.model,
    apiKey: parsed.apiKey,
    baseUrl: parsed.baseUrl,
    wireApi: parsed.wireApi,
    reasoningEffort: parsed.reasoningEffort,
    configPath: parsed.config,
  };
}

function buildDefaultReplayOutDir(call: ReplayCallName, now?: Date): string {
  const date = now ?? new Date();
  const dayStamp = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("");
  const timeStamp = date
    .toISOString()
    .replace(/[:.]/g, "")
    .replace("T", "-")
    .replace("Z", "Z");
  return resolve(
    process.cwd(),
    ".runs",
    `llm-call-replay-codex-${dayStamp}-${call}-${timeStamp}`,
  );
}

function resolveSummaryPath(input: {
  call: ReplayCallName;
  skillPath: string;
  summaryPath?: string;
  predictedScenariosPath?: string;
  scenarioPath?: string;
}): string | null {
  if (input.summaryPath) {
    return resolve(input.summaryPath);
  }
  if (
    input.call !== "scenario-generalization" ||
    input.scenarioPath ||
    input.predictedScenariosPath
  ) {
    return null;
  }
  return join(dirname(input.skillPath), "summary.json");
}

function buildReplaySummaryFromSkill(input: {
  skill: OpenClawSkill;
  outDir: string;
  generatedAt: string;
}): SkillExtractionSummary {
  return {
    runId: input.skill.source.runId,
    episodeId: input.skill.source.episodeId,
    skillId: input.skill.skillId,
    generatedAt: input.generatedAt,
    sourceEvents: input.skill.evidence.totalEvents,
    stepsCount: input.skill.steps.length,
    workflowCandidates: [buildReplayWorkflowFromSkill(input.skill)],
    selectedWorkflowId: "workflow-replay",
    selectedWorkflowPriority: 1,
    output: {
      outDir: input.outDir,
      skillPath: join(input.outDir, "replay-skill.json"),
      summaryPath: join(input.outDir, "replay-summary.json"),
    },
    warnings: [
      "Replay summary synthesized from skill.json because summary.json was not provided.",
    ],
  };
}

function buildReplayWorkflowFromSkill(skill: OpenClawSkill): WorkflowCandidate {
  return {
    workflowId: "workflow-replay",
    name: skill.skillName,
    description:
      skill.shortDescription ??
      skill.description ??
      "Synthesized replay workflow from skill.json.",
    goal: skill.goal,
    priority: 1,
    startEventId: "replay-start",
    endEventId: "replay-end",
    startTs: skill.source.startTs,
    endTs: skill.source.endTs,
    eventCount: skill.evidence.totalEvents,
    whyThisWorkflow:
      "Synthesized replay workflow because scenario-prediction replay was invoked without summary/workflow context.",
  };
}

async function resolveWorkflowContext(input: {
  summary: SkillExtractionSummary;
  workflowPath?: string;
}): Promise<WorkflowCandidate> {
  const selectedWorkflowId =
    typeof input.summary.selectedWorkflowId === "string" &&
    input.summary.selectedWorkflowId.length > 0
      ? input.summary.selectedWorkflowId
      : null;
  const summaryCandidates = Array.isArray(input.summary.workflowCandidates)
    ? input.summary.workflowCandidates
    : [];
  const candidates =
    summaryCandidates.length > 0
      ? summaryCandidates
      : await loadWorkflowCandidates(input.workflowPath);
  if (candidates.length === 0) {
    throw new Error(
      "Failed to resolve selected workflow. Provide summary.workflowCandidates or --workflow-path.",
    );
  }
  if (selectedWorkflowId) {
    const matched =
      candidates.find(
        (candidate) => candidate.workflowId === selectedWorkflowId,
      ) ?? null;
    if (matched) {
      return matched;
    }
  }
  return candidates[0];
}

async function loadWorkflowCandidates(
  workflowPath?: string,
): Promise<WorkflowCandidate[]> {
  if (!workflowPath) {
    return [];
  }

  const raw = await loadJson(resolve(workflowPath), "workflow");
  if (Array.isArray(raw)) {
    return raw.map((item, index) =>
      ensureWorkflowCandidate(item, `${workflowPath}[${index}]`),
    );
  }
  if (!isRecord(raw)) {
    throw new Error(
      `Workflow file must be a JSON object or array: ${workflowPath}`,
    );
  }
  if (Array.isArray(raw.workflowCandidates)) {
    return raw.workflowCandidates.map((item, index) =>
      ensureWorkflowCandidate(
        item,
        `${workflowPath}.workflowCandidates[${index}]`,
      ),
    );
  }
  return [ensureWorkflowCandidate(raw, workflowPath)];
}

async function resolveScenarioContext(input: {
  summary: SkillExtractionSummary;
  predictedScenariosPath?: string;
  scenarioPath?: string;
  scenarioId?: string;
}): Promise<PredictedReuseScenario> {
  const scenarios = await loadScenarios(input);
  if (scenarios.length === 0) {
    throw new Error(
      "No scenario cards available for scenario-generalization. Provide --scenario-path or --predicted-scenarios-path.",
    );
  }
  if (input.scenarioId) {
    const matched =
      scenarios.find((item) => item.scenarioId === input.scenarioId) ?? null;
    if (!matched) {
      throw new Error(`Scenario not found: ${input.scenarioId}`);
    }
    return matched;
  }
  return scenarios[0];
}

async function loadScenarios(input: {
  summary: SkillExtractionSummary;
  predictedScenariosPath?: string;
  scenarioPath?: string;
}): Promise<PredictedReuseScenario[]> {
  if (input.scenarioPath) {
    const raw = await loadJson(resolve(input.scenarioPath), "scenario");
    return unwrapScenarioCollection(raw, input.scenarioPath);
  }

  const predictedScenariosPath =
    input.predictedScenariosPath ??
    input.summary.generalization?.predictedScenariosPath ??
    null;
  if (!predictedScenariosPath) {
    return [];
  }
  const raw = await loadJson(
    resolve(predictedScenariosPath),
    "predicted scenarios",
  );
  return unwrapScenarioCollection(raw, predictedScenariosPath);
}

async function loadSkill(filePath: string): Promise<OpenClawSkill> {
  return ensureSkill(await loadJson(filePath, "skill"), filePath);
}

async function loadSummary(filePath: string): Promise<SkillExtractionSummary> {
  return ensureSummary(await loadJson(filePath, "summary"), filePath);
}

async function loadJson(filePath: string, label: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    throw new Error(
      `Failed to read ${label} file at ${filePath}: ${toErrorMessage(error)}`,
    );
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid JSON in ${label} file at ${filePath}: ${toErrorMessage(error)}`,
    );
  }
}

function ensureSkill(value: unknown, filePath: string): OpenClawSkill {
  if (!isRecord(value)) {
    throw new Error(`Skill file must be a JSON object: ${filePath}`);
  }
  if (
    typeof value.skillId !== "string" ||
    typeof value.skillName !== "string"
  ) {
    throw new Error(`Skill file is missing skillId/skillName: ${filePath}`);
  }
  if (!Array.isArray(value.steps)) {
    throw new Error(`Skill file is missing steps array: ${filePath}`);
  }
  return value as unknown as OpenClawSkill;
}

function ensureSummary(
  value: unknown,
  filePath: string,
): SkillExtractionSummary {
  if (!isRecord(value)) {
    throw new Error(`Summary file must be a JSON object: ${filePath}`);
  }
  if (typeof value.runId !== "string" || typeof value.skillId !== "string") {
    throw new Error(`Summary file is missing runId/skillId: ${filePath}`);
  }
  return value as unknown as SkillExtractionSummary;
}

function ensureWorkflowCandidate(
  value: unknown,
  filePath: string,
): WorkflowCandidate {
  if (!isRecord(value)) {
    throw new Error(`Workflow candidate must be a JSON object: ${filePath}`);
  }
  if (
    typeof value.workflowId !== "string" ||
    typeof value.name !== "string" ||
    typeof value.startEventId !== "string" ||
    typeof value.endEventId !== "string"
  ) {
    throw new Error(
      `Workflow candidate is missing required fields: ${filePath}`,
    );
  }
  return value as unknown as WorkflowCandidate;
}

function ensureScenario(
  value: unknown,
  filePath: string,
): PredictedReuseScenario {
  if (!isRecord(value)) {
    throw new Error(`Scenario must be a JSON object: ${filePath}`);
  }
  const scenarioId = normalizeReplayText(
    pickReplayString(value, ["scenarioId"]),
  );
  const nextUseHypothesis = normalizeReplayText(
    pickReplayString(value, ["nextUseHypothesis"]),
  );
  if (!scenarioId || !nextUseHypothesis) {
    throw new Error(`Scenario is missing required fields: ${filePath}`);
  }

  return {
    scenarioId,
    nextUseHypothesis,
  };
}

function unwrapScenarioCollection(
  value: unknown,
  filePath: string,
): PredictedReuseScenario[] {
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      ensureScenario(item, `${filePath}[${index}]`),
    );
  }
  if (isRecord(value) && Array.isArray(value.scenarios)) {
    return value.scenarios.map((item, index) =>
      ensureScenario(item, `${filePath}.scenarios[${index}]`),
    );
  }
  if (isRecord(value) && typeof value.scenarioId === "string") {
    return [ensureScenario(value, filePath)];
  }
  throw new Error(
    `Scenario file must be a scenario object, a scenario array, or an object with scenarios[]: ${filePath}`,
  );
}

function pickReplayString(
  record: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

function normalizeReplayText(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
