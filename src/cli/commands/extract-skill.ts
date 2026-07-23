import { createInterface } from "node:readline/promises";
import { stdin as stdinStream, stdout as stdoutStream } from "node:process";
import { join, resolve } from "node:path";
import { z } from "zod";
import { runDiscoverWorkflows } from "./discover-workflows.js";
import {
  runExtractSkillLlm,
  type RunExtractSkillLlmOptions,
} from "./extract-skill-llm.js";
import type { ExtractOpenClawSkillLlmResult } from "../../skill/extract-openclaw-llm.js";
import type { WorkflowCandidate } from "../../types/contracts.js";

const wireApiSchema = z.enum(["responses", "chat-completions"]);

const extractSkillArgsSchema = z.object({
  runDir: z.string().min(1),
  out: z.string().min(1).optional(),
  discoveryOut: z.string().min(1).optional(),
  episodeId: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  guidance: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  apiKey: z.string().min(1).optional(),
  baseUrl: z.string().url().optional(),
  wireApi: wireApiSchema.optional(),
  reasoningEffort: z.string().min(1).optional(),
  config: z.string().min(1).optional(),
});

export interface WorkflowSelector {
  selectWorkflow(input: {
    workflowCandidates: WorkflowCandidate[];
  }): Promise<WorkflowCandidate>;
}

export interface RunExtractSkillOptions extends Omit<
  RunExtractSkillLlmOptions,
  "workflowId" | "workflowCandidates" | "selectedWorkflow"
> {
  configPath?: string;
  discoveryOutPath?: string;
  workflowSelector?: WorkflowSelector;
}

export interface RunExtractSkillResult {
  discoveryPath: string | null;
  workflowCandidates: WorkflowCandidate[];
  selectedWorkflow: WorkflowCandidate;
  extractResult: ExtractOpenClawSkillLlmResult;
}

/**
 * EN: High-level wrapper command that runs discovery, prompts one selection, then extracts the skill.
 * @param options wrapper command options.
 * @returns discovery + selected workflow + extraction result.
 */
export async function runExtractSkill(
  options: RunExtractSkillOptions,
): Promise<RunExtractSkillResult> {
  const discoveryResult = await runDiscoverWorkflows({
    runDir: options.runDir,
    outPath:
      options.discoveryOutPath ??
      join(resolve(options.runDir), "workflow-discovery.json"),
    episodeId: options.episodeId,
    skillName: options.skillName,
    generationGuidance: options.generationGuidance,
    model: options.model,
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    wireApi: options.wireApi,
    reasoningEffort: options.reasoningEffort,
    responseReadTimeoutMs: options.responseReadTimeoutMs,
    responseTimeoutMode: options.responseTimeoutMode,
    callProfiles: options.callProfiles,
    configPath: options.configPath,
    now: options.now,
    llmClient: options.llmClient,
  });
  const workflowCandidates = discoveryResult.workflowCandidates;
  const selectedWorkflow =
    workflowCandidates.length <= 1
      ? workflowCandidates[0]
      : await (
          options.workflowSelector ?? DEFAULT_WORKFLOW_SELECTOR
        ).selectWorkflow({
          workflowCandidates,
        });
  const extractResult = await runExtractSkillLlm({
    runDir: options.runDir,
    outDir: options.outDir,
    episodeId: options.episodeId,
    workflowId: selectedWorkflow.workflowId,
    workflowCandidates,
    skillName: options.skillName,
    generationGuidance: options.generationGuidance,
    model: options.model,
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    wireApi: options.wireApi,
    reasoningEffort: options.reasoningEffort,
    responseReadTimeoutMs: options.responseReadTimeoutMs,
    responseTimeoutMode: options.responseTimeoutMode,
    callProfiles: options.callProfiles,
    configPath: options.configPath,
    now: options.now,
    llmClient: options.llmClient,
  });

  return {
    discoveryPath: discoveryResult.path,
    workflowCandidates,
    selectedWorkflow,
    extractResult,
  };
}

/**
 * EN: Parses and validates extract-skill CLI arguments.
 * @param input raw CLI args.
 * @returns typed wrapper options.
 */
export function parseExtractSkillCliArgs(input: {
  runDir: string;
  out?: string;
  discoveryOut?: string;
  episodeId?: string;
  name?: string;
  guidance?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  wireApi?: "responses" | "chat-completions" | string;
  reasoningEffort?: string;
  config?: string;
}): RunExtractSkillOptions {
  const parsed = extractSkillArgsSchema.parse(input);
  return {
    runDir: parsed.runDir,
    outDir: parsed.out,
    discoveryOutPath: parsed.discoveryOut,
    episodeId: parsed.episodeId,
    skillName: parsed.name,
    generationGuidance: parsed.guidance,
    model: parsed.model,
    apiKey: parsed.apiKey,
    baseUrl: parsed.baseUrl,
    wireApi: parsed.wireApi,
    reasoningEffort: parsed.reasoningEffort,
    configPath: parsed.config,
  };
}

const DEFAULT_WORKFLOW_SELECTOR: WorkflowSelector = {
  async selectWorkflow(selectionInput) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      const candidatesText = selectionInput.workflowCandidates
        .map(
          (candidate) =>
            `${candidate.workflowId}: ${candidate.name} (priority=${candidate.priority})`,
        )
        .join(", ");
      throw new Error(
        `Detected multiple workflows in a non-interactive terminal. Run discover-workflows first, then use extract-skill-llm --workflow-id <id>. Candidates: ${candidatesText}`,
      );
    }

    process.stdout.write("Detected multiple workflows:\n");
    selectionInput.workflowCandidates.forEach((candidate, index) => {
      const confidence =
        typeof candidate.confidence === "number"
          ? `, confidence=${candidate.confidence.toFixed(2)}`
          : "";
      process.stdout.write(
        `${index + 1}. ${candidate.name} [${candidate.workflowId}] priority=${candidate.priority}${confidence}\n`,
      );
      process.stdout.write(`   goal: ${candidate.goal}\n`);
      process.stdout.write(`   description: ${candidate.description}\n`);
    });

    const rl = createInterface({ input: stdinStream, output: stdoutStream });
    try {
      while (true) {
        const answer = (
          await rl.question("Choose one workflow to generate (enter number): ")
        ).trim();
        const selectedIndex = Number.parseInt(answer, 10);
        if (
          Number.isInteger(selectedIndex) &&
          selectedIndex >= 1 &&
          selectedIndex <= selectionInput.workflowCandidates.length
        ) {
          return selectionInput.workflowCandidates[selectedIndex - 1];
        }
        process.stdout.write(
          `Please enter a number between 1 and ${selectionInput.workflowCandidates.length}.\n`,
        );
      }
    } finally {
      rl.close();
    }
  },
};
