import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import {
  createDefaultOpenAiClient,
  type LlmInvocationMetrics,
  type OpenClawLlmClient,
} from "../../skill/extract-openclaw-llm.js";
import {
  buildEmptyCatalogMatch,
  normalizeCandidateWorkflow,
  normalizeWorkflowFamilyMatch,
  WORKFLOW_CANDIDATE_FILE_NAME,
  WORKFLOW_FAMILY_MATCH_FILE_NAME,
} from "../../skill/workflow-learning.js";
import {
  buildWorkflowGraphDraftFromCandidate,
  normalizeWorkflowMergeProposal,
  WORKFLOW_MERGE_PROPOSAL_FILE_NAME,
} from "../../skill/workflow-merge.js";
import { persistWorkflowGraphDraft } from "../../skill/workflow-graph.js";
import type {
  CandidateWorkflow,
  WorkflowFamilyMatch,
  WorkflowMergeProposal,
} from "../../types/contracts.js";
import { parseSkillJson } from "./materialize-workflow-graph.js";
import { resolveExtractSkillLlmOptions } from "./extract-skill-llm.js";

const learnWorkflowGraphArgsSchema = z.object({
  skill: z.string().min(1),
  out: z.string().min(1),
  workflowFamilyCatalog: z.string().min(1).optional(),
  config: z.string().min(1).optional(),
});

export interface LearnWorkflowGraphCliOptions {
  skillPath: string;
  outDir: string;
  workflowFamilyCatalogPath?: string;
  configPath?: string;
  llmClient?: OpenClawLlmClient;
  now?: Date;
}

export interface LearnWorkflowGraphResult {
  candidate: CandidateWorkflow;
  familyMatch: WorkflowFamilyMatch;
  mergeProposal?: WorkflowMergeProposal;
  paths: {
    candidatePath: string;
    familyMatchPath: string;
    mergeProposalPath: string | null;
    canonicalGraphPath: string | null;
    summaryPath: string;
  };
  calls: Array<{
    label: "call-3" | "call-4" | "call-5";
    metrics: LlmInvocationMetrics | null;
  }>;
  warnings: string[];
}

/**
 * CN: 解析独立 workflow learning 命令，并强制所有文件路径为绝对路径。
 * EN: Parses standalone workflow learning CLI arguments and requires absolute paths.
 * @param input raw Commander values.
 * @returns normalized absolute paths.
 */
export function parseLearnWorkflowGraphCliArgs(input: {
  skill: string;
  out: string;
  workflowFamilyCatalog?: string;
  config?: string;
}): LearnWorkflowGraphCliOptions {
  const parsed = learnWorkflowGraphArgsSchema.parse(input);
  for (const [label, value] of [
    ["--skill", parsed.skill],
    ["--out", parsed.out],
    ["--workflow-family-catalog", parsed.workflowFamilyCatalog],
    ["--config", parsed.config],
  ] as const) {
    if (value && !isAbsolute(value)) {
      throw new Error(`${label} must be an absolute path.`);
    }
  }
  return {
    skillPath: resolve(parsed.skill),
    outDir: resolve(parsed.out),
    ...(parsed.workflowFamilyCatalog
      ? { workflowFamilyCatalogPath: resolve(parsed.workflowFamilyCatalog) }
      : {}),
    ...(parsed.config ? { configPath: resolve(parsed.config) } : {}),
  };
}

/**
 * CN: 对已有 skill.json 独立执行 Call 3、Call 4 和必要的 Call 5，不重新运行 Call 2。
 * EN: Runs Call 3, Call 4, and matched Call 5 for an existing skill without rerunning Call 2.
 * @param options skill, output, catalog, and LLM config paths.
 * @returns persisted learning artifacts and per-call metrics.
 */
export async function runLearnWorkflowGraph(
  options: LearnWorkflowGraphCliOptions,
): Promise<LearnWorkflowGraphResult> {
  await mkdir(options.outDir, { recursive: true });
  const skill = parseSkillJson(
    await readFile(options.skillPath, "utf8"),
    options.skillPath,
  );
  const resolved = await resolveExtractSkillLlmOptions({
    runDir: options.outDir,
    outDir: options.outDir,
    configPath: options.configPath,
    workflowFamilyCatalogPath: options.workflowFamilyCatalogPath,
  });
  const client = options.llmClient ?? createDefaultOpenAiClient(resolved);
  if (!client.generateCandidateWorkflow) {
    throw new Error("Configured LLM client does not implement Call 3.");
  }
  const calls: LearnWorkflowGraphResult["calls"] = [];
  const warnings: string[] = [];
  const rawCandidate = await client.generateCandidateWorkflow({ skill });
  const candidate = normalizeCandidateWorkflow(rawCandidate, skill);
  calls.push({
    label: "call-3",
    metrics: client.getLastInvocationMetrics?.() ?? null,
  });
  warnings.push(...(client.getLastInvocationWarnings?.() ?? []));

  const families = resolved.workflowFamilyCards ?? [];
  let familyMatch: WorkflowFamilyMatch;
  if (families.length === 0) {
    familyMatch = buildEmptyCatalogMatch(candidate);
  } else {
    if (!client.matchWorkflowFamily) {
      throw new Error("Configured LLM client does not implement Call 4.");
    }
    const rawMatch = await client.matchWorkflowFamily({ candidate, families });
    familyMatch = normalizeWorkflowFamilyMatch(rawMatch, candidate, families);
    calls.push({
      label: "call-4",
      metrics: client.getLastInvocationMetrics?.() ?? null,
    });
    warnings.push(...(client.getLastInvocationWarnings?.() ?? []));
  }

  let mergeProposal: WorkflowMergeProposal | undefined;
  let canonicalGraphPath: string | null = null;
  if (familyMatch.decision === "match" && familyMatch.matchedWorkflowId) {
    const canonicalGraph =
      resolved.workflowFamilyGraphs?.[familyMatch.matchedWorkflowId];
    if (!canonicalGraph) {
      throw new Error(
        `Matched family ${familyMatch.matchedWorkflowId} has no canonical graph. Use a v2 family catalog with graphPath.`,
      );
    }
    if (!client.proposeWorkflowMerge) {
      throw new Error("Configured LLM client does not implement Call 5.");
    }
    const rawProposal = await client.proposeWorkflowMerge({
      candidate,
      canonicalGraph,
      skill,
    });
    mergeProposal = normalizeWorkflowMergeProposal({
      raw: rawProposal,
      candidate,
      canonicalGraph,
      skill,
      now: options.now,
    });
    calls.push({
      label: "call-5",
      metrics: client.getLastInvocationMetrics?.() ?? null,
    });
    warnings.push(...(client.getLastInvocationWarnings?.() ?? []));
    canonicalGraphPath =
      resolved.workflowFamilyGraphPaths?.[familyMatch.matchedWorkflowId] ??
      null;
  }

  if (
    familyMatch.decision === "new_family" ||
    familyMatch.decision === "uncertain" ||
    mergeProposal?.result === "incompatible"
  ) {
    const saved = await persistWorkflowGraphDraft({
      draft: buildWorkflowGraphDraftFromCandidate(candidate, skill),
      outDir: options.outDir,
      sourceSkillPath: options.skillPath,
      now: options.now,
    });
    canonicalGraphPath = saved.graphPath;
  }

  const candidatePath = join(options.outDir, WORKFLOW_CANDIDATE_FILE_NAME);
  const familyMatchPath = join(options.outDir, WORKFLOW_FAMILY_MATCH_FILE_NAME);
  const mergeProposalPath = mergeProposal
    ? join(options.outDir, WORKFLOW_MERGE_PROPOSAL_FILE_NAME)
    : null;
  const summaryPath = join(options.outDir, "workflow-learning-summary.json");
  await writeJson(candidatePath, candidate);
  await writeJson(familyMatchPath, familyMatch);
  if (mergeProposal && mergeProposalPath) {
    await writeJson(mergeProposalPath, mergeProposal);
  }
  const result: LearnWorkflowGraphResult = {
    candidate,
    familyMatch,
    ...(mergeProposal ? { mergeProposal } : {}),
    paths: {
      candidatePath,
      familyMatchPath,
      mergeProposalPath,
      canonicalGraphPath,
      summaryPath,
    },
    calls,
    warnings,
  };
  await writeJson(summaryPath, {
    schemaVersion: "oyster-workflow-learning-summary-v1",
    skillPath: options.skillPath,
    outDir: options.outDir,
    candidateId: candidate.candidateId,
    familyMatch,
    mergeResult: mergeProposal?.result ?? null,
    paths: result.paths,
    calls,
    warnings,
  });
  return result;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
