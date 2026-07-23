import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { SkillQualityReport } from "../types/contracts.js";

/**
 * EN: Input options for PRD update.
 */
export interface UpdatePrdFromQualityInput {
  report: SkillQualityReport;
  prdPath?: string;
  caseTitle?: string;
}

/**
 * EN: PRD update result.
 */
export interface UpdatePrdFromQualityResult {
  prdPath: string;
  updated: boolean;
}

/**
 * EN: Appends improvement items into PRD.md when quality is below threshold.
 * @param input quality report and PRD path.
 * @returns update result.
 */
export async function updatePrdFromQuality(
  input: UpdatePrdFromQualityInput,
): Promise<UpdatePrdFromQualityResult> {
  const prdPath = resolve(input.prdPath ?? "PRD.md");
  const caseTitle =
    normalizeText(input.caseTitle) ||
    "Screenpipe Test Case (11:50:00-11:57:00)";
  const { report } = input;

  if (report.score >= report.threshold) {
    return { prdPath, updated: false };
  }

  await mkdir(dirname(prdPath), { recursive: true });
  const existing = await readTextIfExists(prdPath);
  const runMarker = `runId: ${report.runId}`;
  if (existing.includes(runMarker)) {
    return { prdPath, updated: false };
  }

  const header = buildHeader(caseTitle);
  const section = buildImprovementSection(caseTitle, report);
  const next =
    existing.trim().length > 0
      ? `${existing.replace(/\s*$/, "\n\n")}${section}`
      : `${header}\n\n${section}`;

  await writeFile(prdPath, `${next.replace(/\s*$/, "\n")}`, "utf8");
  return { prdPath, updated: true };
}

/**
 * EN: Reads text file and returns empty string when absent.
 * @param path file path.
 * @returns file content or empty string.
 */
async function readTextIfExists(path: string): Promise<string> {
  try {
    await access(path);
  } catch {
    return "";
  }

  return readFile(path, "utf8");
}

/**
 * EN: Builds default PRD header.
 * @param caseTitle case title.
 * @returns markdown header text.
 */
function buildHeader(caseTitle: string): string {
  return [
    "# PRD - oysterworkflow",
    "",
    "## Background",
    "- Goal: extract Screenpipe traces into executable, reusable agent skills.",
    `- Regression case: ${caseTitle}`,
    "",
    "## Quality Gate",
    "- Score threshold: 70 (anything below this is not directly usable and requires recorded improvements).",
    "",
    "## Improvement Backlog",
  ].join("\n");
}

/**
 * EN: Formats one low-quality result into a PRD markdown entry.
 * @param caseTitle case title.
 * @param report quality report.
 * @returns markdown entry.
 */
function buildImprovementSection(
  caseTitle: string,
  report: SkillQualityReport,
): string {
  const issueLines =
    report.issues.length > 0
      ? report.issues
      : [
          "The quality score is below the threshold, but no concrete issue was generated.",
        ];
  const improvementLines =
    report.improvements.length > 0
      ? report.improvements
      : ["Add more fine-grained quality diagnostics and rerun this case."];

  const issueMarkdown = issueLines.map((item) => `- ${item}`).join("\n");
  const improvementMarkdown = improvementLines
    .map((item) => `- ${item}`)
    .join("\n");

  return [
    `### ${report.evaluatedAt}`,
    `- case: ${caseTitle}`,
    `- runId: ${report.runId}`,
    `- episodeId: ${report.episodeId}`,
    `- skillId: ${report.skillId}`,
    `- score: ${report.score}/${report.threshold}`,
    `- verdict: ${report.verdict}`,
    "",
    "Issues:",
    issueMarkdown,
    "",
    "Improvements:",
    improvementMarkdown,
  ].join("\n");
}

/**
 * EN: Trims text safely.
 * @param value raw text.
 * @returns normalized text.
 */
function normalizeText(value: string | undefined): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}
