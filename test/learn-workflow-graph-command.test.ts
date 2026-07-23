import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseLearnWorkflowGraphCliArgs,
  runLearnWorkflowGraph,
} from "../src/cli/commands/learn-workflow-graph.js";
import {
  loadWorkflowGraph,
  toWorkflowGraphDraft,
} from "../src/skill/workflow-graph.js";
import type { OpenClawLlmClient } from "../src/skill/extract-openclaw-llm.js";
import type {
  OpenClawSkill,
  OysterWorkflowGraph,
} from "../src/types/contracts.js";

describe("learn-workflow-graph command", () => {
  it("requires absolute input and output paths", () => {
    expect(() =>
      parseLearnWorkflowGraphCliArgs({
        skill: "skill.json",
        out: "/tmp/out",
      }),
    ).toThrow("--skill must be an absolute path");
  });

  it("promotes a Call 3 Candidate and then produces Call 5 against a v2 catalog", async () => {
    const root = await mkdtemp(join(tmpdir(), "learn-workflow-command-"));
    const baseSkillPath = join(root, "base-skill.json");
    const baseOut = join(root, "base-family");
    const baseSkill = buildSkill("base-sales", "episode-base");
    await writeFile(baseSkillPath, `${JSON.stringify(baseSkill, null, 2)}\n`);

    const baseResult = await runLearnWorkflowGraph({
      skillPath: baseSkillPath,
      outDir: baseOut,
      llmClient: buildNewFamilyClient(),
      now: new Date("2026-07-12T20:00:00.000Z"),
    });
    expect(baseResult.familyMatch.decision).toBe("new_family");
    expect(baseResult.paths.canonicalGraphPath).toBe(
      join(baseOut, "workflow.json"),
    );
    const baseGraph = await loadWorkflowGraph(
      baseResult.paths.canonicalGraphPath!,
    );

    const catalogPath = join(root, "workflow-families.json");
    await writeFile(
      catalogPath,
      `${JSON.stringify(
        {
          schemaVersion: "oyster-workflow-family-catalog-v2",
          families: [
            {
              workflowId: baseGraph.workflowId,
              name: baseGraph.name,
              goal: baseGraph.goal,
              whenToUse: ["A sales inquiry arrives"],
              outline: ["Assess legitimacy"],
              terminalOutcomes: ["completed"],
              apps: ["Outlook"],
              graphPath: "base-family/workflow.json",
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const nextSkillPath = join(root, "next-skill.json");
    const nextSkill = buildSkill("next-sales", "episode-next");
    const nextOut = join(root, "next-case");
    await writeFile(nextSkillPath, `${JSON.stringify(nextSkill, null, 2)}\n`);
    const result = await runLearnWorkflowGraph({
      skillPath: nextSkillPath,
      outDir: nextOut,
      workflowFamilyCatalogPath: catalogPath,
      llmClient: buildMatchClient(baseGraph),
      now: new Date("2026-07-12T21:00:00.000Z"),
    });

    expect(result.familyMatch).toEqual(
      expect.objectContaining({
        decision: "match",
        matchedWorkflowId: baseGraph.workflowId,
      }),
    );
    expect(result.mergeProposal?.result).toBe("no_change");
    expect(result.calls.map((call) => call.label)).toEqual([
      "call-3",
      "call-4",
      "call-5",
    ]);
    expect(result.paths.canonicalGraphPath).toBe(
      join(baseOut, "workflow.json"),
    );
    expect(
      JSON.parse(await readFile(result.paths.mergeProposalPath!, "utf8")),
    ).toEqual(expect.objectContaining({ result: "no_change" }));
  });
});

function buildNewFamilyClient(): OpenClawLlmClient {
  return {
    generateSkillDraft: async () => ({}),
    generateCandidateWorkflow: async () => buildCandidateDraft(),
  };
}

function buildMatchClient(graph: OysterWorkflowGraph): OpenClawLlmClient {
  return {
    generateSkillDraft: async () => ({}),
    generateCandidateWorkflow: async () => buildCandidateDraft(),
    matchWorkflowFamily: async () => ({
      decision: "match",
      matchedWorkflowId: graph.workflowId,
    }),
    proposeWorkflowMerge: async (input) => ({
      result: "no_change",
      mergedGraph: toWorkflowGraphDraft(input.canonicalGraph),
      nodeMappings: [
        {
          candidateNodeId: "assess-legitimacy",
          mergedNodeIds: ["assess-legitimacy"],
          disposition: "reuse",
        },
        {
          candidateNodeId: "terminal-proceed",
          mergedNodeIds: ["terminal-proceed"],
          disposition: "reuse",
        },
      ],
      transitionMappings: [
        {
          candidateTransitionId: "route-legitimate",
          mergedTransitionIds: ["route-legitimate"],
          disposition: "reuse",
        },
      ],
    }),
  };
}

function buildCandidateDraft(): Record<string, unknown> {
  return {
    name: "Handle inbound opportunity",
    goal: "Decide whether the opportunity should proceed",
    entryNodeId: "assess-legitimacy",
    nodes: [
      {
        id: "assess-legitimacy",
        type: "decision",
        title: "Assess legitimacy",
        decision: "Is the inquiry legitimate?",
        hints: [],
      },
      {
        id: "terminal-proceed",
        type: "terminal",
        title: "Proceed with evaluation",
        outcome: "completed",
        summary: "The legitimate inquiry advances to evaluation.",
        hints: [],
      },
    ],
    transitions: [
      {
        id: "route-legitimate",
        from: "assess-legitimacy",
        to: "terminal-proceed",
        type: "conditional",
        when: "The inquiry is legitimate",
      },
    ],
  };
}

function buildSkill(skillId: string, episodeId: string): OpenClawSkill {
  return {
    schemaVersion: "openclaw-skill-v1",
    promptSet: "specific-v29",
    skillId,
    skillName: "Handle inbound opportunity",
    generatedAt: "2026-07-12T19:00:00.000Z",
    source: {
      runId: `run-${skillId}`,
      runDir: `/runs/run-${skillId}`,
      episodeId,
      startTs: "2026-07-12T18:00:00.000Z",
      endTs: "2026-07-12T18:05:00.000Z",
    },
    description: "Handle one inbound sales opportunity.",
    goal: "Decide whether the opportunity should proceed",
    whenToUse: ["A sales inquiry arrives"],
    whenNotToUse: [],
    inputs: [],
    outputs: [],
    prerequisites: [],
    steps: [
      {
        step: 1,
        instruction: "Assess whether the inquiry is legitimate.",
        intent: "Avoid pursuing fraudulent requests.",
        operationApp: "Outlook",
        hints: [],
      },
    ],
    successCriteria: ["The inquiry is routed"],
    failureModes: [],
    fallback: [],
    examples: [],
    tags: ["sales"],
    assets: [],
    evidence: {
      totalEvents: 1,
      anchorEvents: 1,
      ocrEvents: 0,
      appsSeen: ["Outlook"],
      windowsSeen: ["Inbox"],
    },
  };
}
