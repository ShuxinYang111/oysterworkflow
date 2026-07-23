import { access, copyFile, cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  loadWorkflowGraph,
  renderWorkflowGraphMarkdown,
  WORKFLOW_GRAPH_FILE_NAME,
  WORKFLOW_GRAPH_MARKDOWN_FILE_NAME,
  WORKFLOW_GRAPH_REVISIONS_DIRECTORY,
} from "./workflow-graph.js";
import type { OysterWorkflowGraph } from "../types/contracts.js";

export interface WorkflowGraphPackageArtifacts {
  graphPath: string;
  markdownPath: string;
  revisionsDir: string;
  revisionPath: string;
}

/**
 * CN: 如果 skill.json 同目录存在 canonical workflow.json，则严格读取；不存在时返回 null。
 * EN: Strictly loads a sibling canonical workflow.json when present.
 * @param skillPath source skill JSON or Markdown path.
 * @returns validated graph plus source path, or null for legacy packages.
 */
export async function loadSiblingWorkflowGraph(
  skillPath: string,
): Promise<{ graph: OysterWorkflowGraph; graphPath: string } | null> {
  const graphPath = join(dirname(skillPath), WORKFLOW_GRAPH_FILE_NAME);
  try {
    await access(graphPath);
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) {
      return null;
    }
    throw error;
  }
  return {
    graph: await loadWorkflowGraph(graphPath),
    graphPath,
  };
}

/**
 * CN: 确认 canonical graph 确实属于当前兼容 skill，避免打包错配文件。
 * EN: Ensures the canonical graph belongs to the compatibility skill being packaged.
 * @param graph canonical workflow graph.
 * @param skillId expected source skill id.
 * @returns void; throws on mismatch.
 */
export function assertWorkflowGraphSourceSkill(
  graph: OysterWorkflowGraph,
  skillId: string,
): void {
  if (graph.source.skillId !== skillId) {
    throw new Error(
      `Workflow graph source skill mismatch: expected ${skillId}, received ${graph.source.skillId}.`,
    );
  }
}

/**
 * CN: 将 canonical graph、审查投影和不可变 revision history 写入 Agent skill package。
 * EN: Materializes the canonical graph, review projection, and immutable revisions into an Agent skill package.
 * @param input graph, original graph path, and target skill directory.
 * @returns packaged graph artifact paths.
 */
export async function materializeWorkflowGraphPackage(input: {
  graph: OysterWorkflowGraph;
  sourceGraphPath: string;
  targetDir: string;
}): Promise<WorkflowGraphPackageArtifacts> {
  const graphPath = join(input.targetDir, WORKFLOW_GRAPH_FILE_NAME);
  const markdownPath = join(input.targetDir, WORKFLOW_GRAPH_MARKDOWN_FILE_NAME);
  const revisionsDir = join(
    input.targetDir,
    WORKFLOW_GRAPH_REVISIONS_DIRECTORY,
  );
  const sourceRevisionsDir = join(
    dirname(input.sourceGraphPath),
    WORKFLOW_GRAPH_REVISIONS_DIRECTORY,
  );
  const revisionFileName = `revision-${String(input.graph.revision.number).padStart(4, "0")}-${input.graph.revision.contentHash.slice(0, 12)}.json`;
  const revisionPath = join(revisionsDir, revisionFileName);
  const serializedGraph = `${JSON.stringify(input.graph, null, 2)}\n`;

  await mkdir(input.targetDir, { recursive: true });
  if (resolve(sourceRevisionsDir) !== resolve(revisionsDir)) {
    await rm(revisionsDir, { recursive: true, force: true });
    if (await pathExists(sourceRevisionsDir)) {
      await cp(sourceRevisionsDir, revisionsDir, {
        recursive: true,
        force: false,
        errorOnExist: true,
      });
    }
  }
  if (!(await pathExists(revisionsDir))) {
    await mkdir(revisionsDir, { recursive: true });
  }
  if (!(await pathExists(revisionPath))) {
    await writeFile(revisionPath, serializedGraph, "utf8");
  }
  if (resolve(input.sourceGraphPath) !== resolve(graphPath)) {
    await copyFile(input.sourceGraphPath, graphPath);
  }
  await writeFile(
    markdownPath,
    renderWorkflowGraphMarkdown(input.graph),
    "utf8",
  );
  return { graphPath, markdownPath, revisionsDir, revisionPath };
}

/**
 * CN: 清理受管理 skill 目录中已失效的 graph sidecars。
 * EN: Removes stale graph sidecars from a managed skill directory.
 * @param targetDir managed Agent skill directory.
 * @returns resolves after cleanup.
 */
export async function removeWorkflowGraphPackage(
  targetDir: string,
): Promise<void> {
  await Promise.all([
    rm(join(targetDir, WORKFLOW_GRAPH_FILE_NAME), { force: true }),
    rm(join(targetDir, WORKFLOW_GRAPH_MARKDOWN_FILE_NAME), { force: true }),
    rm(join(targetDir, WORKFLOW_GRAPH_REVISIONS_DIRECTORY), {
      recursive: true,
      force: true,
    }),
  ]);
}

/**
 * CN: 生成放入 SKILL.md 的 canonical graph 加载协议，不复制完整节点正文。
 * EN: Renders the canonical graph loading protocol for SKILL.md without duplicating node details.
 * @param graph canonical workflow graph.
 * @returns Markdown lines for the entry skill.
 */
export function renderWorkflowGraphSkillGuide(
  graph: OysterWorkflowGraph,
): string[] {
  return [
    "## Canonical Execution Graph",
    "",
    "This skill has a canonical execution graph. Before taking the first action, read [WORKFLOW.md](./WORKFLOW.md). Treat `workflow.json` as the machine-readable source of truth.",
    "",
    `- Workflow ID: \`${graph.workflowId}\``,
    `- Revision: \`${graph.revision.revisionId}\``,
    `- Entry node: \`${graph.entryNodeId}\``,
    `- Nodes: ${graph.nodes.length}`,
    `- Transitions: ${graph.transitions.length}`,
    "",
    "Execution rules:",
    "",
    "- Follow node IDs and typed transitions; do not flatten branches into one unconditional sequence.",
    "- At a decision, use the decision statement and hints, then choose only a transition whose condition is satisfied. A partial decision may currently have only one known route; if it does not fit, stop as an unknown route instead of guessing.",
    "- At a wait node, pause until a known resume condition is satisfied. An open wait may have no resume transition yet.",
    "- Stop immediately at a terminal node and report its outcome.",
    "- Never exceed a retry transition's `maxAttempts`; for a conditional return loop, follow its explicit exit route when the exit condition is met.",
    "",
  ];
}

/**
 * CN: 将 graph 加载协议写入 Agent Markdown，并移除会与 canonical graph 冲突的线性 Steps。
 * EN: Writes the graph loading protocol into Agent Markdown and removes linear Steps that conflict with the canonical graph.
 * @param markdown existing Agent skill Markdown.
 * @param graph canonical workflow graph.
 * @returns graph-aware skill Markdown.
 */
export function appendWorkflowGraphSkillGuide(
  markdown: string,
  graph: OysterWorkflowGraph,
): string {
  const lines = removeMarkdownSection(markdown, "Steps").trimEnd().split("\n");
  const sectionStart = lines.findIndex(
    (line) => line.trim() === "## Canonical Execution Graph",
  );
  const guideLines = renderWorkflowGraphSkillGuide(graph);

  if (sectionStart >= 0) {
    const relativeSectionEnd = lines
      .slice(sectionStart + 1)
      .findIndex((line) => /^##\s+\S/u.test(line));
    const sectionEnd =
      relativeSectionEnd < 0
        ? lines.length
        : sectionStart + 1 + relativeSectionEnd;
    lines.splice(sectionStart, sectionEnd - sectionStart, ...guideLines);
    return `${lines.join("\n").trimEnd()}\n`;
  }
  return `${lines.join("\n")}\n\n${guideLines.join("\n").trimEnd()}\n`;
}

/**
 * CN: 按二级标题精确删除一个 Markdown 章节，同时保留后续章节。
 * EN: Removes one exact level-two Markdown section while preserving later sections.
 * @param markdown source Markdown.
 * @param heading exact level-two heading text.
 * @returns Markdown without the requested section.
 */
function removeMarkdownSection(markdown: string, heading: string): string {
  const lines = markdown.trimEnd().split("\n");
  const sectionStart = lines.findIndex(
    (line) => line.trim() === `## ${heading}`,
  );
  if (sectionStart < 0) {
    return markdown;
  }
  const relativeSectionEnd = lines
    .slice(sectionStart + 1)
    .findIndex((line) => /^##\s+\S/u.test(line));
  const sectionEnd =
    relativeSectionEnd < 0
      ? lines.length
      : sectionStart + 1 + relativeSectionEnd;
  lines.splice(sectionStart, sectionEnd - sectionStart);
  return `${lines
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trimEnd()}\n`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

function isFileSystemError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
