import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyProductWorkflowGraphEdit,
  parseProductWorkflowGraphEditInput,
  persistProductWorkflowGraphEdit,
} from "../src/product/workflow-graph-edit.js";
import {
  listWorkflowGraphRevisions,
  loadWorkflowGraph,
  persistWorkflowGraphDraft,
} from "../src/skill/workflow-graph.js";
import type { OysterWorkflowGraphDraftV2 } from "../src/types/contracts.js";

describe("product workflow graph editing", () => {
  it("creates an immutable revision while preserving topology and provenance", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "product-graph-edit-"));
    const initial = await persistWorkflowGraphDraft({
      draft: buildGraphDraft(),
      outDir,
      now: new Date("2026-07-21T12:00:00.000Z"),
    });
    const beforeNode = initial.graph.nodes.find(
      (node) => node.id === "action-start",
    );
    const edited = await persistProductWorkflowGraphEdit({
      graphPath: initial.graphPath,
      edit: parseProductWorkflowGraphEditInput({
        expectedRevisionId: initial.graph.revision.revisionId,
        target: { kind: "node", id: "action-start", type: "action" },
        patch: {
          title: "Open and review the latest request",
          objective: "Review the latest request before branching.",
          act: ["Open the request.", "Confirm its current state."],
          operationApp: "Mail",
          hints: ["Use the newest message only."],
        },
      }),
      now: new Date("2026-07-21T12:05:00.000Z"),
    });

    expect(edited.graph.revision.number).toBe(2);
    expect(edited.graph.revision.previousRevisionId).toBe(
      initial.graph.revision.revisionId,
    );
    expect(edited.graph.transitions).toEqual(initial.graph.transitions);
    expect(
      edited.graph.nodes.find((node) => node.id === "action-start"),
    ).toEqual(
      expect.objectContaining({
        id: "action-start",
        type: "action",
        title: "Open and review the latest request",
        sourceRefs: beforeNode?.sourceRefs,
      }),
    );
    const versions = await listWorkflowGraphRevisions(initial.graphPath);
    expect(versions).toHaveLength(2);
    expect(versions.map(({ graph }) => graph.revision.number)).toEqual([2, 1]);
  });

  it("edits conditional, resume, and retry route fields without reconnecting routes", () => {
    const graph = materializedGraph();
    const conditional = parseProductWorkflowGraphEditInput({
      expectedRevisionId: graph.revision.revisionId,
      target: {
        kind: "transition",
        id: "route-review",
        type: "conditional",
      },
      patch: { when: "The request needs a manual review" },
    });
    const resume = parseProductWorkflowGraphEditInput({
      expectedRevisionId: graph.revision.revisionId,
      target: { kind: "transition", id: "route-resume", type: "resume" },
      patch: { when: "The approval is visible" },
    });
    const retry = parseProductWorkflowGraphEditInput({
      expectedRevisionId: graph.revision.revisionId,
      target: { kind: "transition", id: "route-retry", type: "retry" },
      patch: { when: "The send action times out", maxAttempts: 4 },
    });

    for (const input of [conditional, resume, retry]) {
      const draft = applyProductWorkflowGraphEdit(graph, input);
      const before = graph.transitions.find(
        (transition) => transition.id === input.target.id,
      );
      const after = draft.transitions.find(
        (transition) => transition.id === input.target.id,
      );
      expect(after).toEqual(expect.objectContaining(input.patch));
      expect(after).toEqual(
        expect.objectContaining({
          id: before?.id,
          type: before?.type,
          from: before?.from,
          to: before?.to,
          sourceRefs: before?.sourceRefs,
        }),
      );
    }
  });

  it("rejects stale saves and leaves the newer canonical revision untouched", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "product-graph-stale-"));
    const initial = await persistWorkflowGraphDraft({
      draft: buildGraphDraft(),
      outDir,
      now: new Date("2026-07-21T12:00:00.000Z"),
    });
    const firstEdit = parseProductWorkflowGraphEditInput({
      expectedRevisionId: initial.graph.revision.revisionId,
      target: { kind: "node", id: "decision-route", type: "decision" },
      patch: { title: "Choose the verified route" },
    });
    const saved = await persistProductWorkflowGraphEdit({
      graphPath: initial.graphPath,
      edit: firstEdit,
      now: new Date("2026-07-21T12:01:00.000Z"),
    });

    await expect(
      persistProductWorkflowGraphEdit({
        graphPath: initial.graphPath,
        edit: firstEdit,
        now: new Date("2026-07-21T12:02:00.000Z"),
      }),
    ).rejects.toThrow("Refresh the graph and try again");
    expect(
      (await loadWorkflowGraph(initial.graphPath)).revision.revisionId,
    ).toBe(saved.graph.revision.revisionId);
    expect(await listWorkflowGraphRevisions(initial.graphPath)).toHaveLength(2);
  });

  it("rejects empty content, invalid retry limits, default edits, and topology fields", () => {
    const revisionId = materializedGraph().revision.revisionId;
    const invalidInputs = [
      {
        expectedRevisionId: revisionId,
        target: { kind: "node", id: "action-start", type: "action" },
        patch: { title: " " },
      },
      {
        expectedRevisionId: revisionId,
        target: { kind: "transition", id: "route-retry", type: "retry" },
        patch: { maxAttempts: 0 },
      },
      {
        expectedRevisionId: revisionId,
        target: { kind: "transition", id: "route-next", type: "default" },
        patch: { when: "Always" },
      },
      {
        expectedRevisionId: revisionId,
        target: { kind: "node", id: "action-start", type: "action" },
        patch: { id: "rewritten-id" },
      },
      {
        expectedRevisionId: revisionId,
        target: {
          kind: "transition",
          id: "route-review",
          type: "conditional",
        },
        patch: { from: "rewritten-start" },
      },
    ];

    for (const input of invalidInputs) {
      expect(() => parseProductWorkflowGraphEditInput(input)).toThrow();
    }
  });
});

function materializedGraph() {
  return {
    ...buildGraphDraft(),
    revision: {
      number: 1,
      revisionId: "workflow-edit:rev-1:hash",
      previousRevisionId: null,
      contentHash: "hash",
      createdAt: "2026-07-21T12:00:00.000Z",
    },
  };
}

function buildGraphDraft(): OysterWorkflowGraphDraftV2 {
  const sourceRefs = [
    { kind: "skill-step" as const, ref: "skill:edit#step-1" },
  ];
  return {
    schemaVersion: "oyster-workflow-graph-v2",
    workflowId: "workflow-edit",
    name: "Editable workflow",
    goal: "Review, wait, and finish the request.",
    entryNodeId: "action-start",
    nodes: [
      {
        id: "action-start",
        type: "action",
        title: "Open the request",
        objective: "Review the request before branching.",
        act: ["Open the newest request."],
        operationApp: "Mail",
        hints: [],
        sourceRefs,
      },
      {
        id: "decision-route",
        type: "decision",
        title: "Choose a route",
        decision: "Does this request need approval?",
        hints: [],
        sourceRefs,
      },
      {
        id: "wait-approval",
        type: "wait",
        title: "Wait for approval",
        waitFor: "Approval from the owner",
        resumeCondition: "Approval is visible",
        hints: [],
        sourceRefs,
      },
      {
        id: "action-send",
        type: "action",
        title: "Send the result",
        objective: "Send the approved result.",
        act: ["Send the approved result."],
        operationApp: "Mail",
        hints: [],
        sourceRefs,
      },
      {
        id: "terminal-completed",
        type: "terminal",
        title: "Completed",
        outcome: "completed",
        summary: "The result was sent.",
        hints: [],
        sourceRefs,
      },
      {
        id: "terminal-rejected",
        type: "terminal",
        title: "Rejected",
        outcome: "rejected",
        summary: "The request was rejected.",
        hints: [],
        sourceRefs,
      },
    ],
    transitions: [
      {
        id: "route-next",
        from: "action-start",
        to: "decision-route",
        type: "default",
        sourceRefs,
      },
      {
        id: "route-review",
        from: "decision-route",
        to: "wait-approval",
        type: "conditional",
        when: "Approval is required",
        sourceRefs,
      },
      {
        id: "route-reject",
        from: "decision-route",
        to: "terminal-rejected",
        type: "conditional",
        when: "The request is invalid",
        sourceRefs,
      },
      {
        id: "route-resume",
        from: "wait-approval",
        to: "action-send",
        type: "resume",
        when: "Approval is visible",
        sourceRefs,
      },
      {
        id: "route-retry",
        from: "action-send",
        to: "action-send",
        type: "retry",
        when: "The send action times out",
        maxAttempts: 2,
        sourceRefs,
      },
      {
        id: "route-completed",
        from: "action-send",
        to: "terminal-completed",
        type: "default",
        sourceRefs,
      },
    ],
    source: {
      skillId: "skill-edit",
      skillSchemaVersion: "openclaw-skill-v1",
      skillGeneratedAt: "2026-07-21T11:00:00.000Z",
      promptSet: null,
      runId: "run-edit",
      runDir: "/tmp/run-edit",
      episodeId: "episode-edit",
    },
  };
}
