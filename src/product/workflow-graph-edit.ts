import { dirname } from "node:path";
import { z } from "zod";
import {
  loadWorkflowGraph,
  parseWorkflowGraphDraft,
  persistWorkflowGraphDraft,
  toWorkflowGraphDraft,
  type MaterializeWorkflowGraphResult,
} from "../skill/workflow-graph.js";
import type {
  OysterWorkflowGraph,
  OysterWorkflowGraphDraft,
} from "../types/contracts.js";
import type { ProductWorkflowGraphEditInput } from "./contracts.js";

const requiredTextSchema = z.string().trim().min(1);
const textListSchema = z.array(requiredTextSchema);
const nonEmptyPatch = <T extends z.ZodRawShape>(shape: T) =>
  z
    .object(shape)
    .partial()
    .strict()
    .refine((patch) => Object.keys(patch).length > 0, {
      message: "At least one editable field is required.",
    });
const expectedRevisionSchema = requiredTextSchema;
const nodeTargetBaseSchema = z.object({
  kind: z.literal("node"),
  id: requiredTextSchema,
});
const transitionTargetBaseSchema = z.object({
  kind: z.literal("transition"),
  id: requiredTextSchema,
});

export const productWorkflowGraphEditInputSchema = z.union([
  z
    .object({
      expectedRevisionId: expectedRevisionSchema,
      target: nodeTargetBaseSchema
        .extend({ type: z.literal("action") })
        .strict(),
      patch: nonEmptyPatch({
        title: requiredTextSchema,
        objective: requiredTextSchema,
        act: textListSchema.min(1),
        operationApp: requiredTextSchema,
        hints: textListSchema,
      }),
    })
    .strict(),
  z
    .object({
      expectedRevisionId: expectedRevisionSchema,
      target: nodeTargetBaseSchema
        .extend({ type: z.literal("decision") })
        .strict(),
      patch: nonEmptyPatch({
        title: requiredTextSchema,
        decision: requiredTextSchema,
        hints: textListSchema,
      }),
    })
    .strict(),
  z
    .object({
      expectedRevisionId: expectedRevisionSchema,
      target: nodeTargetBaseSchema.extend({ type: z.literal("wait") }).strict(),
      patch: nonEmptyPatch({
        title: requiredTextSchema,
        waitFor: requiredTextSchema,
        resumeCondition: requiredTextSchema,
        hints: textListSchema,
      }),
    })
    .strict(),
  z
    .object({
      expectedRevisionId: expectedRevisionSchema,
      target: nodeTargetBaseSchema
        .extend({ type: z.literal("terminal") })
        .strict(),
      patch: nonEmptyPatch({
        title: requiredTextSchema,
        outcome: z.enum(["completed", "stopped", "rejected", "failed"]),
        summary: requiredTextSchema,
        hints: textListSchema,
      }),
    })
    .strict(),
  z
    .object({
      expectedRevisionId: expectedRevisionSchema,
      target: transitionTargetBaseSchema
        .extend({ type: z.literal("conditional") })
        .strict(),
      patch: nonEmptyPatch({ when: requiredTextSchema }),
    })
    .strict(),
  z
    .object({
      expectedRevisionId: expectedRevisionSchema,
      target: transitionTargetBaseSchema
        .extend({ type: z.literal("resume") })
        .strict(),
      patch: nonEmptyPatch({ when: requiredTextSchema }),
    })
    .strict(),
  z
    .object({
      expectedRevisionId: expectedRevisionSchema,
      target: transitionTargetBaseSchema
        .extend({ type: z.literal("retry") })
        .strict(),
      patch: nonEmptyPatch({
        when: requiredTextSchema,
        maxAttempts: z.number().int().min(1),
      }),
    })
    .strict(),
]);

/**
 * CN: 严格解析 UI 发来的 Graph 内容编辑，并拒绝拓扑与来源字段。
 * EN: Strictly parses Graph content edits while rejecting topology and provenance fields.
 * @param value untrusted Runtime request body.
 * @returns validated edit input shared by Runtime and ProductStore.
 */
export function parseProductWorkflowGraphEditInput(
  value: unknown,
): ProductWorkflowGraphEditInput {
  return productWorkflowGraphEditInputSchema.parse(
    value,
  ) as ProductWorkflowGraphEditInput;
}

/**
 * CN: 在内存中只修改一个已存在节点或路线的白名单内容字段。
 * EN: Applies allow-listed content fields to one existing node or transition in memory.
 * @param graph current canonical graph.
 * @param input validated revision-bound edit.
 * @returns a strictly validated semantic graph draft.
 */
export function applyProductWorkflowGraphEdit(
  graph: OysterWorkflowGraph,
  input: ProductWorkflowGraphEditInput,
): OysterWorkflowGraphDraft {
  if (graph.revision.revisionId !== input.expectedRevisionId) {
    throw staleWorkflowGraphEditError(
      input.expectedRevisionId,
      graph.revision.revisionId,
    );
  }

  const draft = toWorkflowGraphDraft(graph);
  if (input.target.kind === "node") {
    const nodeIndex = draft.nodes.findIndex(
      (node) => node.id === input.target.id,
    );
    const node = draft.nodes[nodeIndex];
    if (!node) {
      throw new Error(
        `Workflow graph edit target node does not exist: ${input.target.id}. / 工作流图中不存在要编辑的节点：${input.target.id}。`,
      );
    }
    if (node.type !== input.target.type) {
      throw new Error(
        `Workflow graph edit target type changed: expected ${input.target.type}, received ${node.type}. / 工作流图编辑目标类型已变化。`,
      );
    }
    draft.nodes[nodeIndex] = {
      ...node,
      ...input.patch,
    } as OysterWorkflowGraphDraft["nodes"][number];
  } else {
    const transitionIndex = draft.transitions.findIndex(
      (transition) => transition.id === input.target.id,
    );
    const transition = draft.transitions[transitionIndex];
    if (!transition) {
      throw new Error(
        `Workflow graph edit target transition does not exist: ${input.target.id}. / 工作流图中不存在要编辑的路线：${input.target.id}。`,
      );
    }
    if (transition.type !== input.target.type) {
      throw new Error(
        `Workflow graph edit target type changed: expected ${input.target.type}, received ${transition.type}. / 工作流图编辑目标类型已变化。`,
      );
    }
    draft.transitions[transitionIndex] = {
      ...transition,
      ...input.patch,
    } as OysterWorkflowGraphDraft["transitions"][number];
  }

  return parseWorkflowGraphDraft(draft, "workflow graph edit");
}

/**
 * CN: 用 optimistic revision guard 将一次 Graph 内容编辑保存为新修订。
 * EN: Persists one Graph content edit as a new revision with an optimistic revision guard.
 * @param input canonical graph path, source skill link, edit and optional clock.
 * @returns newly materialized canonical Graph artifacts.
 */
export async function persistProductWorkflowGraphEdit(input: {
  graphPath: string;
  sourceSkillPath?: string;
  edit: ProductWorkflowGraphEditInput;
  now?: Date;
}): Promise<MaterializeWorkflowGraphResult> {
  const edit = parseProductWorkflowGraphEditInput(input.edit);
  const graph = await loadWorkflowGraph(input.graphPath);
  const draft = applyProductWorkflowGraphEdit(graph, edit);
  return persistWorkflowGraphDraft({
    draft,
    outDir: dirname(input.graphPath),
    sourceSkillPath: input.sourceSkillPath,
    expectedRevisionId: edit.expectedRevisionId,
    now: input.now,
  });
}

function staleWorkflowGraphEditError(
  expectedRevisionId: string,
  actualRevisionId: string,
): Error {
  return new Error(
    `Workflow graph edit is stale because the canonical revision changed: expected ${expectedRevisionId}, received ${actualRevisionId}. Refresh the graph and try again. / 工作流图版本已更新，请刷新后重新编辑。`,
  );
}

export function isWorkflowGraphEditConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.startsWith("Workflow graph edit is stale") ||
      error.message.startsWith("Workflow graph draft is stale") ||
      error.message.startsWith("Workflow graph edit target"))
  );
}
