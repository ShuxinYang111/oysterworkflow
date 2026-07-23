import { createHash } from "node:crypto";
import { z } from "zod";
import { stableStringify } from "../io/stable-json.js";
import type {
  CandidateWorkflow,
  OpenClawSkill,
  OysterWorkflowGraph,
  OysterWorkflowGraphDraftV2,
  WorkflowGraphNodeV2,
  WorkflowGraphSourceRef,
  WorkflowGraphTransition,
  WorkflowMergeMappingDisposition,
  WorkflowMergeNodeMapping,
  WorkflowMergeProposal,
  WorkflowMergeTransitionMapping,
} from "../types/contracts.js";
import {
  parseWorkflowGraphDraft,
  persistWorkflowGraphDraft,
  toWorkflowGraphDraft,
  type MaterializeWorkflowGraphResult,
} from "./workflow-graph.js";
import {
  renderPromptTemplate,
  type LoadedPromptSet,
} from "./prompt-registry.js";

export const WORKFLOW_MERGE_PROPOSAL_FILE_NAME = "workflow-merge-proposal.json";
export const WORKFLOW_MERGE_PROPOSAL_SCHEMA_VERSION =
  "oyster-workflow-merge-proposal-v1" as const;

const nonEmptyString = z.string().trim().min(1);
const mappingDispositionSchema = z.enum([
  "reuse",
  "adjust",
  "add",
  "merge",
  "split",
]);
const rawNodeMappingSchema = z
  .object({
    candidateNodeId: nonEmptyString,
    mergedNodeIds: z.array(nonEmptyString).min(1),
    disposition: mappingDispositionSchema,
  })
  .strict();
const rawTransitionMappingSchema = z
  .object({
    candidateTransitionId: nonEmptyString,
    mergedTransitionIds: z.array(nonEmptyString).min(1),
    disposition: mappingDispositionSchema,
  })
  .strict();
const rawMergeProposalSchema = z
  .object({
    result: z.enum(["merge", "no_change", "incompatible"]),
    mergedGraph: z.unknown().nullable(),
    nodeMappings: z.array(rawNodeMappingSchema),
    transitionMappings: z.array(rawTransitionMappingSchema),
  })
  .strict();
const storedMergeProposalSchema = rawMergeProposalSchema
  .extend({
    schemaVersion: z.literal(WORKFLOW_MERGE_PROPOSAL_SCHEMA_VERSION),
    proposalId: nonEmptyString,
    candidateId: nonEmptyString,
    baseWorkflowId: nonEmptyString,
    baseRevisionId: nonEmptyString,
    proposalHash: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: nonEmptyString,
  })
  .strict();

export interface WorkflowMergePromptPayload {
  systemPrompt: string;
  userPrompt: string;
}

/**
 * CN: 把通过 Call 3 校验的新 Candidate 提升为首个 canonical graph draft。
 * EN: Promotes a validated new-family Candidate into its first canonical graph draft.
 * @param candidate Call 3 candidate graph.
 * @param skill source skill used to generate the candidate.
 * @returns canonical v2 draft with deterministic provenance.
 */
export function buildWorkflowGraphDraftFromCandidate(
  candidate: CandidateWorkflow,
  skill: OpenClawSkill,
): OysterWorkflowGraphDraftV2 {
  if (candidate.skillId !== skill.skillId) {
    throw new Error(
      `Candidate skill mismatch: expected ${skill.skillId}, received ${candidate.skillId}.`,
    );
  }
  const sourceRefs = sourceRefsForSkill(skill);
  const nodes: WorkflowGraphNodeV2[] = candidate.nodes.map((node) => {
    if (node.type === "action") {
      return { ...node, sourceRefs: [...sourceRefs] };
    }
    if (node.type === "decision") {
      return { ...node, sourceRefs: [...sourceRefs] };
    }
    if (node.type === "wait") {
      return { ...node, sourceRefs: [...sourceRefs] };
    }
    if (!isCanonicalTerminalOutcome(node.outcome)) {
      throw new Error(
        `Candidate terminal ${node.id} uses unsupported outcome ${node.outcome}. Use completed, stopped, rejected, or failed.`,
      );
    }
    return { ...node, outcome: node.outcome, sourceRefs: [...sourceRefs] };
  });
  const transitions: WorkflowGraphTransition[] = candidate.transitions.map(
    (transition) => ({ ...transition, sourceRefs: [...sourceRefs] }),
  );
  const draft: OysterWorkflowGraphDraftV2 = {
    schemaVersion: "oyster-workflow-graph-v2",
    workflowId: `workflow.${skill.skillId}`,
    name: candidate.name,
    goal: candidate.goal,
    entryNodeId: candidate.entryNodeId,
    nodes,
    transitions,
    ...(candidate.references && candidate.references.length > 0
      ? {
          references: candidate.references.map((reference) => ({
            ...reference,
          })),
        }
      : {}),
    source: {
      skillId: skill.skillId,
      skillSchemaVersion: skill.schemaVersion,
      skillGeneratedAt: skill.generatedAt,
      promptSet: skill.promptSet,
      runId: skill.source.runId,
      runDir: skill.source.runDir,
      episodeId: skill.source.episodeId,
    },
  };
  return parseWorkflowGraphDraft(
    draft,
    `Promoted candidate ${candidate.candidateId}`,
  ) as OysterWorkflowGraphDraftV2;
}

/**
 * CN: 构建 Call 5 prompt，只包含完整 canonical graph 与 Call 3 Candidate。
 * EN: Builds the Call 5 prompt from the full canonical graph and Call 3 Candidate.
 * @param canonicalGraph matched family graph with revision metadata.
 * @param candidate candidate graph for the new case.
 * @param promptSet active prompt set.
 * @returns rendered system and user prompts.
 */
export function buildWorkflowMergePrompt(
  canonicalGraph: OysterWorkflowGraph,
  candidate: CandidateWorkflow,
  promptSet: LoadedPromptSet,
): WorkflowMergePromptPayload {
  const section = promptSet.workflowMergeProposal;
  if (!section) {
    throw new Error(
      `Prompt set ${promptSet.promptSet} does not define workflowMergeProposal.`,
    );
  }
  return {
    systemPrompt: renderPromptTemplate(section.system, {}),
    userPrompt: `${renderPromptTemplate(section.userPreamble, {})}\n\nCanonical workflow graph:\n${JSON.stringify(toCurrentGraphDraft(canonicalGraph), null, 2)}\n\nCandidate workflow graph:\n${JSON.stringify(candidate, null, 2)}`,
  };
}

/**
 * CN: 解析并验证 Call 5 输出，补充新 case provenance，形成不可直接覆盖 canonical 的 proposal。
 * EN: Validates Call 5 output, adds case provenance, and produces a version-bound proposal.
 * @param raw untrusted LLM output.
 * @param candidate Call 3 candidate.
 * @param canonicalGraph matched canonical graph.
 * @param skill source skill for the new case.
 * @param now deterministic clock for tests.
 * @returns strict merge proposal.
 */
export function normalizeWorkflowMergeProposal(input: {
  raw: unknown;
  candidate: CandidateWorkflow;
  canonicalGraph: OysterWorkflowGraph;
  skill: OpenClawSkill;
  now?: Date;
}): WorkflowMergeProposal {
  const rawProposal = rawMergeProposalSchema.parse(
    normalizeWorkflowMergeOutputAliases(input.raw),
  );
  if (rawProposal.result === "incompatible") {
    if (
      rawProposal.mergedGraph !== null ||
      rawProposal.nodeMappings.length > 0 ||
      rawProposal.transitionMappings.length > 0
    ) {
      throw new Error(
        "Incompatible workflow merge must return null mergedGraph and empty mappings.",
      );
    }
    return finalizeProposal({
      candidateId: input.candidate.candidateId,
      baseWorkflowId: input.canonicalGraph.workflowId,
      baseRevisionId: input.canonicalGraph.revision.revisionId,
      result: "incompatible",
      mergedGraph: null,
      nodeMappings: [],
      transitionMappings: [],
      createdAt: (input.now ?? new Date()).toISOString(),
    });
  }
  if (rawProposal.mergedGraph === null) {
    throw new Error(
      `${rawProposal.result} workflow merge requires a complete mergedGraph.`,
    );
  }
  const parsedDraft = parseWorkflowGraphDraft(
    rawProposal.mergedGraph,
    "Call 5 mergedGraph",
  );
  if (parsedDraft.schemaVersion !== "oyster-workflow-graph-v2") {
    throw new Error("Call 5 mergedGraph must use oyster-workflow-graph-v2.");
  }
  const baseDraft = toCurrentGraphDraft(input.canonicalGraph);
  assertMergedGraphIdentity(parsedDraft, baseDraft);
  assertBaseStableNodesAndRoutesPreserved(parsedDraft, baseDraft);
  assertReferenceStatePreservedBeforeMapping(parsedDraft, baseDraft);
  assertNoDuplicateConditionalRoutes(parsedDraft.transitions);
  validateNodeMappings(
    rawProposal.nodeMappings,
    input.candidate,
    baseDraft,
    parsedDraft,
  );
  validateTransitionMappings(
    rawProposal.transitionMappings,
    input.candidate,
    baseDraft,
    parsedDraft,
  );
  if (
    rawProposal.result === "no_change" &&
    stableStringify(parsedDraft) !== stableStringify(baseDraft)
  ) {
    throw new Error(
      "no_change mergedGraph must equal the base graph before provenance is appended.",
    );
  }
  if (
    rawProposal.result === "no_change" &&
    [...rawProposal.nodeMappings, ...rawProposal.transitionMappings].some(
      (mapping) =>
        mapping.disposition === "adjust" || mapping.disposition === "add",
    )
  ) {
    throw new Error("no_change mappings cannot use adjust or add.");
  }
  const mergedGraph = parseWorkflowGraphDraft(
    appendCaseProvenance({
      draft: parsedDraft,
      candidate: input.candidate,
      nodeMappings: rawProposal.nodeMappings,
      transitionMappings: rawProposal.transitionMappings,
      sourceRefs: sourceRefsForSkill(input.skill),
    }),
    "Call 5 mergedGraph with mapped References",
  ) as OysterWorkflowGraphDraftV2;
  return finalizeProposal({
    candidateId: input.candidate.candidateId,
    baseWorkflowId: input.canonicalGraph.workflowId,
    baseRevisionId: input.canonicalGraph.revision.revisionId,
    result: rawProposal.result,
    mergedGraph,
    nodeMappings: rawProposal.nodeMappings,
    transitionMappings: rawProposal.transitionMappings,
    createdAt: (input.now ?? new Date()).toISOString(),
  });
}

/**
 * CN: 严格读取已落盘的 Call 5 proposal 并验证 proposal hash 与 merged graph。
 * EN: Strictly parses a stored Call 5 proposal and verifies its hash and graph.
 * @param value untrusted stored JSON.
 * @returns validated merge proposal.
 */
export function parseWorkflowMergeProposal(
  value: unknown,
): WorkflowMergeProposal {
  const parsed = storedMergeProposalSchema.parse(value);
  const mergedGraph =
    parsed.mergedGraph === null
      ? null
      : (parseWorkflowGraphDraft(
          parsed.mergedGraph,
          "Stored workflow merge proposal",
        ) as OysterWorkflowGraphDraftV2);
  const proposal = { ...parsed, mergedGraph } as WorkflowMergeProposal;
  const expectedHash = hashProposalContent(proposalContent(proposal));
  if (proposal.proposalHash !== expectedHash) {
    throw new Error(
      `Workflow merge proposal hash mismatch: expected ${expectedHash}, received ${proposal.proposalHash}.`,
    );
  }
  const expectedProposalId = buildProposalId(
    proposal.baseWorkflowId,
    expectedHash,
  );
  if (proposal.proposalId !== expectedProposalId) {
    throw new Error(
      `Workflow merge proposal id mismatch: expected ${expectedProposalId}, received ${proposal.proposalId}.`,
    );
  }
  if (proposal.result === "incompatible") {
    if (
      proposal.mergedGraph !== null ||
      proposal.nodeMappings.length > 0 ||
      proposal.transitionMappings.length > 0
    ) {
      throw new Error(
        "Incompatible workflow merge must return null mergedGraph and empty mappings.",
      );
    }
  } else if (!proposal.mergedGraph) {
    throw new Error(
      `${proposal.result} workflow merge requires a complete mergedGraph.`,
    );
  } else if (proposal.mergedGraph.workflowId !== proposal.baseWorkflowId) {
    throw new Error(
      "Stored workflow merge proposal must preserve baseWorkflowId in mergedGraph.",
    );
  }
  return proposal;
}

/**
 * CN: 在调用方明确接受 proposal 后，绑定 base revision 并写入 canonical revision store。
 * EN: Applies an explicitly accepted proposal after checking its base revision binding.
 * @param proposal validated proposal.
 * @param currentGraph current canonical graph on disk.
 * @param outDir canonical family directory.
 * @param sourceSkillPath optional review link target.
 * @param now deterministic clock for tests.
 * @returns persisted canonical graph artifacts.
 */
export async function applyWorkflowMergeProposal(input: {
  proposal: WorkflowMergeProposal;
  currentGraph: OysterWorkflowGraph;
  outDir: string;
  sourceSkillPath?: string;
  now?: Date;
}): Promise<MaterializeWorkflowGraphResult> {
  const proposal = parseWorkflowMergeProposal(input.proposal);
  if (proposal.result === "incompatible" || !proposal.mergedGraph) {
    throw new Error("An incompatible workflow proposal cannot be applied.");
  }
  if (
    input.currentGraph.workflowId !== proposal.baseWorkflowId ||
    input.currentGraph.revision.revisionId !== proposal.baseRevisionId
  ) {
    throw new Error(
      "Workflow merge proposal is stale because the canonical revision changed.",
    );
  }
  const currentDraft = toCurrentGraphDraft(input.currentGraph);
  assertMergedGraphIdentity(proposal.mergedGraph, currentDraft);
  assertBaseStableNodesAndRoutesPreserved(proposal.mergedGraph, currentDraft);
  assertNoDuplicateConditionalRoutes(proposal.mergedGraph.transitions);
  return persistWorkflowGraphDraft({
    draft: proposal.mergedGraph,
    outDir: input.outDir,
    sourceSkillPath: input.sourceSkillPath,
    now: input.now,
    expectedRevisionId: proposal.baseRevisionId,
  });
}

/**
 * CN: 仅在 Call 5 边界兼容模型常见且无歧义的条件与单目标 mapping 别名。
 * EN: Accepts common unambiguous condition and single-target mapping aliases only at the Call 5 boundary.
 * @param value untrusted Call 5 JSON output.
 * @returns a copied value using the canonical Call 5 contract.
 */
function normalizeWorkflowMergeOutputAliases(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  const normalizeMapping = (
    mapping: unknown,
    canonicalKey: "mergedNodeIds" | "mergedTransitionIds",
    aliasKey: "targetNodeId" | "targetTransitionId",
  ): unknown => {
    if (
      !isRecord(mapping) ||
      mapping[canonicalKey] !== undefined ||
      typeof mapping[aliasKey] !== "string" ||
      mapping[aliasKey].trim().length === 0
    ) {
      return mapping;
    }
    const aliasTarget = mapping[aliasKey] as string;
    const { [aliasKey]: _removedAlias, ...normalized } = mapping;
    return { ...normalized, [canonicalKey]: [aliasTarget.trim()] };
  };
  const normalizedNodeMappings = Array.isArray(value.nodeMappings)
    ? value.nodeMappings.map((mapping) =>
        normalizeMapping(mapping, "mergedNodeIds", "targetNodeId"),
      )
    : value.nodeMappings;
  const normalizedTransitionMappings = Array.isArray(value.transitionMappings)
    ? value.transitionMappings.map((mapping) =>
        normalizeMapping(mapping, "mergedTransitionIds", "targetTransitionId"),
      )
    : value.transitionMappings;
  if (!isRecord(value.mergedGraph)) {
    return {
      ...value,
      nodeMappings: normalizedNodeMappings,
      transitionMappings: normalizedTransitionMappings,
    };
  }
  const transitions = value.mergedGraph.transitions;
  return {
    ...value,
    nodeMappings: normalizedNodeMappings,
    transitionMappings: normalizedTransitionMappings,
    mergedGraph: {
      ...value.mergedGraph,
      ...(Array.isArray(transitions)
        ? {
            transitions: transitions.map((transition) => {
              if (
                !isRecord(transition) ||
                transition.when !== undefined ||
                typeof transition.condition !== "string" ||
                !["conditional", "resume", "retry"].includes(
                  String(transition.type),
                )
              ) {
                return transition;
              }
              const { condition, ...normalized } = transition;
              return { ...normalized, when: condition };
            }),
          }
        : {}),
    },
  };
}

function toCurrentGraphDraft(
  graph: OysterWorkflowGraph,
): OysterWorkflowGraphDraftV2 {
  const draft = toWorkflowGraphDraft(graph);
  if (draft.schemaVersion === "oyster-workflow-graph-v2") {
    return draft;
  }
  return {
    ...draft,
    schemaVersion: "oyster-workflow-graph-v2",
    nodes: draft.nodes.map((node) => {
      if (node.type === "action") {
        const { observe: _observe, verify: _verify, ...current } = node;
        return current;
      }
      if (node.type === "decision") {
        const { observe: _observe, ...current } = node;
        return current;
      }
      return node;
    }),
  };
}

function assertMergedGraphIdentity(
  merged: OysterWorkflowGraphDraftV2,
  base: OysterWorkflowGraphDraftV2,
): void {
  if (merged.workflowId !== base.workflowId) {
    throw new Error("Call 5 must preserve canonical workflowId.");
  }
  if (stableStringify(merged.source) !== stableStringify(base.source)) {
    throw new Error("Call 5 must preserve canonical graph source metadata.");
  }
}

function assertBaseStableNodesAndRoutesPreserved(
  merged: OysterWorkflowGraphDraftV2,
  base: OysterWorkflowGraphDraftV2,
): void {
  const mergedNodes = new Map(merged.nodes.map((node) => [node.id, node]));
  for (const baseNode of base.nodes) {
    const mergedNode = mergedNodes.get(baseNode.id);
    if (!mergedNode) {
      throw new Error(
        `Call 5 must preserve existing stable node id: ${baseNode.id}`,
      );
    }
    if (mergedNode.type !== baseNode.type) {
      throw new Error(
        `Call 5 cannot change existing node type for ${baseNode.id}.`,
      );
    }
  }
  const mergedTransitionIds = new Set(
    merged.transitions.map((transition) => transition.id),
  );
  for (const transition of base.transitions) {
    if (!mergedTransitionIds.has(transition.id)) {
      throw new Error(
        `Call 5 must preserve existing stable transition id: ${transition.id}`,
      );
    }
  }
}

function assertReferenceStatePreservedBeforeMapping(
  merged: OysterWorkflowGraphDraftV2,
  base: OysterWorkflowGraphDraftV2,
): void {
  if (
    stableStringify(merged.references ?? []) !==
    stableStringify(base.references ?? [])
  ) {
    throw new Error(
      "Call 5 must preserve the canonical Reference catalog before code applies Candidate mappings.",
    );
  }
  const baseNodeById = new Map(base.nodes.map((node) => [node.id, node]));
  for (const node of merged.nodes) {
    const baseNode = baseNodeById.get(node.id);
    const expectedRefs = baseNode?.referenceRefs ?? [];
    if (
      stableStringify(node.referenceRefs ?? []) !==
      stableStringify(expectedRefs)
    ) {
      throw new Error(
        `Call 5 must preserve Reference bindings for node ${node.id} before code applies Candidate mappings.`,
      );
    }
  }
}

function assertNoDuplicateConditionalRoutes(
  transitions: WorkflowGraphTransition[],
): void {
  const routeKeys = new Set<string>();
  for (const transition of transitions) {
    if (transition.type !== "conditional") continue;
    const key = `${transition.from}\u0000${normalizeComparableText(transition.when)}`;
    if (routeKeys.has(key)) {
      throw new Error(
        `Call 5 produced duplicate conditional routes from ${transition.from}: ${transition.when}`,
      );
    }
    routeKeys.add(key);
  }
}

function validateNodeMappings(
  mappings: WorkflowMergeNodeMapping[],
  candidate: CandidateWorkflow,
  base: OysterWorkflowGraphDraftV2,
  merged: OysterWorkflowGraphDraftV2,
): void {
  validateMappingCoverage({
    mappings,
    candidateIds: candidate.nodes.map((node) => node.id),
    sourceId: (mapping) => mapping.candidateNodeId,
    targetIds: (mapping) => mapping.mergedNodeIds,
    disposition: (mapping) => mapping.disposition,
    baseIds: new Set(base.nodes.map((node) => node.id)),
    mergedIds: new Set(merged.nodes.map((node) => node.id)),
    label: "node",
  });
}

function validateTransitionMappings(
  mappings: WorkflowMergeTransitionMapping[],
  candidate: CandidateWorkflow,
  base: OysterWorkflowGraphDraftV2,
  merged: OysterWorkflowGraphDraftV2,
): void {
  validateMappingCoverage({
    mappings,
    candidateIds: candidate.transitions.map((transition) => transition.id),
    sourceId: (mapping) => mapping.candidateTransitionId,
    targetIds: (mapping) => mapping.mergedTransitionIds,
    disposition: (mapping) => mapping.disposition,
    baseIds: new Set(base.transitions.map((transition) => transition.id)),
    mergedIds: new Set(merged.transitions.map((transition) => transition.id)),
    label: "transition",
  });
}

function validateMappingCoverage<T>(input: {
  mappings: T[];
  candidateIds: string[];
  sourceId: (mapping: T) => string;
  targetIds: (mapping: T) => string[];
  disposition: (mapping: T) => WorkflowMergeMappingDisposition;
  baseIds: Set<string>;
  mergedIds: Set<string>;
  label: "node" | "transition";
}): void {
  const expected = new Set(input.candidateIds);
  const seen = new Set<string>();
  const targetUse = new Map<string, T[]>();
  for (const mapping of input.mappings) {
    const sourceId = input.sourceId(mapping);
    if (!expected.has(sourceId)) {
      throw new Error(
        `Call 5 maps unknown candidate ${input.label}: ${sourceId}`,
      );
    }
    if (seen.has(sourceId)) {
      throw new Error(
        `Call 5 maps candidate ${input.label} more than once: ${sourceId}`,
      );
    }
    seen.add(sourceId);
    const targetIds = input.targetIds(mapping);
    if (new Set(targetIds).size !== targetIds.length) {
      throw new Error(`Call 5 mapping repeats a merged ${input.label} id.`);
    }
    for (const targetId of targetIds) {
      if (!input.mergedIds.has(targetId)) {
        throw new Error(
          `Call 5 mapping references missing merged ${input.label}: ${targetId}`,
        );
      }
      const uses = targetUse.get(targetId) ?? [];
      uses.push(mapping);
      targetUse.set(targetId, uses);
    }
    const disposition = input.disposition(mapping);
    if (disposition === "split" && targetIds.length < 2) {
      throw new Error(`Call 5 split mapping requires multiple targets.`);
    }
    if (disposition !== "split" && targetIds.length !== 1) {
      throw new Error(
        `Call 5 ${disposition} mapping requires exactly one target.`,
      );
    }
    const targetId = targetIds[0];
    if (
      (disposition === "reuse" || disposition === "adjust") &&
      targetId &&
      !input.baseIds.has(targetId)
    ) {
      throw new Error(
        `Call 5 ${disposition} mapping must target an existing ${input.label}.`,
      );
    }
    if (disposition === "add" && targetId && input.baseIds.has(targetId)) {
      throw new Error(
        `Call 5 add mapping must target a new ${input.label} id.`,
      );
    }
  }
  const missing = [...expected].filter((id) => !seen.has(id));
  if (missing.length > 0) {
    throw new Error(
      `Call 5 must map every candidate ${input.label}: ${missing.join(", ")}`,
    );
  }
  for (const [targetId, uses] of targetUse) {
    if (uses.length < 2) continue;
    if (uses.some((mapping) => input.disposition(mapping) === "split")) {
      continue;
    }
    if (uses.some((mapping) => input.disposition(mapping) !== "merge")) {
      throw new Error(
        `Many-to-one ${input.label} mapping for ${targetId} must use merge disposition.`,
      );
    }
  }
  for (const mapping of input.mappings) {
    if (input.disposition(mapping) !== "merge") continue;
    const targetId = input.targetIds(mapping)[0];
    if (!targetId || (targetUse.get(targetId)?.length ?? 0) < 2) {
      throw new Error(
        `Call 5 merge mapping requires multiple candidate ${input.label}s to share one target.`,
      );
    }
  }
}

function appendCaseProvenance(input: {
  draft: OysterWorkflowGraphDraftV2;
  candidate: CandidateWorkflow;
  nodeMappings: WorkflowMergeNodeMapping[];
  transitionMappings: WorkflowMergeTransitionMapping[];
  sourceRefs: WorkflowGraphSourceRef[];
}): OysterWorkflowGraphDraftV2 {
  const mappedNodeIds = new Set(
    input.nodeMappings.flatMap((mapping) => mapping.mergedNodeIds),
  );
  const mappedTransitionIds = new Set(
    input.transitionMappings.flatMap((mapping) => mapping.mergedTransitionIds),
  );
  const referenceRefsByMergedNodeId = new Map<string, string[]>();
  const candidateNodeById = new Map(
    input.candidate.nodes.map((node) => [node.id, node]),
  );
  for (const mapping of input.nodeMappings) {
    const candidateNode = candidateNodeById.get(mapping.candidateNodeId);
    if (!candidateNode) continue;
    for (const mergedNodeId of mapping.mergedNodeIds) {
      referenceRefsByMergedNodeId.set(
        mergedNodeId,
        mergeStringIds(
          referenceRefsByMergedNodeId.get(mergedNodeId) ?? [],
          candidateNode.referenceRefs ?? [],
        ),
      );
    }
  }
  const mergedReferences = mergeWorkflowReferences(
    input.draft.references ?? [],
    input.candidate.references ?? [],
  );
  return {
    ...input.draft,
    ...(mergedReferences.length > 0 ? { references: mergedReferences } : {}),
    nodes: input.draft.nodes.map((node) => {
      if (!mappedNodeIds.has(node.id)) return node;
      const referenceRefs = mergeStringIds(
        node.referenceRefs ?? [],
        referenceRefsByMergedNodeId.get(node.id) ?? [],
      );
      return {
        ...node,
        ...(referenceRefs.length > 0 ? { referenceRefs } : {}),
        sourceRefs: mergeSourceRefs(node.sourceRefs, input.sourceRefs),
      };
    }),
    transitions: input.draft.transitions.map((transition) =>
      mappedTransitionIds.has(transition.id)
        ? {
            ...transition,
            sourceRefs: mergeSourceRefs(
              transition.sourceRefs,
              input.sourceRefs,
            ),
          }
        : transition,
    ),
  };
}

function mergeWorkflowReferences(
  current: NonNullable<OysterWorkflowGraphDraftV2["references"]>,
  additions: NonNullable<CandidateWorkflow["references"]>,
): NonNullable<OysterWorkflowGraphDraftV2["references"]> {
  const merged = new Map(current.map((reference) => [reference.id, reference]));
  for (const reference of additions) {
    const existing = merged.get(reference.id);
    if (existing && stableStringify(existing) !== stableStringify(reference)) {
      throw new Error(
        `Workflow Reference ID collision with different content: ${reference.id}`,
      );
    }
    if (!existing) merged.set(reference.id, reference);
  }
  return [...merged.values()];
}

function mergeStringIds(current: string[], additions: string[]): string[] {
  return [...new Set([...current, ...additions])];
}

function sourceRefsForSkill(skill: OpenClawSkill): WorkflowGraphSourceRef[] {
  return [
    { kind: "skill", ref: `skill:${skill.skillId}`, label: skill.skillName },
    {
      kind: "episode",
      ref: `episode:${skill.source.runId}:${skill.source.episodeId}`,
      label: skill.source.episodeId,
    },
  ];
}

function mergeSourceRefs(
  current: WorkflowGraphSourceRef[],
  additions: WorkflowGraphSourceRef[],
): WorkflowGraphSourceRef[] {
  const result = [...current];
  const seen = new Set(current.map(sourceRefIdentity));
  for (const sourceRef of additions) {
    const identity = sourceRefIdentity(sourceRef);
    if (seen.has(identity)) continue;
    result.push(sourceRef);
    seen.add(identity);
  }
  return result;
}

function sourceRefIdentity(sourceRef: WorkflowGraphSourceRef): string {
  return `${sourceRef.kind}\u0000${sourceRef.ref}`;
}

function finalizeProposal(
  content: Omit<
    WorkflowMergeProposal,
    "schemaVersion" | "proposalId" | "proposalHash"
  >,
): WorkflowMergeProposal {
  const proposalHash = hashProposalContent(content);
  return {
    schemaVersion: WORKFLOW_MERGE_PROPOSAL_SCHEMA_VERSION,
    proposalId: buildProposalId(content.baseWorkflowId, proposalHash),
    ...content,
    proposalHash,
  };
}

function buildProposalId(baseWorkflowId: string, proposalHash: string): string {
  return `proposal.${baseWorkflowId}.${proposalHash.slice(0, 12)}`;
}

function proposalContent(
  proposal: WorkflowMergeProposal,
): Omit<
  WorkflowMergeProposal,
  "schemaVersion" | "proposalId" | "proposalHash"
> {
  const {
    schemaVersion: _schemaVersion,
    proposalId: _proposalId,
    proposalHash: _proposalHash,
    ...content
  } = proposal;
  return content;
}

function hashProposalContent(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function normalizeComparableText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function isCanonicalTerminalOutcome(
  value: string,
): value is "completed" | "stopped" | "rejected" | "failed" {
  return ["completed", "stopped", "rejected", "failed"].includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
