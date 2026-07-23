import { describe, expect, it } from "vitest";
import type {
  LabSession,
  WorkflowCandidate,
} from "../../src/lab-api/api-contracts.js";
import { selectWorkflowCandidate } from "../src/demo-runtime";

describe("selectWorkflowCandidate", () => {
  it("defaults to the candidate with the smallest priority number", () => {
    const selected = selectWorkflowCandidate(
      buildCandidateSelectionSession({
        candidates: [
          buildCandidate("workflow-3", 3, 14),
          buildCandidate("workflow-1", 1, 301),
          buildCandidate("workflow-2", 2, 23),
        ],
      }),
    );

    expect(selected?.workflowId).toBe("workflow-1");
  });

  it("preserves an explicit candidate selection", () => {
    const selected = selectWorkflowCandidate(
      buildCandidateSelectionSession({
        selectedWorkflowId: "workflow-3",
        candidates: [
          buildCandidate("workflow-1", 1, 301),
          buildCandidate("workflow-3", 3, 14),
        ],
      }),
    );

    expect(selected?.workflowId).toBe("workflow-3");
  });

  it("uses the larger evidence slice to break equal-priority ties", () => {
    const selected = selectWorkflowCandidate(
      buildCandidateSelectionSession({
        candidates: [
          buildCandidate("workflow-short", 1, 14),
          buildCandidate("workflow-long", 1, 301),
        ],
      }),
    );

    expect(selected?.workflowId).toBe("workflow-long");
  });
});

/**
 * EN: Builds the minimal session state used by workflow candidate selection.
 * 中文: 构造 workflow 候选选择所需的最小 session 状态。
 * @param input candidate list and optional explicit selection.
 * @returns selection-compatible session state.
 */
function buildCandidateSelectionSession(input: {
  candidates: WorkflowCandidate[];
  selectedWorkflowId?: string | null;
}): Pick<LabSession, "selection" | "workflowDiscovery"> {
  return {
    selection: {
      workflowId: input.selectedWorkflowId ?? null,
      workflowPath: "/tmp/workflow-discovery.json",
    },
    workflowDiscovery: {
      latestPath: "/tmp/workflow-discovery.json",
      workflowCandidates: input.candidates,
    },
  };
}

/**
 * EN: Builds one workflow candidate with deterministic evidence boundaries.
 * 中文: 构造具有确定证据边界的 workflow 候选。
 * @param workflowId stable candidate identifier.
 * @param priority numeric priority where a smaller value ranks higher.
 * @param eventCount evidence event count used as the tie-breaker.
 * @returns workflow candidate fixture.
 */
function buildCandidate(
  workflowId: string,
  priority: number,
  eventCount: number,
): WorkflowCandidate {
  return {
    workflowId,
    name: workflowId,
    description: `${workflowId} description`,
    goal: `${workflowId} goal`,
    priority,
    startEventId: `${workflowId}-start`,
    endEventId: `${workflowId}-end`,
    startTs: "2026-07-21T01:00:00.000Z",
    endTs: "2026-07-21T01:01:00.000Z",
    eventCount,
  };
}
