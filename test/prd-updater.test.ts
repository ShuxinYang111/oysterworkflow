import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { updatePrdFromQuality } from "../src/quality/prd-updater.js";
import type { SkillQualityReport } from "../src/types/contracts.js";

/**
 * EN: Builds quality report fixture.
 * @param score quality score.
 * @returns quality report.
 */
function buildReport(score: number): SkillQualityReport {
  return {
    schemaVersion: "openclaw-quality-v1",
    evaluatedAt: "2026-03-04T04:00:00.000Z",
    runId: "run-001",
    episodeId: "run-001-ep-0001",
    skillId: "skill-001",
    score,
    threshold: 70,
    verdict: score >= 70 ? "usable" : "needs-improvement",
    dimensions: [],
    strengths: [],
    issues: ["Steps are too templated"],
    improvements: ["Increase app/window filter priority"],
    details: {
      warningsCount: 0,
      stepsCount: 2,
      genericStepCount: 1,
      contextAnchoredStepCount: 2,
      dominantApp: "Google Chrome",
      dominantAppStepCoverage: 1,
    },
  };
}

describe("updatePrdFromQuality", () => {
  // EN: Should append to PRD when score is below threshold.
  it("writes PRD entry when quality is below threshold", async () => {
    const tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-prd-"),
    );
    const prdPath = path.join(tempRoot, "PRD.md");

    const result = await updatePrdFromQuality({
      report: buildReport(62),
      prdPath,
      caseTitle: "Screenpipe Test Case（11:50:00-11:57:00）",
    });

    expect(result.updated).toBe(true);
    const content = await readFile(prdPath, "utf8");
    expect(content.includes("runId: run-001")).toBe(true);
    expect(content.includes("score: 62/70")).toBe(true);
  });
  // EN: Should skip PRD update when score passes threshold.
  it("skips write when quality passes threshold", async () => {
    const tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-prd-skip-"),
    );
    const prdPath = path.join(tempRoot, "PRD.md");

    const result = await updatePrdFromQuality({
      report: buildReport(88),
      prdPath,
      caseTitle: "Screenpipe Test Case（11:50:00-11:57:00）",
    });

    expect(result.updated).toBe(false);
  });
  // EN: Should not append duplicate entry for the same runId.
  it("is idempotent for same runId", async () => {
    const tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-prd-idempotent-"),
    );
    const prdPath = path.join(tempRoot, "PRD.md");
    const report = buildReport(60);

    const first = await updatePrdFromQuality({
      report,
      prdPath,
      caseTitle: "Screenpipe Test Case（11:50:00-11:57:00）",
    });
    const second = await updatePrdFromQuality({
      report,
      prdPath,
      caseTitle: "Screenpipe Test Case（11:50:00-11:57:00）",
    });

    expect(first.updated).toBe(true);
    expect(second.updated).toBe(false);

    const content = await readFile(prdPath, "utf8");
    const runMentions = content.match(/runId: run-001/g) ?? [];
    expect(runMentions).toHaveLength(1);
  });
});
