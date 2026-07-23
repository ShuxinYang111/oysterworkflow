import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RUNNER_REQUEST_SCHEMA_VERSION,
  applyRunnerRequestOptions,
  loadRunnerRequestFile,
  normalizeRunnerRequest,
} from "../scripts/lib/codex-runner-request.mjs";

let tempRoot = "";

afterEach(async () => {
  if (tempRoot) {
    await import("node:fs/promises").then(({ rm }) =>
      rm(tempRoot, { recursive: true, force: true }),
    );
    tempRoot = "";
  }
});

describe("codex runner request", () => {
  it("normalizes a structured request into Desktop probe options", () => {
    const request = {
      schemaVersion: RUNNER_REQUEST_SCHEMA_VERSION,
      skillPath: "skills/demo-skill.json",
      outDir: ".runs/demo",
      browser: {
        enabled: true,
        surface: "chrome",
        serveProbePage: true,
      },
      computerUse: {
        enabled: true,
        prepareTextEditTarget: true,
        acceptedApps: ["TextEdit"],
        safeAutoReview: true,
        task: "Open a local app and observe its window.",
      },
      codex: {
        bin: "codex",
        approvalPolicy: "never",
        approvalsReviewer: null,
        ephemeral: false,
        remoteEnvironmentScope: "none",
        startRemoteControl: false,
        threadTitle: "Visible AI Worker",
        timeoutMs: 12345,
        workspaceRoot: "demo-project",
      },
      watchdog: {
        scan: true,
        codexHome: ".codex-fixture",
        codexBin: "/bin/echo",
        resumeMode: "dry-run",
        useTtyWrapper: false,
        liveWindowMinutes: 60,
        delaySeconds: 2,
        maxAttempts: 2,
        maxSessions: 3,
        prompt: "Continue safely.",
        resumeTimeoutMs: 5000,
      },
    };

    const options = normalizeRunnerRequest(request, {
      baseDir: "/tmp/request-root",
      requestPath: "/tmp/request-root/request.json",
    });

    expect(options.skillPath).toBe("/tmp/request-root/skills/demo-skill.json");
    expect(options.outDir).toBe("/tmp/request-root/.runs/demo");
    expect(options.browserSurface).toBe("chrome");
    expect(options.includeBrowser).toBe(true);
    expect(options.serveProbePage).toBe(true);
    expect(options.includeComputerUse).toBe(true);
    expect(options.computerUseTask).toBe(
      "Open a local app and observe its window.",
    );
    expect(options.prepareTextEditTarget).toBe(true);
    expect(options.acceptedComputerUseApps).toEqual(["TextEdit"]);
    expect(options.approvalPolicy).toBe("never");
    expect(options.approvalsReviewer).toBe(null);
    expect(options.threadEphemeral).toBe(false);
    expect(options.threadTitle).toBe("Visible AI Worker");
    expect(options.noStartRemoteControl).toBe(true);
    expect(options.timeoutMs).toBe(12345);
    expect(options.workspaceRoot).toBe("/tmp/request-root/demo-project");
    expect(options.watchdogCodexHome).toBe("/tmp/request-root/.codex-fixture");
    expect(options.watchdogCodexBin).toBe("/bin/echo");
    expect(options.watchdogResumeMode).toBe("dry-run");
    expect(options.watchdogUseTtyWrapper).toBe(false);
    expect(options.watchdogLiveWindowMs).toBe(60 * 60_000);
    expect(options.watchdogDelayMs).toBe(2_000);
    expect(options.watchdogPrompt).toBe("Continue safely.");
  });

  it("loads a request file and resolves paths relative to that file", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "oyster-runner-request-"));
    await mkdir(path.join(tempRoot, "skills"), { recursive: true });
    const requestPath = path.join(tempRoot, "request.json");
    await writeFile(
      requestPath,
      JSON.stringify({
        schemaVersion: RUNNER_REQUEST_SCHEMA_VERSION,
        skillPath: "skills/demo.json",
        browser: { surface: "chrome" },
      }),
      "utf8",
    );

    const options = await loadRunnerRequestFile(requestPath);

    expect(options.requestJsonPath).toBe(requestPath);
    expect(options.skillPath).toBe(path.join(tempRoot, "skills", "demo.json"));
    expect(options.browserSurface).toBe("chrome");
  });

  it("merges accepted Computer Use apps instead of replacing existing CLI apps", () => {
    const options = {
      acceptedComputerUseApps: ["Preview"],
      browserSurface: "iab",
    };

    applyRunnerRequestOptions(options, {
      acceptedComputerUseApps: ["TextEdit", "Preview"],
      browserSurface: "chrome",
    });

    expect(options.acceptedComputerUseApps).toEqual(["Preview", "TextEdit"]);
    expect(options.browserSurface).toBe("chrome");
  });

  it("rejects unknown fields and invalid enum values", () => {
    expect(() =>
      normalizeRunnerRequest(
        {
          schemaVersion: RUNNER_REQUEST_SCHEMA_VERSION,
          browser: { surface: "safari" },
        },
        { baseDir: "/tmp" },
      ),
    ).toThrow("browser.surface must be one of");

    expect(() =>
      normalizeRunnerRequest(
        { schemaVersion: RUNNER_REQUEST_SCHEMA_VERSION, unknown: true },
        { baseDir: "/tmp" },
      ),
    ).toThrow("request.unknown is not supported");
  });
});
