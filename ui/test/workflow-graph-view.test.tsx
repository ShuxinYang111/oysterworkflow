import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DemoWorkflowSummary } from "../src/demo-runtime";
import { RuntimeRequestError } from "../src/runtime-request";
import {
  WorkflowGraphPanel,
  WorkflowRouteLabel,
  workflowRouteVisualStyle,
} from "../src/workflow-graph-view";

const graphRuntimeMock = vi.hoisted(() => ({
  fetchProductWorkflowGraph: vi.fn(),
  updateProductWorkflowGraph: vi.fn(),
}));

vi.mock("../src/product-runtime", () => graphRuntimeMock);

describe("WorkflowGraphPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    graphRuntimeMock.fetchProductWorkflowGraph.mockReset();
    graphRuntimeMock.updateProductWorkflowGraph.mockReset();
  });

  it("selects a route from its visible keyboard-accessible label", () => {
    const onSelect = vi.fn();
    render(
      <WorkflowRouteLabel
        id="route-legitimate"
        label="The request is legitimate"
        routeType="conditional"
        selected={false}
        position={{ x: 120, y: 80 }}
        onSelect={onSelect}
      />,
    );

    const label = screen.getByRole("button", {
      name: "The request is legitimate",
    });
    expect(label).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(label);
    expect(onSelect).toHaveBeenCalledWith("route-legitimate");
  });

  it("renders a canonical graph and edits a selected route as a new revision", async () => {
    const initialBundle = {
      workflowId: "workflow.sales",
      canonicalGraph: {
        schemaVersion: "oyster-workflow-graph-v2",
        workflowId: "workflow.sales",
        name: "Handle inbound opportunity",
        goal: "Decide whether the opportunity should proceed",
        entryNodeId: "assess-legitimacy",
        references: [
          {
            id: "reference:sales:sender-profile",
            name: "Sender profile",
            value: "https://example.com/sender-profile",
            notes: "Use this profile while assessing legitimacy.",
          },
        ],
        nodes: [
          {
            id: "assess-legitimacy",
            type: "decision",
            title: "Assess legitimacy",
            decision: "Is the request legitimate?",
            hints: ["Check the sender domain and official website"],
            referenceRefs: ["reference:sales:sender-profile"],
            sourceRefs: [
              { kind: "episode", ref: "episode:run:case-1", label: "Case 1" },
            ],
          },
          {
            id: "continue-evaluation",
            type: "terminal",
            title: "Continue evaluation",
            outcome: "completed",
            summary: "The request advances to evaluation.",
            hints: [],
            sourceRefs: [],
          },
        ],
        transitions: [
          {
            id: "route-legitimate",
            from: "assess-legitimacy",
            to: "continue-evaluation",
            type: "conditional",
            when: "The request is legitimate",
            sourceRefs: [],
          },
        ],
        source: {
          skillId: "sales",
          skillSchemaVersion: "openclaw-skill-v1",
          skillGeneratedAt: "2026-07-12T18:00:00.000Z",
          promptSet: "specific-v29",
          runId: "run",
          runDir: "/runs/run",
          episodeId: "case-1",
        },
        revision: {
          number: 2,
          revisionId: "workflow.sales:revision:2",
          previousRevisionId: "workflow.sales:revision:1",
          contentHash: "a".repeat(64),
          createdAt: "2026-07-12T19:00:00.000Z",
        },
      },
      mergeBaseGraph: null,
      candidate: null,
      mergeProposal: null,
      mergeStatus: null,
      paths: {
        graphPath: "/runs/run/workflow.json",
        mergeBaseGraphPath: null,
        candidatePath: null,
        mergeProposalPath: null,
      },
      errors: [],
    };
    graphRuntimeMock.fetchProductWorkflowGraph.mockResolvedValueOnce(
      initialBundle,
    );
    graphRuntimeMock.updateProductWorkflowGraph.mockResolvedValueOnce({
      state: {},
      workflowId: "workflow.sales",
      graphPath: "/runs/run/workflow.json",
      canonicalGraph: {
        ...initialBundle.canonicalGraph,
        transitions: initialBundle.canonicalGraph.transitions.map(
          (transition) => ({
            ...transition,
            when: "The request is verified and legitimate",
          }),
        ),
        revision: {
          number: 3,
          revisionId: "workflow.sales:revision:3",
          previousRevisionId: "workflow.sales:revision:2",
          contentHash: "b".repeat(64),
          createdAt: "2026-07-12T19:05:00.000Z",
        },
      },
    });

    render(
      <WorkflowGraphPanel
        workflow={buildWorkflow()}
        language="en"
        mode="full"
      />,
    );

    expect(await screen.findByText("Workflow map")).toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(screen.queryByText("Canonical")).not.toBeInTheDocument();
    expect(screen.queryByText("New case")).not.toBeInTheDocument();
    expect(screen.queryByText("Merge proposal")).not.toBeInTheDocument();
    expect(
      (await screen.findAllByText("Assess legitimacy"))[0],
    ).toBeInTheDocument();
    expect(screen.getByText("References")).toBeInTheDocument();
    expect(screen.getByText("Sender profile")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /sender-profile.*Open reference/i }),
    ).toHaveAttribute("href", "https://example.com/sender-profile");
    fireEvent.click(
      screen.getByRole("button", {
        name: /Conditional.*The request is legitimate/,
      }),
    );
    expect(screen.queryByText("References")).not.toBeInTheDocument();
    expect(screen.queryByText("Selected route")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Condition"), {
      target: { value: "The request is verified and legitimate" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save new version" }));

    await waitFor(() =>
      expect(graphRuntimeMock.updateProductWorkflowGraph).toHaveBeenCalledWith(
        "workflow.sales",
        {
          expectedRevisionId: "workflow.sales:revision:2",
          target: {
            kind: "transition",
            id: "route-legitimate",
            type: "conditional",
          },
          patch: { when: "The request is verified and legitimate" },
        },
      ),
    );
    expect(screen.queryByText("Revision 3")).not.toBeInTheDocument();
    expect(
      screen.getAllByText("The request is verified and legitimate"),
    ).toHaveLength(2);
  });

  it("does not convert legacy Steps into a fake graph", async () => {
    graphRuntimeMock.fetchProductWorkflowGraph.mockResolvedValueOnce({
      workflowId: "workflow.sales",
      canonicalGraph: null,
      mergeBaseGraph: null,
      candidate: null,
      mergeProposal: null,
      mergeStatus: null,
      paths: {
        graphPath: null,
        mergeBaseGraphPath: null,
        candidatePath: null,
        mergeProposalPath: null,
      },
      errors: [],
    });
    render(<WorkflowGraphPanel workflow={buildWorkflow()} language="zh" />);

    expect(
      await screen.findByText("此旧版工作流暂无可编辑 Graph。"),
    ).toBeVisible();
    expect(screen.queryByText("Read the inquiry")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Decide whether to proceed"),
    ).not.toBeInTheDocument();
  });

  it("keeps the preview graph-only without mounting the editor", async () => {
    graphRuntimeMock.fetchProductWorkflowGraph.mockResolvedValueOnce({
      workflowId: "workflow.sales",
      canonicalGraph: buildSimpleGraph(1, null),
      mergeBaseGraph: null,
      candidate: null,
      mergeProposal: null,
      mergeStatus: null,
      paths: {
        graphPath: "/runs/run/workflow.json",
        mergeBaseGraphPath: null,
        candidatePath: null,
        mergeProposalPath: null,
      },
      errors: [],
    });

    const { container } = render(
      <WorkflowGraphPanel workflow={buildWorkflow()} language="en" />,
    );

    await screen.findByText("Workflow map");
    expect(container.querySelector(".workflow-graph-inspector")).toBeNull();
    expect(screen.queryByText("Selected route")).not.toBeInTheDocument();
    expect(screen.queryByText(/^Revision /u)).not.toBeInTheDocument();
    expect(screen.queryByText("Sources")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  });

  it("gives every route an explicit visible line style", () => {
    expect(workflowRouteVisualStyle("default")).toEqual({
      stroke: "#668f8a",
      strokeWidth: 1.9,
    });
    expect(workflowRouteVisualStyle("retry")).toEqual({
      stroke: "#a84f4a",
      strokeWidth: 1.9,
      strokeDasharray: "5 4",
    });
    expect(workflowRouteVisualStyle("conditional", true)).toEqual({
      stroke: "#007b78",
      strokeWidth: 2.8,
    });
  });

  it("keeps unsaved node content after a save failure", async () => {
    graphRuntimeMock.fetchProductWorkflowGraph.mockResolvedValueOnce({
      workflowId: "workflow.sales",
      canonicalGraph: buildSimpleGraph(1, null),
      mergeBaseGraph: null,
      candidate: null,
      mergeProposal: null,
      mergeStatus: null,
      paths: {
        graphPath: "/runs/run/workflow.json",
        mergeBaseGraphPath: null,
        candidatePath: null,
        mergeProposalPath: null,
      },
      errors: [],
    });
    graphRuntimeMock.updateProductWorkflowGraph.mockRejectedValueOnce(
      new RuntimeRequestError(
        "Workflow graph edit is stale. / 工作流图版本已更新，请刷新后重新编辑。",
        409,
      ),
    );
    render(
      <WorkflowGraphPanel
        workflow={buildWorkflow()}
        language="en"
        mode="full"
      />,
    );

    await screen.findByText("Workflow map");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Complete with verified evidence" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save new version" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Workflow graph edit is stale",
    );
    expect(screen.getByLabelText("Title")).toHaveValue(
      "Complete with verified evidence",
    );
    expect(
      screen.getByText("Refresh the graph, then edit the latest version."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Save new version" }),
    ).toBeEnabled();
  });

  it("does not show revision refresh guidance for a generic save failure", async () => {
    graphRuntimeMock.fetchProductWorkflowGraph.mockResolvedValueOnce({
      workflowId: "workflow.sales",
      canonicalGraph: buildSimpleGraph(1, null),
      mergeBaseGraph: null,
      candidate: null,
      mergeProposal: null,
      mergeStatus: null,
      paths: {
        graphPath: "/runs/run/workflow.json",
        mergeBaseGraphPath: null,
        candidatePath: null,
        mergeProposalPath: null,
      },
      errors: [],
    });
    graphRuntimeMock.updateProductWorkflowGraph.mockRejectedValueOnce(
      new RuntimeRequestError(
        "The local Runtime could not save this edit. / 本地 Runtime 无法保存此次编辑。",
        500,
      ),
    );
    render(
      <WorkflowGraphPanel
        workflow={buildWorkflow()}
        language="en"
        mode="full"
      />,
    );

    await screen.findByText("Workflow map");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Complete after retry" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save new version" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The local Runtime could not save this edit.",
    );
    expect(
      screen.queryByText("Refresh the graph, then edit the latest version."),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Title")).toHaveValue("Complete after retry");
  });

  it("keeps default routes unlabeled and out of the inspector", async () => {
    graphRuntimeMock.fetchProductWorkflowGraph.mockResolvedValueOnce({
      workflowId: "workflow.sales",
      canonicalGraph: buildDefaultRouteGraph(),
      mergeBaseGraph: null,
      candidate: null,
      mergeProposal: null,
      mergeStatus: null,
      paths: {
        graphPath: "/runs/run/workflow.json",
        mergeBaseGraphPath: null,
        candidatePath: null,
        mergeProposalPath: null,
      },
      errors: [],
    });
    render(
      <WorkflowGraphPanel
        workflow={buildWorkflow()}
        language="en"
        mode="full"
      />,
    );

    await screen.findByText("Workflow map");
    expect(
      screen.queryByRole("button", { name: /Default.*Next/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Selected route")).not.toBeInTheDocument();
    expect(screen.queryByText("Next")).not.toBeInTheDocument();
    expect(
      screen.queryByText("This route type has no editable content."),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
  });

  it("keeps proposal review concepts out of the current workflow map", async () => {
    const baseGraph = buildSimpleGraph(1, null);
    graphRuntimeMock.fetchProductWorkflowGraph.mockResolvedValueOnce({
      workflowId: "workflow.source",
      canonicalGraph: baseGraph,
      mergeBaseGraph: baseGraph,
      candidate: null,
      mergeProposal: {
        schemaVersion: "oyster-workflow-merge-proposal-v1",
        proposalId: "proposal.workflow.sales.test",
        candidateId: "candidate.source",
        baseWorkflowId: baseGraph.workflowId,
        baseRevisionId: baseGraph.revision.revisionId,
        result: "merge",
        mergedGraph: {
          ...baseGraph,
          revision: undefined,
        },
        nodeMappings: [],
        transitionMappings: [],
        proposalHash: "a".repeat(64),
        createdAt: "2026-07-12T20:05:00.000Z",
      },
      mergeStatus: "ready",
      paths: {
        graphPath: null,
        mergeBaseGraphPath: "/runs/base/workflow.json",
        candidatePath: null,
        mergeProposalPath: "/runs/source/workflow-merge-proposal.json",
      },
      errors: [],
    });

    render(
      <WorkflowGraphPanel
        workflow={{ ...buildWorkflow(), id: "workflow.source" }}
        language="zh"
        mode="full"
      />,
    );

    expect(await screen.findByText("工作流图")).toBeVisible();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(screen.queryByText("规范图")).not.toBeInTheDocument();
    expect(screen.queryByText("新案例")).not.toBeInTheDocument();
    expect(screen.queryByText("合并提案")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "接受合并" }),
    ).not.toBeInTheDocument();
  });
});

function buildSimpleGraph(number: number, previousRevisionId: string | null) {
  const revisionId = `workflow.sales:revision:${number}`;
  return {
    schemaVersion: "oyster-workflow-graph-v2",
    workflowId: "workflow.sales",
    name: "Handle inbound opportunity",
    goal: "Decide whether the opportunity should proceed",
    entryNodeId: "complete",
    nodes: [
      {
        id: "complete",
        type: "terminal",
        title: "Complete",
        outcome: "completed",
        summary: "The workflow is complete.",
        hints: [],
        sourceRefs: [],
      },
    ],
    transitions: [],
    source: {
      skillId: "sales",
      skillSchemaVersion: "openclaw-skill-v1",
      skillGeneratedAt: "2026-07-12T18:00:00.000Z",
      promptSet: "specific-v33",
      runId: "run",
      runDir: "/runs/run",
      episodeId: "case-1",
    },
    revision: {
      number,
      revisionId,
      previousRevisionId,
      contentHash: "a".repeat(64),
      createdAt: "2026-07-12T20:00:00.000Z",
    },
  } as const;
}

function buildDefaultRouteGraph() {
  return {
    ...buildSimpleGraph(1, null),
    entryNodeId: "review",
    nodes: [
      {
        id: "review",
        type: "action",
        title: "Review the request",
        objective: "Review the latest request.",
        act: ["Open the request."],
        operationApp: "Mail",
        hints: [],
        sourceRefs: [],
      },
      {
        id: "complete",
        type: "terminal",
        title: "Complete",
        outcome: "completed",
        summary: "The workflow is complete.",
        hints: [],
        sourceRefs: [],
      },
    ],
    transitions: [
      {
        id: "route-next",
        from: "review",
        to: "complete",
        type: "default",
        sourceRefs: [],
      },
    ],
  } as const;
}

function buildWorkflow(): DemoWorkflowSummary {
  return {
    id: "workflow.sales",
    title: "Handle inbound opportunity",
    code: "WF-1000",
    status: "Installable",
    tone: "ready",
    confidence: null,
    description: "Decide whether the opportunity should proceed",
    icon: "target",
    detectedAt: "Detected today",
    stats: {
      uiEvents: 10,
      ocrObservations: 20,
      voiceNotes: 1,
      duration: "05:00",
      decisionPoints: 1,
    },
    steps: [
      {
        id: "step-1",
        title: "Read the inquiry",
        type: "Action",
        app: "Outlook",
        body: "Understand the request",
        hints: "Check the sender",
        assets: [],
        approval: "None",
      },
      {
        id: "step-2",
        title: "Decide whether to proceed",
        type: "Decision",
        app: "Outlook",
        body: "Choose the next action",
        hints: "Use the available evidence",
        assets: [],
        approval: "None",
      },
    ],
    connectedApps: ["Outlook"],
    phase: "generated",
    sessionId: null,
    workflowId: "workflow.sales",
    workflowPath: null,
    skillPath: null,
    sourceType: "demo",
    skill: null,
    candidate: null,
  };
}
