import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import {
  appendWorkflowGraphSkillGuide,
  assertWorkflowGraphSourceSkill,
  loadSiblingWorkflowGraph,
  materializeWorkflowGraphPackage,
} from "../../skill/workflow-graph-package.js";
import type { OysterWorkflowGraph } from "../../types/contracts.js";

export const DEFAULT_OPENCLAW_INSTALL_ROOT = join(
  os.homedir(),
  ".agents",
  "skills",
);
const GENERATED_PREFIX = "generated-";
const GENERATED_NAME_PATTERN =
  /^generated-[a-z0-9]+(?:-[a-z0-9]+)*(?:-v\d+)?$/i;
const VERSIONED_INSTALL_NAME_PATTERN = /^(?<baseName>.+)-v(?<version>\d+)$/i;
const OPENCLAW_EXECUTABLE_NAME = "openclaw";
const OPENCLAW_EXECUTABLE_ENV_VARS = [
  "OYSTERWORKFLOW_OPENCLAW_PATH",
  "TRACE2OPENCLAW_OPENCLAW_PATH",
  "OPENCLAW_PATH",
] as const;
const OPENCLAW_EXECUTABLE_FALLBACK_PATHS = [
  "/opt/homebrew/bin/openclaw",
  "/usr/local/bin/openclaw",
] as const;
const OPENCLAW_COMMAND_TIMEOUT_MS = 120_000;
const OPENCLAW_COMMAND_TERMINATION_GRACE_MS = 750;
const OPENCLAW_COMMAND_FORCE_SETTLE_MS = 250;
const OPENCLAW_COMMAND_OUTPUT_LIMIT_BYTES = 1024 * 1024;

const installArgsSchema = z.object({
  skillPath: z.string().min(1),
  summaryPath: z.string().min(1).optional(),
  installName: z.string().min(1).optional(),
  installRoot: z.string().min(1).optional(),
  run: z.boolean().optional().default(false),
});

const uninstallArgsSchema = z.object({
  name: z.string().min(1),
  installRoot: z.string().min(1).optional(),
});

const skillSourceSchema = z.object({
  runId: z.string().min(1),
  runDir: z.string().min(1),
  episodeId: z.string().min(1),
  startTs: z.string().min(1),
  endTs: z.string().min(1),
});

const structuredSkillFieldSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  required: z.boolean().optional(),
});

const structuredSkillAssetValueSchema = z.union([
  z.string().min(1),
  z.array(z.string().min(1)).min(1),
  z.record(z.string(), z.string().min(1)),
]);

const structuredSkillAssetSchema = z.object({
  name: z.string().min(1),
  value: structuredSkillAssetValueSchema,
  notes: z.string().optional(),
});

const inlineSkillAssetsSchema = z.preprocess(
  normalizeInlineSkillAssetsInput,
  z.array(structuredSkillAssetSchema).default([]),
);

const skillFieldListSchema = z.preprocess(
  normalizeStructuredSkillFieldListInput,
  z.array(structuredSkillFieldSchema).default([]),
);

const evidenceSchema = z.object({
  totalEvents: z.coerce.number().int().nonnegative().default(0),
  anchorEvents: z.coerce.number().int().nonnegative().default(0),
  ocrEvents: z.coerce.number().int().nonnegative().default(0),
  appsSeen: z.array(z.string()).default([]),
  windowsSeen: z.array(z.string()).default([]),
});

const stepSchema = z.object({
  step: z.coerce.number().int().min(1),
  instruction: z.string().min(1),
  intent: z.string().min(1),
  operationApp: z.string().min(1),
  hints: z.array(z.string()).optional().default([]),
  referenceRefs: z.array(z.string().min(1)).optional(),
});

const skillSchema = z.object({
  schemaVersion: z.literal("openclaw-skill-v1"),
  promptSet: z.string().nullable().optional().default(null),
  skillId: z.string().min(1),
  skillName: z.string().min(1),
  generatedAt: z.string().min(1),
  source: skillSourceSchema,
  executionMode: z.string().min(1).optional(),
  shortDescription: z.string().optional().default(""),
  description: z.string().optional().default(""),
  goal: z.string().min(1),
  whenToUse: z.array(z.string().min(1)).min(1),
  whenNotToUse: z.array(z.string()).optional().default([]),
  inputs: skillFieldListSchema,
  outputs: skillFieldListSchema,
  prerequisites: z.array(z.string().min(1)).min(1),
  steps: z.array(stepSchema).min(1),
  successCriteria: z.array(z.string().min(1)).min(1),
  failureModes: z.array(z.string()).optional().default([]),
  fallback: z.array(z.string()).optional().default([]),
  examples: z.array(z.string()).optional().default([]),
  tags: z.array(z.string()).optional().default([]),
  assets: inlineSkillAssetsSchema,
  references: z
    .array(
      structuredSkillAssetSchema.extend({
        id: z.string().min(1),
      }),
    )
    .optional(),
  evidence: evidenceSchema.optional().default({
    totalEvents: 0,
    anchorEvents: 0,
    ocrEvents: 0,
    appsSeen: [],
    windowsSeen: [],
  }),
});

type ValidatedSkill = z.infer<typeof skillSchema>;

export interface OpenClawCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface OpenClawCommandRunner {
  run(command: string, args: string[]): Promise<OpenClawCommandResult>;
}

export interface SpawnCommandRunnerOptions {
  timeoutMs?: number;
  terminationGraceMs?: number;
  forceSettleMs?: number;
}

export interface ResolveOpenClawExecutablePathOptions {
  env?: NodeJS.ProcessEnv;
  isExecutablePath?: (filePath: string) => Promise<boolean>;
}

export interface ParseOpenClawSkillInstallCliInput {
  skillPath: string;
  summaryPath?: string;
  installName?: string;
  installRoot?: string;
  run?: boolean;
}

export interface RunOpenClawSkillInstallOptions {
  skillPath: string;
  installName?: string;
  installRoot: string;
  now?: Date;
  commandRunner?: OpenClawCommandRunner;
}

export interface ParseOpenClawSkillUninstallCliInput {
  name: string;
  installRoot?: string;
}

export interface RunOpenClawSkillUninstallOptions {
  installName: string;
  installRoot: string;
}

export interface OpenClawSkillInstallResult {
  installName: string;
  installDir: string;
  skillMdPath: string;
  sourceSkillPath: string;
  workflowGraph?: InstalledWorkflowGraphResult | null;
  validation: {
    skill: {
      ok: true;
      skillId: string;
      stepsCount: number;
      whenToUseCount: number;
      prerequisitesCount: number;
      successCriteriaCount: number;
    };
  };
}

export type OpenClawSkillExportResult = OpenClawSkillInstallResult;

export interface OpenClawSkillUninstallResult {
  installName: string;
  installDir: string;
  removed: true;
}

interface InstallSourceFiles {
  skillPath: string;
}

interface InstallValidationResult {
  skill: ValidatedSkill;
  workflowGraph: {
    graph: OysterWorkflowGraph;
    graphPath: string;
  } | null;
  result: OpenClawSkillInstallResult["validation"];
}

export interface InstalledWorkflowGraphResult {
  workflowId: string;
  revisionId: string;
  graphPath: string;
  markdownPath: string;
  revisionsDir: string;
}

/**
 * EN: Parses install CLI arguments and keeps only the skill package inputs.
 * @param input raw CLI input.
 * @returns normalized install options.
 */
export function parseOpenClawSkillInstallCliArgs(
  input: ParseOpenClawSkillInstallCliInput,
): RunOpenClawSkillInstallOptions {
  const parsed = installArgsSchema.parse(input);
  const skillPath = normalizeCliAbsolutePath(parsed.skillPath, "--skill-path");
  const installRoot =
    parsed.installRoot !== undefined
      ? normalizeCliAbsolutePath(parsed.installRoot, "--install-root")
      : DEFAULT_OPENCLAW_INSTALL_ROOT;

  return {
    skillPath,
    installName: parsed.installName,
    installRoot,
  };
}

/**
 * EN: Parses uninstall CLI arguments and fills default install root.
 * @param input raw CLI input.
 * @returns normalized uninstall options.
 */
export function parseOpenClawSkillUninstallCliArgs(
  input: ParseOpenClawSkillUninstallCliInput,
): RunOpenClawSkillUninstallOptions {
  const parsed = uninstallArgsSchema.parse(input);
  const installRoot =
    parsed.installRoot !== undefined
      ? normalizeCliAbsolutePath(parsed.installRoot, "--install-root")
      : DEFAULT_OPENCLAW_INSTALL_ROOT;

  return {
    installName: normalizeInstallNameForLookup(parsed.name),
    installRoot,
  };
}

/**
 * EN: Installs one structured skill as a generic agent-readable skill directory.
 * 中文: 将结构化 skill 安装为通用 Agent 可读的 skill 目录。
 * @param options install options.
 * @returns install result summary.
 */
export async function runOpenClawSkillInstall(
  options: RunOpenClawSkillInstallOptions,
): Promise<OpenClawSkillInstallResult> {
  return materializeOpenClawSkill(options);
}

/**
 * EN: Materializes the shared filesystem representation used by install and export.
 * 中文: 物化安装与导出共同使用的文件系统 skill 表示。
 * @param options normalized source and destination options.
 * @returns materialized skill paths and validation summary.
 */
async function materializeOpenClawSkill(
  options: RunOpenClawSkillInstallOptions,
): Promise<OpenClawSkillInstallResult> {
  const sourceFiles = await resolveInstallSourceFiles(options);
  const validation = await loadAndValidateInstallSources(sourceFiles);
  const baseInstallName = buildGeneratedInstallName(
    options.installName ?? validation.skill.skillName,
    validation.skill.skillId,
  );
  const { installName, installDir } = await reserveInstallDirectory(
    options.installRoot,
    baseInstallName,
  );

  const materialized = await materializeAgentSkillDirectory({
    installDir,
    installName,
    validation,
  });

  return {
    installName,
    installDir,
    skillMdPath: materialized.skillMdPath,
    sourceSkillPath: sourceFiles.skillPath,
    workflowGraph: materialized.workflowGraph,
    validation: validation.result,
  };
}

/**
 * EN: Exports one structured skill into a discoverable skill directory without invoking OpenClaw CLI checks.
 * @param options normalized install options including the destination root.
 * @returns export result summary for file-system-only installs.
 */
export async function runOpenClawSkillExport(
  options: RunOpenClawSkillInstallOptions,
): Promise<OpenClawSkillExportResult> {
  return materializeOpenClawSkill(options);
}

/**
 * EN: Uninstalls one installed skill previously generated by oysterworkflow.
 * @param options uninstall options.
 * @returns uninstall result summary.
 */
export async function runOpenClawSkillUninstall(
  options: RunOpenClawSkillUninstallOptions,
): Promise<OpenClawSkillUninstallResult> {
  const installName = normalizeInstallNameForLookup(options.installName);
  const installDir = join(options.installRoot, installName);

  await assertPathExists(
    installDir,
    `Installed skill directory not found: ${installDir}`,
  );

  await rm(installDir, { recursive: true, force: false });
  return {
    installName,
    installDir,
    removed: true,
  };
}

async function resolveInstallSourceFiles(
  options: RunOpenClawSkillInstallOptions,
): Promise<InstallSourceFiles> {
  await assertPathExists(
    options.skillPath,
    `Skill file not found: ${options.skillPath}`,
  );

  return {
    skillPath: options.skillPath,
  };
}

async function loadAndValidateInstallSources(
  input: InstallSourceFiles,
): Promise<InstallValidationResult> {
  const skill = skillSchema.parse(
    await readJsonFile(input.skillPath, "skill"),
  ) as ValidatedSkill;
  assertSequentialSteps(skill.steps);
  const workflowGraph = await loadSiblingWorkflowGraph(input.skillPath);
  if (workflowGraph) {
    assertWorkflowGraphSourceSkill(workflowGraph.graph, skill.skillId);
  }

  return {
    skill,
    workflowGraph,
    result: {
      skill: {
        ok: true,
        skillId: skill.skillId,
        stepsCount: skill.steps.length,
        whenToUseCount: skill.whenToUse.length,
        prerequisitesCount: skill.prerequisites.length,
        successCriteriaCount: skill.successCriteria.length,
      },
    },
  };
}

async function materializeAgentSkillDirectory(input: {
  installDir: string;
  installName: string;
  validation: InstallValidationResult;
}): Promise<{
  skillMdPath: string;
  workflowGraph: InstalledWorkflowGraphResult | null;
}> {
  const skillMdPath = join(input.installDir, "SKILL.md");
  const baseMarkdown = buildSkillMarkdown({
    installName: input.installName,
    skill: input.validation.skill,
  });
  const skillMarkdown = input.validation.workflowGraph
    ? appendWorkflowGraphSkillGuide(
        baseMarkdown,
        input.validation.workflowGraph.graph,
      )
    : baseMarkdown;
  await writeFile(skillMdPath, skillMarkdown, "utf8");
  if (!input.validation.workflowGraph) {
    return { skillMdPath, workflowGraph: null };
  }
  const artifacts = await materializeWorkflowGraphPackage({
    graph: input.validation.workflowGraph.graph,
    sourceGraphPath: input.validation.workflowGraph.graphPath,
    targetDir: input.installDir,
  });
  return {
    skillMdPath,
    workflowGraph: {
      workflowId: input.validation.workflowGraph.graph.workflowId,
      revisionId: input.validation.workflowGraph.graph.revision.revisionId,
      graphPath: artifacts.graphPath,
      markdownPath: artifacts.markdownPath,
      revisionsDir: artifacts.revisionsDir,
    },
  };
}

function assertSequentialSteps(steps: ValidatedSkill["steps"]): void {
  for (let index = 0; index < steps.length; index += 1) {
    const expected = index + 1;
    if (steps[index].step !== expected) {
      throw new Error(
        `Invalid skill step sequence: expected step ${expected}, received ${steps[index].step}.`,
      );
    }
  }
}

function buildGeneratedInstallName(rawName: string, skillId: string): string {
  const normalized = slugifyName(rawName);
  const baseName = normalized || `skill-${skillId.slice(0, 8).toLowerCase()}`;
  return baseName.startsWith(GENERATED_PREFIX)
    ? baseName
    : `${GENERATED_PREFIX}${baseName}`;
}

function normalizeInstallNameForLookup(input: string): string {
  const trimmed = input.trim();
  if (!GENERATED_NAME_PATTERN.test(trimmed)) {
    throw new Error(
      `--name must be a generated install name like ${GENERATED_PREFIX}example.`,
    );
  }
  const versionedName = parseInstallNameVersion(trimmed);
  if (!versionedName) {
    return trimmed.toLowerCase();
  }
  return `${versionedName.baseName.toLowerCase()}-V${versionedName.version}`;
}

function slugifyName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function reserveInstallDirectory(
  installRoot: string,
  baseInstallName: string,
): Promise<{ installName: string; installDir: string }> {
  await mkdir(installRoot, { recursive: true });

  const initialReservation = await tryCreateInstallDirectory(
    installRoot,
    baseInstallName,
  );
  if (initialReservation) {
    return initialReservation;
  }

  const versionedName = parseInstallNameVersion(baseInstallName);
  const versionBaseName = versionedName?.baseName ?? baseInstallName;
  const startVersion = versionedName?.version ?? 0;

  for (let version = startVersion + 1; version <= 999; version += 1) {
    const installName = `${versionBaseName}-V${version}`;
    const reservedDirectory = await tryCreateInstallDirectory(
      installRoot,
      installName,
    );
    if (reservedDirectory) {
      return reservedDirectory;
    }
  }

  throw new Error(`Unable to reserve install directory under ${installRoot}.`);
}

/**
 * EN: Parses a trailing install-name version suffix such as `generated-skill-V2`.
 * @param input install name to inspect.
 * @returns parsed version info or null when absent.
 */
function parseInstallNameVersion(
  input: string,
): { baseName: string; version: number } | null {
  const matched = VERSIONED_INSTALL_NAME_PATTERN.exec(input);
  if (!matched?.groups) {
    return null;
  }

  const version = Number.parseInt(matched.groups.version, 10);
  if (!Number.isSafeInteger(version) || version < 0) {
    return null;
  }

  return {
    baseName: matched.groups.baseName,
    version,
  };
}

/**
 * EN: Attempts to create an install directory and returns null when the name is already taken.
 * @param installRoot install root.
 * @param installName candidate install name.
 * @returns reserved directory info or null when occupied.
 */
async function tryCreateInstallDirectory(
  installRoot: string,
  installName: string,
): Promise<{ installName: string; installDir: string } | null> {
  const installDir = join(installRoot, installName);
  try {
    await mkdir(installDir);
    return { installName, installDir };
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code === "EEXIST") {
      return null;
    }
    throw error;
  }
}

function buildSkillMarkdown(input: {
  installName: string;
  skill: ValidatedSkill;
}): string {
  const description = buildFrontmatterDescription(input.skill);
  const lines: string[] = [
    "---",
    `name: ${JSON.stringify(input.installName)}`,
    `description: ${JSON.stringify(description)}`,
    "---",
    "",
    `# ${input.skill.skillName}`,
    "",
    "## Description",
    "",
    ...renderDescription(input.skill.description),
    "",
    "## Goal",
    "",
    input.skill.goal,
    "",
    "## When to Use",
    "",
    ...renderBulletList(
      input.skill.whenToUse,
      "No explicit use cases in source skill.",
    ),
    "",
    "## When Not to Use",
    "",
    ...renderBulletList(
      input.skill.whenNotToUse,
      "No explicit exclusions in source skill.",
    ),
    "",
    "## Prerequisites",
    "",
    ...renderBulletList(
      input.skill.prerequisites,
      "No explicit prerequisites in source skill.",
    ),
    "",
    "## Inputs",
    "",
    ...renderSkillFieldList(
      input.skill.inputs,
      "No explicit inputs in source skill.",
    ),
    "",
    "## Outputs",
    "",
    ...renderSkillFieldList(
      input.skill.outputs,
      "No explicit outputs in source skill.",
    ),
    "",
    "## Assets",
    "",
    ...renderSkillAssets(input.skill.assets),
    "",
    "## Steps",
    "",
    ...renderSteps(input.skill),
    "",
    "## Success Criteria",
    "",
    ...renderBulletList(
      input.skill.successCriteria,
      "No explicit success criteria in source skill.",
    ),
    "",
    ...renderOptionalBulletSection("Failure Modes", input.skill.failureModes),
    ...renderOptionalBulletSection("Fallback", input.skill.fallback),
    "## Examples",
    "",
    ...renderBulletList(
      input.skill.examples,
      "No explicit examples in source skill.",
    ),
    "",
  ];

  return `${lines.join("\n")}\n`;
}

function buildFrontmatterDescription(skill: ValidatedSkill): string {
  const preferredDescription = compactWhitespace(skill.shortDescription);
  if (preferredDescription.length > 0) {
    return preferredDescription.slice(0, 280);
  }
  const firstWhenToUse = skill.whenToUse[0] ?? "";
  const fullDescription = compactWhitespace(skill.description);
  if (fullDescription.length > 0) {
    return fullDescription.slice(0, 280);
  }
  return compactWhitespace(
    `${skill.skillName}. ${skill.goal} ${firstWhenToUse}`.trim(),
  ).slice(0, 280);
}

/**
 * EN: Renders the full description block instead of only keeping the frontmatter summary.
 * @param value raw description text.
 * @returns markdown-ready lines.
 */
function renderDescription(value: string): string[] {
  const description = value.trim();
  if (description.length === 0) {
    return ["No explicit description in source skill."];
  }
  return [description];
}

function renderBulletList(values: string[], emptyText: string): string[] {
  if (values.length === 0) {
    return [`- ${emptyText}`];
  }
  return values.map((value) => `- ${value}`);
}

/**
 * CN: 仅在存在真实内容时渲染可选章节，避免把空异常模板写入 skill。
 * EN: Renders an optional section only when it has real content.
 * @param heading markdown section heading.
 * @param values section bullet values.
 * @returns markdown-ready lines or an empty list.
 */
function renderOptionalBulletSection(
  heading: string,
  values: string[],
): string[] {
  if (values.length === 0) {
    return [];
  }
  return [`## ${heading}`, "", ...values.map((value) => `- ${value}`), ""];
}

function renderSkillFieldList(
  values: ValidatedSkill["inputs"],
  emptyText: string,
): string[] {
  if (values.length === 0) {
    return [`- ${emptyText}`];
  }
  return values.map((value) => {
    const requiredSuffix =
      value.required === true
        ? " (required)"
        : value.required === false
          ? " (optional)"
          : "";
    const description = compactWhitespace(value.description);
    if (description.length === 0) {
      return `- ${value.name}${requiredSuffix}`;
    }
    return `- ${value.name}${requiredSuffix}: ${description}`;
  });
}

/**
 * EN: Renders structured assets so SKILL.md includes the key materials inline.
 * @param values normalized asset entries.
 * @returns markdown asset lines.
 */
function renderSkillAssets(values: ValidatedSkill["assets"]): string[] {
  if (values.length === 0) {
    return ["- No explicit assets in source skill."];
  }

  return values.map((value) => {
    const notes = compactWhitespace(value.notes ?? "");
    const renderedValue = formatSkillAssetValue(value.value);
    const baseLine = `- ${value.name}: ${renderedValue}`;
    return notes.length > 0 ? `${baseLine} Notes: ${notes}` : baseLine;
  });
}

/**
 * EN: Flattens asset values into one line for strings, string arrays, and string maps.
 * @param value structured asset value.
 * @returns single-line display text.
 */
function formatSkillAssetValue(
  value: z.infer<typeof structuredSkillAssetValueSchema>,
): string {
  if (typeof value === "string") {
    return compactWhitespace(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => compactWhitespace(item)).join("; ");
  }

  return Object.entries(value)
    .map(([key, itemValue]) => `${key}: ${compactWhitespace(itemValue)}`)
    .join("; ");
}

function renderSteps(skill: ValidatedSkill): string[] {
  const lines: string[] = [];
  for (const step of skill.steps) {
    const hints =
      step.hints.length > 0 ? step.hints.join("; ") : "No explicit hints.";
    lines.push(`${step.step}. ${step.instruction}`);
    lines.push(`   Intent: ${step.intent}`);
    lines.push(`   Operation App: ${step.operationApp}`);
    lines.push(`   Hints: ${hints}`);
    lines.push("");
  }
  if (lines.length === 0) {
    return ["No steps found."];
  }
  return lines.slice(0, -1);
}

export function createSpawnCommandRunner(
  options: SpawnCommandRunnerOptions = {},
): OpenClawCommandRunner {
  return {
    async run(command, args) {
      const resolved = await resolveSpawnCommand(command);
      return new Promise((resolvePromise, rejectPromise) => {
        const useProcessGroup = process.platform !== "win32";
        const child = spawn(resolved.command, args, {
          detached: useProcessGroup,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let settled = false;
        let timedOut = false;
        let forceKillTimer: NodeJS.Timeout | null = null;
        let forceSettleTimer: NodeJS.Timeout | null = null;
        const timeoutMs = options.timeoutMs ?? OPENCLAW_COMMAND_TIMEOUT_MS;
        const terminationGraceMs =
          options.terminationGraceMs ?? OPENCLAW_COMMAND_TERMINATION_GRACE_MS;
        const forceSettleMs =
          options.forceSettleMs ?? OPENCLAW_COMMAND_FORCE_SETTLE_MS;

        const clearLifecycle = () => {
          clearTimeout(timeoutTimer);
          if (forceKillTimer) clearTimeout(forceKillTimer);
          if (forceSettleTimer) clearTimeout(forceSettleTimer);
        };
        const settle = (code: number | null, error?: Error) => {
          if (settled) return;
          settled = true;
          clearLifecycle();
          if (error || timedOut) {
            rejectPromise(
              error ??
                new Error(
                  `OpenClaw command timed out after ${timeoutMs}ms and was terminated.`,
                ),
            );
            return;
          }
          resolvePromise({
            stdout,
            stderr,
            exitCode: code ?? 1,
          });
        };
        const timeoutTimer = setTimeout(() => {
          if (settled) return;
          timedOut = true;
          signalOpenClawProcessGroup(child, "SIGTERM", useProcessGroup);
          forceKillTimer = setTimeout(() => {
            if (settled) return;
            signalOpenClawProcessGroup(child, "SIGKILL", useProcessGroup);
            forceSettleTimer = setTimeout(() => {
              if (settled) return;
              child.stdout.destroy();
              child.stderr.destroy();
              child.unref();
              settle(null);
            }, forceSettleMs);
            forceSettleTimer.unref?.();
          }, terminationGraceMs);
          forceKillTimer.unref?.();
        }, timeoutMs);
        timeoutTimer.unref?.();

        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
          stdout = appendCommandOutput(stdout, chunk);
        });
        child.stderr.on("data", (chunk) => {
          stderr = appendCommandOutput(stderr, chunk);
        });
        child.once("error", (error) => {
          settle(
            null,
            new Error(
              formatSpawnFailureMessage({
                command,
                attemptedPaths: resolved.attemptedPaths,
                error,
              }),
            ),
          );
        });
        child.once("close", (code) => {
          settle(code);
        });
      });
    },
  };
}

function appendCommandOutput(current: string, chunk: string): string {
  const next = `${current}${chunk}`;
  if (Buffer.byteLength(next, "utf8") <= OPENCLAW_COMMAND_OUTPUT_LIMIT_BYTES) {
    return next;
  }
  return Buffer.from(next, "utf8")
    .subarray(-OPENCLAW_COMMAND_OUTPUT_LIMIT_BYTES)
    .toString("utf8")
    .replace(/^\uFFFD/u, "");
}

function signalOpenClawProcessGroup(
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals,
  useProcessGroup: boolean,
): boolean {
  if (useProcessGroup && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch {
      // EN/CN: Fall back to the direct child if its process group is already gone.
    }
  }
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}

/**
 * EN: Resolves a stable absolute OpenClaw executable path for GUI-launched processes.
 * @param options optional env and executable checker overrides for tests.
 * @returns absolute executable path or null when no known location is executable.
 */
export async function resolveOpenClawExecutablePath(
  options: ResolveOpenClawExecutablePathOptions = {},
): Promise<string | null> {
  const candidates = collectOpenClawExecutableCandidates(
    options.env ?? process.env,
  );
  const isExecutablePath = options.isExecutablePath ?? pathIsExecutable;

  for (const candidate of candidates) {
    if (await isExecutablePath(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * EN: Resolves the command that should be passed to `spawn`, keeping OpenClaw-specific fallbacks private to the command layer.
 * @param command raw command requested by the caller.
 * @returns resolved command plus any OpenClaw absolute paths we checked.
 */
async function resolveSpawnCommand(command: string): Promise<{
  command: string;
  attemptedPaths: string[];
}> {
  if (isAbsolute(command) || command !== OPENCLAW_EXECUTABLE_NAME) {
    return {
      command,
      attemptedPaths: [],
    };
  }

  const attemptedPaths = collectOpenClawExecutableCandidates(process.env);
  const resolvedCommand = await resolveOpenClawExecutablePath();
  return {
    command: resolvedCommand ?? command,
    attemptedPaths,
  };
}

/**
 * EN: Collects OpenClaw executable candidates from env overrides and common Homebrew install paths.
 * @param env environment variables to inspect.
 * @returns deduplicated absolute paths to probe.
 */
function collectOpenClawExecutableCandidates(env: NodeJS.ProcessEnv): string[] {
  return [
    ...new Set(
      [
        ...OPENCLAW_EXECUTABLE_ENV_VARS.map((name) =>
          normalizeOpenClawExecutableCandidate(env[name]),
        ),
        ...OPENCLAW_EXECUTABLE_FALLBACK_PATHS,
      ].filter((value): value is string => value !== null),
    ),
  ];
}

/**
 * EN: Normalizes user-provided executable candidates and ignores non-absolute values.
 * @param value raw env override candidate.
 * @returns normalized absolute path or null when unusable.
 */
function normalizeOpenClawExecutableCandidate(
  value: string | undefined,
): string | null {
  if (!value) {
    return null;
  }

  const expanded = expandUserHome(value.trim());
  if (!isAbsolute(expanded)) {
    return null;
  }
  return resolve(expanded);
}

/**
 * EN: Checks whether one file path exists and has execute permissions.
 * @param filePath absolute file path to inspect.
 * @returns true when the path is executable.
 */
async function pathIsExecutable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * EN: Formats spawn failures with an actionable OpenClaw hint for GUI environments.
 * @param input original command, attempted absolute paths, and the spawn error.
 * @returns user-facing error message.
 */
function formatSpawnFailureMessage(input: {
  command: string;
  attemptedPaths: string[];
  error: unknown;
}): string {
  const message =
    input.error instanceof Error ? input.error.message : String(input.error);
  const errno = input.error as NodeJS.ErrnoException;

  if (input.command === OPENCLAW_EXECUTABLE_NAME && errno.code === "ENOENT") {
    const checkedLocations = input.attemptedPaths.length
      ? `${input.attemptedPaths.join(", ")}, and PATH`
      : "PATH";
    return `Failed to run ${input.command}: executable not found. Checked ${checkedLocations}. Set OYSTERWORKFLOW_OPENCLAW_PATH, TRACE2OPENCLAW_OPENCLAW_PATH, or OPENCLAW_PATH to an absolute executable path. Original error: ${message}`;
  }

  return `Failed to run ${input.command}: ${message}`;
}

async function readJsonFile(
  filePath: string,
  label: string,
): Promise<Record<string, unknown>> {
  const raw = await readFile(filePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid JSON in ${label} file at ${filePath}: ${toErrorMessage(error)}`,
    );
  }

  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error(
      `Expected ${label} file at ${filePath} to contain a JSON object.`,
    );
  }
  return parsed as Record<string, unknown>;
}

/**
 * EN: Normalizes legacy string arrays and structured objects into one field list.
 * @param value raw field input.
 * @returns structured field array for schema validation.
 */
function normalizeStructuredSkillFieldListInput(value: unknown): unknown {
  if (value === undefined || value === null) {
    return [];
  }

  const items = Array.isArray(value) ? value : [value];
  const normalized: Array<z.infer<typeof structuredSkillFieldSchema>> = [];
  for (const item of items) {
    if (typeof item === "string") {
      const name = normalizeLooseText(item);
      if (name.length > 0) {
        normalized.push({
          name,
          description: "",
        });
      }
      continue;
    }

    const record = asRecord(item);
    if (!record) {
      continue;
    }

    const name =
      pickNormalizedString(record, ["name", "title", "label", "key"]) ?? "";
    if (name.length === 0) {
      continue;
    }

    const description =
      pickNormalizedString(record, [
        "description",
        "desc",
        "details",
        "summary",
      ]) ?? "";
    const required = normalizeLooseBoolean(
      pickFirstDefined(record, ["required", "mandatory", "must"]),
    );
    normalized.push({
      name,
      description,
      ...(required === undefined ? {} : { required }),
    });
  }

  return normalized;
}

/**
 * EN: Normalizes legacy `{credentials,texts,urls}` and structured arrays into inline assets.
 * @param value raw assets input.
 * @returns structured asset array for schema validation.
 */
function normalizeInlineSkillAssetsInput(value: unknown): unknown {
  if (value === undefined || value === null) {
    return [];
  }

  const record = asRecord(value);
  if (
    record &&
    (Array.isArray(record.credentials) ||
      Array.isArray(record.texts) ||
      Array.isArray(record.urls))
  ) {
    return normalizeLegacyInlineSkillAssets(record);
  }

  const items = Array.isArray(value) ? value : [value];
  const normalized: Array<z.infer<typeof structuredSkillAssetSchema>> = [];
  for (const [index, item] of items.entries()) {
    if (typeof item === "string") {
      const text = normalizeLooseText(item);
      if (text.length > 0) {
        normalized.push({
          name: `Asset ${index + 1}`,
          value: text,
        });
      }
      continue;
    }

    const assetRecord = asRecord(item);
    if (!assetRecord) {
      continue;
    }

    const normalizedValue = normalizeLooseAssetValue(
      pickFirstDefined(assetRecord, ["value", "content", "values", "payload"]),
    );
    if (normalizedValue === null) {
      continue;
    }

    const name =
      pickNormalizedString(assetRecord, ["name", "title", "label"]) ??
      `Asset ${index + 1}`;
    const notes = pickNormalizedString(assetRecord, [
      "notes",
      "note",
      "description",
    ]);
    normalized.push({
      name,
      value: normalizedValue,
      ...(notes ? { notes } : {}),
    });
  }

  return normalized;
}

function normalizeLegacyInlineSkillAssets(
  record: Record<string, unknown>,
): Array<z.infer<typeof structuredSkillAssetSchema>> {
  const normalized: Array<z.infer<typeof structuredSkillAssetSchema>> = [];

  const credentials = Array.isArray(record.credentials)
    ? record.credentials
    : [];
  credentials.forEach((entry, index) => {
    const credential = asRecord(entry);
    if (!credential) {
      return;
    }

    const account =
      pickNormalizedString(credential, ["account", "username", "name"]) ??
      `Credential ${index + 1}`;
    const password = pickNormalizedString(credential, ["password", "secret"]);
    const notes = pickNormalizedString(credential, [
      "notes",
      "note",
      "description",
    ]);
    normalized.push({
      name: account,
      value: password
        ? ({ account, password } as Record<string, string>)
        : ({ account } as Record<string, string>),
      ...(notes ? { notes } : {}),
    });
  });

  const texts = Array.isArray(record.texts) ? record.texts : [];
  texts.forEach((entry, index) => {
    if (typeof entry !== "string") {
      return;
    }
    const text = normalizeLooseText(entry);
    if (text.length === 0) {
      return;
    }
    normalized.push({
      name: `Text ${index + 1}`,
      value: text,
    });
  });

  const urls = Array.isArray(record.urls) ? record.urls : [];
  urls.forEach((entry, index) => {
    if (typeof entry !== "string") {
      return;
    }
    const url = normalizeLooseText(entry);
    if (url.length === 0) {
      return;
    }
    normalized.push({
      name: `URL ${index + 1}`,
      value: url,
    });
  });

  return normalized;
}

function normalizeLooseAssetValue(
  value: unknown,
): z.infer<typeof structuredSkillAssetValueSchema> | null {
  if (typeof value === "string") {
    const normalized = normalizeLooseText(value);
    return normalized.length > 0 ? normalized : null;
  }

  if (Array.isArray(value)) {
    const normalized = [
      ...new Set(
        value
          .map((item) =>
            typeof item === "string" ||
            typeof item === "number" ||
            typeof item === "boolean"
              ? normalizeLooseText(String(item))
              : "",
          )
          .filter((item) => item.length > 0),
      ),
    ];
    return normalized.length > 0 ? normalized : null;
  }

  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const entries = Object.entries(record)
    .map(([key, rawValue]) => {
      const normalizedKey = normalizeLooseText(key);
      const normalizedValue =
        typeof rawValue === "string" ||
        typeof rawValue === "number" ||
        typeof rawValue === "boolean"
          ? normalizeLooseText(String(rawValue))
          : "";
      return [normalizedKey, normalizedValue] as const;
    })
    .filter(([key, rawValue]) => key.length > 0 && rawValue.length > 0);

  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function pickFirstDefined(
  record: Record<string, unknown>,
  keys: string[],
): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) {
      return record[key];
    }
  }
  return undefined;
}

function pickNormalizedString(
  record: Record<string, unknown>,
  keys: string[],
): string | undefined {
  const value = pickFirstDefined(record, keys);
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = normalizeLooseText(value);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeLooseText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeLooseBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (value === 1) {
      return true;
    }
    if (value === 0) {
      return false;
    }
    return undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (["true", "yes", "y", "1", "required"].includes(normalized)) {
    return true;
  }
  if (["false", "no", "n", "0", "optional"].includes(normalized)) {
    return false;
  }
  return undefined;
}

async function assertPathExists(
  filePath: string,
  message: string,
): Promise<void> {
  if (!(await pathExists(filePath))) {
    throw new Error(message);
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function normalizeCliAbsolutePath(value: string, flagName: string): string {
  const expanded = expandUserHome(value.trim());
  if (!isAbsolute(expanded)) {
    throw new Error(`${flagName} must be an absolute path, received: ${value}`);
  }
  return resolve(expanded);
}

function expandUserHome(value: string): string {
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/")) {
    return join(os.homedir(), value.slice(2));
  }
  return value;
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
