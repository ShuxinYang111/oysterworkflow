import { basename, dirname, extname, join, resolve } from "node:path";
import type {
  OysterWorkflowGraph,
  WorkflowFamilyCard,
} from "../types/contracts.js";
import {
  loadWorkflowGraph,
  WORKFLOW_GRAPH_FILE_NAME,
} from "../skill/workflow-graph.js";
import { buildWorkflowFamilyCard } from "../skill/workflow-learning.js";
import type { LabSession } from "./contracts.js";

export interface WorkflowFamilyArtifactSource {
  artifactPath: string;
  updatedAt: string;
  whenToUse?: string[];
}

export interface RuntimeWorkflowFamilyCatalog {
  families: WorkflowFamilyCard[];
  graphs: Record<string, OysterWorkflowGraph>;
  graphPaths: Record<string, string>;
  warnings: string[];
}

interface ResolvedWorkflowFamilyArtifactSource extends WorkflowFamilyArtifactSource {
  graphPath: string;
}

/**
 * EN: Collects canonical workflow graph sources already persisted in Lab sessions.
 * 中文: 收集 Lab 会话中已经持久化的 canonical workflow graph 来源。
 * @param sessions persisted Lab sessions.
 * @returns graph artifact sources with companion skill trigger descriptions.
 */
export function collectSessionWorkflowFamilyArtifactSources(
  sessions: LabSession[],
): WorkflowFamilyArtifactSource[] {
  return sessions.flatMap((session) => {
    const artifactSources = session.skillExtraction.artifacts.flatMap(
      (artifact) => {
        const graphPath = artifact.summary.output.workflowGraphPath;
        return graphPath
          ? [
              {
                artifactPath: graphPath,
                updatedAt: artifact.summary.generatedAt,
                whenToUse: artifact.skill.whenToUse,
              },
            ]
          : [];
      },
    );
    const latestGraphPath =
      session.skillExtraction.summary?.output.workflowGraphPath;
    return latestGraphPath
      ? [
          ...artifactSources,
          {
            artifactPath: latestGraphPath,
            updatedAt:
              session.skillExtraction.summary?.generatedAt ?? session.updatedAt,
            whenToUse: session.skillExtraction.skill?.whenToUse ?? [],
          },
        ]
      : artifactSources;
  });
}

/**
 * EN: Builds the in-memory v2 family catalog used by Call 4 and Call 5.
 * 中文: 构建供 Call 4 与 Call 5 使用的内存 v2 family catalog。
 * @param sources canonical graph or sibling skill artifact locations.
 * @returns validated, revision-aware family cards, graphs, paths, and diagnostics.
 */
export async function buildRuntimeWorkflowFamilyCatalog(
  sources: WorkflowFamilyArtifactSource[],
): Promise<RuntimeWorkflowFamilyCatalog> {
  const resolvedSources = deduplicateArtifactSources(sources);
  const families: WorkflowFamilyCard[] = [];
  const graphs: Record<string, OysterWorkflowGraph> = {};
  const graphPaths: Record<string, string> = {};
  const warnings: string[] = [];

  for (const source of resolvedSources) {
    let graph: OysterWorkflowGraph;
    try {
      graph = await loadWorkflowGraph(source.graphPath);
    } catch (error) {
      if (!isMissingFileError(error)) {
        warnings.push(
          `Skipped invalid workflow family graph at ${source.graphPath}: ${formatError(error)} / 已跳过无效的工作流家族图。`,
        );
      }
      continue;
    }
    if (graphs[graph.workflowId]) {
      const existingFamily = families.find(
        (family) => family.workflowId === graph.workflowId,
      );
      if (existingFamily) {
        existingFamily.whenToUse = mergeStringLists(
          existingFamily.whenToUse,
          source.whenToUse ?? [],
        );
      }
      continue;
    }
    families.push(
      buildWorkflowFamilyCard(graph, mergeStringLists(source.whenToUse ?? [])),
    );
    graphs[graph.workflowId] = graph;
    graphPaths[graph.workflowId] = source.graphPath;
  }

  return { families, graphs, graphPaths, warnings };
}

/**
 * EN: Resolves a canonical graph beside a skill artifact or from an explicit graph path.
 * 中文: 从 skill 产物同目录或显式 graph 路径解析 canonical graph。
 * @param artifactPath workflow graph, skill file, or package directory.
 * @returns absolute canonical workflow graph path.
 */
export function resolveWorkflowFamilyGraphPath(artifactPath: string): string {
  const absolutePath = resolve(artifactPath);
  if (basename(absolutePath) === WORKFLOW_GRAPH_FILE_NAME) {
    return absolutePath;
  }
  return extname(absolutePath)
    ? join(dirname(absolutePath), WORKFLOW_GRAPH_FILE_NAME)
    : join(absolutePath, WORKFLOW_GRAPH_FILE_NAME);
}

function deduplicateArtifactSources(
  sources: WorkflowFamilyArtifactSource[],
): ResolvedWorkflowFamilyArtifactSource[] {
  const sorted = sources
    .map((source, index) => ({
      ...source,
      graphPath: resolveWorkflowFamilyGraphPath(source.artifactPath),
      index,
    }))
    .sort(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) ||
        left.index - right.index,
    );
  const byGraphPath = new Map<string, ResolvedWorkflowFamilyArtifactSource>();
  for (const { index: _index, ...source } of sorted) {
    const existing = byGraphPath.get(source.graphPath);
    if (!existing) {
      byGraphPath.set(source.graphPath, source);
      continue;
    }
    existing.whenToUse = mergeStringLists(
      existing.whenToUse ?? [],
      source.whenToUse ?? [],
    );
  }
  return [...byGraphPath.values()];
}

function mergeStringLists(...lists: string[][]): string[] {
  return Array.from(
    new Set(
      lists
        .flat()
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
