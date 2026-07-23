import {
  access,
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  approveHermesGatewayPairing,
  beginHermesGatewayChannelSetup,
  cancelHermesGatewayChannelSetup,
  configureHermesGatewayChannel,
  disconnectHermesGatewayChannel,
  ensureHermesGatewayRunning,
  HERMES_STATUS_TIMEOUT_MS,
  hermesGatewayStatusIsRunning,
  installHermesSkill,
  probeHermesStatus,
  provisionHermesAgent,
  readHermesGatewayChannelSetup,
  startHermesProgressLogWatcher,
  startHermesWorkerTurn,
  stopHermesWorkerProcesses,
} from "../src/product/hermes.js";

let tempRoot = "";

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "oyster-product-hermes-"));
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe("product Hermes integration", () => {
  if (process.platform === "win32") {
    it("provisions a worker profile through a PowerShell Hermes launcher", async () => {
      const hermesPath = join(tempRoot, "fake-hermes.ps1");
      const llmConfigPath = join(tempRoot, "llm.config.json");
      const profilesRoot = join(tempRoot, "profiles");
      const profileName = "ow-worker-windows-worker";
      const profilePath = join(profilesRoot, profileName);
      const profileMarker = join(tempRoot, "profile-created");
      const argumentLogPath = join(tempRoot, "hermes-args.log");
      const psLiteral = (value: string): string =>
        `'${value.replace(/'/gu, "''")}'`;
      await writeFile(
        llmConfigPath,
        `${JSON.stringify({
          provider: "test",
          baseUrl: "https://example.test/v1",
          wireApi: "responses",
          model: "gpt-test",
          apiKey: "test-key",
        })}\n`,
        "utf8",
      );
      await writeFile(
        hermesPath,
        `$ErrorActionPreference = "Stop"
$ProfileMarker = ${psLiteral(profileMarker)}
$ProfilePath = ${psLiteral(profilePath)}
Add-Content -LiteralPath ${psLiteral(argumentLogPath)} -Value ($args -join " ")
if ($args.Count -ge 4 -and $args[0] -eq "-p" -and $args[2] -eq "profile" -and $args[3] -eq "show") {
  if (Test-Path -LiteralPath $ProfileMarker) {
    [Console]::Out.WriteLine("Profile path: $ProfilePath")
    exit 0
  }
  exit 1
}
if ($args.Count -ge 3 -and $args[0] -eq "profile" -and $args[1] -eq "create") {
  New-Item -ItemType Directory -Path $ProfilePath -Force | Out-Null
  Set-Content -LiteralPath $ProfileMarker -Value "created"
  [Console]::Out.WriteLine("Created profile $($args[2])")
  exit 0
}
exit 2
`,
        "utf8",
      );

      await expect(
        provisionHermesAgent({
          workerId: "worker",
          workerName: "Windows Worker",
          configSource: {
            label: "test",
            commandPath: hermesPath,
            llmConfigPath,
            runtimeHome: join(tempRoot, "hermes-home"),
            profilesRoot,
          },
        }),
      ).resolves.toMatchObject({
        profileName,
        agentReference: `hermes-profile:${profileName}`,
        profilePath,
      });
      const argumentLog = await readFile(argumentLogPath, "utf8");
      expect(argumentLog).toContain(
        `-p ${profileName} profile show ${profileName}`,
      );
      expect(argumentLog).toContain(
        `profile create ${profileName} --clone --no-alias`,
      );
    });

    it("exports a worker session through a PowerShell Hermes launcher", async () => {
      const hermesPath = join(tempRoot, "fake-hermes-export.ps1");
      const llmConfigPath = join(tempRoot, "llm.config.json");
      const profilesRoot = join(tempRoot, "profiles");
      const argumentLogPath = join(tempRoot, "hermes-export-args.log");
      const profileName = "ow-worker-export";
      const sessionId = "20260723_001122_2f379a";
      const assistantMessage = [
        "PowerShell session export completed.",
        'OYSTERWORKFLOW_SESSION_STATUS {"status":"running","message":"Ready for another command","user_action":null}',
      ].join("\n");
      const exportPayload = JSON.stringify({
        id: sessionId,
        source: "oysterworkflow-worker",
        messages: [
          {
            id: 1,
            session_id: sessionId,
            role: "assistant",
            content: assistantMessage,
            timestamp: 1784784682,
            active: 1,
          },
        ],
      });
      const psLiteral = (value: string): string =>
        `'${value.replace(/'/gu, "''")}'`;
      await writeFile(
        llmConfigPath,
        `${JSON.stringify({
          provider: "test",
          baseUrl: "https://example.test/v1",
          wireApi: "responses",
          model: "gpt-test",
          apiKey: "test-key",
        })}\n`,
        "utf8",
      );
      await writeFile(
        hermesPath,
        `$ErrorActionPreference = "Stop"
Add-Content -LiteralPath ${psLiteral(argumentLogPath)} -Value ($args -join " ")
if ($args.Count -ge 3 -and $args[0] -eq "-p" -and $args[2] -eq "chat") {
  [Console]::Out.WriteLine("Session: ${sessionId}")
  [Console]::Out.WriteLine("OYSTERWORKFLOW_WORKER_READY")
  exit 0
}
if ($args.Count -ge 7 -and $args[0] -eq "-p" -and $args[2] -eq "sessions" -and $args[3] -eq "export") {
  if ($args[4] -eq "-") {
    throw "PowerShell must receive a file output path instead of a bare dash."
  }
  if ($args[5] -ne "--session-id" -or $args[6] -ne "${sessionId}") {
    throw "Unexpected session export arguments."
  }
  [System.IO.File]::WriteAllText(
    $args[4],
    ${psLiteral(exportPayload)},
    [System.Text.UTF8Encoding]::new($false)
  )
  exit 0
}
throw "Unexpected fake Hermes arguments: $($args -join ' ')"
`,
        "utf8",
      );

      const handle = await startHermesWorkerTurn({
        cwd: tempRoot,
        prompt: "initialize",
        workerAgentReference: `hermes-profile:${profileName}`,
        configSource: {
          label: "test",
          commandPath: hermesPath,
          llmConfigPath,
          runtimeHome: join(tempRoot, "hermes-home"),
          profilesRoot,
        },
      });

      await expect(handle.completion).resolves.toMatchObject({
        ok: true,
        sessionId,
        sessionStatus: "running",
        sessionStatusMessage: "Ready for another command",
        output: assistantMessage,
        errorMessage: null,
      });
      const argumentLog = await readFile(argumentLogPath, "utf8");
      expect(argumentLog).toContain(
        `-p ${profileName} sessions export ${tmpdir()}`,
      );
      expect(argumentLog).not.toContain("sessions export - --session-id");
    });
  }

  it("validates QR setup process ownership before bounded tree termination", async () => {
    const setupId = "setup-owned-qr-process";
    const profileName = "ow-qr-owner";
    const profilesRoot = join(tempRoot, "profiles");
    const readyMarker = join(tempRoot, "qr-process-ready");
    const child = spawn(
      process.execPath,
      [
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(readyMarker)}, "ready"); process.on("SIGTERM", () => undefined); setInterval(() => undefined, 1000);`,
        "--",
        "-p",
        profileName,
        "gateway",
        "channel-setup",
        "run",
        "--setup-id",
        setupId,
      ],
      { detached: process.platform !== "win32", stdio: "ignore" },
    );
    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      child.once("spawn", resolveSpawn);
      child.once("error", rejectSpawn);
    });
    const pid = child.pid!;
    child.unref();
    await waitForPath(readyMarker);
    const configSource = {
      label: "test",
      llmConfigPath: join(tempRoot, "llm.config.json"),
      profilesRoot,
    };

    try {
      await expect(
        cancelHermesGatewayChannelSetup({
          processId: pid,
          setupId: "setup-does-not-match",
          workerAgentReference: `hermes-profile:${profileName}`,
          configSource,
        }),
      ).resolves.toBe(false);
      expect(await isProcessAlive(pid)).toBe(true);

      const startedAt = Date.now();
      await expect(
        cancelHermesGatewayChannelSetup({
          processId: pid,
          setupId,
          workerAgentReference: `hermes-profile:${profileName}`,
          configSource,
        }),
      ).resolves.toBe(true);
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      await expect(waitForProcessExit(pid)).resolves.toBeUndefined();
    } finally {
      if (await isProcessAlive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // The bounded terminator may have completed between checks.
        }
      }
    }
  });

  it("rejects unreadable and self-referential workflow source skills", async () => {
    const profilesRoot = join(tempRoot, "profiles");
    const baseInput = {
      workflowId: "workflow-source-validation",
      workflowTitle: "Validate workflow source",
      description: "Validate the canonical workflow source handoff.",
      apps: ["Google Chrome"],
      workerAgentReference: "hermes-profile:ow-sales",
      profilesRoot,
    };

    await expect(
      installHermesSkill({
        ...baseInput,
        sourceSkillPath: join(tempRoot, "missing-skill.json"),
      }),
    ).rejects.toThrow(/Cannot read workflow source skill/u);

    const installed = await installHermesSkill(baseInput);
    await expect(
      installHermesSkill({
        ...baseInput,
        sourceSkillPath: installed.skillPath,
      }),
    ).rejects.toThrow(/managed Hermes target/u);
  });

  it("authorizes the WeChat QR owner without carrying another platform allowlist", async () => {
    const profilesRoot = join(tempRoot, "profiles");
    const profileDir = join(profilesRoot, "ow-sales");
    const setupDir = join(profileDir, "gateway-setups");
    await mkdir(setupDir, { recursive: true });

    await configureHermesGatewayChannel({
      workerAgentReference: "hermes-profile:ow-sales",
      channel: {
        platform: "weixin",
        accessMode: "allowlist",
        allowedUsers: ["wechat-owner-123"],
        credentials: {},
      },
      configSource: {
        label: "test",
        llmConfigPath: join(tempRoot, "llm.config.json"),
        profilesRoot,
      },
    });

    await expect(readFile(join(profileDir, ".env"), "utf8")).resolves.toBe(
      'WEIXIN_ALLOWED_USERS="wechat-owner-123"\nWEIXIN_DM_POLICY="allowlist"\nWEIXIN_GROUP_POLICY="disabled"\n',
    );

    await writeFile(
      join(setupDir, "setup-wechat-owner.json"),
      `${JSON.stringify({
        setupId: "setup-wechat-owner",
        platform: "weixin",
        state: "connected",
        accountId: "bot-account@im.bot",
        userId: "wechat-owner-123",
        updatedAt: "2026-07-12T09:00:00.000Z",
      })}\n`,
      "utf8",
    );

    await expect(
      readHermesGatewayChannelSetup({
        setupId: "setup-wechat-owner",
        workerAgentReference: "hermes-profile:ow-sales",
        platform: "weixin",
        configSource: {
          label: "test",
          llmConfigPath: join(tempRoot, "llm.config.json"),
          profilesRoot,
        },
      }),
    ).resolves.toMatchObject({
      status: "connected",
      ownerUserId: "wechat-owner-123",
    });
  });

  it("removes channel routes, credentials, pairing state, and restarts the profile", async () => {
    const hermesPath = join(tempRoot, "fake-hermes-disconnect");
    const argsPath = join(tempRoot, "disconnect-args.txt");
    const profilesRoot = join(tempRoot, "profiles");
    const profileDir = join(profilesRoot, "ow-sales");
    const pairingDir = join(profileDir, "platforms", "pairing");
    await mkdir(pairingDir, { recursive: true });
    await writeFile(
      join(profileDir, ".env"),
      'SLACK_BOT_TOKEN="xoxb-secret"\nSLACK_APP_TOKEN="xapp-secret"\nOPENAI_API_KEY="keep-me"\n',
      "utf8",
    );
    await writeFile(join(pairingDir, "slack-approved.json"), "[]\n", "utf8");
    await writeFile(join(pairingDir, "slack-pending.json"), "[]\n", "utf8");
    await writeFile(
      hermesPath,
      `#!/bin/sh
printf '%s\n' "$*" >> "${argsPath}"
if echo "$*" | grep -q "bindings unbind"; then
  echo '{"ok":true,"action":"unbind","removed":1}'
  exit 0
fi
if echo "$*" | grep -q "gateway restart"; then
  echo 'Gateway restarted'
  exit 0
fi
exit 1
`,
      "utf8",
    );
    await chmod(hermesPath, 0o755);

    await disconnectHermesGatewayChannel({
      workerAgentReference: "hermes-profile:ow-sales",
      platform: "slack",
      bindings: [{ chatId: "D123", threadId: null }],
      configSource: {
        label: "test",
        commandPath: hermesPath,
        llmConfigPath: join(tempRoot, "llm.config.json"),
        profilesRoot,
      },
    });

    const environment = await readFile(join(profileDir, ".env"), "utf8");
    expect(environment).toBe('OPENAI_API_KEY="keep-me"\n');
    await expect(
      access(join(pairingDir, "slack-approved.json")),
    ).rejects.toThrow();
    await expect(
      access(join(pairingDir, "slack-pending.json")),
    ).rejects.toThrow();
    const args = await readFile(argsPath, "utf8");
    expect(args).toContain(
      "gateway bindings unbind --platform slack --chat-id D123",
    );
    expect(args).toContain("gateway restart");
  });

  it("approves a gateway pairing code through structured CLI output", async () => {
    const hermesPath = join(tempRoot, "fake-hermes-pairing");
    const argsPath = join(tempRoot, "pairing-args.txt");
    await writeFile(
      hermesPath,
      `#!/bin/sh
printf '%s' "$*" > "${argsPath}"
echo '{"ok":true,"action":"approve-pairing","pairing":{"platform":"slack","user_id":"U123","user_name":"alex"}}'
`,
      "utf8",
    );
    await chmod(hermesPath, 0o755);

    await expect(
      approveHermesGatewayPairing({
        workerAgentReference: "hermes-profile:ow-sales",
        platform: "slack",
        code: "ab23cdef",
        configSource: {
          label: "test",
          commandPath: hermesPath,
          llmConfigPath: join(tempRoot, "llm.config.json"),
          runtimeHome: join(tempRoot, "hermes-home"),
        },
      }),
    ).resolves.toEqual({
      platform: "slack",
      userId: "U123",
      userName: "alex",
    });
    await expect(readFile(argsPath, "utf8")).resolves.toContain(
      "gateway bindings approve-pairing --platform slack --code AB23CDEF",
    );
  });

  it("allows the packaged status probe enough time for first-run managed install", () => {
    expect(HERMES_STATUS_TIMEOUT_MS).toBeGreaterThanOrEqual(300_000);
  });

  it("force-settles a timed-out managed Hermes probe and kills its TERM-ignoring process tree", async () => {
    const hermesPath = join(tempRoot, "fake-hermes-hung-managed-probe");
    const llmConfigPath = join(tempRoot, "llm.config.json");
    const runtimeHome = join(tempRoot, "hermes-home");
    const parentPidPath = join(tempRoot, "hung-hermes-parent.pid");
    const descendantPidPath = join(tempRoot, "hung-hermes-descendant.pid");
    const previousHermesCommand = process.env.OYSTERWORKFLOW_HERMES_COMMAND;
    const observedPids: number[] = [];
    await writeFile(
      llmConfigPath,
      `${JSON.stringify({
        provider: "test",
        baseUrl: "https://example.test/v1",
        wireApi: "responses",
        model: "gpt-test",
        apiKey: null,
      })}\n`,
      "utf8",
    );
    await writeFile(
      hermesPath,
      `#!/bin/sh
echo "$$" > "${parentPidPath}"
trap '' TERM
(
  trap '' TERM
  while true; do
    sleep 1
  done
) &
echo "$!" > "${descendantPidPath}"
wait
`,
      "utf8",
    );
    await chmod(hermesPath, 0o755);
    delete process.env.OYSTERWORKFLOW_HERMES_COMMAND;

    try {
      const preAbortedProbe = new AbortController();
      preAbortedProbe.abort();
      await expect(
        probeHermesStatus(
          {
            label: "managed Hermes pre-aborted test",
            commandPath: hermesPath,
            llmConfigPath,
            runtimeHome,
          },
          { signal: preAbortedProbe.signal },
        ),
      ).resolves.toMatchObject({
        available: false,
        lastError: expect.stringContaining("Hermes command was cancelled"),
      });
      await expect(access(parentPidPath)).rejects.toThrow();

      const startedAt = Date.now();
      const status = await probeHermesStatus(
        {
          label: "managed Hermes timeout test",
          commandPath: hermesPath,
          llmConfigPath,
          runtimeHome,
        },
        {
          // Full-suite parallelism can delay the shell before it writes the PID
          // markers. Keep the timeout short relative to production, but long
          // enough that this test still exercises process-tree termination.
          statusTimeoutMs: 3_000,
          terminationGraceMs: 50,
          forceSettleMs: 50,
        },
      );
      expect(Date.now() - startedAt).toBeLessThan(6_000);
      expect(status).toMatchObject({
        available: false,
        lastError: expect.stringContaining(
          "Hermes command timed out after 3000ms",
        ),
      });

      observedPids.push(
        Number((await readFile(parentPidPath, "utf8")).trim()),
        Number((await readFile(descendantPidPath, "utf8")).trim()),
      );
      for (const pid of observedPids) {
        await expect(waitForProcessExit(pid)).resolves.toBeUndefined();
      }
    } finally {
      for (const pid of observedPids) {
        if (await isProcessAlive(pid)) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // The bounded runner may have completed cleanup between checks.
          }
        }
      }
      if (previousHermesCommand === undefined) {
        delete process.env.OYSTERWORKFLOW_HERMES_COMMAND;
      } else {
        process.env.OYSTERWORKFLOW_HERMES_COMMAND = previousHermesCommand;
      }
    }
  });

  it("does not treat a not-running profile as healthy because another profile is online", () => {
    expect(
      hermesGatewayStatusIsRunning(`
✗ Gateway is not running

Other profiles:
  ✓ default — PID 46943
`),
    ).toBe(false);
    expect(hermesGatewayStatusIsRunning("✓ Gateway is running (PID 123)")).toBe(
      true,
    );
    expect(
      hermesGatewayStatusIsRunning(
        "✓ Gateway is supervised by launchd (PID 4390)",
      ),
    ).toBe(true);
  });

  it("syncs the LLM config and reloads an already-running channel gateway", async () => {
    const hermesPath = join(tempRoot, "fake-hermes-gateway-sync");
    const argsPath = join(tempRoot, "gateway-sync-args.txt");
    const profilesRoot = join(tempRoot, "profiles");
    const llmConfigPath = join(tempRoot, "llm.config.json");
    await mkdir(join(profilesRoot, "ow-sales"), { recursive: true });
    await writeFile(
      join(profilesRoot, "ow-sales", "config.yaml"),
      "onboarding:\n  seen: true\n",
      "utf8",
    );
    await writeFile(
      llmConfigPath,
      `${JSON.stringify({
        provider: "codex-local",
        baseUrl: "http://127.0.0.1:18080/v1",
        wireApi: "responses",
        model: "gpt-5.5",
      })}\n`,
      "utf8",
    );
    await writeFile(
      hermesPath,
      `#!/bin/sh
printf '%s\n' "$*" >> "${argsPath}"
if echo "$*" | grep -q "gateway status"; then
  echo 'Gateway is running (PID 123)'
  exit 0
fi
if echo "$*" | grep -q "gateway restart"; then
  echo 'Gateway restarted'
  exit 0
fi
exit 1
`,
      "utf8",
    );
    await chmod(hermesPath, 0o755);

    await ensureHermesGatewayRunning({
      workerAgentReference: "hermes-profile:ow-sales",
      configSource: {
        label: "test",
        commandPath: hermesPath,
        llmConfigPath,
        profilesRoot,
      },
    });

    const config = await readFile(
      join(profilesRoot, "ow-sales", "config.yaml"),
      "utf8",
    );
    expect(config).toContain('provider: "custom:oysterworkflow"');
    expect(config).toContain('base_url: "http://127.0.0.1:18080/v1"');
    expect(config).not.toContain("key_env:");
    await expect(readFile(argsPath, "utf8")).resolves.toContain(
      "gateway restart",
    );
  });

  it("reports an outdated QR setup helper instead of leaving setup loading", async () => {
    const hermesPath = join(tempRoot, "fake-hermes-old-channel-setup");
    const runtimeHome = join(tempRoot, "hermes-home");
    await writeFile(
      hermesPath,
      `#!/bin/sh
echo "hermes gateway: error: argument gateway_command: invalid choice: 'channel-setup'" >&2
exit 2
`,
      "utf8",
    );
    await chmod(hermesPath, 0o755);

    await expect(
      beginHermesGatewayChannelSetup({
        setupId: "setup-outdated-runtime",
        workerAgentReference: "hermes-profile:ow-test-worker",
        platform: "weixin",
        configSource: {
          label: "test",
          llmConfigPath: join(tempRoot, "llm.config.json"),
          commandPath: hermesPath,
          runtimeHome,
          profilesRoot: join(runtimeHome, "profiles"),
        },
      }),
    ).rejects.toThrow(
      "The installed AI worker runtime is out of date and cannot start QR setup.",
    );

    const logPath = join(
      runtimeHome,
      "profiles",
      "ow-test-worker",
      "gateway-setups",
      "setup-outdated-runtime.log",
    );
    await expect(readFile(logPath, "utf8")).resolves.toContain(
      "invalid choice: 'channel-setup'",
    );
    expect((await stat(logPath)).mode & 0o777).toBe(0o600);
  });

  it("force-stops a Hermes worker turn that ignores SIGTERM", async () => {
    const hermesPath = join(tempRoot, "fake-hermes-ignore-term");
    const llmConfigPath = join(tempRoot, "llm.config.json");
    const codexEnvPath = join(tempRoot, ".env");
    await writeFile(
      llmConfigPath,
      `${JSON.stringify({
        provider: "test",
        baseUrl: "https://example.test/v1",
        wireApi: "responses",
        model: "gpt-test",
        apiKey: "${OPENAI_API_KEY}",
        apiKeyEnv: "OPENAI_API_KEY",
      })}\n`,
      "utf8",
    );
    await writeFile(codexEnvPath, "OPENAI_API_KEY=test-key\n", "utf8");
    await writeFile(
      hermesPath,
      `#!/bin/sh
if [ "$1" = "chat" ]; then
  echo "Session: 20260627032600ab"
  echo "OYSTERWORKFLOW_WORKER_READY"
  trap '' TERM
  while true; do sleep 1; done
fi
echo "unexpected fake hermes command: $*" >&2
exit 1
`,
      "utf8",
    );
    await chmod(hermesPath, 0o755);

    const handle = await startHermesWorkerTurn({
      cwd: tempRoot,
      prompt: "start",
      configSource: {
        label: "test",
        commandPath: hermesPath,
        llmConfigPath,
        codexEnvPath,
        runtimeHome: join(tempRoot, "hermes-home"),
      },
    });
    await expect(handle.ready).resolves.toMatchObject({ ok: true });
    expect(handle.pid).toEqual(expect.any(Number));

    expect(handle.stop()).toBe(true);

    await expect(waitForProcessExit(handle.pid!)).resolves.toBeUndefined();
  }, 5_000);

  it("does not mark a worker turn ready from error stdout", async () => {
    const hermesPath = join(tempRoot, "fake-hermes-error-stdout");
    const llmConfigPath = join(tempRoot, "llm.config.json");
    const codexEnvPath = join(tempRoot, ".env");
    const errorMarker = join(tempRoot, "error-emitted");
    await writeFile(
      llmConfigPath,
      `${JSON.stringify({
        provider: "test",
        baseUrl: "https://example.test/v1",
        wireApi: "responses",
        model: "gpt-test",
        apiKey: "${OPENAI_API_KEY}",
        apiKeyEnv: "OPENAI_API_KEY",
      })}\n`,
      "utf8",
    );
    await writeFile(codexEnvPath, "OPENAI_API_KEY=test-key\n", "utf8");
    await writeFile(
      hermesPath,
      `#!/bin/sh
if [ "$1" = "chat" ]; then
  echo "API call failed after 3 retries: Connection error."
  touch "${errorMarker}"
  sleep 0.2
  exit 1
fi
echo "unexpected fake hermes command: $*" >&2
exit 1
`,
      "utf8",
    );
    await chmod(hermesPath, 0o755);

    const handle = await startHermesWorkerTurn({
      cwd: tempRoot,
      prompt: "start",
      configSource: {
        label: "test",
        commandPath: hermesPath,
        llmConfigPath,
        codexEnvPath,
        runtimeHome: join(tempRoot, "hermes-home"),
      },
    });

    await expect(waitForPath(errorMarker)).resolves.toBeUndefined();
    await expect(
      Promise.race([
        handle.ready.then(() => "resolved"),
        new Promise<"pending">((resolve) =>
          setTimeout(() => resolve("pending"), 50),
        ),
      ]),
    ).resolves.toBe("pending");
    await expect(handle.ready).resolves.toMatchObject({
      ok: false,
      errorMessage: "API call failed after 3 retries: Connection error.",
    });
  });

  it("keeps only a bounded tail of large Hermes worker output", async () => {
    const hermesPath = join(tempRoot, "fake-hermes-large-output");
    const llmConfigPath = join(tempRoot, "llm.config.json");
    const codexEnvPath = join(tempRoot, ".env");
    await writeFile(
      llmConfigPath,
      `${JSON.stringify({
        provider: "test",
        baseUrl: "https://example.test/v1",
        wireApi: "responses",
        model: "gpt-test",
        apiKey: "${OPENAI_API_KEY}",
        apiKeyEnv: "OPENAI_API_KEY",
      })}\n`,
      "utf8",
    );
    await writeFile(codexEnvPath, "OPENAI_API_KEY=test-key\n", "utf8");
    await writeFile(
      hermesPath,
      `#!/usr/bin/env node
if (process.argv[2] === "chat") {
  process.stdout.write("x".repeat(3 * 1024 * 1024));
  process.stdout.write("\\nSession: 20260717010101aa\\n");
  process.stdout.write("OYSTERWORKFLOW_WORKER_READY\\n");
} else {
  process.exitCode = 1;
}
`,
      "utf8",
    );
    await chmod(hermesPath, 0o755);

    const handle = await startHermesWorkerTurn({
      cwd: tempRoot,
      prompt: "start",
      configSource: {
        label: "test",
        commandPath: hermesPath,
        llmConfigPath,
        codexEnvPath,
        runtimeHome: join(tempRoot, "hermes-home"),
      },
    });

    const ready = await handle.ready;
    expect(ready.sessionId).toBe("20260717010101aa");
    const result = await handle.completion;
    expect(result.output).toContain("OYSTERWORKFLOW_WORKER_READY");
    expect(result.sessionId).toBe("20260717010101aa");
    expect(Buffer.byteLength(result.output, "utf8")).toBeLessThanOrEqual(
      2 * 1024 * 1024 + 1,
    );
  });

  it("carries the latest provider health into the completed turn result", async () => {
    const hermesPath = join(tempRoot, "fake-hermes-provider-health-result");
    const llmConfigPath = join(tempRoot, "llm.config.json");
    const codexEnvPath = join(tempRoot, ".env");
    await writeFile(
      llmConfigPath,
      `${JSON.stringify({
        provider: "test",
        baseUrl: "https://example.test/v1",
        wireApi: "responses",
        model: "gpt-test",
        apiKey: "${OPENAI_API_KEY}",
        apiKeyEnv: "OPENAI_API_KEY",
      })}\n`,
      "utf8",
    );
    await writeFile(codexEnvPath, "OPENAI_API_KEY=test-key\n", "utf8");
    await writeFile(
      hermesPath,
      `#!/bin/sh
if [ "$1" = "chat" ]; then
  echo "OYSTERWORKFLOW_WORKER_READY"
  printf '%s' 'OYSTERWORKFLOW_PROVIDER_STATUS {"status":"degraded","kind":"llm_timeout",' >&2
  printf '%s\n' '"recoverability":"retryable","message":"Provider timed out.","retryable":true}' >&2
  echo "Workflow completed after retry."
  exit 0
fi
echo "unexpected fake hermes command: $*" >&2
exit 1
`,
      "utf8",
    );
    await chmod(hermesPath, 0o755);

    const handle = await startHermesWorkerTurn({
      cwd: tempRoot,
      prompt: "start",
      configSource: {
        label: "test",
        commandPath: hermesPath,
        llmConfigPath,
        codexEnvPath,
        runtimeHome: join(tempRoot, "hermes-home"),
      },
    });

    await expect(handle.completion).resolves.toMatchObject({
      ok: true,
      providerHealth: {
        status: "degraded",
        kind: "llm_timeout",
        recoverability: "retryable",
        message: "Provider timed out.",
        retryable: true,
      },
    });
  });

  it("reads appended Hermes progress from a byte offset after Unicode log text", async () => {
    const hermesPath = join(tempRoot, "fake-hermes-progress-offset");
    const llmConfigPath = join(tempRoot, "llm.config.json");
    const codexEnvPath = join(tempRoot, ".env");
    const profilesRoot = join(tempRoot, "profiles");
    const profileName = "ow-progress-offset";
    const logPath = join(profilesRoot, profileName, "logs", "agent.log");
    await mkdir(join(profilesRoot, profileName, "logs"), { recursive: true });
    await writeFile(logPath, "中\n", "utf8");
    await writeFile(
      llmConfigPath,
      `${JSON.stringify({
        provider: "test",
        baseUrl: "https://example.test/v1",
        wireApi: "responses",
        model: "gpt-test",
        apiKey: "${OPENAI_API_KEY}",
        apiKeyEnv: "OPENAI_API_KEY",
      })}\n`,
      "utf8",
    );
    await writeFile(codexEnvPath, "OPENAI_API_KEY=test-key\n", "utf8");
    await writeFile(
      hermesPath,
      `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
appendFileSync(${JSON.stringify(logPath)}, "agent.tool_executor: tool browser completed (0.1s)\\n", "utf8");
process.stdout.write("Session: 20260717020202bb\\n");
process.stdout.write("OYSTERWORKFLOW_WORKER_READY\\n");
`,
      "utf8",
    );
    await chmod(hermesPath, 0o755);
    const progress: Array<{ status: string; body: string }> = [];

    const handle = await startHermesWorkerTurn({
      cwd: tempRoot,
      prompt: "start",
      workerAgentReference: `hermes-profile:${profileName}`,
      onProgress: (event) => progress.push(event),
      configSource: {
        label: "test",
        commandPath: hermesPath,
        llmConfigPath,
        codexEnvPath,
        runtimeHome: join(tempRoot, "hermes-home"),
        profilesRoot,
      },
    });
    await handle.completion;

    expect(progress).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "Tool action completed",
          body: expect.stringContaining("Used browser"),
        }),
      ]),
    );
  });

  it("stops progress polling without draining an interval backlog", async () => {
    vi.useFakeTimers();
    const logPath = join(tempRoot, "single-flight-progress.log");
    await writeFile(logPath, "", "utf8");
    const progress: Array<{ status: string; body: string }> = [];
    try {
      const stop = await startHermesProgressLogWatcher({
        logPath,
        onProgress: (event) => progress.push(event),
      });
      await appendFile(
        logPath,
        "agent.tool_executor: tool browser completed (0.1s)\n",
        "utf8",
      );

      vi.advanceTimersByTime(750 * 5_000);
      const stopping = stop();
      await vi.runAllTimersAsync();
      await stopping;

      expect(progress).toEqual([
        expect.objectContaining({
          status: "Tool action completed",
          body: expect.stringContaining("Used browser"),
        }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  }, 3_000);

  it("stops lingering OysterWorkflow Hermes worker processes by profile", async () => {
    const hermesPath = join(tempRoot, "fake-hermes-lingering-profile");
    const startedMarker = join(tempRoot, "lingering-started");
    const stoppedMarker = join(tempRoot, "lingering-stopped");
    await writeFile(
      hermesPath,
      `#!/bin/sh
touch "${startedMarker}"
trap 'touch "${stoppedMarker}"; exit 143' TERM INT
while true; do sleep 1; done
`,
      "utf8",
    );
    await chmod(hermesPath, 0o755);

    const child = spawn(
      hermesPath,
      [
        "-p",
        "ow-test-worker",
        "chat",
        "--source",
        "oysterworkflow-worker",
        "--query",
        "stay alive",
      ],
      {
        detached: true,
        stdio: "ignore",
      },
    );
    child.unref();
    await expect(waitForPath(startedMarker)).resolves.toBeUndefined();

    await expect(
      stopHermesWorkerProcesses({
        workerAgentReference: "hermes-profile:ow-test-worker",
      }),
    ).resolves.toBe(true);

    await expect(waitForPath(stoppedMarker)).resolves.toBeUndefined();
    await expect(waitForProcessExit(child.pid!)).resolves.toBeUndefined();
  }, 5_000);

  it("returns the final assistant message from a resumed profile turn", async () => {
    const hermesPath = join(tempRoot, "fake-hermes-resumed-profile");
    const llmConfigPath = join(tempRoot, "llm.config.json");
    const codexEnvPath = join(tempRoot, ".env");
    const profilesRoot = join(tempRoot, "profiles");
    const profileName = "ow-test-worker";
    const sessionId = "20260705_213829_2f0f17";
    const assistantMessage = [
      "Progress: reviewed the visible YC Co-Founder Matching profile.",
      "Next screen action: keep the profile open and wait for review.",
      'OYSTERWORKFLOW_SESSION_STATUS {"status":"blocked","message":"Needs user review","user_action":"Review the prepared notes"}',
    ].join("\n");
    const exportPayload = JSON.stringify({
      id: sessionId,
      source: "oysterworkflow-worker",
      messages: [
        {
          id: 101,
          session_id: sessionId,
          role: "user",
          content: "continue",
          timestamp: 1783319200,
          active: 1,
        },
        {
          id: 102,
          session_id: sessionId,
          role: "assistant",
          content: assistantMessage,
          timestamp: 1783319214,
          active: 1,
        },
      ],
    });
    await writeFile(
      llmConfigPath,
      `${JSON.stringify({
        provider: "test",
        baseUrl: "https://example.test/v1",
        wireApi: "responses",
        model: "gpt-test",
        apiKey: "${OPENAI_API_KEY}",
        apiKeyEnv: "OPENAI_API_KEY",
      })}\n`,
      "utf8",
    );
    await writeFile(codexEnvPath, "OPENAI_API_KEY=test-key\n", "utf8");
    await writeFile(
      hermesPath,
      `#!/bin/sh
if [ "$1" = "-p" ] && [ "$3" = "chat" ]; then
  echo "↻ Resumed session ${sessionId} (1 user message, 5 total messages)"
  exit 0
fi
if [ "$1" = "-p" ] && [ "$3" = "sessions" ] && [ "$4" = "export" ]; then
  if [ "$5" != "-" ] || [ "$6" != "--session-id" ] || [ "$7" != "${sessionId}" ]; then
    echo "unexpected sessions export args: $*" >&2
    exit 1
  fi
  cat <<'JSON'
${exportPayload}
JSON
  exit 0
fi
echo "unexpected fake hermes command: $*" >&2
exit 1
`,
      "utf8",
    );
    await chmod(hermesPath, 0o755);

    const handle = await startHermesWorkerTurn({
      cwd: tempRoot,
      prompt: "continue",
      workerAgentReference: `hermes-profile:${profileName}`,
      resumeSessionId: sessionId,
      configSource: {
        label: "test",
        commandPath: hermesPath,
        llmConfigPath,
        codexEnvPath,
        runtimeHome: join(tempRoot, "hermes-home"),
        profilesRoot,
      },
    });

    await expect(handle.completion).resolves.toMatchObject({
      ok: true,
      sessionId,
      sessionStatus: "blocked",
      sessionStatusMessage: "Needs user review",
      userAction: "Review the prepared notes",
      output: assistantMessage,
      errorMessage: null,
    });
  });

  it("injects the Oyster BrowserAct launcher into Hermes worker turns", async () => {
    const hermesPath = join(tempRoot, "fake-hermes-browser-env");
    const llmConfigPath = join(tempRoot, "llm.config.json");
    const codexEnvPath = join(tempRoot, ".env");
    const launcherRecordPath = join(tempRoot, "launcher-path.txt");
    const providerRecordPath = join(tempRoot, "provider.txt");
    const logDirRecordPath = join(tempRoot, "browser-log-dir.txt");
    const runIdRecordPath = join(tempRoot, "browser-run-id.txt");
    const sessionRecordPath = join(tempRoot, "browser-session.txt");
    await writeFile(
      llmConfigPath,
      `${JSON.stringify({
        provider: "test",
        baseUrl: "https://example.test/v1",
        wireApi: "responses",
        model: "gpt-test",
        apiKey: "${OPENAI_API_KEY}",
        apiKeyEnv: "OPENAI_API_KEY",
      })}\n`,
      "utf8",
    );
    await writeFile(codexEnvPath, "OPENAI_API_KEY=test-key\n", "utf8");
    await writeFile(
      hermesPath,
      `#!/bin/sh
if [ "$1" = "chat" ]; then
  echo "$OYSTER_BROWSER_CLI" > "${launcherRecordPath}"
  echo "$OYSTER_BROWSER_PROVIDER" > "${providerRecordPath}"
  echo "$OYSTER_BROWSER_LOG_DIR" > "${logDirRecordPath}"
  echo "$OYSTER_WORKFLOW_RUN_ID" > "${runIdRecordPath}"
  echo "$OYSTER_BROWSER_SESSION" > "${sessionRecordPath}"
  if [ ! -x "$OYSTER_BROWSER_CLI" ]; then
    echo "missing executable OYSTER_BROWSER_CLI" >&2
    exit 2
  fi
  echo "Session: 20260706010101aa"
  echo "OYSTERWORKFLOW_WORKER_READY"
  exit 0
fi
echo "unexpected fake hermes command: $*" >&2
exit 1
`,
      "utf8",
    );
    await chmod(hermesPath, 0o755);

    const handle = await startHermesWorkerTurn({
      cwd: tempRoot,
      prompt: "start",
      runId: "run-1783550003038",
      configSource: {
        label: "test",
        commandPath: hermesPath,
        llmConfigPath,
        codexEnvPath,
        runtimeHome: join(tempRoot, "hermes-home"),
      },
    });

    await expect(handle.ready).resolves.toMatchObject({
      ok: true,
      sessionId: "20260706010101aa",
    });
    await expect(readFile(launcherRecordPath, "utf8")).resolves.toContain(
      "/bin/oyster-browser",
    );
    await expect(readFile(providerRecordPath, "utf8")).resolves.toBe(
      "browseract.chrome-direct\n",
    );
    await expect(readFile(logDirRecordPath, "utf8")).resolves.toContain(
      "/logs/browser-act",
    );
    await expect(readFile(runIdRecordPath, "utf8")).resolves.toBe(
      "run-1783550003038\n",
    );
    await expect(readFile(sessionRecordPath, "utf8")).resolves.toBe(
      "oyster-run-1783550003038\n",
    );
  });

  it("injects the unrestricted Composio hosted MCP session into a worker profile", async () => {
    const hermesPath = join(tempRoot, "fake-hermes-composio-mcp");
    const llmConfigPath = join(tempRoot, "llm.config.json");
    const codexEnvPath = join(tempRoot, ".env");
    const profilesRoot = join(tempRoot, "profiles");
    const profileName = "ow-composio-worker";
    await writeFile(
      llmConfigPath,
      `${JSON.stringify({
        provider: "test",
        baseUrl: "https://example.test/v1",
        wireApi: "responses",
        model: "gpt-test",
        apiKey: "${OPENAI_API_KEY}",
        apiKeyEnv: "OPENAI_API_KEY",
      })}\n`,
      "utf8",
    );
    await writeFile(codexEnvPath, "OPENAI_API_KEY=test-key\n", "utf8");
    await writeFile(
      hermesPath,
      `#!/bin/sh
if [ "$1" = "-p" ] && [ "$3" = "chat" ]; then
  echo "Session: 20260709010101aa"
  echo "OYSTERWORKFLOW_WORKER_READY"
  exit 0
fi
echo "unexpected fake hermes command: $*" >&2
exit 1
`,
      "utf8",
    );
    await chmod(hermesPath, 0o755);

    const handle = await startHermesWorkerTurn({
      cwd: tempRoot,
      prompt: "start",
      integrationUserId: "oysterworkflow:workspace:account",
      workerAgentReference: `hermes-profile:${profileName}`,
      configSource: {
        label: "test",
        commandPath: hermesPath,
        llmConfigPath,
        codexEnvPath,
        runtimeHome: join(tempRoot, "hermes-home"),
        profilesRoot,
        resolveMcpServers: async ({ integrationUserId }) => {
          expect(integrationUserId).toBe("oysterworkflow:workspace:account");
          return [
            {
              name: "composio",
              url: "https://mcp.example/session-full",
              headers: { "x-api-key": "ak_remote_secret" },
              timeoutSeconds: 120,
            },
          ];
        },
      },
    });

    await expect(handle.ready).resolves.toMatchObject({ ok: true });
    const configPath = join(profilesRoot, profileName, "config.yaml");
    const config = await readFile(configPath, "utf8");
    expect(config).toContain("mcp_servers:");
    expect(config).toContain('"composio":');
    expect(config).toContain('url: "https://mcp.example/session-full"');
    expect(config).toContain('"x-api-key": "ak_remote_secret"');
    expect(config).toContain("enabled: true");
    expect(config).toContain("timeout: 120");
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
  });

  it("installs and enables the OysterWorkflow provider status observer plugin", async () => {
    const hermesPath = join(tempRoot, "fake-hermes-provider-observer");
    const llmConfigPath = join(tempRoot, "llm.config.json");
    const codexEnvPath = join(tempRoot, ".env");
    const runtimeHome = join(tempRoot, "hermes-home");
    await writeFile(
      llmConfigPath,
      `${JSON.stringify({
        provider: "test",
        baseUrl: "https://example.test/v1",
        wireApi: "responses",
        model: "gpt-test",
        apiKey: "${OPENAI_API_KEY}",
        apiKeyEnv: "OPENAI_API_KEY",
      })}\n`,
      "utf8",
    );
    await writeFile(codexEnvPath, "OPENAI_API_KEY=test-key\n", "utf8");
    await writeFile(
      hermesPath,
      `#!/bin/sh
if [ "$1" = "chat" ]; then
  echo "Session: 20260707010101aa"
  echo "OYSTERWORKFLOW_WORKER_READY"
  exit 0
fi
echo "unexpected fake hermes command: $*" >&2
exit 1
`,
      "utf8",
    );
    await chmod(hermesPath, 0o755);

    const handle = await startHermesWorkerTurn({
      cwd: tempRoot,
      prompt: "start",
      configSource: {
        label: "test",
        commandPath: hermesPath,
        llmConfigPath,
        codexEnvPath,
        runtimeHome,
      },
    });

    await expect(handle.ready).resolves.toMatchObject({ ok: true });
    await expect(
      readFile(join(runtimeHome, "config.yaml"), "utf8"),
    ).resolves.toContain("  - oysterworkflow_status");
    await expect(
      readFile(
        join(runtimeHome, "plugins", "oysterworkflow_status", "plugin.yaml"),
        "utf8",
      ),
    ).resolves.toContain("api_request_error");
    await expect(
      readFile(
        join(runtimeHome, "plugins", "oysterworkflow_status", "__init__.py"),
        "utf8",
      ),
    ).resolves.toContain("OYSTERWORKFLOW_PROVIDER_STATUS");
  });
});

async function waitForProcessExit(pid: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 2_000) {
    if (!(await isProcessAlive(pid))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for process ${pid} to exit`);
}

async function waitForPath(path: string): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 2_000) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function isProcessAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    try {
      await access(`/proc/${pid}`);
      return true;
    } catch {
      return false;
    }
  }
}
