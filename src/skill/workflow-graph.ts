import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { z } from "zod";
import { stableStringify } from "../io/stable-json.js";
import type {
  OpenClawSkill,
  OysterWorkflowGraph,
  OysterWorkflowGraphDraft,
  WorkflowGraphNodeV2,
  WorkflowGraphNode,
  WorkflowGraphSourceRef,
  WorkflowGraphTransition,
} from "../types/contracts.js";
import { validateWorkflowTopology } from "./workflow-topology.js";
import {
  buildWorkflowReferenceCatalog,
  buildWorkflowReferenceRefs,
} from "./workflow-references.js";

export const WORKFLOW_GRAPH_SCHEMA_VERSION =
  "oyster-workflow-graph-v2" as const;
export const LEGACY_WORKFLOW_GRAPH_SCHEMA_VERSION =
  "oyster-workflow-graph-v1" as const;
export const WORKFLOW_GRAPH_FILE_NAME = "workflow.json";
export const WORKFLOW_GRAPH_MARKDOWN_FILE_NAME = "WORKFLOW.md";
export const WORKFLOW_GRAPH_REVISIONS_DIRECTORY = ".workflow-revisions";

const workflowGraphSourceRefSchema = z
  .object({
    kind: z.enum(["skill", "skill-step", "episode"]),
    ref: z.string().min(1),
    label: z.string().optional(),
  })
  .strict();
const workflowGraphReferenceValueSchema = z.union([
  z.string().min(1),
  z.array(z.string().min(1)).min(1),
  z.record(z.string(), z.string().min(1)),
]);
const workflowGraphReferenceSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    value: workflowGraphReferenceValueSchema,
    notes: z.string().min(1).optional(),
  })
  .strict();
const workflowGraphNodeBaseSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    title: z.string().min(1),
    hints: z.array(z.string()),
    sourceRefs: z.array(workflowGraphSourceRefSchema),
    referenceRefs: z.array(z.string().min(1)).optional(),
  })
  .strict();
const workflowGraphNodeV2Schema = z.discriminatedUnion("type", [
  workflowGraphNodeBaseSchema.extend({
    type: z.literal("action"),
    objective: z.string().min(1),
    act: z.array(z.string().min(1)).min(1),
    operationApp: z.string().min(1),
  }),
  workflowGraphNodeBaseSchema.extend({
    type: z.literal("decision"),
    decision: z.string().min(1),
  }),
  workflowGraphNodeBaseSchema.extend({
    type: z.literal("wait"),
    waitFor: z.string().min(1),
    resumeCondition: z.string().min(1),
  }),
  workflowGraphNodeBaseSchema.extend({
    type: z.literal("terminal"),
    outcome: z.enum(["completed", "stopped", "rejected", "failed"]),
    summary: z.string().min(1),
  }),
]);
const legacyWorkflowGraphNodeV1Schema = z.discriminatedUnion("type", [
  workflowGraphNodeBaseSchema.extend({
    type: z.literal("action"),
    objective: z.string().min(1),
    observe: z.array(z.string()),
    act: z.array(z.string().min(1)).min(1),
    verify: z.array(z.string()),
    operationApp: z.string().min(1),
  }),
  workflowGraphNodeBaseSchema.extend({
    type: z.literal("decision"),
    decision: z.string().min(1),
    observe: z.array(z.string()),
  }),
  workflowGraphNodeBaseSchema.extend({
    type: z.literal("wait"),
    waitFor: z.string().min(1),
    resumeCondition: z.string().min(1),
  }),
  workflowGraphNodeBaseSchema.extend({
    type: z.literal("terminal"),
    outcome: z.enum(["completed", "stopped", "rejected", "failed"]),
    summary: z.string().min(1),
  }),
]);
const workflowGraphTransitionBaseSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    from: z.string().min(1),
    to: z.string().min(1),
    sourceRefs: z.array(workflowGraphSourceRefSchema),
  })
  .strict();
const workflowGraphTransitionSchema = z.discriminatedUnion("type", [
  workflowGraphTransitionBaseSchema.extend({ type: z.literal("default") }),
  workflowGraphTransitionBaseSchema.extend({
    type: z.literal("conditional"),
    when: z.string().min(1),
    priority: z.number().int().optional(),
  }),
  workflowGraphTransitionBaseSchema.extend({
    type: z.literal("retry"),
    when: z.string().min(1),
    maxAttempts: z.number().int().min(1),
  }),
  workflowGraphTransitionBaseSchema.extend({
    type: z.literal("resume"),
    when: z.string().min(1),
  }),
]);
const workflowGraphSourceSchema = z
  .object({
    skillId: z.string().min(1),
    skillSchemaVersion: z.literal("openclaw-skill-v1"),
    skillGeneratedAt: z.string().min(1),
    promptSet: z.string().nullable(),
    runId: z.string().min(1),
    runDir: z.string().min(1),
    episodeId: z.string().min(1),
  })
  .strict();
const workflowGraphDraftV2Schema = z
  .object({
    schemaVersion: z.literal(WORKFLOW_GRAPH_SCHEMA_VERSION),
    workflowId: z.string().min(1),
    name: z.string().min(1),
    goal: z.string().min(1),
    entryNodeId: z.string().min(1),
    nodes: z.array(workflowGraphNodeV2Schema).min(1),
    transitions: z.array(workflowGraphTransitionSchema),
    references: z.array(workflowGraphReferenceSchema).optional(),
    source: workflowGraphSourceSchema,
  })
  .strict();
const legacyWorkflowGraphDraftV1Schema = z
  .object({
    schemaVersion: z.literal(LEGACY_WORKFLOW_GRAPH_SCHEMA_VERSION),
    workflowId: z.string().min(1),
    name: z.string().min(1),
    goal: z.string().min(1),
    entryNodeId: z.string().min(1),
    nodes: z.array(legacyWorkflowGraphNodeV1Schema).min(1),
    transitions: z.array(workflowGraphTransitionSchema),
    references: z.array(workflowGraphReferenceSchema).optional(),
    source: workflowGraphSourceSchema,
  })
  .strict();
const workflowGraphRevisionSchema = z
  .object({
    number: z.number().int().min(1),
    revisionId: z.string().min(1),
    previousRevisionId: z.string().min(1).nullable(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: z.string().min(1),
  })
  .strict();
const workflowGraphDraftSchema = z.discriminatedUnion("schemaVersion", [
  legacyWorkflowGraphDraftV1Schema,
  workflowGraphDraftV2Schema,
]);
const workflowGraphSchema = z.discriminatedUnion("schemaVersion", [
  legacyWorkflowGraphDraftV1Schema.extend({
    revision: workflowGraphRevisionSchema,
  }),
  workflowGraphDraftV2Schema.extend({
    revision: workflowGraphRevisionSchema,
  }),
]);

type WorkflowGraphSemanticContent = OysterWorkflowGraphDraft;

export interface BuildWorkflowGraphOptions {
  existingGraph?: OysterWorkflowGraph | null;
  now?: Date;
}

export interface MaterializeWorkflowGraphOptions {
  skill: OpenClawSkill;
  outDir: string;
  sourceSkillPath?: string;
  now?: Date;
}

export interface PersistWorkflowGraphDraftOptions {
  draft: unknown;
  outDir: string;
  sourceSkillPath?: string;
  now?: Date;
  expectedRevisionId?: string;
}

export interface RenderWorkflowGraphProjectionOptions {
  graphPath: string;
  markdownPath?: string;
  sourceSkillPath?: string;
}

export interface MaterializeWorkflowGraphResult {
  graph: OysterWorkflowGraph;
  graphPath: string;
  markdownPath: string;
  revisionPath: string;
}

/**
 * CN: 在写入兼容 skill 前预检 canonical graph，防止非线性图被部分覆盖。
 * EN: Preflights canonical graph compatibility before writing a compatibility skill.
 * @param options candidate skill and graph artifact directory.
 * @returns resolves when the write is safe.
 */
export async function assertWorkflowGraphCompatibility(options: {
  skill: OpenClawSkill;
  outDir: string;
}): Promise<void> {
  const existingGraph = await readExistingGraph(
    join(options.outDir, WORKFLOW_GRAPH_FILE_NAME),
  );
  if (existingGraph && !isMechanicalLinearSkillGraph(existingGraph)) {
    assertSkillMatchesCanonicalGraph(options.skill, existingGraph);
  }
}

/**
 * CN: 将兼容层的线性 OpenClaw steps 机械迁移为可执行图，不推断录制中未出现的分支。
 * EN: Mechanically migrates linear OpenClaw steps into an executable graph without inventing branches.
 * @param skill source OpenClaw skill.
 * @param options existing revision and deterministic clock options.
 * @returns validated workflow graph.
 */
export function buildWorkflowGraphFromSkill(
  skill: OpenClawSkill,
  options: BuildWorkflowGraphOptions = {},
): OysterWorkflowGraph {
  assertSkillCanBecomeWorkflowGraph(skill);
  const orderedSteps = [...skill.steps].sort((left, right) => {
    return left.step - right.step;
  });
  const skillRef = buildSkillRef(skill.skillId);
  const episodeRef = buildEpisodeRef(
    skill.source.runId,
    skill.source.episodeId,
  );
  const workflowReferences = buildWorkflowReferenceCatalog(skill);
  const actionNodes: WorkflowGraphNodeV2[] = orderedSteps.map((step) => {
    const referenceRefs = buildWorkflowReferenceRefs(skill, step.referenceRefs);
    return {
      id: buildStepNodeId(step.step),
      type: "action",
      title: summarizeInstruction(step.instruction),
      objective: step.intent,
      act: [step.instruction],
      operationApp: step.operationApp,
      hints: [...step.hints],
      ...(referenceRefs.length > 0 ? { referenceRefs } : {}),
      sourceRefs: [
        {
          kind: "skill-step",
          ref: `${skillRef}#step-${step.step}`,
          label: `Skill step ${step.step}`,
        },
        {
          kind: "episode",
          ref: episodeRef,
          label: skill.source.episodeId,
        },
      ],
    };
  });
  const terminalNode: WorkflowGraphNodeV2 = {
    id: "terminal-completed",
    type: "terminal",
    title: "Workflow completed / 工作流已完成",
    outcome: "completed",
    summary:
      skill.successCriteria.join("; ") ||
      "Workflow goal completed. / 工作流目标已完成。",
    hints: [],
    sourceRefs: [
      { kind: "skill", ref: skillRef, label: skill.skillName },
      { kind: "episode", ref: episodeRef, label: skill.source.episodeId },
    ],
  };
  const nodes = [...actionNodes, terminalNode];
  const transitions = actionNodes.map<WorkflowGraphTransition>(
    (node, index) => {
      const nextNode = actionNodes[index + 1] ?? terminalNode;
      return {
        id: `transition-${node.id}-to-${nextNode.id}`,
        from: node.id,
        to: nextNode.id,
        type: "default",
        sourceRefs: [...node.sourceRefs],
      };
    },
  );
  const semanticContent: WorkflowGraphSemanticContent = {
    schemaVersion: WORKFLOW_GRAPH_SCHEMA_VERSION,
    workflowId: `workflow.${skill.skillId}`,
    name: skill.skillName,
    goal: skill.goal,
    entryNodeId: actionNodes[0].id,
    nodes,
    transitions,
    ...(workflowReferences.length > 0
      ? { references: workflowReferences }
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
  const contentHash = hashSemanticContent(semanticContent);
  const revision = resolveRevision({
    workflowId: semanticContent.workflowId,
    contentHash,
    existingGraph: options.existingGraph ?? null,
    createdAt: (options.now ?? new Date()).toISOString(),
  });
  const graph: OysterWorkflowGraph = {
    ...semanticContent,
    revision,
  };
  validateWorkflowGraph(graph);
  return graph;
}

/**
 * CN: 严格解析并校验一个带 revision 的 canonical workflow graph。
 * EN: Strictly parses and validates a revisioned canonical workflow graph.
 * @param value untrusted JSON value.
 * @param context diagnostic source label.
 * @returns validated workflow graph.
 */
export function parseWorkflowGraph(
  value: unknown,
  context = "workflow graph",
): OysterWorkflowGraph {
  const parsed = workflowGraphSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(formatSchemaError(context, parsed.error));
  }
  const graph = parsed.data as OysterWorkflowGraph;
  validateWorkflowGraph(graph);
  const expectedHash = hashSemanticContent(toWorkflowGraphDraft(graph));
  if (graph.revision.contentHash !== expectedHash) {
    throw new Error(
      `${context} content hash mismatch: expected ${expectedHash}, received ${graph.revision.contentHash}.`,
    );
  }
  return graph;
}

/**
 * CN: 解析待保存的 graph draft；revision 字段由存储层计算，输入中的同名字段会被忽略。
 * EN: Parses a graph draft; revision metadata is computed by storage and ignored from input.
 * @param value untrusted draft or full graph value.
 * @param context diagnostic source label.
 * @returns validated semantic graph content without revision metadata.
 */
export function parseWorkflowGraphDraft(
  value: unknown,
  context = "workflow graph draft",
): OysterWorkflowGraphDraft {
  const candidate =
    value && typeof value === "object" && "revision" in value
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>).filter(
            ([key]) => key !== "revision",
          ),
        )
      : value;
  const parsed = workflowGraphDraftSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(formatSchemaError(context, parsed.error));
  }
  const draft = parsed.data as OysterWorkflowGraphDraft;
  const contentHash = hashSemanticContent(draft);
  validateWorkflowGraph({
    ...draft,
    revision: {
      number: 1,
      revisionId: `${draft.workflowId}:validation:${contentHash.slice(0, 12)}`,
      previousRevisionId: null,
      contentHash,
      createdAt: "validation",
    },
  });
  return draft;
}

/**
 * CN: 从磁盘读取 canonical workflow graph，并验证 schema、拓扑和内容 hash。
 * EN: Loads a canonical workflow graph and validates schema, topology, and content hash.
 * @param graphPath absolute graph JSON path.
 * @returns validated workflow graph.
 */
export async function loadWorkflowGraph(
  graphPath: string,
): Promise<OysterWorkflowGraph> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(graphPath, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(
        `Invalid workflow graph JSON at ${graphPath}: ${error.message}`,
      );
    }
    throw error;
  }
  return parseWorkflowGraph(parsed, `Workflow graph at ${graphPath}`);
}

/**
 * CN: 校验图的引用、分支、终止状态和循环安全性。
 * EN: Validates graph references, branching, terminal states, and cycle safety.
 * @param graph workflow graph to validate.
 * @returns void; throws a diagnostic error when invalid.
 */
export function validateWorkflowGraph(graph: OysterWorkflowGraph): void {
  const schemaVersion = (graph as { schemaVersion: string }).schemaVersion;
  if (
    schemaVersion !== WORKFLOW_GRAPH_SCHEMA_VERSION &&
    schemaVersion !== LEGACY_WORKFLOW_GRAPH_SCHEMA_VERSION
  ) {
    throw new Error(`Unsupported workflow graph schema: ${schemaVersion}`);
  }
  if (graph.nodes.length === 0) {
    throw new Error("Workflow graph must contain at least one node.");
  }
  for (const node of graph.nodes) {
    assertNonEmptyIdentifier(node.id, "node");
  }
  for (const transition of graph.transitions) {
    assertNonEmptyIdentifier(transition.id, "transition");
  }
  validateGraphReferenceBindings(graph);
  validateWorkflowTopology({
    graphLabel: "Workflow graph",
    nodeLabel: "workflow node",
    transitionLabel: "Transition",
    entryNodeId: graph.entryNodeId,
    nodes: graph.nodes,
    transitions: graph.transitions,
  });
}

function validateGraphReferenceBindings(graph: OysterWorkflowGraph): void {
  const referenceIds = new Set<string>();
  for (const reference of graph.references ?? []) {
    if (referenceIds.has(reference.id)) {
      throw new Error(
        `Workflow graph contains duplicate reference id: ${reference.id}`,
      );
    }
    referenceIds.add(reference.id);
  }
  for (const node of graph.nodes) {
    const nodeRefs = node.referenceRefs ?? [];
    if (new Set(nodeRefs).size !== nodeRefs.length) {
      throw new Error(`Workflow node ${node.id} repeats a reference id.`);
    }
    for (const referenceId of nodeRefs) {
      if (!referenceIds.has(referenceId)) {
        throw new Error(
          `Workflow node ${node.id} references unknown Reference: ${referenceId}`,
        );
      }
    }
  }
}

/**
 * CN: 生成 Obsidian 可读的审查投影；执行语义仍以 workflow.json 为准。
 * EN: Renders an Obsidian-readable review projection; workflow.json remains canonical.
 * @param graph validated workflow graph.
 * @param sourceSkillPath optional source skill path displayed as a relative file link.
 * @param markdownDirectory optional projection directory used to resolve the relative source link.
 * @returns Markdown projection.
 */
export function renderWorkflowGraphMarkdown(
  graph: OysterWorkflowGraph,
  sourceSkillPath?: string,
  markdownDirectory?: string,
): string {
  validateWorkflowGraph(graph);
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const referenceById = new Map(
    (graph.references ?? []).map((reference) => [reference.id, reference]),
  );
  const outgoing = groupTransitionsBySource(graph.transitions);
  const lines: string[] = [
    "---",
    `id: ${yamlString(graph.workflowId)}`,
    "type: executable-workflow",
    `schema_version: ${yamlString(graph.schemaVersion)}`,
    `revision: ${graph.revision.number}`,
    `revision_id: ${yamlString(graph.revision.revisionId)}`,
    `source_skill_id: ${yamlString(graph.source.skillId)}`,
    `source_episode_id: ${yamlString(graph.source.episodeId)}`,
    "---",
    "",
    `# ${markdownText(graph.name)}`,
    "",
    "> Review projection only / 仅供审查。`workflow.json` is the canonical executable graph / 是规范执行图。",
    "",
    "## Goal / 目标",
    "",
    markdownText(graph.goal),
    "",
    "## Provenance / 来源",
    "",
    renderSourceSkillLine(graph, sourceSkillPath, markdownDirectory),
    `- Skill ID: \`${markdownCode(graph.source.skillId)}\``,
    `- Run: \`${markdownCode(graph.source.runId)}\``,
    `- Episode: \`${markdownCode(graph.source.episodeId)}\``,
    `- Revision: \`${markdownCode(graph.revision.revisionId)}\``,
    `- Content hash: \`${graph.revision.contentHash}\``,
    "",
    "## Graph / 图",
    "",
    "```mermaid",
    "flowchart TD",
  ];
  const mermaidAliases = new Map<string, string>();
  graph.nodes.forEach((node, index) => {
    const alias = `N${index + 1}`;
    mermaidAliases.set(node.id, alias);
    lines.push(`  ${alias}${renderMermaidNode(node)}`);
  });
  for (const transition of graph.transitions) {
    const from = mermaidAliases.get(transition.from);
    const to = mermaidAliases.get(transition.to);
    if (!from || !to) {
      continue;
    }
    const label = mermaidText(renderTransitionLabel(transition));
    lines.push(`  ${from} -->|${label}| ${to}`);
  }
  lines.push("```", "", "## Nodes / 节点", "");

  for (const node of graph.nodes) {
    lines.push(
      `### ${node.id}`,
      "",
      `**${markdownText(node.title)}**`,
      "",
      `- Type: \`${node.type}\``,
    );
    if (node.type === "action") {
      lines.push(
        `- Objective: ${markdownText(node.objective)}`,
        `- Act: ${node.act.map(markdownText).join("; ")}`,
        `- App: ${markdownText(node.operationApp)}`,
      );
    } else if (node.type === "decision") {
      lines.push(`- Decision: ${markdownText(node.decision)}`);
    } else if (node.type === "wait") {
      lines.push(
        `- Wait for: ${markdownText(node.waitFor)}`,
        `- Resume when: ${markdownText(node.resumeCondition)}`,
      );
    } else {
      lines.push(
        `- Outcome: \`${node.outcome}\``,
        `- Summary: ${markdownText(node.summary)}`,
      );
    }
    if (node.hints.length > 0) {
      lines.push(`- Hints: ${node.hints.map(markdownText).join("; ")}`);
    }
    const nodeReferences = (node.referenceRefs ?? [])
      .map((referenceId) => referenceById.get(referenceId))
      .filter((reference) => reference !== undefined);
    if (nodeReferences.length > 0) {
      lines.push("- References:");
      for (const reference of nodeReferences) {
        lines.push(
          `  - **${markdownText(reference.name)}**: ${markdownText(renderReferenceValue(reference.value))}`,
        );
      }
    }
    lines.push("- Source refs:");
    for (const sourceRef of node.sourceRefs) {
      lines.push(`  - ${renderSourceRef(sourceRef)}`);
    }
    const nodeOutgoing = outgoing.get(node.id) ?? [];
    if (nodeOutgoing.length > 0) {
      lines.push("- Routes:");
      for (const transition of nodeOutgoing) {
        const target = nodeById.get(transition.to);
        const targetLabel = target?.title ?? transition.to;
        lines.push(
          `  - ${markdownText(renderTransitionLabel(transition))} → [${markdownText(targetLabel)}](#${transition.to})`,
        );
      }
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function renderReferenceValue(
  value: string | string[] | Record<string, string>,
): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.join("; ");
  return Object.entries(value)
    .map(([key, item]) => `${key}: ${item}`)
    .join("; ");
}

/**
 * CN: 在 skill 产物旁写入结构化图和 Markdown 审查投影，并保留修订链。
 * EN: Writes the structured graph and Markdown projection beside a skill while preserving revision history.
 * @param options skill, output directory, and optional source path/clock.
 * @returns materialized graph and artifact paths.
 */
export async function materializeWorkflowGraphArtifacts(
  options: MaterializeWorkflowGraphOptions,
): Promise<MaterializeWorkflowGraphResult> {
  const graphPath = join(options.outDir, WORKFLOW_GRAPH_FILE_NAME);
  const existingGraph = await readExistingGraph(graphPath);
  if (existingGraph && !isMechanicalLinearSkillGraph(existingGraph)) {
    assertSkillMatchesCanonicalGraph(options.skill, existingGraph);
    return writeWorkflowGraphArtifactFiles({
      graph: existingGraph,
      outDir: options.outDir,
      sourceSkillPath: options.sourceSkillPath,
    });
  }
  const graph = buildWorkflowGraphFromSkill(options.skill, {
    existingGraph,
    now: options.now,
  });
  return writeWorkflowGraphArtifactFiles({
    graph,
    outDir: options.outDir,
    sourceSkillPath: options.sourceSkillPath,
  });
}

/**
 * CN: 将 graph draft 保存为新的 canonical revision，并生成 Markdown 投影。
 * EN: Persists a graph draft as a canonical revision and renders its Markdown projection.
 * @param options semantic draft, output directory, source link, and optional clock.
 * @returns canonical graph and artifact paths.
 */
export async function persistWorkflowGraphDraft(
  options: PersistWorkflowGraphDraftOptions,
): Promise<MaterializeWorkflowGraphResult> {
  const draft = parseWorkflowGraphDraft(options.draft);
  const graphPath = join(options.outDir, WORKFLOW_GRAPH_FILE_NAME);
  const existingGraph = await readExistingGraph(graphPath);
  if (
    options.expectedRevisionId &&
    existingGraph?.revision.revisionId !== options.expectedRevisionId
  ) {
    throw new Error(
      `Workflow graph draft is stale because the canonical revision changed: expected ${options.expectedRevisionId}, received ${existingGraph?.revision.revisionId ?? "missing"}. Refresh the graph and try again. / 工作流图版本已更新，请刷新后重新编辑。`,
    );
  }
  const contentHash = hashSemanticContent(draft);
  const graph: OysterWorkflowGraph = {
    ...draft,
    revision: resolveRevision({
      workflowId: draft.workflowId,
      contentHash,
      existingGraph,
      createdAt: (options.now ?? new Date()).toISOString(),
    }),
  };
  validateWorkflowGraph(graph);
  return writeWorkflowGraphArtifactFiles({
    graph,
    outDir: options.outDir,
    sourceSkillPath: options.sourceSkillPath,
  });
}

/**
 * CN: 仅从 canonical workflow.json 重建 Markdown，不读取或重写 skill.json。
 * EN: Rebuilds Markdown from canonical workflow.json without reading or rewriting skill.json.
 * @param options graph path and optional output/source paths.
 * @returns validated graph and rendered Markdown path.
 */
export async function renderWorkflowGraphProjection(
  options: RenderWorkflowGraphProjectionOptions,
): Promise<{ graph: OysterWorkflowGraph; markdownPath: string }> {
  const graph = await loadWorkflowGraph(options.graphPath);
  const markdownPath =
    options.markdownPath ??
    join(dirname(options.graphPath), WORKFLOW_GRAPH_MARKDOWN_FILE_NAME);
  await mkdir(dirname(markdownPath), { recursive: true });
  await writeFile(
    markdownPath,
    renderWorkflowGraphMarkdown(
      graph,
      options.sourceSkillPath,
      dirname(markdownPath),
    ),
    "utf8",
  );
  return { graph, markdownPath };
}

export interface WorkflowGraphRevisionRecord {
  graph: OysterWorkflowGraph;
  revisionPath: string;
  isCurrent: boolean;
}

/**
 * CN: 从不可变 revision 目录读取同一 workflow 的完整版本历史。
 * EN: Loads the complete immutable revision history for one workflow.
 * @param graphPath absolute canonical workflow.json path.
 * @returns validated revisions ordered from newest to oldest.
 */
export async function listWorkflowGraphRevisions(
  graphPath: string,
): Promise<WorkflowGraphRevisionRecord[]> {
  const currentGraph = await loadWorkflowGraph(graphPath);
  const revisionsDirectory = join(
    dirname(graphPath),
    WORKFLOW_GRAPH_REVISIONS_DIRECTORY,
  );
  const entries = await readdir(revisionsDirectory, { withFileTypes: true });
  const revisions = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry) => {
        const revisionPath = join(revisionsDirectory, entry.name);
        const graph = await loadWorkflowGraph(revisionPath);
        if (graph.workflowId !== currentGraph.workflowId) {
          throw new Error(
            `Workflow revision ${revisionPath} belongs to ${graph.workflowId}, expected ${currentGraph.workflowId}.`,
          );
        }
        return {
          graph,
          revisionPath,
          isCurrent:
            graph.revision.revisionId === currentGraph.revision.revisionId,
        };
      }),
  );
  return revisions.sort(
    (left, right) =>
      right.graph.revision.number - left.graph.revision.number ||
      right.graph.revision.createdAt.localeCompare(
        left.graph.revision.createdAt,
      ),
  );
}

/**
 * CN: 将历史快照的语义内容恢复为一个新的 canonical revision，保留完整审计链。
 * EN: Restores historical semantic content as a new canonical revision while preserving the audit chain.
 * @param input canonical path, selected historical revision, optional source path and clock.
 * @returns newly persisted canonical revision artifacts.
 */
export async function restoreWorkflowGraphRevision(input: {
  graphPath: string;
  revisionId: string;
  sourceSkillPath?: string;
  now?: Date;
}): Promise<MaterializeWorkflowGraphResult> {
  const currentGraph = await loadWorkflowGraph(input.graphPath);
  if (currentGraph.revision.revisionId === input.revisionId) {
    throw new Error("The selected workflow revision is already current.");
  }
  const revisions = await listWorkflowGraphRevisions(input.graphPath);
  const selected = revisions.find(
    ({ graph }) => graph.revision.revisionId === input.revisionId,
  );
  if (!selected) {
    throw new Error(`Unknown workflow revision: ${input.revisionId}.`);
  }
  return persistWorkflowGraphDraft({
    draft: toWorkflowGraphDraft(selected.graph),
    outDir: dirname(input.graphPath),
    sourceSkillPath: input.sourceSkillPath,
    expectedRevisionId: currentGraph.revision.revisionId,
    now: input.now,
  });
}

async function writeWorkflowGraphArtifactFiles(input: {
  graph: OysterWorkflowGraph;
  outDir: string;
  sourceSkillPath?: string;
}): Promise<MaterializeWorkflowGraphResult> {
  const graphPath = join(input.outDir, WORKFLOW_GRAPH_FILE_NAME);
  const markdownPath = join(input.outDir, WORKFLOW_GRAPH_MARKDOWN_FILE_NAME);
  await mkdir(input.outDir, { recursive: true });
  const serializedGraph = `${JSON.stringify(input.graph, null, 2)}\n`;
  const revisionDirectory = join(
    input.outDir,
    WORKFLOW_GRAPH_REVISIONS_DIRECTORY,
  );
  const revisionPath = join(
    revisionDirectory,
    `revision-${String(input.graph.revision.number).padStart(4, "0")}-${input.graph.revision.contentHash.slice(0, 12)}.json`,
  );
  await mkdir(revisionDirectory, { recursive: true });
  await writeImmutableRevision(revisionPath, serializedGraph);
  await writeFile(graphPath, serializedGraph, "utf8");
  await writeFile(
    markdownPath,
    renderWorkflowGraphMarkdown(
      input.graph,
      input.sourceSkillPath,
      input.outDir,
    ),
    "utf8",
  );
  return { graph: input.graph, graphPath, markdownPath, revisionPath };
}

function assertSkillCanBecomeWorkflowGraph(skill: OpenClawSkill): void {
  if (skill.schemaVersion !== "openclaw-skill-v1") {
    throw new Error(`Unsupported skill schema: ${String(skill.schemaVersion)}`);
  }
  if (!skill.skillId.trim() || !skill.skillName.trim() || !skill.goal.trim()) {
    throw new Error(
      "Skill id, name, and goal are required for graph migration.",
    );
  }
  if (!Array.isArray(skill.steps) || skill.steps.length === 0) {
    throw new Error(
      "Skill must contain at least one step for graph migration.",
    );
  }
  const stepNumbers = new Set<number>();
  for (const step of skill.steps) {
    if (!Number.isInteger(step.step) || step.step < 1) {
      throw new Error(`Invalid skill step number: ${String(step.step)}`);
    }
    if (stepNumbers.has(step.step)) {
      throw new Error(`Duplicate skill step number: ${step.step}`);
    }
    stepNumbers.add(step.step);
    if (
      !step.instruction.trim() ||
      !step.intent.trim() ||
      !step.operationApp.trim()
    ) {
      throw new Error(`Skill step ${step.step} is missing executable content.`);
    }
  }
}

function isMechanicalLinearSkillGraph(graph: OysterWorkflowGraph): boolean {
  const nodes: WorkflowGraphNode[] = graph.nodes;
  const actionNodes = nodes.filter(
    (node): node is Extract<WorkflowGraphNode, { type: "action" }> =>
      node.type === "action",
  );
  const terminalNodes = nodes.filter(
    (node): node is Extract<WorkflowGraphNode, { type: "terminal" }> =>
      node.type === "terminal",
  );
  if (
    actionNodes.length === 0 ||
    terminalNodes.length !== 1 ||
    graph.nodes.length !== actionNodes.length + 1 ||
    graph.transitions.length !== actionNodes.length ||
    graph.transitions.some((transition) => transition.type !== "default")
  ) {
    return false;
  }
  for (const node of actionNodes) {
    const stepNumber = findSkillStepNumber(
      node.sourceRefs,
      graph.source.skillId,
    );
    const legacyNode = node as {
      observe?: string[];
      verify?: string[];
    };
    const legacyHasExecutionFields =
      (legacyNode.observe?.length ?? 0) > 0 ||
      (legacyNode.verify?.length ?? 0) > 0;
    if (
      stepNumber === null ||
      node.id !== buildStepNodeId(stepNumber) ||
      legacyHasExecutionFields ||
      !hasOnlyMechanicalActionSourceRefs(node.sourceRefs, graph, stepNumber) ||
      node.act.length !== 1
    ) {
      return false;
    }
  }
  if (
    !hasOnlySourceRefs(terminalNodes[0].sourceRefs, [
      { kind: "skill", ref: buildSkillRef(graph.source.skillId) },
      {
        kind: "episode",
        ref: buildEpisodeRef(graph.source.runId, graph.source.episodeId),
      },
    ])
  ) {
    return false;
  }
  const outgoing = groupTransitionsBySource(graph.transitions);
  const visited = new Set<string>();
  let currentId = graph.entryNodeId;
  while (true) {
    if (visited.has(currentId)) {
      return false;
    }
    visited.add(currentId);
    const current = graph.nodes.find((node) => node.id === currentId);
    if (!current) {
      return false;
    }
    if (current.type === "terminal") {
      return visited.size === graph.nodes.length;
    }
    const routes = outgoing.get(currentId) ?? [];
    if (routes.length !== 1 || routes[0].type !== "default") {
      return false;
    }
    if (!hasOnlySourceRefs(routes[0].sourceRefs, current.sourceRefs)) {
      return false;
    }
    currentId = routes[0].to;
  }
}

function hasOnlyMechanicalActionSourceRefs(
  sourceRefs: WorkflowGraphSourceRef[],
  graph: OysterWorkflowGraph,
  stepNumber: number,
): boolean {
  return hasOnlySourceRefs(sourceRefs, [
    {
      kind: "skill-step",
      ref: `${buildSkillRef(graph.source.skillId)}#step-${stepNumber}`,
    },
    {
      kind: "episode",
      ref: buildEpisodeRef(graph.source.runId, graph.source.episodeId),
    },
  ]);
}

function hasOnlySourceRefs(
  actual: WorkflowGraphSourceRef[],
  expected: Array<Pick<WorkflowGraphSourceRef, "kind" | "ref">>,
): boolean {
  if (actual.length !== expected.length) {
    return false;
  }
  const actualIdentities = new Set(
    actual.map((sourceRef) => `${sourceRef.kind}\u0000${sourceRef.ref}`),
  );
  return expected.every((sourceRef) =>
    actualIdentities.has(`${sourceRef.kind}\u0000${sourceRef.ref}`),
  );
}

function assertSkillMatchesCanonicalGraph(
  skill: OpenClawSkill,
  graph: OysterWorkflowGraph,
): void {
  assertSkillCanBecomeWorkflowGraph(skill);
  const fail = (detail: string): never => {
    throw new Error(
      `Canonical workflow graph is protected from compatibility overwrite: ${detail}. Edit the graph draft and persist a new graph revision instead.`,
    );
  };
  if (graph.source.skillId !== skill.skillId) {
    fail(`skill id changed from ${graph.source.skillId} to ${skill.skillId}`);
  }
  if (graph.name !== skill.skillName) {
    fail("skill name no longer matches the canonical graph");
  }
  if (graph.goal !== skill.goal) {
    fail("skill goal no longer matches the canonical graph");
  }
  if (
    graph.source.runId !== skill.source.runId ||
    graph.source.episodeId !== skill.source.episodeId
  ) {
    fail("source episode no longer matches the canonical graph provenance");
  }
  const mappedActions = new Map<
    number,
    Array<Extract<WorkflowGraphNode, { type: "action" }>>
  >();
  for (const node of graph.nodes) {
    if (node.type !== "action") {
      continue;
    }
    for (const stepNumber of findSkillStepNumbers(
      node.sourceRefs,
      skill.skillId,
    )) {
      const actions = mappedActions.get(stepNumber) ?? [];
      actions.push(node);
      mappedActions.set(stepNumber, actions);
    }
  }
  for (const step of skill.steps) {
    const nodes = mappedActions.get(step.step) ?? [];
    if (nodes.length === 0) {
      fail(`skill step ${step.step} has no canonical graph node`);
    }
    const preservesAction = nodes.some(
      (node) =>
        node.operationApp === step.operationApp &&
        node.act.includes(step.instruction),
    );
    const preservedHints = new Set(nodes.flatMap((node) => node.hints));
    if (
      !preservesAction ||
      !step.hints.every((hint) => preservedHints.has(hint))
    ) {
      fail(`skill step ${step.step} content diverged from the canonical graph`);
    }
  }
}

function findSkillStepNumber(
  sourceRefs: WorkflowGraphSourceRef[],
  skillId: string,
): number | null {
  return findSkillStepNumbers(sourceRefs, skillId)[0] ?? null;
}

function findSkillStepNumbers(
  sourceRefs: WorkflowGraphSourceRef[],
  skillId: string,
): number[] {
  const prefix = `${buildSkillRef(skillId)}#step-`;
  return Array.from(
    new Set(
      sourceRefs.flatMap((sourceRef) => {
        if (
          sourceRef.kind !== "skill-step" ||
          !sourceRef.ref.startsWith(prefix)
        ) {
          return [];
        }
        const stepNumber = Number(sourceRef.ref.slice(prefix.length));
        return Number.isInteger(stepNumber) && stepNumber >= 1
          ? [stepNumber]
          : [];
      }),
    ),
  );
}

function buildStepNodeId(stepNumber: number): string {
  return `step-${String(stepNumber).padStart(3, "0")}`;
}

function buildSkillRef(skillId: string): string {
  return `skill:${skillId}`;
}

function buildEpisodeRef(runId: string, episodeId: string): string {
  return `episode:${runId}:${episodeId}`;
}

function summarizeInstruction(instruction: string): string {
  const normalized = instruction.replace(/\s+/g, " ").trim();
  if (normalized.length <= 72) {
    return normalized;
  }
  return `${normalized.slice(0, 71)}…`;
}

function hashSemanticContent(content: WorkflowGraphSemanticContent): string {
  return createHash("sha256").update(stableStringify(content)).digest("hex");
}

export function toWorkflowGraphDraft(
  graph: OysterWorkflowGraph,
): OysterWorkflowGraphDraft {
  const { revision: _revision, ...draft } = graph;
  return draft;
}

function formatSchemaError(context: string, error: z.ZodError): string {
  const details = error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "root";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
  return `Invalid ${context}: ${details}`;
}

function resolveRevision(input: {
  workflowId: string;
  contentHash: string;
  existingGraph: OysterWorkflowGraph | null;
  createdAt: string;
}): OysterWorkflowGraph["revision"] {
  const sameWorkflow = input.existingGraph?.workflowId === input.workflowId;
  if (
    sameWorkflow &&
    input.existingGraph?.revision.contentHash === input.contentHash
  ) {
    return input.existingGraph.revision;
  }
  const number = sameWorkflow
    ? (input.existingGraph?.revision.number ?? 0) + 1
    : 1;
  return {
    number,
    revisionId: `${input.workflowId}:rev-${number}:${input.contentHash.slice(0, 12)}`,
    previousRevisionId: sameWorkflow
      ? (input.existingGraph?.revision.revisionId ?? null)
      : null,
    contentHash: input.contentHash,
    createdAt: input.createdAt,
  };
}

async function readExistingGraph(
  graphPath: string,
): Promise<OysterWorkflowGraph | null> {
  try {
    return await loadWorkflowGraph(graphPath);
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    throw error;
  }
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

async function writeImmutableRevision(
  revisionPath: string,
  serializedGraph: string,
): Promise<void> {
  try {
    await writeFile(revisionPath, serializedGraph, {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (error) {
    if (!isFileSystemError(error, "EEXIST")) {
      throw error;
    }
    const existing = await readFile(revisionPath, "utf8");
    if (existing !== serializedGraph) {
      throw new Error(`Workflow revision is immutable: ${revisionPath}`);
    }
  }
}

function isFileSystemError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function assertNonEmptyIdentifier(value: string, kind: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Workflow ${kind} id must be non-empty.`);
  }
}

function groupTransitionsBySource(
  transitions: WorkflowGraphTransition[],
): Map<string, WorkflowGraphTransition[]> {
  const outgoing = new Map<string, WorkflowGraphTransition[]>();
  for (const transition of transitions) {
    const grouped = outgoing.get(transition.from) ?? [];
    grouped.push(transition);
    outgoing.set(transition.from, grouped);
  }
  return outgoing;
}

function renderMermaidNode(node: WorkflowGraphNode): string {
  const label = mermaidText(node.title);
  if (node.type === "decision") {
    return `{\"${label}\"}`;
  }
  if (node.type === "terminal") {
    return `([\"${label}\"])`;
  }
  if (node.type === "wait") {
    return `([\"Wait: ${label}\"])`;
  }
  return `[\"${label}\"]`;
}

function renderTransitionLabel(transition: WorkflowGraphTransition): string {
  if (transition.type === "default") {
    return "next";
  }
  if (transition.type === "retry") {
    return `retry (${transition.when}; max ${transition.maxAttempts})`;
  }
  return `${transition.type} (${transition.when})`;
}

function renderSourceRef(sourceRef: WorkflowGraphSourceRef): string {
  const label = sourceRef.label ? `${markdownText(sourceRef.label)} — ` : "";
  return `${label}\`${markdownCode(sourceRef.ref)}\``;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function markdownText(value: string): string {
  return value.replace(/\r?\n/g, " ").trim();
}

function markdownCode(value: string): string {
  return value.replace(/`/g, "\\`");
}

function buildRelativeFileLink(
  sourcePath: string,
  markdownDirectory?: string,
): string {
  const rawPath = markdownDirectory
    ? relative(markdownDirectory, sourcePath)
    : basename(sourcePath);
  const portablePath = rawPath.replace(/\\/g, "/");
  const relativePath = portablePath.startsWith(".")
    ? portablePath
    : `./${portablePath}`;
  return encodeURI(relativePath);
}

function renderSourceSkillLine(
  graph: OysterWorkflowGraph,
  sourceSkillPath?: string,
  markdownDirectory?: string,
): string {
  if (!sourceSkillPath) {
    return `- Source skill: \`skill:${markdownCode(graph.source.skillId)}\``;
  }
  return `- Source skill: [${markdownText(basename(sourceSkillPath))}](${buildRelativeFileLink(sourceSkillPath, markdownDirectory)})`;
}

function mermaidText(value: string): string {
  return markdownText(value)
    .replace(/&/g, "&amp;")
    .replace(/\"/g, "&quot;")
    .replace(/\|/g, "&#124;")
    .replace(/[{}\[\]]/g, "");
}
