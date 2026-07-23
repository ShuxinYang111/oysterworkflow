import { spawn } from "node:child_process";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

export const DEFAULT_CODEX_HOME = path.join(os.homedir(), ".codex");

/**
 * EN: Scans recent Codex sessions and optionally executes explicitly allowed resume fallback.
 * @param {object} input Scan input.
 * @returns {Promise<object>} Watchdog scan summary.
 */
export async function buildWatchdogFallbackScan(input = {}) {
  const options = {
    allowRealResume: false,
    codexBin: "codex",
    codexHome: DEFAULT_CODEX_HOME,
    delayMs: 10_000,
    liveWindowMs: 30 * 60 * 1_000,
    maxAttempts: 6,
    maxSessions: 5,
    now: new Date(),
    prompt:
      "Continue from the last unfinished task. Do not repeat completed work.",
    protectedCodexHome: DEFAULT_CODEX_HOME,
    resumeBin: input.codexBin ?? "codex",
    resumeMode: "dry-run",
    resumeTimeoutMs: 60_000,
    statePath: null,
    useTtyWrapper: true,
    ...input,
  };
  options.statePath =
    options.statePath ??
    path.join(options.codexHome, "auto-continue-watchdog-state.json");

  const execute = options.resumeMode === "execute";
  const realCodexHome =
    path.resolve(options.codexHome) ===
    path.resolve(options.protectedCodexHome);
  if (execute && realCodexHome && !options.allowRealResume) {
    throw new Error(
      "watchdog resume execution against the real ~/.codex requires --watchdog-allow-real-resume.",
    );
  }

  const now = parseDate(options.now) ?? new Date();
  const indexPath = path.join(options.codexHome, "session_index.jsonl");
  const sessionRoot = path.join(options.codexHome, "sessions");
  const indexEntries = await readJsonlFile(indexPath);
  const sessions = selectRecentWatchdogSessions(indexEntries, {
    liveWindowMs: options.liveWindowMs,
    maxSessions: options.maxSessions,
    now,
  });
  const sessionFileMap = await buildSessionFileMap(sessionRoot);
  const state = await readJsonFile(
    options.statePath,
    createEmptyWatchdogState(),
  );
  const decisions = [];

  for (const session of sessions) {
    const sessionFile = sessionFileMap.get(session.id);
    if (!sessionFile) {
      decisions.push({
        action: "skip",
        command: null,
        dryRun: !execute,
        reason: "missing_session_file",
        session,
      });
      continue;
    }

    const entries = await readJsonlFile(sessionFile);
    const analysis = analyzeWatchdogSessionEvents(entries);
    const decision = decideWatchdogRescue({
      analysis,
      delayMs: options.delayMs,
      maxAttempts: options.maxAttempts,
      now,
      session: { ...session, sessionFile },
      state,
    });
    decisions.push({
      ...decision,
      command:
        decision.action === "resume"
          ? buildWatchdogResumeCommand({
              codexBin: options.resumeBin,
              prompt: options.prompt,
              sessionId: session.id,
              useTtyWrapper: options.useTtyWrapper,
            })
          : null,
      dryRun: !execute,
    });
  }

  if (execute) {
    for (const decision of decisions) {
      if (decision.action !== "resume" || !decision.command) {
        continue;
      }
      const result = await runCommand({
        args: decision.command.args,
        command: decision.command.command,
        timeoutMs: options.resumeTimeoutMs,
      });
      decision.result = {
        durationMs: result.durationMs,
        exitCode: result.exitCode,
        ok: result.exitCode === 0,
        signal: result.signal ?? null,
        stderrSnippet: normalizeWhitespace(result.stderr).slice(0, 1000),
        stdoutSnippet: normalizeWhitespace(result.stdout).slice(0, 1000),
        timedOut: result.timedOut === true,
      };
      recordWatchdogRescueAttempt(state, decision, decision.result);
    }
    await writeJson(options.statePath, state);
  }

  return {
    enabled: true,
    dryRun: !execute,
    indexPath,
    sessionRoot,
    statePath: options.statePath,
    allowRealResume: options.allowRealResume,
    resumeBin: options.resumeBin,
    liveWindowMs: options.liveWindowMs,
    delayMs: options.delayMs,
    maxAttempts: options.maxAttempts,
    maxSessions: options.maxSessions,
    resumeMode: options.resumeMode,
    resumeTimeoutMs: options.resumeTimeoutMs,
    useTtyWrapper: options.useTtyWrapper,
    recentSessionCount: sessions.length,
    scannedSessionCount: decisions.length,
    resumeCandidateCount: decisions.filter(
      (decision) => decision.action === "resume",
    ).length,
    executedResumeCount: decisions.filter(
      (decision) => decision.action === "resume" && decision.result,
    ).length,
    decisions,
  };
}

/**
 * EN: Reads a JSONL file into parsed objects.
 * @param {string} filePath JSONL path.
 * @returns {Promise<object[]>} Parsed entries.
 */
export async function readJsonlFile(filePath) {
  if (!(await pathExists(filePath))) {
    return [];
  }
  return parseJsonl(await readFile(filePath, "utf8"));
}

/**
 * EN: Parses newline-delimited JSON.
 * @param {string} text JSONL text.
 * @returns {object[]} Parsed entries.
 */
export function parseJsonl(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => parseJsonOrNull(line))
    .filter(Boolean);
}

/**
 * EN: Selects recent sessions from Codex session_index.jsonl entries.
 * @param {object[]} indexEntries Session index entries.
 * @param {{liveWindowMs:number,maxSessions:number,now:Date}} options Selection options.
 * @returns {object[]} Recent sessions.
 */
export function selectRecentWatchdogSessions(indexEntries, options) {
  const nowMs = options.now.getTime();
  const byId = new Map();

  for (const entry of indexEntries) {
    const id = String(entry?.id ?? "").trim();
    const updatedAt = parseDate(entry?.updated_at);
    if (!id || !updatedAt) {
      continue;
    }
    const existing = byId.get(id);
    if (!existing || updatedAt.getTime() > existing.updatedAtMs) {
      byId.set(id, {
        id,
        threadName: String(entry?.thread_name ?? ""),
        updatedAt: updatedAt.toISOString(),
        updatedAtMs: updatedAt.getTime(),
      });
    }
  }

  return [...byId.values()]
    .filter((session) => nowMs - session.updatedAtMs <= options.liveWindowMs)
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs)
    .slice(0, options.maxSessions)
    .map((session) => ({
      id: session.id,
      threadName: session.threadName,
      updatedAt: session.updatedAt,
    }));
}

/**
 * EN: Maps Codex session ids to session JSONL files.
 * @param {string} sessionRoot Session root directory.
 * @returns {Promise<Map<string,string>>} Session file map.
 */
export async function buildSessionFileMap(sessionRoot) {
  const files = await listJsonlFiles(sessionRoot);
  const map = new Map();
  for (const filePath of files) {
    const match = filePath.match(
      /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i,
    );
    if (match) {
      map.set(match[1], filePath);
    }
  }
  return map;
}

/**
 * EN: Recursively lists JSONL files.
 * @param {string} directory Directory.
 * @returns {Promise<string[]>} JSONL files.
 */
export async function listJsonlFiles(directory) {
  if (!(await pathExists(directory))) {
    return [];
  }

  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listJsonlFiles(fullPath)));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * EN: Analyzes terminal state signals from a Codex session JSONL.
 * @param {object[]} entries Session events.
 * @returns {object} Last signal and status.
 */
export function analyzeWatchdogSessionEvents(entries) {
  let lastError = null;
  let lastSignal = null;

  for (const entry of entries) {
    const signal = signalFromWatchdogEntry(entry);
    if (!signal) {
      continue;
    }
    lastSignal = signal;
    if (signal.kind === "error") {
      lastError = signal;
    }
  }

  return {
    lastError,
    lastSignal,
    status: lastSignal?.kind ?? "unknown",
  };
}

/**
 * EN: Extracts a watchdog-relevant signal from a session event.
 * @param {object} entry Session event.
 * @returns {object|null} Signal.
 */
export function signalFromWatchdogEntry(entry) {
  const timestamp = eventTimestamp(entry);
  const payload = entry?.payload ?? {};

  if (entry?.type === "event_msg") {
    if (payload.type === "error") {
      return { kind: "error", payload, timestamp };
    }
    if (
      payload.type === "turn_aborted" ||
      payload.type === "interrupted" ||
      payload.reason === "interrupted"
    ) {
      return { kind: "interrupted", payload, timestamp };
    }
    if (payload.type === "task_started") {
      return { kind: "started", payload, timestamp };
    }
    if (payload.type === "task_complete") {
      return { kind: "complete", payload, timestamp };
    }
    if (payload.type === "user_message") {
      return { kind: "user_message", payload, timestamp };
    }
  }

  if (
    entry?.type === "response_item" &&
    payload.type === "message" &&
    payload.role === "user"
  ) {
    return { kind: "user_message", payload, timestamp };
  }

  return null;
}

/**
 * EN: Decides whether a watchdog fallback would resume a session.
 * @param {{analysis:object,delayMs:number,maxAttempts:number,now:Date,session:object,state:object}} input Decision input.
 * @returns {object} Decision.
 */
export function decideWatchdogRescue(input) {
  const session = input.session;
  const safeAnalysis = sanitizeWatchdogAnalysis(input.analysis);
  if (input.analysis.status === "interrupted") {
    return {
      action: "skip",
      analysis: safeAnalysis,
      reason: "interrupted",
      session,
    };
  }
  if (
    input.analysis.status !== "error" ||
    !input.analysis.lastError?.timestamp
  ) {
    return {
      action: "skip",
      analysis: safeAnalysis,
      reason: `status_${input.analysis.status}`,
      session,
    };
  }

  const errorAtMs = parseDate(input.analysis.lastError.timestamp)?.getTime();
  if (!errorAtMs) {
    return {
      action: "skip",
      analysis: safeAnalysis,
      reason: "missing_error_time",
      session,
    };
  }

  const ageMs = input.now.getTime() - errorAtMs;
  if (ageMs < input.delayMs) {
    return {
      action: "wait",
      analysis: safeAnalysis,
      errorAt: input.analysis.lastError.timestamp.toISOString(),
      remainingMs: input.delayMs - ageMs,
      session,
    };
  }

  const fingerprint = fingerprintWatchdogError(
    input.analysis.lastError.payload,
  );
  const key = `${session.id}:${fingerprint}`;
  const attempt = input.state?.attempts?.[key] ?? { count: 0 };
  const errorAt = input.analysis.lastError.timestamp.toISOString();
  if (attempt.lastErrorAt === errorAt) {
    return {
      action: "skip",
      analysis: safeAnalysis,
      errorAt,
      fingerprint,
      reason: "already_attempted",
      session,
    };
  }
  if (attempt.count >= input.maxAttempts) {
    return {
      action: "limit_reached",
      analysis: safeAnalysis,
      count: attempt.count,
      errorAt,
      fingerprint,
      session,
    };
  }

  return {
    action: "resume",
    analysis: safeAnalysis,
    attemptNumber: attempt.count + 1,
    errorAt,
    fingerprint,
    key,
    session,
  };
}

/**
 * EN: Builds the command shape a real watchdog fallback would run.
 * @param {{codexBin:string,prompt:string,sessionId:string,useTtyWrapper?:boolean}} input Command input.
 * @returns {object} Command shape.
 */
export function buildWatchdogResumeCommand(input) {
  if (input.useTtyWrapper === false) {
    return {
      command: input.codexBin,
      args: ["resume", input.sessionId, input.prompt],
      directCommand: {
        command: input.codexBin,
        args: ["resume", input.sessionId, input.prompt],
      },
    };
  }

  return {
    command: "script",
    args: [
      "-q",
      "/dev/null",
      input.codexBin,
      "resume",
      input.sessionId,
      input.prompt,
    ],
    directCommand: {
      command: input.codexBin,
      args: ["resume", input.sessionId, input.prompt],
    },
  };
}

/**
 * EN: Creates an empty watchdog retry state.
 * @returns {object} Empty state.
 */
export function createEmptyWatchdogState() {
  return {
    attempts: {},
    version: 1,
  };
}

/**
 * EN: Records a resume attempt in watchdog retry state.
 * @param {object} state Mutable watchdog state.
 * @param {object} decision Resume decision.
 * @param {object} result Resume execution result.
 * @returns {object} Updated state.
 */
export function recordWatchdogRescueAttempt(state, decision, result = {}) {
  if (decision.action !== "resume" || !decision.key) {
    return state;
  }
  const current = state.attempts?.[decision.key] ?? { count: 0 };
  state.attempts =
    state.attempts && typeof state.attempts === "object" ? state.attempts : {};
  state.attempts[decision.key] = {
    count: current.count + 1,
    firstAttemptAt: current.firstAttemptAt ?? new Date().toISOString(),
    lastAttemptAt: new Date().toISOString(),
    lastErrorAt: decision.errorAt,
    lastResult: result.ok === false ? "failed" : "ok",
    lastResultDetail:
      result.stderrSnippet || result.stdoutSnippet || result.error
        ? String(
            result.stderrSnippet || result.stdoutSnippet || result.error,
          ).slice(0, 500)
        : "",
  };
  return state;
}

/**
 * EN: Fingerprints a watchdog error without storing full sensitive payloads.
 * @param {object} payload Error payload.
 * @returns {string} Fingerprint.
 */
export function fingerprintWatchdogError(payload) {
  const raw = [
    payload?.message,
    typeof payload?.codex_error_info === "string"
      ? payload.codex_error_info
      : JSON.stringify(payload?.codex_error_info ?? ""),
  ]
    .filter(Boolean)
    .join(" ");
  const text = raw.toLowerCase();
  if (text.includes("insufficient_balance")) {
    return "insufficient_balance";
  }
  if (text.includes("cyber_policy")) {
    return "cyber_policy";
  }
  if (text.includes("stream disconnected")) {
    return "stream_disconnected";
  }
  const statusMatch = text.match(/(?:status|http_status_code)["\s:,-]+(\d{3})/);
  if (statusMatch) {
    return `http_${statusMatch[1]}`;
  }
  return (
    text
      .replace(/https?:\/\/\S+/g, "url")
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "uuid")
      .replace(/\b[0-9a-f]{12,}\b/g, "hex")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) || "unknown_error"
  );
}

/**
 * EN: Sanitizes watchdog analysis for summary output.
 * @param {object} analysis Raw analysis.
 * @returns {object} Safe analysis.
 */
export function sanitizeWatchdogAnalysis(analysis) {
  return {
    lastError: sanitizeWatchdogSignal(analysis.lastError),
    lastSignal: sanitizeWatchdogSignal(analysis.lastSignal),
    status: analysis.status,
  };
}

/**
 * EN: Sanitizes a session signal for summary output.
 * @param {object|null} signal Raw signal.
 * @returns {object|null} Safe signal.
 */
export function sanitizeWatchdogSignal(signal) {
  if (!signal) {
    return null;
  }
  return {
    kind: signal.kind,
    timestamp: signal.timestamp?.toISOString?.() ?? null,
    payloadType: signal.payload?.type ?? null,
    reason: signal.payload?.reason ?? null,
    messageSnippet: normalizeWhitespace(signal.payload?.message ?? "").slice(
      0,
      240,
    ),
  };
}

/**
 * EN: Extracts a timestamp from a session event.
 * @param {object} entry Session event.
 * @returns {Date|null} Timestamp.
 */
export function eventTimestamp(entry) {
  return parseDate(entry?.timestamp) ?? parseDate(entry?.payload?.timestamp);
}

/**
 * EN: Checks if a path exists.
 * @param {string} filePath Path.
 * @returns {Promise<boolean>} Existence.
 */
export async function pathExists(filePath) {
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
export async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/**
 * EN: Parses JSON or returns null.
 * @param {string} text JSON text.
 * @returns {object|null} Parsed value.
 */
export function parseJsonOrNull(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * EN: Reads JSON or returns a fallback value.
 * @param {string} filePath JSON path.
 * @param {object} fallback Fallback value.
 * @returns {Promise<object>} Parsed object or fallback.
 */
export async function readJsonFile(filePath, fallback) {
  if (!(await pathExists(filePath))) {
    return fallback;
  }
  return parseJsonOrNull(await readFile(filePath, "utf8")) ?? fallback;
}

/**
 * EN: Parses a date-like value.
 * @param {unknown} value Raw value.
 * @returns {Date|null} Parsed date.
 */
export function parseDate(value) {
  const date = value instanceof Date ? value : new Date(String(value ?? ""));
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * EN: Normalizes whitespace.
 * @param {string} value Input value.
 * @returns {string} Normalized text.
 */
export function normalizeWhitespace(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * EN: Runs a child process and captures output.
 * @param {{command:string,args:string[],timeoutMs:number,cwd?:string}} input Command input.
 * @returns {Promise<object>} Result.
 */
export function runCommand(input) {
  const startedAt = performance.now();
  return new Promise((resolveCommand) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, input.timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
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
