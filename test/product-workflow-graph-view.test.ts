import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readProductWorkflowGraph } from "../src/product/workflow-graph-view.js";
import { persistWorkflowGraphDraft } from "../src/skill/workflow-graph.js";
import {
  applyWorkflowMergeProposal,
  buildWorkflowGraphDraftFromCandidate,
  normalizeWorkflowMergeProposal,
} from "../src/skill/workflow-merge.js";
import type { ProductWorkflow } from "../src/product/contracts.js";
import type {
  CandidateWorkflow,
  OpenClawSkill,
} from "../src/types/contracts.js";

describe("product workflow graph view service", () => {
  it("loads canonical, Candidate, and Call 5 proposal siblings", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "product-graph-view-"));
    const skill = buildSkill();
    const candidate = buildCandidate(skill.skillId);
    const saved = await persistWorkflowGraphDraft({
      draft: buildWorkflowGraphDraftFromCandidate(candidate, skill),
      outDir,
      now: new Date("2026-07-12T20:00:00.000Z"),
    });
    const proposal = normalizeWorkflowMergeProposal({
      raw: {
        result: "no_change",
        mergedGraph: {
          ...saved.graph,
          revision: undefined,
        },
        nodeMappings: candidate.nodes.map((node) => ({
          candidateNodeId: node.id,
          mergedNodeIds: [node.id],
          disposition: "reuse",
        })),
        transitionMappings: candidate.transitions.map((transition) => ({
          candidateTransitionId: transition.id,
          mergedTransitionIds: [transition.id],
          disposition: "reuse",
        })),
      },
      candidate,
      canonicalGraph: saved.graph,
      skill,
    });
    await writeFile(
      join(outDir, "workflow-candidate.json"),
      `${JSON.stringify(candidate, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(outDir, "workflow-merge-proposal.json"),
      `${JSON.stringify(proposal, null, 2)}\n`,
      "utf8",
    );

    const result = await readProductWorkflowGraph({
      workflowId: saved.graph.workflowId,
      artifactPath: join(outDir, "skill.json"),
    });

    expect(result.canonicalGraph?.workflowId).toBe(saved.graph.workflowId);
    expect(result.candidate?.candidateId).toBe(candidate.candidateId);
    expect(result.mergeProposal?.proposalId).toBe(proposal.proposalId);
    expect(result.errors).toEqual([]);
  });

  it("returns a focused error while preserving other valid graph artifacts", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "product-graph-error-"));
    const skill = buildSkill();
    const candidate = buildCandidate(skill.skillId);
    const saved = await persistWorkflowGraphDraft({
      draft: buildWorkflowGraphDraftFromCandidate(candidate, skill),
      outDir,
    });
    await writeFile(
      join(outDir, "workflow-candidate.json"),
      "{ not valid json\n",
      "utf8",
    );

    const result = await readProductWorkflowGraph({
      workflowId: saved.graph.workflowId,
      graphPath: saved.graphPath,
      candidatePath: join(outDir, "workflow-candidate.json"),
    });

    expect(result.canonicalGraph).not.toBeNull();
    expect(result.candidate).toBeNull();
    expect(result.errors).toEqual([
      expect.objectContaining({ artifact: "candidate" }),
    ]);
  });

  it("resolves the matched family graph and distinguishes ready from applied proposals", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "product-graph-base-"));
    const sourceDir = await mkdtemp(join(tmpdir(), "product-graph-source-"));
    const baseSkill = buildSkill("base-case");
    const baseCandidate = buildCandidate(baseSkill.skillId);
    const base = await persistWorkflowGraphDraft({
      draft: buildWorkflowGraphDraftFromCandidate(baseCandidate, baseSkill),
      outDir: baseDir,
      now: new Date("2026-07-12T20:00:00.000Z"),
    });
    const sourceSkill = buildSkill("next-case");
    const sourceCandidate = buildCandidate(sourceSkill.skillId);
    const proposal = normalizeWorkflowMergeProposal({
      raw: {
        result: "no_change",
        mergedGraph: {
          ...base.graph,
          revision: undefined,
        },
        nodeMappings: sourceCandidate.nodes.map((node) => ({
          candidateNodeId: node.id,
          mergedNodeIds: [node.id],
          disposition: "reuse",
        })),
        transitionMappings: sourceCandidate.transitions.map((transition) => ({
          candidateTransitionId: transition.id,
          mergedTransitionIds: [transition.id],
          disposition: "reuse",
        })),
      },
      candidate: sourceCandidate,
      canonicalGraph: base.graph,
      skill: sourceSkill,
      now: new Date("2026-07-12T20:05:00.000Z"),
    });
    await writeFile(
      join(sourceDir, "workflow-merge-proposal.json"),
      `${JSON.stringify(proposal, null, 2)}\n`,
      "utf8",
    );
    const workflows = [
      buildProductWorkflow(
        "product.source",
        sourceDir,
        "2026-07-12T20:05:00.000Z",
      ),
      buildProductWorkflow("product.base", baseDir, "2026-07-12T20:00:00.000Z"),
    ];

    const ready = await readProductWorkflowGraph({
      workflowId: "product.source",
      artifactPath: sourceDir,
      workflows,
    });

    expect(ready.mergeStatus).toBe("ready");
    expect(ready.mergeBaseGraph?.revision.revisionId).toBe(
      base.graph.revision.revisionId,
    );
    expect(ready.paths.mergeBaseGraphPath).toBe(base.graphPath);

    const applied = await applyWorkflowMergeProposal({
      proposal,
      currentGraph: base.graph,
      outDir: baseDir,
      now: new Date("2026-07-12T20:10:00.000Z"),
    });
    const afterApply = await readProductWorkflowGraph({
      workflowId: "product.source",
      artifactPath: sourceDir,
      workflows,
    });

    expect(afterApply.mergeStatus).toBe("applied");
    expect(afterApply.mergeBaseGraph?.revision.revisionId).toBe(
      applied.graph.revision.revisionId,
    );
  });
});

function buildProductWorkflow(
  id: string,
  artifactPath: string,
  updatedAt: string,
): ProductWorkflow {
  return {
    id,
    title: id,
    description: id,
    status: "Generated",
    sourceType: "runtime",
    confidence: null,
    apps: [],
    stats: {
      uiEvents: 0,
      ocrObservations: 0,
      voiceNotes: 0,
      duration: "00:00",
      decisionPoints: 0,
    },
    detectedAt: updatedAt,
    artifactPath,
    createdAt: updatedAt,
    updatedAt,
  };
}

function buildCandidate(skillId: string): CandidateWorkflow {
  return {
    schemaVersion: "oyster-workflow-candidate-v2",
    candidateId: `candidate.${skillId}`,
    skillId,
    name: "Review one opportunity",
    goal: "Decide whether an opportunity should proceed",
    entryNodeId: "review",
    nodes: [
      {
        id: "review",
        type: "action",
        title: "Review the request",
        objective: "Understand the request",
        act: ["Read the request"],
        operationApp: "Outlook",
        hints: [],
      },
      {
        id: "complete",
        type: "terminal",
        title: "Review complete",
        outcome: "completed",
        summary: "The request has been reviewed.",
        hints: [],
      },
    ],
    transitions: [
      {
        id: "review-complete",
        from: "review",
        to: "complete",
        type: "default",
      },
    ],
  };
}

function buildSkill(skillId = "graph-view"): OpenClawSkill {
  return {
    schemaVersion: "openclaw-skill-v1",
    promptSet: "specific-v29",
    skillId,
    skillName: "Review one opportunity",
    generatedAt: "2026-07-12T19:00:00.000Z",
    source: {
      runId: `run-${skillId}`,
      runDir: `/runs/run-${skillId}`,
      episodeId: `episode-${skillId}`,
      startTs: "2026-07-12T18:00:00.000Z",
      endTs: "2026-07-12T18:05:00.000Z",
    },
    description: "Review one opportunity.",
    goal: "Decide whether an opportunity should proceed",
    whenToUse: ["A request arrives"],
    whenNotToUse: [],
    inputs: [],
    outputs: [],
    prerequisites: [],
    steps: [
      {
        step: 1,
        instruction: "Read the request",
        intent: "Understand the request",
        operationApp: "Outlook",
        hints: [],
      },
    ],
    successCriteria: ["The request is reviewed"],
    failureModes: [],
    fallback: [],
    examples: [],
    tags: [],
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
