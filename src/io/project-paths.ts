import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT_DIR = resolveProjectRootDir();

/**
 * EN: Detects the project root by walking upward for the packaged/shared
 * config directory, covering source runs, `out/runtime` builds, and Electron
 * resources layouts.
 * @returns inferred project root directory.
 */
function resolveProjectRootDir(): string {
  let currentDir = dirname(fileURLToPath(import.meta.url));

  for (let depth = 0; depth < 6; depth += 1) {
    if (hasProjectMarkers(currentDir)) {
      return currentDir;
    }
    currentDir = resolve(currentDir, "..");
  }

  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/**
 * EN: Checks whether a directory contains the shared config payload used by
 * both the repo workspace and packaged desktop resources.
 * @param candidateDir directory candidate.
 * @returns whether the project markers exist.
 */
function hasProjectMarkers(candidateDir: string): boolean {
  return existsSync(resolve(candidateDir, "config", "llm.config.json"));
}

/**
 * EN: Returns the repository root based on source location instead of `process.cwd()`.
 * @returns absolute repository root path.
 */
export function getProjectRootDir(): string {
  return PROJECT_ROOT_DIR;
}

/**
 * EN: Resolves an absolute path under the repository root.
 * @param segments path segments relative to repo root.
 * @returns absolute path.
 */
export function resolveProjectPath(...segments: string[]): string {
  return resolve(PROJECT_ROOT_DIR, ...segments);
}

/**
 * EN: Returns the bundled/public LLM config template path.
 * @returns absolute `config/llm.config.json` path.
 */
export function getDefaultLlmConfigPath(): string {
  return resolveProjectPath("config", "llm.config.json");
}

/**
 * EN: Returns the writable local-development LLM config path.
 * @returns absolute `config/llm.local.json` path.
 */
export function getLocalLlmConfigPath(): string {
  return resolveProjectPath("config", "llm.local.json");
}

/**
 * EN: Returns the preferred readable LLM config path for local development.
 * EN: Uses the local private config when present, otherwise falls back to the bundled template.
 * @returns absolute preferred LLM config path.
 */
export function getPreferredLlmConfigPath(): string {
  const localConfigPath = getLocalLlmConfigPath();
  return existsSync(localConfigPath)
    ? localConfigPath
    : getDefaultLlmConfigPath();
}

/**
 * EN: Returns the default absolute user skill config file path.
 * @returns absolute `config/user-skill.config.json` path.
 */
export function getDefaultUserSkillConfigPath(): string {
  return resolveProjectPath("config", "user-skill.config.json");
}

/**
 * EN: Returns the default absolute promptset directory path.
 * @returns absolute `config/promptsets` path.
 */
export function getDefaultPromptsetDir(): string {
  return resolveProjectPath("config", "promptsets");
}
