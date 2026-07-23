#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  applyRunnerRequestOptions,
  loadRunnerRequestFile,
} from "./lib/codex-runner-request.mjs";
import { buildWatchdogFallbackScan as buildWatchdogFallbackScanModule } from "./lib/codex-watchdog-fallback.mjs";

const PROJECT_ROOT = path.resolve(
  fileURLToPath(new URL("..", import.meta.url)),
);
const WORKSPACE_ALIAS = path.join(os.homedir(), "Documents", "New_project");
const CODEX_HOME = path.join(os.homedir(), ".codex");
const DEFAULT_SOCKET_PATH = path.join(
  CODEX_HOME,
  "app-server-control",
  "app-server-control.sock",
);
const DEFAULT_TIMEOUT_MS = 180_000;
const COMMAND_TIMEOUT_MS = 30_000;
const WATCHDOG_DEFAULT_LIVE_WINDOW_MS = 30 * 60 * 1_000;
const WATCHDOG_DEFAULT_DELAY_MS = 10_000;
const WATCHDOG_DEFAULT_MAX_ATTEMPTS = 6;
const WATCHDOG_DEFAULT_MAX_SESSIONS = 5;
const WATCHDOG_DEFAULT_PROMPT =
  "Continue from the last unfinished task. Do not repeat completed work.";
const WATCHDOG_DEFAULT_RESUME_TIMEOUT_MS = 60_000;
const PROBE_PAGE_TITLE = "Oyster Desktop Remote Browser Probe";
const PROBE_TOKEN = "OYSTER_DESKTOP_REMOTE_BROWSER_TOKEN";
const FIXTURE_SKILL_NAME = "oyster-desktop-remote-probe";

/**
 * EN: Parses CLI flags for the Desktop app-server probe.
 * @param {string[]} argv CLI arguments.
 * @returns {Promise<object>} Parsed options.
 */
async function parseArgs(argv) {
  const options = {
    codexBin: "codex",
    approvalPolicy: "never",
    approvalsReviewer: null,
    acceptedComputerUseApps: [],
    browserSurface: "iab",
    computerUseTask: null,
    dryRun: false,
    help: false,
    includeBrowser: true,
    includeComputerUse: false,
    noStartRemoteControl: false,
    outDir: null,
    prepareTextEditTarget: false,
    remoteEnvironmentScope: "none",
    requestJsonPaths: [],
    serveProbePage: null,
    skillPath: null,
    socketPath: DEFAULT_SOCKET_PATH,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    threadEphemeral: true,
    threadTitle: null,
    watchdogDelayMs: WATCHDOG_DEFAULT_DELAY_MS,
    watchdogAllowRealResume: false,
    watchdogCodexHome: CODEX_HOME,
    watchdogCodexBin: null,
    watchdogLiveWindowMs: WATCHDOG_DEFAULT_LIVE_WINDOW_MS,
    watchdogMaxAttempts: WATCHDOG_DEFAULT_MAX_ATTEMPTS,
    watchdogMaxSessions: WATCHDOG_DEFAULT_MAX_SESSIONS,
    watchdogPrompt: WATCHDOG_DEFAULT_PROMPT,
    watchdogResumeMode: "dry-run",
    watchdogResumeTimeoutMs: WATCHDOG_DEFAULT_RESUME_TIMEOUT_MS,
    watchdogScan: true,
    watchdogUseTtyWrapper: true,
    workspaceRoot: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--request-json") {
      continue;
    }
    const requestPath = readRequiredValue(argv, (index += 1), "--request-json");
    const requestOptions = await loadRunnerRequestFile(requestPath);
    options.requestJsonPaths.push(path.resolve(requestPath));
    applyRunnerRequestOptions(options, requestOptions);
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--codex-bin":
        options.codexBin = readRequiredValue(argv, (index += 1), arg);
        break;
      case "--approval-policy":
        options.approvalPolicy = parseApprovalPolicy(
          readRequiredValue(argv, (index += 1), arg),
          arg,
        );
        break;
      case "--approvals-reviewer":
        options.approvalsReviewer = parseApprovalsReviewer(
          readRequiredValue(argv, (index += 1), arg),
          arg,
        );
        break;
      case "--accept-computer-use-app":
        options.acceptedComputerUseApps.push(
          readRequiredValue(argv, (index += 1), arg),
        );
        break;
      case "--accept-textedit-computer-use":
        options.acceptedComputerUseApps.push("TextEdit");
        break;
      case "--browser-surface":
        options.browserSurface = parseBrowserSurface(
          readRequiredValue(argv, (index += 1), arg),
          arg,
        );
        break;
      case "--safe-auto-review":
        options.approvalPolicy = "on-request";
        options.approvalsReviewer = "auto_review";
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--include-computer-use":
        options.includeComputerUse = true;
        break;
      case "--include-browser":
        options.includeBrowser = true;
        break;
      case "--prepare-textedit-target":
        options.prepareTextEditTarget = true;
        break;
      case "--no-browser":
        options.includeBrowser = false;
        break;
      case "--no-remote-environment":
        options.remoteEnvironmentScope = "none";
        break;
      case "--use-remote-environment":
        options.remoteEnvironmentScope = "turn";
        break;
      case "--remote-environment-scope":
        options.remoteEnvironmentScope = parseRemoteEnvironmentScope(
          readRequiredValue(argv, (index += 1), arg),
          arg,
        );
        break;
      case "--request-json":
        index += 1;
        break;
      case "--serve-probe-page":
        options.serveProbePage = true;
        break;
      case "--no-serve-probe-page":
        options.serveProbePage = false;
        break;
      case "--no-start-remote-control":
        options.noStartRemoteControl = true;
        break;
      case "--no-watchdog-scan":
        options.watchdogScan = false;
        break;
      case "--watchdog-scan":
        options.watchdogScan = true;
        break;
      case "--watchdog-allow-real-resume":
        options.watchdogAllowRealResume = true;
        break;
      case "--watchdog-codex-home":
        options.watchdogCodexHome = path.resolve(
          readRequiredValue(argv, (index += 1), arg),
        );
        break;
      case "--watchdog-codex-bin":
        options.watchdogCodexBin = readRequiredValue(argv, (index += 1), arg);
        break;
      case "--watchdog-execute-resume":
        options.watchdogResumeMode = "execute";
        break;
      case "--watchdog-no-tty-wrapper":
        options.watchdogUseTtyWrapper = false;
        break;
      case "--out-dir":
        options.outDir = readRequiredValue(argv, (index += 1), arg);
        break;
      case "--socket-path":
        options.socketPath = readRequiredValue(argv, (index += 1), arg);
        break;
      case "--skill-path":
        options.skillPath = path.resolve(
          readRequiredValue(argv, (index += 1), arg),
        );
        break;
      case "--timeout-ms":
        options.timeoutMs = parsePositiveInteger(
          readRequiredValue(argv, (index += 1), arg),
          arg,
        );
        break;
      case "--visible-thread":
        options.threadEphemeral = false;
        break;
      case "--ephemeral-thread":
        options.threadEphemeral = true;
        break;
      case "--thread-title":
        options.threadTitle = readRequiredValue(argv, (index += 1), arg);
        break;
      case "--workspace-root":
        options.workspaceRoot = path.resolve(
          readRequiredValue(argv, (index += 1), arg),
        );
        break;
      case "--watchdog-delay-seconds":
        options.watchdogDelayMs = parsePositiveDurationMs(
          readRequiredValue(argv, (index += 1), arg),
          1_000,
          arg,
        );
        break;
      case "--watchdog-live-window-minutes":
        options.watchdogLiveWindowMs = parsePositiveDurationMs(
          readRequiredValue(argv, (index += 1), arg),
          60_000,
          arg,
        );
        break;
      case "--watchdog-max-attempts":
        options.watchdogMaxAttempts = parsePositiveInteger(
          readRequiredValue(argv, (index += 1), arg),
          arg,
        );
        break;
      case "--watchdog-max-sessions":
        options.watchdogMaxSessions = parsePositiveInteger(
          readRequiredValue(argv, (index += 1), arg),
          arg,
        );
        break;
      case "--watchdog-prompt":
        options.watchdogPrompt = readRequiredValue(argv, (index += 1), arg);
        break;
      case "--watchdog-resume-mode":
        options.watchdogResumeMode = parseWatchdogResumeMode(
          readRequiredValue(argv, (index += 1), arg),
          arg,
        );
        break;
      case "--watchdog-resume-timeout-ms":
        options.watchdogResumeTimeoutMs = parsePositiveInteger(
          readRequiredValue(argv, (index += 1), arg),
          arg,
        );
        break;
      default:
        throw new Error(`Unsupported argument: ${arg}`);
    }
  }

  if (!options.includeBrowser && !options.includeComputerUse) {
    throw new Error("At least one probe surface must be enabled.");
  }

  return options;
}

/**
 * EN: Prints CLI usage.
 * @returns {void}
 */
function printHelp() {
  process.stdout.write(`Usage: node scripts/codex-desktop-probe.mjs [options]

Validates the Desktop Codex control path:
OysterWorkflow skill -> runner script -> Codex Desktop app-server remote-control -> Browser / Computer Use.

Options:
  --include-computer-use       Also ask for a read-only Computer Use observation.
  --prepare-textedit-target    Open a local TextEdit token file for Computer Use to read.
  --no-browser                 Skip the Browser smoke task.
  --browser-surface <surface>  Browser surface to request. One of iab, chrome. Defaults to iab.
  --dry-run                    Write artifacts and inspect app-server without starting a turn.
  --out-dir <path>             Output directory under .runs by default.
  --request-json <path>        Load a structured runner request JSON. Repeatable.
  --socket-path <path>         app-server remote-control Unix socket.
  --skill-path <path>          Read this existing skill/harness instead of generating a fixture.
  --codex-bin <path>           Codex executable. Defaults to "codex".
  --approval-policy <policy>   Turn approval policy. One of never, on-request, on-failure, untrusted.
                               Defaults to "never".
  --approvals-reviewer <name>  Optional reviewer. One of user, auto_review, guardian_subagent.
  --safe-auto-review           Shortcut for --approval-policy on-request --approvals-reviewer auto_review.
  --accept-computer-use-app <app>
                               Accept Computer Use MCP elicitation only for this app label. Repeatable.
  --accept-textedit-computer-use
                               Shortcut for --accept-computer-use-app TextEdit.
  --timeout-ms <ms>            Turn timeout. Defaults to ${DEFAULT_TIMEOUT_MS}.
  --visible-thread             Create a non-ephemeral Desktop thread for UI/demo visibility.
  --ephemeral-thread           Create an ephemeral thread. This is the default.
  --thread-title <title>       Optional visible thread name when app-server accepts it.
  --workspace-root <path>      Workspace cwd for thread/turn. Defaults to New_project alias.
  --use-remote-environment     Attach the connected remote-control environment to turn/start only.
  --remote-environment-scope <scope>
                               One of none, turn, thread-turn. Defaults to none.
  --no-remote-environment      Shortcut for --remote-environment-scope none.
  --serve-probe-page           Serve probe-page.html on 127.0.0.1 for browser verification.
  --no-serve-probe-page        Force file:// probe page target.
  --no-start-remote-control    Do not run "codex remote-control start".
  --no-watchdog-scan           Skip read-only Codex session watchdog fallback scan.
  --watchdog-scan              Enable watchdog scan after a request disabled it.
  --watchdog-resume-mode <mode>
                               One of dry-run, execute. Defaults to dry-run.
  --watchdog-execute-resume    Shortcut for --watchdog-resume-mode execute.
  --watchdog-allow-real-resume Required to execute resume against the real ~/.codex home.
  --watchdog-no-tty-wrapper    Execute resume directly instead of through script(1).
  --watchdog-codex-home <path> Codex home to scan for watchdog dry-run. Defaults to ~/.codex.
  --watchdog-codex-bin <path>  Codex binary for watchdog resume. Defaults to --codex-bin.
  --watchdog-live-window-minutes <n>
                               Recent session window for watchdog dry-run. Defaults to 30.
  --watchdog-delay-seconds <n> Error age before a watchdog resume would be eligible. Defaults to 10.
  --watchdog-max-attempts <n>  Max resume attempts per session/error fingerprint. Defaults to 6.
  --watchdog-max-sessions <n>  Max recent sessions to inspect. Defaults to 5.
  --watchdog-prompt <text>     Prompt that a future resume fallback would inject.
  --watchdog-resume-timeout-ms <ms>
                               Timeout for an explicit watchdog resume execution. Defaults to ${WATCHDOG_DEFAULT_RESUME_TIMEOUT_MS}.
  --help, -h                   Show this help.
`);
}

/**
 * EN: Runs the Desktop app-server probe.
 * @returns {Promise<void>}
 */
async function main() {
  const options = await parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const startedAt = new Date();
  const startedAtMonotonicMs = performance.now();
  const workspaceRoot = await resolveWorkspaceRoot(options.workspaceRoot);
  const outDir = await resolveOutputDir(options.outDir, startedAt);
  await mkdir(outDir, { recursive: true });

  const paths = {
    transcript: path.join(outDir, "app-server-transcript.jsonl"),
    prompt: path.join(outDir, "prompt.md"),
    probePage: path.join(outDir, "probe-page.html"),
    fixtureSkill: path.join(outDir, "fixture-skill.json"),
    computerUseTarget: path.join(outDir, "computer-use-target.txt"),
    lastMessage: path.join(outDir, "last-message.md"),
    summary: path.join(outDir, "probe-summary.json"),
    remoteControlStart: path.join(outDir, "remote-control-start.json"),
    watchdogFallback: path.join(outDir, "watchdog-fallback.json"),
  };
  await writeFile(paths.transcript, "", "utf8");

  process.stdout.write(`[codex-desktop-probe] output: ${outDir}\n`);
  process.stdout.write(
    "[codex-desktop-probe] probing local Codex Desktop controls\n",
  );

  const environment = await collectLocalEnvironment(options, paths);
  const skill = await resolveProbeSkill({
    fixturePath: paths.fixtureSkill,
    providedPath: options.skillPath,
  });
  const probePageFileUrl = await writeProbePage(paths.probePage);
  const serveProbePage = shouldServeProbePage(options);
  let probePageServer = null;
  let probePageUrl = probePageFileUrl;
  if (serveProbePage) {
    probePageServer = await startProbePageServer(paths.probePage);
    probePageUrl = probePageServer.url;
  }
  options.serveProbePageEffective = serveProbePage;
  const computerUseTarget = await prepareComputerUseTarget({
    enabled: options.includeComputerUse && options.prepareTextEditTarget,
    filePath: paths.computerUseTarget,
  });

  let appServer = null;
  let appServerError = null;
  let remoteStatus = null;
  let pluginList = null;
  let turnResult = null;
  let finalMessage = "";

  try {
    appServer = new AppServerWebSocketClient({
      acceptedComputerUseApps: options.acceptedComputerUseApps,
      socketPath: options.socketPath,
      transcriptPath: paths.transcript,
    });
    await appServer.connect();
    await appServer.request("initialize", {
      clientInfo: {
        name: "oyster_ai_worker_probe",
        title: "Oyster AI Worker Probe",
        version: "0.2.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    appServer.notify("initialized", {});

    remoteStatus = await appServer.request("remoteControl/status/read");
    pluginList = await appServer.request("plugin/list", {});
    const plugins = flattenPlugins(pluginList);
    const prompt = buildPrompt({
      computerUseTarget,
      computerUseTask: options.computerUseTask,
      browserSurface: options.browserSurface,
      includeBrowser: options.includeBrowser,
      includeComputerUse: options.includeComputerUse,
      plugins,
      probePageUrl,
      skill,
      threadTitle: options.threadTitle,
    });
    await writeFile(paths.prompt, prompt, "utf8");

    if (!options.dryRun) {
      process.stdout.write(
        "[codex-desktop-probe] starting Desktop app-server thread\n",
      );
      turnResult = await runDesktopTurn({
        appServer,
        approvalPolicy: options.approvalPolicy,
        approvalsReviewer: options.approvalsReviewer,
        remoteStatus,
        remoteEnvironmentScope: options.remoteEnvironmentScope,
        prompt,
        threadEphemeral: options.threadEphemeral,
        threadTitle: options.threadTitle,
        timeoutMs: options.timeoutMs,
        workspaceRoot,
      });
      finalMessage = turnResult.finalMessage;
      await writeFile(paths.lastMessage, `${finalMessage}\n`, "utf8");
    } else {
      await writeFile(paths.lastMessage, "", "utf8");
    }

    const summary = buildSummary({
      appServer,
      appServerError,
      environment,
      finalMessage,
      options,
      outDir,
      paths,
      pluginList,
      probePageUrl,
      remoteStatus,
      skill,
      startedAt,
      startedAtMonotonicMs,
      turnResult,
      computerUseTarget,
      workspaceRoot,
    });
    await writeJson(paths.summary, summary);
    process.stdout.write(
      `[codex-desktop-probe] ${summary.status}: ${summary.failureReason ?? "probe passed"}\n`,
    );
    if (summary.status !== "passed" && !options.dryRun) {
      process.exitCode = 1;
    }
  } catch (error) {
    appServerError = error instanceof Error ? error.message : String(error);
    const summary = buildSummary({
      appServer,
      appServerError,
      environment,
      finalMessage,
      options,
      outDir,
      paths,
      pluginList,
      probePageUrl,
      remoteStatus,
      skill,
      startedAt,
      startedAtMonotonicMs,
      turnResult,
      computerUseTarget,
      workspaceRoot,
    });
    await writeJson(paths.summary, summary);
    process.stdout.write(`[codex-desktop-probe] failed: ${appServerError}\n`);
    process.exitCode = 1;
  } finally {
    appServer?.close();
    await closeProbePageServer(probePageServer);
  }
}

/**
 * EN: Starts a Desktop app-server thread and turn.
 * @param {{appServer:AppServerWebSocketClient,approvalPolicy:string,approvalsReviewer:string|null,remoteStatus:object|null,remoteEnvironmentScope:string,prompt:string,threadEphemeral:boolean,threadTitle:string|null,timeoutMs:number,workspaceRoot:string}} input Turn input.
 * @returns {Promise<object>} Turn result.
 */
async function runDesktopTurn(input) {
  const environments = buildTurnEnvironments({
    remoteStatus: input.remoteStatus,
    remoteEnvironmentScope: input.remoteEnvironmentScope,
    workspaceRoot: input.workspaceRoot,
  });
  const threadParams = {
    approvalPolicy: input.approvalPolicy,
    cwd: input.workspaceRoot,
    ephemeral: input.threadEphemeral,
    ...(input.remoteEnvironmentScope === "thread-turn" &&
    environments.length > 0
      ? { environments }
      : {}),
    runtimeWorkspaceRoots: [input.workspaceRoot],
    sandbox: "read-only",
    threadSource: "user",
  };
  if (input.threadTitle) {
    threadParams.name = input.threadTitle;
  }
  if (input.approvalsReviewer) {
    threadParams.approvalsReviewer = input.approvalsReviewer;
  }

  const threadResponse = await input.appServer.request(
    "thread/start",
    threadParams,
  );
  const threadId = threadResponse.thread?.id;
  if (!threadId) {
    throw new Error("thread/start succeeded without a thread id.");
  }
  input.appServer.threadId = threadId;

  const turnParams = {
    approvalPolicy: input.approvalPolicy,
    cwd: input.workspaceRoot,
    input: [
      {
        type: "text",
        text: input.prompt,
        text_elements: [],
      },
    ],
    ...(input.remoteEnvironmentScope !== "none" && environments.length > 0
      ? { environments }
      : {}),
    runtimeWorkspaceRoots: [input.workspaceRoot],
    sandboxPolicy: {
      type: "readOnly",
      networkAccess: false,
    },
    threadId,
  };
  if (input.approvalsReviewer) {
    turnParams.approvalsReviewer = input.approvalsReviewer;
  }

  const turnResponse = await input.appServer.request("turn/start", turnParams);
  const turnId = turnResponse.turn?.id;
  input.appServer.turnId = turnId ?? null;
  await input.appServer.waitForTurnCompletion({
    threadId,
    timeoutMs: input.timeoutMs,
    turnId,
  });

  return {
    threadId,
    turnId,
    environments,
    finalMessage: input.appServer.finalMessage,
    status: input.appServer.turnCompleted?.status ?? "unknown",
  };
}

/**
 * EN: Builds app-server turn environment bindings from remote-control status.
 * @param {{remoteStatus:object|null,remoteEnvironmentScope:string,workspaceRoot:string}} input Environment input.
 * @returns {Array<object>} Turn environment params.
 */
function buildTurnEnvironments(input) {
  const environmentId = input.remoteStatus?.environmentId;
  if (input.remoteEnvironmentScope === "none" || !environmentId) {
    return [];
  }
  return [
    {
      environmentId,
      cwd: input.workspaceRoot,
    },
  ];
}

/**
 * EN: Minimal WebSocket-over-Unix-socket client for Codex app-server remote-control.
 */
class AppServerWebSocketClient {
  /**
   * @param {{acceptedComputerUseApps:string[],socketPath:string,transcriptPath:string}} input Client input.
   */
  constructor(input) {
    this.acceptedComputerUseApps = input.acceptedComputerUseApps ?? [];
    this.buffer = Buffer.alloc(0);
    this.connected = false;
    this.finalMessage = "";
    this.finalMessages = [];
    this.mcpElicitations = [];
    this.nextId = 1;
    this.pending = new Map();
    this.socket = null;
    this.socketPath = input.socketPath;
    this.threadIdle = false;
    this.threadId = null;
    this.toolCalls = [];
    this.tokenUsage = null;
    this.transcriptPath = input.transcriptPath;
    this.turnCompleted = null;
    this.turnId = null;
  }

  /**
   * EN: Opens the Unix socket and performs the WebSocket handshake.
   * @returns {Promise<void>}
   */
  connect() {
    return new Promise((resolveConnect, rejectConnect) => {
      const socket = net.createConnection(this.socketPath);
      this.socket = socket;
      let handshakeDone = false;
      const rejectOnce = (error) => {
        if (!handshakeDone) {
          handshakeDone = true;
          rejectConnect(error);
        }
      };

      socket.on("connect", () => {
        const key = crypto.randomBytes(16).toString("base64");
        socket.write(
          [
            "GET / HTTP/1.1",
            "Host: localhost",
            "Upgrade: websocket",
            "Connection: Upgrade",
            `Sec-WebSocket-Key: ${key}`,
            "Sec-WebSocket-Version: 13",
            "",
            "",
          ].join("\r\n"),
        );
      });

      socket.on("data", (chunk) => {
        if (!this.connected) {
          this.buffer = Buffer.concat([this.buffer, chunk]);
          const headerEnd = this.buffer.indexOf("\r\n\r\n");
          if (headerEnd < 0) {
            return;
          }
          const header = this.buffer.subarray(0, headerEnd + 4).toString();
          this.buffer = this.buffer.subarray(headerEnd + 4);
          void this.appendTranscript({
            direction: "handshake",
            statusLine: header.split("\r\n")[0],
          });
          if (!header.includes("101 Switching Protocols")) {
            rejectOnce(
              new Error(`WebSocket upgrade failed: ${header.split("\r\n")[0]}`),
            );
            return;
          }
          this.connected = true;
          handshakeDone = true;
          resolveConnect();
          this.decodeFrames();
          return;
        }
        this.buffer = Buffer.concat([this.buffer, chunk]);
        this.decodeFrames();
      });

      socket.on("error", (error) => {
        rejectOnce(error);
        this.rejectAll(error);
      });
      socket.on("close", () => {
        this.rejectAll(new Error("app-server WebSocket closed."));
      });
    });
  }

  /**
   * EN: Sends a JSON-RPC request and waits for the response.
   * @param {string} method JSON-RPC method.
   * @param {object|undefined} params JSON-RPC params.
   * @param {number} timeoutMs Response timeout.
   * @returns {Promise<object>} Response result.
   */
  request(method, params = undefined, timeoutMs = COMMAND_TIMEOUT_MS) {
    const id = this.nextId;
    this.nextId += 1;
    const message =
      params === undefined ? { id, method } : { id, method, params };
    return new Promise((resolveRequest, rejectRequest) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new Error(`${method} timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        reject: rejectRequest,
        resolve: resolveRequest,
        timeout,
      });
      this.send(message);
    });
  }

  /**
   * EN: Sends a JSON-RPC notification.
   * @param {string} method JSON-RPC method.
   * @param {object} params JSON-RPC params.
   * @returns {void}
   */
  notify(method, params = {}) {
    this.send({ method, params });
  }

  /**
   * EN: Waits until app-server emits turn/completed or final answer plus idle.
   * @param {{threadId:string,turnId:string|undefined,timeoutMs:number}} input Wait input.
   * @returns {Promise<void>}
   */
  async waitForTurnCompletion(input) {
    const deadline = performance.now() + input.timeoutMs;
    let interruptSent = false;

    while (performance.now() < deadline) {
      if (this.turnCompleted) {
        return;
      }
      if (this.threadIdle && this.finalMessage) {
        return;
      }
      if (this.hasBrowserBackendBlocked() && !interruptSent && input.turnId) {
        interruptSent = true;
        try {
          await this.request(
            "turn/interrupt",
            {
              threadId: input.threadId,
              turnId: input.turnId,
            },
            5_000,
          );
        } catch {
          // The backend is already proven blocked; interruption is best effort.
        }
        this.turnCompleted = {
          id: input.turnId,
          status: "blocked_early",
        };
        return;
      }
      await sleep(500);
    }

    throw new Error(
      `turn did not complete after ${input.timeoutMs}ms (thread=${input.threadId}, turn=${input.turnId ?? "unknown"}).`,
    );
  }

  /**
   * EN: Closes the WebSocket.
   * @returns {void}
   */
  close() {
    if (!this.socket || this.socket.destroyed) {
      return;
    }
    this.socket.write(encodeClientFrame(8, Buffer.alloc(0)));
    this.socket.end();
  }

  /**
   * EN: Sends a JSON message as a WebSocket text frame.
   * @param {object} message Message payload.
   * @returns {void}
   */
  send(message) {
    void this.appendTranscript({ direction: "send", message });
    this.socket.write(encodeClientFrame(1, JSON.stringify(message)));
  }

  /**
   * EN: Sends a JSON-RPC response to an app-server request.
   * @param {number|string} id Request id.
   * @param {object} result Response result.
   * @returns {void}
   */
  respond(id, result) {
    this.send({ id, result });
  }

  /**
   * EN: Decodes buffered WebSocket frames.
   * @returns {void}
   */
  decodeFrames() {
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;

      if (length === 126) {
        if (this.buffer.length < offset + 2) {
          return;
        }
        length = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (this.buffer.length < offset + 8) {
          return;
        }
        length = Number(this.buffer.readBigUInt64BE(offset));
        offset += 8;
      }

      let mask = null;
      if (masked) {
        if (this.buffer.length < offset + 4) {
          return;
        }
        mask = this.buffer.subarray(offset, offset + 4);
        offset += 4;
      }

      if (this.buffer.length < offset + length) {
        return;
      }

      let payload = this.buffer.subarray(offset, offset + length);
      this.buffer = this.buffer.subarray(offset + length);
      if (mask) {
        payload = Buffer.from(
          payload.map((byte, index) => byte ^ mask[index % 4]),
        );
      }

      if (opcode === 1) {
        this.handleTextFrame(payload.toString());
      } else if (opcode === 8) {
        this.socket.end();
      } else if (opcode === 9) {
        this.socket.write(encodeClientFrame(10, payload));
      }
    }
  }

  /**
   * EN: Handles a JSON-RPC message from app-server.
   * @param {string} text Raw JSON text.
   * @returns {void}
   */
  handleTextFrame(text) {
    let message = null;
    try {
      message = JSON.parse(text);
    } catch {
      void this.appendTranscript({ direction: "recv-unparsed", text });
      return;
    }
    void this.appendTranscript({ direction: "recv", message });

    if (message.method && message.id !== undefined) {
      this.handleServerRequest(message);
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(
            new Error(`${pending.method} failed: ${message.error.message}`),
          );
        } else {
          pending.resolve(message.result ?? {});
        }
      }
    }

    if (message.method === "item/completed") {
      const item = message.params?.item;
      if (item?.type === "mcpToolCall") {
        this.toolCalls.push(item);
      }
      if (
        (item?.type === "agentMessage" && item.phase === "final_answer") ||
        item?.type === "final_answer"
      ) {
        const textValue = extractItemText(item);
        this.finalMessages.push(textValue);
        this.finalMessage = textValue;
      }
    } else if (message.method === "thread/status/changed") {
      this.threadIdle = message.params?.status?.type === "idle";
    } else if (message.method === "turn/completed") {
      this.turnCompleted = message.params?.turn ?? { status: "completed" };
    } else if (message.method === "thread/tokenUsage/updated") {
      this.tokenUsage = message.params?.tokenUsage ?? null;
    }
  }

  /**
   * EN: Handles JSON-RPC requests initiated by app-server.
   * @param {object} message JSON-RPC request.
   * @returns {void}
   */
  handleServerRequest(message) {
    if (message.method === "mcpServer/elicitation/request") {
      const decision = this.reviewMcpElicitation(message.params);
      this.mcpElicitations.push({
        id: message.id,
        method: message.method,
        message: message.params?.message ?? null,
        mode: message.params?.mode ?? null,
        serverName: message.params?.serverName ?? null,
        action: decision.result.action,
        reason: decision.reason,
      });
      this.respond(message.id, decision.result);
      return;
    }

    this.respond(message.id, {
      action: "decline",
      content: null,
      _meta: {
        declinedBy: "oyster-desktop-probe",
        reason: `unsupported app-server request: ${message.method}`,
      },
    });
  }

  /**
   * EN: Reviews an MCP elicitation and accepts only explicitly allowed safe Computer Use app access.
   * @param {object} params Elicitation params.
   * @returns {{result:object,reason:string}} Elicitation response and reason.
   */
  reviewMcpElicitation(params) {
    const message = String(params?.message ?? "");
    const appMatch = message.match(/^Allow Codex to use (.+)\?$/i);
    const appLabel = appMatch?.[1]?.trim() ?? "";
    const allowlisted = this.acceptedComputerUseApps.some(
      (app) => app.toLowerCase() === appLabel.toLowerCase(),
    );
    const isComputerUseAppApproval =
      params?.serverName === "computer-use" &&
      params?.mode === "form" &&
      appLabel.length > 0;

    if (isComputerUseAppApproval && allowlisted) {
      return {
        reason: `accepted explicit Computer Use allowlist app: ${appLabel}`,
        result: {
          action: "accept",
          content: {},
          _meta: {
            acceptedBy: "oyster-desktop-probe",
            app: appLabel,
            reason: "explicit CLI allowlist",
          },
        },
      };
    }

    return {
      reason: isComputerUseAppApproval
        ? `declined Computer Use app outside explicit allowlist: ${appLabel}`
        : "declined unsupported MCP elicitation",
      result: {
        action: "decline",
        content: null,
        _meta: {
          declinedBy: "oyster-desktop-probe",
          reason: "not explicitly allowlisted",
        },
      },
    };
  }

  /**
   * EN: Appends one event to the transcript.
   * @param {object} entry Transcript entry.
   * @returns {Promise<void>}
   */
  async appendTranscript(entry) {
    await writeFileAppend(
      this.transcriptPath,
      `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
    );
  }

  /**
   * EN: Rejects all pending requests.
   * @param {Error} error Error reason.
   * @returns {void}
   */
  rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  /**
   * EN: Detects the known unavailable in-app Browser backend condition.
   * @returns {boolean} True when Browser backend is blocked.
   */
  hasBrowserBackendBlocked() {
    return this.toolCalls.some((call) =>
      /Browser is not available|not available: iab/i.test(
        JSON.stringify(call.result ?? ""),
      ),
    );
  }
}

/**
 * EN: Encodes a masked WebSocket frame for client-to-server traffic.
 * @param {number} opcode WebSocket opcode.
 * @param {string|Buffer} payload Input payload.
 * @returns {Buffer} Encoded frame.
 */
function encodeClientFrame(opcode, payload) {
  const payloadBuffer = Buffer.isBuffer(payload)
    ? payload
    : Buffer.from(payload);
  let headerLength = 2;
  if (payloadBuffer.length >= 126 && payloadBuffer.length <= 65_535) {
    headerLength += 2;
  } else if (payloadBuffer.length > 65_535) {
    headerLength += 8;
  }
  const mask = crypto.randomBytes(4);
  const frame = Buffer.alloc(headerLength + 4 + payloadBuffer.length);
  let offset = 0;
  frame[offset] = 0x80 | opcode;
  offset += 1;

  if (payloadBuffer.length < 126) {
    frame[offset] = 0x80 | payloadBuffer.length;
    offset += 1;
  } else if (payloadBuffer.length <= 65_535) {
    frame[offset] = 0x80 | 126;
    offset += 1;
    frame.writeUInt16BE(payloadBuffer.length, offset);
    offset += 2;
  } else {
    frame[offset] = 0x80 | 127;
    offset += 1;
    frame.writeBigUInt64BE(BigInt(payloadBuffer.length), offset);
    offset += 8;
  }

  mask.copy(frame, offset);
  offset += 4;
  for (let index = 0; index < payloadBuffer.length; index += 1) {
    frame[offset + index] = payloadBuffer[index] ^ mask[index % 4];
  }
  return frame;
}

/**
 * EN: Builds the prompt sent to the Desktop app-server turn.
 * @param {object} input Prompt inputs.
 * @returns {string} Prompt markdown.
 */
function buildPrompt(input) {
  const browser = findPlugin(
    input.plugins,
    "browser@openai-bundled",
    "browser",
  );
  const chrome = findPlugin(input.plugins, "chrome@openai-bundled", "chrome");
  const computerUse = findPlugin(
    input.plugins,
    "computer-use@openai-bundled",
    "computer-use",
  );
  const browserReady = isPluginReady(browser);
  const chromeReady = isPluginReady(chrome);
  const computerReady = isPluginReady(computerUse);
  const browserSurfaceLabel =
    input.browserSurface === "chrome"
      ? "Chrome extension"
      : "Codex in-app Browser";
  const browserSurfaceInstruction =
    input.browserSurface === "chrome"
      ? `Use @Chrome / the Codex Chrome plugin. Select the \`extension\` browser backend.`
      : `Use @Browser / the Codex in-app Browser if available. Select the \`iab\` browser backend.`;
  const browserSurfacePrecheck =
    input.browserSurface === "chrome"
      ? `chrome installed/enabled = ${String(chromeReady)}`
      : `browser installed/enabled = ${String(browserReady)}`;
  const promptTitle = input.threadTitle ?? "AI Worker Desktop Runner Probe";

  const browserTask = input.includeBrowser
    ? `## Browser task

Requested browser surface: ${browserSurfaceLabel}.

${browserSurfaceInstruction}

Open this safe local target:

\`${input.probePageUrl}\`

Verify the page title is exactly \`${PROBE_PAGE_TITLE}\` and the visible token is \`${PROBE_TOKEN}\`.

Local plugin precheck: ${browserSurfacePrecheck}.
`
    : "## Browser task\n\nBrowser probe disabled for this run.\n";

  const computerTask = input.includeComputerUse
    ? `## Computer Use task

Use @Computer / Computer Use only if it is available.

${buildComputerUseTaskBody(input.computerUseTarget, input.computerUseTask)}

Local plugin precheck: computer-use installed/enabled = ${String(computerReady)}.
`
    : "## Computer Use task\n\nComputer Use probe disabled for this run.\n";

  return `# ${promptTitle}

You are being launched by an OysterWorkflow local runner script through Codex Desktop app-server remote-control. This is a safe smoke test for:

\`OysterWorkflow skill -> runner script -> Codex Desktop -> Browser / Computer Use -> result logs\`

## Skill / harness to execute

Skill source: \`${input.skill.source}\`

Read this skill / harness path:

\`${input.skill.path}\`

Expected skill name:

\`${input.skill.name}\`

Preview truncated: \`${String(input.skill.previewTruncated)}\`

Skill preview:

\`\`\`json
${input.skill.preview}
\`\`\`

Adapt this skill to the current safe probe environment. The safety policy below overrides any skill instruction that would submit, upload, send, delete, purchase, install, change external settings, create accounts, or transmit sensitive data.

${browserTask}

${computerTask}

## Safety policy

- Do not perform external side effects beyond an explicitly requested local app launch and read-only observation.
- Do not submit forms, upload files, send messages, delete data, purchase anything, install software, create accounts, change settings, or transmit sensitive data.
- If any requested action would cross that boundary, stop and report the blocking reason.

## Final response contract

Return one compact JSON object only. Include:

- \`desktopRemoteProbeOk\`: boolean
- \`skillRead\`: boolean
- \`browser\`: object with \`usedOrAttempted\`, \`actuallyAvailable\`, \`pageTitle\`, \`tokenFound\`, \`blockedReason\`
- \`computerUse\`: object with \`usedOrAttempted\`, \`actuallyAvailable\`, \`observedState\`, \`tokenFound\`, \`blockedReason\`
- \`notes\`: short string

Set \`desktopRemoteProbeOk\` to true only if every enabled probe surface actually succeeds through its Codex Desktop runtime. If Browser is unavailable and you can only read the local HTML file directly, set \`browser.actuallyAvailable\` to false.
`;
}

/**
 * EN: Builds the Computer Use task body.
 * @param {object|null} computerUseTarget Optional prepared target.
 * @param {string|null} computerUseTask Optional custom safe desktop task.
 * @returns {string} Prompt text.
 */
function buildComputerUseTaskBody(computerUseTarget, computerUseTask) {
  if (computerUseTask) {
    return `Custom Computer Use task:

${computerUseTask}

You may use only the minimum local desktop action needed to perform that task. If the task asks to open a local app, launch that app and then stop at read-only observation of the resulting window/app state. Do not click inside the app after launch, type into fields, play media, change settings, log in, send, upload, delete, purchase, or install anything. If app permission, Screen Recording, Accessibility, or approval is required, stop and report that as blocked.`;
  }

  if (computerUseTarget?.prepared) {
    return `A local TextEdit target has been prepared and opened for this probe.

Target file:

\`${computerUseTarget.filePath}\`

Expected visible token:

\`${computerUseTarget.expectedToken}\`

Use Computer Use for a read-only observation of the TextEdit window and report whether the token is visible. Do not click, type, scroll, drag, press keys, change settings, submit, upload, delete, send, purchase, or install anything. If TextEdit permission, Screen Recording, Accessibility, app approval, or runtime safety blocks the observation, stop and report that as blocked.`;
  }

  return "Do one read-only observation of the current visible desktop state. Do not click, type, scroll, drag, press keys, change settings, submit, upload, delete, send, purchase, or install anything. If app permission, Screen Recording, Accessibility, or approval is required, stop and report that as blocked.";
}

/**
 * EN: Prepares a safe TextEdit target for Computer Use visual observation.
 * @param {{enabled:boolean,filePath:string}} input Target input.
 * @returns {Promise<object|null>} Prepared target metadata.
 */
async function prepareComputerUseTarget(input) {
  if (!input.enabled) {
    return null;
  }
  const expectedToken = "OYSTER_COMPUTER_USE_TEXTEDIT_TOKEN";
  const text = [
    "OysterWorkflow Computer Use Probe",
    "",
    `Verification token: ${expectedToken}`,
    "",
    "This local file is a read-only visual target for Codex Computer Use.",
  ].join("\n");
  await writeFile(input.filePath, `${text}\n`, "utf8");
  const openResult = await runCommand({
    args: ["-a", "TextEdit", input.filePath],
    command: "open",
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
  return {
    expectedToken,
    filePath: input.filePath,
    openExitCode: openResult.exitCode,
    openStderrSnippet: normalizeWhitespace(openResult.stderr).slice(0, 500),
    prepared: openResult.exitCode === 0,
  };
}

/**
 * EN: Resolves either a provided skill/harness path or a generated fixture skill.
 * @param {{fixturePath:string,providedPath:string|null}} input Skill source input.
 * @returns {Promise<object>} Skill metadata.
 */
async function resolveProbeSkill(input) {
  if (!input.providedPath) {
    return writeFixtureSkill(input.fixturePath);
  }

  const filePath = path.resolve(input.providedPath);
  if (!(await pathExists(filePath))) {
    throw new Error(`--skill-path does not exist: ${filePath}`);
  }

  const text = await readFile(filePath, "utf8");
  const parsed = parseJsonOrNull(text);
  const name =
    firstNonEmptyString(parsed?.name, parsed?.title, parsed?.id) ??
    path.basename(filePath);
  const previewLimit = 12_000;
  const previewTruncated = text.length > previewLimit;
  return {
    name,
    path: filePath,
    preview: previewTruncated
      ? `${text.slice(0, previewLimit)}\n... [truncated]`
      : text,
    previewChars: text.length,
    previewTruncated,
    source: "provided",
  };
}

/**
 * EN: Writes a minimal fixture skill for injection tests.
 * @param {string} filePath Fixture path.
 * @returns {Promise<object>} Skill metadata.
 */
async function writeFixtureSkill(filePath) {
  const fixture = {
    schemaVersion: "oyster-desktop-probe-skill-v1",
    name: FIXTURE_SKILL_NAME,
    goal: "Verify that a script can inject a skill into Codex Desktop app-server and request Browser / Computer Use runtime work.",
    runtimeSurfaces: ["browser", "desktop_app"],
    safety:
      "Only safe local read-only observation is allowed. No submit, upload, send, delete, purchase, install, or sensitive data transmission.",
    steps: [
      "Read this fixture skill.",
      "Use Browser to inspect the safe local probe page if Browser runtime is available.",
      "Use Computer Use only for a read-only availability check if requested.",
      "Return compact JSON with blocked reasons when a runtime is unavailable.",
    ],
  };
  await writeJson(filePath, fixture);
  return {
    name: fixture.name,
    path: filePath,
    preview: JSON.stringify(fixture, null, 2),
    previewChars: JSON.stringify(fixture, null, 2).length,
    previewTruncated: false,
    source: "fixture",
  };
}

/**
 * EN: Writes the safe local Browser target page.
 * @param {string} filePath Page path.
 * @returns {Promise<string>} File URL.
 */
async function writeProbePage(filePath) {
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>${escapeHtml(PROBE_PAGE_TITLE)}</title>
  </head>
  <body>
    <main id="desktop-probe-root">
      <h1>${escapeHtml(PROBE_PAGE_TITLE)}</h1>
      <p id="desktop-probe-token">${escapeHtml(PROBE_TOKEN)}</p>
    </main>
  </body>
</html>
`;
  await writeFile(filePath, html, "utf8");
  return pathToFileURL(filePath).href;
}

/**
 * EN: Decides whether to serve the probe page over localhost.
 * @param {object} options CLI options.
 * @returns {boolean} True when an HTTP target should be used.
 */
function shouldServeProbePage(options) {
  if (options.serveProbePage !== null) {
    return options.serveProbePage;
  }
  return options.includeBrowser && options.browserSurface === "chrome";
}

/**
 * EN: Starts a localhost-only static server for the single probe page.
 * @param {string} filePath Probe page path.
 * @returns {Promise<{server:import("node:http").Server,sockets:Set<import("node:net").Socket>,url:string}>} Server and URL.
 */
function startProbePageServer(filePath) {
  return new Promise((resolveStart, rejectStart) => {
    const sockets = new Set();
    const server = http.createServer(async (request, response) => {
      if (request.url !== "/" && request.url !== "/probe-page.html") {
        response.writeHead(404, {
          "content-type": "text/plain; charset=utf-8",
        });
        response.end("not found");
        return;
      }
      try {
        const html = await readFile(filePath, "utf8");
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-type": "text/html; charset=utf-8",
        });
        response.end(html);
      } catch (error) {
        response.writeHead(500, {
          "content-type": "text/plain; charset=utf-8",
        });
        response.end(error instanceof Error ? error.message : String(error));
      }
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    server.on("error", rejectStart);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        rejectStart(new Error("probe page server did not expose a TCP port."));
        return;
      }
      resolveStart({
        server,
        sockets,
        url: `http://127.0.0.1:${address.port}/probe-page.html`,
      });
    });
  });
}

/**
 * EN: Closes the probe page server.
 * @param {{server:import("node:http").Server,sockets:Set<import("node:net").Socket>}|undefined|null} probePageServer HTTP server context.
 * @returns {Promise<void>} Resolves after close.
 */
function closeProbePageServer(probePageServer) {
  if (!probePageServer) {
    return Promise.resolve();
  }
  const { server, sockets } = probePageServer;
  return new Promise((resolveClose) => {
    let settled = false;
    let timeout = null;
    const settle = () => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      resolveClose();
    };
    timeout = setTimeout(() => {
      for (const socket of sockets) {
        socket.destroy();
      }
      settle();
    }, 1_000);
    timeout.unref?.();

    server.close(() => settle());
    server.closeAllConnections?.();
    for (const socket of sockets) {
      socket.destroy();
    }
  });
}

/**
 * EN: Collects local CLI, remote-control, and watchdog environment facts.
 * @param {object} options CLI options.
 * @param {object} paths Artifact paths.
 * @returns {Promise<object>} Environment summary.
 */
async function collectLocalEnvironment(options, paths) {
  const version = await runCommand({
    args: ["--version"],
    command: options.codexBin,
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
  const pluginList = await runCommand({
    args: ["plugin", "list", "--json"],
    command: options.codexBin,
    timeoutMs: COMMAND_TIMEOUT_MS,
  });

  let remoteControlStart = null;
  if (!options.noStartRemoteControl) {
    const started = await runCommand({
      args: ["remote-control", "start", "--json"],
      command: options.codexBin,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    remoteControlStart = parseJsonOrNull(started.stdout);
    await writeFile(
      paths.remoteControlStart,
      started.stdout || "null\n",
      "utf8",
    );
  }

  return {
    codex: {
      available: version.exitCode === 0,
      command: options.codexBin,
      version: firstNonEmptyLine(version.stdout),
      stderrSnippet: normalizeWhitespace(version.stderr).slice(0, 500),
    },
    cliPlugins: parseJsonOrNull(pluginList.stdout),
    remoteControlStart,
    socketPath: options.socketPath,
    watchdogFallback: await collectWatchdogFallback(options, paths),
  };
}

/**
 * EN: Records whether the older auto-continue watchdog fallback exists and can select sessions.
 * @param {object} options CLI options.
 * @param {object} paths Artifact paths.
 * @returns {Promise<object>} Watchdog facts.
 */
async function collectWatchdogFallback(options, paths) {
  const codexHome = options.watchdogCodexHome;
  const statePath = path.join(codexHome, "auto-continue-watchdog-state.json");
  const downloadedScript = path.join(
    os.homedir(),
    "Downloads",
    "codex-watchdog",
    "src",
    "codex-watchdog.js",
  );
  const launchAgentPath = path.join(
    os.homedir(),
    "Library",
    "LaunchAgents",
    "com.shuxin.codexhelper.watchdog.plist.disabled",
  );
  const fallback = {
    codexHome,
    statePath,
    stateExists: await pathExists(statePath),
    helperScriptPath: downloadedScript,
    helperScriptExists: await pathExists(downloadedScript),
    disabledLaunchAgentPath: launchAgentPath,
    disabledLaunchAgentExists: await pathExists(launchAgentPath),
    commandShape: "codex resume <sessionId> <prompt>",
    scope:
      "Fallback can resume recent Codex sessions after errors, but it is not a Browser/Computer Use runtime by itself.",
  };

  if (!options.watchdogScan) {
    const skipped = {
      ...fallback,
      scan: {
        enabled: false,
        reason: "disabled_by_cli",
      },
    };
    await writeJson(paths.watchdogFallback, skipped);
    return skipped;
  }

  try {
    const scanned = {
      ...fallback,
      scan: await buildWatchdogFallbackScanModule({
        allowRealResume: options.watchdogAllowRealResume,
        codexBin: options.codexBin,
        codexHome,
        delayMs: options.watchdogDelayMs,
        liveWindowMs: options.watchdogLiveWindowMs,
        maxAttempts: options.watchdogMaxAttempts,
        maxSessions: options.watchdogMaxSessions,
        prompt: options.watchdogPrompt,
        protectedCodexHome: CODEX_HOME,
        resumeBin: options.watchdogCodexBin ?? options.codexBin,
        resumeMode: options.watchdogResumeMode,
        resumeTimeoutMs: options.watchdogResumeTimeoutMs,
        statePath,
        useTtyWrapper: options.watchdogUseTtyWrapper,
      }),
    };
    await writeJson(paths.watchdogFallback, scanned);
    return scanned;
  } catch (error) {
    const failed = {
      ...fallback,
      scan: {
        enabled: true,
        error: error instanceof Error ? error.message : String(error),
      },
    };
    await writeJson(paths.watchdogFallback, failed);
    return failed;
  }
}

/**
 * EN: Builds the final machine-readable probe summary.
 * @param {object} input Summary input.
 * @returns {object} Summary object.
 */
function buildSummary(input) {
  const plugins = flattenPlugins(input.pluginList);
  const browser = findPlugin(plugins, "browser@openai-bundled", "browser");
  const chrome = findPlugin(plugins, "chrome@openai-bundled", "chrome");
  const requestedBrowserPlugin =
    input.options.browserSurface === "chrome" ? chrome : browser;
  const computerUse = findPlugin(
    plugins,
    "computer-use@openai-bundled",
    "computer-use",
  );
  const finalJson = parseLastJsonObject(input.finalMessage);
  const eventSummary = input.appServer
    ? summarizeAppServerEvents(input.appServer)
    : emptyEventSummary();
  const browserRequested = input.options.includeBrowser;
  const computerRequested = input.options.includeComputerUse;
  const browserVerified =
    browserRequested &&
    (finalJson?.browser?.actuallyAvailable === true ||
      finalJson?.browserActuallyAvailable === true) &&
    (finalJson?.browser?.tokenFound === true || finalJson?.tokenFound === true);
  const computerBlockedReason = finalJson?.computerUse?.blockedReason ?? "";
  const computerUseTokenFound =
    finalJson?.computerUse?.tokenFound === true ||
    (input.computerUseTarget?.expectedToken &&
      new RegExp(input.computerUseTarget.expectedToken).test(
        String(
          finalJson?.computerUse?.observedState ?? input.finalMessage ?? "",
        ),
      ));
  const computerVerified =
    !computerRequested ||
    (finalJson?.computerUse?.actuallyAvailable === true &&
      !computerBlockedReason &&
      (!input.computerUseTarget?.prepared || computerUseTokenFound));
  const browserBackendBlocked =
    eventSummary.browserBackendBlocked ||
    /Browser is not available|iab unavailable|not available: iab/i.test(
      input.finalMessage,
    );
  const computerUseBlockedSignals =
    !isPluginReady(computerUse) ||
    eventSummary.computerUseBlocked ||
    Boolean(computerBlockedReason) ||
    /permission|Screen Recording|Accessibility|not available|blocked/i.test(
      computerBlockedReason,
    );
  const computerUseBlocked =
    computerRequested && !computerVerified && computerUseBlockedSignals;
  const remoteControlStatus = input.remoteStatus?.status ?? null;
  const remoteControlConnected =
    remoteControlStatus === "connected" ||
    (remoteControlStatus === "connecting" &&
      Boolean(input.turnResult?.threadId ?? input.appServer?.threadId));

  let status = "passed";
  let failureReason = null;
  if (input.appServerError) {
    status = browserBackendBlocked ? "blocked" : "failed";
    failureReason = browserBackendBlocked
      ? "Browser plugin is installed/enabled, but app-server could not access the in-app Browser backend (iab)."
      : input.appServerError;
  } else if (input.options.dryRun) {
    status = "dry-run";
  } else if (browserRequested && !browserVerified) {
    status = browserBackendBlocked ? "blocked" : "failed";
    failureReason = browserBackendBlocked
      ? "Browser plugin is installed/enabled, but app-server could not access the in-app Browser backend (iab)."
      : "Browser probe did not verify the page title/token.";
  } else if (computerRequested && !computerVerified) {
    status = computerUseBlocked ? "blocked" : "failed";
    failureReason = computerUseBlocked
      ? "Computer Use plugin is installed/enabled but runtime permissions or app approval blocked the read-only observation."
      : "Computer Use probe did not complete a read-only observation.";
  }

  return {
    schemaVersion: "oyster-codex-desktop-probe-v1",
    createdAt: input.startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - input.startedAtMonotonicMs),
    status,
    failureReason,
    workspaceRoot: input.workspaceRoot,
    outDir: input.outDir,
    options: sanitizeOptions(input.options),
    artifacts: {
      transcript: input.paths.transcript,
      prompt: input.paths.prompt,
      probePage: input.paths.probePage,
      computerUseTarget: input.paths.computerUseTarget,
      fixtureSkill:
        input.skill.source === "fixture" ? input.paths.fixtureSkill : null,
      lastMessage: input.paths.lastMessage,
      providedSkill:
        input.skill.source === "provided" ? input.skill.path : null,
      summary: input.paths.summary,
      remoteControlStart: input.paths.remoteControlStart,
      watchdogFallback: input.paths.watchdogFallback,
    },
    environment: input.environment,
    desktopAppServer: {
      connected: Boolean(input.appServer?.connected),
      socketPath: input.options.socketPath,
      remoteStatus: input.remoteStatus,
      threadId: input.turnResult?.threadId ?? input.appServer?.threadId ?? null,
      turnId: input.turnResult?.turnId ?? input.appServer?.turnId ?? null,
      environments: input.turnResult?.environments ?? [],
      turnStatus:
        input.turnResult?.status ??
        input.appServer?.turnCompleted?.status ??
        null,
      tokenUsage: input.appServer?.tokenUsage ?? null,
    },
    mcpElicitations: input.appServer?.mcpElicitations ?? [],
    plugins: {
      browser: summarizePlugin(browser),
      chrome: summarizePlugin(chrome),
      computerUse: summarizePlugin(computerUse),
    },
    skill: {
      name: input.skill.name,
      path: input.skill.path,
      previewChars: input.skill.previewChars,
      previewTruncated: input.skill.previewTruncated,
      source: input.skill.source,
    },
    browserTarget: {
      surface: input.options.browserSurface,
      url: input.probePageUrl,
      expectedTitle: PROBE_PAGE_TITLE,
      expectedToken: PROBE_TOKEN,
    },
    computerUseTarget: input.computerUseTarget,
    eventSummary,
    verdict: {
      appServerConnected: Boolean(input.appServer?.connected),
      remoteControlConnected,
      remoteControlStatus,
      threadStarted: Boolean(
        input.turnResult?.threadId ?? input.appServer?.threadId,
      ),
      turnStarted: Boolean(input.turnResult?.turnId ?? input.appServer?.turnId),
      browserPluginReady: isPluginReady(requestedBrowserPlugin),
      inAppBrowserPluginReady: isPluginReady(browser),
      chromePluginReady: isPluginReady(chrome),
      browserUsedOrAttempted: eventSummary.browserUsedOrAttempted,
      browserBackendBlocked,
      browserVerified,
      computerUsePluginReady: isPluginReady(computerUse),
      computerUseUsedOrAttempted: eventSummary.computerUseUsedOrAttempted,
      computerUseBlocked,
      computerUseVerified: computerVerified,
      finalJsonParsed: Boolean(finalJson),
    },
    finalJson,
    finalMessage: input.finalMessage,
  };
}

/**
 * EN: Summarizes app-server event state collected by the client.
 * @param {AppServerWebSocketClient} appServer Client instance.
 * @returns {object} Event summary.
 */
function summarizeAppServerEvents(appServer) {
  const toolInputs = appServer.toolCalls.map((call) =>
    JSON.stringify({
      arguments: call.arguments ?? null,
      pluginId: call.pluginId ?? null,
      server: call.server ?? null,
      tool: call.tool ?? null,
    }),
  );
  const inputText = toolInputs.join("\n");
  const browserCalls = appServer.toolCalls.filter((call) =>
    /browser|iab|browser-client/i.test(
      JSON.stringify({
        arguments: call.arguments ?? null,
        server: call.server ?? null,
        tool: call.tool ?? null,
      }),
    ),
  );
  const computerUseCalls = appServer.toolCalls.filter((call) =>
    /computer-use|computer_use|SkyComputerUse|computerUse/i.test(
      JSON.stringify({
        arguments: call.arguments ?? null,
        pluginId: call.pluginId ?? null,
        server: call.server ?? null,
        tool: call.tool ?? null,
      }),
    ),
  );
  return {
    toolCallCount: appServer.toolCalls.length,
    failedToolCallCount: appServer.toolCalls.filter(
      (call) => call.status === "failed",
    ).length,
    browserUsedOrAttempted: /browser|iab|browser-client/i.test(inputText),
    browserBackendBlocked: browserCalls.some((call) =>
      /Browser is not available|not available: iab/i.test(
        JSON.stringify(call.result ?? ""),
      ),
    ),
    computerUseUsedOrAttempted: computerUseCalls.length > 0,
    computerUseBlocked: computerUseCalls.some((call) =>
      /permission|Screen Recording|Accessibility|not available|blocked/i.test(
        JSON.stringify(call.result ?? ""),
      ),
    ),
    finalMessageCount: appServer.finalMessages.length,
  };
}

/**
 * EN: Returns an empty event summary.
 * @returns {object} Empty summary.
 */
function emptyEventSummary() {
  return {
    browserBackendBlocked: false,
    browserUsedOrAttempted: false,
    computerUseBlocked: false,
    computerUseUsedOrAttempted: false,
    failedToolCallCount: 0,
    finalMessageCount: 0,
    toolCallCount: 0,
  };
}

/**
 * EN: Flattens plugin/list output from app-server.
 * @param {object|null} pluginList Plugin list result.
 * @returns {object[]} Plugins.
 */
function flattenPlugins(pluginList) {
  return (
    pluginList?.marketplaces?.flatMap(
      (marketplace) => marketplace.plugins ?? [],
    ) ?? []
  );
}

/**
 * EN: Finds a plugin by id or name.
 * @param {object[]} plugins Plugin list.
 * @param {string} id Plugin id.
 * @param {string} name Plugin name.
 * @returns {object|null} Plugin record.
 */
function findPlugin(plugins, id, name) {
  return (
    plugins.find((plugin) => plugin.id === id || plugin.name === name) ?? null
  );
}

/**
 * EN: Summarizes a plugin record.
 * @param {object|null} plugin Plugin record.
 * @returns {object|null} Summary.
 */
function summarizePlugin(plugin) {
  if (!plugin) {
    return null;
  }
  return {
    availability: plugin.availability ?? null,
    enabled: plugin.enabled === true,
    id: plugin.id ?? null,
    installed: plugin.installed === true,
    name: plugin.name ?? null,
    version: plugin.localVersion ?? plugin.version ?? null,
  };
}

/**
 * EN: Checks whether a plugin is installed and enabled.
 * @param {object|null} plugin Plugin record.
 * @returns {boolean} True when ready.
 */
function isPluginReady(plugin) {
  return plugin?.installed === true && plugin?.enabled === true;
}

/**
 * EN: Extracts text from an app-server item.
 * @param {object} item Event item.
 * @returns {string} Text value.
 */
function extractItemText(item) {
  if (typeof item?.text === "string") {
    return item.text;
  }
  if (Array.isArray(item?.content)) {
    return item.content.map((part) => part.text ?? "").join("");
  }
  return "";
}

/**
 * EN: Parses the last JSON object embedded in a string.
 * @param {string} text Input text.
 * @returns {object|null} Parsed object.
 */
function parseLastJsonObject(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.lastIndexOf("{");
    if (start < 0) {
      return null;
    }
    for (let end = trimmed.length; end > start; end -= 1) {
      const candidate = trimmed.slice(start, end);
      try {
        return JSON.parse(candidate);
      } catch {
        // Continue scanning backward.
      }
    }
    return null;
  }
}

/**
 * EN: Runs a child process and captures output.
 * @param {{command:string,args:string[],timeoutMs:number,cwd?:string,stdoutPath?:string,stderrPath?:string}} input Command input.
 * @returns {Promise<object>} Result.
 */
function runCommand(input) {
  const startedAt = performance.now();
  return new Promise((resolveCommand) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd ?? PROJECT_ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutFile = input.stdoutPath
      ? createWriteStream(input.stdoutPath, { flags: "w" })
      : null;
    const stderrFile = input.stderrPath
      ? createWriteStream(input.stderrPath, { flags: "w" })
      : null;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, input.timeoutMs);

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      stdoutFile?.write(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      stderrFile?.write(text);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      stdoutFile?.end();
      stderrFile?.end();
      resolveCommand({
        durationMs: Math.round(performance.now() - startedAt),
        error: error.message,
        exitCode: null,
        stderr,
        stdout,
        timedOut,
      });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      stdoutFile?.end();
      stderrFile?.end();
      resolveCommand({
        durationMs: Math.round(performance.now() - startedAt),
        exitCode: code,
        signal,
        stderr,
        stdout,
        timedOut,
      });
    });
  });
}

/**
 * EN: Resolves the workspace path used by Desktop thread/turn.
 * @param {string|null} requestedWorkspaceRoot Optional explicit workspace root.
 * @returns {Promise<string>} Workspace root.
 */
async function resolveWorkspaceRoot(requestedWorkspaceRoot = null) {
  if (requestedWorkspaceRoot) {
    return path.resolve(requestedWorkspaceRoot);
  }
  if (await pathExists(WORKSPACE_ALIAS)) {
    return WORKSPACE_ALIAS;
  }
  return PROJECT_ROOT;
}

/**
 * EN: Resolves a unique output directory.
 * @param {string|null} requestedDir Requested directory.
 * @param {Date} startedAt Start timestamp.
 * @returns {Promise<string>} Output directory.
 */
async function resolveOutputDir(requestedDir, startedAt) {
  const workspaceRoot = await resolveWorkspaceRoot();
  const baseDir = requestedDir
    ? path.resolve(requestedDir)
    : path.join(
        workspaceRoot,
        ".runs",
        `codex-desktop-probe-${formatLocalTimestamp(startedAt)}`,
      );
  if (!(await pathExists(baseDir))) {
    return baseDir;
  }
  for (let index = 2; index < 1_000; index += 1) {
    const candidate = `${baseDir}-${index}`;
    if (!(await pathExists(candidate))) {
      return candidate;
    }
  }
  throw new Error(`Unable to find a unique output directory for ${baseDir}`);
}

/**
 * EN: Formats a local timestamp for artifact names.
 * @param {Date} value Timestamp.
 * @returns {string} Formatted timestamp.
 */
function formatLocalTimestamp(value) {
  const pad = (part) => String(part).padStart(2, "0");
  return [
    value.getFullYear(),
    pad(value.getMonth() + 1),
    pad(value.getDate()),
    "-",
    pad(value.getHours()),
    pad(value.getMinutes()),
    pad(value.getSeconds()),
  ].join("");
}

/**
 * EN: Reads a required CLI value.
 * @param {string[]} argv Arguments.
 * @param {number} index Value index.
 * @param {string} flag Flag name.
 * @returns {string} Value.
 */
function readRequiredValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

/**
 * EN: Parses a positive integer.
 * @param {string} value Raw value.
 * @param {string} flag Flag name.
 * @returns {number} Parsed integer.
 */
function parsePositiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer, received: ${value}`);
  }
  return parsed;
}

/**
 * EN: Parses a positive duration and converts it to milliseconds.
 * @param {string} value Raw value.
 * @param {number} unitMs Unit multiplier.
 * @param {string} flag Flag name.
 * @returns {number} Duration in milliseconds.
 */
function parsePositiveDurationMs(value, unitMs, flag) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive number, received: ${value}`);
  }
  return Math.round(parsed * unitMs);
}

/**
 * EN: Parses a supported app-server approval policy.
 * @param {string} value Raw CLI value.
 * @param {string} flag Flag name for diagnostics.
 * @returns {string} Approval policy.
 */
function parseApprovalPolicy(value, flag) {
  const allowed = new Set(["never", "on-request", "on-failure", "untrusted"]);
  if (!allowed.has(value)) {
    throw new Error(`${flag} must be one of: ${[...allowed].join(", ")}`);
  }
  return value;
}

/**
 * EN: Parses a supported app-server approvals reviewer.
 * @param {string} value Raw CLI value.
 * @param {string} flag Flag name for diagnostics.
 * @returns {string} Approvals reviewer.
 */
function parseApprovalsReviewer(value, flag) {
  const allowed = new Set(["user", "auto_review", "guardian_subagent"]);
  if (!allowed.has(value)) {
    throw new Error(`${flag} must be one of: ${[...allowed].join(", ")}`);
  }
  return value;
}

/**
 * EN: Parses how to attach the remote-control environment.
 * @param {string} value Raw CLI value.
 * @param {string} flag Flag name for diagnostics.
 * @returns {string} Remote environment scope.
 */
function parseRemoteEnvironmentScope(value, flag) {
  const allowed = new Set(["none", "turn", "thread-turn"]);
  if (!allowed.has(value)) {
    throw new Error(`${flag} must be one of: ${[...allowed].join(", ")}`);
  }
  return value;
}

/**
 * EN: Parses the requested browser runtime surface.
 * @param {string} value Raw CLI value.
 * @param {string} flag Flag name for diagnostics.
 * @returns {string} Browser surface.
 */
function parseBrowserSurface(value, flag) {
  const allowed = new Set(["iab", "chrome"]);
  if (!allowed.has(value)) {
    throw new Error(`${flag} must be one of: ${[...allowed].join(", ")}`);
  }
  return value;
}

/**
 * EN: Parses watchdog resume mode.
 * @param {string} value Raw CLI value.
 * @param {string} flag Flag name for diagnostics.
 * @returns {string} Resume mode.
 */
function parseWatchdogResumeMode(value, flag) {
  const allowed = new Set(["dry-run", "execute"]);
  if (!allowed.has(value)) {
    throw new Error(`${flag} must be one of: ${[...allowed].join(", ")}`);
  }
  return value;
}

/**
 * EN: Checks if a path exists.
 * @param {string} filePath Path.
 * @returns {Promise<boolean>} Existence.
 */
async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * EN: Writes JSON with stable formatting.
 * @param {string} filePath Path.
 * @param {unknown} value JSON value.
 * @returns {Promise<void>}
 */
async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/**
 * EN: Appends text to a file.
 * @param {string} filePath Path.
 * @param {string} text Text to append.
 * @returns {Promise<void>}
 */
async function writeFileAppend(filePath, text) {
  await writeFile(filePath, text, { encoding: "utf8", flag: "a" });
}

/**
 * EN: Parses JSON or returns null.
 * @param {string} text JSON text.
 * @returns {object|null} Parsed value.
 */
function parseJsonOrNull(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * EN: Returns the first non-empty line.
 * @param {string} text Input text.
 * @returns {string|null} First line.
 */
function firstNonEmptyLine(text) {
  return (
    String(text ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? null
  );
}

/**
 * EN: Returns the first non-empty string from a list.
 * @param {...unknown} values Candidate values.
 * @returns {string|null} First non-empty string.
 */
function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

/**
 * EN: Normalizes whitespace.
 * @param {string} value Input value.
 * @returns {string} Normalized text.
 */
function normalizeWhitespace(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * EN: Escapes HTML text.
 * @param {string} value Raw text.
 * @returns {string} Escaped text.
 */
function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * EN: Removes nonessential or duplicate option fields from summary.
 * @param {object} options Options.
 * @returns {object} Sanitized options.
 */
function sanitizeOptions(options) {
  return {
    approvalPolicy: options.approvalPolicy,
    approvalsReviewer: options.approvalsReviewer,
    acceptedComputerUseApps: [...new Set(options.acceptedComputerUseApps)],
    browserSurface: options.browserSurface,
    codexBin: options.codexBin,
    computerUseTask: options.computerUseTask,
    dryRun: options.dryRun,
    includeBrowser: options.includeBrowser,
    includeComputerUse: options.includeComputerUse,
    noStartRemoteControl: options.noStartRemoteControl,
    prepareTextEditTarget: options.prepareTextEditTarget,
    remoteEnvironmentScope: options.remoteEnvironmentScope,
    requestJsonPaths: options.requestJsonPaths,
    serveProbePage: options.serveProbePage,
    serveProbePageEffective: Boolean(options.serveProbePageEffective),
    skillPath: options.skillPath,
    socketPath: options.socketPath,
    timeoutMs: options.timeoutMs,
    threadEphemeral: options.threadEphemeral,
    threadTitle: options.threadTitle,
    watchdogAllowRealResume: options.watchdogAllowRealResume,
    watchdogCodexBin: options.watchdogCodexBin,
    watchdogCodexHome: options.watchdogCodexHome,
    watchdogDelayMs: options.watchdogDelayMs,
    watchdogLiveWindowMs: options.watchdogLiveWindowMs,
    watchdogMaxAttempts: options.watchdogMaxAttempts,
    watchdogMaxSessions: options.watchdogMaxSessions,
    watchdogPrompt: options.watchdogPrompt,
    watchdogResumeMode: options.watchdogResumeMode,
    watchdogResumeTimeoutMs: options.watchdogResumeTimeoutMs,
    watchdogScan: options.watchdogScan,
    watchdogUseTtyWrapper: options.watchdogUseTtyWrapper,
    workspaceRoot: options.workspaceRoot,
  };
}

/**
 * EN: Sleeps for a short interval.
 * @param {number} ms Milliseconds.
 * @returns {Promise<void>} Promise resolved after the delay.
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
