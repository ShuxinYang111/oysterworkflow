import { validateWorkflowGraph } from "./workflow-graph.js";
import type {
  OysterWorkflowGraph,
  WorkflowGraphNode,
  WorkflowGraphTransition,
} from "../types/contracts.js";

export type WorkflowGraphRunStatus =
  "running" | "waiting" | "completed" | "stopped" | "rejected" | "failed";

export interface WorkflowGraphRunHistoryEntry {
  transitionId: string;
  from: string;
  to: string;
  type: WorkflowGraphTransition["type"];
  retryAttempt?: number;
  traversedAt: string;
}

export interface WorkflowGraphRunState {
  workflowId: string;
  revisionId: string;
  currentNodeId: string;
  status: WorkflowGraphRunStatus;
  retryAttempts: Record<string, number>;
  history: WorkflowGraphRunHistoryEntry[];
}

export interface AdvanceWorkflowGraphOptions {
  graph: OysterWorkflowGraph;
  state: WorkflowGraphRunState;
  transitionId?: string;
  now?: Date;
}

/**
 * CN: 从 canonical entry node 创建一个不可变的图运行状态。
 * EN: Creates an immutable graph run state at the canonical entry node.
 * @param graph validated executable graph.
 * @returns initial run state.
 */
export function startWorkflowGraph(
  graph: OysterWorkflowGraph,
): WorkflowGraphRunState {
  validateWorkflowGraph(graph);
  const entryNode = getNode(graph, graph.entryNodeId);
  return {
    workflowId: graph.workflowId,
    revisionId: graph.revision.revisionId,
    currentNodeId: entryNode.id,
    status: statusForNode(entryNode),
    retryAttempts: {},
    history: [],
  };
}

/**
 * CN: 返回当前节点可选择的 typed transitions；条件判断仍由调用方或 Agent 完成。
 * EN: Lists typed transitions available from the current node; callers evaluate conditions.
 * @param graph executable workflow graph.
 * @param state current run state.
 * @returns outgoing transitions in graph order.
 */
export function getAvailableWorkflowTransitions(
  graph: OysterWorkflowGraph,
  state: WorkflowGraphRunState,
): WorkflowGraphTransition[] {
  assertStateBelongsToGraph(graph, state);
  return graph.transitions.filter(
    (transition) => transition.from === state.currentNodeId,
  );
}

/**
 * CN: 沿一条明确的 transition 推进状态，并在 runtime 强制执行 retry 上限。
 * EN: Advances through one selected transition and enforces retry limits at runtime.
 * @param options graph, current state, optional route choice, and clock.
 * @returns next immutable run state.
 */
export function advanceWorkflowGraph(
  options: AdvanceWorkflowGraphOptions,
): WorkflowGraphRunState {
  validateWorkflowGraph(options.graph);
  assertStateBelongsToGraph(options.graph, options.state);
  const currentNode = getNode(options.graph, options.state.currentNodeId);
  if (currentNode.type === "terminal") {
    throw new Error(
      `Workflow run already reached terminal node: ${currentNode.id}`,
    );
  }
  const available = getAvailableWorkflowTransitions(
    options.graph,
    options.state,
  );
  if (currentNode.type === "wait" && available.length === 0) {
    throw new Error(
      `Wait node ${currentNode.id} has no known resume transition yet.`,
    );
  }
  const selected = selectTransition(available, options.transitionId);
  const retryAttempts = { ...options.state.retryAttempts };
  let retryAttempt: number | undefined;
  if (selected.type === "retry") {
    retryAttempt = (retryAttempts[selected.id] ?? 0) + 1;
    if (retryAttempt > selected.maxAttempts) {
      throw new Error(
        `Retry transition ${selected.id} exceeded maxAttempts=${selected.maxAttempts}.`,
      );
    }
    retryAttempts[selected.id] = retryAttempt;
  }
  const targetNode = getNode(options.graph, selected.to);
  return {
    ...options.state,
    currentNodeId: targetNode.id,
    status: statusForNode(targetNode),
    retryAttempts,
    history: [
      ...options.state.history,
      {
        transitionId: selected.id,
        from: selected.from,
        to: selected.to,
        type: selected.type,
        ...(retryAttempt !== undefined ? { retryAttempt } : {}),
        traversedAt: (options.now ?? new Date()).toISOString(),
      },
    ],
  };
}

function selectTransition(
  available: WorkflowGraphTransition[],
  transitionId?: string,
): WorkflowGraphTransition {
  if (transitionId) {
    const selected = available.find(
      (transition) => transition.id === transitionId,
    );
    if (!selected) {
      throw new Error(
        `Transition ${transitionId} is not available from the current node.`,
      );
    }
    return selected;
  }
  if (available.length === 1 && available[0].type === "default") {
    return available[0];
  }
  if (available.length === 0) {
    throw new Error("Current non-terminal node has no available transition.");
  }
  throw new Error(
    "Multiple or conditional transitions are available; transitionId is required.",
  );
}

function assertStateBelongsToGraph(
  graph: OysterWorkflowGraph,
  state: WorkflowGraphRunState,
): void {
  if (state.workflowId !== graph.workflowId) {
    throw new Error(
      `Workflow run belongs to ${state.workflowId}, not ${graph.workflowId}.`,
    );
  }
  if (state.revisionId !== graph.revision.revisionId) {
    throw new Error(
      `Workflow run revision ${state.revisionId} does not match ${graph.revision.revisionId}.`,
    );
  }
  const currentNode = getNode(graph, state.currentNodeId);
  const expectedStatus = statusForNode(currentNode);
  if (state.status !== expectedStatus) {
    throw new Error(
      `Workflow run status ${state.status} does not match node ${currentNode.id} (${expectedStatus}).`,
    );
  }
}

function getNode(
  graph: OysterWorkflowGraph,
  nodeId: string,
): WorkflowGraphNode {
  const node = graph.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) {
    throw new Error(`Workflow node does not exist: ${nodeId}`);
  }
  return node;
}

function statusForNode(node: WorkflowGraphNode): WorkflowGraphRunStatus {
  if (node.type === "wait") {
    return "waiting";
  }
  if (node.type === "terminal") {
    return node.outcome;
  }
  return "running";
}
