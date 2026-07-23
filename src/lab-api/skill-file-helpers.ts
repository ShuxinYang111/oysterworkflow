import { lstat, readFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import type {
  LabOpenClawExportMarkerSummary,
  LabOpenClawPersonalSkillSourceType,
} from "./contracts.js";

const exportMarkerSchema = z.object({
  installName: z.string().min(1),
  installDir: z.string().min(1),
  generatedAt: z.string().min(1),
  sourceSkillPath: z.string().min(1),
  sourceSummaryPath: z.string().nullable().optional(),
  originalSkillName: z.string().min(1),
  skillId: z.string().min(1),
});

export const GENERATED_SKILL_NAME_PATTERN =
  /^generated-[a-z0-9]+(?:-[a-z0-9]+)*(?:-v\d+)?$/i;

/**
 * EN: Normalizes one direct child skill directory name.
 * @param input user or filesystem-provided install name.
 * @returns safe direct child directory name.
 */
export function normalizeSkillInstallName(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new Error("installName must not be empty.");
  }
  if (basename(trimmed) !== trimmed || trimmed.includes("\\")) {
    throw new Error(`Invalid installName: ${input}`);
  }
  return trimmed;
}

/**
 * EN: Reads a concise skill description from frontmatter, then falls back to the first body line.
 * @param skillFilePath absolute SKILL.md path.
 * @returns discovered description text.
 */
export async function readSkillDescription(
  skillFilePath: string,
): Promise<string> {
  const raw = await readFile(skillFilePath, "utf8");
  const frontmatterMatch = raw.match(
    /^---\s*\n[\s\S]*?\ndescription:\s*(.+?)\n[\s\S]*?\n---/m,
  );
  if (frontmatterMatch?.[1]) {
    return stripWrappingQuotes(frontmatterMatch[1].trim());
  }

  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.find((line) => !line.startsWith("#") && line !== "---") ?? "";
}

/**
 * EN: Reads the first valid generated-skill export marker from a list of candidate paths.
 * @param markerPaths candidate marker file paths in priority order.
 * @returns marker summary when a valid marker exists.
 */
export async function readFirstSkillExportMarker(
  markerPaths: readonly string[],
): Promise<LabOpenClawExportMarkerSummary | null> {
  for (const markerPath of markerPaths) {
    const marker = await readSkillExportMarker(markerPath);
    if (marker) {
      return marker;
    }
  }
  return null;
}

/**
 * EN: Reads one generated-skill export marker file.
 * @param markerPath marker JSON path.
 * @returns marker summary when present and valid.
 */
export async function readSkillExportMarker(
  markerPath: string,
): Promise<LabOpenClawExportMarkerSummary | null> {
  if (!(await isRegularFile(markerPath))) {
    return null;
  }

  try {
    const raw = await readFile(markerPath, "utf8");
    const parsed = exportMarkerSchema.parse(JSON.parse(raw));
    return {
      installName: parsed.installName,
      installDir: parsed.installDir,
      generatedAt: parsed.generatedAt,
      sourceSkillPath: parsed.sourceSkillPath,
      sourceSummaryPath: parsed.sourceSummaryPath ?? null,
      originalSkillName: parsed.originalSkillName,
      skillId: parsed.skillId,
    };
  } catch {
    return null;
  }
}

/**
 * EN: Verifies a skill directory can be safely removed from a configured root.
 * @param input install root, install name, and optional error labels.
 * @returns absolute install directory path.
 */
export async function assertRemovableSkillDirectory(input: {
  installRoot: string;
  installName: string;
  directoryLabel?: string;
}): Promise<string> {
  const installRoot = resolve(input.installRoot);
  const installName = normalizeSkillInstallName(input.installName);
  const installDir = resolve(installRoot, installName);
  const relativePath = relative(installRoot, installDir);

  if (
    relativePath.length === 0 ||
    relativePath.startsWith("..") ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`Refusing to uninstall path outside ${installRoot}.`);
  }

  const label = input.directoryLabel ?? "Installed skill";
  const directoryStats = await lstat(installDir).catch(() => null);
  if (!directoryStats?.isDirectory() || directoryStats.isSymbolicLink()) {
    throw new Error(`${label} directory not found: ${installDir}`);
  }

  if (!(await isRegularFile(join(installDir, "SKILL.md")))) {
    throw new Error(`Refusing to uninstall non-skill directory: ${installDir}`);
  }

  return installDir;
}

/**
 * EN: Checks that a path is a regular file and not a symlink.
 * @param filePath path to inspect.
 * @returns true when the path is a regular file.
 */
export async function isRegularFile(filePath: string): Promise<boolean> {
  const stats = await lstat(filePath).catch(() => null);
  return Boolean(stats?.isFile() && !stats.isSymbolicLink());
}

/**
 * EN: Provides stable sorting priority for generated and manual skill entries.
 * @param sourceType normalized source type.
 * @returns numeric sort rank.
 */
export function getSkillSourceTypeRank(
  sourceType: LabOpenClawPersonalSkillSourceType,
): number {
  switch (sourceType) {
    case "generated-managed":
      return 0;
    case "generated-unmanaged":
      return 1;
    case "manual-personal":
      return 2;
    default:
      return 9;
  }
}

function stripWrappingQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
