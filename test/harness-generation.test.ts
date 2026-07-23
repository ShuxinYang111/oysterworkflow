import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadRulePackCatalog } from "../src/harness/rule-pack-catalog.js";
import { writeHarnessPackage } from "../src/harness/renderer.js";
import type {
  ExecutionProtocol,
  HarnessPlanning,
} from "../src/harness/types.js";
import { parseAndValidateHarnessPlanning } from "../src/harness/validation.js";
import type { OpenClawSkill } from "../src/types/contracts.js";

let tempRoot = "";
const projectRoot = join(import.meta.dirname, "..");

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "oyster-harness-"));
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe("harness planning validation", () => {
  it("accepts one surface RulePack plus one compatible app RulePack per phase", async () => {
    const rulePacks = await loadRulePackCatalog({ projectRoot });
    const planning = parseAndValidateHarnessPlanning(
      {
        schemaVersion: "oysterworkflow-harness-planning-v1",
        sourceSkillId: sampleSkill.skillId,
        phases: [
          {
            id: "phase-01",
            title: "Draft Gmail reply",
            objective:
              "Find the target Gmail thread and prepare a reply draft.",
            sourceSkillSteps: [1, 2],
            entryState: "The browser is available and the user is signed in.",
            exitState: "A draft reply is visible in the target Gmail thread.",
            rulePackIds: ["surface.browser", "app.gmail"],
            artifacts: ["reply draft"],
          },
        ],
      },
      { skill: sampleSkill, rulePacks },
    );

    expect(planning.phases[0]?.rulePackIds).toEqual([
      "surface.browser",
      "app.gmail",
    ]);
  });

  it("rejects first-call planning that includes reference lookup or protocol details", async () => {
    const rulePacks = await loadRulePackCatalog({ projectRoot });

    expect(() =>
      parseAndValidateHarnessPlanning(
        {
          schemaVersion: "oysterworkflow-harness-planning-v1",
          sourceSkillId: sampleSkill.skillId,
          phases: [
            {
              id: "phase-01",
              title: "Draft Gmail reply",
              objective:
                "Find the target Gmail thread and prepare a reply draft.",
              sourceSkillSteps: [1],
              entryState: "Gmail is open.",
              exitState: "A draft exists.",
              rulePackIds: ["surface.browser", "app.gmail"],
              referenceLookups: [
                {
                  rulePackId: "app.gmail",
                  referenceId: "gmail-common-errors",
                },
              ],
              checkpointNeeds: ["Ask before sending."],
            },
          ],
        },
        { skill: sampleSkill, rulePacks },
      ),
    ).toThrow();
  });

  it("rejects more than two RulePacks in one phase", async () => {
    const rulePacks = await loadRulePackCatalog({ projectRoot });

    expect(() =>
      parseAndValidateHarnessPlanning(
        {
          schemaVersion: "oysterworkflow-harness-planning-v1",
          sourceSkillId: sampleSkill.skillId,
          phases: [
            {
              id: "phase-01",
              title: "Too many packs",
              objective: "Invalidly attach three RulePacks.",
              sourceSkillSteps: [1],
              entryState: "A browser is open.",
              exitState: "Work is complete.",
              rulePackIds: ["surface.browser", "app.gmail", "app.word"],
            },
          ],
        },
        { skill: sampleSkill, rulePacks },
      ),
    ).toThrow();
  });

  it("rejects app RulePacks that are incompatible with the selected surface", async () => {
    const rulePacks = await loadRulePackCatalog({ projectRoot });

    expect(() =>
      parseAndValidateHarnessPlanning(
        {
          schemaVersion: "oysterworkflow-harness-planning-v1",
          sourceSkillId: sampleSkill.skillId,
          phases: [
            {
              id: "phase-01",
              title: "Wrong surface",
              objective: "Try to run Word app rules in a browser phase.",
              sourceSkillSteps: [1],
              entryState: "A browser is open.",
              exitState: "A Word document is saved.",
              rulePackIds: ["surface.browser", "app.word"],
            },
          ],
        },
        { skill: sampleSkill, rulePacks },
      ),
    ).toThrow(/not compatible/u);
  });
});

describe("harness package renderer", () => {
  it("writes SKILL.md, lightweight harness.json, phase files, and rule references", async () => {
    const rulePacks = await loadRulePackCatalog({ projectRoot });
    const selectedRulePacks = rulePacks.filter((rulePack) =>
      ["surface.browser", "app.gmail"].includes(rulePack.id),
    );
    const packageDir = join(tempRoot, "package");

    const result = await writeHarnessPackage({
      projectRoot,
      packageDir,
      skill: sampleSkill,
      planning: samplePlanning,
      protocol: sampleProtocol,
      selectedRulePacks,
      generatedAt: "2026-07-07T00:00:00.000Z",
    });

    const skillMd = await readFile(result.skillPath, "utf8");
    expect(skillMd).toContain("name: draft-gmail-reply-harness");
    expect(skillMd).toContain("references/phases/phase-01.md");

    const harnessJson = JSON.parse(
      await readFile(result.harnessJsonPath, "utf8"),
    ) as { phases: Array<{ file: string }>; selectedRulePacks: unknown[] };
    expect(harnessJson.phases[0]?.file).toBe("references/phases/phase-01.md");
    expect(JSON.stringify(harnessJson)).not.toContain("instructions");
    expect(harnessJson.selectedRulePacks).toHaveLength(2);

    const phaseMd = await readFile(
      join(packageDir, "references", "phases", "phase-01.md"),
      "utf8",
    );
    expect(phaseMd).toContain("references/rules/surface-browser.md");
    expect(phaseMd).toContain("references/rules/app-gmail.md");

    const ruleMd = await readFile(
      join(packageDir, "references", "rules", "app-gmail.md"),
      "utf8",
    );
    expect(ruleMd).toContain("Gmail App Rules");
  });
});

const sampleSkill: OpenClawSkill = {
  schemaVersion: "openclaw-skill-v1",
  promptSet: null,
  skillId: "skill-gmail-draft",
  skillName: "Draft Gmail reply",
  generatedAt: "2026-07-07T00:00:00.000Z",
  source: {
    runId: "run-1",
    runDir: tempRoot,
    episodeId: "episode-1",
    startTs: "2026-07-07T00:00:00.000Z",
    endTs: "2026-07-07T00:01:00.000Z",
  },
  description: "Find a Gmail thread and draft a reply.",
  goal: "Draft a reply without sending it.",
  whenToUse: ["When a Gmail reply draft is needed."],
  whenNotToUse: ["When the user wants the email sent immediately."],
  inputs: [],
  outputs: [],
  prerequisites: [],
  steps: [
    {
      step: 1,
      instruction: "Open Gmail and find the target thread.",
      intent: "Locate target thread",
      operationApp: "Gmail",
      hints: [],
    },
    {
      step: 2,
      instruction: "Draft a reply in the thread without sending.",
      intent: "Prepare draft",
      operationApp: "Gmail",
      hints: [],
    },
  ],
  successCriteria: ["The reply draft is visible and unsent."],
  failureModes: [],
  fallback: [],
  examples: [],
  tags: [],
  assets: [],
  evidence: {
    totalEvents: 2,
    anchorEvents: 2,
    ocrEvents: 0,
    appsSeen: ["Gmail"],
    windowsSeen: ["Gmail"],
  },
};

const samplePlanning: HarnessPlanning = {
  schemaVersion: "oysterworkflow-harness-planning-v1",
  sourceSkillId: "skill-gmail-draft",
  phases: [
    {
      id: "phase-01",
      title: "Draft Gmail reply",
      objective:
        "Find the target Gmail thread and prepare an unsent reply draft.",
      sourceSkillSteps: [1, 2],
      entryState: "Gmail is available in a signed-in browser session.",
      exitState: "The target thread has a visible unsent reply draft.",
      rulePackIds: ["surface.browser", "app.gmail"],
      artifacts: ["reply draft"],
    },
  ],
  assumptions: [],
};

const sampleProtocol: ExecutionProtocol = {
  schemaVersion: "oysterworkflow-harness-execution-protocol-v1",
  sourceSkillId: "skill-gmail-draft",
  title: "Draft Gmail Reply Harness",
  description:
    "Use this harness to find a Gmail thread and draft a reply without sending.",
  mode: "autonomous",
  phases: [
    {
      id: "phase-01",
      title: "Draft Gmail reply",
      objective:
        "Find the target Gmail thread and prepare an unsent reply draft.",
      rulePackIds: ["surface.browser", "app.gmail"],
      instructions: [
        "Confirm the Gmail account and locate the target thread.",
        "Draft the reply in the existing thread and leave it unsent.",
      ],
      validation: [
        "Verify the draft is visible in the target thread and has not been sent.",
      ],
      askUserBefore: [],
      stopIf: ["Stop if multiple threads match the target."],
    },
  ],
  finalValidation: ["The target Gmail thread shows the unsent draft."],
  blockingReportFields: ["Target thread", "Observed draft state"],
  assumptions: [],
};
