import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseReplayLlmCallCliArgs,
  runReplayLlmCall,
} from "../src/cli/commands/replay-llm-call.js";
import type { OpenClawLlmClient } from "../src/skill/extract-openclaw-llm.js";
import type {
  OpenClawSkill,
  PredictedReuseScenario,
  SkillExtractionSummary,
  WorkflowCandidate,
} from "../src/types/contracts.js";

async function createReplayFixture(): Promise<{
  root: string;
  skillPath: string;
  summaryPath: string;
  predictedScenariosPath: string;
  workflow: WorkflowCandidate;
  scenario: PredictedReuseScenario;
}> {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "oysterworkflow-replay-llm-call-"),
  );
  const sourceDir = path.join(root, "source");
  await mkdir(sourceDir, { recursive: true });

  const workflow: WorkflowCandidate = {
    workflowId: "workflow-1",
    name: "Claim status check",
    description: "Check claim status in the portal.",
    goal: "Confirm the latest claim status.",
    priority: 1,
    startEventId: "e1",
    endEventId: "e9",
    startTs: "2026-03-30T10:00:00.000Z",
    endTs: "2026-03-30T10:05:00.000Z",
    eventCount: 9,
  };
  const scenario: PredictedReuseScenario = {
    scenarioId: "scenario-one",
    nextUseHypothesis: "The user will review another claim soon.",
  };
  const skill: OpenClawSkill = {
    schemaVersion: "openclaw-skill-v1",
    promptSet: "specific-v13",
    skillId: "skill-1",
    skillName: "Claim status check",
    generatedAt: "2026-03-30T10:05:00.000Z",
    source: {
      runId: "run-1",
      runDir: "/tmp/run-1",
      episodeId: "ep-1",
      startTs: "2026-03-30T10:00:00.000Z",
      endTs: "2026-03-30T10:05:00.000Z",
    },
    executionMode: "autonomous",
    shortDescription: "Check one claim status.",
    description: "Check the target claim status in the portal.",
    goal: "Confirm the latest claim status.",
    whenToUse: ["Need the current claim status."],
    whenNotToUse: ["Need to submit a new claim."],
    inputs: [],
    outputs: [],
    prerequisites: ["Have portal access."],
    steps: [
      {
        step: 1,
        instruction: "Open the claim detail page.",
        intent: "Reach the target claim.",
        operationApp: "Google Chrome",
        hints: [],
      },
    ],
    successCriteria: ["The latest claim status is visible."],
    failureModes: [],
    fallback: ["Refresh the page once."],
    examples: [],
    tags: ["claim"],
    assets: [],
    evidence: {
      totalEvents: 9,
      anchorEvents: 3,
      ocrEvents: 4,
      appsSeen: ["Google Chrome"],
      windowsSeen: ["Claims Portal"],
    },
  };

  const predictedScenariosPath = path.join(
    sourceDir,
    "predicted-scenarios.json",
  );
  const summary: SkillExtractionSummary = {
    runId: "run-1",
    episodeId: "ep-1",
    skillId: "skill-1",
    generatedAt: "2026-03-30T10:05:00.000Z",
    sourceEvents: 9,
    stepsCount: 1,
    workflowCandidates: [workflow],
    selectedWorkflowId: workflow.workflowId,
    selectedWorkflowPriority: workflow.priority,
    output: {
      outDir: sourceDir,
      skillPath: path.join(sourceDir, "skill.json"),
      summaryPath: path.join(sourceDir, "summary.json"),
    },
    generalization: {
      predictedScenariosPath,
      scenarioCount: 1,
      variants: [],
      warnings: [],
    },
    warnings: [],
  };

  const skillPath = path.join(sourceDir, "skill.json");
  const summaryPath = path.join(sourceDir, "summary.json");
  await writeFile(skillPath, JSON.stringify(skill, null, 2) + "\n", "utf8");
  await writeFile(summaryPath, JSON.stringify(summary, null, 2) + "\n", "utf8");
  await writeFile(
    predictedScenariosPath,
    JSON.stringify([scenario], null, 2) + "\n",
    "utf8",
  );

  return {
    root,
    skillPath,
    summaryPath,
    predictedScenariosPath,
    workflow,
    scenario,
  };
}

describe("replay-llm-call command", () => {
  it("parses CLI args into typed replay options", () => {
    const parsed = parseReplayLlmCallCliArgs({
      call: "scenario-generalization",
      skillPath: "/tmp/skill.json",
      summaryPath: "/tmp/summary.json",
      scenarioId: "scenario-one",
      config: "/tmp/llm.json",
    });

    expect(parsed.call).toBe("scenario-generalization");
    expect(parsed.skillPath).toBe("/tmp/skill.json");
    expect(parsed.summaryPath).toBe("/tmp/summary.json");
    expect(parsed.scenarioId).toBe("scenario-one");
    expect(parsed.configPath).toBe("/tmp/llm.json");
  });

  it("rejects removed legacy replay call names", () => {
    expect(() =>
      parseReplayLlmCallCliArgs({
        call: "callE",
        skillPath: "/tmp/skill.json",
      }),
    ).toThrow();
  });

  it("replays scenario-prediction with summary workflow context and persists artifacts", async () => {
    const fixture = await createReplayFixture();
    const outDir = path.join(fixture.root, "out-scenario-prediction");
    let receivedWorkflowId: string | null = null;

    const llmClient: OpenClawLlmClient = {
      async generateSkillDraft() {
        return {};
      },
      async predictReusableScenarios(input) {
        receivedWorkflowId = input.selectedWorkflow.workflowId;
        return {
          scenarios: [
            {
              scenarioId: "scenario-two",
              nextUseHypothesis: "Review another claim.",
            },
          ],
        };
      },
      getLastInvocationMetrics() {
        return {
          callCount: 1,
          inputTokens: 10,
          outputTokens: 20,
          totalTokens: 30,
          totalReactionTimeMs: 456,
        };
      },
      getLastInvocationWarnings() {
        return ["mock-warning"];
      },
    };

    const result = await runReplayLlmCall({
      call: "scenario-prediction",
      skillPath: fixture.skillPath,
      summaryPath: fixture.summaryPath,
      outDir,
      llmClient,
      now: new Date("2026-03-30T12:00:00.000Z"),
    });

    expect(receivedWorkflowId).toBe(fixture.workflow.workflowId);
    expect(result.selectedWorkflow?.workflowId).toBe(
      fixture.workflow.workflowId,
    );
    expect(result.scenario).toBeNull();
    expect(result.metrics?.callCount).toBe(1);
    expect(result.warnings).toEqual(["mock-warning"]);

    const savedResult = JSON.parse(
      await readFile(result.resultPath, "utf8"),
    ) as { scenarios?: Array<{ scenarioId?: string }> };
    expect(savedResult.scenarios?.[0]?.scenarioId).toBe("scenario-two");

    const report = JSON.parse(await readFile(result.reportPath, "utf8")) as {
      context?: { selectedWorkflowId?: string | null };
      output?: { traceDir?: string };
    };
    expect(report.context?.selectedWorkflowId).toBe(
      fixture.workflow.workflowId,
    );
    expect(report.output?.traceDir).toBe(path.join(outDir, "llm-trace"));
  });

  it("replays scenario-prediction with only skill.json by synthesizing minimal context", async () => {
    const fixture = await createReplayFixture();
    const outDir = path.join(
      fixture.root,
      "out-scenario-prediction-skill-only",
    );
    let receivedWorkflowId: string | null = null;

    const llmClient: OpenClawLlmClient = {
      async generateSkillDraft() {
        return {};
      },
      async predictReusableScenarios(input) {
        receivedWorkflowId = input.selectedWorkflow.workflowId;
        return {
          scenarios: [
            {
              scenarioId: "scenario-skill-only",
              nextUseHypothesis:
                "Reuse the same skill for another target object.",
            },
          ],
        };
      },
      getLastInvocationMetrics() {
        return {
          callCount: 1,
          inputTokens: 7,
          outputTokens: 11,
          totalTokens: 18,
          totalReactionTimeMs: 210,
        };
      },
      getLastInvocationWarnings() {
        return [];
      },
    };

    const result = await runReplayLlmCall({
      call: "scenario-prediction",
      skillPath: fixture.skillPath,
      outDir,
      llmClient,
      now: new Date("2026-03-30T12:15:00.000Z"),
    });

    expect(receivedWorkflowId).toBe("workflow-replay");
    expect(result.selectedWorkflow?.workflowId).toBe("workflow-replay");
    expect(result.metrics?.callCount).toBe(1);

    const savedResult = JSON.parse(
      await readFile(result.resultPath, "utf8"),
    ) as { scenarios?: Array<{ scenarioId?: string; title?: string }> };
    expect(savedResult.scenarios?.[0]?.scenarioId).toBe("scenario-skill-only");
    expect(savedResult.scenarios?.[0]?.title).toBeUndefined();
  });

  it("replays scenario-generalization using the first predicted scenario by default", async () => {
    const fixture = await createReplayFixture();
    const outDir = path.join(fixture.root, "out-scenario-generalization");
    let receivedScenarioId: string | null = null;

    const llmClient: OpenClawLlmClient = {
      async generateSkillDraft() {
        return {};
      },
      async generalizeSkillForScenario(input) {
        receivedScenarioId = input.scenario.scenarioId;
        return {
          skillName: "Generalized claim status check",
          goal: "Check the latest claim status for the selected claim.",
        };
      },
      getLastInvocationMetrics() {
        return {
          callCount: 1,
          inputTokens: 12,
          outputTokens: 18,
          totalTokens: 30,
          totalReactionTimeMs: 789,
        };
      },
      getLastInvocationWarnings() {
        return [];
      },
    };

    const result = await runReplayLlmCall({
      call: "scenario-generalization",
      skillPath: fixture.skillPath,
      summaryPath: fixture.summaryPath,
      outDir,
      llmClient,
      now: new Date("2026-03-30T12:30:00.000Z"),
    });

    expect(receivedScenarioId).toBe(fixture.scenario.scenarioId);
    expect(result.selectedWorkflow?.workflowId).toBe(
      fixture.workflow.workflowId,
    );
    expect(result.scenario?.scenarioId).toBe(fixture.scenario.scenarioId);

    const report = JSON.parse(await readFile(result.reportPath, "utf8")) as {
      context?: { scenarioId?: string | null };
    };
    expect(report.context?.scenarioId).toBe(fixture.scenario.scenarioId);
  });

  it("accepts a scenario-prediction-style scenarios wrapper file for scenario-generalization", async () => {
    const fixture = await createReplayFixture();
    const outDir = path.join(
      fixture.root,
      "out-scenario-generalization-wrapper",
    );
    const wrappedScenariosPath = path.join(
      fixture.root,
      "scenario-prediction-result.json",
    );
    await writeFile(
      wrappedScenariosPath,
      JSON.stringify(
        {
          scenarios: [
            {
              scenarioId: fixture.scenario.scenarioId,
              nextUseHypothesis: fixture.scenario.nextUseHypothesis,
            },
          ],
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    let receivedScenarioId: string | null = null;

    const llmClient: OpenClawLlmClient = {
      async generateSkillDraft() {
        return {};
      },
      async generalizeSkillForScenario(input) {
        receivedScenarioId = input.scenario.scenarioId;
        return { skillName: "Wrapped scenario replay" };
      },
      getLastInvocationMetrics() {
        return {
          callCount: 1,
          inputTokens: 8,
          outputTokens: 9,
          totalTokens: 17,
          totalReactionTimeMs: 123,
        };
      },
      getLastInvocationWarnings() {
        return [];
      },
    };

    const result = await runReplayLlmCall({
      call: "scenario-generalization",
      skillPath: fixture.skillPath,
      summaryPath: fixture.summaryPath,
      predictedScenariosPath: wrappedScenariosPath,
      outDir,
      llmClient,
    });

    expect(receivedScenarioId).toBe(fixture.scenario.scenarioId);
    expect(result.scenario?.scenarioId).toBe(fixture.scenario.scenarioId);
    expect(result.scenario?.nextUseHypothesis).toBe(
      fixture.scenario.nextUseHypothesis,
    );
  });

  it("replays scenario-generalization with skill.json plus scenario file only", async () => {
    const fixture = await createReplayFixture();
    const outDir = path.join(
      fixture.root,
      "out-scenario-generalization-skill-scenario-only",
    );
    const scenarioPath = path.join(fixture.root, "scenario.json");
    await writeFile(
      scenarioPath,
      JSON.stringify(fixture.scenario, null, 2) + "\n",
      "utf8",
    );
    let receivedScenarioId: string | null = null;
    let receivedWorkflowId: string | null = null;

    const llmClient: OpenClawLlmClient = {
      async generateSkillDraft() {
        return {};
      },
      async generalizeSkillForScenario(input) {
        receivedScenarioId = input.scenario.scenarioId;
        receivedWorkflowId = input.selectedWorkflow.workflowId;
        return { skillName: "Scenario only replay" };
      },
      getLastInvocationMetrics() {
        return {
          callCount: 1,
          inputTokens: 9,
          outputTokens: 10,
          totalTokens: 19,
          totalReactionTimeMs: 150,
        };
      },
      getLastInvocationWarnings() {
        return [];
      },
    };

    const result = await runReplayLlmCall({
      call: "scenario-generalization",
      skillPath: fixture.skillPath,
      scenarioPath,
      outDir,
      llmClient,
    });

    expect(receivedScenarioId).toBe(fixture.scenario.scenarioId);
    expect(receivedWorkflowId).toBe("workflow-replay");
    expect(result.selectedWorkflow?.workflowId).toBe("workflow-replay");
    expect(result.scenario?.scenarioId).toBe(fixture.scenario.scenarioId);
  });

  it("rejects legacy scenario alias files for scenario-generalization replay", async () => {
    const fixture = await createReplayFixture();
    const outDir = path.join(
      fixture.root,
      "out-scenario-generalization-legacy-alias",
    );
    const scenarioPath = path.join(fixture.root, "legacy-scenario.json");
    await writeFile(
      scenarioPath,
      JSON.stringify(
        {
          id: fixture.scenario.scenarioId,
          title: fixture.scenario.nextUseHypothesis,
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    const llmClient: OpenClawLlmClient = {
      async generateSkillDraft() {
        return {};
      },
      async generalizeSkillForScenario() {
        return { skillName: "legacy replay should not run" };
      },
    };

    await expect(
      runReplayLlmCall({
        call: "scenario-generalization",
        skillPath: fixture.skillPath,
        scenarioPath,
        outDir,
        llmClient,
      }),
    ).rejects.toThrow("Scenario file must be a scenario object");
  });
});
