import { createServer } from "node:net";
import { homedir } from "node:os";
import path from "node:path";

const SCREENPIPE_HELPER_RESOURCE_DIRECTORY = "bin";
const HERMES_HELPER_RESOURCE_DIRECTORY = "bin";
const BROWSERACT_HELPER_RESOURCE_DIRECTORY = "bin";

export interface DesktopRuntimePaths {
  appRootPath: string;
  runtimeEntryPath: string;
  mcpConnectionPath: string;
  legacyCodexMcpConnectionPath: string;
  screenpipeBinaryPath: string;
  hermesCommandPath: string | null;
  browserActCommandPath: string | null;
  hermesRuntimeRoot: string;
  hermesProfilesRoot: string;
  hermesSkillsRoot: string;
  bundledLlmConfigPath: string;
  userLlmConfigPath: string;
  userSkillManagerConfigPath: string;
  runsRoot: string;
  codexEnvPath: string;
}

/**
 * EN: Resolves the key Runtime paths for desktop mode, covering both dev builds and packaged artifacts.
 * @param input Electron path context.
 * @returns all key paths required by the desktop Runtime.
 */
export function resolveDesktopRuntimePaths(input: {
  appPath: string;
  resourcesPath: string;
  userDataPath: string;
  isPackaged: boolean;
  platform?: NodeJS.Platform | string;
}): DesktopRuntimePaths {
  const platform = input.platform ?? process.platform;
  const pathApi = selectPathApi(platform);
  const helperExecutableName = resolveScreenpipeHelperExecutableName(platform);
  const bundledExecutableName =
    resolveBundledScreenpipeExecutableName(platform);
  const hermesHelperExecutableName =
    resolveHermesHelperExecutableName(platform);
  const bundledHermesExecutableName =
    resolveBundledHermesExecutableName(platform);
  const browserActHelperExecutableName =
    resolveBrowserActHelperExecutableName(platform);
  const bundledBrowserActExecutableName =
    resolveBundledBrowserActExecutableName(platform);
  const appRootPath = input.isPackaged
    ? input.appPath
    : resolveDevelopmentProjectRootPath(input.appPath, pathApi);
  const resourceBasePath = input.isPackaged ? input.resourcesPath : appRootPath;
  const hermesRuntimeRoot = resolveHermesRuntimeRoot({
    pathApi,
    platform,
    userDataPath: input.userDataPath,
  });
  return {
    appRootPath,
    runtimeEntryPath: pathApi.join(
      appRootPath,
      "out",
      "runtime",
      "runtime",
      "server.js",
    ),
    mcpConnectionPath: pathApi.join(
      input.userDataPath,
      "mcp",
      "runtime-connection.json",
    ),
    legacyCodexMcpConnectionPath: pathApi.join(
      input.userDataPath,
      "codex",
      "runtime-connection.json",
    ),
    screenpipeBinaryPath: input.isPackaged
      ? pathApi.join(
          resourceBasePath,
          SCREENPIPE_HELPER_RESOURCE_DIRECTORY,
          helperExecutableName,
        )
      : pathApi.join(
          resourceBasePath,
          "out",
          "bundled",
          "screenpipe",
          bundledExecutableName,
        ),
    hermesCommandPath: input.isPackaged
      ? pathApi.join(
          resourceBasePath,
          HERMES_HELPER_RESOURCE_DIRECTORY,
          hermesHelperExecutableName,
        )
      : pathApi.join(
          resourceBasePath,
          "out",
          "bundled",
          "hermes",
          bundledHermesExecutableName,
        ),
    browserActCommandPath: input.isPackaged
      ? pathApi.join(
          resourceBasePath,
          BROWSERACT_HELPER_RESOURCE_DIRECTORY,
          browserActHelperExecutableName,
        )
      : pathApi.join(
          resourceBasePath,
          "out",
          "bundled",
          "browseract",
          bundledBrowserActExecutableName,
        ),
    hermesRuntimeRoot,
    hermesProfilesRoot: pathApi.join(hermesRuntimeRoot, "profiles"),
    hermesSkillsRoot: pathApi.join(hermesRuntimeRoot, "skills"),
    bundledLlmConfigPath: pathApi.join(
      resourceBasePath,
      "config",
      "llm.config.json",
    ),
    userLlmConfigPath: pathApi.join(
      input.userDataPath,
      "config",
      "llm.config.json",
    ),
    userSkillManagerConfigPath: pathApi.join(
      input.userDataPath,
      "config",
      "skill-manager.config.json",
    ),
    runsRoot: pathApi.join(input.userDataPath, "runs"),
    codexEnvPath: pathApi.join(homedir(), ".codex", ".env"),
  };
}

/**
 * EN: Builds the startup arguments Electron passes when spawning the Runtime.
 * @param input runtime port and path bundle.
 * @returns runtime argument array.
 */
export function buildDesktopRuntimeArgs(input: {
  apiPort: number;
  paths: DesktopRuntimePaths;
}): string[] {
  return [
    input.paths.runtimeEntryPath,
    "--mode",
    "desktop",
    "--api-port",
    String(input.apiPort),
    "--screenpipe-binary",
    input.paths.screenpipeBinaryPath,
    ...(input.paths.hermesCommandPath
      ? ["--hermes-command", input.paths.hermesCommandPath]
      : []),
    ...(input.paths.browserActCommandPath
      ? ["--browser-act-command", input.paths.browserActCommandPath]
      : []),
    "--hermes-runtime-root",
    input.paths.hermesRuntimeRoot,
    "--hermes-profiles-root",
    input.paths.hermesProfilesRoot,
    "--hermes-skills-root",
    input.paths.hermesSkillsRoot,
    "--runs-root",
    input.paths.runsRoot,
    "--llm-config",
    input.paths.userLlmConfigPath,
    "--skill-manager-config",
    input.paths.userSkillManagerConfigPath,
    "--codex-env",
    input.paths.codexEnvPath,
  ];
}

/**
 * EN: Finds an available local port for the desktop Runtime.
 * @returns available port number.
 */
export async function findFreePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() =>
          rejectPort(new Error("Unable to resolve free port.")),
        );
        return;
      }

      server.close((error) => {
        if (error) {
          rejectPort(error);
          return;
        }
        resolvePort(address.port);
      });
    });
  });
}

function resolveScreenpipeHelperExecutableName(
  platform: NodeJS.Platform | string,
): string {
  return platform === "win32"
    ? "oysterworkflow-screenpipe.exe"
    : "oysterworkflow-screenpipe";
}

function resolveBundledScreenpipeExecutableName(
  platform: NodeJS.Platform | string,
): string {
  return platform === "win32" ? "screenpipe.exe" : "screenpipe";
}

function resolveHermesHelperExecutableName(
  platform: NodeJS.Platform | string,
): string {
  return platform === "win32"
    ? "oysterworkflow-hermes.ps1"
    : "oysterworkflow-hermes";
}

function resolveBrowserActHelperExecutableName(
  platform: NodeJS.Platform | string,
): string {
  return platform === "win32"
    ? "oysterworkflow-browseract.ps1"
    : "oysterworkflow-browseract";
}

function resolveBundledHermesExecutableName(
  platform: NodeJS.Platform | string,
): string {
  return platform === "win32" ? "hermes.ps1" : "hermes";
}

function resolveBundledBrowserActExecutableName(
  platform: NodeJS.Platform | string,
): string {
  return platform === "win32" ? "browser-act.ps1" : "browser-act";
}

function selectPathApi(platform: NodeJS.Platform | string): path.PlatformPath {
  return platform === "win32" ? path.win32 : path.posix;
}

function resolveHermesRuntimeRoot(input: {
  pathApi: path.PlatformPath;
  platform: NodeJS.Platform | string;
  userDataPath: string;
}): string {
  if (input.platform !== "darwin") {
    return input.pathApi.join(input.userDataPath, "hermes");
  }

  const appDirectoryName =
    input.pathApi.basename(input.userDataPath) || "oysterworkflow";
  const parentDirectory = input.pathApi.dirname(input.userDataPath);
  const libraryDirectory =
    input.pathApi.basename(parentDirectory) === "Application Support"
      ? input.pathApi.dirname(parentDirectory)
      : parentDirectory;
  return input.pathApi.join(libraryDirectory, appDirectoryName, "hermes");
}

function resolveDevelopmentProjectRootPath(
  appPath: string,
  pathApi: path.PlatformPath,
): string {
  const desktopDir = appPath;
  const electronDir = pathApi.dirname(desktopDir);
  const outDir = pathApi.dirname(electronDir);
  if (
    pathApi.basename(desktopDir) === "desktop" &&
    pathApi.basename(electronDir) === "electron" &&
    pathApi.basename(outDir) === "out"
  ) {
    return pathApi.dirname(outDir);
  }
  return appPath;
}
