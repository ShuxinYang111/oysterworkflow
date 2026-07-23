import { access, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  discoverOpenClawWorkflows,
  extractOpenClawSkillLlm,
  normalizeGeneralizedSkillDraft,
  normalizePlannerOptimizationDraft,
  normalizePredictedReusableScenarios,
  type OpenClawLlmClient,
} from "../src/skill/extract-openclaw-llm.js";
import type { Episode, NormalizedEvent } from "../src/types/contracts.js";

/**
 * EN: Builds normalized-event fixtures to reduce repeated boilerplate.
 * @param input core event fields (id/time/type/context).
 * @returns contract-compliant NormalizedEvent.
 */
function buildEvent(input: {
  id: string;
  tsMs: number;
  eventType: NormalizedEvent["eventType"];
  appName?: string | null;
  windowName?: string | null;
  textContent?: string | null;
  x?: number | null;
  y?: number | null;
}): NormalizedEvent {
  return {
    id: input.id,
    source: input.eventType === "ocr" ? "search-ocr" : "ui-events",
    tsIso: new Date(input.tsMs).toISOString(),
    tsMs: input.tsMs,
    appName: input.appName ?? "Google Chrome",
    windowName: input.windowName ?? "Inbox",
    eventType: input.eventType,
    textContent: input.textContent ?? null,
    x: input.x ?? null,
    y: input.y ?? null,
    keyCode: null,
    modifiers: null,
    browserUrl: null,
    frameId: null,
    rawRef: {
      file: "/tmp/events.ndjson",
      line: 1,
    },
  };
}

describe("extractOpenClawSkillLlm", () => {
  // EN: Valid LLM steps should produce a structured skill and omit evidenceEventIds from final steps.
  it("generates skill/summary using mocked LLM draft", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-skill-llm-"),
    );
    const runDir = path.join(root, "runs", "run-llm-001");
    await mkdir(runDir, { recursive: true });

    const base = Date.parse("2026-03-03T19:00:00.000Z");
    const episode: Episode = {
      id: "run-llm-001-ep-0001",
      runId: "run-llm-001",
      startTs: new Date(base).toISOString(),
      endTs: new Date(base + 6_000).toISOString(),
      durationMs: 6_000,
      eventsCount: 4,
      events: [
        buildEvent({
          id: "e1",
          tsMs: base,
          eventType: "app_switch",
          appName: "Google Chrome",
        }),
        buildEvent({
          id: "e2",
          tsMs: base + 2_000,
          eventType: "click",
          x: 120,
          y: 220,
        }),
        buildEvent({
          id: "e3",
          tsMs: base + 4_000,
          eventType: "text",
          textContent: "book flight ticket",
        }),
        buildEvent({
          id: "e4",
          tsMs: base + 6_000,
          eventType: "ocr",
          textContent: "Trip search result",
        }),
      ],
    };

    await writeFile(
      path.join(runDir, "manifest.json"),
      `${JSON.stringify({ runId: "run-llm-001" })}\n`,
      "utf8",
    );
    await writeFile(
      path.join(runDir, "episodes.json"),
      `${JSON.stringify([episode], null, 2)}\n`,
      "utf8",
    );

    let candidateSkillInput: unknown = null;
    let familyMatchInput: unknown = null;
    const progressStages: string[] = [];
    const llmClient: OpenClawLlmClient = {
      async generateSkillDraft() {
        return {
          skillName: "Book Flight Workflow",
          goal: "Complete and .",
          whenToUse: ["NeedWorkflow when"],
          prerequisites: ["The booking site is already signed in"],
          steps: [
            {
              instruction: "Click the search entry in the web page.",
              intent: "Enter the flight-search workflow.",
              operationApp: "Google Chrome",
              hints: ["Prefer clicking the obvious search button"],
              referenceRefs: ["flight-search-entry"],
            },
            {
              instruction: "Enter the travel keywords and confirm.",
              intent: " item.",
              operationApp: "Google Chrome",
            },
          ],
          successCriteria: ["Available flight results appear"],
          fallback: ["If the page does not respond, refresh and retry"],
          references: [
            {
              id: "flight-search-entry",
              name: "Flight search entry",
              value: "https://example.com/flights",
              notes: "Open this page before entering the trip.",
            },
          ],
        };
      },
      async generateCandidateWorkflow(input) {
        candidateSkillInput = input.skill;
        return {
          name: "Book Flight Workflow",
          goal: "Complete and .",
          entryNodeId: "open-search",
          nodes: [
            {
              id: "open-search",
              type: "action",
              title: "Open flight search",
              objective: "Enter the flight-search workflow.",
              act: ["Click the search entry in the web page."],
              operationApp: "Google Chrome",
              hints: [],
              referenceRefs: ["flight-search-entry"],
            },
            {
              id: "complete-search",
              type: "terminal",
              title: "Flight results available",
              outcome: "completed",
              summary: "Available flight results appear.",
              hints: [],
            },
          ],
          transitions: [
            {
              id: "open-search-to-complete",
              from: "open-search",
              to: "complete-search",
              type: "default",
            },
          ],
        };
      },
      async matchWorkflowFamily(input) {
        familyMatchInput = input;
        return {
          decision: "match",
          matchedWorkflowId: "workflow.flight-booking",
        };
      },
    };

    const outDir = path.join(runDir, "openclaw-llm-test");
    const result = await extractOpenClawSkillLlm({
      runDir,
      outDir,
      now: new Date("2026-03-03T19:10:00.000Z"),
      llmClient,
      onProgress: ({ stage }) => {
        progressStages.push(stage);
      },
      workflowFamilyCards: [
        {
          workflowId: "workflow.flight-booking",
          name: "Flight booking",
          goal: "Search and select a flight",
          whenToUse: ["A user needs to book a flight"],
          outline: ["Open search", "Enter trip", "Review results"],
          terminalOutcomes: ["completed"],
          apps: ["Google Chrome"],
        },
      ],
    });

    expect(result.skill.schemaVersion).toBe("openclaw-skill-v1");
    expect(progressStages).toEqual([
      "building-skill",
      "building-workflow-graph",
    ]);
    expect(result.skill.promptSet).toBe("specific-v34");
    expect(result.skill.skillName).toBe("Book Flight Workflow");
    expect(result.skill.executionMode).toBe("autonomous");
    expect(result.skill.references).toEqual([
      {
        id: "flight-search-entry",
        name: "Flight search entry",
        value: "https://example.com/flights",
        notes: "Open this page before entering the trip.",
      },
    ]);
    expect(result.skill.steps[0]?.referenceRefs).toEqual([
      "flight-search-entry",
    ]);
    expect(result.skill.steps.length).toBeGreaterThanOrEqual(2);
    expect(
      result.skill.steps.every((step) => !("evidenceEventIds" in step)),
    ).toBe(true);
    expect(
      result.skill.steps.every(
        (step) =>
          step.operationApp.length > 0 &&
          !("eventType" in step) &&
          !("appName" in step) &&
          !("windowName" in step),
      ),
    ).toBe(true);

    await Promise.all([
      access(result.paths.skillPath),
      access(result.paths.summaryPath),
      access(result.paths.workflowGraphPath),
      access(result.paths.workflowMarkdownPath),
      access(result.paths.workflowRevisionsDir),
      access(result.paths.workflowCandidatePath ?? ""),
      access(result.paths.workflowFamilyMatchPath ?? ""),
    ]);
    expect(candidateSkillInput).toBe(result.skill);
    expect(result.workflowCandidate?.references).toEqual([
      {
        id: `reference:${result.skill.skillId}:flight-search-entry`,
        name: "Flight search entry",
        value: "https://example.com/flights",
        notes: "Open this page before entering the trip.",
      },
    ]);
    expect(result.workflowCandidate?.nodes[0]?.referenceRefs).toEqual([
      `reference:${result.skill.skillId}:flight-search-entry`,
    ]);
    expect(result.workflowCandidate?.nodes[1]?.referenceRefs).toBeUndefined();
    expect(familyMatchInput).toEqual({
      candidate: result.workflowCandidate,
      families: expect.arrayContaining([
        expect.objectContaining({
          workflowId: "workflow.flight-booking",
        }),
      ]),
    });
    expect(result.workflowFamilyMatch).toEqual(
      expect.objectContaining({
        decision: "match",
        matchedWorkflowId: "workflow.flight-booking",
      }),
    );
    expect(JSON.stringify(result.workflowCandidate)).not.toMatch(
      /confidence|reason|sourceRefs|stepRefs|provenance/i,
    );
    expect(result.summary.output.workflowCandidatePath).toBe(
      result.paths.workflowCandidatePath,
    );
    expect(result.summary.output.workflowFamilyMatchPath).toBe(
      result.paths.workflowFamilyMatchPath,
    );
    expect(result.summary.output.workflowRevisionsDir).toBe(
      result.paths.workflowRevisionsDir,
    );
    const savedSkill = JSON.parse(
      await readFile(result.paths.skillPath, "utf8"),
    ) as { promptSet?: string | null; steps?: Array<Record<string, unknown>> };
    expect(savedSkill.promptSet).toBe("specific-v34");
    expect(
      savedSkill.steps?.every((step) => !("evidenceEventIds" in step)),
    ).toBe(true);
    expect(
      savedSkill.steps?.every(
        (step) =>
          typeof step.operationApp === "string" &&
          !("eventType" in step) &&
          !("appName" in step) &&
          !("windowName" in step),
      ),
    ).toBe(true);
    const savedGraph = JSON.parse(
      await readFile(result.paths.workflowGraphPath, "utf8"),
    ) as {
      schemaVersion?: string;
      nodes?: Array<{ type?: string }>;
      transitions?: Array<{ type?: string }>;
    };
    expect(savedGraph.schemaVersion).toBe("oyster-workflow-graph-v2");
    expect(savedGraph.nodes?.at(-1)?.type).toBe("terminal");
    expect(
      savedGraph.transitions?.every((transition) =>
        ["default", "conditional", "retry", "resume"].includes(
          transition.type ?? "",
        ),
      ),
    ).toBe(true);
  });

  it("rejects legacy autonomousSteps-only drafts", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-skill-llm-legacy-steps-"),
    );
    const runDir = path.join(root, "runs", "run-llm-legacy-steps");
    await mkdir(runDir, { recursive: true });

    const base = Date.parse("2026-03-03T19:05:00.000Z");
    const episode: Episode = {
      id: "run-llm-legacy-steps-ep-0001",
      runId: "run-llm-legacy-steps",
      startTs: new Date(base).toISOString(),
      endTs: new Date(base + 2_000).toISOString(),
      durationMs: 2_000,
      eventsCount: 2,
      events: [
        buildEvent({
          id: "ls1",
          tsMs: base,
          eventType: "click",
          appName: "Google Chrome",
        }),
        buildEvent({
          id: "ls2",
          tsMs: base + 2_000,
          eventType: "ocr",
          textContent: "Legacy draft should fail",
        }),
      ],
    };

    await writeFile(
      path.join(runDir, "manifest.json"),
      `${JSON.stringify({ runId: "run-llm-legacy-steps" })}\n`,
      "utf8",
    );
    await writeFile(
      path.join(runDir, "episodes.json"),
      `${JSON.stringify([episode], null, 2)}\n`,
      "utf8",
    );

    const llmClient: OpenClawLlmClient = {
      async generateSkillDraft() {
        return {
          skillName: "Legacy Skill",
          goal: "Reject legacy-only step payloads.",
          whenToUse: ["when verifying strict canonical step parsing"],
          prerequisites: ["The page is open."],
          autonomousSteps: [
            {
              instruction: "This legacy field should no longer be accepted.",
              intent: "Verify strict parsing.",
              operationApp: "Google Chrome",
            },
          ],
          successCriteria: ["The task is complete."],
          fallback: ["Retry once after refreshing the page."],
        };
      },
    };

    await expect(
      extractOpenClawSkillLlm({
        runDir,
        outDir: path.join(runDir, "openclaw-llm-legacy"),
        now: new Date("2026-03-03T19:10:00.000Z"),
        llmClient,
      }),
    ).rejects.toThrow("LLM output contains no usable steps");
  });

  it("ignores legacy top-level aliases for required fields", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-skill-llm-legacy-fields-"),
    );
    const runDir = path.join(root, "runs", "run-llm-legacy-fields");
    await mkdir(runDir, { recursive: true });

    const base = Date.parse("2026-03-03T19:06:00.000Z");
    const episode: Episode = {
      id: "run-llm-legacy-fields-ep-0001",
      runId: "run-llm-legacy-fields",
      startTs: new Date(base).toISOString(),
      endTs: new Date(base + 2_000).toISOString(),
      durationMs: 2_000,
      eventsCount: 2,
      events: [
        buildEvent({
          id: "lf1",
          tsMs: base,
          eventType: "click",
          appName: "Google Chrome",
          windowName: "Legacy Fields",
        }),
        buildEvent({
          id: "lf2",
          tsMs: base + 2_000,
          eventType: "ocr",
          textContent: "Legacy fields should be ignored",
        }),
      ],
    };

    await writeFile(
      path.join(runDir, "manifest.json"),
      `${JSON.stringify({ runId: "run-llm-legacy-fields" })}\n`,
      "utf8",
    );
    await writeFile(
      path.join(runDir, "episodes.json"),
      `${JSON.stringify([episode], null, 2)}\n`,
      "utf8",
    );

    const llmClient: OpenClawLlmClient = {
      async generateSkillDraft() {
        return {
          name: "Legacy draft name",
          objective: "Legacy draft goal",
          usage: ["Legacy when-to-use"],
          preconditions: ["Legacy prerequisite"],
          steps: [
            {
              instruction: "Keep the canonical step payload valid.",
              intent: "Isolate top-level alias handling.",
              operationApp: "Google Chrome",
            },
          ],
          success: ["Legacy success criteria"],
          recovery: ["Legacy fallback path"],
        };
      },
    };

    const result = await extractOpenClawSkillLlm({
      runDir,
      outDir: path.join(runDir, "openclaw-llm-legacy-fields"),
      now: new Date("2026-03-03T19:10:00.000Z"),
      llmClient,
    });

    expect(result.skill.goal).toBe(
      "LLM did not generate this field successfully",
    );
    expect(result.skill.whenToUse).toEqual([
      "LLM did not generate this field successfully",
    ]);
    expect(result.skill.prerequisites).toEqual([
      "LLM did not generate this field successfully",
    ]);
    expect(result.skill.successCriteria).toEqual([
      "LLM did not generate this field successfully",
    ]);
    expect(result.skill.fallback).toEqual([]);
    expect(result.summary.warnings).toEqual(
      expect.arrayContaining([
        "LLM output missing goal; used placeholder.",
        "LLM output missing whenToUse; used placeholder.",
        "LLM output missing prerequisites; used placeholder.",
        "LLM output missing successCriteria; used placeholder.",
      ]),
    );
    expect(result.summary.warnings).not.toContain(
      "LLM output missing fallback; used placeholder.",
    );
    expect(result.skill.skillName).not.toBe("Legacy draft name");
  });

  it("rejects legacy step object aliases", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-skill-llm-legacy-step-keys-"),
    );
    const runDir = path.join(root, "runs", "run-llm-legacy-step-keys");
    await mkdir(runDir, { recursive: true });

    const base = Date.parse("2026-03-03T19:07:00.000Z");
    const episode: Episode = {
      id: "run-llm-legacy-step-keys-ep-0001",
      runId: "run-llm-legacy-step-keys",
      startTs: new Date(base).toISOString(),
      endTs: new Date(base + 2_000).toISOString(),
      durationMs: 2_000,
      eventsCount: 2,
      events: [
        buildEvent({
          id: "lk1",
          tsMs: base,
          eventType: "click",
          appName: "Google Chrome",
        }),
        buildEvent({
          id: "lk2",
          tsMs: base + 2_000,
          eventType: "ocr",
          textContent: "Legacy step keys should fail",
        }),
      ],
    };

    await writeFile(
      path.join(runDir, "manifest.json"),
      `${JSON.stringify({ runId: "run-llm-legacy-step-keys" })}\n`,
      "utf8",
    );
    await writeFile(
      path.join(runDir, "episodes.json"),
      `${JSON.stringify([episode], null, 2)}\n`,
      "utf8",
    );

    const llmClient: OpenClawLlmClient = {
      async generateSkillDraft() {
        return {
          skillName: "Legacy Step Skill",
          goal: "Reject legacy step object aliases.",
          whenToUse: ["when verifying strict step field parsing"],
          prerequisites: ["The page is open."],
          steps: [
            {
              action: "This legacy action key should no longer work.",
              purpose: "Legacy step intent",
              appName: "Google Chrome",
              notes: ["Legacy hints"],
            },
          ],
          successCriteria: ["The task is complete."],
          fallback: ["Retry once after refreshing the page."],
        };
      },
    };

    await expect(
      extractOpenClawSkillLlm({
        runDir,
        outDir: path.join(runDir, "openclaw-llm-legacy-step-keys"),
        now: new Date("2026-03-03T19:10:00.000Z"),
        llmClient,
      }),
    ).rejects.toThrow("LLM output contains no usable steps");
  });

  it("adds planner-friendly soft constraints via a dedicated rewrite call", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-skill-llm-planner-opt-"),
    );
    const runDir = path.join(root, "runs", "run-llm-planner-opt");
    await mkdir(runDir, { recursive: true });

    const base = Date.parse("2026-03-03T19:20:00.000Z");
    const episode: Episode = {
      id: "run-llm-planner-opt-ep-0001",
      runId: "run-llm-planner-opt",
      startTs: new Date(base).toISOString(),
      endTs: new Date(base + 8_000).toISOString(),
      durationMs: 8_000,
      eventsCount: 4,
      events: [
        buildEvent({
          id: "po1",
          tsMs: base,
          eventType: "window_focus",
          appName: "Google Chrome",
          windowName: "Pirate Ship Claim Center",
        }),
        buildEvent({
          id: "po2",
          tsMs: base + 2_000,
          eventType: "text",
          appName: "Google Chrome",
          windowName: "Pirate Ship Claim Center",
          textContent: "claim 12345",
        }),
        buildEvent({
          id: "po3",
          tsMs: base + 5_000,
          eventType: "ocr",
          appName: "Google Chrome",
          windowName: "Pirate Ship Claim Center",
          textContent: "Claim status and payout amount",
        }),
        buildEvent({
          id: "po4",
          tsMs: base + 8_000,
          eventType: "click",
          appName: "Google Chrome",
          windowName: "Pirate Ship Claim Center",
          x: 120,
          y: 220,
        }),
      ],
    };

    await writeFile(
      path.join(runDir, "manifest.json"),
      `${JSON.stringify({ runId: "run-llm-planner-opt" })}\n`,
      "utf8",
    );
    await writeFile(
      path.join(runDir, "episodes.json"),
      `${JSON.stringify([episode], null, 2)}\n`,
      "utf8",
    );

    let plannerInput: Record<string, unknown> | null = null;
    const llmClient: OpenClawLlmClient = {
      async generateSkillDraft() {
        return {
          skillName: "Claim Workflow Skill",
          goal: "Confirm the claim status and payout amount.",
          whenToUse: ["when you need to view claim information"],
          prerequisites: ["already enteredClaimPage"],
          steps: [
            {
              instruction: "Open the claim details page.",
              intent: "Enter the claim context.",
              operationApp: "Google Chrome",
            },
            {
              instruction: "Read the status and payout amount.",
              intent: "Complete the verification.",
              operationApp: "Google Chrome",
            },
          ],
          successCriteria: ["See the status and payout amount"],
          fallback: ["Page after Retry"],
        };
      },
      async optimizeSkillForPlanner(input) {
        plannerInput = input as unknown as Record<string, unknown>;
        return {
          skillName: "Verify Pirate Ship claim status and payout amount",
          shortDescription:
            "Use this verified Pirate Ship claim flow to check one claim status and payout amount.",
          description: "Suitable for verifying a single-record claim result.",
          whenToUse: [
            "Use this when the goal is to verify Pirate Ship single-record claim status and payout amount.",
          ],
          tags: ["claim-check"],
        };
      },
    };

    const result = await extractOpenClawSkillLlm({
      runDir,
      outDir: path.join(runDir, "openclaw-llm"),
      now: new Date("2026-03-03T19:25:00.000Z"),
      llmClient,
    });

    expect(result.skill.skillName).toBe(
      "Verify Pirate Ship claim status and payout amount",
    );
    expect(result.skill.shortDescription).toBe(
      "Use this verified Pirate Ship claim flow to check one claim status and payout amount.",
    );
    expect(result.skill.description).toContain("skill learner");
    expect(result.skill.description).toContain("multi-step workflow");
    expect(
      result.skill.whenToUse.some((item) =>
        item.includes("task goal closely matches the skill description"),
      ),
    ).toBe(true);
    expect(result.skill.goal).toBe(
      "Confirm the claim status and payout amount.",
    );
    expect(result.skill.prerequisites).toEqual([
      "Have the account, permissions, or key identifiers required to access the target system.",
      "Allow the AI to read the original context materials preserved in references.",
    ]);
    expect(result.skill.successCriteria).toEqual([
      "See the status and payout amount",
    ]);
    expect(result.skill.fallback).toContain("Page after Retry");
    expect(result.skill.tags).toEqual([]);
    expect(result.skill.whenNotToUse).toEqual([]);
    expect(plannerInput).toEqual({
      skill: expect.objectContaining({
        skillName: "Claim Workflow Skill",
      }),
    });
  });

  it("ignores legacy workflow-discovery aliases and falls back to one workflow", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-workflow-legacy-alias-"),
    );
    const runDir = path.join(root, "runs", "run-workflow-legacy-alias");
    await mkdir(runDir, { recursive: true });

    const base = Date.parse("2026-03-04T10:00:00.000Z");
    const episode: Episode = {
      id: "run-workflow-legacy-alias-ep-0001",
      runId: "run-workflow-legacy-alias",
      startTs: new Date(base).toISOString(),
      endTs: new Date(base + 4_000).toISOString(),
      durationMs: 4_000,
      eventsCount: 2,
      events: [
        buildEvent({
          id: "wf1",
          tsMs: base,
          eventType: "click",
          appName: "Google Chrome",
          textContent: "open task",
        }),
        buildEvent({
          id: "wf2",
          tsMs: base + 4_000,
          eventType: "ocr",
          appName: "Google Chrome",
          textContent: "task detail",
        }),
      ],
    };

    await writeFile(
      path.join(runDir, "manifest.json"),
      `${JSON.stringify({ runId: "run-workflow-legacy-alias" })}\n`,
      "utf8",
    );
    await writeFile(
      path.join(runDir, "episodes.json"),
      `${JSON.stringify([episode], null, 2)}\n`,
      "utf8",
    );

    const result = await discoverOpenClawWorkflows({
      runDir,
      now: new Date("2026-03-04T10:10:00.000Z"),
      llmClient: {
        async generateSkillDraft() {
          throw new Error(
            "generateSkillDraft should not be called in this test",
          );
        },
        async discoverWorkflows() {
          return {
            workflows: [
              {
                title: "Legacy workflow title",
                objective: "Legacy workflow goal",
                summary: "Legacy workflow description",
                start_event_id: "wf1",
                end_event_id: "wf2",
                why_this_workflow: "Legacy alias should be ignored",
              },
            ],
          };
        },
      },
    });

    expect(result.workflowCandidates).toHaveLength(1);
    expect(result.workflowCandidates[0]?.workflowId).toBe("workflow-1");
    expect(result.workflowCandidates[0]?.name).not.toBe(
      "Legacy workflow title",
    );
    expect(
      result.artifact.warnings.some((warning) =>
        warning.includes("no usable candidates"),
      ),
    ).toBe(true);
  });

  it("ignores legacy planner optimization aliases", () => {
    expect(
      normalizePlannerOptimizationDraft({
        name: "Legacy planner title",
        short_description: "Legacy short description",
        summary: "Legacy planner description",
        usage: ["Legacy usage"],
      }),
    ).toEqual({});

    expect(
      normalizePlannerOptimizationDraft({
        skillName: "Canonical planner title",
        shortDescription: "Canonical short description",
        description: "Canonical planner description",
        whenToUse: ["Canonical usage"],
      }),
    ).toEqual({
      skillName: "Canonical planner title",
      shortDescription: "Canonical short description",
      description: "Canonical planner description",
      whenToUse: ["Canonical usage"],
    });
  });

  it("rejects legacy generalized skill aliases", () => {
    expect(() =>
      normalizeGeneralizedSkillDraft({
        rawDraft: {
          name: "Legacy generalized name",
          short_description: "Legacy generalized short description",
          summary: "Legacy generalized description",
          objective: "Legacy generalized goal",
          usage: ["Legacy when-to-use"],
          preconditions: ["Legacy prerequisite"],
          autonomousSteps: [
            {
              instruction: "Legacy generalized step",
              intent: "Legacy intent",
              operationApp: "Google Chrome",
            },
          ],
        },
        events: [
          buildEvent({
            id: "gg1",
            tsMs: Date.parse("2026-03-05T10:00:00.000Z"),
            eventType: "click",
            appName: "Google Chrome",
          }),
        ],
        warnings: [],
      }),
    ).toThrow("Generalized skill output contains no usable fields");
  });

  it("rejects legacy scenario prediction collection aliases", () => {
    expect(() =>
      normalizePredictedReusableScenarios(
        {
          predictedScenarios: [
            {
              scenarioId: "legacy-scenario",
              nextUseHypothesis: "Legacy wrapper key should no longer work.",
            },
          ],
        },
        [],
      ),
    ).toThrow("Scenario prediction output contains no scenario entries.");
  });

  it("rejects legacy scenario prediction field aliases", () => {
    expect(() =>
      normalizePredictedReusableScenarios(
        {
          scenarios: [
            {
              id: "legacy-scenario",
              title: "Legacy field aliases should no longer work.",
            },
          ],
        },
        [],
      ),
    ).toThrow("Scenario prediction must yield 1-3 scenarios, received 0.");
  });

  it("builds a shortDescription automatically when only a long description is available", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-skill-llm-short-description-"),
    );
    const runDir = path.join(root, "runs", "run-llm-short-description");
    await mkdir(runDir, { recursive: true });

    const base = Date.parse("2026-03-03T19:12:00.000Z");
    const episode: Episode = {
      id: "run-llm-short-description-ep-0001",
      runId: "run-llm-short-description",
      startTs: new Date(base).toISOString(),
      endTs: new Date(base + 5_000).toISOString(),
      durationMs: 5_000,
      eventsCount: 3,
      events: [
        buildEvent({
          id: "sd1",
          tsMs: base,
          eventType: "window_focus",
          appName: "Google Chrome",
          windowName: "Benefits Overview",
        }),
        buildEvent({
          id: "sd2",
          tsMs: base + 2_000,
          eventType: "text",
          appName: "Google Chrome",
          windowName: "Benefits Overview",
          textContent: "compare benefits and motivation",
        }),
        buildEvent({
          id: "sd3",
          tsMs: base + 5_000,
          eventType: "ocr",
          appName: "Google Chrome",
          windowName: "Benefits Overview",
          textContent: "career motivation and benefits",
        }),
      ],
    };

    await writeFile(
      path.join(runDir, "manifest.json"),
      `${JSON.stringify({ runId: "run-llm-short-description" })}\n`,
      "utf8",
    );
    await writeFile(
      path.join(runDir, "episodes.json"),
      `${JSON.stringify([episode], null, 2)}\n`,
      "utf8",
    );

    const longDescription =
      "Use this verified learner-generated flow to compare personal career motivation against company benefits for a course infographic submission, keeping the original evidence trail intact so the agent can reuse the user's proven research-and-writing path instead of improvising each decision from scratch. " +
      "This longer description should remain available in the full markdown body for human readers who need the complete context.";

    const llmClient: OpenClawLlmClient = {
      async generateSkillDraft() {
        return {
          skillName: "Career Benefits Comparison",
          goal: "Compare whether career motivation and company benefits match.",
          description: longDescription,
          whenToUse: [
            "when you need to reuse a career-motivation and benefits comparison workflow",
          ],
          prerequisites: ["Relevant web pages are accessible"],
          steps: [
            {
              instruction:
                "Open the reference materials and verify the benefits information.",
              intent: "Collect facts that can be used for comparison.",
              operationApp: "Google Chrome",
            },
          ],
          successCriteria: [
            "Get a comparison conclusion that can be submitted",
          ],
          fallback: [
            "If the materials are incomplete, go back to the source page and fill in the missing information",
          ],
        };
      },
    };

    const result = await extractOpenClawSkillLlm({
      runDir,
      outDir: path.join(runDir, "openclaw-llm"),
      now: new Date("2026-03-03T19:18:00.000Z"),
      llmClient,
    });

    expect(result.skill.description).toBe(longDescription);
    expect(result.skill.shortDescription).toBeDefined();
    const shortDescription = result.skill.shortDescription ?? "";
    expect(shortDescription.length).toBeLessThanOrEqual(280);
    expect(shortDescription).not.toBe(longDescription);
    expect(shortDescription).toContain(
      "Use this verified learner-generated flow",
    );
  });

  it("runs planner-optimization after generalization and keeps scenario-prediction/scenario-generalization on the pre-optimized skill", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-skill-llm-callc-order-"),
    );
    const runDir = path.join(root, "runs", "run-llm-callc-order");
    await mkdir(runDir, { recursive: true });

    const base = Date.parse("2026-03-03T19:30:00.000Z");
    const episode: Episode = {
      id: "run-llm-callc-order-ep-0001",
      runId: "run-llm-callc-order",
      startTs: new Date(base).toISOString(),
      endTs: new Date(base + 4_000).toISOString(),
      durationMs: 4_000,
      eventsCount: 2,
      events: [
        buildEvent({
          id: "co1",
          tsMs: base,
          eventType: "window_focus",
          appName: "Google Chrome",
          windowName: "Claim Center",
        }),
        buildEvent({
          id: "co2",
          tsMs: base + 4_000,
          eventType: "ocr",
          appName: "Google Chrome",
          windowName: "Claim Center",
          textContent: "claim status details",
        }),
      ],
    };

    await writeFile(
      path.join(runDir, "manifest.json"),
      `${JSON.stringify({ runId: "run-llm-callc-order" })}\n`,
      "utf8",
    );
    await writeFile(
      path.join(runDir, "episodes.json"),
      `${JSON.stringify([episode], null, 2)}\n`,
      "utf8",
    );

    const callOrder: string[] = [];
    const llmClient: OpenClawLlmClient = {
      async generateSkillDraft() {
        callOrder.push("generate");
        return {
          skillName: "Specific Claim Skill",
          goal: "ViewClaimStatus.",
          whenToUse: ["NeedViewClaimStatus"],
          prerequisites: ["already enteredClaimPage"],
          steps: [
            {
              instruction: "Open the claim details page.",
              intent: "Enter the claim context.",
              operationApp: "Google Chrome",
            },
          ],
          successCriteria: ["SeeClaimStatus"],
          fallback: ["Page after Retry"],
        };
      },
      async predictReusableScenarios(input) {
        callOrder.push(`predict:${input.skill.skillName}`);
        return {
          scenarios: [
            {
              scenarioId: "scenario-one",
              nextUseHypothesis: "Verify another claim status again.",
            },
          ],
        };
      },
      async generalizeSkillForScenario(input) {
        callOrder.push(`generalize:${input.skill.skillName}`);
        return {
          skillName: `Generalized ${input.skill.skillName}`,
          goal: input.scenario.nextUseHypothesis,
          whenToUse: [input.scenario.nextUseHypothesis],
        };
      },
      async optimizeSkillForPlanner(input) {
        callOrder.push(`optimize:${input.skill.skillName}`);
        return {
          skillName: "Optimized Claim Skill",
          description:
            "A claim-verification skill that is suitable for preferred reuse.",
          whenToUse: ["Use this when the goal is to verify claim status."],
        };
      },
    };

    const result = await extractOpenClawSkillLlm({
      runDir,
      outDir: path.join(runDir, "openclaw-llm"),
      now: new Date("2026-03-03T19:36:00.000Z"),
      llmClient,
    });

    expect(callOrder).toEqual([
      "generate",
      "predict:Specific Claim Skill",
      "generalize:Specific Claim Skill",
      "optimize:Specific Claim Skill",
    ]);
    expect(result.skill.skillName).toBe("ViewClaimStatus");
    expect(result.generalization?.scenarioCount).toBe(1);
    expect(result.generalization?.variants[0]?.nextUseHypothesis).toBe(
      "Verify another claim status again.",
    );
    expect(result.generalization?.warnings).toEqual([]);
  });

  it("skips optional planner-optimization when disabled explicitly", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-skill-llm-callc-disabled-"),
    );
    const runDir = path.join(root, "runs", "run-llm-callc-disabled");
    await mkdir(runDir, { recursive: true });

    const base = Date.parse("2026-03-03T19:40:00.000Z");
    const episode: Episode = {
      id: "run-llm-callc-disabled-ep-0001",
      runId: "run-llm-callc-disabled",
      startTs: new Date(base).toISOString(),
      endTs: new Date(base + 4_000).toISOString(),
      durationMs: 4_000,
      eventsCount: 2,
      events: [
        buildEvent({
          id: "cd1",
          tsMs: base,
          eventType: "window_focus",
          appName: "Google Chrome",
          windowName: "Claim Center",
        }),
        buildEvent({
          id: "cd2",
          tsMs: base + 4_000,
          eventType: "ocr",
          appName: "Google Chrome",
          windowName: "Claim Center",
          textContent: "claim status details",
        }),
      ],
    };

    await writeFile(
      path.join(runDir, "manifest.json"),
      `${JSON.stringify({ runId: "run-llm-callc-disabled" })}\n`,
      "utf8",
    );
    await writeFile(
      path.join(runDir, "episodes.json"),
      `${JSON.stringify([episode], null, 2)}\n`,
      "utf8",
    );

    let optimizeCalls = 0;
    const llmClient: OpenClawLlmClient = {
      async generateSkillDraft() {
        return {
          skillName: "Unoptimized Claim Skill",
          goal: "ViewClaimStatus.",
          whenToUse: ["NeedViewClaimStatus"],
          prerequisites: ["already enteredClaimPage"],
          steps: [
            {
              instruction: "Open the claim details page.",
              intent: "Enter the claim context.",
              operationApp: "Google Chrome",
            },
          ],
          successCriteria: ["SeeClaimStatus"],
          fallback: ["Page after Retry"],
        };
      },
      async predictReusableScenarios() {
        return {
          scenarios: [
            {
              scenarioId: "scenario-one",
              nextUseHypothesis: "Verify another claim status again.",
            },
          ],
        };
      },
      async generalizeSkillForScenario(input) {
        return {
          skillName: `Generalized ${input.skill.skillName}`,
          goal: input.scenario.nextUseHypothesis,
          whenToUse: [input.scenario.nextUseHypothesis],
        };
      },
      async optimizeSkillForPlanner() {
        optimizeCalls += 1;
        return {
          skillName: "Optimization skill that should not run",
        };
      },
    };

    const result = await extractOpenClawSkillLlm({
      runDir,
      outDir: path.join(runDir, "openclaw-llm"),
      now: new Date("2026-03-03T19:46:00.000Z"),
      llmClient,
      components: {
        plannerOptimization: {
          enabled: false,
        },
      },
    });

    expect(optimizeCalls).toBe(0);
    expect(result.skill.skillName).toBe("Unoptimized Claim Skill");
    expect(result.generalization?.scenarioCount).toBe(1);
    expect(
      result.summary.warnings.some((warning) =>
        warning.includes("Planner optimization"),
      ),
    ).toBe(false);
    expect(result.skill.fallback).not.toContain(
      "Warning: Planner optimization skipped: component disabled by configuration.",
    );
  });

  it("skips optional generalization when disabled explicitly", async () => {
    const root = await mkdtemp(
      path.join(
        os.tmpdir(),
        "oysterworkflow-skill-llm-generalization-disabled-",
      ),
    );
    const runDir = path.join(root, "runs", "run-llm-generalization-disabled");
    await mkdir(runDir, { recursive: true });

    const base = Date.parse("2026-03-03T19:50:00.000Z");
    const episode: Episode = {
      id: "run-llm-generalization-disabled-ep-0001",
      runId: "run-llm-generalization-disabled",
      startTs: new Date(base).toISOString(),
      endTs: new Date(base + 4_000).toISOString(),
      durationMs: 4_000,
      eventsCount: 2,
      events: [
        buildEvent({
          id: "gd1",
          tsMs: base,
          eventType: "window_focus",
          appName: "Google Chrome",
          windowName: "Claim Center",
        }),
        buildEvent({
          id: "gd2",
          tsMs: base + 4_000,
          eventType: "ocr",
          appName: "Google Chrome",
          windowName: "Claim Center",
          textContent: "claim status details",
        }),
      ],
    };

    await writeFile(
      path.join(runDir, "manifest.json"),
      `${JSON.stringify({ runId: "run-llm-generalization-disabled" })}\n`,
      "utf8",
    );
    await writeFile(
      path.join(runDir, "episodes.json"),
      `${JSON.stringify([episode], null, 2)}\n`,
      "utf8",
    );

    let scenarioPredictionCalls = 0;
    const llmClient: OpenClawLlmClient = {
      async generateSkillDraft() {
        return {
          skillName: "Ungeneralized Claim Skill",
          goal: "ViewClaimStatus.",
          whenToUse: ["NeedViewClaimStatus"],
          prerequisites: ["already enteredClaimPage"],
          steps: [
            {
              instruction: "Open the claim details page.",
              intent: "Enter the claim context.",
              operationApp: "Google Chrome",
            },
          ],
          successCriteria: ["SeeClaimStatus"],
          fallback: ["Page after Retry"],
        };
      },
      async predictReusableScenarios() {
        scenarioPredictionCalls += 1;
        return {
          scenarios: [
            {
              scenarioId: "scenario-one",
              nextUseHypothesis: "Verify another claim status again.",
            },
          ],
        };
      },
    };

    const result = await extractOpenClawSkillLlm({
      runDir,
      outDir: path.join(runDir, "openclaw-llm"),
      now: new Date("2026-03-03T19:56:00.000Z"),
      llmClient,
      components: {
        generalization: {
          enabled: false,
        },
      },
    });

    expect(scenarioPredictionCalls).toBe(0);
    expect(result.generalization).toBeUndefined();
    expect(
      result.summary.warnings.includes(
        "Generalization skipped: component disabled by configuration.",
      ),
    ).toBe(true);
    expect(result.skill.fallback).not.toContain(
      "Warning: Generalization skipped: component disabled by configuration.",
    );
  });
  // EN: When LLM goal is missing, fill placeholder and warn.
  it("fills missing goal with placeholder", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-skill-llm-missing-meta-"),
    );
    const runDir = path.join(root, "runs", "run-llm-missing-meta");
    await mkdir(runDir, { recursive: true });

    const base = Date.parse("2026-03-03T21:00:00.000Z");
    const episode: Episode = {
      id: "run-llm-missing-meta-ep-0001",
      runId: "run-llm-missing-meta",
      startTs: new Date(base).toISOString(),
      endTs: new Date(base + 4_000).toISOString(),
      durationMs: 4_000,
      eventsCount: 3,
      events: [
        buildEvent({
          id: "m1",
          tsMs: base,
          eventType: "app_switch",
          appName: "Google Chrome",
        }),
        buildEvent({
          id: "m2",
          tsMs: base + 1_000,
          eventType: "click",
          x: 200,
          y: 240,
        }),
        buildEvent({
          id: "m3",
          tsMs: base + 3_000,
          eventType: "text",
          textContent: "search keyword",
        }),
      ],
    };

    await writeFile(
      path.join(runDir, "manifest.json"),
      `${JSON.stringify({ runId: "run-llm-missing-meta" })}\n`,
      "utf8",
    );
    await writeFile(
      path.join(runDir, "episodes.json"),
      `${JSON.stringify([episode], null, 2)}\n`,
      "utf8",
    );

    const llmClient: OpenClawLlmClient = {
      async generateSkillDraft() {
        return {
          steps: [
            {
              instruction: "Click the entry button.",
              intent: "Enter the search workflow.",
              operationApp: "Google Chrome",
            },
            {
              instruction: "Enter the keyword and submit it.",
              intent: "Start the search.",
              operationApp: "Google Chrome",
            },
          ],
        };
      },
    };

    const outDir = path.join(runDir, "openclaw-llm-missing-meta");
    const result = await extractOpenClawSkillLlm({
      runDir,
      outDir,
      now: new Date("2026-03-03T21:05:00.000Z"),
      llmClient,
    });

    expect(result.skill.goal).toBe(
      "LLM did not generate this field successfully",
    );
    expect(result.summary.warnings).toContain(
      "LLM output missing goal; used placeholder.",
    );
  });
  // EN: Steps should materialize successfully even when the LLM omits evidenceEventIds.
  it("does not require evidence ids from LLM steps", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-skill-llm-fallback-"),
    );
    const runDir = path.join(root, "runs", "run-llm-fallback");
    await mkdir(runDir, { recursive: true });

    const base = Date.parse("2026-03-03T20:00:00.000Z");
    const episode: Episode = {
      id: "run-llm-fallback-ep-0001",
      runId: "run-llm-fallback",
      startTs: new Date(base).toISOString(),
      endTs: new Date(base + 3_000).toISOString(),
      durationMs: 3_000,
      eventsCount: 3,
      events: [
        buildEvent({
          id: "f1",
          tsMs: base,
          eventType: "app_switch",
          appName: "Google Docs",
        }),
        buildEvent({
          id: "f2",
          tsMs: base + 1_000,
          eventType: "click",
          x: 300,
          y: 400,
        }),
        buildEvent({
          id: "f3",
          tsMs: base + 3_000,
          eventType: "ocr",
          textContent: "Untitled document",
        }),
      ],
    };

    await writeFile(
      path.join(runDir, "manifest.json"),
      `${JSON.stringify({ runId: "run-llm-fallback" })}\n`,
      "utf8",
    );
    await writeFile(
      path.join(runDir, "episodes.json"),
      `${JSON.stringify([episode], null, 2)}\n`,
      "utf8",
    );

    const llmClient: OpenClawLlmClient = {
      async generateSkillDraft() {
        return {
          goal: "Document",
          whenToUse: ["NeedwriteDocument"],
          prerequisites: ["DocumentOpen"],
          steps: [
            {
              instruction: "Perform the key click",
              intent: "Advance the workflow",
              operationApp: "Google Docs",
            },
          ],
          successCriteria: ["Document"],
          fallback: ["Manually inspect the page"],
        };
      },
    };

    const result = await extractOpenClawSkillLlm({
      runDir,
      outDir: path.join(runDir, "openclaw-llm"),
      now: new Date("2026-03-03T20:05:00.000Z"),
      llmClient,
    });

    expect(result.skill.steps).toHaveLength(1);
    expect(result.skill.steps[0]?.operationApp).toBe("Google Docs");
    expect("evidenceEventIds" in result.skill.steps[0]!).toBe(false);
  });
  // EN: When LLM goal is noisy, extractor should use a placeholder goal without pruning steps heuristically.
  it("keeps placeholder goal without pruning terminal steps heuristically", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-skill-llm-goal-prune-"),
    );
    const runDir = path.join(root, "runs", "run-llm-goal-prune");
    await mkdir(runDir, { recursive: true });

    const base = Date.parse("2026-03-03T19:50:00.000Z");
    const episode: Episode = {
      id: "run-llm-goal-prune-ep-0001",
      runId: "run-llm-goal-prune",
      startTs: new Date(base).toISOString(),
      endTs: new Date(base + 12_000).toISOString(),
      durationMs: 12_000,
      eventsCount: 6,
      events: [
        buildEvent({
          id: "p1",
          tsMs: base,
          eventType: "ocr",
          appName: "Google Chrome",
          windowName: "Vibe Coding-bilibili_bilibili",
          textContent: "Vibe Coding tutorial intro",
        }),
        buildEvent({
          id: "p2",
          tsMs: base + 2_000,
          eventType: "window_focus",
          appName: "Google Chrome",
          windowName: "Untitled document - Google Docs",
        }),
        buildEvent({
          id: "p3",
          tsMs: base + 4_000,
          eventType: "text",
          appName: "Google Chrome",
          windowName: "Untitled document - Google Docs",
          textContent: "Vibe coding notes",
        }),
        buildEvent({
          id: "p4",
          tsMs: base + 6_000,
          eventType: "text",
          appName: "Google Chrome",
          windowName: "Untitled document - Google Docs",
          textContent: "landing page structure",
        }),
        buildEvent({
          id: "p5",
          tsMs: base + 8_000,
          eventType: "scroll",
          appName: "Terminal",
          windowName: ".screenpipe log",
          textContent: "stderr trace",
        }),
        buildEvent({
          id: "p6",
          tsMs: base + 12_000,
          eventType: "key",
          appName: "Terminal",
          windowName: ".screenpipe log",
          textContent: "backspace",
        }),
      ],
    };

    await writeFile(
      path.join(runDir, "manifest.json"),
      `${JSON.stringify({ runId: "run-llm-goal-prune" })}\n`,
      "utf8",
    );
    await writeFile(
      path.join(runDir, "episodes.json"),
      `${JSON.stringify([episode], null, 2)}\n`,
      "utf8",
    );

    const llmClient: OpenClawLlmClient = {
      async generateSkillDraft() {
        return {
          skillName: "Vibe Notes Workflow",
          goal: 'Google Chrome in complete and "Vibe Codn" +*#++> G@ bcalhost/mfrs.',
          whenToUse: ["NeedReproducestudyWorkflow"],
          prerequisites: ["The page is accessible"],
          steps: [
            {
              instruction: "Open the video page.",
              intent: "Enter the study context.",
              operationApp: "Google Chrome",
            },
            {
              instruction: "Record the key points in Google Docs.",
              intent: "Organize the notes.",
              operationApp: "Google Chrome",
            },
            {
              instruction:
                "Go back to the terminal, view the logs, and scroll.",
              intent: "Advance the current task workflow.",
              operationApp: "Terminal",
            },
          ],
          successCriteria: ["Notes complete"],
          fallback: [" after Retry"],
        };
      },
    };

    const result = await extractOpenClawSkillLlm({
      runDir,
      outDir: path.join(runDir, "openclaw-llm"),
      now: new Date("2026-03-03T20:00:00.000Z"),
      llmClient,
    });

    expect(result.skill.goal).toBe(
      "LLM did not generate this field successfully",
    );
    expect(
      result.summary.warnings.some((warning) =>
        warning.includes("LLM goal looked noisy"),
      ),
    ).toBe(true);
    expect(
      result.skill.steps.some((step) => step.operationApp === "Terminal"),
    ).toBe(true);
  });
  // EN: If a step omits operationApp, extractor should use an explicit missing marker instead of timeline inference.
  it("marks missing operationApp from LLM without timeline inference", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-skill-llm-context-backfill-"),
    );
    const runDir = path.join(root, "runs", "run-llm-context-backfill");
    await mkdir(runDir, { recursive: true });

    const base = Date.parse("2026-03-03T21:00:00.000Z");
    const episode: Episode = {
      id: "run-llm-context-backfill-ep-0001",
      runId: "run-llm-context-backfill",
      startTs: new Date(base).toISOString(),
      endTs: new Date(base + 4_000).toISOString(),
      durationMs: 4_000,
      eventsCount: 3,
      events: [
        buildEvent({
          id: "c1",
          tsMs: base,
          eventType: "text",
          appName: "",
          windowName: "",
          textContent: "v",
        }),
        buildEvent({
          id: "c2",
          tsMs: base + 2_000,
          eventType: "ocr",
          appName: "Google Chrome",
          windowName: "Untitled document - Google Docs",
          textContent: "Untitled document - Google Docs",
        }),
        buildEvent({
          id: "c3",
          tsMs: base + 4_000,
          eventType: "text",
          appName: "",
          windowName: "",
          textContent: "vibe",
        }),
      ],
    };

    await writeFile(
      path.join(runDir, "manifest.json"),
      `${JSON.stringify({ runId: "run-llm-context-backfill" })}\n`,
      "utf8",
    );
    await writeFile(
      path.join(runDir, "episodes.json"),
      `${JSON.stringify([episode], null, 2)}\n`,
      "utf8",
    );

    const llmClient: OpenClawLlmClient = {
      async generateSkillDraft() {
        return {
          goal: "writeDocument",
          whenToUse: ["Record content"],
          prerequisites: ["DocumentOpen"],
          steps: [
            {
              instruction: "Enterkey and .",
              intent: "Record notes.",
            },
          ],
          successCriteria: ["Document"],
          fallback: [" after Retry"],
        };
      },
    };

    const result = await extractOpenClawSkillLlm({
      runDir,
      outDir: path.join(runDir, "openclaw-llm"),
      now: new Date("2026-03-03T21:05:00.000Z"),
      llmClient,
    });

    expect(result.skill.steps).toHaveLength(1);
    expect(result.skill.steps[0]?.operationApp).toBe(
      "MissingOperationAppFromLLM",
    );
  });
  // EN: When one LLM step references multiple apps, it should be split into single-app steps.
  it("splits one multi-app step into multiple single-app steps", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-skill-llm-multi-app-"),
    );
    const runDir = path.join(root, "runs", "run-llm-multi-app");
    await mkdir(runDir, { recursive: true });

    const base = Date.parse("2026-03-03T21:10:00.000Z");
    const episode: Episode = {
      id: "run-llm-multi-app-ep-0001",
      runId: "run-llm-multi-app",
      startTs: new Date(base).toISOString(),
      endTs: new Date(base + 4_000).toISOString(),
      durationMs: 4_000,
      eventsCount: 3,
      events: [
        buildEvent({
          id: "m1",
          tsMs: base,
          eventType: "window_focus",
          appName: "Google Chrome",
          windowName: "Task Page",
        }),
        buildEvent({
          id: "m2",
          tsMs: base + 2_000,
          eventType: "window_focus",
          appName: "Terminal",
          windowName: "Terminal",
        }),
        buildEvent({
          id: "m3",
          tsMs: base + 4_000,
          eventType: "text",
          appName: "Terminal",
          windowName: "Terminal",
          textContent: "done",
        }),
      ],
    };

    await writeFile(
      path.join(runDir, "manifest.json"),
      `${JSON.stringify({ runId: "run-llm-multi-app" })}\n`,
      "utf8",
    );
    await writeFile(
      path.join(runDir, "episodes.json"),
      `${JSON.stringify([episode], null, 2)}\n`,
      "utf8",
    );

    const llmClient: OpenClawLlmClient = {
      async generateSkillDraft() {
        return {
          goal: "Complete cross-application operations",
          whenToUse: ["when you need to execute a cross-application task"],
          prerequisites: ["Both applications are available"],
          steps: [
            {
              instruction:
                "View the result in Google Chrome, then return to Terminal to run the confirmation command.",
              intent: "Complete the final confirmation.",
              operationApp: "Google Chrome / Terminal",
            },
          ],
          successCriteria: ["The result is confirmed"],
          fallback: [" after Retry"],
        };
      },
    };

    const result = await extractOpenClawSkillLlm({
      runDir,
      outDir: path.join(runDir, "openclaw-llm"),
      now: new Date("2026-03-03T21:15:00.000Z"),
      llmClient,
    });

    expect(result.skill.steps).toHaveLength(2);
    expect(result.skill.steps.map((step) => step.operationApp)).toEqual([
      "Google Chrome",
      "Terminal",
    ]);
    expect(
      result.summary.warnings.some((warning) =>
        warning.includes("Split one multi-app LLM step"),
      ),
    ).toBe(true);
  });
  // EN: For "Bilibili learning + Google Docs note-taking" trajectories, output should be generalized and include Docs preference.
  it("does not override learning workflow with template", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-skill-llm-learning-abstraction-"),
    );
    const runDir = path.join(root, "runs", "run-llm-learning-abstraction");
    await mkdir(runDir, { recursive: true });

    const base = Date.parse("2026-03-03T22:00:00.000Z");
    const episode: Episode = {
      id: "run-llm-learning-abstraction-ep-0001",
      runId: "run-llm-learning-abstraction",
      startTs: new Date(base).toISOString(),
      endTs: new Date(base + 10_000).toISOString(),
      durationMs: 10_000,
      eventsCount: 5,
      events: [
        buildEvent({
          id: "l1",
          tsMs: base,
          eventType: "ocr",
          appName: "Google Chrome",
          windowName: "Vibe Coding_bilibili_bilibili",
          textContent: "vibe coding tutorial",
        }),
        buildEvent({
          id: "l2",
          tsMs: base + 2_000,
          eventType: "ocr",
          appName: "Google Chrome",
          windowName: "_bilibili_bilibili",
          textContent: "watch and learn",
        }),
        buildEvent({
          id: "l3",
          tsMs: base + 4_000,
          eventType: "window_focus",
          appName: "Google Chrome",
          windowName: "Untitled document - Google Docs",
        }),
        buildEvent({
          id: "l4",
          tsMs: base + 6_000,
          eventType: "text",
          appName: "Google Chrome",
          windowName: "Untitled document - Google Docs",
          textContent: "vibe coding notes",
        }),
        buildEvent({
          id: "l5",
          tsMs: base + 10_000,
          eventType: "text",
          appName: "Google Chrome",
          windowName: "Untitled document - Google Docs",
          textContent: "action items",
        }),
      ],
    };

    await writeFile(
      path.join(runDir, "manifest.json"),
      `${JSON.stringify({ runId: "run-llm-learning-abstraction" })}\n`,
      "utf8",
    );
    await writeFile(
      path.join(runDir, "episodes.json"),
      `${JSON.stringify([episode], null, 2)}\n`,
      "utf8",
    );

    const llmClient: OpenClawLlmClient = {
      async generateSkillDraft() {
        return {
          skillName: "Vibe Coding Study Notes",
          goal: "Watch the specified video and record notes",
          whenToUse: ["Need to reproduce this workflow"],
          prerequisites: ["browser available"],
          steps: [
            {
              instruction: "Open this specific video page.",
              intent: "Enter the study flow.",
              operationApp: "Google Chrome",
            },
            {
              instruction: "Continue watching and switch sections.",
              intent: "Gather information.",
              operationApp: "Google Chrome",
            },
            {
              instruction: "Write the summary in the document.",
              intent: "Capture the result.",
              operationApp: "Google Chrome",
            },
          ],
          successCriteria: ["Study notes exist"],
          fallback: ["Retry"],
        };
      },
    };

    const result = await extractOpenClawSkillLlm({
      runDir,
      outDir: path.join(runDir, "openclaw-llm"),
      now: new Date("2026-03-03T22:05:00.000Z"),
      llmClient,
    });

    expect(result.skill.goal).toBe(
      "Watch the specified video and record notes",
    );
    expect(result.skill.whenToUse).toContain("Need to reproduce this workflow");
    expect(
      result.skill.steps.some((step) => step.instruction.includes("search")),
    ).toBe(false);
    expect(
      result.skill.steps.some((step) =>
        step.instruction.includes("Google Docs"),
      ),
    ).toBe(false);
    expect(
      result.summary.warnings.some((warning) =>
        warning.includes("Applied behavior abstraction"),
      ),
    ).toBe(false);
  });

  it("writes scenario cards and one generalized variant without overriding the specific skill", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-skill-llm-generalization-one-"),
    );
    const runDir = path.join(root, "runs", "run-llm-generalization-one");
    await mkdir(runDir, { recursive: true });

    const base = Date.parse("2026-03-10T18:00:00.000Z");
    const episode: Episode = {
      id: "run-llm-generalization-one-ep-0001",
      runId: "run-llm-generalization-one",
      startTs: new Date(base).toISOString(),
      endTs: new Date(base + 8_000).toISOString(),
      durationMs: 8_000,
      eventsCount: 4,
      events: [
        buildEvent({
          id: "g1",
          tsMs: base,
          eventType: "ocr",
          appName: "Google Chrome",
          windowName: "BA5223 Assignments",
          textContent: "BA5223 this week assignments",
        }),
        buildEvent({
          id: "g2",
          tsMs: base + 2_000,
          eventType: "click",
          appName: "Google Chrome",
          windowName: "BA5223 Assignments",
          x: 120,
          y: 260,
        }),
        buildEvent({
          id: "g3",
          tsMs: base + 5_000,
          eventType: "window_focus",
          appName: "Google Chrome",
          windowName: "BA5223 Notes - Google Docs",
        }),
        buildEvent({
          id: "g4",
          tsMs: base + 8_000,
          eventType: "text",
          appName: "Google Chrome",
          windowName: "BA5223 Notes - Google Docs",
          textContent: "assignment notes",
        }),
      ],
    };

    await writeFile(
      path.join(runDir, "manifest.json"),
      `${JSON.stringify({ runId: "run-llm-generalization-one" })}\n`,
      "utf8",
    );
    await writeFile(
      path.join(runDir, "episodes.json"),
      `${JSON.stringify([episode], null, 2)}\n`,
      "utf8",
    );

    const llmClient: OpenClawLlmClient = {
      async generateSkillDraft() {
        return {
          skillName: "BA5223 Weekly Assignment Notes",
          goal: "View the BA5223 current_week assignment and record it to the course Google Docs.",
          whenToUse: [
            "when you need to reproduce this BA5223 current_week assignment viewing and recording workflow",
          ],
          prerequisites: ["The course page is already signed in."],
          steps: [
            {
              instruction:
                "Open the BA5223 assignment page and view the current_week assignment.",
              intent:
                "Confirm the assignment that needs to be completed this current_week.",
              operationApp: "Google Chrome",
            },
            {
              instruction:
                "Switch to the BA5223 Google Docs notes document and record the assignment content.",
              intent: "Capture the current_week assignment record.",
              operationApp: "Google Chrome",
            },
          ],
          successCriteria: [
            "The current_week assignment record appears in Google Docs.",
          ],
          fallback: ["If the course page did not load, refresh and retry."],
          outputs: [
            {
              name: "BA5223 Google Docs notes document",
              description: "Update the current_week assignment record.",
            },
          ],
        };
      },
      async predictReusableScenarios() {
        return {
          scenarios: [
            {
              scenarioId: "weekly-assignment-check",
              nextUseHypothesis:
                "The user will most likely view the latest BA5223 weekly assignment next time and record it into the same Google Docs container.",
            },
          ],
        };
      },
      async generalizeSkillForScenario() {
        return {
          skillName: "BA5223 Weekly Assignment Review and Notes",
          goal: "View BA5223 current_week assignment and Recordcourse Google Docs Document.",
          whenToUse: [
            "when you need to view the latest BA5223 current-week assignment and update the course Google Docs notes",
          ],
          outputs: [
            {
              name: "BA5223 course Google Docs notes document",
              description:
                "Keep the course-level Google Docs container and update the current-week assignment record.",
            },
          ],
          steps: [
            {
              instruction:
                "Open the BA5223 course page and view the current_week assignment.",
              intent: "Confirm the current_week assignment.",
              operationApp: "Google Chrome",
            },
            {
              instruction:
                "Record the current_week assignment content in the BA5223 Google Docs notes document.",
              intent: "Keep the course-level record container.",
              operationApp: "Google Chrome",
            },
          ],
          successCriteria: [
            "The current_week assignment record was updated in the course Google Docs.",
          ],
          failureModes: ["A newly imagined generalized failure."],
          fallback: ["A newly imagined generalized recovery."],
        };
      },
    };

    const outDir = path.join(runDir, "openclaw-llm");
    const result = await extractOpenClawSkillLlm({
      runDir,
      outDir,
      now: new Date("2026-03-10T18:10:00.000Z"),
      llmClient,
    });

    expect(result.skill.skillName).toBe("BA5223 Weekly Assignment Notes");
    expect(result.skill.goal).toContain("current_week");
    expect(result.generalization?.scenarioCount).toBe(1);
    expect(result.generalization?.variants).toHaveLength(1);

    const predictedScenarios = JSON.parse(
      await readFile(path.join(outDir, "predicted-scenarios.json"), "utf8"),
    ) as Array<{ scenarioId: string }>;
    expect(predictedScenarios).toHaveLength(1);
    expect(predictedScenarios[0]?.scenarioId).toBe("weekly-assignment-check");

    const generalizedSkillPath =
      result.generalization?.variants[0]?.output.skillPath ?? "";
    const generalizedGraphPath =
      result.generalization?.variants[0]?.output.workflowGraphPath ?? "";
    const generalizedSkill = JSON.parse(
      await readFile(generalizedSkillPath, "utf8"),
    ) as {
      goal: string;
      outputs: Array<{ name: string; description: string }>;
      steps: Array<{ instruction: string }>;
      failureModes: string[];
      fallback: string[];
    };
    expect(generalizedSkill.goal).toContain("current_week");
    expect(generalizedSkill.goal).toContain("Google Docs");
    expect(generalizedSkill.goal).not.toContain("Untitled document");
    expect(generalizedSkill.outputs[0]?.name).toContain("Google Docs");
    expect(
      generalizedSkill.steps.some((step) =>
        step.instruction.includes("current_week"),
      ),
    ).toBe(true);
    expect(generalizedSkill.failureModes).toEqual([]);
    expect(generalizedSkill.fallback).toEqual([
      "If the course page did not load, refresh and retry.",
    ]);
    const generalizedGraph = JSON.parse(
      await readFile(generalizedGraphPath, "utf8"),
    ) as { source?: { skillId?: string }; nodes?: unknown[] };
    expect(generalizedGraph.source?.skillId).toBe(
      result.generalization?.variants[0]?.skillId,
    );
    expect(generalizedGraph.nodes?.length).toBeGreaterThan(1);
  });

  it("writes three generalized variants when three scenarios are predicted", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-skill-llm-generalization-three-"),
    );
    const runDir = path.join(root, "runs", "run-llm-generalization-three");
    await mkdir(runDir, { recursive: true });

    const base = Date.parse("2026-03-11T18:00:00.000Z");
    const episode: Episode = {
      id: "run-llm-generalization-three-ep-0001",
      runId: "run-llm-generalization-three",
      startTs: new Date(base).toISOString(),
      endTs: new Date(base + 4_000).toISOString(),
      durationMs: 4_000,
      eventsCount: 2,
      events: [
        buildEvent({
          id: "tg1",
          tsMs: base,
          eventType: "ocr",
          appName: "Google Chrome",
          windowName: "Claims Center",
          textContent: "claim status history",
        }),
        buildEvent({
          id: "tg2",
          tsMs: base + 4_000,
          eventType: "text",
          appName: "Google Chrome",
          windowName: "Claims Center",
          textContent: "latest claim message",
        }),
      ],
    };

    await writeFile(
      path.join(runDir, "manifest.json"),
      `${JSON.stringify({ runId: "run-llm-generalization-three" })}\n`,
      "utf8",
    );
    await writeFile(
      path.join(runDir, "episodes.json"),
      `${JSON.stringify([episode], null, 2)}\n`,
      "utf8",
    );

    const llmClient: OpenClawLlmClient = {
      async generateSkillDraft() {
        return {
          skillName: "Claim Status Verification",
          goal: "View claim status and the latest messages.",
          whenToUse: [
            "when you need to reproduce this claim status verification workflow",
          ],
          prerequisites: ["The claim page is already open."],
          steps: [
            {
              instruction: "Open the claim details page.",
              intent: "Enter the claim context.",
              operationApp: "Google Chrome",
            },
            {
              instruction: "View the latest status and messages.",
              intent: "Complete the verification.",
              operationApp: "Google Chrome",
            },
          ],
          successCriteria: ["Confirm the latest status and messages."],
          fallback: ["If the page is abnormal, refresh and retry."],
        };
      },
      async predictReusableScenarios() {
        return {
          scenarios: [
            {
              scenarioId: "latest-status",
              nextUseHypothesis:
                "The user will continue viewing the latest status next time.",
            },
            {
              scenarioId: "history-check",
              nextUseHypothesis:
                "The user will view message history next time.",
            },
            {
              scenarioId: "status-and-history",
              nextUseHypothesis:
                "The user will view status and history next time.",
            },
          ],
        };
      },
      async generalizeSkillForScenario(input) {
        return {
          skillName: `Generalized ${input.scenario.scenarioId}`,
          goal: input.scenario.nextUseHypothesis,
          whenToUse: [input.scenario.nextUseHypothesis],
        };
      },
    };

    const outDir = path.join(runDir, "openclaw-llm");
    const result = await extractOpenClawSkillLlm({
      runDir,
      outDir,
      now: new Date("2026-03-11T18:10:00.000Z"),
      llmClient,
    });

    expect(result.generalization?.scenarioCount).toBe(3);
    expect(result.generalization?.variants).toHaveLength(3);
    expect(result.summary.generalization?.llm?.callCount).toBe(4);

    await Promise.all(
      (result.generalization?.variants ?? []).flatMap((variant) => [
        access(variant.output.skillPath),
        access(variant.output.workflowGraphPath ?? ""),
        access(variant.output.workflowMarkdownPath ?? ""),
        access(variant.output.workflowRevisionsDir ?? ""),
      ]),
    );
  });

  it("skips generalization when scenario prediction count exceeds three", async () => {
    const root = await mkdtemp(
      path.join(
        os.tmpdir(),
        "oysterworkflow-skill-llm-generalization-invalid-",
      ),
    );
    const runDir = path.join(root, "runs", "run-llm-generalization-invalid");
    await mkdir(runDir, { recursive: true });

    const base = Date.parse("2026-03-12T18:00:00.000Z");
    const episode: Episode = {
      id: "run-llm-generalization-invalid-ep-0001",
      runId: "run-llm-generalization-invalid",
      startTs: new Date(base).toISOString(),
      endTs: new Date(base + 2_000).toISOString(),
      durationMs: 2_000,
      eventsCount: 1,
      events: [
        buildEvent({
          id: "ig1",
          tsMs: base,
          eventType: "ocr",
          textContent: "single event",
        }),
      ],
    };

    await writeFile(
      path.join(runDir, "manifest.json"),
      `${JSON.stringify({ runId: "run-llm-generalization-invalid" })}\n`,
      "utf8",
    );
    await writeFile(
      path.join(runDir, "episodes.json"),
      `${JSON.stringify([episode], null, 2)}\n`,
      "utf8",
    );

    let generalizeCalls = 0;
    const llmClient: OpenClawLlmClient = {
      async generateSkillDraft() {
        return {
          skillName: "Simple Skill",
          goal: "Execute a simple action.",
          whenToUse: ["when you need to reproduce this simple action"],
          prerequisites: ["The browser is available."],
          steps: [
            {
              instruction: "Execute the current action.",
              intent: "Complete the task.",
              operationApp: "Google Chrome",
            },
          ],
          successCriteria: ["The task is complete."],
          fallback: [" whenRetry."],
        };
      },
      async predictReusableScenarios() {
        return {
          scenarios: [
            {
              scenarioId: "s1",
              nextUseHypothesis: "1",
            },
            {
              scenarioId: "s2",
              nextUseHypothesis: "2",
            },
            {
              scenarioId: "s3",
              nextUseHypothesis: "3",
            },
            {
              scenarioId: "s4",
              nextUseHypothesis: "4",
            },
          ],
        };
      },
      async generalizeSkillForScenario() {
        generalizeCalls += 1;
        return {};
      },
    };

    const result = await extractOpenClawSkillLlm({
      runDir,
      outDir: path.join(runDir, "openclaw-llm"),
      now: new Date("2026-03-12T18:10:00.000Z"),
      llmClient,
    });

    expect(result.generalization?.scenarioCount).toBe(0);
    expect(result.generalization?.variants).toHaveLength(0);
    expect(result.generalization?.predictedScenariosPath).toBeNull();
    expect(
      result.generalization?.warnings.some((warning) =>
        warning.includes("1-3"),
      ),
    ).toBe(true);
    expect(generalizeCalls).toBe(0);
  });
});
