import { readFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { stableStringify } from "../io/stable-json.js";
import type { ProductWorkflowGraphResponse } from "./contracts.js";
import type { ProductWorkflow } from "./contracts.js";
import {
  loadWorkflowGraph,
  toWorkflowGraphDraft,
  WORKFLOW_GRAPH_FILE_NAME,
} from "../skill/workflow-graph.js";
import {
  parseCandidateWorkflow,
  WORKFLOW_CANDIDATE_FILE_NAME,
} from "../skill/workflow-learning.js";
import {
  parseWorkflowMergeProposal,
  WORKFLOW_MERGE_PROPOSAL_FILE_NAME,
} from "../skill/workflow-merge.js";
import type {
  OysterWorkflowGraph,
  WorkflowMergeProposal,
} from "../types/contracts.js";

export interface ReadProductWorkflowGraphInput {
  workflowId: string;
  artifactPath?: string | null;
  graphPath?: string | null;
  candidatePath?: string | null;
  mergeProposalPath?: string | null;
  workflows?: ProductWorkflow[];
}

export interface ProductWorkflowMergeBaseResolution {
  status: "ready" | "applied" | "stale";
  graph: OysterWorkflowGraph | null;
  graphPath: string | null;
  productWorkflowId: string | null;
  errors: string[];
}

/**
 * CN: 在 service 层读取并严格校验 workflow 的 canonical、Candidate 与 Call 5 proposal。
 * EN: Loads and validates canonical, Candidate, and Call 5 proposal artifacts in the service layer.
 * @param input workflow identity plus optional explicit or product artifact paths.
 * @returns graph review bundle with per-artifact diagnostics.
 */
export async function readProductWorkflowGraph(
  input: ReadProductWorkflowGraphInput,
): Promise<ProductWorkflowGraphResponse> {
  const baseDirectory = resolveArtifactDirectory(input);
  const graphPath = resolveOptionalPath(
    input.graphPath,
    baseDirectory,
    WORKFLOW_GRAPH_FILE_NAME,
  );
  const candidatePath = resolveOptionalPath(
    input.candidatePath,
    baseDirectory,
    WORKFLOW_CANDIDATE_FILE_NAME,
  );
  const mergeProposalPath = resolveOptionalPath(
    input.mergeProposalPath,
    baseDirectory,
    WORKFLOW_MERGE_PROPOSAL_FILE_NAME,
  );
  const errors: ProductWorkflowGraphResponse["errors"] = [];

  const canonicalGraph = graphPath
    ? await loadOptionalArtifact({
        artifact: "canonical",
        path: graphPath,
        errors,
        load: () => loadWorkflowGraph(graphPath),
      })
    : null;
  const candidate = candidatePath
    ? await loadOptionalArtifact({
        artifact: "candidate",
        path: candidatePath,
        errors,
        load: async () =>
          parseCandidateWorkflow(
            JSON.parse(await readFile(candidatePath, "utf8")),
          ),
      })
    : null;
  const mergeProposal = mergeProposalPath
    ? await loadOptionalArtifact({
        artifact: "merge-proposal",
        path: mergeProposalPath,
        errors,
        load: async () =>
          parseWorkflowMergeProposal(
            JSON.parse(await readFile(mergeProposalPath, "utf8")),
          ),
      })
    : null;
  const mergeBase =
    mergeProposal && input.workflows
      ? await resolveProductWorkflowMergeBase({
          proposal: mergeProposal,
          workflows: input.workflows,
        })
      : null;
  for (const message of mergeBase?.errors ?? []) {
    errors.push({ artifact: "merge-base", message });
  }

  return {
    workflowId: input.workflowId,
    canonicalGraph,
    mergeBaseGraph: mergeBase?.graph ?? null,
    candidate,
    mergeProposal,
    mergeStatus: mergeBase?.status ?? null,
    paths: {
      graphPath,
      mergeBaseGraphPath: mergeBase?.graphPath ?? null,
      candidatePath,
      mergeProposalPath,
    },
    errors,
  };
}

/**
 * CN: 用 proposal 的 family 与 base revision 绑定解析当前可应用的 canonical graph。
 * EN: Resolves the canonical graph targeted by a version-bound merge proposal.
 * @param input validated proposal and authoritative Product workflows.
 * @returns ready, already-applied, or stale merge base resolution.
 */
export async function resolveProductWorkflowMergeBase(input: {
  proposal: WorkflowMergeProposal;
  workflows: ProductWorkflow[];
}): Promise<ProductWorkflowMergeBaseResolution> {
  const candidates = input.workflows
    .flatMap((workflow) => {
      if (!workflow.artifactPath) return [];
      return [
        {
          productWorkflowId: workflow.id,
          graphPath: resolveProductWorkflowSiblingArtifactPath(
            workflow.artifactPath,
            WORKFLOW_GRAPH_FILE_NAME,
          ),
          updatedAt: workflow.updatedAt,
        },
      ];
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const loaded: Array<{
    productWorkflowId: string;
    graphPath: string;
    graph: OysterWorkflowGraph;
  }> = [];
  const errors: string[] = [];
  const seenPaths = new Set<string>();
  for (const candidate of candidates) {
    if (seenPaths.has(candidate.graphPath)) continue;
    seenPaths.add(candidate.graphPath);
    try {
      const graph = await loadWorkflowGraph(candidate.graphPath);
      if (graph.workflowId === input.proposal.baseWorkflowId) {
        loaded.push({ ...candidate, graph });
      }
    } catch (error) {
      if (!isMissingFileError(error)) {
        errors.push(
          `${candidate.graphPath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  const applied = loaded.find(({ graph }) =>
    graphMatchesAppliedProposal(graph, input.proposal),
  );
  if (applied) {
    return {
      status: "applied",
      graph: applied.graph,
      graphPath: applied.graphPath,
      productWorkflowId: applied.productWorkflowId,
      errors,
    };
  }
  const ready = loaded.find(
    ({ graph }) => graph.revision.revisionId === input.proposal.baseRevisionId,
  );
  if (ready) {
    return {
      status: "ready",
      graph: ready.graph,
      graphPath: ready.graphPath,
      productWorkflowId: ready.productWorkflowId,
      errors,
    };
  }
  const current = loaded[0];
  return {
    status: "stale",
    graph: current?.graph ?? null,
    graphPath: current?.graphPath ?? null,
    productWorkflowId: current?.productWorkflowId ?? null,
    errors,
  };
}

/**
 * CN: 从 Product workflow 的 skill/package 路径严格读取 sibling merge proposal。
 * EN: Loads the sibling merge proposal owned by one Product workflow package.
 * @param workflow authoritative Product workflow.
 * @returns validated proposal and absolute path.
 */
export async function loadProductWorkflowMergeProposal(
  workflow: ProductWorkflow,
): Promise<{ proposal: WorkflowMergeProposal; proposalPath: string }> {
  if (!workflow.artifactPath) {
    throw new Error(
      `Workflow ${workflow.id} has no artifact package. / 工作流 ${workflow.id} 没有产物包。`,
    );
  }
  const proposalPath = resolveProductWorkflowSiblingArtifactPath(
    workflow.artifactPath,
    WORKFLOW_MERGE_PROPOSAL_FILE_NAME,
  );
  const proposal = parseWorkflowMergeProposal(
    JSON.parse(await readFile(proposalPath, "utf8")),
  );
  return { proposal, proposalPath };
}

function resolveArtifactDirectory(
  input: ReadProductWorkflowGraphInput,
): string | null {
  const explicitPath =
    input.graphPath ?? input.candidatePath ?? input.mergeProposalPath;
  if (explicitPath) return dirname(resolve(explicitPath));
  if (!input.artifactPath) return null;
  const artifactPath = resolve(input.artifactPath);
  return extname(artifactPath) ? dirname(artifactPath) : artifactPath;
}

function resolveOptionalPath(
  explicitPath: string | null | undefined,
  baseDirectory: string | null,
  fileName: string,
): string | null {
  if (explicitPath) return resolve(explicitPath);
  return baseDirectory ? join(baseDirectory, fileName) : null;
}

export function resolveProductWorkflowSiblingArtifactPath(
  artifactPath: string,
  fileName: string,
): string {
  const absolutePath = resolve(artifactPath);
  return join(
    extname(absolutePath) ? dirname(absolutePath) : absolutePath,
    fileName,
  );
}

function graphMatchesAppliedProposal(
  graph: OysterWorkflowGraph,
  proposal: WorkflowMergeProposal,
): boolean {
  return (
    proposal.mergedGraph !== null &&
    graph.revision.previousRevisionId === proposal.baseRevisionId &&
    stableStringify(toWorkflowGraphDraft(graph)) ===
      stableStringify(proposal.mergedGraph)
  );
}

async function loadOptionalArtifact<T>(input: {
  artifact: ProductWorkflowGraphResponse["errors"][number]["artifact"];
  path: string;
  errors: ProductWorkflowGraphResponse["errors"];
  load: () => Promise<T>;
}): Promise<T | null> {
  try {
    return await input.load();
  } catch (error) {
    if (isMissingFileError(error)) return null;
    input.errors.push({
      artifact: input.artifact,
      message: `${input.path}: ${error instanceof Error ? error.message : String(error)}`,
    });
    return null;
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
