import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawSkill } from "../src/lab-api/contracts.js";
import type {
  ProductState,
  ProductWorkflow,
} from "../src/product/contracts.js";
import { buildWorkflowGraphFromSkill } from "../src/skill/workflow-graph.js";
import {
  CodexWorkflowServiceError,
  createCodexWorkflowService,
} from "../src/codex-workflow/service.js";

describe("Codex workflow service", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempRoots
        .splice(0)
        .map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  it("discovers executable workflows and reports their pinned revision", async () => {
    const fixture = await createWorkflowFixture();
    const service = createCodexWorkflowService({
      runsRoot: fixture.runsRoot,
      readProductState: async () => fixture.state,
    });

    const search = await service.searchWorkflows({ query: "sales" });
    const fetched = await service.fetchWorkflow(fixture.workflow.id);

    expect(search).toMatchObject({
      matchMode: "query",
      total: 1,
      results: [
        {
          id: fixture.workflow.id,
          hasCanonicalGraph: true,
          revisionId: fixture.graph.revision.revisionId,
        },
      ],
    });
    expect(fetched.graphIssues).toEqual([]);
    expect(fetched.canonicalGraph?.revision).toEqual(fixture.graph.revision);

    await expect(
      service.searchWorkflows({ query: "处理中文销售邮件" }),
    ).resolves.toMatchObject({
      query: "处理中文销售邮件",
      matchMode: "fallback",
      total: 1,
      results: [{ id: fixture.workflow.id, hasCanonicalGraph: true }],
    });
  });

  it("persists a revision-pinned run and validates every transition", async () => {
    const fixture = await createWorkflowFixture();
    const runId = "codex-run-00000000-0000-4000-8000-000000000001";
    const service = createCodexWorkflowService({
      runsRoot: fixture.runsRoot,
      readProductState: async () => fixture.state,
      createId: () => runId,
      now: () => new Date("2026-07-14T18:00:00.000Z"),
    });

    const prepared = await service.prepareRun({
      workflowId: fixture.workflow.id,
      expectedRevisionId: fixture.graph.revision.revisionId,
      inputs: { mailbox: "sales@example.com" },
    });
    expect(prepared).toMatchObject({
      run: {
        id: runId,
        executor: "mcp-host",
        status: "running",
        revisionId: fixture.graph.revision.revisionId,
      },
      currentNode: { id: "step-001", type: "action" },
      nextAction: "execute_current_node",
    });

    const advanced = await service.advanceRun(runId, {
      currentNodeId: "step-001",
      summary: "Reviewed the inbound sales request and prepared a draft.",
      evidence: [
        {
          kind: "observation",
          value: "Sender and request were reviewed in Outlook.",
        },
      ],
    });
    expect(advanced).toMatchObject({
      run: {
        status: "completed",
        stepResults: [
          {
            nodeId: "step-001",
            transitionId: "transition-step-001-to-terminal-completed",
          },
        ],
      },
      currentNode: { id: "terminal-completed" },
      availableTransitions: [],
      nextAction: "workflow_finished",
    });

    await access(
      join(fixture.runsRoot, "codex-hosted-workflow-runs", `${runId}.json`),
    );
    const reloaded = createCodexWorkflowService({
      runsRoot: fixture.runsRoot,
      readProductState: async () => fixture.state,
    });
    await expect(reloaded.getRun(runId)).resolves.toMatchObject({
      run: {
        status: "completed",
        revisionId: fixture.graph.revision.revisionId,
      },
    });
  });

  it("rejects stale revisions and stale current-node updates", async () => {
    const fixture = await createWorkflowFixture();
    const runId = "codex-run-00000000-0000-4000-8000-000000000002";
    const service = createCodexWorkflowService({
      runsRoot: fixture.runsRoot,
      readProductState: async () => fixture.state,
      createId: () => runId,
    });

    await expect(
      service.prepareRun({
        workflowId: fixture.workflow.id,
        expectedRevisionId: "stale-revision",
      }),
    ).rejects.toMatchObject({
      code: "workflow_revision_changed",
      status: 409,
    } satisfies Partial<CodexWorkflowServiceError>);

    await service.prepareRun({ workflowId: fixture.workflow.id });
    await expect(
      service.advanceRun(runId, {
        currentNodeId: "wrong-node",
        summary: "This update must not be accepted.",
      }),
    ).rejects.toMatchObject({
      code: "workflow_node_changed",
      status: 409,
    } satisfies Partial<CodexWorkflowServiceError>);
  });

  it("cancels idempotently and prevents later transitions", async () => {
    const fixture = await createWorkflowFixture();
    const runId = "codex-run-00000000-0000-4000-8000-000000000003";
    const service = createCodexWorkflowService({
      runsRoot: fixture.runsRoot,
      readProductState: async () => fixture.state,
      createId: () => runId,
    });
    await service.prepareRun({ workflowId: fixture.workflow.id });

    const cancelled = await service.cancelRun(runId);
    const cancelledAgain = await service.cancelRun(runId);

    expect(cancelled).toMatchObject({
      run: { status: "cancelled" },
      nextAction: "workflow_cancelled",
      availableTransitions: [],
    });
    expect(cancelledAgain.run.cancelledAt).toBe(cancelled.run.cancelledAt);
    await expect(
      service.advanceRun(runId, {
        currentNodeId: "step-001",
        summary: "Must not advance after cancellation.",
      }),
    ).rejects.toMatchObject({ code: "workflow_run_cancelled", status: 409 });
  });

  it("keeps generated workflows without a canonical graph non-executable", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "oyster-codex-no-graph-"));
    tempRoots.push(tempRoot);
    const workflow = buildProductWorkflow(null);
    const state = { workflows: [workflow] } as unknown as ProductState;
    const service = createCodexWorkflowService({
      runsRoot: join(tempRoot, "runs"),
      readProductState: async () => state,
    });

    await expect(
      service.getWorkflowReadiness(workflow.id),
    ).resolves.toMatchObject({
      ready: false,
      revisionId: null,
      issues: [{ code: "canonical_graph_missing" }],
    });
    await expect(
      service.prepareRun({ workflowId: workflow.id }),
    ).rejects.toMatchObject({
      code: "workflow_graph_unavailable",
      status: 409,
    });
  });

  async function createWorkflowFixture() {
    const tempRoot = await mkdtemp(join(tmpdir(), "oyster-codex-workflow-"));
    tempRoots.push(tempRoot);
    const artifactPath = join(tempRoot, "workflow-artifacts");
    const runsRoot = join(tempRoot, "runs");
    await mkdir(artifactPath, { recursive: true });
    const graph = buildWorkflowGraphFromSkill(buildSkill(), {
      now: new Date("2026-07-14T17:00:00.000Z"),
    });
    await writeFile(
      join(artifactPath, "workflow.json"),
      `${JSON.stringify(graph, null, 2)}\n`,
      "utf8",
    );
    const workflow = buildProductWorkflow(artifactPath);
    const state = { workflows: [workflow] } as unknown as ProductState;
    return { tempRoot, artifactPath, runsRoot, graph, workflow, state };
  }
});

function buildProductWorkflow(artifactPath: string | null): ProductWorkflow {
  return {
    id: "workflow.sales-inquiry",
    title: "筛选销售询盘并准备回复 / Qualify sales inquiries",
    description: "Review inbound sales inquiries and prepare a response draft.",
    status: "Generated",
    sourceType: "runtime",
    sourceText: null,
    confidence: 0.94,
    apps: ["Outlook"],
    stats: {
      uiEvents: 12,
      ocrObservations: 8,
      voiceNotes: 0,
      duration: "4m",
      decisionPoints: 1,
    },
    detectedAt: "2026-07-14T16:00:00.000Z",
    artifactPath,
    createdAt: "2026-07-14T16:00:00.000Z",
    updatedAt: "2026-07-14T17:00:00.000Z",
  };
}

function buildSkill(): OpenClawSkill {
  return {
    schemaVersion: "openclaw-skill-v1",
    promptSet: "specific-v32",
    skillId: "sales-inquiry",
    skillName: "筛选销售询盘并准备回复",
    generatedAt: "2026-07-14T16:30:00.000Z",
    source: {
      runId: "run-sales",
      runDir: "/tmp/run-sales",
      episodeId: "episode-sales",
      startTs: "2026-07-14T16:00:00.000Z",
      endTs: "2026-07-14T16:10:00.000Z",
    },
    executionMode: "autonomous",
    description: "Review an inbound sales inquiry and prepare a reply draft.",
    goal: "Qualify the inquiry and prepare a useful draft without sending it.",
    whenToUse: ["A new sales inquiry needs review"],
    whenNotToUse: [],
    inputs: [],
    outputs: [],
    prerequisites: ["Authorized Outlook access"],
    steps: [
      {
        step: 1,
        instruction: "Review the inquiry and prepare a response draft.",
        intent: "Qualify the inquiry without sending the draft.",
        operationApp: "Outlook",
        hints: ["Keep the draft unsent for review."],
      },
    ],
    successCriteria: [
      "The inquiry is qualified and a draft is ready for review",
    ],
    failureModes: [],
    fallback: [],
    examples: [],
    tags: ["sales", "email"],
    assets: [],
    evidence: {
      totalEvents: 20,
      anchorEvents: 4,
      ocrEvents: 8,
      appsSeen: ["Outlook"],
      windowsSeen: ["Inbox"],
    },
  };
}
