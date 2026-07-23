import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import {
  loadWorkflowGraph,
  persistWorkflowGraphDraft,
  renderWorkflowGraphProjection,
  WORKFLOW_GRAPH_FILE_NAME,
} from "../../skill/workflow-graph.js";
import {
  applyWorkflowMergeProposal,
  parseWorkflowMergeProposal,
} from "../../skill/workflow-merge.js";

const graphPathArgsSchema = z.object({
  workflow: z.string().min(1),
});
const renderArgsSchema = graphPathArgsSchema.extend({
  out: z.string().min(1).optional(),
  sourceSkill: z.string().min(1).optional(),
});
const persistArgsSchema = z.object({
  input: z.string().min(1),
  out: z.string().min(1),
  sourceSkill: z.string().min(1).optional(),
});
const applyMergeArgsSchema = z.object({
  workflow: z.string().min(1),
  proposal: z.string().min(1),
  out: z.string().min(1),
  sourceSkill: z.string().min(1).optional(),
});

export interface ValidateWorkflowGraphCliOptions {
  graphPath: string;
}

export interface RenderWorkflowGraphCliOptions {
  graphPath: string;
  markdownPath?: string;
  sourceSkillPath?: string;
}

export interface PersistWorkflowGraphCliOptions {
  inputPath: string;
  outDir: string;
  sourceSkillPath?: string;
}

export interface ApplyWorkflowMergeCliOptions {
  graphPath: string;
  proposalPath: string;
  outDir: string;
  sourceSkillPath?: string;
}

/**
 * CN: 解析 canonical graph 校验命令参数。
 * EN: Parses canonical graph validation arguments.
 * @param input raw CLI values.
 * @returns normalized absolute graph path.
 */
export function parseValidateWorkflowGraphCliArgs(input: {
  workflow: string;
}): ValidateWorkflowGraphCliOptions {
  const parsed = graphPathArgsSchema.parse(input);
  assertAbsolutePath(parsed.workflow, "--workflow");
  return { graphPath: resolve(parsed.workflow) };
}

/**
 * CN: 解析从 canonical JSON 重建 Markdown 的命令参数。
 * EN: Parses Markdown projection rendering arguments.
 * @param input raw CLI values.
 * @returns normalized absolute paths.
 */
export function parseRenderWorkflowGraphCliArgs(input: {
  workflow: string;
  out?: string;
  sourceSkill?: string;
}): RenderWorkflowGraphCliOptions {
  const parsed = renderArgsSchema.parse(input);
  assertAbsolutePath(parsed.workflow, "--workflow");
  if (parsed.out) {
    assertAbsolutePath(parsed.out, "--out");
  }
  if (parsed.sourceSkill) {
    assertAbsolutePath(parsed.sourceSkill, "--source-skill");
  }
  return {
    graphPath: resolve(parsed.workflow),
    ...(parsed.out ? { markdownPath: resolve(parsed.out) } : {}),
    ...(parsed.sourceSkill
      ? { sourceSkillPath: resolve(parsed.sourceSkill) }
      : {}),
  };
}

/**
 * CN: 解析 graph draft 持久化命令；draft 必须与 canonical 文件分离，避免先覆盖当前版本。
 * EN: Parses draft persistence arguments and keeps the draft separate from canonical storage.
 * @param input raw CLI values.
 * @returns normalized draft and output paths.
 */
export function parsePersistWorkflowGraphCliArgs(input: {
  input: string;
  out: string;
  sourceSkill?: string;
}): PersistWorkflowGraphCliOptions {
  const parsed = persistArgsSchema.parse(input);
  assertAbsolutePath(parsed.input, "--input");
  assertAbsolutePath(parsed.out, "--out");
  if (parsed.sourceSkill) {
    assertAbsolutePath(parsed.sourceSkill, "--source-skill");
  }
  const inputPath = resolve(parsed.input);
  const outDir = resolve(parsed.out);
  if (inputPath === join(outDir, WORKFLOW_GRAPH_FILE_NAME)) {
    throw new Error(
      "--input must be a separate draft file, not the canonical workflow.json.",
    );
  }
  return {
    inputPath,
    outDir,
    ...(parsed.sourceSkill
      ? { sourceSkillPath: resolve(parsed.sourceSkill) }
      : {}),
  };
}

/**
 * CN: 解析显式应用 Call 5 proposal 的命令，并拒绝相对路径。
 * EN: Parses explicit Call 5 proposal application arguments and rejects relative paths.
 * @param input raw CLI values.
 * @returns normalized canonical, proposal, and output paths.
 */
export function parseApplyWorkflowMergeCliArgs(input: {
  workflow: string;
  proposal: string;
  out: string;
  sourceSkill?: string;
}): ApplyWorkflowMergeCliOptions {
  const parsed = applyMergeArgsSchema.parse(input);
  for (const [flag, value] of [
    ["--workflow", parsed.workflow],
    ["--proposal", parsed.proposal],
    ["--out", parsed.out],
    ["--source-skill", parsed.sourceSkill],
  ] as const) {
    if (value) assertAbsolutePath(value, flag);
  }
  return {
    graphPath: resolve(parsed.workflow),
    proposalPath: resolve(parsed.proposal),
    outDir: resolve(parsed.out),
    ...(parsed.sourceSkill
      ? { sourceSkillPath: resolve(parsed.sourceSkill) }
      : {}),
  };
}

/**
 * CN: 严格读取并验证 canonical graph。
 * EN: Strictly loads and validates a canonical graph.
 * @param options canonical graph path.
 * @returns validated graph.
 */
export async function runValidateWorkflowGraph(
  options: ValidateWorkflowGraphCliOptions,
) {
  return loadWorkflowGraph(options.graphPath);
}

/**
 * CN: 执行 canonical graph 的 Markdown 重建。
 * EN: Rebuilds the Markdown projection from a canonical graph.
 * @param options validated graph and output paths.
 * @returns graph plus generated Markdown path.
 */
export async function runRenderWorkflowGraph(
  options: RenderWorkflowGraphCliOptions,
) {
  return renderWorkflowGraphProjection(options);
}

/**
 * CN: 读取独立 draft 并保存一个新的 canonical revision。
 * EN: Reads a separate draft and persists a new canonical revision.
 * @param options draft, canonical output, and optional source skill paths.
 * @returns persisted graph and versioned artifact paths.
 */
export async function runPersistWorkflowGraph(
  options: PersistWorkflowGraphCliOptions,
) {
  const draft = parseJson(
    await readFile(options.inputPath, "utf8"),
    options.inputPath,
  );
  return persistWorkflowGraphDraft({
    draft,
    outDir: options.outDir,
    sourceSkillPath: options.sourceSkillPath,
  });
}

/**
 * CN: 校验 proposal hash 与 base revision 后，由代码写入新的 canonical revision。
 * EN: Applies a proposal in code after validating its hash and base revision binding.
 * @param options canonical graph, proposal, and output paths.
 * @returns persisted canonical graph artifacts.
 */
export async function runApplyWorkflowMerge(
  options: ApplyWorkflowMergeCliOptions,
) {
  const [currentGraph, proposalContent] = await Promise.all([
    loadWorkflowGraph(options.graphPath),
    readFile(options.proposalPath, "utf8"),
  ]);
  const proposal = parseWorkflowMergeProposal(
    parseJson(proposalContent, options.proposalPath),
  );
  return applyWorkflowMergeProposal({
    proposal,
    currentGraph,
    outDir: options.outDir,
    sourceSkillPath: options.sourceSkillPath,
  });
}

function parseJson(content: string, path: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON at ${path}: ${message}`);
  }
}

function assertAbsolutePath(value: string, flag: string): void {
  if (!isAbsolute(value)) {
    throw new Error(`${flag} must be an absolute path.`);
  }
}
