#!/usr/bin/env node
import { Command } from "commander";
import { parseCaseLoopCliArgs, runCaseLoop } from "./commands/case-loop.js";
import {
  parseDiscoverWorkflowsCliArgs,
  runDiscoverWorkflows,
} from "./commands/discover-workflows.js";
import {
  parseExtractSkillCliArgs,
  runExtractSkill,
} from "./commands/extract-skill.js";
import {
  parseE2eAnalyzeCliArgs,
  runE2eAnalyze,
} from "./commands/e2e-analyze.js";
import {
  parseExtractSkillLlmCliArgs,
  runExtractSkillLlm,
} from "./commands/extract-skill-llm.js";
import {
  parseGenerateHarnessCliArgs,
  runGenerateHarness,
} from "./commands/generate-harness.js";
import {
  parseMaterializeWorkflowGraphCliArgs,
  runMaterializeWorkflowGraph,
} from "./commands/materialize-workflow-graph.js";
import {
  parseLearnWorkflowGraphCliArgs,
  runLearnWorkflowGraph,
} from "./commands/learn-workflow-graph.js";
import {
  parseApplyWorkflowMergeCliArgs,
  parsePersistWorkflowGraphCliArgs,
  parseRenderWorkflowGraphCliArgs,
  parseValidateWorkflowGraphCliArgs,
  runApplyWorkflowMerge,
  runPersistWorkflowGraph,
  runRenderWorkflowGraph,
  runValidateWorkflowGraph,
} from "./commands/manage-workflow-graph.js";
import {
  parseReplayLlmCallCliArgs,
  runReplayLlmCall,
} from "./commands/replay-llm-call.js";
import { parseIngestCliArgs, runIngest } from "./commands/ingest.js";
import {
  parseOpenClawSkillInstallCliArgs,
  parseOpenClawSkillUninstallCliArgs,
  runOpenClawSkillInstall,
  runOpenClawSkillUninstall,
} from "./commands/openclaw-skill.js";
import {
  parseOysterBrowserCliArgs,
  runOysterBrowserCli,
} from "./commands/oyster-browser.js";
import { readCommonLlmOptions, withCommonLlmOptions } from "./llm-options.js";
// EN: Unified CLI entrypoint for oysterworkflow.
const program = new Command();
program
  .name("oysterworkflow")
  .description(
    "Screenpipe ingest pipeline for reusable agent skill generation",
  );

program
  .command("ingest")
  .description(
    "Fetch OCR + audio + UI events, normalize, segment episodes, and write ingest artifacts",
  )
  .requiredOption("--from <ISO>", "Start timestamp (ISO 8601)")
  .requiredOption("--to <ISO>", "End timestamp (ISO 8601)")
  .requiredOption(
    "--apps <csv|*>",
    "Application filter: '*' or comma-separated app names",
  )
  .requiredOption("--out <abs-path>", "Absolute output directory")
  .option("--base-url <url>", "Screenpipe base URL", "http://localhost:3030")
  .action(async (opts) => {
    try {
      // CN/EN: Parse and validate CLI strings into typed ingest options.
      const parsed = parseIngestCliArgs({
        from: String(opts.from),
        to: String(opts.to),
        apps: String(opts.apps),
        out: String(opts.out),
        baseUrl: String(opts.baseUrl),
      });

      const result = await runIngest(parsed);
      // CN/EN: Keep stdout machine-readable JSON for shell automation.
      process.stdout.write(
        `${JSON.stringify(
          {
            runId: result.summary.runId,
            status: result.manifest.status,
            outputRunDir: result.manifest.paths.runDir,
            summaryPath: result.manifest.paths.summary,
          },
          null,
          2,
        )}\n`,
      );
    } catch (error) {
      // CN/EN: Human-readable error goes to stderr; non-zero exit indicates failure.
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`ingest failed: ${message}\n`);
      process.exitCode = 1;
    }
  });

program
  .command("case-loop")
  .description(
    "Run fixed 11:50-11:57 Screenpipe case, evaluate skill quality, update PRD when needed",
  )
  .requiredOption(
    "--out <abs-path>",
    "Absolute output root directory for ingest runs",
  )
  .option(
    "--apps <csv|*>",
    "Application filter: '*' or comma-separated app names",
    "*",
  )
  .option("--base-url <url>", "Screenpipe base URL", "http://localhost:3030")
  .option(
    "--date <YYYY-MM-DD>",
    "Local date for test case window (default: 2026-03-03)",
  )
  .option("--from-time <HH:mm:ss>", "Local start time (default: 11:50:00)")
  .option("--to-time <HH:mm:ss>", "Local end time (default: 11:57:00)")
  .option(
    "--min-score <n>",
    "Minimum acceptable quality score (1-100)",
    (value) => Number(value),
  )
  .option("--case-title <text>", "Case title shown in PRD")
  .option("--prd <abs-path>", "Absolute path to PRD.md (default: <cwd>/PRD.md)")
  .option(
    "--config <path>",
    "LLM config JSON path (default: prefer <repo>/config/llm.local.json, fallback to <repo>/config/llm.config.json)",
  )
  .option("--model <name>", "OpenAI-compatible model override")
  .option("--api-key <key>", "OpenAI-compatible API key override")
  .option("--llm-base-url <url>", "OpenAI-compatible API base URL override")
  .option("--wire-api <mode>", "Wire API mode: responses | chat-completions")
  .option("--reasoning-effort <level>", "Reasoning effort hint")
  .option("--skill-name <text>", "Override generated skill name")
  .action(async (opts) => {
    try {
      const parsed = parseCaseLoopCliArgs({
        out: String(opts.out),
        apps: opts.apps ? String(opts.apps) : undefined,
        baseUrl: opts.baseUrl ? String(opts.baseUrl) : undefined,
        date: opts.date ? String(opts.date) : undefined,
        fromTime: opts.fromTime ? String(opts.fromTime) : undefined,
        toTime: opts.toTime ? String(opts.toTime) : undefined,
        minScore: opts.minScore as number | undefined,
        caseTitle: opts.caseTitle ? String(opts.caseTitle) : undefined,
        prd: opts.prd ? String(opts.prd) : undefined,
        config: opts.config ? String(opts.config) : undefined,
        model: opts.model ? String(opts.model) : undefined,
        apiKey: opts.apiKey ? String(opts.apiKey) : undefined,
        llmBaseUrl: opts.llmBaseUrl ? String(opts.llmBaseUrl) : undefined,
        wireApi: opts.wireApi ? String(opts.wireApi) : undefined,
        reasoningEffort: opts.reasoningEffort
          ? String(opts.reasoningEffort)
          : undefined,
        skillName: opts.skillName ? String(opts.skillName) : undefined,
      });

      const result = await runCaseLoop(parsed);
      process.stdout.write(
        `${JSON.stringify(
          {
            runId: result.runId,
            runDir: result.runDir,
            fromIso: result.fromIso,
            toIso: result.toIso,
            score: result.score,
            threshold: result.threshold,
            verdict: result.verdict,
            qualityPath: result.qualityPath,
            prdPath: result.prdPath,
            prdUpdated: result.prdUpdated,
            skillPath: result.skillPath,
            summaryPath: result.summaryPath,
          },
          null,
          2,
        )}\n`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`case-loop failed: ${message}\n`);
      process.exitCode = 1;
    }
  });

program
  .command("oyster-browser")
  .description(
    "Run one OysterWorkflow browser action through the configured BrowserAct provider",
  )
  .argument(
    "<action>",
    "Browser action such as open, state, click, input, eval",
  )
  .option("--json <payload>", "JSON action payload")
  .option("--json-file <path>", "Path to a JSON action payload file")
  .action(async (action, opts) => {
    try {
      const parsed = parseOysterBrowserCliArgs({
        action: String(action),
        json: opts.json ? String(opts.json) : undefined,
        jsonFile: opts.jsonFile ? String(opts.jsonFile) : undefined,
      });
      const result = await runOysterBrowserCli(parsed);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if (!result.ok) {
        process.exitCode = 1;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`oyster-browser failed: ${message}\n`);
      process.exitCode = 1;
    }
  });

withCommonLlmOptions(
  program
    .command("discover-workflows")
    .description(
      "Discover workflow candidates from one completed ingest run and persist workflow-discovery.json",
    )
    .requiredOption(
      "--run-dir <abs-path>",
      "Absolute path to one run directory",
    )
    .option(
      "--out <abs-path>",
      "Absolute output path for workflow-discovery.json (default: <run-dir>/workflow-discovery.json)",
    )
    .option("--episode-id <id>", "Explicit episode id to analyze")
    .option("--name <text>", "Optional preferred skill/workflow name hint")
    .option(
      "--guidance <text>",
      "User generation guidance to apply while discovering workflows",
    ),
).action(async (opts) => {
  try {
    const parsed = parseDiscoverWorkflowsCliArgs({
      runDir: String(opts.runDir),
      out: opts.out ? String(opts.out) : undefined,
      episodeId: opts.episodeId ? String(opts.episodeId) : undefined,
      name: opts.name ? String(opts.name) : undefined,
      guidance: opts.guidance ? String(opts.guidance) : undefined,
      ...readCommonLlmOptions(opts),
    });
    const result = await runDiscoverWorkflows(parsed);
    process.stdout.write(
      `${JSON.stringify(
        {
          runId: result.runId,
          episodeId: result.episode.id,
          workflowCount: result.workflowCandidates.length,
          discoveryPath: result.path,
          workflowCandidates: result.workflowCandidates,
        },
        null,
        2,
      )}\n`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`discover-workflows failed: ${message}\n`);
    process.exitCode = 1;
  }
});

withCommonLlmOptions(
  program
    .command("extract-skill")
    .description(
      "Discover workflows, prompt for one selection when needed, then extract one agent skill",
    )
    .requiredOption(
      "--run-dir <abs-path>",
      "Absolute path to one run directory",
    )
    .option(
      "--out <abs-path>",
      "Absolute output directory (default: <run-dir>/openclaw-llm)",
    )
    .option(
      "--discovery-out <abs-path>",
      "Absolute output path for workflow-discovery.json (default: <run-dir>/workflow-discovery.json)",
    )
    .option("--episode-id <id>", "Explicit episode id to extract")
    .option("--name <text>", "Override generated skill name")
    .option(
      "--guidance <text>",
      "User generation guidance to apply while discovering and creating the skill",
    ),
).action(async (opts) => {
  try {
    const parsed = parseExtractSkillCliArgs({
      runDir: String(opts.runDir),
      out: opts.out ? String(opts.out) : undefined,
      discoveryOut: opts.discoveryOut ? String(opts.discoveryOut) : undefined,
      episodeId: opts.episodeId ? String(opts.episodeId) : undefined,
      name: opts.name ? String(opts.name) : undefined,
      guidance: opts.guidance ? String(opts.guidance) : undefined,
      ...readCommonLlmOptions(opts),
    });
    const result = await runExtractSkill(parsed);
    process.stdout.write(
      `${JSON.stringify(
        {
          runId: result.extractResult.summary.runId,
          episodeId: result.extractResult.summary.episodeId,
          selectedWorkflowId: result.selectedWorkflow.workflowId,
          workflowCount: result.workflowCandidates.length,
          discoveryPath: result.discoveryPath,
          skillId: result.extractResult.summary.skillId,
          stepsCount: result.extractResult.summary.stepsCount,
          skillPath: result.extractResult.paths.skillPath,
          summaryPath: result.extractResult.paths.summaryPath,
          workflowCandidatePath:
            result.extractResult.paths.workflowCandidatePath,
          workflowFamilyMatchPath:
            result.extractResult.paths.workflowFamilyMatchPath,
          workflowMergeProposalPath:
            result.extractResult.paths.workflowMergeProposalPath,
          workflowGraphPath: result.extractResult.paths.workflowGraphPath,
          workflowMarkdownPath: result.extractResult.paths.workflowMarkdownPath,
          workflowRevisionsDir: result.extractResult.paths.workflowRevisionsDir,
        },
        null,
        2,
      )}\n`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`extract-skill failed: ${message}\n`);
    process.exitCode = 1;
  }
});

program
  .command("e2e-analyze")
  .description(
    "Replay an explicit e2e case catalog and generate completeness + skill quality analysis",
  )
  .option(
    "--out <abs-path>",
    "Absolute output directory (default: .runs/e2e-analysis)",
  )
  .requiredOption(
    "--cases <path>",
    "Explicit case catalog path; no default cases are run automatically",
  )
  .action(async (opts) => {
    try {
      const parsed = parseE2eAnalyzeCliArgs({
        out: opts.out ? String(opts.out) : undefined,
        cases: String(opts.cases),
      });

      const result = await runE2eAnalyze(parsed);
      process.stdout.write(
        `${JSON.stringify(
          {
            reportPath: result.reportPath,
            markdownPath: result.markdownPath,
            casesTotal: result.report.overview.casesTotal,
            completenessPassCount: result.report.overview.completenessPassCount,
            qualityPassCount: result.report.overview.qualityPassCount,
            autonomousIdealPassCount:
              result.report.overview.autonomousIdealPassCount,
          },
          null,
          2,
        )}\n`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`e2e-analyze failed: ${message}\n`);
      process.exitCode = 1;
    }
  });

program
  .command("learn-workflow-graph")
  .description(
    "Run Call 3, Call 4, and matched Call 5 for an existing skill.json without rerunning Call 2",
  )
  .requiredOption("--skill <abs-path>", "Absolute path to skill.json")
  .requiredOption("--out <abs-path>", "Absolute output directory")
  .option(
    "--workflow-family-catalog <abs-path>",
    "Optional v1/v2 workflow family catalog; v2 graphPath enables Call 5",
  )
  .option("--config <abs-path>", "Optional LLM config path")
  .action(async (opts) => {
    try {
      const parsed = parseLearnWorkflowGraphCliArgs({
        skill: String(opts.skill),
        out: String(opts.out),
        workflowFamilyCatalog: opts.workflowFamilyCatalog
          ? String(opts.workflowFamilyCatalog)
          : undefined,
        config: opts.config ? String(opts.config) : undefined,
      });
      const result = await runLearnWorkflowGraph(parsed);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`learn-workflow-graph failed: ${message}\n`);
      process.exitCode = 1;
    }
  });

program
  .command("apply-workflow-merge")
  .description(
    "Explicitly apply a validated Call 5 proposal as a new canonical workflow revision",
  )
  .requiredOption("--workflow <abs-path>", "Current canonical workflow.json")
  .requiredOption(
    "--proposal <abs-path>",
    "Validated workflow-merge-proposal.json",
  )
  .requiredOption("--out <abs-path>", "Canonical workflow family directory")
  .option("--source-skill <abs-path>", "Optional source skill.json path")
  .action(async (opts) => {
    try {
      const parsed = parseApplyWorkflowMergeCliArgs({
        workflow: String(opts.workflow),
        proposal: String(opts.proposal),
        out: String(opts.out),
        sourceSkill: opts.sourceSkill ? String(opts.sourceSkill) : undefined,
      });
      const result = await runApplyWorkflowMerge(parsed);
      process.stdout.write(
        `${JSON.stringify(
          {
            workflowId: result.graph.workflowId,
            revision: result.graph.revision,
            workflowGraphPath: result.graphPath,
            workflowMarkdownPath: result.markdownPath,
            workflowRevisionPath: result.revisionPath,
          },
          null,
          2,
        )}\n`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`apply-workflow-merge failed: ${message}\n`);
      process.exitCode = 1;
    }
  });

program
  .command("materialize-workflow-graph")
  .description(
    "Convert an existing linear skill.json into canonical workflow.json plus an Obsidian-compatible WORKFLOW.md projection",
  )
  .requiredOption("--skill <abs-path>", "Absolute path to skill.json")
  .option(
    "--out <abs-path>",
    "Absolute output directory (default: directory containing skill.json)",
  )
  .action(async (opts) => {
    try {
      const parsed = parseMaterializeWorkflowGraphCliArgs({
        skill: String(opts.skill),
        out: opts.out ? String(opts.out) : undefined,
      });
      const result = await runMaterializeWorkflowGraph(parsed);
      process.stdout.write(
        `${JSON.stringify(
          {
            workflowId: result.graph.workflowId,
            revision: result.graph.revision,
            workflowGraphPath: result.graphPath,
            workflowMarkdownPath: result.markdownPath,
            workflowRevisionPath: result.revisionPath,
          },
          null,
          2,
        )}\n`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`materialize-workflow-graph failed: ${message}\n`);
      process.exitCode = 1;
    }
  });

program
  .command("validate-workflow-graph")
  .description("Validate canonical workflow.json / 校验规范执行图")
  .requiredOption("--workflow <abs-path>", "Absolute workflow.json path")
  .action(async (opts) => {
    try {
      const parsed = parseValidateWorkflowGraphCliArgs({
        workflow: String(opts.workflow),
      });
      const graph = await runValidateWorkflowGraph(parsed);
      process.stdout.write(
        `${JSON.stringify(
          {
            valid: true,
            workflowId: graph.workflowId,
            revision: graph.revision,
            nodeCount: graph.nodes.length,
            transitionCount: graph.transitions.length,
          },
          null,
          2,
        )}\n`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`validate-workflow-graph failed: ${message}\n`);
      process.exitCode = 1;
    }
  });

program
  .command("render-workflow-graph")
  .description(
    "Render WORKFLOW.md from canonical workflow.json / 从规范执行图生成审查文档",
  )
  .requiredOption("--workflow <abs-path>", "Absolute workflow.json path")
  .option("--out <abs-path>", "Absolute Markdown output path")
  .option("--source-skill <abs-path>", "Optional source skill.json path")
  .action(async (opts) => {
    try {
      const parsed = parseRenderWorkflowGraphCliArgs({
        workflow: String(opts.workflow),
        out: opts.out ? String(opts.out) : undefined,
        sourceSkill: opts.sourceSkill ? String(opts.sourceSkill) : undefined,
      });
      const result = await runRenderWorkflowGraph(parsed);
      process.stdout.write(
        `${JSON.stringify(
          {
            workflowId: result.graph.workflowId,
            revision: result.graph.revision,
            workflowMarkdownPath: result.markdownPath,
          },
          null,
          2,
        )}\n`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`render-workflow-graph failed: ${message}\n`);
      process.exitCode = 1;
    }
  });

program
  .command("persist-workflow-graph")
  .description(
    "Persist a graph draft as a new canonical revision / 保存新的规范执行图版本",
  )
  .requiredOption("--input <abs-path>", "Absolute graph draft JSON path")
  .requiredOption("--out <abs-path>", "Absolute canonical graph directory")
  .option("--source-skill <abs-path>", "Optional source skill.json path")
  .action(async (opts) => {
    try {
      const parsed = parsePersistWorkflowGraphCliArgs({
        input: String(opts.input),
        out: String(opts.out),
        sourceSkill: opts.sourceSkill ? String(opts.sourceSkill) : undefined,
      });
      const result = await runPersistWorkflowGraph(parsed);
      process.stdout.write(
        `${JSON.stringify(
          {
            workflowId: result.graph.workflowId,
            revision: result.graph.revision,
            workflowGraphPath: result.graphPath,
            workflowMarkdownPath: result.markdownPath,
            workflowRevisionPath: result.revisionPath,
          },
          null,
          2,
        )}\n`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`persist-workflow-graph failed: ${message}\n`);
      process.exitCode = 1;
    }
  });

withCommonLlmOptions(
  program
    .command("extract-skill-llm")
    .description(
      "Extract one agent skill with LLM reasoning from a completed ingest run",
    )
    .requiredOption(
      "--run-dir <abs-path>",
      "Absolute path to one run directory",
    )
    .option(
      "--out <abs-path>",
      "Absolute output directory (default: <run-dir>/openclaw-llm)",
    )
    .option("--episode-id <id>", "Explicit episode id to extract")
    .option("--workflow-id <id>", "Explicit workflow id to extract")
    .option("--name <text>", "Override generated skill name")
    .option(
      "--guidance <text>",
      "User generation guidance to apply while creating the skill",
    )
    .option(
      "--workflow-family-catalog <abs-path>",
      "Optional compact Workflow Family catalog JSON for Call 4 matching",
    ),
)
  .option(
    "--enable-generalization",
    "Enable optional generalization component after skill-extraction",
  )
  .option(
    "--disable-generalization",
    "Disable optional generalization component after skill-extraction",
  )
  .option(
    "--enable-planner-optimization",
    "Enable optional planner-optimization component after skill-extraction",
  )
  .option(
    "--disable-planner-optimization",
    "Disable optional planner-optimization component after skill-extraction",
  )
  .action(async (opts) => {
    try {
      // CN/EN: Parse CLI args into typed LLM extraction options.
      const enableGeneralization =
        opts.enableGeneralization === true
          ? true
          : opts.disableGeneralization === true
            ? false
            : undefined;
      const enablePlannerOptimization =
        opts.enablePlannerOptimization === true
          ? true
          : opts.disablePlannerOptimization === true
            ? false
            : undefined;
      const parsed = parseExtractSkillLlmCliArgs({
        runDir: String(opts.runDir),
        out: opts.out ? String(opts.out) : undefined,
        episodeId: opts.episodeId ? String(opts.episodeId) : undefined,
        workflowId: opts.workflowId ? String(opts.workflowId) : undefined,
        name: opts.name ? String(opts.name) : undefined,
        guidance: opts.guidance ? String(opts.guidance) : undefined,
        workflowFamilyCatalog: opts.workflowFamilyCatalog
          ? String(opts.workflowFamilyCatalog)
          : undefined,
        ...readCommonLlmOptions(opts),
        enableGeneralization,
        enablePlannerOptimization,
      });

      const result = await runExtractSkillLlm(parsed);
      // CN/EN: Return key ids and output files for script integration.
      process.stdout.write(
        `${JSON.stringify(
          {
            runId: result.summary.runId,
            episodeId: result.summary.episodeId,
            selectedWorkflowId: result.selectedWorkflow.workflowId,
            skillId: result.summary.skillId,
            stepsCount: result.summary.stepsCount,
            skillPath: result.paths.skillPath,
            summaryPath: result.paths.summaryPath,
            workflowCandidatePath: result.paths.workflowCandidatePath,
            workflowFamilyMatchPath: result.paths.workflowFamilyMatchPath,
            workflowMergeProposalPath: result.paths.workflowMergeProposalPath,
            workflowGraphPath: result.paths.workflowGraphPath,
            workflowMarkdownPath: result.paths.workflowMarkdownPath,
            workflowRevisionsDir: result.paths.workflowRevisionsDir,
          },
          null,
          2,
        )}\n`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`extract-skill-llm failed: ${message}\n`);
      process.exitCode = 1;
    }
  });

withCommonLlmOptions(
  program
    .command("generate-harness")
    .description(
      "Generate a skill-level harness package from an existing skill.json",
    )
    .requiredOption(
      "--skill <abs-path>",
      "Absolute path to one existing skill.json",
    )
    .option(
      "--out <abs-path>",
      "Absolute output directory (default: sibling harness directory)",
    )
    .option("--mode <mode>", "Harness mode: autonomous | collaborative"),
).action(async (opts) => {
  try {
    const parsed = parseGenerateHarnessCliArgs({
      skill: String(opts.skill),
      out: opts.out ? String(opts.out) : undefined,
      mode: opts.mode ? String(opts.mode) : undefined,
      ...readCommonLlmOptions(opts),
    });
    const result = await runGenerateHarness(parsed);
    process.stdout.write(
      `${JSON.stringify(
        {
          sourceSkillId: result.summary.sourceSkillId,
          mode: result.summary.mode,
          outDir: result.summary.output.outDir,
          generationRecordDir: result.summary.output.generationRecordDir,
          packageDir: result.summary.output.packageDir,
          skillPath: result.summary.output.skillPath,
          harnessJsonPath: result.summary.output.harnessJsonPath,
          llm: result.summary.llm ?? null,
        },
        null,
        2,
      )}\n`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`generate-harness failed: ${message}\n`);
    process.exitCode = 1;
  }
});

withCommonLlmOptions(
  program
    .command("replay-llm-call")
    .description(
      "Replay one specific LLM call (planner-optimization/scenario-prediction/scenario-generalization) against existing skill artifacts",
    )
    .requiredOption(
      "--call <name>",
      "Target call: planner-optimization | scenario-prediction | scenario-generalization",
    )
    .requiredOption(
      "--skill-path <abs-path>",
      "Absolute path to one existing skill.json",
    )
    .option(
      "--summary-path <abs-path>",
      "Absolute path to summary.json (default: sibling summary.json next to --skill-path)",
    )
    .option(
      "--workflow-path <abs-path>",
      "Absolute path to workflow-discovery.json or one workflow JSON override",
    )
    .option(
      "--predicted-scenarios-path <abs-path>",
      "Absolute path to predicted-scenarios.json override for scenario-generalization",
    )
    .option(
      "--scenario-path <abs-path>",
      "Absolute path to one scenario JSON or scenario array JSON for scenario-generalization",
    )
    .option(
      "--scenario-id <id>",
      "Scenario id to select for scenario-generalization (defaults to first scenario)",
    )
    .option(
      "--out <abs-path>",
      "Absolute output directory (default: <cwd>/.runs/llm-call-replay-...)",
    ),
).action(async (opts) => {
  try {
    const parsed = parseReplayLlmCallCliArgs({
      call: String(opts.call),
      skillPath: String(opts.skillPath),
      summaryPath: opts.summaryPath ? String(opts.summaryPath) : undefined,
      workflowPath: opts.workflowPath ? String(opts.workflowPath) : undefined,
      predictedScenariosPath: opts.predictedScenariosPath
        ? String(opts.predictedScenariosPath)
        : undefined,
      scenarioPath: opts.scenarioPath ? String(opts.scenarioPath) : undefined,
      scenarioId: opts.scenarioId ? String(opts.scenarioId) : undefined,
      out: opts.out ? String(opts.out) : undefined,
      ...readCommonLlmOptions(opts),
    });
    const result = await runReplayLlmCall(parsed);
    process.stdout.write(
      `${JSON.stringify(
        {
          call: result.call,
          outDir: result.outDir,
          resultPath: result.resultPath,
          reportPath: result.reportPath,
          traceDir: result.traceDir,
          selectedWorkflowId: result.selectedWorkflow?.workflowId ?? null,
          scenarioId: result.scenario?.scenarioId ?? null,
        },
        null,
        2,
      )}\n`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`replay-llm-call failed: ${message}\n`);
    process.exitCode = 1;
  }
});

const openClawSkillProgram = program
  .command("openclaw-skill")
  .description(
    "Install or uninstall generated skills as OpenClaw-discoverable directories",
  );

openClawSkillProgram
  .command("install")
  .description(
    "Install one generated skill.json as an OpenClaw skill directory and verify discovery",
  )
  .requiredOption("--skill-path <abs-path>", "Absolute path to one skill.json")
  .option(
    "--summary-path <abs-path>",
    "Absolute path to companion summary.json (default: sibling summary.json when present)",
  )
  .option(
    "--install-name <text>",
    "Override generated install name before normalization",
  )
  .option(
    "--install-root <abs-path>",
    "Absolute install root (default: ~/.agents/skills)",
  )
  .option(
    "--run",
    "Run a planning-only smoke test via `openclaw agent --local` after install",
  )
  .action(async (opts) => {
    try {
      const parsed = parseOpenClawSkillInstallCliArgs({
        skillPath: String(opts.skillPath),
        summaryPath: opts.summaryPath ? String(opts.summaryPath) : undefined,
        installName: opts.installName ? String(opts.installName) : undefined,
        installRoot: opts.installRoot ? String(opts.installRoot) : undefined,
        run: Boolean(opts.run),
      });
      const result = await runOpenClawSkillInstall(parsed);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`openclaw-skill install failed: ${message}\n`);
      process.exitCode = 1;
    }
  });

openClawSkillProgram
  .command("uninstall")
  .description(
    "Uninstall one previously exported OpenClaw skill directory created by this tool",
  )
  .requiredOption("--name <install-name>", "Generated install name to remove")
  .option(
    "--install-root <abs-path>",
    "Absolute install root (default: ~/.agents/skills)",
  )
  .action(async (opts) => {
    try {
      const parsed = parseOpenClawSkillUninstallCliArgs({
        name: String(opts.name),
        installRoot: opts.installRoot ? String(opts.installRoot) : undefined,
      });
      const result = await runOpenClawSkillUninstall(parsed);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`openclaw-skill uninstall failed: ${message}\n`);
      process.exitCode = 1;
    }
  });
// EN: Async parse allows command actions to await I/O safely.
program.parseAsync(process.argv);
