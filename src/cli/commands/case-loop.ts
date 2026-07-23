import { writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { parseApps, runIngest } from "./ingest.js";
import { runExtractSkillLlm } from "./extract-skill-llm.js";
import { evaluateSkillQuality } from "../../quality/evaluate-skill.js";
import { updatePrdFromQuality } from "../../quality/prd-updater.js";
import type { SkillQualityReport } from "../../types/contracts.js";

const DEFAULT_CASE_DATE = "2026-03-03";
const DEFAULT_CASE_FROM_TIME = "11:50:00";
const DEFAULT_CASE_TO_TIME = "11:57:00";
const DEFAULT_MIN_SCORE = 70;
// EN: Validation schema for `oysterworkflow case-loop` arguments.
const caseLoopArgsSchema = z.object({
  out: z.string().min(1),
  apps: z.string().min(1).default("*"),
  baseUrl: z.string().url().default("http://localhost:3030"),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .default(DEFAULT_CASE_DATE),
  fromTime: z
    .string()
    .regex(/^\d{2}:\d{2}:\d{2}$/)
    .default(DEFAULT_CASE_FROM_TIME),
  toTime: z
    .string()
    .regex(/^\d{2}:\d{2}:\d{2}$/)
    .default(DEFAULT_CASE_TO_TIME),
  minScore: z.coerce.number().int().min(1).max(100).default(DEFAULT_MIN_SCORE),
  caseTitle: z.string().min(1).optional(),
  prd: z.string().min(1).optional(),
  config: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  apiKey: z.string().min(1).optional(),
  baseUrlLlm: z.string().url().optional(),
  wireApi: z.enum(["responses", "chat-completions"]).optional(),
  reasoningEffort: z.string().min(1).optional(),
  skillName: z.string().min(1).optional(),
});

export interface RunCaseLoopOptions {
  out: string;
  apps: string;
  baseUrl: string;
  date?: string;
  fromTime?: string;
  toTime?: string;
  minScore?: number;
  caseTitle?: string;
  prdPath?: string;
  llmConfigPath?: string;
  model?: string;
  apiKey?: string;
  llmBaseUrl?: string;
  wireApi?: "responses" | "chat-completions";
  reasoningEffort?: string;
  skillName?: string;
}

export interface RunCaseLoopResult {
  runId: string;
  runDir: string;
  fromIso: string;
  toIso: string;
  qualityPath: string;
  prdPath: string | null;
  prdUpdated: boolean;
  score: number;
  threshold: number;
  verdict: SkillQualityReport["verdict"];
  skillPath: string;
  summaryPath: string;
}

/**
 * EN: Runs fixed test-case loop (ingest -> LLM extraction -> quality evaluation -> PRD update).
 * @param options case-loop options.
 * @returns loop execution result.
 */
export async function runCaseLoop(
  options: RunCaseLoopOptions,
): Promise<RunCaseLoopResult> {
  const parsed = caseLoopArgsSchema.parse({
    out: options.out,
    apps: options.apps,
    baseUrl: options.baseUrl,
    date: options.date ?? DEFAULT_CASE_DATE,
    fromTime: options.fromTime ?? DEFAULT_CASE_FROM_TIME,
    toTime: options.toTime ?? DEFAULT_CASE_TO_TIME,
    minScore: options.minScore ?? DEFAULT_MIN_SCORE,
    caseTitle: options.caseTitle,
    prd: options.prdPath,
    config: options.llmConfigPath,
    model: options.model,
    apiKey: options.apiKey,
    baseUrlLlm: options.llmBaseUrl,
    wireApi: options.wireApi,
    reasoningEffort: options.reasoningEffort,
    skillName: options.skillName,
  });

  const outDir = resolve(parsed.out);
  if (!isAbsolute(outDir)) {
    throw new Error(`--out must be an absolute path, received: ${parsed.out}`);
  }

  const fromIso = buildLocalIso(parsed.date, parsed.fromTime);
  const toIso = buildLocalIso(parsed.date, parsed.toTime);
  if (Date.parse(toIso) <= Date.parse(fromIso)) {
    throw new Error(
      `Invalid case time window: ${parsed.date} ${parsed.fromTime} -> ${parsed.toTime}`,
    );
  }

  const ingestResult = await runIngest({
    from: fromIso,
    to: toIso,
    apps: parseApps(parsed.apps),
    out: outDir,
    baseUrl: parsed.baseUrl,
  });

  const extractResult = await runExtractSkillLlm({
    runDir: ingestResult.manifest.paths.runDir,
    configPath: parsed.config,
    model: parsed.model,
    apiKey: parsed.apiKey,
    baseUrl: parsed.baseUrlLlm,
    wireApi: parsed.wireApi,
    reasoningEffort: parsed.reasoningEffort,
    skillName: parsed.skillName,
  });

  const quality = evaluateSkillQuality({
    skill: extractResult.skill,
    summary: extractResult.summary,
    threshold: parsed.minScore,
  });

  const qualityPath = join(extractResult.paths.outDir, "quality.json");
  await writeJson(qualityPath, quality);

  const prdResult = await updatePrdFromQuality({
    report: quality,
    prdPath: parsed.prd,
    caseTitle:
      parsed.caseTitle ??
      `Screenpipe Test Case (${parsed.date} ${parsed.fromTime}-${parsed.toTime})`,
  });

  return {
    runId: ingestResult.manifest.runId,
    runDir: ingestResult.manifest.paths.runDir,
    fromIso,
    toIso,
    qualityPath,
    prdPath: prdResult.prdPath,
    prdUpdated: prdResult.updated,
    score: quality.score,
    threshold: quality.threshold,
    verdict: quality.verdict,
    skillPath: extractResult.paths.skillPath,
    summaryPath: extractResult.paths.summaryPath,
  };
}

/**
 * EN: Converts local date+time to UTC ISO string.
 * @param date local date (YYYY-MM-DD).
 * @param time local time (HH:mm:ss).
 * @returns UTC ISO timestamp.
 */
function buildLocalIso(date: string, time: string): string {
  const local = new Date(`${date}T${time}`);
  if (Number.isNaN(local.getTime())) {
    throw new Error(`Invalid local date/time: ${date} ${time}`);
  }
  return local.toISOString();
}

/**
 * EN: Parses and validates case-loop CLI arguments.
 * @param input raw CLI args.
 * @returns typed options.
 */
export function parseCaseLoopCliArgs(input: {
  out: string;
  apps?: string;
  baseUrl?: string;
  date?: string;
  fromTime?: string;
  toTime?: string;
  minScore?: number | string;
  caseTitle?: string;
  prd?: string;
  config?: string;
  model?: string;
  apiKey?: string;
  llmBaseUrl?: string;
  wireApi?: "responses" | "chat-completions" | string;
  reasoningEffort?: string;
  skillName?: string;
}): RunCaseLoopOptions {
  const parsed = caseLoopArgsSchema.parse({
    out: input.out,
    apps: input.apps ?? "*",
    baseUrl: input.baseUrl ?? "http://localhost:3030",
    date: input.date ?? DEFAULT_CASE_DATE,
    fromTime: input.fromTime ?? DEFAULT_CASE_FROM_TIME,
    toTime: input.toTime ?? DEFAULT_CASE_TO_TIME,
    minScore: input.minScore ?? DEFAULT_MIN_SCORE,
    caseTitle: input.caseTitle,
    prd: input.prd,
    config: input.config,
    model: input.model,
    apiKey: input.apiKey,
    baseUrlLlm: input.llmBaseUrl,
    wireApi: input.wireApi,
    reasoningEffort: input.reasoningEffort,
    skillName: input.skillName,
  });

  return {
    out: parsed.out,
    apps: parsed.apps,
    baseUrl: parsed.baseUrl,
    date: parsed.date,
    fromTime: parsed.fromTime,
    toTime: parsed.toTime,
    minScore: parsed.minScore,
    caseTitle: parsed.caseTitle,
    prdPath: parsed.prd,
    llmConfigPath: parsed.config,
    model: parsed.model,
    apiKey: parsed.apiKey,
    llmBaseUrl: parsed.baseUrlLlm,
    wireApi: parsed.wireApi,
    reasoningEffort: parsed.reasoningEffort,
    skillName: parsed.skillName,
  };
}

/**
 * EN: Writes one object into JSON file.
 * @param path output file path.
 * @param value object to serialize.
 * @returns resolves after write.
 */
async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
