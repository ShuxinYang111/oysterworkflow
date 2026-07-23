import { describe, expect, it } from "vitest";
import { buildWorkflowGraphFromSkill } from "../src/skill/workflow-graph.js";
import {
  advanceWorkflowGraph,
  getAvailableWorkflowTransitions,
  startWorkflowGraph,
} from "../src/skill/workflow-graph-runtime.js";
import type {
  OpenClawSkill,
  OysterWorkflowGraph,
} from "../src/types/contracts.js";

describe("workflow graph runtime", () => {
  it("automatically advances a single default route to completion", () => {
    const graph = buildWorkflowGraphFromSkill(buildSkill());
    const started = startWorkflowGraph(graph);
    const afterFirst = advanceWorkflowGraph({
      graph,
      state: started,
      now: new Date("2026-07-12T12:00:00.000Z"),
    });
    const completed = advanceWorkflowGraph({
      graph,
      state: afterFirst,
      now: new Date("2026-07-12T12:01:00.000Z"),
    });

    expect(started.currentNodeId).toBe("step-001");
    expect(afterFirst.currentNodeId).toBe("step-002");
    expect(completed.currentNodeId).toBe("terminal-completed");
    expect(completed.status).toBe("completed");
    expect(completed.history).toHaveLength(2);
    expect(() => advanceWorkflowGraph({ graph, state: completed })).toThrow(
      "already reached terminal node",
    );
  });

  it("requires an explicit route choice at a decision node", () => {
    const graph = buildDecisionGraph();
    const started = startWorkflowGraph(graph);

    expect(getAvailableWorkflowTransitions(graph, started)).toHaveLength(2);
    expect(() => advanceWorkflowGraph({ graph, state: started })).toThrow(
      "transitionId is required",
    );
    const rejected = advanceWorkflowGraph({
      graph,
      state: started,
      transitionId: "route-fraud",
    });
    expect(rejected.currentNodeId).toBe("terminal-rejected");
    expect(rejected.status).toBe("rejected");
  });

  it("blocks on a partial decision until its one known conditional route is explicitly selected", () => {
    const graph = buildDecisionGraph();
    graph.nodes = graph.nodes.filter((node) => node.id !== "terminal-rejected");
    graph.transitions = graph.transitions.filter(
      (transition) => transition.id !== "route-fraud",
    );
    const started = startWorkflowGraph(graph);

    expect(getAvailableWorkflowTransitions(graph, started)).toHaveLength(1);
    expect(() => advanceWorkflowGraph({ graph, state: started })).toThrow(
      "transitionId is required",
    );
    const continued = advanceWorkflowGraph({
      graph,
      state: started,
      transitionId: "route-legitimate",
    });
    expect(continued.currentNodeId).toBe("step-002");
  });

  it("represents wait nodes as waiting until a resume route is selected", () => {
    const graph = buildWorkflowGraphFromSkill(buildSkill());
    graph.nodes[0] = {
      id: "step-001",
      type: "wait",
      title: "Wait for engineering",
      waitFor: "Engineering assessment",
      resumeCondition: "Assessment received",
      hints: [],
      sourceRefs: [],
    };
    graph.transitions[0] = {
      id: "resume-engineering",
      from: "step-001",
      to: "step-002",
      type: "resume",
      when: "Engineering has responded",
      sourceRefs: [],
    };

    const waiting = startWorkflowGraph(graph);
    expect(waiting.status).toBe("waiting");
    expect(() => advanceWorkflowGraph({ graph, state: waiting })).toThrow(
      "transitionId is required",
    );
    const resumed = advanceWorkflowGraph({
      graph,
      state: waiting,
      transitionId: "resume-engineering",
    });
    expect(resumed.status).toBe("running");
    expect(resumed.currentNodeId).toBe("step-002");
  });

  it("keeps an open wait blocked when no resume path has been observed", () => {
    const graph = buildWorkflowGraphFromSkill(buildSkill());
    graph.nodes = [
      {
        id: "wait-engineering",
        type: "wait",
        title: "Wait for engineering",
        waitFor: "Engineering assessment",
        resumeCondition: "Assessment received",
        hints: [],
        sourceRefs: [],
      },
    ];
    graph.entryNodeId = "wait-engineering";
    graph.transitions = [];

    const waiting = startWorkflowGraph(graph);
    expect(waiting.status).toBe("waiting");
    expect(() => advanceWorkflowGraph({ graph, state: waiting })).toThrow(
      "has no known resume transition yet",
    );
  });

  it("enforces retry maxAttempts across a loop", () => {
    const graph = buildWorkflowGraphFromSkill(buildSkill());
    graph.transitions = [
      {
        id: "next-assessment",
        from: "step-001",
        to: "step-002",
        type: "default",
        sourceRefs: [],
      },
      {
        id: "route-success",
        from: "step-002",
        to: "terminal-completed",
        type: "conditional",
        when: "Assessment succeeds",
        sourceRefs: [],
      },
      {
        id: "retry-assessment",
        from: "step-002",
        to: "step-001",
        type: "retry",
        when: "Assessment needs another attempt",
        maxAttempts: 2,
        sourceRefs: [],
      },
    ];

    let state = startWorkflowGraph(graph);
    state = advanceWorkflowGraph({ graph, state });
    state = advanceWorkflowGraph({
      graph,
      state,
      transitionId: "retry-assessment",
    });
    state = advanceWorkflowGraph({ graph, state });
    state = advanceWorkflowGraph({
      graph,
      state,
      transitionId: "retry-assessment",
    });
    state = advanceWorkflowGraph({ graph, state });

    expect(state.retryAttempts["retry-assessment"]).toBe(2);
    expect(() =>
      advanceWorkflowGraph({
        graph,
        state,
        transitionId: "retry-assessment",
      }),
    ).toThrow("exceeded maxAttempts=2");
  });
});

function buildDecisionGraph(): OysterWorkflowGraph {
  const graph = buildWorkflowGraphFromSkill(buildSkill());
  graph.nodes[0] = {
    id: "step-001",
    type: "decision",
    title: "Assess sender legitimacy",
    decision: "Is the sender and request legitimate?",
    hints: [],
    sourceRefs: [],
  };
  graph.nodes.push({
    id: "terminal-rejected",
    type: "terminal",
    title: "Reject fraudulent request",
    outcome: "rejected",
    summary: "The request is considered fraudulent.",
    hints: [],
    sourceRefs: [],
  });
  graph.transitions = [
    {
      id: "route-legitimate",
      from: "step-001",
      to: "step-002",
      type: "conditional",
      when: "The sender and request are legitimate",
      sourceRefs: [],
    },
    {
      id: "route-fraud",
      from: "step-001",
      to: "terminal-rejected",
      type: "conditional",
      when: "Fraud signals are present",
      sourceRefs: [],
    },
    {
      id: "route-complete",
      from: "step-002",
      to: "terminal-completed",
      type: "default",
      sourceRefs: [],
    },
  ];
  return graph;
}

function buildSkill(): OpenClawSkill {
  return {
    schemaVersion: "openclaw-skill-v1",
    promptSet: "specific-v25",
    skillId: "runtime-email-triage",
    skillName: "Handle inbound opportunity",
    generatedAt: "2026-07-12T11:00:00.000Z",
    source: {
      runId: "run-runtime",
      runDir: "/tmp/run-runtime",
      episodeId: "episode-runtime",
      startTs: "2026-07-12T10:00:00.000Z",
      endTs: "2026-07-12T10:10:00.000Z",
    },
    executionMode: "autonomous",
    description: "Review an inbound opportunity.",
    goal: "Decide whether and how to follow up.",
    whenToUse: ["An inbound opportunity arrives"],
    whenNotToUse: [],
    inputs: [],
    outputs: [],
    prerequisites: ["Mailbox access"],
    steps: [
      {
        step: 1,
        instruction: "Review the sender and request.",
        intent: "Assess legitimacy.",
        operationApp: "Mail",
        hints: [],
      },
      {
        step: 2,
        instruction: "Prepare the response.",
        intent: "Advance or close the request.",
        operationApp: "Mail",
        hints: [],
      },
    ],
    successCriteria: ["A next action is decided"],
    failureModes: [],
    fallback: [],
    examples: [],
    tags: [],
    assets: [],
    evidence: {
      totalEvents: 2,
      anchorEvents: 2,
      ocrEvents: 0,
      appsSeen: ["Mail"],
      windowsSeen: ["Inbox"],
    },
  };
}
