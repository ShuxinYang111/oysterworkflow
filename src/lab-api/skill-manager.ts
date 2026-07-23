import { constants as fsConstants } from "node:fs";
import { access, mkdir, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { runOpenClawSkillUninstall } from "../cli/commands/openclaw-skill.js";
import type {
  LabManagedSkill,
  LabOpenClawExportMarkerSummary,
  LabOpenClawPersonalSkillSourceType,
  LabOpenClawUninstallResult,
  LabSkillManagerConfig,
  SkillManagerPathCandidate,
} from "./contracts.js";
import {
  GENERATED_SKILL_NAME_PATTERN,
  assertRemovableSkillDirectory,
  getSkillSourceTypeRank,
  isRegularFile,
  normalizeSkillInstallName,
  readFirstSkillExportMarker,
  readSkillDescription,
} from "./skill-file-helpers.js";
import { readJsonWithBackup, writeJsonAtomic } from "../io/atomic-json.js";

const LEGACY_OYSTERWORKFLOW_EXPORT_MARKER_FILENAME =
  ".oysterworkflow-export.json";
const LEGACY_OPENCLAW_EXPORT_MARKER_FILENAME = ".trace2openclaw-export.json";

const skillManagerConfigSchema = z.object({
  skillPath: z.string().min(1).nullable().default(null),
  updatedAt: z.string().min(1).nullable().optional().default(null),
});

type SkillManagerPathCandidateDefinition = {
  id: string;
  label: string;
  agentFamily: SkillManagerPathCandidate["agentFamily"];
  pathSegments: readonly string[];
  detectionPathSegments?: readonly (readonly string[])[];
};

const SKILL_MANAGER_PATH_CANDIDATES = [
  {
    id: "openclaw-default",
    label: "OpenClaw (.openclaw/skills)",
    agentFamily: "openclaw",
    pathSegments: [".openclaw", "skills"],
    detectionPathSegments: [[".openclaw"], [".openclaw", "openclaw.json"]],
  },
  {
    id: "openclaw-personal",
    label: "OpenClaw (.agents/skills)",
    agentFamily: "openclaw",
    pathSegments: [".agents", "skills"],
  },
  {
    id: "workbuddy-default",
    label: "WorkBuddy (.workbuddy/skills)",
    agentFamily: "workbuddy",
    pathSegments: [".workbuddy", "skills"],
    detectionPathSegments: [[".workbuddy"], [".workbuddy", "settings.json"]],
  },
  {
    id: "codebuddy-default",
    label: "CodeBuddy (.codebuddy/skills)",
    agentFamily: "codebuddy",
    pathSegments: [".codebuddy", "skills"],
    detectionPathSegments: [[".codebuddy"]],
  },
  {
    id: "qwen-default",
    label: "Qwen Code (.qwen/skills)",
    agentFamily: "qwen",
    pathSegments: [".qwen", "skills"],
    detectionPathSegments: [[".qwen"]],
  },
  {
    id: "qoder-default",
    label: "Qoder CLI (.qoder/skills)",
    agentFamily: "qoder",
    pathSegments: [".qoder", "skills"],
    detectionPathSegments: [[".qoder"]],
  },
  {
    id: "qoderwork-default",
    label: "QoderWork (.qoderwork/skills)",
    agentFamily: "qoderwork",
    pathSegments: [".qoderwork", "skills"],
    detectionPathSegments: [[".qoderwork"]],
  },
  {
    id: "lingma-default",
    label: "Lingma (.lingma/skills)",
    agentFamily: "lingma",
    pathSegments: [".lingma", "skills"],
    detectionPathSegments: [[".lingma"]],
  },
  {
    id: "comate-default",
    label: "Baidu Comate (.comate/skills)",
    agentFamily: "comate",
    pathSegments: [".comate", "skills"],
    detectionPathSegments: [[".comate"]],
  },
  {
    id: "codeartsdoer-default",
    label: "CodeArts Doer (.codeartsdoer/skills)",
    agentFamily: "codeartsdoer",
    pathSegments: [".codeartsdoer", "skills"],
    detectionPathSegments: [[".codeartsdoer"]],
  },
  {
    id: "iflow-default",
    label: "iFlow (.iflow/skills)",
    agentFamily: "iflow",
    pathSegments: [".iflow", "skills"],
    detectionPathSegments: [[".iflow"]],
  },
  {
    id: "trae-default",
    label: "Trae (.trae/skills)",
    agentFamily: "trae",
    pathSegments: [".trae", "skills"],
  },
  {
    id: "trae-cn-default",
    label: "Trae CN (.trae-cn/skills)",
    agentFamily: "trae",
    pathSegments: [".trae-cn", "skills"],
  },
  {
    id: "codex-default",
    label: "Codex (.codex/skills)",
    agentFamily: "codex",
    pathSegments: [".codex", "skills"],
  },
  {
    id: "claude-default",
    label: "Claude (.claude/skills)",
    agentFamily: "claude",
    pathSegments: [".claude", "skills"],
  },
  {
    id: "hermes-default",
    label: "Hermes Agent (.hermes/skills)",
    agentFamily: "hermes",
    pathSegments: [".hermes", "skills"],
  },
] as const satisfies ReadonlyArray<SkillManagerPathCandidateDefinition>;

/**
 * EN: Reads the persisted Skill Manager config and falls back to an empty value when missing.
 * @param configPath absolute config file path.
 * @returns normalized Skill Manager config.
 */
export async function readSkillManagerConfig(
  configPath: string,
): Promise<LabSkillManagerConfig> {
  try {
    const config = await readJsonWithBackup(configPath, {
      validate: (value) => skillManagerConfigSchema.parse(value),
    });
    if (!config) {
      return {
        skillPath: null,
        updatedAt: null,
      };
    }
    return {
      skillPath: config.skillPath,
      updatedAt: config.updatedAt ?? null,
    };
  } catch (error) {
    throw new Error(
      `Invalid Skill Manager config schema at ${configPath}: ${toErrorMessage(error)}`,
    );
  }
}

/**
 * EN: Saves one Skill Manager directory preference, creating the destination directory when needed.
 * @param input requested skill path and optional timestamp override.
 * @param configPath absolute config file path.
 * @returns normalized persisted config.
 */
export async function writeSkillManagerConfig(
  input: {
    skillPath: string;
    now?: Date;
  },
  configPath: string,
): Promise<LabSkillManagerConfig> {
  const normalizedSkillPath = normalizeSkillPath(input.skillPath);
  await mkdir(normalizedSkillPath, { recursive: true });
  const directoryStats = await stat(normalizedSkillPath).catch(() => null);
  if (!directoryStats?.isDirectory()) {
    throw new Error(`Skill path is not a directory: ${normalizedSkillPath}`);
  }
  await access(
    normalizedSkillPath,
    fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK,
  );

  const nextConfig: LabSkillManagerConfig = {
    skillPath: normalizedSkillPath,
    updatedAt: (input.now ?? new Date()).toISOString(),
  };
  await writeJsonAtomic(configPath, nextConfig, {
    mode: 0o600,
    backup: true,
    validate: (value) => skillManagerConfigSchema.parse(value),
  });
  return nextConfig;
}

/**
 * EN: Detects known user-level skill directories without relying on shell lookup.
 * @returns existing skill directory candidates in stable priority order.
 */
export async function listSkillManagerPathCandidates(): Promise<
  SkillManagerPathCandidate[]
> {
  const homeDirectory = os.homedir();
  const candidates = await Promise.all(
    SKILL_MANAGER_PATH_CANDIDATES.map(async (candidate) => {
      const candidatePath = resolve(homeDirectory, ...candidate.pathSegments);
      const exists = await directoryExists(candidatePath);
      const detected =
        exists || (await hasDetectionPath(homeDirectory, candidate));
      if (!detected) {
        return null;
      }

      return {
        id: candidate.id,
        label: candidate.label,
        agentFamily: candidate.agentFamily,
        path: candidatePath,
        exists,
      } satisfies SkillManagerPathCandidate;
    }),
  );

  return candidates.filter(isDefined);
}

/**
 * EN: Lists installed skills by scanning the configured directory for direct child folders containing SKILL.md.
 * @param input configured Skill Manager path.
 * @returns sorted installed skill summaries.
 */
export async function listInstalledSkills(input: {
  skillPath: string | null;
}): Promise<LabManagedSkill[]> {
  if (!input.skillPath) {
    return [];
  }

  if (!(await directoryExists(input.skillPath))) {
    return [];
  }

  const entries = await readdir(input.skillPath, { withFileTypes: true });
  const skills = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) =>
        readInstalledSkill({
          installRoot: input.skillPath!,
          installName: entry.name,
        }),
      ),
  );

  return skills
    .filter((skill): skill is LabManagedSkill => skill !== null)
    .sort(compareInstalledSkills);
}

/**
 * EN: Removes one installed skill from the configured directory with extra confirmation for manual entries.
 * @param input install root, install name, and optional manual confirmation string.
 * @returns uninstall summary.
 */
export async function uninstallInstalledSkill(input: {
  installRoot: string;
  installName: string;
  confirmName?: string;
}): Promise<LabOpenClawUninstallResult> {
  const installRoot = resolve(input.installRoot);
  const installName = normalizeSkillInstallName(input.installName);
  const skill = await readInstalledSkill({
    installRoot,
    installName,
  });
  if (!skill) {
    throw new Error(`Installed skill not found: ${installName}`);
  }

  if (
    skill.sourceType === "manual-personal" &&
    input.confirmName !== skill.name
  ) {
    throw new Error(
      `Uninstalling manual personal skill requires confirmName to match ${skill.name}.`,
    );
  }

  if (skill.marker) {
    const result = await runOpenClawSkillUninstall({
      installName,
      installRoot,
    });
    return {
      installName: result.installName,
      installDir: result.installDir,
      removed: result.removed,
      sourceType: skill.sourceType,
    };
  }

  const installDir = await assertRemovableSkillDirectory({
    installRoot,
    installName,
  });
  await rm(installDir, { recursive: true, force: false });
  return {
    installName,
    installDir,
    removed: true,
    sourceType: skill.sourceType,
  };
}

async function readInstalledSkill(input: {
  installRoot: string;
  installName: string;
}): Promise<LabManagedSkill | null> {
  const installName = normalizeSkillInstallName(input.installName);
  const installDir = resolve(input.installRoot, installName);
  const skillFilePath = join(installDir, "SKILL.md");
  if (!(await isRegularFile(skillFilePath))) {
    return null;
  }

  const marker = await readFirstSkillExportMarker([
    join(installDir, LEGACY_OYSTERWORKFLOW_EXPORT_MARKER_FILENAME),
    join(installDir, LEGACY_OPENCLAW_EXPORT_MARKER_FILENAME),
  ]);
  return {
    name: installName,
    description: await readSkillDescription(skillFilePath),
    baseDir: installDir,
    filePath: skillFilePath,
    sourceType: classifyInstalledSkillSourceType({
      installName,
      marker,
    }),
    marker,
  };
}

function classifyInstalledSkillSourceType(input: {
  installName: string;
  marker: LabOpenClawExportMarkerSummary | null;
}): LabOpenClawPersonalSkillSourceType {
  if (input.marker) {
    return "generated-managed";
  }
  if (GENERATED_SKILL_NAME_PATTERN.test(input.installName)) {
    return "generated-unmanaged";
  }
  return "manual-personal";
}

function compareInstalledSkills(
  left: LabManagedSkill,
  right: LabManagedSkill,
): number {
  const sourceRank =
    getSkillSourceTypeRank(left.sourceType) -
    getSkillSourceTypeRank(right.sourceType);
  if (sourceRank !== 0) {
    return sourceRank;
  }
  return left.name.localeCompare(right.name);
}

/**
 * EN: Narrows nullable filesystem scan results after filtering.
 * @param value candidate value.
 * @returns true when the value is not null.
 */
function isDefined<T>(value: T | null): value is T {
  return value !== null;
}

function normalizeSkillPath(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new Error("Skill path must not be empty.");
  }
  if (trimmed === "~") {
    return os.homedir();
  }
  if (trimmed.startsWith("~/")) {
    return resolve(os.homedir(), trimmed.slice(2));
  }
  if (!isAbsolute(trimmed)) {
    throw new Error("Skill path must be an absolute path or start with ~/.");
  }
  return resolve(trimmed);
}

async function directoryExists(directoryPath: string): Promise<boolean> {
  const stats = await stat(directoryPath).catch(() => null);
  return Boolean(stats?.isDirectory());
}

async function hasDetectionPath(
  homeDirectory: string,
  candidate: SkillManagerPathCandidateDefinition,
): Promise<boolean> {
  if (!candidate.detectionPathSegments) {
    return false;
  }

  for (const pathSegments of candidate.detectionPathSegments) {
    const stats = await stat(resolve(homeDirectory, ...pathSegments)).catch(
      () => null,
    );
    if (stats) {
      return true;
    }
  }
  return false;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
