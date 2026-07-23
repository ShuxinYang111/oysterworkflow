import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { ProductState, ProductWorkflow } from "../product/contracts.js";
import { readProductWorkflowGraph } from "../product/workflow-graph-view.js";
import {
  advanceWorkflowGraph,
  getAvailableWorkflowTransitions,
  startWorkflowGraph,
  type WorkflowGraphRunState,
} from "../skill/workflow-graph-runtime.js";
import { parseWorkflowGraph } from "../skill/workflow-graph.js";
import type {
  OysterWorkflowGraph,
  WorkflowGraphNode,
} from "../types/contracts.js";
import {
  CODEX_WORKFLOW_RUN_SCHEMA_VERSION,
  type AdvanceCodexWorkflowRunInput,
  type CodexWorkflowFetchResponse,
  type CodexWorkflowNextAction,
  type CodexWorkflowReadiness,
  type CodexWorkflowRunRecord,
  type CodexWorkflowRunView,
  type CodexWorkflowSearchResponse,
  type PrepareCodexWorkflowRunInput,
} from "./contracts.js";

const CODEX_WORKFLOW_RUNS_DIRECTORY = "codex-hosted-workflow-runs";
const CODEX_WORKFLOW_RUN_ID_PATTERN = /^(?:mcp|codex)-run-[0-9a-f-]{36}$/u;

const workflowEvidenceSchema = z.object({
  kind: z.enum(["observation", "url", "artifact", "receipt"]),
  value: z.string().min(1),
  label: z.string().min(1).optional(),
});

const graphRunStateSchema = z.object({
  workflowId: z.string().min(1),
  revisionId: z.string().min(1),
  currentNodeId: z.string().min(1),
  status: z.enum([
    "running",
    "waiting",
    "completed",
    "stopped",
    "rejected",
    "failed",
  ]),
  retryAttempts: z.record(z.string(), z.number().int().nonnegative()),
  history: z.array(
    z.object({
      transitionId: z.string().min(1),
      from: z.string().min(1),
      to: z.string().min(1),
      type: z.enum(["default", "conditional", "retry", "resume"]),
      retryAttempt: z.number().int().positive().optional(),
      traversedAt: z.string().min(1),
    }),
  ),
});

const persistedRunSchema = z.object({
  schemaVersion: z.literal(CODEX_WORKFLOW_RUN_SCHEMA_VERSION),
  id: z.string().regex(CODEX_WORKFLOW_RUN_ID_PATTERN),
  workflowId: z.string().min(1),
  workflowTitle: z.string().min(1),
  revisionId: z.string().min(1),
  executor: z.enum(["mcp-host", "codex-app"]),
  status: z.enum([
    "running",
    "waiting",
    "completed",
    "stopped",
    "rejected",
    "failed",
    "cancelled",
  ]),
  inputs: z.record(z.string(), z.unknown()),
  pinnedGraph: z.unknown(),
  graphState: graphRunStateSchema,
  stepResults: z.array(
    z.object({
      nodeId: z.string().min(1),
      transitionId: z.string().min(1),
      summary: z.string().min(1),
      evidence: z.array(workflowEvidenceSchema),
      completedAt: z.string().min(1),
    }),
  ),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  cancelledAt: z.string().min(1).nullable(),
});

export class CodexWorkflowServiceError extends Error {
  public readonly status: 400 | 404 | 409;
  public readonly code: string;

  public constructor(input: {
    status: 400 | 404 | 409;
    code: string;
    message: string;
  }) {
    super(input.message);
    this.name = "CodexWorkflowServiceError";
    this.status = input.status;
    this.code = input.code;
  }
}

export interface CodexWorkflowService {
  searchWorkflows: (input?: {
    query?: string;
    limit?: number;
  }) => Promise<CodexWorkflowSearchResponse>;
  fetchWorkflow: (workflowId: string) => Promise<CodexWorkflowFetchResponse>;
  getWorkflowReadiness: (workflowId: string) => Promise<CodexWorkflowReadiness>;
  prepareRun: (
    input: PrepareCodexWorkflowRunInput,
  ) => Promise<CodexWorkflowRunView>;
  getRun: (runId: string) => Promise<CodexWorkflowRunView>;
  advanceRun: (
    runId: string,
    input: AdvanceCodexWorkflowRunInput,
  ) => Promise<CodexWorkflowRunView>;
  cancelRun: (runId: string) => Promise<CodexWorkflowRunView>;
}

export interface CreateCodexWorkflowServiceInput {
  runsRoot: string;
  readProductState: () => Promise<ProductState>;
  now?: () => Date;
  createId?: () => string;
}

/**
 * CN: 创建由当前 MCP Host 托管动作、由 OysterWorkflow Runtime 强制图状态的运行服务。
 * EN: Creates the service where the current MCP host performs actions and OysterWorkflow enforces graph state.
 * @param input persistence root, product-state reader, and deterministic test hooks.
 * @returns workflow discovery and revision-pinned run operations.
 */
export function createCodexWorkflowService(
  input: CreateCodexWorkflowServiceInput,
): CodexWorkflowService {
  const runsDirectory = resolve(input.runsRoot, CODEX_WORKFLOW_RUNS_DIRECTORY);
  const now = input.now ?? (() => new Date());
  const createId = input.createId ?? (() => `mcp-run-${randomUUID()}`);
  let updateQueue: Promise<void> = Promise.resolve();

  async function searchWorkflows(
    options: { query?: string; limit?: number } = {},
  ): Promise<CodexWorkflowSearchResponse> {
    const query = options.query?.trim() ?? "";
    const normalizedQuery = query.toLocaleLowerCase();
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
    const state = await input.readProductState();
    const directMatches = state.workflows.filter((workflow) => {
      if (!normalizedQuery) return true;
      const haystack = [
        workflow.id,
        workflow.title,
        workflow.description,
        ...workflow.apps,
      ]
        .join("\n")
        .toLocaleLowerCase();
      return haystack.includes(normalizedQuery);
    });
    const matchMode = !normalizedQuery
      ? "all"
      : directMatches.length > 0
        ? "query"
        : "fallback";
    const matches = matchMode === "fallback" ? state.workflows : directMatches;
    const selected = matches.slice(0, limit);
    const results = await Promise.all(
      selected.map(async (workflow) => {
        const readiness = await buildReadiness(workflow);
        return {
          id: workflow.id,
          title: workflow.title,
          description: workflow.description,
          status: workflow.status,
          apps: [...workflow.apps],
          updatedAt: workflow.updatedAt,
          hasCanonicalGraph: readiness.ready,
          revisionId: readiness.revisionId,
          graphIssues: readiness.issues.map((issue) => issue.message),
        };
      }),
    );
    return { query, matchMode, total: matches.length, results };
  }

  async function fetchWorkflow(
    workflowId: string,
  ): Promise<CodexWorkflowFetchResponse> {
    const workflow = await requireWorkflow(workflowId);
    const graphResponse = await readProductWorkflowGraph({
      workflowId,
      artifactPath: workflow.artifactPath,
    });
    return {
      workflow,
      canonicalGraph: graphResponse.canonicalGraph,
      graphIssues: graphIssuesFromResponse(graphResponse),
    };
  }

  async function getWorkflowReadiness(
    workflowId: string,
  ): Promise<CodexWorkflowReadiness> {
    const workflow = await requireWorkflow(workflowId);
    return buildReadiness(workflow);
  }

  async function prepareRun(
    options: PrepareCodexWorkflowRunInput,
  ): Promise<CodexWorkflowRunView> {
    const fetched = await fetchWorkflow(options.workflowId);
    const graph = fetched.canonicalGraph;
    if (!graph) {
      throw new CodexWorkflowServiceError({
        status: 409,
        code: "workflow_graph_unavailable",
        message: `Workflow ${options.workflowId} does not have a valid canonical graph / Workflow 缺少有效规范执行图: ${fetched.graphIssues.join("; ")}`,
      });
    }
    if (
      options.expectedRevisionId &&
      options.expectedRevisionId !== graph.revision.revisionId
    ) {
      throw new CodexWorkflowServiceError({
        status: 409,
        code: "workflow_revision_changed",
        message: `Workflow revision changed / Workflow revision 已变化: expected ${options.expectedRevisionId}, current ${graph.revision.revisionId}.`,
      });
    }
    const timestamp = now().toISOString();
    const graphState = startWorkflowGraph(graph);
    const record: CodexWorkflowRunRecord = {
      schemaVersion: CODEX_WORKFLOW_RUN_SCHEMA_VERSION,
      id: createId(),
      workflowId: fetched.workflow.id,
      workflowTitle: fetched.workflow.title,
      revisionId: graph.revision.revisionId,
      executor: "mcp-host",
      status: graphState.status,
      inputs: options.inputs ?? {},
      pinnedGraph: graph,
      graphState,
      stepResults: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      cancelledAt: null,
    };
    await persistRun(record);
    return toRunView(record);
  }

  async function getRun(runId: string): Promise<CodexWorkflowRunView> {
    return toRunView(await loadRun(runId));
  }

  async function advanceRun(
    runId: string,
    options: AdvanceCodexWorkflowRunInput,
  ): Promise<CodexWorkflowRunView> {
    return enqueueUpdate(async () => {
      const record = await loadRun(runId);
      assertRunCanAdvance(record);
      if (record.graphState.currentNodeId !== options.currentNodeId) {
        throw new CodexWorkflowServiceError({
          status: 409,
          code: "workflow_node_changed",
          message: `Workflow node changed / Workflow 当前节点已变化: expected ${options.currentNodeId}, current ${record.graphState.currentNodeId}.`,
        });
      }
      const updatedAt = now().toISOString();
      let nextState: WorkflowGraphRunState;
      try {
        nextState = advanceWorkflowGraph({
          graph: record.pinnedGraph,
          state: record.graphState,
          transitionId: options.transitionId,
          now: new Date(updatedAt),
        });
      } catch (error) {
        throw new CodexWorkflowServiceError({
          status: 409,
          code: "invalid_workflow_transition",
          message: `${error instanceof Error ? error.message : String(error)} / Workflow transition 无效。`,
        });
      }
      const traversed = nextState.history.at(-1);
      if (!traversed) {
        throw new Error("Workflow transition did not create a history entry.");
      }
      const updated: CodexWorkflowRunRecord = {
        ...record,
        status: nextState.status,
        graphState: nextState,
        stepResults: [
          ...record.stepResults,
          {
            nodeId: options.currentNodeId,
            transitionId: traversed.transitionId,
            summary: options.summary,
            evidence: options.evidence ?? [],
            completedAt: updatedAt,
          },
        ],
        updatedAt,
      };
      await persistRun(updated);
      return toRunView(updated);
    });
  }

  async function cancelRun(runId: string): Promise<CodexWorkflowRunView> {
    return enqueueUpdate(async () => {
      const record = await loadRun(runId);
      if (record.status === "cancelled" || isTerminalStatus(record.status)) {
        return toRunView(record);
      }
      const timestamp = now().toISOString();
      const updated: CodexWorkflowRunRecord = {
        ...record,
        status: "cancelled",
        updatedAt: timestamp,
        cancelledAt: timestamp,
      };
      await persistRun(updated);
      return toRunView(updated);
    });
  }

  async function requireWorkflow(workflowId: string): Promise<ProductWorkflow> {
    const state = await input.readProductState();
    const workflow = state.workflows.find((item) => item.id === workflowId);
    if (!workflow) {
      throw new CodexWorkflowServiceError({
        status: 404,
        code: "workflow_not_found",
        message: `Unknown workflow / 未找到 Workflow: ${workflowId}`,
      });
    }
    return workflow;
  }

  async function buildReadiness(
    workflow: ProductWorkflow,
  ): Promise<CodexWorkflowReadiness> {
    const graphResponse = await readProductWorkflowGraph({
      workflowId: workflow.id,
      artifactPath: workflow.artifactPath,
    });
    return readinessFromGraphResponse(workflow, graphResponse);
  }

  async function persistRun(record: CodexWorkflowRunRecord): Promise<void> {
    await mkdir(runsDirectory, { recursive: true });
    const targetPath = runPath(record.id);
    const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(
      temporaryPath,
      `${JSON.stringify(record, null, 2)}\n`,
      "utf8",
    );
    await rename(temporaryPath, targetPath);
  }

  async function loadRun(runId: string): Promise<CodexWorkflowRunRecord> {
    const path = runPath(runId);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if (isMissingFileError(error)) {
        throw new CodexWorkflowServiceError({
          status: 404,
          code: "workflow_run_not_found",
          message: `Unknown OysterWorkflow MCP run / 未找到 OysterWorkflow MCP 运行: ${runId}`,
        });
      }
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      throw new Error(
        `Invalid OysterWorkflow MCP run JSON at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const parsed = persistedRunSchema.parse(value);
    const pinnedGraph = parseWorkflowGraph(
      parsed.pinnedGraph,
      `OysterWorkflow MCP run ${runId}`,
    );
    if (parsed.revisionId !== pinnedGraph.revision.revisionId) {
      throw new Error(
        `OysterWorkflow MCP run ${runId} revision does not match its pinned graph.`,
      );
    }
    if (
      parsed.status !== "cancelled" &&
      parsed.status !== parsed.graphState.status
    ) {
      throw new Error(
        `OysterWorkflow MCP run ${runId} status does not match its graph state.`,
      );
    }
    return {
      ...parsed,
      pinnedGraph,
      graphState: parsed.graphState as WorkflowGraphRunState,
    };
  }

  function runPath(runId: string): string {
    if (!CODEX_WORKFLOW_RUN_ID_PATTERN.test(runId)) {
      throw new CodexWorkflowServiceError({
        status: 400,
        code: "invalid_workflow_run_id",
        message: `Invalid OysterWorkflow MCP run id / OysterWorkflow MCP 运行 ID 无效: ${runId}`,
      });
    }
    return join(runsDirectory, `${runId}.json`);
  }

  function enqueueUpdate<T>(operation: () => Promise<T>): Promise<T> {
    const result = updateQueue.then(operation, operation);
    updateQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  return {
    searchWorkflows,
    fetchWorkflow,
    getWorkflowReadiness,
    prepareRun,
    getRun,
    advanceRun,
    cancelRun,
  };
}

function readinessFromGraphResponse(
  workflow: ProductWorkflow,
  response: Awaited<ReturnType<typeof readProductWorkflowGraph>>,
): CodexWorkflowReadiness {
  const canonicalErrors = response.errors.filter(
    (error) => error.artifact === "canonical",
  );
  const issues: CodexWorkflowReadiness["issues"] = canonicalErrors.map(
    (error) => ({
      code: "canonical_graph_invalid" as const,
      message: `Canonical graph is invalid / 规范执行图无效: ${error.message}`,
    }),
  );
  if (!response.canonicalGraph && canonicalErrors.length === 0) {
    issues.push({
      code: "canonical_graph_missing",
      message:
        "Generate a canonical workflow graph before starting a run / 开始运行前请先生成规范执行图。",
    });
  }
  return {
    workflowId: workflow.id,
    workflowTitle: workflow.title,
    ready: response.canonicalGraph !== null && issues.length === 0,
    revisionId: response.canonicalGraph?.revision.revisionId ?? null,
    requiredApps: [...workflow.apps],
    issues,
    capabilityNote:
      "This legacy endpoint reports graph structure only and does not evaluate agent tools or permissions / 此兼容端点仅报告执行图结构，不评估 Agent 工具或权限。",
  };
}

function graphIssuesFromResponse(
  response: Awaited<ReturnType<typeof readProductWorkflowGraph>>,
): string[] {
  const issues = response.errors
    .filter((error) => error.artifact === "canonical")
    .map(
      (error) =>
        `Canonical graph is invalid / 规范执行图无效: ${error.message}`,
    );
  if (!response.canonicalGraph && issues.length === 0) {
    issues.push("Canonical graph is missing / 缺少规范执行图。");
  }
  return issues;
}

function toRunView(record: CodexWorkflowRunRecord): CodexWorkflowRunView {
  const currentNode = getGraphNode(
    record.pinnedGraph,
    record.graphState.currentNodeId,
  );
  const availableTransitions =
    record.status === "cancelled" || isTerminalStatus(record.status)
      ? []
      : getAvailableWorkflowTransitions(record.pinnedGraph, record.graphState);
  const nextAction = nextActionForStatus(record.status);
  const { pinnedGraph: _pinnedGraph, ...run } = record;
  return {
    run,
    currentNode,
    availableTransitions,
    nextAction,
    instruction: instructionForNextAction(nextAction, currentNode),
  };
}

function getGraphNode(
  graph: OysterWorkflowGraph,
  nodeId: string,
): WorkflowGraphNode {
  const node = graph.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) throw new Error(`Workflow node does not exist: ${nodeId}`);
  return node;
}

function assertRunCanAdvance(record: CodexWorkflowRunRecord): void {
  if (record.status === "cancelled") {
    throw new CodexWorkflowServiceError({
      status: 409,
      code: "workflow_run_cancelled",
      message: `Workflow run is cancelled / Workflow 运行已取消: ${record.id}`,
    });
  }
  if (isTerminalStatus(record.status)) {
    throw new CodexWorkflowServiceError({
      status: 409,
      code: "workflow_run_finished",
      message: `Workflow run already finished / Workflow 运行已结束: ${record.id} (${record.status})`,
    });
  }
}

function isTerminalStatus(status: CodexWorkflowRunRecord["status"]): boolean {
  return ["completed", "stopped", "rejected", "failed"].includes(status);
}

function nextActionForStatus(
  status: CodexWorkflowRunRecord["status"],
): CodexWorkflowNextAction {
  if (status === "cancelled") return "workflow_cancelled";
  if (status === "waiting") return "wait_for_resume_condition";
  if (isTerminalStatus(status)) return "workflow_finished";
  return "execute_current_node";
}

function instructionForNextAction(
  nextAction: CodexWorkflowNextAction,
  node: WorkflowGraphNode,
): string {
  switch (nextAction) {
    case "execute_current_node":
      return `Use the current agent's tools to execute only the current node, then call advance_workflow_run with evidence / 仅用当前 Agent 的工具执行当前节点，完成后携带证据调用 advance_workflow_run: ${node.title}`;
    case "wait_for_resume_condition":
      return `Do not bypass the wait. Resume only when the node condition is satisfied / 不要跳过等待条件，满足后再恢复: ${node.title}`;
    case "workflow_finished":
      return `The pinned workflow revision has reached a terminal node / 当前固定 revision 已到达终止节点: ${node.title}`;
    case "workflow_cancelled":
      return `The workflow run was cancelled; do not perform more actions / Workflow 运行已取消，不要继续执行: ${node.title}`;
  }
}

function isMissingFileError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}
