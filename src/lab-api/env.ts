import { homedir } from "node:os";
import { resolve } from "node:path";
import dotenv from "dotenv";

/**
 * EN: Returns the default `~/.codex/.env` path used by the lab API.
 * @returns absolute `.env` path.
 */
export function getCodexEnvPath(): string {
  return resolve(homedir(), ".codex", ".env");
}

/**
 * EN: Loads `~/.codex/.env` into the current process environment.
 * @param path optional custom `.env` path.
 * @returns dotenv result with the resolved path.
 */
export function loadCodexEnv(path = getCodexEnvPath()): {
  path: string;
  parsed?: Record<string, string>;
} {
  const result = dotenv.config({
    path,
    override: false,
  });

  return {
    path,
    ...(result.parsed ? { parsed: result.parsed } : {}),
  };
}
