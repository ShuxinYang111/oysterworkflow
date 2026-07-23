import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import type {
  CandidateWorkflow,
  OpenClawSkill,
  OysterWorkflowGraph,
  WorkflowGraphNode,
  WorkflowFamilyCard,
  WorkflowFamilyMatch,
} from "../types/contracts.js";
import {
  renderPromptTemplate,
  type LoadedPromptSet,
} from "./prompt-registry.js";
import { validateWorkflowTopology } from "./workflow-topology.js";
import { loadWorkflowGraph } from "./workflow-graph.js";
import {
  buildWorkflowReferenceCatalog,
  buildWorkflowReferenceRefs,
} from "./workflow-references.js";

export const WORKFLOW_CANDIDATE_FILE_NAME = "workflow-candidate.json";
export const WORKFLOW_FAMILY_MATCH_FILE_NAME = "workflow-family-match.json";
export const WORKFLOW_FAMILY_CATALOG_SCHEMA_VERSION =
  "oyster-workflow-family-catalog-v1" as const;
export const WORKFLOW_FAMILY_CATALOG_V2_SCHEMA_VERSION =
  "oyster-workflow-family-catalog-v2" as const;

const nonEmptyString = z.string().trim().min(1);
const stringArray = z.array(nonEmptyString);
const workflowReferenceValueSchema = z.union([
  nonEmptyString,
  z.array(nonEmptyString).min(1),
  z.record(z.string(), nonEmptyString),
]);
const workflowReferenceSchema = z
  .object({
    id: nonEmptyString,
    name: nonEmptyString,
    value: workflowReferenceValueSchema,
    notes: nonEmptyString.optional(),
  })
  .strict();
const actionStringArray = z.preprocess(
  (value) => (typeof value === "string" ? [value] : value),
  stringArray.min(1),
);
const candidateActionNodeSchema = z
  .object({
    id: nonEmptyString,
    type: z.literal("action"),
    title: nonEmptyString,
    objective: nonEmptyString,
    act: actionStringArray,
    operationApp: nonEmptyString,
    hints: stringArray,
    referenceRefs: stringArray.optional(),
  })
  .strict();
const candidateDecisionNodeSchema = z
  .object({
    id: nonEmptyString,
    type: z.literal("decision"),
    title: nonEmptyString,
    decision: nonEmptyString,
    hints: stringArray,
    referenceRefs: stringArray.optional(),
  })
  .strict();
const candidateWaitNodeSchema = z
  .object({
    id: nonEmptyString,
    type: z.literal("wait"),
    title: nonEmptyString,
    waitFor: nonEmptyString,
    resumeCondition: nonEmptyString,
    hints: stringArray,
    referenceRefs: stringArray.optional(),
  })
  .strict();
const candidateTerminalNodeSchema = z
  .object({
    id: nonEmptyString,
    type: z.literal("terminal"),
    title: nonEmptyString,
    outcome: z.enum(["completed", "stopped", "rejected", "failed"]),
    summary: nonEmptyString,
    hints: stringArray,
    referenceRefs: stringArray.optional(),
  })
  .strict();
const candidateNodeSchema = z.discriminatedUnion("type", [
  candidateActionNodeSchema,
  candidateDecisionNodeSchema,
  candidateWaitNodeSchema,
  candidateTerminalNodeSchema,
]);
const candidateDefaultTransitionSchema = z
  .object({
    id: nonEmptyString,
    from: nonEmptyString,
    to: nonEmptyString,
    type: z.literal("default"),
  })
  .strict();
const candidateConditionalTransitionSchema = z
  .object({
    id: nonEmptyString,
    from: nonEmptyString,
    to: nonEmptyString,
    type: z.literal("conditional"),
    when: nonEmptyString,
  })
  .strict();
const candidateRetryTransitionSchema = z
  .object({
    id: nonEmptyString,
    from: nonEmptyString,
    to: nonEmptyString,
    type: z.literal("retry"),
    when: nonEmptyString,
    maxAttempts: z.number().int().positive(),
  })
  .strict();
const candidateResumeTransitionSchema = z
  .object({
    id: nonEmptyString,
    from: nonEmptyString,
    to: nonEmptyString,
    type: z.literal("resume"),
    when: nonEmptyString,
  })
  .strict();
const candidateTransitionSchema = z.discriminatedUnion("type", [
  candidateDefaultTransitionSchema,
  candidateConditionalTransitionSchema,
  candidateRetryTransitionSchema,
  candidateResumeTransitionSchema,
]);
const candidateWorkflowDraftSchema = z
  .object({
    name: nonEmptyString,
    goal: nonEmptyString,
    entryNodeId: nonEmptyString,
    nodes: z.array(candidateNodeSchema).min(1),
    transitions: z.array(candidateTransitionSchema),
  })
  .strict();
const candidateWorkflowSchema = candidateWorkflowDraftSchema
  .extend({
    schemaVersion: z.literal("oyster-workflow-candidate-v2"),
    candidateId: nonEmptyString,
    skillId: nonEmptyString,
    references: z.array(workflowReferenceSchema).optional(),
  })
  .strict();
const workflowFamilyCardSchema = z
  .object({
    workflowId: nonEmptyString,
    name: nonEmptyString,
    goal: nonEmptyString,
    whenToUse: stringArray,
    outline: stringArray,
    terminalOutcomes: stringArray,
    apps: stringArray,
  })
  .strict();
const workflowFamilyCatalogV1Schema = z
  .object({
    schemaVersion: z.literal(WORKFLOW_FAMILY_CATALOG_SCHEMA_VERSION),
    families: z.array(workflowFamilyCardSchema),
  })
  .strict();
const workflowFamilyCatalogV2Schema = z
  .object({
    schemaVersion: z.literal(WORKFLOW_FAMILY_CATALOG_V2_SCHEMA_VERSION),
    families: z.array(
      workflowFamilyCardSchema.extend({ graphPath: nonEmptyString }).strict(),
    ),
  })
  .strict();
const workflowFamilyCatalogSchema = z.discriminatedUnion("schemaVersion", [
  workflowFamilyCatalogV1Schema,
  workflowFamilyCatalogV2Schema,
]);
const workflowFamilyMatchDraftSchema = z
  .object({
    decision: z.enum(["match", "new_family", "uncertain"]),
    matchedWorkflowId: nonEmptyString.nullable(),
  })
  .strict();

export interface WorkflowLearningPromptPayload {
  systemPrompt: string;
  userPrompt: string;
}

export interface LoadedWorkflowFamilyCatalog {
  schemaVersion:
    | typeof WORKFLOW_FAMILY_CATALOG_SCHEMA_VERSION
    | typeof WORKFLOW_FAMILY_CATALOG_V2_SCHEMA_VERSION;
  families: WorkflowFamilyCard[];
  graphPaths: Record<string, string>;
  graphs: Record<string, OysterWorkflowGraph>;
}

/**
 * CN: 将只读取 skill 的 Call 3 原始输出规范化为候选工作流。
 * EN: Normalizes raw Call 3 output into a candidate workflow using only skill identity metadata.
 * @param raw untrusted LLM JSON.
 * @param skill source skill supplied to Call 3.
 * @returns validated candidate workflow without confidence, reason, or provenance fields.
 */
export function normalizeCandidateWorkflow(
  raw: unknown,
  skill: OpenClawSkill,
): CandidateWorkflow {
  const draft = candidateWorkflowDraftSchema.parse(raw);
  const references = buildWorkflowReferenceCatalog(skill);
  const candidate: CandidateWorkflow = {
    schemaVersion: "oyster-workflow-candidate-v2",
    candidateId: `candidate.${skill.skillId}`,
    skillId: skill.skillId,
    ...draft,
    nodes: draft.nodes.map((node) => {
      const referenceRefs = buildWorkflowReferenceRefs(
        skill,
        node.referenceRefs,
      );
      const { referenceRefs: _referenceRefs, ...base } = node;
      return {
        ...base,
        ...(referenceRefs.length > 0 ? { referenceRefs } : {}),
      };
    }),
    ...(references.length > 0 ? { references } : {}),
  };
  validateCandidateWorkflow(candidate);
  return candidate;
}

/**
 * CN: 严格读取已落盘的 Call 3 Candidate artifact。
 * EN: Strictly parses a stored Call 3 Candidate artifact.
 * @param value untrusted stored JSON.
 * @returns validated Candidate workflow.
 */
export function parseCandidateWorkflow(value: unknown): CandidateWorkflow {
  const candidate = candidateWorkflowSchema.parse(value);
  validateCandidateWorkflow(candidate);
  return candidate;
}

/**
 * CN: 校验候选图的基础拓扑；候选 decision 可以只有本 case 已观察到的一条路线。
 * EN: Validates candidate topology while allowing a decision to contain only the route observed in this case.
 * @param candidate workflow candidate to validate.
 * @returns void; throws for malformed topology.
 */
export function validateCandidateWorkflow(candidate: CandidateWorkflow): void {
  validateNodeReferenceBindings(
    "Candidate workflow",
    candidate.references ?? [],
    candidate.nodes,
  );
  validateWorkflowTopology({
    graphLabel: "Candidate workflow",
    nodeLabel: "candidate workflow node",
    transitionLabel: "Candidate workflow transition",
    entryNodeId: candidate.entryNodeId,
    nodes: candidate.nodes,
    transitions: candidate.transitions,
  });
}

function validateNodeReferenceBindings(
  label: string,
  references: Array<{ id: string }>,
  nodes: Array<{ id: string; referenceRefs?: string[] }>,
): void {
  const referenceIds = new Set<string>();
  for (const reference of references) {
    if (referenceIds.has(reference.id)) {
      throw new Error(
        `${label} contains duplicate reference id: ${reference.id}`,
      );
    }
    referenceIds.add(reference.id);
  }
  for (const node of nodes) {
    const nodeRefs = node.referenceRefs ?? [];
    if (new Set(nodeRefs).size !== nodeRefs.length) {
      throw new Error(`${label} node ${node.id} repeats a reference id.`);
    }
    for (const referenceId of nodeRefs) {
      if (!referenceIds.has(referenceId)) {
        throw new Error(
          `${label} node ${node.id} references unknown Reference: ${referenceId}`,
        );
      }
    }
  }
}

/**
 * CN: 从 canonical graph 确定性生成供 Call 4 使用的紧凑 Family Card。
 * EN: Deterministically builds a compact Call 4 family card from a canonical graph.
 * @param graph canonical workflow graph.
 * @param whenToUse optional trigger descriptions from a companion skill.
 * @returns compact workflow family card.
 */
export function buildWorkflowFamilyCard(
  graph: OysterWorkflowGraph,
  whenToUse: string[] = [],
): WorkflowFamilyCard {
  const nodes: WorkflowGraphNode[] = graph.nodes;
  return {
    workflowId: graph.workflowId,
    name: graph.name,
    goal: graph.goal,
    whenToUse: [...whenToUse],
    outline: nodes.map((node) => describeWorkflowNode(node)),
    terminalOutcomes: nodes
      .filter(
        (node): node is Extract<WorkflowGraphNode, { type: "terminal" }> =>
          node.type === "terminal",
      )
      .map((node) => node.outcome),
    apps: Array.from(
      new Set(
        nodes
          .filter(
            (node): node is Extract<WorkflowGraphNode, { type: "action" }> =>
              node.type === "action",
          )
          .map((node) => node.operationApp),
      ),
    ),
  };
}

/**
 * CN: 严格读取显式提供的 Workflow Family catalog。
 * EN: Strictly loads an explicitly supplied workflow family catalog.
 * @param path absolute catalog JSON path.
 * @returns validated catalog.
 */
export async function loadWorkflowFamilyCatalog(
  path: string,
): Promise<LoadedWorkflowFamilyCatalog> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(
      `Failed to read workflow family catalog at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const catalog = workflowFamilyCatalogSchema.parse(parsed);
  if (catalog.schemaVersion === WORKFLOW_FAMILY_CATALOG_SCHEMA_VERSION) {
    return {
      schemaVersion: catalog.schemaVersion,
      families: catalog.families,
      graphPaths: {},
      graphs: {},
    };
  }
  const graphEntries = await Promise.all(
    catalog.families.map(async (family) => {
      const graphPath = resolve(dirname(path), family.graphPath);
      const graph = await loadWorkflowGraph(graphPath);
      if (graph.workflowId !== family.workflowId) {
        throw new Error(
          `Workflow family ${family.workflowId} points to graph ${graph.workflowId} at ${graphPath}.`,
        );
      }
      return { family, graphPath, graph };
    }),
  );
  return {
    schemaVersion: catalog.schemaVersion,
    families: graphEntries.map(({ family }) => {
      const { graphPath: _graphPath, ...card } = family;
      return card;
    }),
    graphPaths: Object.fromEntries(
      graphEntries.map(({ family, graphPath }) => [
        family.workflowId,
        graphPath,
      ]),
    ),
    graphs: Object.fromEntries(
      graphEntries.map(({ family, graph }) => [family.workflowId, graph]),
    ),
  };
}

/**
 * CN: 将 Call 4 原始输出规范化，并保证 match 结果指向输入 catalog。
 * EN: Normalizes Call 4 output and ensures a match points into the supplied catalog.
 * @param raw untrusted LLM JSON.
 * @param candidate candidate workflow being matched.
 * @param families exact family cards shown to Call 4.
 * @returns strict match result without confidence or reason fields.
 */
export function normalizeWorkflowFamilyMatch(
  raw: unknown,
  candidate: CandidateWorkflow,
  families: WorkflowFamilyCard[],
): WorkflowFamilyMatch {
  const draft = workflowFamilyMatchDraftSchema.parse(raw);
  if (draft.decision === "match") {
    if (!draft.matchedWorkflowId) {
      throw new Error("Workflow family match requires matchedWorkflowId.");
    }
    if (
      !families.some((family) => family.workflowId === draft.matchedWorkflowId)
    ) {
      throw new Error(
        `Workflow family match references an unknown workflow: ${draft.matchedWorkflowId}`,
      );
    }
  } else if (draft.matchedWorkflowId !== null) {
    throw new Error(
      `${draft.decision} workflow family result must set matchedWorkflowId to null.`,
    );
  }
  return {
    schemaVersion: "oyster-workflow-family-match-v1",
    candidateId: candidate.candidateId,
    ...draft,
  };
}

/**
 * CN: 空 catalog 无需调用 LLM，直接确定为新 family。
 * EN: Resolves an empty catalog as a new family without spending an LLM call.
 * @param candidate candidate workflow.
 * @returns deterministic new-family result.
 */
export function buildEmptyCatalogMatch(
  candidate: CandidateWorkflow,
): WorkflowFamilyMatch {
  return {
    schemaVersion: "oyster-workflow-family-match-v1",
    candidateId: candidate.candidateId,
    decision: "new_family",
    matchedWorkflowId: null,
  };
}

/**
 * CN: 构建只包含 skill JSON 的 Call 3 prompt。
 * EN: Builds the Call 3 prompt whose only business input is the skill JSON.
 * @param skill source skill.
 * @param promptSet active prompt set.
 * @returns rendered system and user prompts.
 */
export function buildCandidateWorkflowPrompt(
  skill: OpenClawSkill,
  promptSet: LoadedPromptSet,
): WorkflowLearningPromptPayload {
  const section = promptSet.workflowCandidateGeneration;
  if (!section) {
    throw new Error(
      `Prompt set ${promptSet.promptSet} does not define workflowCandidateGeneration.`,
    );
  }
  return {
    systemPrompt: renderPromptTemplate(section.system, {}),
    userPrompt: `${renderPromptTemplate(section.userPreamble, {})}\n\nSkill JSON:\n${JSON.stringify(skill, null, 2)}`,
  };
}

/**
 * CN: 构建只包含 candidate 和紧凑 family cards 的 Call 4 prompt。
 * EN: Builds the Call 4 prompt from one candidate and compact family cards.
 * @param candidate candidate workflow.
 * @param families family cards selected for comparison.
 * @param promptSet active prompt set.
 * @returns rendered system and user prompts.
 */
export function buildWorkflowFamilyMatchPrompt(
  candidate: CandidateWorkflow,
  families: WorkflowFamilyCard[],
  promptSet: LoadedPromptSet,
): WorkflowLearningPromptPayload {
  const section = promptSet.workflowFamilyMatching;
  if (!section) {
    throw new Error(
      `Prompt set ${promptSet.promptSet} does not define workflowFamilyMatching.`,
    );
  }
  return {
    systemPrompt: renderPromptTemplate(section.system, {}),
    userPrompt: `${renderPromptTemplate(section.userPreamble, {})}\n\nCandidate workflow:\n${JSON.stringify(candidate, null, 2)}\n\nWorkflow family cards:\n${JSON.stringify(families, null, 2)}`,
  };
}

function describeWorkflowNode(node: WorkflowGraphNode): string {
  if (node.type === "action") {
    return `[action] ${node.objective}`;
  }
  if (node.type === "decision") {
    return `[decision] ${node.decision}`;
  }
  if (node.type === "wait") {
    return `[wait] ${node.waitFor}`;
  }
  return `[terminal:${node.outcome}] ${node.summary}`;
}
