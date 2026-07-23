import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import {
  getLocalLlmConfigPath,
  getProjectRootDir,
} from "../io/project-paths.js";
import { getCodexEnvPath } from "../lab-api/env.js";

export const RUNTIME_MODES = ["dev", "desktop", "test"] as const;
export type RuntimeMode = (typeof RUNTIME_MODES)[number];
export const PRODUCT_SEED_MODES = ["empty", "demo"] as const;
export type ProductSeedMode = (typeof PRODUCT_SEED_MODES)[number];
export const RUNTIME_API_SECRET_HEADER =
  "x-oysterworkflow-runtime-secret" as const;
export const RUNTIME_API_SECRET_ENV_NAME =
  "OYSTERWORKFLOW_RUNTIME_SECRET" as const;

export interface RuntimeBridgeInfo {
  apiBaseUrl: string;
  platform: NodeJS.Platform | string;
  mode: RuntimeMode;
}

export interface RuntimeConfig {
  mode: RuntimeMode;
  apiSecret: string | null;
  productSeedMode: ProductSeedMode;
  apiPort: number;
  screenpipeBaseUrl: string;
  screenpipeBinaryPath: string;
  screenpipeWorkDir: string;
  hermesCommandPath: string | null;
  browserActCommandPath: string | null;
  hermesRuntimeRoot: string;
  hermesProfilesRoot: string;
  hermesSkillsRoot: string;
  screenpipeRecordingPort: number;
  screenpipeQueryPortStart: number;
  runsRoot: string;
  llmConfigPath: string;
  skillManagerConfigPath: string;
  codexEnvPath: string;
  platform: NodeJS.Platform | string;
  projectRootDir: string;
}

export interface ResolveRuntimeConfigInput {
  mode?: RuntimeMode;
  apiSecret?: string | null;
  productSeedMode?: ProductSeedMode;
  apiPort?: number;
  screenpipeBaseUrl?: string;
  screenpipeBinaryPath?: string;
  screenpipeWorkDir?: string;
  hermesCommandPath?: string | null;
  browserActCommandPath?: string | null;
  hermesRuntimeRoot?: string;
  hermesProfilesRoot?: string;
  hermesSkillsRoot?: string;
  screenpipeRecordingPort?: number;
  screenpipeQueryPortStart?: number;
  runsRoot?: string;
  llmConfigPath?: string;
  skillManagerConfigPath?: string;
  codexEnvPath?: string;
  platform?: NodeJS.Platform | string;
  cwd?: string;
  projectRootDir?: string;
}

const DESKTOP_APP_DIRNAME = "oysterworkflow";
const DEFAULT_API_PORT = 3034;
const DEFAULT_SCREENPIPE_RECORDING_PORT = 3030;
const DEFAULT_SCREENPIPE_QUERY_PORT_START = 3031;
export const RUNTIME_API_PORT_ENV_NAME = "OYSTERWORKFLOW_API_PORT";

const runtimeCliArgsSchema = z.object({
  mode: z.enum(RUNTIME_MODES).optional(),
  apiSecret: z.string().min(16).nullable().optional(),
  apiPort: z.number().int().nonnegative().optional(),
  screenpipeBaseUrl: z.string().url().optional(),
  screenpipeBinaryPath: z.string().min(1).optional(),
  screenpipeWorkDir: z.string().min(1).optional(),
  hermesCommandPath: z.string().min(1).nullable().optional(),
  browserActCommandPath: z.string().min(1).nullable().optional(),
  hermesRuntimeRoot: z.string().min(1).optional(),
  hermesProfilesRoot: z.string().min(1).optional(),
  hermesSkillsRoot: z.string().min(1).optional(),
  screenpipeRecordingPort: z.number().int().positive().optional(),
  screenpipeQueryPortStart: z.number().int().positive().optional(),
  runsRoot: z.string().min(1).optional(),
  llmConfigPath: z.string().min(1).optional(),
  skillManagerConfigPath: z.string().min(1).optional(),
  codexEnvPath: z.string().min(1).optional(),
});

/**
 * EN: Parses Runtime CLI arguments using the `--key value` style.
 * @param argv argument array such as `process.argv.slice(2)`.
 * @returns parsed runtime config input.
 */
export function parseRuntimeCliArgs(
  argv: string[],
): Partial<ResolveRuntimeConfigInput> {
  const parsed: Record<string, unknown> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith("--")) {
      continue;
    }

    const rawKey = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for runtime argument: ${token}`);
    }

    index += 1;
    switch (rawKey) {
      case "mode":
        parsed.mode = value;
        break;
      case "api-secret":
        parsed.apiSecret = value;
        break;
      case "api-port":
        parsed.apiPort = Number(value);
        break;
      case "screenpipe-base-url":
        parsed.screenpipeBaseUrl = value;
        break;
      case "screenpipe-binary":
        parsed.screenpipeBinaryPath = value;
        break;
      case "screenpipe-workdir":
        parsed.screenpipeWorkDir = value;
        break;
      case "hermes-command":
        parsed.hermesCommandPath = value;
        break;
      case "browser-act-command":
        parsed.browserActCommandPath = value;
        break;
      case "hermes-runtime-root":
        parsed.hermesRuntimeRoot = value;
        break;
      case "hermes-profiles-root":
        parsed.hermesProfilesRoot = value;
        break;
      case "hermes-skills-root":
        parsed.hermesSkillsRoot = value;
        break;
      case "screenpipe-recording-port":
        parsed.screenpipeRecordingPort = Number(value);
        break;
      case "screenpipe-query-port-start":
        parsed.screenpipeQueryPortStart = Number(value);
        break;
      case "runs-root":
        parsed.runsRoot = value;
        break;
      case "llm-config":
        parsed.llmConfigPath = value;
        break;
      case "skill-manager-config":
        parsed.skillManagerConfigPath = value;
        break;
      case "codex-env":
        parsed.codexEnvPath = value;
        break;
      default:
        throw new Error(`Unsupported runtime argument: --${rawKey}`);
    }
  }

  return runtimeCliArgsSchema.parse(parsed);
}

/**
 * EN: Resolves the final Runtime config, centralizing mode, directory, and Screenpipe defaults.
 * @param input optional overrides.
 * @returns fully resolved Runtime config.
 */
export function resolveRuntimeConfig(
  input: ResolveRuntimeConfigInput = {},
): RuntimeConfig {
  const mode = input.mode ?? "dev";
  const cwd = resolve(input.cwd ?? process.cwd());
  const projectRootDir = resolve(input.projectRootDir ?? getProjectRootDir());
  const platform = input.platform ?? process.platform;
  const appDataRoot = resolveAppDataRoot({ mode, platform, cwd });
  const screenpipeRecordingPort =
    input.screenpipeRecordingPort ?? DEFAULT_SCREENPIPE_RECORDING_PORT;

  const screenpipeBinaryPath = resolve(
    input.screenpipeBinaryPath ??
      resolveDefaultScreenpipeBinaryPath({
        mode,
        platform,
        projectRootDir,
      }),
  );
  const hermesRuntimeRoot = resolve(
    input.hermesRuntimeRoot ??
      resolveDefaultHermesRuntimeRoot({ appDataRoot, mode, platform }),
  );
  const defaultHermesCommandPath = resolveDefaultHermesCommandPath({
    mode,
    platform,
    projectRootDir,
  });
  const hermesCommandPath =
    input.hermesCommandPath === null
      ? null
      : (input.hermesCommandPath ?? defaultHermesCommandPath);
  const defaultBrowserActCommandPath = resolveDefaultBrowserActCommandPath({
    mode,
    platform,
    projectRootDir,
  });
  const browserActCommandPath =
    input.browserActCommandPath === null
      ? null
      : (input.browserActCommandPath ?? defaultBrowserActCommandPath);

  return {
    mode,
    apiSecret: resolveRuntimeApiSecret({
      mode,
      apiSecret: input.apiSecret,
      env: process.env,
    }),
    productSeedMode: input.productSeedMode ?? "empty",
    apiPort: resolveRuntimeApiPort({
      apiPort: input.apiPort,
      env: mode === "dev" ? process.env : undefined,
    }),
    screenpipeRecordingPort,
    screenpipeQueryPortStart:
      input.screenpipeQueryPortStart ?? DEFAULT_SCREENPIPE_QUERY_PORT_START,
    screenpipeBaseUrl:
      input.screenpipeBaseUrl ?? `http://127.0.0.1:${screenpipeRecordingPort}`,
    screenpipeBinaryPath,
    screenpipeWorkDir: resolve(
      input.screenpipeWorkDir ?? dirname(screenpipeBinaryPath),
    ),
    hermesCommandPath:
      hermesCommandPath === null ? null : resolve(hermesCommandPath),
    browserActCommandPath:
      browserActCommandPath === null ? null : resolve(browserActCommandPath),
    hermesRuntimeRoot,
    hermesProfilesRoot: resolve(
      input.hermesProfilesRoot ?? resolve(hermesRuntimeRoot, "profiles"),
    ),
    hermesSkillsRoot: resolve(
      input.hermesSkillsRoot ?? resolve(hermesRuntimeRoot, "skills"),
    ),
    runsRoot: resolve(
      input.runsRoot ??
        (mode === "desktop"
          ? resolve(appDataRoot, "runs")
          : mode === "test"
            ? resolve(appDataRoot, "runs")
            : resolve(cwd, ".runs")),
    ),
    llmConfigPath: resolve(
      input.llmConfigPath ??
        (mode === "desktop"
          ? resolve(appDataRoot, "config", "llm.config.json")
          : getLocalLlmConfigPath()),
    ),
    skillManagerConfigPath: resolve(
      input.skillManagerConfigPath ??
        (mode === "dev"
          ? resolve(cwd, ".runs", "config", "skill-manager.config.json")
          : resolve(appDataRoot, "config", "skill-manager.config.json")),
    ),
    codexEnvPath: resolve(input.codexEnvPath ?? getCodexEnvPath()),
    platform,
    projectRootDir,
  };
}

/**
 * EN: Resolves the desktop Runtime capability secret without enabling ambient auth in dev/test.
 * 中文: 解析桌面 Runtime 能力密钥，同时避免在 dev/test 中隐式启用鉴权。
 * @param input runtime mode, explicit override, and process environment.
 * @returns normalized secret for desktop mode, or null when capability auth is disabled.
 */
export function resolveRuntimeApiSecret(input: {
  mode: RuntimeMode;
  apiSecret?: string | null;
  env?: NodeJS.ProcessEnv;
}): string | null {
  if (input.apiSecret !== undefined) {
    return normalizeRuntimeApiSecret(input.apiSecret);
  }
  if (input.mode !== "desktop") {
    return null;
  }
  return normalizeRuntimeApiSecret(input.env?.[RUNTIME_API_SECRET_ENV_NAME]);
}

/**
 * EN: Resolves the Runtime API port from explicit input first, then the shared dev env var, then the default.
 * @param input optional explicit port and environment map.
 * @returns API port used by the Runtime HTTP server.
 */
export function resolveRuntimeApiPort(
  input: {
    apiPort?: number;
    env?: NodeJS.ProcessEnv;
  } = {},
): number {
  if (
    typeof input.apiPort === "number" &&
    Number.isInteger(input.apiPort) &&
    input.apiPort >= 0
  ) {
    return input.apiPort;
  }

  const envPort = parseRuntimeApiPort(input.env?.[RUNTIME_API_PORT_ENV_NAME]);
  return envPort ?? DEFAULT_API_PORT;
}

/**
 * EN: Builds the read-only bridge payload consumed by the renderer.
 * @param config runtime config.
 * @returns bridge info exposed to the renderer via preload.
 */
export function toRuntimeBridgeInfo(config: RuntimeConfig): RuntimeBridgeInfo {
  return {
    apiBaseUrl: `http://127.0.0.1:${config.apiPort}`,
    platform: config.platform,
    mode: config.mode,
  };
}

/**
 * EN: Resolves the default application data root used by desktop mode.
 * @param input mode, platform, and current working directory.
 * @returns application data root.
 */
function resolveAppDataRoot(input: {
  mode: RuntimeMode;
  platform: NodeJS.Platform | string;
  cwd: string;
}): string {
  if (input.mode !== "desktop") {
    if (input.mode === "test") {
      return resolve(tmpdir(), `${DESKTOP_APP_DIRNAME}-test`);
    }
    return input.cwd;
  }

  if (input.platform === "darwin") {
    return resolve(
      homedir(),
      "Library",
      "Application Support",
      DESKTOP_APP_DIRNAME,
    );
  }

  if (input.platform === "win32") {
    return resolve(
      process.env.APPDATA ?? resolve(homedir(), "AppData", "Roaming"),
      DESKTOP_APP_DIRNAME,
    );
  }

  return resolve(homedir(), `.${DESKTOP_APP_DIRNAME}`);
}

function resolveDefaultHermesRuntimeRoot(input: {
  appDataRoot: string;
  mode: RuntimeMode;
  platform: NodeJS.Platform | string;
}): string {
  if (input.mode === "desktop" && input.platform === "darwin") {
    return resolve(homedir(), "Library", DESKTOP_APP_DIRNAME, "hermes");
  }
  return resolve(input.appDataRoot, "hermes");
}

/**
 * EN: Resolves the default Screenpipe binary path across development and bundled layouts.
 * @param input mode and project root.
 * @returns default binary path.
 */
function resolveDefaultScreenpipeBinaryPath(input: {
  mode: RuntimeMode;
  platform: NodeJS.Platform | string;
  projectRootDir: string;
}): string {
  const executableName =
    input.platform === "win32" ? "screenpipe.exe" : "screenpipe";
  const candidates = [
    resolve(input.projectRootDir, "screenpipe", executableName),
    resolve(
      input.projectRootDir,
      "out",
      "bundled",
      "screenpipe",
      executableName,
    ),
    resolve(
      input.projectRootDir,
      "vendor",
      "screenpipe",
      "target",
      "release",
      executableName,
    ),
    resolve(
      input.projectRootDir,
      "vendor",
      "screenpipe",
      "target",
      "debug",
      executableName,
    ),
    ...(input.platform === "win32"
      ? [resolve(homedir(), "screenpipe", "bin", executableName)]
      : []),
  ];

  const matched = candidates.find((candidate) => existsSync(candidate));
  if (matched) {
    return matched;
  }

  return input.mode === "desktop" ? candidates[0]! : candidates[2]!;
}

/**
 * EN: Resolves the default managed Hermes command path for development and desktop packaging.
 * @param input mode, platform, and project root.
 * @returns preferred Hermes command path; callers may fall back if it is not bundled yet.
 */
function resolveDefaultHermesCommandPath(input: {
  mode: RuntimeMode;
  platform: NodeJS.Platform | string;
  projectRootDir: string;
}): string | null {
  const executableName = input.platform === "win32" ? "hermes.exe" : "hermes";
  const candidates = [
    resolve(input.projectRootDir, "out", "bundled", "hermes", executableName),
    resolve(input.projectRootDir, "vendor", "hermes", executableName),
  ];
  const matched = candidates.find((candidate) => existsSync(candidate));
  if (matched) {
    return matched;
  }
  return input.mode === "desktop" ? candidates[0]! : null;
}

/**
 * EN: Resolves the default BrowserAct launcher path owned by the Chrome capability provider.
 * 中文: 解析 Chrome 能力 provider 自己管理的 BrowserAct 启动器路径。
 * @param input mode, platform, and project root.
 * @returns preferred BrowserAct command path, or null when dev mode should use PATH.
 */
function resolveDefaultBrowserActCommandPath(input: {
  mode: RuntimeMode;
  platform: NodeJS.Platform | string;
  projectRootDir: string;
}): string | null {
  const executableName =
    input.platform === "win32" ? "browser-act.cmd" : "browser-act";
  const candidates = [
    resolve(
      input.projectRootDir,
      "out",
      "bundled",
      "browseract",
      executableName,
    ),
  ];
  const matched = candidates.find((candidate) => existsSync(candidate));
  if (matched) {
    return matched;
  }
  return input.mode === "desktop" ? candidates[0]! : null;
}

function parseRuntimeApiPort(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return null;
  }

  return parsed;
}

function normalizeRuntimeApiSecret(
  value: string | null | undefined,
): string | null {
  const normalized = value?.trim() ?? "";
  if (!normalized) {
    return null;
  }
  if (normalized.length < 16) {
    throw new Error("Runtime API secret must contain at least 16 characters.");
  }
  return normalized;
}
