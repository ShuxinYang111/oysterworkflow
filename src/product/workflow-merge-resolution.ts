import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type {
  ProductPendingWorkflowMerge,
  ProductState,
  ProductWorkflow,
  ProductWorkflowMergeTarget,
} from "./contracts.js";
import {
  loadProductWorkflowMergeProposal,
  resolveProductWorkflowMergeBase,
  resolveProductWorkflowSiblingArtifactPath,
} from "./workflow-graph-view.js";
import type { WorkflowMergeProposal } from "../types/contracts.js";

export const WORKFLOW_MERGE_RESOLUTION_FILE_NAME =
  "workflow-merge-resolution.json";

const workflowMergeResolutionSchema = z
  .object({
    schemaVersion: z.literal("oyster-workflow-merge-resolution-v1"),
    proposalId: z.string().min(1),
    proposalHash: z.string().min(1),
    sourceWorkflowId: z.string().min(1),
    decision: z.enum(["create_new", "merge"]),
    targetWorkflowId: z.string().min(1).nullable(),
    resolvedAt: z.string().min(1),
  })
  .strict();

export type ProductWorkflowMergeResolution = z.infer<
  typeof workflowMergeResolutionSchema
>;

/**
 * CN: 读取与当前 proposal 精确绑定的用户归类决策；旧 proposal 的决策不会误用。
 * EN: Reads a user classification decision bound to the exact current proposal.
 * @param workflow source Product workflow.
 * @param proposal validated current merge proposal.
 * @returns matching decision, or null when unresolved or superseded.
 */
export async function readProductWorkflowMergeResolution(
  workflow: ProductWorkflow,
  proposal: WorkflowMergeProposal,
): Promise<ProductWorkflowMergeResolution | null> {
  if (!workflow.artifactPath) return null;
  const resolutionPath = resolveProductWorkflowSiblingArtifactPath(
    workflow.artifactPath,
    WORKFLOW_MERGE_RESOLUTION_FILE_NAME,
  );
  try {
    const resolution = workflowMergeResolutionSchema.parse(
      JSON.parse(await readFile(resolutionPath, "utf8")),
    );
    return resolution.proposalId === proposal.proposalId &&
      resolution.proposalHash === proposal.proposalHash
      ? resolution
      : null;
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

/**
 * CN: 在来源 skill 包旁持久化用户的“新建/合并”决策，供刷新与重启后继续使用。
 * EN: Persists the user's create-or-merge decision beside the source skill package.
 * @param input source workflow, proposal, decision, optional merge target and clock.
 * @returns validated persisted resolution.
 */
export async function writeProductWorkflowMergeResolution(input: {
  workflow: ProductWorkflow;
  proposal: WorkflowMergeProposal;
  decision: "create_new" | "merge";
  targetWorkflowId?: string | null;
  now?: Date;
}): Promise<ProductWorkflowMergeResolution> {
  if (!input.workflow.artifactPath) {
    throw new Error(
      `Workflow ${input.workflow.id} has no artifact package. / 工作流 ${input.workflow.id} 没有产物包。`,
    );
  }
  const resolution = workflowMergeResolutionSchema.parse({
    schemaVersion: "oyster-workflow-merge-resolution-v1",
    proposalId: input.proposal.proposalId,
    proposalHash: input.proposal.proposalHash,
    sourceWorkflowId: input.workflow.id,
    decision: input.decision,
    targetWorkflowId: input.targetWorkflowId ?? null,
    resolvedAt: (input.now ?? new Date()).toISOString(),
  });
  const resolutionPath = resolveProductWorkflowSiblingArtifactPath(
    input.workflow.artifactPath,
    WORKFLOW_MERGE_RESOLUTION_FILE_NAME,
  );
  await mkdir(dirname(resolutionPath), { recursive: true });
  await writeFile(
    resolutionPath,
    `${JSON.stringify(resolution, null, 2)}\n`,
    "utf8",
  );
  return resolution;
}

/**
 * CN: 扫描 Product 工作流，返回仍需要用户选择“新建/合并”的有效提案。
 * EN: Scans Product workflows for valid proposals that still need a create-or-merge decision.
 * @param state authoritative Product state.
 * @returns pending decisions ordered by newest source workflow first.
 */
export async function listPendingProductWorkflowMerges(
  state: ProductState,
): Promise<ProductPendingWorkflowMerge[]> {
  const hiddenWorkflowIds = new Set(
    state.workflowTombstones.map((item) => item.workflowId),
  );
  const sources = [...state.workflows]
    .filter(
      (workflow) =>
        Boolean(workflow.artifactPath) && !hiddenWorkflowIds.has(workflow.id),
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const pending: ProductPendingWorkflowMerge[] = [];

  for (const source of sources) {
    let proposal: WorkflowMergeProposal;
    try {
      ({ proposal } = await loadProductWorkflowMergeProposal(source));
    } catch (error) {
      if (isMissingFileError(error)) continue;
      throw error;
    }
    if (proposal.result === "incompatible") continue;
    if (await readProductWorkflowMergeResolution(source, proposal)) continue;

    const targets: ProductWorkflowMergeTarget[] = [];
    let proposalAlreadyApplied = false;
    for (const candidate of sources) {
      if (candidate.id === source.id) continue;
      const resolution = await resolveProductWorkflowMergeBase({
        proposal,
        workflows: [candidate],
      });
      if (resolution.status === "applied") {
        proposalAlreadyApplied = true;
        break;
      }
      if (
        resolution.status !== "ready" ||
        !resolution.graph ||
        !resolution.productWorkflowId
      ) {
        continue;
      }
      targets.push({
        workflowId: candidate.id,
        title: candidate.title,
        description: candidate.description,
        revisionNumber: resolution.graph.revision.number,
        revisionId: resolution.graph.revision.revisionId,
      });
    }
    if (proposalAlreadyApplied || targets.length === 0) continue;

    pending.push({
      sourceWorkflowId: source.id,
      sourceTitle: source.title,
      sourceDescription: source.description,
      proposalId: proposal.proposalId,
      proposalHash: proposal.proposalHash,
      targets,
      recommendedTargetWorkflowId: targets[0].workflowId,
    });
  }
  return pending;
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
