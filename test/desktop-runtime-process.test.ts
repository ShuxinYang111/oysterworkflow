import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildDesktopRuntimeArgs,
  resolveDesktopRuntimePaths,
} from "../desktop/runtime-process.js";

describe("desktop runtime process helpers", () => {
  it("resolves dev-time bundled paths from the repo root", () => {
    const posix = path.posix;
    const repoRoot = posix.join("/", "repo", "oysterworkflow");
    const resourcesPath = posix.join(
      "/",
      "Applications",
      "OysterWorkflow.app",
      "Contents",
      "Resources",
    );
    const userDataPath = posix.join(
      "/",
      "Users",
      "tester",
      "Library",
      "Application Support",
      "OysterWorkflow",
    );
    const paths = resolveDesktopRuntimePaths({
      appPath: repoRoot,
      resourcesPath,
      userDataPath,
      isPackaged: false,
      platform: "darwin",
    });

    expect(paths.runtimeEntryPath).toBe(
      posix.join(repoRoot, "out", "runtime", "runtime", "server.js"),
    );
    expect(paths.mcpConnectionPath).toBe(
      posix.join(userDataPath, "mcp", "runtime-connection.json"),
    );
    expect(paths.legacyCodexMcpConnectionPath).toBe(
      posix.join(userDataPath, "codex", "runtime-connection.json"),
    );
    expect(paths.appRootPath).toBe(repoRoot);
    expect(paths.screenpipeBinaryPath).toBe(
      posix.join(repoRoot, "out", "bundled", "screenpipe", "screenpipe"),
    );
    expect(paths.hermesCommandPath).toBe(
      posix.join(repoRoot, "out", "bundled", "hermes", "hermes"),
    );
    expect(paths.browserActCommandPath).toBe(
      posix.join(repoRoot, "out", "bundled", "browseract", "browser-act"),
    );
    expect(paths.hermesRuntimeRoot).toBe(
      posix.join("/", "Users", "tester", "Library", "OysterWorkflow", "hermes"),
    );
    expect(paths.hermesRuntimeRoot).not.toContain(" ");
    expect(paths.hermesProfilesRoot).toBe(
      posix.join(
        "/",
        "Users",
        "tester",
        "Library",
        "OysterWorkflow",
        "hermes",
        "profiles",
      ),
    );
    expect(paths.hermesSkillsRoot).toBe(
      posix.join(
        "/",
        "Users",
        "tester",
        "Library",
        "OysterWorkflow",
        "hermes",
        "skills",
      ),
    );
    expect(
      paths.userLlmConfigPath.endsWith(posix.join("config", "llm.config.json")),
    ).toBe(true);
  });

  it("builds the desktop runtime argv with explicit desktop mode overrides", () => {
    const args = buildDesktopRuntimeArgs({
      apiPort: 39321,
      paths: {
        appRootPath: path.join(path.sep, "repo"),
        runtimeEntryPath: path.join(
          path.sep,
          "repo",
          "out",
          "runtime",
          "runtime",
          "server.js",
        ),
        mcpConnectionPath: path.join(
          path.sep,
          "user-data",
          "mcp",
          "runtime-connection.json",
        ),
        legacyCodexMcpConnectionPath: path.join(
          path.sep,
          "user-data",
          "codex",
          "runtime-connection.json",
        ),
        screenpipeBinaryPath: path.join(
          path.sep,
          "repo",
          "out",
          "bundled",
          "screenpipe",
          "screenpipe",
        ),
        hermesCommandPath: path.join(
          path.sep,
          "repo",
          "out",
          "bundled",
          "hermes",
          "hermes",
        ),
        browserActCommandPath: path.join(
          path.sep,
          "repo",
          "out",
          "bundled",
          "browseract",
          "browser-act",
        ),
        hermesRuntimeRoot: path.join(
          path.sep,
          "Users",
          "tester",
          "Library",
          "Application Support",
          "OysterWorkflow",
          "hermes",
        ),
        hermesProfilesRoot: path.join(
          path.sep,
          "Users",
          "tester",
          "Library",
          "Application Support",
          "OysterWorkflow",
          "hermes",
          "profiles",
        ),
        hermesSkillsRoot: path.join(
          path.sep,
          "Users",
          "tester",
          "Library",
          "Application Support",
          "OysterWorkflow",
          "hermes",
          "skills",
        ),
        bundledLlmConfigPath: path.join(
          path.sep,
          "repo",
          "config",
          "llm.config.json",
        ),
        userLlmConfigPath: path.join(
          path.sep,
          "Users",
          "tester",
          "Library",
          "Application Support",
          "OysterWorkflow",
          "config",
          "llm.config.json",
        ),
        userSkillManagerConfigPath: path.join(
          path.sep,
          "Users",
          "tester",
          "Library",
          "Application Support",
          "OysterWorkflow",
          "config",
          "skill-manager.config.json",
        ),
        runsRoot: path.join(
          path.sep,
          "Users",
          "tester",
          "Library",
          "Application Support",
          "OysterWorkflow",
          "runs",
        ),
        codexEnvPath: path.join(path.sep, "Users", "tester", ".codex", ".env"),
      },
    });

    expect(args).toEqual([
      path.join(path.sep, "repo", "out", "runtime", "runtime", "server.js"),
      "--mode",
      "desktop",
      "--api-port",
      "39321",
      "--screenpipe-binary",
      path.join(path.sep, "repo", "out", "bundled", "screenpipe", "screenpipe"),
      "--hermes-command",
      path.join(path.sep, "repo", "out", "bundled", "hermes", "hermes"),
      "--browser-act-command",
      path.join(
        path.sep,
        "repo",
        "out",
        "bundled",
        "browseract",
        "browser-act",
      ),
      "--hermes-runtime-root",
      path.join(
        path.sep,
        "Users",
        "tester",
        "Library",
        "Application Support",
        "OysterWorkflow",
        "hermes",
      ),
      "--hermes-profiles-root",
      path.join(
        path.sep,
        "Users",
        "tester",
        "Library",
        "Application Support",
        "OysterWorkflow",
        "hermes",
        "profiles",
      ),
      "--hermes-skills-root",
      path.join(
        path.sep,
        "Users",
        "tester",
        "Library",
        "Application Support",
        "OysterWorkflow",
        "hermes",
        "skills",
      ),
      "--runs-root",
      path.join(
        path.sep,
        "Users",
        "tester",
        "Library",
        "Application Support",
        "OysterWorkflow",
        "runs",
      ),
      "--llm-config",
      path.join(
        path.sep,
        "Users",
        "tester",
        "Library",
        "Application Support",
        "OysterWorkflow",
        "config",
        "llm.config.json",
      ),
      "--skill-manager-config",
      path.join(
        path.sep,
        "Users",
        "tester",
        "Library",
        "Application Support",
        "OysterWorkflow",
        "config",
        "skill-manager.config.json",
      ),
      "--codex-env",
      path.join(path.sep, "Users", "tester", ".codex", ".env"),
    ]);
  });

  it("resolves packaged desktop resources from the Electron resources directory", () => {
    const posix = path.posix;
    const appPath = posix.join(
      "/",
      "Applications",
      "OysterWorkflow.app",
      "Contents",
      "Resources",
      "app.asar",
    );
    const resourcesPath = posix.join(
      "/",
      "Applications",
      "OysterWorkflow.app",
      "Contents",
      "Resources",
    );
    const userDataPath = posix.join(
      "/",
      "Users",
      "tester",
      "Library",
      "Application Support",
      "OysterWorkflow",
    );
    const paths = resolveDesktopRuntimePaths({
      appPath,
      resourcesPath,
      userDataPath,
      isPackaged: true,
      platform: "darwin",
    });

    expect(paths.runtimeEntryPath).toBe(
      posix.join(appPath, "out", "runtime", "runtime", "server.js"),
    );
    expect(paths.appRootPath).toBe(appPath);
    expect(paths.screenpipeBinaryPath).toBe(
      posix.join(resourcesPath, "bin", "oysterworkflow-screenpipe"),
    );
    expect(paths.hermesCommandPath).toBe(
      posix.join(resourcesPath, "bin", "oysterworkflow-hermes"),
    );
    expect(paths.browserActCommandPath).toBe(
      posix.join(resourcesPath, "bin", "oysterworkflow-browseract"),
    );
    expect(paths.hermesRuntimeRoot).toBe(
      posix.join("/", "Users", "tester", "Library", "OysterWorkflow", "hermes"),
    );
    expect(paths.hermesRuntimeRoot).not.toContain(" ");
    expect(paths.bundledLlmConfigPath).toBe(
      posix.join(resourcesPath, "config", "llm.config.json"),
    );
  });

  it("uses Windows executable names for packaged Windows builds", () => {
    const win = path.win32;
    const appPath = win.join(
      "C:\\",
      "Program Files",
      "OysterWorkflow",
      "resources",
      "app.asar",
    );
    const resourcesPath = win.join(
      "C:\\",
      "Program Files",
      "OysterWorkflow",
      "resources",
    );
    const userDataPath = win.join(
      "C:\\",
      "Users",
      "tester",
      "AppData",
      "Roaming",
      "OysterWorkflow",
    );
    const paths = resolveDesktopRuntimePaths({
      appPath,
      resourcesPath,
      userDataPath,
      isPackaged: true,
      platform: "win32",
    });

    expect(paths.runtimeEntryPath).toBe(
      win.join(appPath, "out", "runtime", "runtime", "server.js"),
    );
    expect(paths.screenpipeBinaryPath).toBe(
      win.join(resourcesPath, "bin", "oysterworkflow-screenpipe.exe"),
    );
    expect(paths.hermesCommandPath).toBe(
      win.join(resourcesPath, "bin", "oysterworkflow-hermes.ps1"),
    );
    expect(paths.browserActCommandPath).toBe(
      win.join(resourcesPath, "bin", "oysterworkflow-browseract.ps1"),
    );
  });

  it("resolves the repo root when Electron runs from compiled dev output", () => {
    const win = path.win32;
    const repoRoot = win.join("K:\\", "OysterWorkflow");
    const appPath = win.join(repoRoot, "out", "electron", "desktop");
    const paths = resolveDesktopRuntimePaths({
      appPath,
      resourcesPath: win.join(
        repoRoot,
        "node_modules",
        "electron",
        "dist",
        "resources",
      ),
      userDataPath: win.join(
        "C:\\",
        "Users",
        "tester",
        "AppData",
        "Roaming",
        "Electron",
      ),
      isPackaged: false,
      platform: "win32",
    });

    expect(paths.appRootPath).toBe(repoRoot);
    expect(paths.runtimeEntryPath).toBe(
      win.join(repoRoot, "out", "runtime", "runtime", "server.js"),
    );
    expect(paths.screenpipeBinaryPath).toBe(
      win.join(repoRoot, "out", "bundled", "screenpipe", "screenpipe.exe"),
    );
    expect(paths.hermesCommandPath).toBe(
      win.join(repoRoot, "out", "bundled", "hermes", "hermes.ps1"),
    );
    expect(paths.browserActCommandPath).toBe(
      win.join(repoRoot, "out", "bundled", "browseract", "browser-act.ps1"),
    );
    expect(paths.bundledLlmConfigPath).toBe(
      win.join(repoRoot, "config", "llm.config.json"),
    );
  });
});
