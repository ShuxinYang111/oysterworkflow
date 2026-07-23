import type { ProductWorkflow } from "../product/contracts.js";
import type {
  OysterWorkflowGraph,
  WorkflowGraphNode,
  WorkflowGraphTransition,
} from "../types/contracts.js";
import type {
  WorkflowGraphRunState,
  WorkflowGraphRunStatus,
} from "../skill/workflow-graph-runtime.js";

export const CODEX_WORKFLOW_RUN_SCHEMA_VERSION =
  "oyster-codex-workflow-run-v1" as const;

export type CodexWorkflowRunStatus = WorkflowGraphRunStatus | "cancelled";

export interface CodexWorkflowReadinessIssue {
  code:
    | "workflow_not_found"
    | "canonical_graph_missing"
    | "canonical_graph_invalid";
  message: string;
}

export interface CodexWorkflowReadiness {
  workflowId: string;
  workflowTitle: string | null;
  ready: boolean;
  revisionId: string | null;
  requiredApps: string[];
  issues: CodexWorkflowReadinessIssue[];
  capabilityNote: string;
}

export interface CodexWorkflowSearchResult {
  id: string;
  title: string;
  description: string;
  status: ProductWorkflow["status"];
  apps: string[];
  updatedAt: string;
  hasCanonicalGraph: boolean;
  revisionId: string | null;
  graphIssues: string[];
}

export interface CodexWorkflowSearchResponse {
  query: string;
  matchMode: "all" | "query" | "fallback";
  total: number;
  results: CodexWorkflowSearchResult[];
}

export interface CodexWorkflowFetchResponse {
  workflow: ProductWorkflow;
  canonicalGraph: OysterWorkflowGraph | null;
  graphIssues: string[];
}

export interface CodexWorkflowEvidence {
  kind: "observation" | "url" | "artifact" | "receipt";
  value: string;
  label?: string;
}

export interface CodexWorkflowStepResult {
  nodeId: string;
  transitionId: string;
  summary: string;
  evidence: CodexWorkflowEvidence[];
  completedAt: string;
}

export interface CodexWorkflowRunRecord {
  schemaVersion: typeof CODEX_WORKFLOW_RUN_SCHEMA_VERSION;
  id: string;
  workflowId: string;
  workflowTitle: string;
  revisionId: string;
  executor: "mcp-host" | "codex-app";
  status: CodexWorkflowRunStatus;
  inputs: Record<string, unknown>;
  pinnedGraph: OysterWorkflowGraph;
  graphState: WorkflowGraphRunState;
  stepResults: CodexWorkflowStepResult[];
  createdAt: string;
  updatedAt: string;
  cancelledAt: string | null;
}

export type CodexWorkflowNextAction =
  | "execute_current_node"
  | "wait_for_resume_condition"
  | "workflow_finished"
  | "workflow_cancelled";

export interface CodexWorkflowRunView {
  run: Omit<CodexWorkflowRunRecord, "pinnedGraph">;
  currentNode: WorkflowGraphNode;
  availableTransitions: WorkflowGraphTransition[];
  nextAction: CodexWorkflowNextAction;
  instruction: string;
}

export interface PrepareCodexWorkflowRunInput {
  workflowId: string;
  expectedRevisionId?: string;
  inputs?: Record<string, unknown>;
}

export interface AdvanceCodexWorkflowRunInput {
  currentNodeId: string;
  transitionId?: string;
  summary: string;
  evidence?: CodexWorkflowEvidence[];
}
