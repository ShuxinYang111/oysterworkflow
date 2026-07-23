#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PROJECT_ROOT = path.resolve(
  fileURLToPath(new URL("..", import.meta.url)),
);
const WORKSPACE_ALIAS = path.join(os.homedir(), "Documents", "New_project");
const DEFAULT_TIMEOUT_MS = 180_000;
const CAPTURE_LIMIT_CHARS = 80_000;
const PROBE_PAGE_TITLE = "Oyster Worker Probe Safe Page";
const PROBE_TOKEN = "OYSTER_WORKER_PROBE_BROWSER_TOKEN";
const FIXTURE_SKILL_NAME = "oyster-worker-probe-browser-title";

/**
 * EN: Parses CLI flags for the Codex worker probe script.
 * @param {string[]} argv CLI argument list after node/script.
 * @returns {{dryRun:boolean, help:boolean, outDir:string|null, skillPath:string|null, taskUrl:string|null, codexBin:string, timeoutMs:number, model:string|null, profile:string|null, codexConfig:string[]}}
 */
function parseArgs(argv) {
  const options = {
    dryRun: false,
    help: false,
    outDir: null,
    skillPath: null,
    taskUrl: null,
    codexBin: "codex",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    model: null,
    profile: null,
    codexConfig: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--dry-run":
      case "--skip-codex-exec":
        options.dryRun = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--out-dir":
        options.outDir = readRequiredValue(argv, (index += 1), arg);
        break;
      case "--skill-path":
        options.skillPath = readRequiredValue(argv, (index += 1), arg);
        break;
      case "--task-url":
        options.taskUrl = readRequiredValue(argv, (index += 1), arg);
        break;
      case "--codex-bin":
        options.codexBin = readRequiredValue(argv, (index += 1), arg);
        break;
      case "--timeout-ms":
        options.timeoutMs = parsePositiveInteger(
          readRequiredValue(argv, (index += 1), arg),
          arg,
        );
        break;
      case "--model":
      case "-m":
        options.model = readRequiredValue(argv, (index += 1), arg);
        break;
      case "--profile":
      case "-p":
        options.profile = readRequiredValue(argv, (index += 1), arg);
        break;
      case "--codex-config":
      case "-c":
        options.codexConfig.push(readRequiredValue(argv, (index += 1), arg));
        break;
      default:
        throw new Error(`Unsupported argument: ${arg}`);
    }
  }

  return options;
}

/**
 * EN: Prints CLI usage for the probe script.
 * @returns {void}
 */
function printHelp() {
  process.stdout.write(`Usage: node scripts/codex-worker-probe.mjs [options]

Validates the shortest Codex-controlled AI Worker runner loop:
OysterWorkflow skill -> runner script -> codex exec -> Browser/Computer Use.

Options:
  --dry-run, --skip-codex-exec  Write probe artifacts without launching Codex.
  --out-dir <path>              Output directory under .runs by default.
  --skill-path <path>           Existing skill or harness file to inject.
  --task-url <url>              Browser target URL. Defaults to a local safe HTML file.
  --codex-bin <path>            Codex executable. Defaults to "codex".
  --timeout-ms <ms>             Codex exec timeout. Defaults to ${DEFAULT_TIMEOUT_MS}.
  --model, -m <model>           Optional model passed to codex exec.
  --profile, -p <profile>       Optional Codex config profile.
  --codex-config, -c <key=val>  Extra Codex config override. Repeatable.
  --help, -h                    Show this help.
`);
}

/**
 * EN: Returns a required option value or throws a diagnostic error.
 * @param {string[]} argv CLI argument list.
 * @param {number} index Value index.
 * @param {string} flag Flag name.
 * @returns {string} Parsed flag value.
 */
function readRequiredValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

/**
 * EN: Parses a positive integer CLI value.
 * @param {string} value Raw CLI value.
 * @param {string} flag Flag name for errors.
 * @returns {number} Positive integer.
 */
function parsePositiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer, received: ${value}`);
  }
  return parsed;
}

/**
 * EN: Runs the full probe and writes all artifacts to disk.
 * @returns {Promise<void>}
 */
async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const startedAt = new Date();
  const workspaceRoot = await resolveWorkspaceRoot();
  const outDir = await resolveOutputDir(options.outDir, startedAt);
  await mkdir(outDir, { recursive: true });

  const paths = {
    prompt: path.join(outDir, "prompt.md"),
    events: path.join(outDir, "codex-events.jsonl"),
    stderr: path.join(outDir, "codex-stderr.log"),
    lastMessage: path.join(outDir, "last-message.md"),
    summary: path.join(outDir, "probe-summary.json"),
    probePage: path.join(outDir, "probe-page.html"),
    fixtureSkill: path.join(outDir, "fixture-skill.json"),
  };

  process.stdout.write(`[codex-worker-probe] output: ${outDir}\n`);
  process.stdout.write("[codex-worker-probe] probing Codex environment\n");

  const environment = await collectEnvironment({
    codexBin: options.codexBin,
    timeoutMs: Math.min(options.timeoutMs, 30_000),
  });
  const skill = await resolveSkillInput({
    skillPath: options.skillPath,
    fixturePath: paths.fixtureSkill,
  });
  const probePageUrl =
    options.taskUrl ??
    (await writeProbePage({
      filePath: paths.probePage,
      title: PROBE_PAGE_TITLE,
      token: PROBE_TOKEN,
    }));
  const prompt = buildPrompt({
    skill,
    probePageUrl,
    browser: environment.plugins.browser,
    computerUse: environment.plugins.computerUse,
  });
  await writeFile(paths.prompt, prompt, "utf8");

  const summary = {
    schemaVersion: "oyster-codex-worker-probe-v1",
    createdAt: startedAt.toISOString(),
    completedAt: null,
    durationMs: null,
    status: "pending",
    verdict: {
      codexCliAvailable: environment.codex.available,
      browserPluginReady: isPluginReady(environment.plugins.browser),
      computerUseReady: isPluginReady(environment.plugins.computerUse),
      codexLaunched: false,
      skillInjected: false,
      browserVerified: false,
    },
    workspaceRoot,
    outDir,
    options: sanitizeOptions(options),
    artifacts: {
      prompt: paths.prompt,
      codexEvents: paths.events,
      codexStderr: paths.stderr,
      lastMessage: paths.lastMessage,
      probeSummary: paths.summary,
      probePage: options.taskUrl ? null : paths.probePage,
      skillPath: skill.path,
    },
    environment,
    skill: {
      path: skill.path,
      name: skill.name,
      source: skill.source,
    },
    browserTarget: {
      url: probePageUrl,
      expectedTitle: PROBE_PAGE_TITLE,
      expectedToken: PROBE_TOKEN,
    },
    desktopControl: buildDesktopControlStatus(environment.plugins.computerUse),
    codexExec: null,
    eventSummary: null,
    failureReason: null,
  };

  if (!environment.codex.available) {
    summary.status = "blocked";
    summary.failureReason = "Codex CLI is unavailable.";
    await finishSummary(summary, paths.summary, startedAt);
    process.exitCode = 1;
    return;
  }

  if (!isPluginReady(environment.plugins.browser)) {
    summary.status = "blocked";
    summary.failureReason = "Browser plugin is not installed and enabled.";
    await finishSummary(summary, paths.summary, startedAt);
    process.exitCode = 1;
    return;
  }

  if (options.dryRun) {
    summary.status = "dry-run";
    summary.verdict.skillInjected = prompt.includes(skill.path);
    await finishSummary(summary, paths.summary, startedAt);
    process.stdout.write("[codex-worker-probe] dry run complete\n");
    return;
  }

  process.stdout.write(
    "[codex-worker-probe] launching codex exec smoke test\n",
  );
  const execResult = await runCodexExec({
    codexBin: options.codexBin,
    workspaceRoot,
    prompt,
    eventsPath: paths.events,
    stderrPath: paths.stderr,
    lastMessagePath: paths.lastMessage,
    timeoutMs: options.timeoutMs,
    model: options.model,
    profile: options.profile,
    codexConfig: options.codexConfig,
  });
  const finalMessage = await readOptionalTextWithRetry(
    paths.lastMessage,
    2_000,
  );
  const eventSummary = await summarizeJsonl(paths.events);
  const verdict = evaluateProbe({
    execResult,
    finalMessage,
    eventSummary,
    skillName: skill.name,
    prompt,
  });

  summary.codexExec = execResult;
  summary.eventSummary = eventSummary;
  summary.verdict = {
    ...summary.verdict,
    ...verdict,
  };
  summary.status = verdict.passed
    ? "passed"
    : verdict.blocked
      ? "blocked"
      : "failed";
  summary.failureReason = verdict.failureReason;
  await finishSummary(summary, paths.summary, startedAt);

  process.stdout.write(
    `[codex-worker-probe] ${summary.status}: ${summary.failureReason ?? "probe passed"}\n`,
  );
  if (!verdict.passed) {
    process.exitCode = 1;
  }
}

/**
 * EN: Resolves the symlinked workspace path preferred for local artifacts.
 * @returns {Promise<string>} Workspace path.
 */
async function resolveWorkspaceRoot() {
  if (await pathExists(WORKSPACE_ALIAS)) {
    return WORKSPACE_ALIAS;
  }
  return PROJECT_ROOT;
}

/**
 * EN: Resolves a unique output directory for this run.
 * @param {string|null} requestedDir Optional user requested output dir.
 * @param {Date} startedAt Run timestamp.
 * @returns {Promise<string>} Unique output directory path.
 */
async function resolveOutputDir(requestedDir, startedAt) {
  const baseDir = requestedDir
    ? path.resolve(requestedDir)
    : path.join(
        await resolveWorkspaceRoot(),
        ".runs",
        `codex-worker-probe-${formatLocalTimestamp(startedAt)}`,
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
 * EN: Formats a local timestamp for readable run directories.
 * @param {Date} value Date to format.
 * @returns {string} Timestamp in YYYYMMDD-HHmmss.
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
 * EN: Collects Codex CLI, plugin, and MCP status without mutating config.
 * @param {{codexBin:string, timeoutMs:number}} input Command input.
 * @returns {Promise<object>} Environment probe result.
 */
async function collectEnvironment(input) {
  const version = await runCommand({
    command: input.codexBin,
    args: ["--version"],
    timeoutMs: input.timeoutMs,
  });
  const codexAvailable = version.exitCode === 0 && !version.timedOut;

  const pluginList = codexAvailable
    ? await runCommand({
        command: input.codexBin,
        args: ["plugin", "list"],
        timeoutMs: input.timeoutMs,
      })
    : emptyCommandResult("codex plugin list skipped");
  const mcpList = codexAvailable
    ? await runCommand({
        command: input.codexBin,
        args: ["mcp", "list"],
        timeoutMs: input.timeoutMs,
      })
    : emptyCommandResult("codex mcp list skipped");
  const pluginText = `${pluginList.stdout}\n${pluginList.stderr}`;

  return {
    codex: {
      available: codexAvailable,
      version: firstNonEmptyLine(version.stdout) ?? null,
      command: input.codexBin,
      exitCode: version.exitCode,
      stderrSnippet: normalizeWhitespace(version.stderr).slice(0, 500),
    },
    plugins: {
      browser: parsePluginStatus(pluginText, "browser"),
      computerUse: parsePluginStatus(pluginText, "computer-use"),
      rawListExitCode: pluginList.exitCode,
      rawListStderrSnippet: normalizeWhitespace(pluginList.stderr).slice(
        0,
        500,
      ),
    },
    mcp: {
      exitCode: mcpList.exitCode,
      containsNodeRepl: /\bnode_repl\b/.test(
        `${mcpList.stdout}\n${mcpList.stderr}`,
      ),
      stdoutSnippet: normalizeWhitespace(mcpList.stdout).slice(0, 1_500),
      stderrSnippet: normalizeWhitespace(mcpList.stderr).slice(0, 500),
    },
  };
}

/**
 * EN: Resolves an existing skill path or creates a safe local fixture skill.
 * @param {{skillPath:string|null, fixturePath:string}} input Skill input.
 * @returns {Promise<{path:string, name:string, source:string, preview:string}>} Skill metadata.
 */
async function resolveSkillInput(input) {
  if (input.skillPath) {
    const resolved = path.resolve(input.skillPath);
    const raw = await readFile(resolved, "utf8");
    return {
      path: resolved,
      name: inferSkillName(raw, resolved),
      source: "provided",
      preview: raw.slice(0, 8_000),
    };
  }

  const fixture = {
    schemaVersion: "oyster-worker-probe-skill-v1",
    name: FIXTURE_SKILL_NAME,
    goal: "Verify that Codex can read a workflow skill and use Browser to inspect a safe local page.",
    whenToUse:
      "Use this fixture only for the AI Worker runner probe smoke test.",
    runtimeSurfaces: ["browser"],
    steps: [
      "Read this skill file.",
      `Open the safe probe page and verify its title is ${PROBE_PAGE_TITLE}.`,
      `Confirm the page contains the token ${PROBE_TOKEN}.`,
      "Return a concise final JSON object with the observed title and token.",
    ],
    safety:
      "This fixture must not submit forms, upload files, send messages, delete data, purchase anything, or transmit sensitive information.",
  };
  await writeJson(input.fixturePath, fixture);
  return {
    path: input.fixturePath,
    name: fixture.name,
    source: "fixture",
    preview: JSON.stringify(fixture, null, 2),
  };
}

/**
 * EN: Writes a local static page that is safe for Browser smoke tests.
 * @param {{filePath:string, title:string, token:string}} input Page input.
 * @returns {Promise<string>} file:// URL for the probe page.
 */
async function writeProbePage(input) {
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>${escapeHtml(input.title)}</title>
  </head>
  <body>
    <main id="probe-root" data-worker-probe="true">
      <h1>${escapeHtml(input.title)}</h1>
      <p>Verification token: <strong>${escapeHtml(input.token)}</strong></p>
      <p>This page is a local, no-side-effect Browser probe target.</p>
    </main>
  </body>
</html>
`;
  await writeFile(input.filePath, html, "utf8");
  return pathToFileURL(input.filePath).href;
}

/**
 * EN: Builds the prompt injected into `codex exec`.
 * @param {{skill:{path:string,name:string,preview:string}, probePageUrl:string, browser:object, computerUse:object}} input Prompt inputs.
 * @returns {string} Prompt markdown.
 */
function buildPrompt(input) {
  const desktopInstruction = isPluginReady(input.computerUse)
    ? [
        "Computer Use check:",
        "- Use Computer Use only for read-only observation if it is available.",
        "- Do not click, type, scroll, drag, submit, upload, delete, install, purchase, send, or change settings.",
        "- Report the visible frontmost app/window if a safe read-only observation is possible.",
      ].join("\n")
    : [
        "Computer Use check:",
        "- The local probe detected that the computer-use plugin is not installed and enabled.",
        "- Do not attempt desktop control.",
        '- In the final JSON, set desktopControl.status to "blocked" and explain that computer-use is not installed/enabled.',
      ].join("\n");

  return `# AI Worker Runner Probe

You are being launched by an OysterWorkflow local runner script. This is a safe smoke test for the shortest AI Worker loop:

\`OysterWorkflow skill -> runner script -> Codex -> Browser / Computer Use -> result logs\`

## Skill to execute

Read the skill or harness file from this path:

\`${input.skill.path}\`

Expected skill name for this probe:

\`${input.skill.name}\`

Skill preview:

\`\`\`json
${input.skill.preview}
\`\`\`

## Browser task

Use the Codex Browser plugin, or the equivalent Browser capability available in this session, to open this safe local target:

\`${input.probePageUrl}\`

Verify that the page title is exactly:

\`${PROBE_PAGE_TITLE}\`

Verify that the page contains this token:

\`${PROBE_TOKEN}\`

## Desktop task

${desktopInstruction}

## Safety policy

- Do not perform external side effects.
- Do not submit forms, upload files, send messages, delete data, purchase anything, install software, create accounts, change settings, or transmit sensitive data.
- If any requested action would cross that boundary, stop and report the blocking reason.

## Final response contract

Return one concise JSON object in your final answer. Include these keys:

- \`workerProbeOk\`: boolean
- \`skillRead\`: boolean
- \`skillName\`: string
- \`browserUsedOrAttempted\`: boolean
- \`pageTitle\`: string or null
- \`pageTokenFound\`: boolean
- \`desktopControl\`: object with \`status\` and \`reason\`
- \`notes\`: short string

Set \`workerProbeOk\` to true only if the Browser capability actually opens or inspects the target page. If Browser is unavailable and you can only read the local HTML file directly, set \`workerProbeOk\` to false and explain the blocked Browser backend in \`notes\`.
`;
}

/**
 * EN: Runs `codex exec --json` with the generated prompt and artifact paths.
 * @param {{codexBin:string, workspaceRoot:string, prompt:string, eventsPath:string, stderrPath:string, lastMessagePath:string, timeoutMs:number, model:string|null, profile:string|null, codexConfig:string[]}} input Exec input.
 * @returns {Promise<object>} Command result.
 */
async function runCodexExec(input) {
  const args = [
    "-C",
    input.workspaceRoot,
    "--ask-for-approval",
    "never",
    "--sandbox",
    "workspace-write",
  ];

  if (input.model) {
    args.push("--model", input.model);
  }
  if (input.profile) {
    args.push("--profile", input.profile);
  }
  for (const config of input.codexConfig) {
    args.push("--config", config);
  }
  args.push(
    "exec",
    "--json",
    "--output-last-message",
    input.lastMessagePath,
    "-",
  );

  return runCommand({
    command: input.codexBin,
    args,
    cwd: input.workspaceRoot,
    input: input.prompt,
    timeoutMs: input.timeoutMs,
    stdoutPath: input.eventsPath,
    stderrPath: input.stderrPath,
  });
}

/**
 * EN: Runs a child process with optional stdin and output files.
 * @param {{command:string, args:string[], cwd?:string, input?:string, timeoutMs:number, stdoutPath?:string, stderrPath?:string}} input Command input.
 * @returns {Promise<object>} Captured command result.
 */
function runCommand(input) {
  const startedAt = Date.now();
  return new Promise((resolveCommand) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd ?? PROJECT_ROOT,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
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
    let spawnError = null;
    let closed = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!closed) {
          child.kill("SIGKILL");
        }
      }, 5_000).unref();
    }, input.timeoutMs);

    child.stdout?.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stdout = appendCapped(stdout, text);
      stdoutFile?.write(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderr = appendCapped(stderr, text);
      stderrFile?.write(chunk);
    });
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (code, signal) => {
      closed = true;
      clearTimeout(timeout);
      stdoutFile?.end();
      stderrFile?.end();
      resolveCommand({
        command: input.command,
        args: input.args,
        exitCode: code,
        signal,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdout,
        stderr,
        error: spawnError
          ? spawnError instanceof Error
            ? spawnError.message
            : String(spawnError)
          : null,
      });
    });

    if (input.input) {
      child.stdin?.end(input.input);
    } else {
      child.stdin?.end();
    }
  });
}

/**
 * EN: Builds an empty command result for skipped probes.
 * @param {string} reason Skip reason.
 * @returns {object} Empty command result.
 */
function emptyCommandResult(reason) {
  return {
    command: null,
    args: [],
    exitCode: null,
    signal: null,
    timedOut: false,
    durationMs: 0,
    stdout: "",
    stderr: reason,
    error: reason,
  };
}

/**
 * EN: Parses a plugin status line from `codex plugin list` output.
 * @param {string} output Combined plugin list stdout/stderr.
 * @param {string} pluginName Plugin name.
 * @returns {{name:string, found:boolean, installed:boolean, enabled:boolean, statusText:string|null}}
 */
function parsePluginStatus(output, pluginName) {
  const line =
    output
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .find((entry) => entry.startsWith(`${pluginName}@`)) ?? null;
  const installed =
    Boolean(line) &&
    /\binstalled\b/.test(line) &&
    !/\bnot installed\b/.test(line);
  const enabled = Boolean(line) && /\benabled\b/.test(line);
  return {
    name: pluginName,
    found: Boolean(line),
    installed,
    enabled,
    statusText: line,
  };
}

/**
 * EN: Returns whether a parsed plugin is ready for use.
 * @param {object} plugin Parsed plugin status.
 * @returns {boolean} True when installed and enabled.
 */
function isPluginReady(plugin) {
  return Boolean(plugin?.installed && plugin?.enabled);
}

/**
 * EN: Builds the desktop-control section of the final summary.
 * @param {object} computerUse Parsed computer-use plugin status.
 * @returns {object} Desktop control status.
 */
function buildDesktopControlStatus(computerUse) {
  if (isPluginReady(computerUse)) {
    return {
      status: "ready",
      reason:
        "computer-use plugin is installed and enabled; prompt restricts it to read-only observation.",
    };
  }
  return {
    status: "blocked",
    reason:
      "computer-use plugin is not installed and enabled; desktop control is intentionally not attempted.",
    installSuggestion:
      "Run `codex plugin add computer-use@openai-bundled` if desktop-control verification is required.",
  };
}

/**
 * EN: Summarizes Codex JSONL events with best-effort schema tolerance.
 * @param {string} eventsPath JSONL path.
 * @returns {Promise<object>} Event summary.
 */
async function summarizeJsonl(eventsPath) {
  const raw = await readOptionalText(eventsPath);
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const eventTypes = new Map();
  const toolNames = new Set();
  let parseErrors = 0;

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      collectJsonSignals(parsed, eventTypes, toolNames);
    } catch {
      parseErrors += 1;
    }
  }

  return {
    lineCount: lines.length,
    parseErrors,
    eventTypes: Object.fromEntries(eventTypes),
    toolNames: [...toolNames].sort(),
    containsBrowserSignal: /\bbrowser\b|browser-use|in-app browser|iab/i.test(
      raw,
    ),
    containsBrowserUnavailableSignal:
      /Browser is not available|no available browser|no in-app Browser|\"list\":\s*\[\]/i.test(
        raw,
      ),
    containsComputerUseSignal:
      /computer-use|computer use|desktop-control/i.test(raw),
  };
}

/**
 * EN: Evaluates the smoke result against the minimum proof criteria.
 * @param {{execResult:object, finalMessage:string, eventSummary:object, skillName:string, prompt:string}} input Probe evidence.
 * @returns {object} Verdict fields.
 */
function evaluateProbe(input) {
  const finalLower = input.finalMessage.toLowerCase();
  const finalJson = parseFinalJson(input.finalMessage);
  const codexLaunched =
    input.execResult.exitCode !== null &&
    !input.execResult.timedOut &&
    input.eventSummary.lineCount > 0;
  const skillInjected = input.prompt.includes(input.skillName);
  const skillRead =
    finalLower.includes("skillread") ||
    finalLower.includes("skill read") ||
    input.finalMessage.includes(input.skillName);
  const browserVerified =
    finalJson?.workerProbeOk === true ||
    (finalJson === null &&
      input.finalMessage.includes(PROBE_PAGE_TITLE) &&
      input.finalMessage.includes(PROBE_TOKEN));
  const pageContentVerified =
    (finalJson?.pageTitle === PROBE_PAGE_TITLE &&
      finalJson?.pageTokenFound === true) ||
    (input.finalMessage.includes(PROBE_PAGE_TITLE) &&
      input.finalMessage.includes(PROBE_TOKEN));
  const browserUsedOrAttempted =
    input.eventSummary.containsBrowserSignal ||
    finalLower.includes("browserusedorattempted") ||
    finalLower.includes("browser");
  const browserBackendBlocked =
    input.eventSummary.containsBrowserUnavailableSignal ||
    /browser (?:was )?(?:attempted, but )?(?:is )?not available|no in-app browser|browser backend.*unavailable|no available.*browser/i.test(
      input.finalMessage,
    );

  let failureReason = null;
  let blocked = false;
  if (input.execResult.timedOut) {
    failureReason = "codex exec timed out.";
  } else if (input.execResult.exitCode !== 0) {
    failureReason = `codex exec exited with code ${input.execResult.exitCode}.`;
  } else if (!codexLaunched) {
    failureReason = "codex exec did not produce JSONL events.";
  } else if (!skillInjected || !skillRead) {
    failureReason =
      "Codex did not clearly read or acknowledge the injected skill.";
  } else if (browserBackendBlocked) {
    blocked = true;
    failureReason =
      "codex exec ran and read the skill, but no in-app Browser backend was available to verify the page.";
  } else if (!browserUsedOrAttempted || !browserVerified) {
    failureReason = "Codex did not clearly verify the Browser probe page.";
  }

  return {
    codexLaunched,
    skillInjected,
    skillRead,
    browserUsedOrAttempted,
    browserVerified,
    pageContentVerified,
    browserBackendBlocked,
    passed: failureReason === null,
    blocked,
    finalJsonParsed: finalJson !== null,
    failureReason,
  };
}

/**
 * EN: Recursively collects common event type and tool-name signals.
 * @param {unknown} value JSON value.
 * @param {Map<string, number>} eventTypes Event type counts.
 * @param {Set<string>} toolNames Tool names.
 * @returns {void}
 */
function collectJsonSignals(value, eventTypes, toolNames) {
  if (!value || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectJsonSignals(item, eventTypes, toolNames);
    }
    return;
  }

  for (const [key, raw] of Object.entries(value)) {
    if ((key === "type" || key === "event") && typeof raw === "string") {
      eventTypes.set(raw, (eventTypes.get(raw) ?? 0) + 1);
    }
    if (
      ["tool", "toolName", "tool_name", "server", "recipient"].includes(key) &&
      typeof raw === "string"
    ) {
      toolNames.add(raw);
    }
    collectJsonSignals(raw, eventTypes, toolNames);
  }
}

/**
 * EN: Finishes and writes the run summary.
 * @param {object} summary Mutable summary object.
 * @param {string} summaryPath Summary output path.
 * @param {Date} startedAt Run start.
 * @returns {Promise<void>}
 */
async function finishSummary(summary, summaryPath, startedAt) {
  const completedAt = new Date();
  summary.completedAt = completedAt.toISOString();
  summary.durationMs = completedAt.getTime() - startedAt.getTime();
  await writeJson(summaryPath, summary);
  process.stdout.write(`[codex-worker-probe] summary: ${summaryPath}\n`);
}

/**
 * EN: Writes pretty JSON with a trailing newline.
 * @param {string} filePath File path.
 * @param {unknown} value JSON value.
 * @returns {Promise<void>}
 */
async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/**
 * EN: Reads text if the file exists.
 * @param {string} filePath File path.
 * @returns {Promise<string>} File content or empty string.
 */
async function readOptionalText(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

/**
 * EN: Reads a text file with a short retry window for tools that flush after process exit.
 * @param {string} filePath File path.
 * @param {number} timeoutMs Retry timeout.
 * @returns {Promise<string>} File content or empty string.
 */
async function readOptionalTextWithRetry(filePath, timeoutMs) {
  const startedAt = Date.now();
  let last = "";
  while (Date.now() - startedAt <= timeoutMs) {
    last = await readOptionalText(filePath);
    if (last.trim()) {
      return last;
    }
    await sleep(100);
  }
  return last;
}

/**
 * EN: Parses a final JSON object from Codex's last message when possible.
 * @param {string} text Final message text.
 * @returns {Record<string, unknown>|null} Parsed object or null.
 */
function parseFinalJson(text) {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }

  try {
    const parsed = JSON.parse(unfenced.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

/**
 * EN: Sleeps for a short retry interval.
 * @param {number} ms Delay in milliseconds.
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}

/**
 * EN: Checks path existence.
 * @param {string} filePath Path to check.
 * @returns {Promise<boolean>} Whether the path exists.
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
 * EN: Infers a skill name from JSON/YAML-ish content or filename.
 * @param {string} raw Skill file content.
 * @param {string} filePath Skill file path.
 * @returns {string} Inferred name.
 */
function inferSkillName(raw, filePath) {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed.name === "string" && parsed.name.trim()) {
      return parsed.name.trim();
    }
    if (typeof parsed.goal === "string" && parsed.goal.trim()) {
      return parsed.goal.trim().slice(0, 80);
    }
  } catch {
    const match = raw.match(/^name:\s*["']?([^"'\n]+)["']?/m);
    if (match?.[1]?.trim()) {
      return match[1].trim();
    }
  }
  return path.basename(filePath, path.extname(filePath));
}

/**
 * EN: Escapes text for the generated local HTML page.
 * @param {string} value Raw text.
 * @returns {string} Escaped text.
 */
function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * EN: Appends output while keeping in-memory command capture bounded.
 * @param {string} current Current capture.
 * @param {string} next New chunk.
 * @returns {string} Bounded capture.
 */
function appendCapped(current, next) {
  const combined = current + next;
  if (combined.length <= CAPTURE_LIMIT_CHARS) {
    return combined;
  }
  return combined.slice(combined.length - CAPTURE_LIMIT_CHARS);
}

/**
 * EN: Returns the first non-empty output line.
 * @param {string} value Raw output.
 * @returns {string|null} First line or null.
 */
function firstNonEmptyLine(value) {
  return (
    value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? null
  );
}

/**
 * EN: Normalizes whitespace in command snippets.
 * @param {string} value Raw text.
 * @returns {string} One-line text.
 */
function normalizeWhitespace(value) {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * EN: Removes large or redundant option fields from the summary.
 * @param {ReturnType<typeof parseArgs>} options Parsed options.
 * @returns {object} Serializable options.
 */
function sanitizeOptions(options) {
  return {
    dryRun: options.dryRun,
    outDir: options.outDir,
    skillPath: options.skillPath,
    taskUrl: options.taskUrl,
    codexBin: options.codexBin,
    timeoutMs: options.timeoutMs,
    model: options.model,
    profile: options.profile,
    codexConfig: options.codexConfig,
  };
}

void main().catch(async (error) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`[codex-worker-probe] failed: ${message}\n`);
  process.exitCode = 1;
});
