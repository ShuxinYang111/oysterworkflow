import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  parseApplyWorkflowMergeCliArgs,
  runApplyWorkflowMerge,
} from "../src/cli/commands/manage-workflow-graph.js";
import { loadPromptSet } from "../src/skill/prompt-registry.js";
import {
  loadWorkflowGraph,
  persistWorkflowGraphDraft,
  toWorkflowGraphDraft,
} from "../src/skill/workflow-graph.js";
import {
  applyWorkflowMergeProposal,
  buildWorkflowGraphDraftFromCandidate,
  buildWorkflowMergePrompt,
  normalizeWorkflowMergeProposal,
  parseWorkflowMergeProposal,
} from "../src/skill/workflow-merge.js";
import type {
  CandidateWorkflow,
  OpenClawSkill,
  OysterWorkflowGraph,
  OysterWorkflowGraphDraftV2,
} from "../src/types/contracts.js";

describe("workflow learning Call 5", () => {
  it("promotes a partial decision Candidate into a canonical new family", () => {
    const skill = buildSkill("case-base", "episode-base");
    const draft = buildWorkflowGraphDraftFromCandidate(
      buildProceedCandidate(skill.skillId),
      skill,
    );

    expect(draft.workflowId).toBe("workflow.case-base");
    expect(draft.nodes[0]).toEqual(
      expect.objectContaining({
        id: "assess-legitimacy",
        type: "decision",
        sourceRefs: expect.arrayContaining([
          expect.objectContaining({ ref: "skill:case-base" }),
          expect.objectContaining({
            ref: "episode:run-case-base:episode-base",
          }),
        ]),
      }),
    );
    expect(draft.transitions).toHaveLength(1);
  });

  it("builds Call 5 from only the complete canonical graph and Candidate", async () => {
    const { graph } = await persistBaseGraph();
    const candidate = buildProceedCandidate("case-next");
    const promptSet = await loadPromptSet("specific-v31");
    const prompt = buildWorkflowMergePrompt(graph, candidate, promptSet);

    expect(prompt.userPrompt).toContain("Canonical workflow graph:");
    expect(prompt.userPrompt).toContain(graph.workflowId);
    expect(prompt.userPrompt).toContain("Candidate workflow graph:");
    expect(prompt.userPrompt).not.toContain('"revision"');
    expect(prompt.systemPrompt).toContain("complete merged canonical graph");
    expect(prompt.systemPrompt).toContain(
      "one Candidate item maps to two or more",
    );
    expect(prompt.systemPrompt).toContain("Decision identity is semantic");
  });

  it("creates and applies provenance-only no_change revisions idempotently", async () => {
    const base = await persistBaseGraph();
    const nextSkill = buildSkill("case-next", "episode-next");
    const candidate = buildProceedCandidate(nextSkill.skillId);
    const raw = buildNoChangeRaw(base.graph, candidate);
    const proposal = normalizeWorkflowMergeProposal({
      raw,
      candidate,
      canonicalGraph: base.graph,
      skill: nextSkill,
      now: new Date("2026-07-12T21:00:00.000Z"),
    });

    expect(proposal.result).toBe("no_change");
    expect(proposal.mergedGraph?.nodes[0]?.sourceRefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ref: "skill:case-next" }),
        expect.objectContaining({
          ref: "episode:run-case-next:episode-next",
        }),
      ]),
    );
    expect(parseWorkflowMergeProposal(proposal)).toEqual(proposal);

    const applied = await applyWorkflowMergeProposal({
      proposal,
      currentGraph: base.graph,
      outDir: base.outDir,
      now: new Date("2026-07-12T21:01:00.000Z"),
    });
    expect(applied.graph.revision.number).toBe(2);

    const repeatedProposal = normalizeWorkflowMergeProposal({
      raw: buildNoChangeRaw(applied.graph, candidate),
      candidate,
      canonicalGraph: applied.graph,
      skill: nextSkill,
      now: new Date("2026-07-12T21:02:00.000Z"),
    });
    const repeated = await applyWorkflowMergeProposal({
      proposal: repeatedProposal,
      currentGraph: applied.graph,
      outDir: base.outDir,
      now: new Date("2026-07-12T21:03:00.000Z"),
    });
    expect(repeated.graph.revision.revisionId).toBe(
      applied.graph.revision.revisionId,
    );
  });

  it("adds Candidate References through node mappings without asking Call 5 to copy them", async () => {
    const base = await persistBaseGraph();
    const skill: OpenClawSkill = {
      ...buildSkill("case-reference", "episode-reference"),
      references: [
        {
          id: "sender-profile",
          name: "Observed sender profile",
          value: "Public mailbox and no official company URL.",
        },
      ],
    };
    const candidate: CandidateWorkflow = {
      ...buildProceedCandidate(skill.skillId),
      references: [
        {
          id: "reference:case-reference:sender-profile",
          name: "Observed sender profile",
          value: "Public mailbox and no official company URL.",
        },
      ],
      nodes: buildProceedCandidate(skill.skillId).nodes.map((node) =>
        node.id === "assess-legitimacy"
          ? {
              ...node,
              referenceRefs: ["reference:case-reference:sender-profile"],
            }
          : node,
      ),
    };

    const proposal = normalizeWorkflowMergeProposal({
      raw: buildNoChangeRaw(base.graph, candidate),
      candidate,
      canonicalGraph: base.graph,
      skill,
    });

    expect(proposal.mergedGraph?.references).toEqual(candidate.references);
    expect(proposal.mergedGraph?.nodes[0]?.referenceRefs).toEqual([
      "reference:case-reference:sender-profile",
    ]);
    expect(proposal.mergedGraph?.nodes[1]?.referenceRefs).toBeUndefined();
  });

  it("applies a stored proposal only through the explicit code command", async () => {
    const base = await persistBaseGraph();
    const skill = buildSkill("case-command", "episode-command");
    const candidate = buildProceedCandidate(skill.skillId);
    const proposal = normalizeWorkflowMergeProposal({
      raw: buildNoChangeRaw(base.graph, candidate),
      candidate,
      canonicalGraph: base.graph,
      skill,
    });
    const proposalPath = join(base.outDir, "proposal.json");
    await writeFile(proposalPath, `${JSON.stringify(proposal, null, 2)}\n`);

    const applied = await runApplyWorkflowMerge(
      parseApplyWorkflowMergeCliArgs({
        workflow: join(base.outDir, "workflow.json"),
        proposal: proposalPath,
        out: base.outDir,
      }),
    );

    expect(applied.graph.revision.number).toBe(2);
    expect(applied.graph.nodes[0]?.sourceRefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ref: "skill:case-command" }),
      ]),
    );
    expect(() =>
      parseApplyWorkflowMergeCliArgs({
        workflow: "workflow.json",
        proposal: proposalPath,
        out: base.outDir,
      }),
    ).toThrow("--workflow must be an absolute path");
  });

  it("adds a second outcome to the same partial decision", async () => {
    const base = await persistBaseGraph();
    const rejectedSkill = buildSkill("case-rejected", "episode-rejected");
    const candidate = buildRejectedCandidate(rejectedSkill.skillId);
    const baseDraft = toWorkflowGraphDraft(
      base.graph,
    ) as OysterWorkflowGraphDraftV2;
    const mergedGraph: OysterWorkflowGraphDraftV2 = {
      ...baseDraft,
      nodes: [
        ...baseDraft.nodes,
        {
          id: "terminal-fraud-rejected",
          type: "terminal",
          title: "Stop fraudulent inquiry",
          outcome: "rejected",
          summary: "The inquiry is rejected as fraudulent.",
          hints: [],
          sourceRefs: [],
        },
      ],
      transitions: [
        ...baseDraft.transitions,
        {
          id: "route-fraud-rejected",
          from: "assess-legitimacy",
          to: "terminal-fraud-rejected",
          type: "conditional",
          when: "The inquiry shows fraud signals",
          sourceRefs: [],
        },
      ],
    };
    const proposal = normalizeWorkflowMergeProposal({
      raw: {
        result: "merge",
        mergedGraph,
        nodeMappings: [
          {
            candidateNodeId: "assess-legitimacy",
            mergedNodeIds: ["assess-legitimacy"],
            disposition: "reuse",
          },
          {
            candidateNodeId: "terminal-fraud-rejected",
            mergedNodeIds: ["terminal-fraud-rejected"],
            disposition: "add",
          },
        ],
        transitionMappings: [
          {
            candidateTransitionId: "route-fraud-rejected",
            mergedTransitionIds: ["route-fraud-rejected"],
            disposition: "add",
          },
        ],
      },
      candidate,
      canonicalGraph: base.graph,
      skill: rejectedSkill,
    });

    expect(proposal.mergedGraph?.transitions).toHaveLength(2);
    expect(
      proposal.mergedGraph?.transitions.filter(
        (transition) =>
          transition.from === "assess-legitimacy" &&
          transition.type === "conditional",
      ),
    ).toHaveLength(2);
  });

  it("normalizes the unambiguous Call 5 condition alias to when", async () => {
    const base = await persistBaseGraph();
    const rejectedSkill = buildSkill("case-condition", "episode-condition");
    const candidate = buildRejectedCandidate(rejectedSkill.skillId);
    const baseDraft = toWorkflowGraphDraft(
      base.graph,
    ) as OysterWorkflowGraphDraftV2;
    const proposal = normalizeWorkflowMergeProposal({
      raw: {
        result: "merge",
        mergedGraph: {
          ...baseDraft,
          nodes: [
            ...baseDraft.nodes,
            {
              id: "terminal-fraud-rejected",
              type: "terminal",
              title: "Stop fraudulent inquiry",
              outcome: "rejected",
              summary: "The inquiry is rejected as fraudulent.",
              hints: [],
              sourceRefs: [],
            },
          ],
          transitions: [
            ...baseDraft.transitions,
            {
              id: "route-fraud-rejected",
              from: "assess-legitimacy",
              to: "terminal-fraud-rejected",
              type: "conditional",
              condition: "The inquiry shows fraud signals",
              sourceRefs: [],
            },
          ],
        },
        nodeMappings: [
          {
            candidateNodeId: "assess-legitimacy",
            mergedNodeIds: ["assess-legitimacy"],
            disposition: "reuse",
          },
          {
            candidateNodeId: "terminal-fraud-rejected",
            mergedNodeIds: ["terminal-fraud-rejected"],
            disposition: "add",
          },
        ],
        transitionMappings: [
          {
            candidateTransitionId: "route-fraud-rejected",
            mergedTransitionIds: ["route-fraud-rejected"],
            disposition: "add",
          },
        ],
      },
      candidate,
      canonicalGraph: base.graph,
      skill: rejectedSkill,
    });

    expect(proposal.mergedGraph?.transitions.at(-1)).toEqual(
      expect.objectContaining({
        type: "conditional",
        when: "The inquiry shows fraud signals",
      }),
    );
    expect(proposal.mergedGraph?.transitions.at(-1)).not.toHaveProperty(
      "condition",
    );
  });

  it("normalizes unambiguous single-target Call 5 mapping aliases", async () => {
    const base = await persistBaseGraph();
    const skill = buildSkill("case-mapping-alias", "episode-mapping-alias");
    const candidate = buildProceedCandidate(skill.skillId);
    const raw = buildNoChangeRaw(base.graph, candidate);
    const nodeMappings = candidate.nodes.map((node) => ({
      candidateNodeId: node.id,
      mergedNodeIds: [node.id],
      disposition: "reuse" as const,
    }));
    const transitionMappings = candidate.transitions.map((transition) => ({
      candidateTransitionId: transition.id,
      mergedTransitionIds: [transition.id],
      disposition: "reuse" as const,
    }));
    const proposal = normalizeWorkflowMergeProposal({
      raw: {
        ...raw,
        nodeMappings: nodeMappings.map((mapping) => ({
          candidateNodeId: mapping.candidateNodeId,
          targetNodeId: mapping.mergedNodeIds[0],
          disposition: mapping.disposition,
        })),
        transitionMappings: transitionMappings.map((mapping) => ({
          candidateTransitionId: mapping.candidateTransitionId,
          targetTransitionId: mapping.mergedTransitionIds[0],
          disposition: mapping.disposition,
        })),
      },
      candidate,
      canonicalGraph: base.graph,
      skill,
    });

    expect(proposal.nodeMappings).toEqual(nodeMappings);
    expect(proposal.transitionMappings).toEqual(transitionMappings);
  });

  it("accepts many-to-one and one-to-many mappings without node-to-edge absorption", async () => {
    const base = await persistBaseGraph();
    const skill = buildSkill("case-granularity", "episode-granularity");
    const candidate = buildGranularityCandidate(skill.skillId);
    const baseDraft = toWorkflowGraphDraft(
      base.graph,
    ) as OysterWorkflowGraphDraftV2;
    const proposal = normalizeWorkflowMergeProposal({
      raw: {
        result: "no_change",
        mergedGraph: baseDraft,
        nodeMappings: [
          {
            candidateNodeId: "inspect-sender",
            mergedNodeIds: ["assess-legitimacy"],
            disposition: "merge",
          },
          {
            candidateNodeId: "inspect-request",
            mergedNodeIds: ["assess-legitimacy"],
            disposition: "merge",
          },
          {
            candidateNodeId: "continue-case",
            mergedNodeIds: ["terminal-proceed"],
            disposition: "reuse",
          },
        ],
        transitionMappings: [
          {
            candidateTransitionId: "sender-to-request",
            mergedTransitionIds: ["route-legitimate"],
            disposition: "merge",
          },
          {
            candidateTransitionId: "request-to-continue",
            mergedTransitionIds: ["route-legitimate"],
            disposition: "merge",
          },
        ],
      },
      candidate,
      canonicalGraph: base.graph,
      skill,
    });
    expect(proposal.nodeMappings[0]?.disposition).toBe("merge");

    const splitCandidate = buildProceedCandidate("case-split");
    const splitProposal = normalizeWorkflowMergeProposal({
      raw: {
        result: "no_change",
        mergedGraph: baseDraft,
        nodeMappings: [
          {
            candidateNodeId: "assess-legitimacy",
            mergedNodeIds: ["assess-legitimacy", "terminal-proceed"],
            disposition: "split",
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
      },
      candidate: splitCandidate,
      canonicalGraph: base.graph,
      skill: buildSkill("case-split", "episode-split"),
    });
    expect(splitProposal.nodeMappings[0]?.mergedNodeIds).toHaveLength(2);
  });

  it("routes incompatible results without a graph and rejects stale apply", async () => {
    const base = await persistBaseGraph();
    const skill = buildSkill("case-other", "episode-other");
    const candidate = buildProceedCandidate(skill.skillId);
    const incompatible = normalizeWorkflowMergeProposal({
      raw: {
        result: "incompatible",
        mergedGraph: null,
        nodeMappings: [],
        transitionMappings: [],
      },
      candidate,
      canonicalGraph: base.graph,
      skill,
    });
    expect(incompatible.mergedGraph).toBeNull();

    const proposal = normalizeWorkflowMergeProposal({
      raw: buildNoChangeRaw(base.graph, candidate),
      candidate,
      canonicalGraph: base.graph,
      skill,
    });
    const staleGraph: OysterWorkflowGraph = {
      ...base.graph,
      revision: {
        ...base.graph.revision,
        revisionId: `${base.graph.workflowId}:revision:stale`,
      },
    };
    await expect(
      applyWorkflowMergeProposal({
        proposal,
        currentGraph: staleGraph,
        outDir: base.outDir,
      }),
    ).rejects.toThrow("stale");

    const wrongOutDir = await mkdtemp(join(tmpdir(), "workflow-merge-wrong-"));
    await expect(
      applyWorkflowMergeProposal({
        proposal,
        currentGraph: base.graph,
        outDir: wrongOutDir,
      }),
    ).rejects.toThrow("canonical revision changed");
  });

  it("validates deterministic proposal identity when loading stored data", async () => {
    const base = await persistBaseGraph();
    const skill = buildSkill("case-identity", "episode-identity");
    const candidate = buildProceedCandidate(skill.skillId);
    const proposal = normalizeWorkflowMergeProposal({
      raw: buildNoChangeRaw(base.graph, candidate),
      candidate,
      canonicalGraph: base.graph,
      skill,
    });

    expect(() =>
      parseWorkflowMergeProposal({
        ...proposal,
        proposalId: "proposal.tampered",
      }),
    ).toThrow("proposal id mismatch");
  });
});

async function persistBaseGraph(): Promise<{
  graph: OysterWorkflowGraph;
  outDir: string;
}> {
  const outDir = await mkdtemp(join(tmpdir(), "workflow-merge-"));
  const skill = buildSkill("case-base", "episode-base");
  const saved = await persistWorkflowGraphDraft({
    draft: buildWorkflowGraphDraftFromCandidate(
      buildProceedCandidate(skill.skillId),
      skill,
    ),
    outDir,
    now: new Date("2026-07-12T20:00:00.000Z"),
  });
  return { graph: await loadWorkflowGraph(saved.graphPath), outDir };
}

function buildNoChangeRaw(
  graph: OysterWorkflowGraph,
  candidate: CandidateWorkflow,
): Record<string, unknown> {
  return {
    result: "no_change",
    mergedGraph: toWorkflowGraphDraft(graph),
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
  };
}

function buildProceedCandidate(skillId: string): CandidateWorkflow {
  return {
    schemaVersion: "oyster-workflow-candidate-v2",
    candidateId: `candidate.${skillId}`,
    skillId,
    name: "Handle inbound opportunity",
    goal: "Decide whether an inbound opportunity should proceed",
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

function buildRejectedCandidate(skillId: string): CandidateWorkflow {
  return {
    ...buildProceedCandidate(skillId),
    nodes: [
      {
        id: "assess-legitimacy",
        type: "decision",
        title: "Assess legitimacy",
        decision: "Is the inquiry legitimate?",
        hints: [],
      },
      {
        id: "terminal-fraud-rejected",
        type: "terminal",
        title: "Stop fraudulent inquiry",
        outcome: "rejected",
        summary: "The inquiry is rejected as fraudulent.",
        hints: [],
      },
    ],
    transitions: [
      {
        id: "route-fraud-rejected",
        from: "assess-legitimacy",
        to: "terminal-fraud-rejected",
        type: "conditional",
        when: "The inquiry shows fraud signals",
      },
    ],
  };
}

function buildGranularityCandidate(skillId: string): CandidateWorkflow {
  return {
    ...buildProceedCandidate(skillId),
    entryNodeId: "inspect-sender",
    nodes: [
      {
        id: "inspect-sender",
        type: "decision",
        title: "Inspect sender",
        decision: "Does the sender appear legitimate?",
        hints: [],
      },
      {
        id: "inspect-request",
        type: "decision",
        title: "Inspect request",
        decision: "Is the request specific and credible?",
        hints: [],
      },
      {
        id: "continue-case",
        type: "terminal",
        title: "Continue case",
        outcome: "completed",
        summary: "Continue evaluating the inquiry.",
        hints: [],
      },
    ],
    transitions: [
      {
        id: "sender-to-request",
        from: "inspect-sender",
        to: "inspect-request",
        type: "conditional",
        when: "The sender appears legitimate",
      },
      {
        id: "request-to-continue",
        from: "inspect-request",
        to: "continue-case",
        type: "conditional",
        when: "The request is specific and credible",
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
      endTs: "2026-07-12T18:10:00.000Z",
    },
    description: "Handle one inbound opportunity.",
    goal: "Decide whether an inbound opportunity should proceed",
    whenToUse: ["A new inbound opportunity arrives"],
    whenNotToUse: [],
    inputs: [],
    outputs: [],
    prerequisites: [],
    steps: [
      {
        step: 1,
        instruction: "Assess whether the inquiry is legitimate.",
        intent: "Avoid pursuing fraudulent inbound requests.",
        operationApp: "Outlook",
        hints: [],
      },
    ],
    successCriteria: ["A legitimate inquiry is routed correctly"],
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
