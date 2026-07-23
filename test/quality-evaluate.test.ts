import { describe, expect, it } from "vitest";
import { evaluateSkillQuality } from "../src/quality/evaluate-skill.js";
import type {
  OpenClawSkill,
  SkillExtractionSummary,
} from "../src/types/contracts.js";

function buildSummary(warnings: string[] = []): SkillExtractionSummary {
  return {
    runId: "run-001",
    episodeId: "run-001-ep-0001",
    skillId: "skill-001",
    generatedAt: "2026-03-04T00:00:00.000Z",
    sourceEvents: 10,
    stepsCount: 3,
    output: {
      outDir: "/tmp/openclaw-llm",
      skillPath: "/tmp/openclaw-llm/skill.json",
      summaryPath: "/tmp/openclaw-llm/summary.json",
    },
    warnings,
  };
}

describe("evaluateSkillQuality", () => {
  it("scores a specific skill as usable without task heuristics", () => {
    const skill: OpenClawSkill = {
      schemaVersion: "openclaw-skill-v1",
      promptSet: "specific-v1",
      skillId: "skill-001",
      skillName: "Google Docs Material Organizer",
      generatedAt: "2026-03-04T00:00:00.000Z",
      source: {
        runId: "run-001",
        runDir: "/tmp/runs/run-001",
        episodeId: "run-001-ep-0001",
        startTs: "2026-03-03T19:50:00.000Z",
        endTs: "2026-03-03T19:57:00.000Z",
      },
      goal: " Google Docs  in Organize and write Vibe Coding studyRecord.",
      description: "",
      whenToUse: ["NeedReproduceDocumentOrganize"],
      whenNotToUse: [],
      inputs: [
        {
          name: "Course Link",
          description: "Organizestudylink.",
          required: true,
        },
      ],
      outputs: [],
      prerequisites: ["GoalDocumentpermissions"],
      steps: [
        {
          step: 1,
          instruction: "Open Google Docs Document and main bodyEnterarea.",
          intent: "Enterwrite.",
          operationApp: "Google Chrome",
          hints: ["Confirm the cursor is in the main body"],
        },
        {
          step: 2,
          instruction: "Enter Vibe Coding Course Link and key points.",
          intent: "CompleteDocument.",
          operationApp: "Google Chrome",
          hints: ["Keep the link and a short comment"],
        },
      ],
      successCriteria: [
        "The document contains structured study notes that make the source and key points easy to review.",
      ],
      failureModes: [],
      fallback: ["If input fails, refocus the document input area and retry"],
      examples: [],
      tags: [],
      assets: [],
      evidence: {
        totalEvents: 2,
        anchorEvents: 2,
        ocrEvents: 0,
        appsSeen: ["Google Chrome"],
        windowsSeen: ["Untitled document - Google Docs"],
      },
    };

    const report = evaluateSkillQuality({
      skill,
      summary: buildSummary(),
      threshold: 70,
      now: new Date("2026-03-04T00:00:00.000Z"),
    });

    expect(report.score).toBeGreaterThanOrEqual(70);
    expect(report.verdict).toBe("usable");
    expect(report.issues.length).toBeLessThanOrEqual(1);
    expect(report.details.parameterHintCount).toBeGreaterThan(0);
  });

  it("scores a generic off-surface skill as poor", () => {
    const skill: OpenClawSkill = {
      schemaVersion: "openclaw-skill-v1",
      promptSet: "specific-v1",
      skillId: "skill-002",
      skillName: "Terminal Daily Workflow Skill",
      generatedAt: "2026-03-04T00:00:00.000Z",
      source: {
        runId: "run-001",
        runDir: "/tmp/runs/run-001",
        episodeId: "run-001-ep-0001",
        startTs: "2026-03-03T19:50:00.000Z",
        endTs: "2026-03-03T19:57:00.000Z",
      },
      goal: "CompleteWorkflow.",
      description: "",
      whenToUse: ["NeedReproduceWorkflow"],
      whenNotToUse: [],
      inputs: [],
      outputs: [],
      prerequisites: ["Open"],
      steps: [
        {
          step: 1,
          instruction: "Perform the corresponding action to advance the task.",
          intent: "Advance the task with a generic placeholder workflow.",
          operationApp: "Terminal",
          hints: [],
        },
      ],
      successCriteria: ["Complete"],
      failureModes: [],
      fallback: ["Retry"],
      examples: [],
      tags: [],
      assets: [],
      evidence: {
        totalEvents: 20,
        anchorEvents: 10,
        ocrEvents: 10,
        appsSeen: ["Terminal", "Google Chrome"],
        windowsSeen: ["Terminal"],
      },
    };

    const report = evaluateSkillQuality({
      skill,
      summary: buildSummary(["LLM output looked noisy; applied cleanup."]),
      threshold: 70,
      now: new Date("2026-03-04T00:00:00.000Z"),
    });

    expect(report.score).toBeLessThan(70);
    expect(report.verdict).not.toBe("usable");
    expect(
      report.improvements.some((item) =>
        item.includes("The LLM output is too generic"),
      ),
    ).toBe(true);
    expect(
      report.improvements.some((item) =>
        item.includes("Task focus is too weak"),
      ),
    ).toBe(true);
  });

  it("does not reward generic fallback text without human evidence", () => {
    const baseSkill: OpenClawSkill = {
      schemaVersion: "openclaw-skill-v1",
      promptSet: "specific-v26",
      skillId: "skill-003",
      skillName: "Review one candidate profile",
      generatedAt: "2026-07-12T00:00:00.000Z",
      source: {
        runId: "run-003",
        runDir: "/tmp/runs/run-003",
        episodeId: "run-003-ep-0001",
        startTs: "2026-07-12T00:00:00.000Z",
        endTs: "2026-07-12T00:01:00.000Z",
      },
      goal: "Review one candidate profile.",
      description: "Review one candidate profile.",
      whenToUse: ["When a candidate profile needs review."],
      whenNotToUse: [],
      inputs: [],
      outputs: [],
      prerequisites: ["Candidate profile access."],
      steps: [
        {
          step: 1,
          instruction: "Open the candidate profile.",
          intent: "Enter the review surface.",
          operationApp: "Google Chrome",
          hints: [],
        },
        {
          step: 2,
          instruction: "Review the candidate details.",
          intent: "Complete the profile review.",
          operationApp: "Google Chrome",
          hints: [],
        },
      ],
      successCriteria: ["The candidate details have been reviewed."],
      failureModes: [],
      fallback: [],
      examples: [],
      tags: [],
      assets: [],
      evidence: {
        totalEvents: 2,
        anchorEvents: 2,
        ocrEvents: 0,
        appsSeen: ["Google Chrome"],
        windowsSeen: ["Candidate profile"],
      },
    };
    const withoutFallback = evaluateSkillQuality({
      skill: baseSkill,
      summary: buildSummary(),
      now: new Date("2026-07-12T00:00:00.000Z"),
    });
    const withGenericFallback = evaluateSkillQuality({
      skill: {
        ...baseSkill,
        fallback: ["Refresh the page and retry."],
      },
      summary: buildSummary(),
      now: new Date("2026-07-12T00:00:00.000Z"),
    });

    expect(withGenericFallback.score).toBe(withoutFallback.score);
    expect(withGenericFallback.details.closureScore).toBe(
      withoutFallback.details.closureScore,
    );
  });
});
