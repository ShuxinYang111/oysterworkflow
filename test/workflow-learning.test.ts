import { describe, expect, it } from "vitest";
import { loadPromptSet } from "../src/skill/prompt-registry.js";
import { buildWorkflowGraphFromSkill } from "../src/skill/workflow-graph.js";
import {
  buildCandidateWorkflowPrompt,
  buildEmptyCatalogMatch,
  buildWorkflowFamilyCard,
  buildWorkflowFamilyMatchPrompt,
  normalizeCandidateWorkflow,
  normalizeWorkflowFamilyMatch,
} from "../src/skill/workflow-learning.js";
import type {
  OpenClawSkill,
  WorkflowFamilyCard,
} from "../src/types/contracts.js";

describe("workflow learning Call 3 and Call 4", () => {
  it("normalizes a single action string without weakening graph semantics", () => {
    const skill = buildSkill();
    const candidate = normalizeCandidateWorkflow(
      {
        name: "Check one inquiry",
        goal: "Decide whether the inquiry can continue",
        entryNodeId: "inspect",
        nodes: [
          {
            id: "inspect",
            type: "action",
            title: "Inspect inquiry",
            objective: "Read the request",
            act: "Open and read the inquiry",
            operationApp: "Outlook",
            hints: [],
          },
          {
            id: "done",
            type: "terminal",
            title: "Inquiry inspected",
            outcome: "completed",
            summary: "The inquiry has been inspected.",
            hints: [],
          },
        ],
        transitions: [
          {
            id: "inspect-to-done",
            from: "inspect",
            to: "done",
            type: "default",
          },
        ],
      },
      skill,
    );

    expect(candidate.nodes[0]).toEqual(
      expect.objectContaining({ act: ["Open and read the inquiry"] }),
    );
  });

  it("accepts a candidate decision with one observed route", () => {
    const candidate = normalizeCandidateWorkflow(
      buildCandidateDraft(),
      buildSkill(),
    );

    expect(candidate.schemaVersion).toBe("oyster-workflow-candidate-v2");
    expect(candidate.skillId).toBe("email-opportunity");
    expect(candidate.nodes[0]?.type).toBe("decision");
    expect(candidate.transitions).toHaveLength(1);
    expect(JSON.stringify(candidate)).not.toMatch(
      /confidence|reason|sourceRefs|stepRefs|provenance/i,
    );
  });

  it("binds Call 2 References to the corresponding Candidate nodes", () => {
    const skill: OpenClawSkill = {
      ...buildSkill(),
      references: [
        {
          id: "sender-profile",
          name: "Observed sender profile",
          value:
            "The sender used a public mailbox and supplied no company URL.",
        },
      ],
      steps: [
        {
          ...buildSkill().steps[0],
          referenceRefs: ["sender-profile"],
        },
      ],
    };
    const raw = buildCandidateDraft();
    const nodes = raw.nodes as Array<Record<string, unknown>>;
    nodes[0] = { ...nodes[0], referenceRefs: ["sender-profile"] };
    nodes[1] = { ...nodes[1], referenceRefs: [] };

    const candidate = normalizeCandidateWorkflow(raw, skill);

    expect(candidate.references).toEqual([
      expect.objectContaining({
        id: "reference:email-opportunity:sender-profile",
        name: "Observed sender profile",
      }),
    ]);
    expect(candidate.nodes[0]?.referenceRefs).toEqual([
      "reference:email-opportunity:sender-profile",
    ]);
    expect(candidate.nodes[1]?.referenceRefs).toBeUndefined();
  });

  it("rejects a Candidate node that invents a Reference ID", () => {
    const raw = buildCandidateDraft();
    const nodes = raw.nodes as Array<Record<string, unknown>>;
    nodes[0] = { ...nodes[0], referenceRefs: ["not-in-skill"] };

    expect(() => normalizeCandidateWorkflow(raw, buildSkill())).toThrow(
      "unknown Reference",
    );
  });

  it("strictly rejects Call 3 confidence, reason, and traceability fields", () => {
    const base = buildCandidateDraft();
    for (const extra of [
      { confidence: 0.9 },
      { reason: "Looks like a decision" },
      { sourceRefs: ["step-1"] },
    ]) {
      expect(() =>
        normalizeCandidateWorkflow(
          {
            ...base,
            ...extra,
          },
          buildSkill(),
        ),
      ).toThrow();
    }
  });

  it("normalizes Call 4 to only decision and matched workflow identity", () => {
    const candidate = normalizeCandidateWorkflow(
      buildCandidateDraft(),
      buildSkill(),
    );
    const families = [buildFamilyCard()];

    expect(
      normalizeWorkflowFamilyMatch(
        {
          decision: "match",
          matchedWorkflowId: "workflow.inbound-opportunity",
        },
        candidate,
        families,
      ),
    ).toEqual({
      schemaVersion: "oyster-workflow-family-match-v1",
      candidateId: candidate.candidateId,
      decision: "match",
      matchedWorkflowId: "workflow.inbound-opportunity",
    });
    expect(() =>
      normalizeWorkflowFamilyMatch(
        {
          decision: "match",
          matchedWorkflowId: "workflow.unknown",
        },
        candidate,
        families,
      ),
    ).toThrow("unknown workflow");
    expect(() =>
      normalizeWorkflowFamilyMatch(
        {
          decision: "new_family",
          matchedWorkflowId: null,
          reason: "No match",
        },
        candidate,
        families,
      ),
    ).toThrow();
  });

  it("resolves an empty family catalog without spending Call 4", () => {
    const candidate = normalizeCandidateWorkflow(
      buildCandidateDraft(),
      buildSkill(),
    );
    expect(buildEmptyCatalogMatch(candidate)).toEqual({
      schemaVersion: "oyster-workflow-family-match-v1",
      candidateId: candidate.candidateId,
      decision: "new_family",
      matchedWorkflowId: null,
    });
  });

  it("builds compact family cards and prompts with the intended inputs", async () => {
    const skill = buildSkill();
    const graph = buildWorkflowGraphFromSkill(skill);
    const family = buildWorkflowFamilyCard(graph, skill.whenToUse);
    const candidate = normalizeCandidateWorkflow(buildCandidateDraft(), skill);
    const promptSet = await loadPromptSet("specific-v29");
    const call3 = buildCandidateWorkflowPrompt(skill, promptSet);
    const call4 = buildWorkflowFamilyMatchPrompt(
      candidate,
      [family],
      promptSet,
    );

    expect(family).toEqual(
      expect.objectContaining({
        workflowId: "workflow.email-opportunity",
        apps: ["Outlook"],
      }),
    );
    expect(call3.userPrompt).toContain('"skillId": "email-opportunity"');
    expect(call3.userPrompt).not.toContain("Raw activity log");
    expect(call3.systemPrompt).toContain(
      "Do not output confidence, score, reason",
    );
    expect(call3.systemPrompt).toContain(
      "A decision node may have one known conditional route",
    );
    expect(call3.systemPrompt).not.toContain("objective, observe, act, verify");
    expect(call3.systemPrompt).toContain(
      "outcome must be completed, stopped, rejected, or failed",
    );
    expect(call4.userPrompt).toContain('"candidateId"');
    expect(call4.userPrompt).toContain(
      '"workflowId": "workflow.email-opportunity"',
    );
    expect(call4.systemPrompt).toContain("exactly two fields");
  });

  it("loads the step-bound Reference contract in PromptSet v34", async () => {
    const promptSet = await loadPromptSet("specific-v34");
    const prompt = buildCandidateWorkflowPrompt(buildSkill(), promptSet);

    expect(promptSet.features?.stepReferences).toBe(true);
    expect(prompt.systemPrompt).toContain("Every node includes referenceRefs");
    expect(prompt.systemPrompt).toContain(
      "Do not duplicate Reference content into hints",
    );
  });

  it("accepts a real workflow that currently ends at an open wait", () => {
    const candidate = normalizeCandidateWorkflow(
      {
        name: "Wait for engineering assessment",
        goal: "Pause the opportunity review until engineering responds",
        entryNodeId: "wait-engineering",
        nodes: [
          {
            id: "wait-engineering",
            type: "wait",
            title: "Wait for engineering",
            waitFor: "Engineering assessment",
            resumeCondition: "Engineering provides an assessment",
            hints: [],
          },
        ],
        transitions: [],
      },
      buildSkill(),
    );

    expect(candidate.nodes).toHaveLength(1);
    expect(candidate.transitions).toEqual([]);
  });

  it("rejects a condition-only decision represented as a default route", () => {
    const draft = buildCandidateDraft();
    const transitions = draft.transitions as Array<Record<string, unknown>>;
    transitions[0] = {
      id: "legitimate-request",
      from: "assess-legitimacy",
      to: "continue-evaluation",
      type: "default",
    };

    expect(() => normalizeCandidateWorkflow(draft, buildSkill())).toThrow(
      "requires at least one conditional route",
    );
  });
});

function buildCandidateDraft(): Record<string, unknown> {
  return {
    name: "Handle inbound opportunity",
    goal: "Decide whether to pursue an inbound opportunity",
    entryNodeId: "assess-legitimacy",
    nodes: [
      {
        id: "assess-legitimacy",
        type: "decision",
        title: "Assess legitimacy",
        decision: "Is the inbound request legitimate?",
        hints: [],
      },
      {
        id: "continue-evaluation",
        type: "terminal",
        title: "Continue evaluation",
        outcome: "completed",
        summary: "The current case proceeds to commercial evaluation.",
        hints: [],
      },
    ],
    transitions: [
      {
        id: "legitimate-request",
        from: "assess-legitimacy",
        to: "continue-evaluation",
        type: "conditional",
        when: "The request is legitimate",
      },
    ],
  };
}

function buildFamilyCard(): WorkflowFamilyCard {
  return {
    workflowId: "workflow.inbound-opportunity",
    name: "Handle inbound opportunity",
    goal: "Decide whether and how to pursue an inbound request",
    whenToUse: ["A new external opportunity arrives"],
    outline: ["Assess legitimacy", "Evaluate commercial value"],
    terminalOutcomes: ["rejected", "advanced"],
    apps: ["Outlook", "Browser"],
  };
}

function buildSkill(): OpenClawSkill {
  return {
    schemaVersion: "openclaw-skill-v1",
    promptSet: "specific-v28",
    skillId: "email-opportunity",
    skillName: "Handle inbound opportunity",
    generatedAt: "2026-07-12T20:00:00.000Z",
    source: {
      runId: "run-email-001",
      runDir: "/tmp/run-email-001",
      episodeId: "episode-email-001",
      startTs: "2026-07-12T19:00:00.000Z",
      endTs: "2026-07-12T19:10:00.000Z",
    },
    executionMode: "autonomous",
    shortDescription: "Qualify one inbound opportunity.",
    description: "Review an inbound request and decide whether to pursue it.",
    goal: "Decide whether to pursue an inbound opportunity",
    whenToUse: ["A new external opportunity email arrives"],
    whenNotToUse: [],
    inputs: [],
    outputs: [],
    prerequisites: ["Mailbox access"],
    steps: [
      {
        step: 1,
        instruction: "Assess the sender and request for legitimacy.",
        intent: "Avoid pursuing fraudulent requests.",
        operationApp: "Outlook",
        hints: [],
      },
    ],
    successCriteria: ["A next action is selected"],
    failureModes: [],
    fallback: [],
    examples: [],
    tags: ["email"],
    assets: [],
    evidence: {
      totalEvents: 10,
      anchorEvents: 2,
      ocrEvents: 3,
      appsSeen: ["Outlook"],
      windowsSeen: ["Inbox"],
    },
  };
}
