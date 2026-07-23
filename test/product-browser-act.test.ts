import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BrowserActBrowserProvider,
  createCapabilityProviderRegistry,
} from "../src/product/capabilities.js";
import { runOysterBrowserAction } from "../src/product/browser-act.js";
import { resolveRuntimeConfig } from "../src/runtime/config.js";

let tempRoot = "";
let previousBrowserActCommand: string | undefined;
let previousBrowserId: string | undefined;
let previousLogDir: string | undefined;
let previousBrowserSession: string | undefined;
let previousWorkflowRunId: string | undefined;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "oyster-browser-act-"));
  previousBrowserActCommand = process.env.OYSTER_BROWSER_ACT_COMMAND;
  previousBrowserId = process.env.OYSTER_BROWSER_ACT_BROWSER_ID;
  previousLogDir = process.env.OYSTER_BROWSER_LOG_DIR;
  previousBrowserSession = process.env.OYSTER_BROWSER_SESSION;
  previousWorkflowRunId = process.env.OYSTER_WORKFLOW_RUN_ID;
  delete process.env.OYSTER_BROWSER_SESSION;
  delete process.env.OYSTER_WORKFLOW_RUN_ID;
});

afterEach(async () => {
  restoreEnv("OYSTER_BROWSER_ACT_COMMAND", previousBrowserActCommand);
  restoreEnv("OYSTER_BROWSER_ACT_BROWSER_ID", previousBrowserId);
  restoreEnv("OYSTER_BROWSER_LOG_DIR", previousLogDir);
  restoreEnv("OYSTER_BROWSER_SESSION", previousBrowserSession);
  restoreEnv("OYSTER_WORKFLOW_RUN_ID", previousWorkflowRunId);
  await rm(tempRoot, { recursive: true, force: true });
});

describe("BrowserAct browser provider wrapper", () => {
  it("opens chrome-direct through BrowserAct and writes an audit log", async () => {
    const callsPath = await installFakeBrowserAct();
    const logDir = join(tempRoot, "logs");
    process.env.OYSTER_BROWSER_LOG_DIR = logDir;

    const result = await runOysterBrowserAction("open", {
      session: "yc-review",
      url: "https://www.ycombinator.com/co-founder-matching",
    });

    expect(result).toMatchObject({
      ok: true,
      action: "open",
      session: "yc-review",
      browserId: "direct_local_test",
      exitCode: 0,
    });
    await expect(readFile(callsPath, "utf8")).resolves.toContain(
      "--session yc-review browser open direct_local_test https://www.ycombinator.com/co-founder-matching --allow-restart-chrome",
    );
    const auditLog = await readFile(
      join(logDir, "oyster-browser.jsonl"),
      "utf8",
    );
    expect(auditLog).toContain('"action":"open"');
    expect(auditLog).toContain('"ok":true');
  });

  it("can disable Chrome restart recovery when explicitly requested", async () => {
    const callsPath = await installFakeBrowserAct();

    await expect(
      runOysterBrowserAction("open", {
        session: "yc-review",
        url: "https://www.ycombinator.com/co-founder-matching",
        allowRestartChrome: false,
      }),
    ).resolves.toMatchObject({ ok: true });

    const calls = await readFile(callsPath, "utf8");
    expect(calls).toContain(
      "--session yc-review browser open direct_local_test https://www.ycombinator.com/co-founder-matching",
    );
    expect(calls).not.toContain("--allow-restart-chrome");
  });

  it("derives the browser session from the OysterWorkflow run environment", async () => {
    const callsPath = await installFakeBrowserAct();
    process.env.OYSTER_WORKFLOW_RUN_ID = "run-1783550003038";

    await expect(runOysterBrowserAction("state", {})).resolves.toMatchObject({
      ok: true,
      session: "oyster-run-1783550003038",
    });

    const calls = await readFile(callsPath, "utf8");
    expect(calls).toContain("--session oyster-run-1783550003038 state");
  });

  it("allows interactive and JavaScript actions without permission tiers", async () => {
    const callsPath = await installFakeBrowserAct();

    await expect(
      runOysterBrowserAction("input", {
        session: "yc-review",
        index: 3,
        text: "invite draft",
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      runOysterBrowserAction("eval", {
        session: "yc-review",
        script: "document.title",
      }),
    ).resolves.toMatchObject({ ok: true });

    const calls = await readFile(callsPath, "utf8");
    expect(calls).toContain("--session yc-review input 3 invite draft");
    expect(calls).toContain("--session yc-review eval document.title");
  });

  it("force-settles a BrowserAct command that ignores graceful termination", async () => {
    await installFakeBrowserAct({ hangIgnoringTerm: true });
    const startedAt = Date.now();

    const result = await runOysterBrowserAction("state", {
      session: "hung-check",
      timeoutMs: 10,
    });

    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(result).toMatchObject({
      ok: false,
      action: "state",
      exitCode: null,
    });
    expect(result.stderr).toContain(
      "BrowserAct command timed out after 10ms and was terminated.",
    );
  }, 6_000);

  it("aborts a running BrowserAct process tree before its command timeout", async () => {
    await installFakeBrowserAct({ hangIgnoringTerm: true });
    const controller = new AbortController();
    const startedAt = Date.now();
    const pending = runOysterBrowserAction(
      "state",
      { session: "aborted-check", timeoutMs: 60_000 },
      { signal: controller.signal },
    );

    setTimeout(() => {
      controller.abort(new Error("test capability shutdown"));
    }, 25);

    await expect(pending).rejects.toThrow("test capability shutdown");
    expect(Date.now() - startedAt).toBeLessThan(2_500);
  }, 4_000);

  it("maps the formal BrowserCapability methods to the stable wrapper surface", async () => {
    const callsPath = await installFakeBrowserAct();
    const provider = new BrowserActBrowserProvider({
      commandPath: process.env.OYSTER_BROWSER_ACT_COMMAND ?? null,
      logDir: join(tempRoot, "logs"),
    });

    await expect(
      provider.hover({ session: "yc-review", index: 4 }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      provider.keys({ session: "yc-review", keys: "Enter" }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      provider.scroll({
        session: "yc-review",
        direction: "down",
        amount: 600,
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      provider.wait({
        session: "yc-review",
        mode: "stable",
        timeoutMs: 1_200,
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      provider.get({
        session: "yc-review",
        contentType: "text",
        index: 2,
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      provider.networkRequests({
        session: "yc-review",
        filter: "api",
        clear: true,
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      provider.networkRequest({
        session: "yc-review",
        requestId: "req-1",
      }),
    ).resolves.toMatchObject({ ok: true });

    const calls = await readFile(callsPath, "utf8");
    expect(calls).toContain("--session yc-review hover 4");
    expect(calls).toContain("--session yc-review keys Enter");
    expect(calls).toContain("--session yc-review scroll down --amount 600");
    expect(calls).toContain("--session yc-review wait stable --timeout 1200");
    expect(calls).toContain("--session yc-review get text 2");
    expect(calls).toContain(
      "--session yc-review network requests --filter api --clear",
    );
    expect(calls).toContain("--session yc-review network request req-1");
  });

  it("checks the Chrome capability provider through the registry", async () => {
    const callsPath = await installFakeBrowserAct({
      missingBrowserUntilCreated: true,
    });
    const runtimeRoot = join(tempRoot, "runtime");
    const registry = createCapabilityProviderRegistry(
      resolveRuntimeConfig({
        mode: "test",
        cwd: tempRoot,
        runsRoot: join(tempRoot, "runs"),
        projectRootDir: tempRoot,
        hermesRuntimeRoot: runtimeRoot,
        browserActCommandPath: process.env.OYSTER_BROWSER_ACT_COMMAND,
      }),
      {
        restartChromeAfterDebugPermission: async () => false,
      },
    );

    const provider = await registry.check("chrome");

    expect(provider).toMatchObject({
      id: "chrome",
      label: "Chrome",
      status: "ready",
      installed: true,
      pinnedVersion: "1.0.6",
      version: "1.0.6",
    });
    const calls = await readFile(callsPath, "utf8");
    expect(calls).toContain("browser list");
    expect(calls).toContain("browser create --type chrome-direct");
    expect(calls).toContain(
      "browser open direct_local_created https://example.com",
    );
    expect(calls).toContain("state");
    expect(calls).toContain("session close chrome-check-");
  });

  it("keeps the original Chrome diagnostic when the restart command fails", async () => {
    const callsPath = await installFakeBrowserAct({
      failOpenWithWindowError: true,
    });
    const registry = createCapabilityProviderRegistry(
      resolveRuntimeConfig({
        mode: "test",
        cwd: tempRoot,
        runsRoot: join(tempRoot, "runs"),
        projectRootDir: tempRoot,
        hermesRuntimeRoot: join(tempRoot, "runtime"),
        browserActCommandPath: process.env.OYSTER_BROWSER_ACT_COMMAND,
      }),
      {
        restartChromeAfterDebugPermission: async () => {
          throw new Error("Chrome restart failed");
        },
        readChromeDevToolsState: async () => ({
          port: 9222,
          browserPath: "/devtools/browser/approved",
        }),
        readChromeProcessIds: async () => [42],
        delayChromeRetry: async () => undefined,
      },
    );

    await expect(registry.check("chrome")).resolves.toMatchObject({
      status: "unavailable",
      lastError: expect.stringContaining("Browser window not found"),
    });
    const calls = await readFile(callsPath, "utf8");
    expect(calls).toContain("session close chrome-check-");
  });

  it("prepares the Chrome sidecar without opening a browser session", async () => {
    const callsPath = await installFakeBrowserAct();
    const runtimeRoot = join(tempRoot, "runtime");
    const registry = createCapabilityProviderRegistry(
      resolveRuntimeConfig({
        mode: "test",
        cwd: tempRoot,
        runsRoot: join(tempRoot, "runs"),
        projectRootDir: tempRoot,
        hermesRuntimeRoot: runtimeRoot,
        browserActCommandPath: process.env.OYSTER_BROWSER_ACT_COMMAND,
      }),
    );

    const provider = await registry.prepare("chrome");

    expect(provider).toMatchObject({
      id: "chrome",
      status: "not_checked",
      installed: true,
      version: "1.0.6",
    });
    const calls = await readFile(callsPath, "utf8");
    expect(calls).not.toContain("browser open");
    expect(calls).not.toContain("session close");
  });

  it("cancels an in-flight Chrome verify when the registry shuts down", async () => {
    const callsPath = await installFakeBrowserAct({ hangIgnoringTerm: true });
    const registry = createCapabilityProviderRegistry(
      resolveRuntimeConfig({
        mode: "test",
        cwd: tempRoot,
        runsRoot: join(tempRoot, "runs"),
        projectRootDir: tempRoot,
        hermesRuntimeRoot: join(tempRoot, "runtime"),
        browserActCommandPath: process.env.OYSTER_BROWSER_ACT_COMMAND,
      }),
    );
    const checking = registry.check("chrome");
    await waitForFileText(callsPath, "browser open");
    const startedAt = Date.now();

    const shuttingDown = registry.shutdown?.() ?? Promise.resolve();

    await expect(checking).rejects.toThrow(/shutting down/i);
    await expect(shuttingDown).resolves.toBeUndefined();
    expect(Date.now() - startedAt).toBeLessThan(2_500);
  }, 5_000);

  it("fully restarts Chrome once after first-permission window binding fails", async () => {
    const callsPath = await installFakeBrowserAct({
      failOpenUntilChromeRestart: true,
    });
    const restartChrome = vi.fn(async () => {
      await writeFile(join(tempRoot, "chrome-restarted"), "ready", "utf8");
      return true;
    });
    let devToolsReadCount = 0;
    const registry = createCapabilityProviderRegistry(
      resolveRuntimeConfig({
        mode: "test",
        cwd: tempRoot,
        runsRoot: join(tempRoot, "runs"),
        projectRootDir: tempRoot,
        hermesRuntimeRoot: join(tempRoot, "runtime"),
        browserActCommandPath: process.env.OYSTER_BROWSER_ACT_COMMAND,
      }),
      {
        restartChromeAfterDebugPermission: restartChrome,
        readChromeDevToolsState: async () =>
          devToolsReadCount++ === 0
            ? null
            : { port: 9222, browserPath: "/devtools/browser/approved" },
        readChromeProcessIds: async () => [42],
        delayChromeRetry: async () => undefined,
      },
    );

    await expect(registry.check("chrome")).resolves.toMatchObject({
      status: "ready",
      lastError: null,
    });
    expect(restartChrome).toHaveBeenCalledTimes(1);
    const calls = await readFile(callsPath, "utf8");
    const openCalls = calls
      .split(/\r?\n/u)
      .filter((line) => line.includes("browser open"));
    expect(openCalls).toHaveLength(4);
    expect(openCalls[0]).toContain("--allow-restart-chrome");
    expect(openCalls.slice(1).join("\n")).not.toContain(
      "--allow-restart-chrome",
    );
    expect(calls).toContain("state");
    expect(calls).toContain("session close chrome-check-");
  });

  it("returns actionable detail when Chrome debug mode cannot bind a window", async () => {
    const callsPath = await installFakeBrowserAct({
      failOpenWithWindowError: true,
    });
    const registry = createCapabilityProviderRegistry(
      resolveRuntimeConfig({
        mode: "test",
        cwd: tempRoot,
        runsRoot: join(tempRoot, "runs"),
        projectRootDir: tempRoot,
        hermesRuntimeRoot: join(tempRoot, "runtime"),
        browserActCommandPath: process.env.OYSTER_BROWSER_ACT_COMMAND,
      }),
      {
        restartChromeAfterDebugPermission: async () => false,
        readChromeDevToolsState: async () => ({
          port: 9222,
          browserPath: "/devtools/browser/approved",
        }),
        readChromeProcessIds: async () => [42],
        delayChromeRetry: async () => undefined,
      },
    );

    await expect(registry.check("chrome")).resolves.toMatchObject({
      status: "unavailable",
      detail: expect.stringContaining(
        "Chrome could not bind the signed-in browser window after waiting for startup.",
      ),
      lastError: expect.stringContaining("Browser window not found"),
    });
    const calls = await readFile(callsPath, "utf8");
    expect(calls).toContain("session close chrome-check-");
  });

  it("retries a state-stage window binding failure before restarting Chrome", async () => {
    const callsPath = await installFakeBrowserAct({
      failFirstStateWithWindowError: true,
    });
    const restartChrome = vi.fn(async () => true);
    const registry = createCapabilityProviderRegistry(
      resolveRuntimeConfig({
        mode: "test",
        cwd: tempRoot,
        runsRoot: join(tempRoot, "runs"),
        projectRootDir: tempRoot,
        hermesRuntimeRoot: join(tempRoot, "runtime"),
        browserActCommandPath: process.env.OYSTER_BROWSER_ACT_COMMAND,
      }),
      {
        restartChromeAfterDebugPermission: restartChrome,
        readChromeDevToolsState: async () => null,
        readChromeProcessIds: async () => [42],
        delayChromeRetry: async () => undefined,
      },
    );

    await expect(registry.check("chrome")).resolves.toMatchObject({
      status: "ready",
      lastError: null,
    });
    expect(restartChrome).not.toHaveBeenCalled();
    const calls = await readFile(callsPath, "utf8");
    expect(calls.match(/ browser open /gu)).toHaveLength(2);
    expect(calls.match(/ state$/gmu)).toHaveLength(2);
    expect(calls.match(/session close chrome-check-/gu)).toHaveLength(2);
  });

  it("does not restart Chrome again when BrowserAct already changed the process", async () => {
    await installFakeBrowserAct({ failOpenWithWindowError: true });
    const restartChrome = vi.fn(async () => true);
    let processReadCount = 0;
    const registry = createCapabilityProviderRegistry(
      resolveRuntimeConfig({
        mode: "test",
        cwd: tempRoot,
        runsRoot: join(tempRoot, "runs"),
        projectRootDir: tempRoot,
        hermesRuntimeRoot: join(tempRoot, "runtime"),
        browserActCommandPath: process.env.OYSTER_BROWSER_ACT_COMMAND,
      }),
      {
        restartChromeAfterDebugPermission: restartChrome,
        readChromeDevToolsState: async () => ({
          port: 9222,
          browserPath: "/devtools/browser/active",
        }),
        readChromeProcessIds: async () =>
          processReadCount++ === 0 ? [42] : [84],
        delayChromeRetry: async () => undefined,
      },
    );

    await expect(registry.check("chrome")).resolves.toMatchObject({
      status: "unavailable",
    });
    expect(restartChrome).not.toHaveBeenCalled();
  });

  it("does not restart Chrome while an AI Worker is actively using it", async () => {
    await installFakeBrowserAct({ failOpenWithWindowError: true });
    const restartChrome = vi.fn(async () => true);
    const registry = createCapabilityProviderRegistry(
      resolveRuntimeConfig({
        mode: "test",
        cwd: tempRoot,
        runsRoot: join(tempRoot, "runs"),
        projectRootDir: tempRoot,
        hermesRuntimeRoot: join(tempRoot, "runtime"),
        browserActCommandPath: process.env.OYSTER_BROWSER_ACT_COMMAND,
      }),
      {
        restartChromeAfterDebugPermission: restartChrome,
        readChromeDevToolsState: async () => ({
          port: 9222,
          browserPath: "/devtools/browser/active",
        }),
        readChromeProcessIds: async () => [42],
        delayChromeRetry: async () => undefined,
        canRestartChrome: async () => false,
      },
    );

    await expect(registry.check("chrome")).resolves.toMatchObject({
      status: "unavailable",
      detail: expect.stringContaining("active AI Worker"),
    });
    expect(restartChrome).not.toHaveBeenCalled();
  });

  it("retries Chrome browser discovery after the packaged helper first warms up", async () => {
    const callsPath = await installFakeBrowserAct({
      emptyBrowserListOnce: true,
    });

    await expect(
      runOysterBrowserAction("open", {
        session: "yc-review",
        url: "https://www.ycombinator.com/co-founder-matching",
      }),
    ).resolves.toMatchObject({
      ok: true,
      browserId: "direct_local_test",
    });

    const calls = await readFile(callsPath, "utf8");
    expect(calls.match(/browser list/gu)).toHaveLength(2);
    expect(calls).toContain(
      "browser open direct_local_test https://www.ycombinator.com/co-founder-matching",
    );
  });

  it("creates and verifies a chrome-direct profile when none is configured", async () => {
    const callsPath = await installFakeBrowserAct({
      missingBrowserUntilCreated: true,
    });

    await expect(
      Promise.all([
        runOysterBrowserAction("open", {
          session: "first-check",
          url: "https://example.com",
        }),
        runOysterBrowserAction("open", {
          session: "second-check",
          url: "https://example.com",
        }),
      ]),
    ).resolves.toEqual([
      expect.objectContaining({
        ok: true,
        browserId: "direct_local_created",
      }),
      expect.objectContaining({
        ok: true,
        browserId: "direct_local_created",
      }),
    ]);

    const calls = await readFile(callsPath, "utf8");
    expect(calls.match(/browser create/gu)).toHaveLength(1);
    expect(calls).toContain(
      "browser create --type chrome-direct --name OysterWorkflow Chrome --desc Use the signed-in local Chrome profile for OysterWorkflow browser tasks",
    );
    expect(calls).toContain(
      "--session first-check browser open direct_local_created https://example.com",
    );
    expect(calls).toContain(
      "--session second-check browser open direct_local_created https://example.com",
    );
  });
});

async function installFakeBrowserAct(
  input: {
    emptyBrowserListOnce?: boolean;
    failFirstOpenWithWindowError?: boolean;
    failFirstStateWithWindowError?: boolean;
    failOpenUntilChromeRestart?: boolean;
    failOpenWithWindowError?: boolean;
    hangIgnoringTerm?: boolean;
    missingBrowserUntilCreated?: boolean;
  } = {},
): Promise<string> {
  const commandPath = join(tempRoot, "browser-act");
  const callsPath = join(tempRoot, "browser-act-calls.txt");
  const emptyListMarkerPath = join(tempRoot, "browser-act-list-warmed");
  const failedOpenMarkerPath = join(tempRoot, "browser-act-open-failed");
  const failedStateMarkerPath = join(tempRoot, "browser-act-state-failed");
  const chromeRestartedMarkerPath = join(tempRoot, "chrome-restarted");
  const createdBrowserMarkerPath = join(tempRoot, "browser-act-created");
  await writeFile(
    commandPath,
    `#!/bin/sh
echo "$*" >> "${callsPath}"
if [ "$1" = "--version" ]; then
  echo 'browser-act-cli 1.0.6'
  exit 0
fi
if [ "$1" = "browser" ] && [ "$2" = "list" ]; then
  if [ "${input.emptyBrowserListOnce ? "1" : "0"}" = "1" ] && [ ! -f "${emptyListMarkerPath}" ]; then
    touch "${emptyListMarkerPath}"
    exit 0
  fi
  if [ "${input.missingBrowserUntilCreated ? "1" : "0"}" = "1" ] && [ ! -f "${createdBrowserMarkerPath}" ]; then
    exit 0
  fi
  if [ "${input.missingBrowserUntilCreated ? "1" : "0"}" = "1" ]; then
    echo 'id=direct_local_created name="OysterWorkflow Chrome" type=chrome-direct state=idle'
    exit 0
  fi
  echo 'id=direct_local_test name="local" type=chrome-direct state=idle'
  exit 0
fi
if [ "$1" = "browser" ] && [ "$2" = "create" ]; then
  touch "${createdBrowserMarkerPath}"
  echo 'id=direct_local_created name="OysterWorkflow Chrome" type=chrome-direct'
  exit 0
fi
if [ "${input.failFirstOpenWithWindowError ? "1" : "0"}" = "1" ] && [ ! -f "${failedOpenMarkerPath}" ] && printf '%s' "$*" | grep -q 'browser open'; then
  touch "${failedOpenMarkerPath}"
  echo "Error 210101: {'code': -32000, 'message': 'Browser window not found'}" >&2
  exit 1
fi
if [ "${input.failOpenUntilChromeRestart ? "1" : "0"}" = "1" ] && [ ! -f "${chromeRestartedMarkerPath}" ] && printf '%s' "$*" | grep -q 'browser open'; then
  echo "Error 210101: {'code': -32000, 'message': 'Browser window not found'}" >&2
  exit 1
fi
if [ "${input.failOpenWithWindowError ? "1" : "0"}" = "1" ] && printf '%s' "$*" | grep -q 'browser open'; then
  echo "Error 210101: {'code': -32000, 'message': 'Browser window not found'}" >&2
  exit 1
fi
if [ "${input.failFirstStateWithWindowError ? "1" : "0"}" = "1" ] && [ ! -f "${failedStateMarkerPath}" ] && printf '%s' "$*" | grep -q ' state$'; then
  touch "${failedStateMarkerPath}"
  echo "Error 210101: {'code': -32000, 'message': 'Browser window not found'}" >&2
  exit 1
fi
if [ "${input.hangIgnoringTerm ? "1" : "0"}" = "1" ]; then
  trap '' TERM
  while true; do
    sleep 1
  done
fi
echo "ok: $*"
exit 0
`,
    "utf8",
  );
  await chmod(commandPath, 0o755);
  process.env.OYSTER_BROWSER_ACT_COMMAND = commandPath;
  return callsPath;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function waitForFileText(
  filePath: string,
  expected: string,
): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const text = await readFile(filePath, "utf8").catch(() => "");
    if (text.includes(expected)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${expected} in ${filePath}`);
}
