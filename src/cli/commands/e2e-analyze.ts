import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { z } from "zod";
import { runExtractSkillLlm } from "./extract-skill-llm.js";
import { parseApps, runIngest } from "./ingest.js";
import { getPreferredLlmConfigPath } from "../../io/project-paths.js";
import {
  compareSkillWithIdealFile,
  type SkillIdealComparison,
} from "../../quality/compare-ideal-skill.js";
import { evaluateSkillQuality } from "../../quality/evaluate-skill.js";
import {
  loadCaseCatalog,
  resolveCaseFixtureDir,
  startMockScreenpipe,
  type E2eCaseDefinition,
} from "../../e2e/case-fixtures.js";
import type {
  SkillGeneralizationSummary,
  SkillQualityReport,
} from "../../types/contracts.js";

const DEFAULT_OUTPUT_DIR = ".runs/e2e-analysis";

const e2eAnalyzeArgsSchema = z.object({
  out: z.string().min(1).optional(),
  cases: z.string().min(1),
});

export interface RunE2eAnalyzeOptions {
  out?: string;
  casesPath: string;
  now?: Date;
}

export interface ParseE2eAnalyzeCliInput {
  out?: string;
  cases?: string;
}

export interface E2eCaseAnalysis {
  id: string;
  title: string;
  description: string;
  sourceRunId: string;
  window: {
    from: string;
    to: string;
  };
  completeness: {
    expectedRawUiEvents: number;
    expectedRawOcr: number;
    actualRawUiEvents: number;
    actualRawOcr: number;
    uiCoverage: number;
    ocrCoverage: number;
    score: number;
    verdict: "pass" | "fail";
    notes: string[];
  };
  skillQuality: {
    score: number;
    threshold: number;
    verdict: SkillQualityReport["verdict"];
    stepsCount: number;
    qualityPath: string;
  };
  idealComparisons: {
    autonomous: SkillIdealComparison;
  };
  generalization: {
    scenarioCount: number;
    predictedScenariosPath: string | null;
    variantPaths: string[];
  };
  run: {
    runId: string;
    runDir: string;
    summaryPath: string;
    skillPath: string;
  };
}

export interface E2eAnalysisReport {
  schemaVersion: "oysterworkflow-e2e-analysis-v1";
  generatedAt: string;
  source: {
    casesPath: string;
    outDir: string;
  };
  overview: {
    casesTotal: number;
    completenessPassCount: number;
    qualityPassCount: number;
    autonomousIdealPassCount: number;
    avgCompletenessScore: number;
    avgQualityScore: number;
  };
  cases: E2eCaseAnalysis[];
}

export interface RunE2eAnalyzeResult {
  reportPath: string;
  markdownPath: string;
  report: E2eAnalysisReport;
}

/**
 * EN: Runs an explicit e2e case catalog and generates completeness + skill quality analysis.
 * @param options run options (output dir, catalog path, injectable clock).
 * @returns report object and JSON/Markdown artifact paths.
 */
export async function runE2eAnalyze(
  options: RunE2eAnalyzeOptions,
): Promise<RunE2eAnalyzeResult> {
  const parsed = e2eAnalyzeArgsSchema.parse({
    out: options.out,
    cases: options.casesPath,
  });

  const now = options.now ?? new Date();
  const generatedAt = now.toISOString();
  const outDir = resolve(parsed.out ?? DEFAULT_OUTPUT_DIR);
  const casesPath = resolve(parsed.cases);
  const llmConfigPath = getPreferredLlmConfigPath();

  const catalog = await loadCaseCatalog(casesPath);
  const fixturesRoot = resolve(
    basename(casesPath) === "cases.json"
      ? join(casesPath, "..")
      : "test/fixtures/e2e-cases",
  );
  await mkdir(outDir, { recursive: true });
  const runRoot = await mkdtemp(join(outDir, `${formatRunPrefix(now)}-`));

  const caseReports: E2eCaseAnalysis[] = [];
  for (const testCase of catalog.cases) {
    const caseOutRoot = join(runRoot, testCase.id);
    await mkdir(caseOutRoot, { recursive: true });
    const server = await startMockScreenpipe({ testCase, fixturesRoot });

    try {
      const ingestResult = await runIngest({
        from: testCase.from,
        to: testCase.to,
        apps: parseApps(testCase.apps),
        out: caseOutRoot,
        baseUrl: server.baseUrl,
      });

      const extractResult = await runExtractSkillLlm({
        runDir: ingestResult.manifest.paths.runDir,
        outDir: join(ingestResult.manifest.paths.runDir, "openclaw-e2e"),
        configPath: llmConfigPath,
      });

      const quality = evaluateSkillQuality({
        skill: extractResult.skill,
        summary: extractResult.summary,
        threshold: testCase.minQualityScore,
      });
      const qualityPath = join(extractResult.paths.outDir, "quality.json");
      await writeJson(qualityPath, quality);

      const caseFixtureRoot = join(
        fixturesRoot,
        resolveCaseFixtureDir(testCase.sourceDir),
      );
      const autonomousIdeal = await compareSkillWithIdealFile({
        generatedSkill: extractResult.skill,
        idealPath: join(caseFixtureRoot, "ideal", "autonomous.skill.json"),
        threshold: testCase.minAutonomousIdealScore,
      });

      const caseReport = buildCaseAnalysis({
        testCase,
        quality,
        qualityPath,
        runId: ingestResult.manifest.runId,
        runDir: ingestResult.manifest.paths.runDir,
        summaryPath: ingestResult.manifest.paths.summary,
        rawUiEventsCount: ingestResult.summary.fetch.rawUiEventsCount,
        rawOcrCount: ingestResult.summary.fetch.rawOcrCount,
        skillPath: extractResult.paths.skillPath,
        stepsCount: extractResult.summary.stepsCount,
        generalization: extractResult.summary.generalization,
        idealComparisons: {
          autonomous: autonomousIdeal,
        },
      });

      caseReports.push(caseReport);
    } finally {
      await server.close();
    }
  }

  const report: E2eAnalysisReport = {
    schemaVersion: "oysterworkflow-e2e-analysis-v1",
    generatedAt,
    source: {
      casesPath,
      outDir: runRoot,
    },
    overview: buildOverview(caseReports),
    cases: caseReports,
  };

  const reportPath = join(runRoot, "analysis.json");
  const markdownPath = join(runRoot, "analysis.md");
  await writeJson(reportPath, report);
  await writeFile(markdownPath, buildMarkdownReport(report), "utf8");

  return {
    reportPath,
    markdownPath,
    report,
  };
}

/**
 * EN: Parses and validates e2e-analyze CLI args.
 * @param input raw CLI input.
 * @returns typed options.
 */
export function parseE2eAnalyzeCliArgs(
  input: ParseE2eAnalyzeCliInput,
): RunE2eAnalyzeOptions {
  const parsed = e2eAnalyzeArgsSchema.parse(input);
  return {
    out: parsed.out,
    casesPath: parsed.cases,
  };
}

/**
 * EN: Builds one case analysis record.
 * @param input run metrics input.
 * @returns case analysis object.
 */
function buildCaseAnalysis(input: {
  testCase: E2eCaseDefinition;
  quality: SkillQualityReport;
  qualityPath: string;
  runId: string;
  runDir: string;
  summaryPath: string;
  rawUiEventsCount: number;
  rawOcrCount: number;
  skillPath: string;
  stepsCount: number;
  generalization?: SkillGeneralizationSummary;
  idealComparisons: {
    autonomous: SkillIdealComparison;
  };
}): E2eCaseAnalysis {
  const uiCoverage = calcCoverage(
    input.rawUiEventsCount,
    input.testCase.expectedRawUiEvents,
  );
  const ocrCoverage = calcCoverage(
    input.rawOcrCount,
    input.testCase.expectedRawOcr,
  );
  const completenessScore = Math.round(((uiCoverage + ocrCoverage) / 2) * 100);
  const notes = buildCompletenessNotes({
    actualUi: input.rawUiEventsCount,
    expectedUi: input.testCase.expectedRawUiEvents,
    actualOcr: input.rawOcrCount,
    expectedOcr: input.testCase.expectedRawOcr,
  });

  return {
    id: input.testCase.id,
    title: input.testCase.title,
    description: input.testCase.description,
    sourceRunId: input.testCase.sourceRunId,
    window: {
      from: input.testCase.from,
      to: input.testCase.to,
    },
    completeness: {
      expectedRawUiEvents: input.testCase.expectedRawUiEvents,
      expectedRawOcr: input.testCase.expectedRawOcr,
      actualRawUiEvents: input.rawUiEventsCount,
      actualRawOcr: input.rawOcrCount,
      uiCoverage,
      ocrCoverage,
      score: completenessScore,
      verdict:
        input.rawUiEventsCount >= input.testCase.expectedRawUiEvents &&
        input.rawOcrCount >= input.testCase.expectedRawOcr
          ? "pass"
          : "fail",
      notes,
    },
    skillQuality: {
      score: input.quality.score,
      threshold: input.quality.threshold,
      verdict: input.quality.verdict,
      stepsCount: input.stepsCount,
      qualityPath: input.qualityPath,
    },
    idealComparisons: input.idealComparisons,
    generalization: {
      scenarioCount: input.generalization?.scenarioCount ?? 0,
      predictedScenariosPath:
        input.generalization?.predictedScenariosPath ?? null,
      variantPaths:
        input.generalization?.variants.map(
          (variant) => variant.output.skillPath,
        ) ?? [],
    },
    run: {
      runId: input.runId,
      runDir: input.runDir,
      summaryPath: input.summaryPath,
      skillPath: input.skillPath,
    },
  };
}

/**
 * EN: Aggregates overview metrics across all cases.
 * @param cases list of case analyses.
 * @returns overview metrics.
 */
function buildOverview(
  cases: E2eCaseAnalysis[],
): E2eAnalysisReport["overview"] {
  if (cases.length === 0) {
    return {
      casesTotal: 0,
      completenessPassCount: 0,
      qualityPassCount: 0,
      autonomousIdealPassCount: 0,
      avgCompletenessScore: 0,
      avgQualityScore: 0,
    };
  }

  const completenessPassCount = cases.filter(
    (item) => item.completeness.verdict === "pass",
  ).length;
  const qualityPassCount = cases.filter(
    (item) => item.skillQuality.score >= item.skillQuality.threshold,
  ).length;
  const autonomousIdealPassCount = cases.filter(
    (item) =>
      item.idealComparisons.autonomous.score >=
      item.idealComparisons.autonomous.threshold,
  ).length;
  const avgCompletenessScore = Math.round(
    cases.reduce((sum, item) => sum + item.completeness.score, 0) /
      cases.length,
  );
  const avgQualityScore = Math.round(
    cases.reduce((sum, item) => sum + item.skillQuality.score, 0) /
      cases.length,
  );

  return {
    casesTotal: cases.length,
    completenessPassCount,
    qualityPassCount,
    autonomousIdealPassCount,
    avgCompletenessScore,
    avgQualityScore,
  };
}

/**
 * EN: Builds markdown analysis report.
 * @param report JSON report object.
 * @returns markdown text.
 */
function buildMarkdownReport(report: E2eAnalysisReport): string {
  const lines: string[] = [];
  lines.push("# E2E Case Analysis");
  lines.push("");
  lines.push(`- generatedAt: ${report.generatedAt}`);
  lines.push(`- casesTotal: ${report.overview.casesTotal}`);
  lines.push(
    `- completenessPass: ${report.overview.completenessPassCount}/${report.overview.casesTotal}`,
  );
  lines.push(
    `- qualityPass: ${report.overview.qualityPassCount}/${report.overview.casesTotal}`,
  );
  lines.push(`- avgCompletenessScore: ${report.overview.avgCompletenessScore}`);
  lines.push(`- avgQualityScore: ${report.overview.avgQualityScore}`);
  lines.push(
    `- autonomousIdealPass: ${report.overview.autonomousIdealPassCount}/${report.overview.casesTotal}`,
  );
  lines.push("");
  lines.push(
    "| case | completeness(score) | skill(score/threshold) | ideal(auto) | verdict |",
  );
  lines.push("| --- | --- | --- | --- | --- |");

  for (const item of report.cases) {
    const finalVerdict =
      item.completeness.verdict === "pass" &&
      item.skillQuality.score >= item.skillQuality.threshold
        ? "pass"
        : "fail";
    lines.push(
      `| ${item.id} | ${item.completeness.score} (ui=${item.completeness.uiCoverage.toFixed(3)}, ocr=${item.completeness.ocrCoverage.toFixed(3)}) | ${item.skillQuality.score}/${item.skillQuality.threshold} | ${item.idealComparisons.autonomous.score}/${item.idealComparisons.autonomous.threshold} | ${finalVerdict} |`,
    );
  }

  lines.push("");
  for (const item of report.cases) {
    lines.push(`## ${item.id}`);
    lines.push(`- title: ${item.title}`);
    lines.push(`- window: ${item.window.from} -> ${item.window.to}`);
    lines.push(
      `- completeness: ${item.completeness.verdict} (${item.completeness.score})`,
    );
    for (const note of item.completeness.notes) {
      lines.push(`- note: ${note}`);
    }
    lines.push(
      `- skillQuality: ${item.skillQuality.verdict} (${item.skillQuality.score}/${item.skillQuality.threshold})`,
    );
    lines.push(
      `- generalization.scenarioCount: ${item.generalization.scenarioCount}`,
    );
    if (item.generalization.predictedScenariosPath) {
      lines.push(
        `- generalization.predictedScenariosPath: ${item.generalization.predictedScenariosPath}`,
      );
    }
    if (item.generalization.variantPaths.length > 0) {
      lines.push(
        `- generalization.variantPaths: ${item.generalization.variantPaths.join(", ")}`,
      );
    }
    lines.push(
      `- autonomousIdeal: ${item.idealComparisons.autonomous.verdict} (${item.idealComparisons.autonomous.score}/${item.idealComparisons.autonomous.threshold})`,
    );
    lines.push(`- qualityPath: ${item.skillQuality.qualityPath}`);
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

/**
 * EN: Builds completeness notes.
 * @param input actual vs expected values.
 * @returns note list.
 */
function buildCompletenessNotes(input: {
  actualUi: number;
  expectedUi: number;
  actualOcr: number;
  expectedOcr: number;
}): string[] {
  const notes: string[] = [];

  if (input.actualUi < input.expectedUi) {
    notes.push(
      `UI events missing: expected=${input.expectedUi}, actual=${input.actualUi}`,
    );
  } else if (input.actualUi > input.expectedUi) {
    notes.push(
      `UI events extra: expected=${input.expectedUi}, actual=${input.actualUi}`,
    );
  } else {
    notes.push(`UI events match baseline: ${input.actualUi}`);
  }

  if (input.actualOcr < input.expectedOcr) {
    notes.push(
      `OCR rows missing: expected=${input.expectedOcr}, actual=${input.actualOcr}`,
    );
  } else if (input.actualOcr > input.expectedOcr) {
    notes.push(
      `OCR rows extra: expected=${input.expectedOcr}, actual=${input.actualOcr}`,
    );
  } else {
    notes.push(`OCR rows match baseline: ${input.actualOcr}`);
  }

  return notes;
}

/**
 * EN: Writes one object to JSON file (pretty + trailing newline).
 * @param path output path.
 * @param value value to serialize.
 * @returns resolves when done.
 */
async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/**
 * EN: Calculates coverage ratio (`actual/expected`, capped at 1).
 * @param actual actual value.
 * @param expected expected value.
 * @returns coverage ratio.
 */
function calcCoverage(actual: number, expected: number): number {
  if (expected <= 0) {
    return 1;
  }
  if (actual <= 0) {
    return 0;
  }
  return Math.min(1, actual / expected);
}

/**
 * EN: Builds timestamp prefix for output directory names.
 * @param now current time.
 * @returns directory prefix.
 */
function formatRunPrefix(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return [
    now.getUTCFullYear(),
    pad(now.getUTCMonth() + 1),
    pad(now.getUTCDate()),
    "T",
    pad(now.getUTCHours()),
    pad(now.getUTCMinutes()),
    pad(now.getUTCSeconds()),
    "Z",
  ].join("");
}
