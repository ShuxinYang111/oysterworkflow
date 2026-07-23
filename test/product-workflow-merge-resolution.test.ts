import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  ProductState,
  ProductWorkflow,
} from "../src/product/contracts.js";
import { finalizeProductWorkflowMergeState } from "../src/product/store.js";
import {
  listPendingProductWorkflowMerges,
  writeProductWorkflowMergeResolution,
} from "../src/product/workflow-merge-resolution.js";
import {
  persistWorkflowGraphDraft,
  toWorkflowGraphDraft,
} from "../src/skill/workflow-graph.js";
import { normalizeWorkflowMergeProposal } from "../src/skill/workflow-merge.js";
import type {
  CandidateWorkflow,
  OpenClawSkill,
  OysterWorkflowGraphDraftV2,
} from "../src/types/contracts.js";

describe("product workflow merge resolution", () => {
  it("lists a valid target and persists the create-new decision", async () => {
    const root = await mkdtemp(join(tmpdir(), "product-merge-resolution-"));
    const targetDir = join(root, "target");
    const sourceDir = join(root, "source");
    await mkdir(sourceDir, { recursive: true });
    const base = await persistWorkflowGraphDraft({
      draft: buildDraft(),
      outDir: targetDir,
      now: new Date("2026-07-21T12:00:00.000Z"),
    });
    const skill = buildSkill();
    const candidate = buildCandidate(skill.skillId);
    const proposal = normalizeWorkflowMergeProposal({
      raw: {
        result: "no_change",
        mergedGraph: toWorkflowGraphDraft(base.graph),
        nodeMappings: [
          {
            candidateNodeId: "complete",
            mergedNodeIds: ["complete"],
            disposition: "reuse",
          },
        ],
        transitionMappings: [],
      },
      candidate,
      canonicalGraph: base.graph,
      skill,
      now: new Date("2026-07-21T12:01:00.000Z"),
    });
    const sourceSkillPath = join(sourceDir, "skill.json");
    await writeFile(sourceSkillPath, `${JSON.stringify(skill, null, 2)}\n`);
    await writeFile(
      join(sourceDir, "workflow-merge-proposal.json"),
      `${JSON.stringify(proposal, null, 2)}\n`,
    );

    const source = buildProductWorkflow({
      id: "workflow.source",
      title: "New recorded case",
      artifactPath: sourceSkillPath,
      updatedAt: "2026-07-21T12:02:00.000Z",
    });
    const target = buildProductWorkflow({
      id: "workflow.target",
      title: "Existing workflow",
      artifactPath: base.graphPath,
      updatedAt: "2026-07-21T12:00:00.000Z",
    });
    const artifactless = {
      ...target,
      id: "workflow.artifactless",
      artifactPath: null,
      updatedAt: "2026-07-21T12:04:00.000Z",
    };
    const state = {
      workflows: [artifactless, source, target],
      workflowTombstones: [],
    } as unknown as ProductState;

    const pending = await listPendingProductWorkflowMerges(state);
    expect(pending).toEqual([
      expect.objectContaining({
        sourceWorkflowId: source.id,
        recommendedTargetWorkflowId: target.id,
        targets: [
          expect.objectContaining({
            workflowId: target.id,
            revisionId: base.graph.revision.revisionId,
          }),
        ],
      }),
    ]);

    await writeProductWorkflowMergeResolution({
      workflow: source,
      proposal,
      decision: "create_new",
      now: new Date("2026-07-21T12:03:00.000Z"),
    });
    expect(await listPendingProductWorkflowMerges(state)).toEqual([]);
  });

  it("removes the source card and promotes the updated target", () => {
    const source = buildProductWorkflow({
      id: "workflow.source",
      title: "New recorded case",
      artifactPath: "/runs/source/skill.json",
      updatedAt: "2026-07-21T12:02:00.000Z",
    });
    const target = buildProductWorkflow({
      id: "workflow.target",
      title: "Existing workflow",
      artifactPath: "/runs/target/workflow.json",
      updatedAt: "2026-07-21T12:00:00.000Z",
    });
    const state = {
      account: { id: "account.test" },
      workflows: [source, target],
      workflowTombstones: [],
    } as unknown as ProductState;

    const merged = finalizeProductWorkflowMergeState({
      draft: state,
      sourceWorkflow: source,
      targetWorkflowId: target.id,
      updatedAt: "2026-07-21T12:05:00.000Z",
    });

    expect(merged.workflows.map((workflow) => workflow.id)).toEqual([
      target.id,
    ]);
    expect(merged.workflows[0].updatedAt).toBe("2026-07-21T12:05:00.000Z");
    expect(merged.workflowTombstones).toEqual([
      expect.objectContaining({
        workflowId: source.id,
        deletedByAccountId: "account.test",
      }),
    ]);
  });
});

function buildDraft(): OysterWorkflowGraphDraftV2 {
  return {
    schemaVersion: "oyster-workflow-graph-v2",
    workflowId: "workflow.family",
    name: "Publish a social post",
    goal: "Publish a prepared social post.",
    entryNodeId: "complete",
    nodes: [
      {
        id: "complete",
        type: "terminal",
        title: "Post published",
        outcome: "completed",
        summary: "The prepared post is published.",
        hints: [],
        sourceRefs: [],
      },
    ],
    transitions: [],
    source: {
      skillId: "base-skill",
      skillSchemaVersion: "openclaw-skill-v1",
      skillGeneratedAt: "2026-07-21T11:59:00.000Z",
      promptSet: "specific-v33",
      runId: "run-base",
      runDir: "/runs/base",
      episodeId: "episode-base",
    },
  };
}

function buildCandidate(skillId: string): CandidateWorkflow {
  return {
    schemaVersion: "oyster-workflow-candidate-v2",
    candidateId: "candidate.source",
    skillId,
    name: "Publish a social post",
    goal: "Publish a prepared social post.",
    entryNodeId: "complete",
    nodes: [
      {
        id: "complete",
        type: "terminal",
        title: "Post published",
        outcome: "completed",
        summary: "The prepared post is published.",
        hints: [],
      },
    ],
    transitions: [],
  };
}

function buildSkill(): OpenClawSkill {
  return {
    schemaVersion: "openclaw-skill-v1",
    promptSet: "specific-v33",
    skillId: "source-skill",
    skillName: "Publish a social post",
    generatedAt: "2026-07-21T12:01:00.000Z",
    source: {
      runId: "run-source",
      runDir: "/runs/source",
      episodeId: "episode-source",
      startTs: "2026-07-21T11:50:00.000Z",
      endTs: "2026-07-21T12:00:00.000Z",
    },
    executionMode: "autonomous",
    shortDescription: "Publish a prepared post.",
    description: "Publish a prepared social post.",
    goal: "Publish a prepared social post.",
    whenToUse: ["A social post is ready."],
    whenNotToUse: [],
    inputs: [],
    outputs: [],
    prerequisites: [],
    steps: [
      {
        step: 1,
        instruction: "Publish the prepared post.",
        intent: "Complete publication.",
        operationApp: "Browser",
        hints: [],
      },
    ],
    successCriteria: ["The post is published."],
    failureModes: [],
    fallback: [],
    examples: [],
    tags: [],
    assets: [],
    evidence: {
      totalEvents: 1,
      anchorEvents: 1,
      ocrEvents: 1,
      appsSeen: ["Browser"],
      windowsSeen: ["Publisher"],
    },
  };
}

function buildProductWorkflow(input: {
  id: string;
  title: string;
  artifactPath: string;
  updatedAt: string;
}): ProductWorkflow {
  return {
    id: input.id,
    title: input.title,
    description: `${input.title} description`,
    status: "Generated",
    sourceType: "runtime",
    confidence: 90,
    apps: ["Browser"],
    stats: {
      uiEvents: 1,
      ocrObservations: 1,
      voiceNotes: 0,
      duration: "0:10",
      decisionPoints: 0,
    },
    detectedAt: input.updatedAt,
    artifactPath: input.artifactPath,
    createdAt: input.updatedAt,
    updatedAt: input.updatedAt,
  };
}
