import { readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  DEFAULT_OPENCLAW_INSTALL_ROOT,
  createSpawnCommandRunner,
  parseOpenClawSkillUninstallCliArgs,
  runOpenClawSkillUninstall,
  type OpenClawCommandRunner,
} from "../cli/commands/openclaw-skill.js";
import type {
  LabOpenClawExportMarkerSummary,
  LabOpenClawMissingRequirements,
  LabOpenClawPersonalSkill,
  LabOpenClawPersonalSkillSourceType,
  LabOpenClawUninstallResult,
} from "./contracts.js";
import {
  assertRemovableSkillDirectory,
  getSkillSourceTypeRank,
  isRegularFile,
  normalizeSkillInstallName,
  readSkillDescription,
  readSkillExportMarker,
} from "./skill-file-helpers.js";

const emptyMissingRequirements: LabOpenClawMissingRequirements = {
  bins: [],
  anyBins: [],
  env: [],
  config: [],
  os: [],
};
const LEGACY_OYSTERWORKFLOW_EXPORT_MARKER_FILENAME =
  ".oysterworkflow-export.json";

const openClawMissingRequirementsSchema = z.object({
  bins: z.array(z.string()).default([]),
  anyBins: z.array(z.string()).default([]),
  env: z.array(z.string()).default([]),
  config: z.array(z.string()).default([]),
  os: z.array(z.string()).default([]),
});

const openClawSkillInfoSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().default(""),
  baseDir: z.string().min(1).optional(),
  filePath: z.string().min(1).optional(),
  eligible: z.boolean().optional(),
  disabled: z.boolean().optional(),
  missing: openClawMissingRequirementsSchema.optional(),
  error: z.unknown().optional(),
});

export interface ListLabOpenClawPersonalSkillsOptions {
  installRoot?: string;
  commandRunner?: OpenClawCommandRunner;
}

export interface UninstallLabOpenClawPersonalSkillOptions {
  installName: string;
  confirmName?: string;
  installRoot?: string;
  commandRunner?: OpenClawCommandRunner;
}

/**
 * EN: Scans the personal skills root and enriches each entry with OpenClaw visibility info.
 * @param options optional install root and command runner.
 * @returns personal skill list.
 */
export async function listLabOpenClawPersonalSkills(
  options: ListLabOpenClawPersonalSkillsOptions = {},
): Promise<LabOpenClawPersonalSkill[]> {
  const installRoot = resolve(
    options.installRoot ?? DEFAULT_OPENCLAW_INSTALL_ROOT,
  );
  const runner = options.commandRunner ?? createSpawnCommandRunner();
  const entries = await readDirectoryEntries(installRoot);
  const skills = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) =>
        readPersonalSkill({
          installName: entry.name,
          installRoot,
          commandRunner: runner,
        }),
      ),
  );

  return skills
    .filter((skill): skill is LabOpenClawPersonalSkill => skill !== null)
    .sort(comparePersonalSkills);
}

/**
 * EN: Uninstalls one personal skill; generated skills can be removed directly, manual skills require name confirmation.
 * @param options install name, confirmation name, and optional install root.
 * @returns uninstall result.
 */
export async function uninstallLabOpenClawPersonalSkill(
  options: UninstallLabOpenClawPersonalSkillOptions,
): Promise<LabOpenClawUninstallResult> {
  const installRoot = resolve(
    options.installRoot ?? DEFAULT_OPENCLAW_INSTALL_ROOT,
  );
  const installName = normalizeSkillInstallName(options.installName);
  const commandRunner = options.commandRunner ?? createSpawnCommandRunner();
  const personalSkill = await readPersonalSkill({
    installName,
    installRoot,
    commandRunner,
  });
  if (!personalSkill) {
    throw new Error(`Personal skill not found: ${installName}`);
  }

  if (
    personalSkill.sourceType === "manual-personal" &&
    options.confirmName !== personalSkill.name
  ) {
    throw new Error(
      `Uninstalling manual personal skill requires confirmName to match ${personalSkill.name}.`,
    );
  }

  if (personalSkill.marker) {
    const result = await runOpenClawSkillUninstall(
      parseOpenClawSkillUninstallCliArgs({
        name: personalSkill.name,
        installRoot,
      }),
    );
    return {
      installName: result.installName,
      installDir: result.installDir,
      removed: result.removed,
      sourceType: personalSkill.sourceType,
    };
  }

  const installDir = await assertRemovableSkillDirectory({
    installRoot,
    installName: personalSkill.name,
    directoryLabel: "Installed personal skill",
  });
  await rm(installDir, { recursive: true, force: false });
  return {
    installName: personalSkill.name,
    installDir,
    removed: true,
    sourceType: personalSkill.sourceType,
  };
}

async function readPersonalSkill(input: {
  installName: string;
  installRoot: string;
  commandRunner: OpenClawCommandRunner;
}): Promise<LabOpenClawPersonalSkill | null> {
  const installName = normalizeSkillInstallName(input.installName);
  const baseDir = resolve(input.installRoot, installName);
  const skillFilePath = join(baseDir, "SKILL.md");

  if (!(await isRegularFile(skillFilePath))) {
    return null;
  }

  const marker = await readSkillExportMarker(
    join(baseDir, LEGACY_OYSTERWORKFLOW_EXPORT_MARKER_FILENAME),
  );
  const info = await readOpenClawSkillInfo(installName, input.commandRunner);
  const fallbackDescription = await readSkillDescription(skillFilePath);

  return {
    name: info?.name ?? installName,
    description: info?.description?.trim() || fallbackDescription,
    baseDir: info?.baseDir ?? baseDir,
    filePath: info?.filePath ?? skillFilePath,
    sourceType: classifyPersonalSkillSourceType({
      installName,
      marker,
    }),
    eligible: info?.eligible ?? null,
    disabled: info?.disabled ?? null,
    missing: info?.missing ?? emptyMissingRequirements,
    marker,
  };
}

async function readOpenClawSkillInfo(
  installName: string,
  commandRunner: OpenClawCommandRunner,
): Promise<{
  name: string;
  description: string;
  baseDir: string | null;
  filePath: string | null;
  eligible: boolean | null;
  disabled: boolean | null;
  missing: LabOpenClawMissingRequirements;
} | null> {
  try {
    const result = await commandRunner.run("openclaw", [
      "skills",
      "info",
      installName,
      "--json",
    ]);
    if (result.exitCode !== 0) {
      return null;
    }

    const parsed = parseJsonRecord(result.stdout, "openclaw skills info");
    const normalized = openClawSkillInfoSchema.parse(parsed);
    if (normalized.error !== undefined) {
      return null;
    }

    return {
      name: normalized.name,
      description: normalized.description,
      baseDir: normalized.baseDir ?? null,
      filePath: normalized.filePath ?? null,
      eligible: normalized.eligible ?? null,
      disabled: normalized.disabled ?? null,
      missing: normalized.missing ?? emptyMissingRequirements,
    };
  } catch {
    return null;
  }
}

function classifyPersonalSkillSourceType(input: {
  installName: string;
  marker: LabOpenClawExportMarkerSummary | null;
}): LabOpenClawPersonalSkillSourceType {
  if (input.marker) {
    return "generated-managed";
  }
  if (input.installName.toLowerCase().startsWith("generated-")) {
    return "generated-unmanaged";
  }
  return "manual-personal";
}

function comparePersonalSkills(
  left: LabOpenClawPersonalSkill,
  right: LabOpenClawPersonalSkill,
): number {
  const sourceRank =
    getSkillSourceTypeRank(left.sourceType) -
    getSkillSourceTypeRank(right.sourceType);
  if (sourceRank !== 0) {
    return sourceRank;
  }
  return left.name.localeCompare(right.name);
}

function parseJsonRecord(raw: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid JSON from ${label}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error(`Expected ${label} to return a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

async function readDirectoryEntries(directoryPath: string) {
  try {
    return await readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}
