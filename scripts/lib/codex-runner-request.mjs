import { readFile } from "node:fs/promises";
import path from "node:path";

export const RUNNER_REQUEST_SCHEMA_VERSION =
  "oyster-ai-worker-runner-request-v1";

/**
 * EN: Loads and normalizes an AI Worker runner request JSON file.
 * @param {string} requestPath Request JSON path.
 * @returns {Promise<object>} Normalized flat runner options.
 */
export async function loadRunnerRequestFile(requestPath) {
  const absolutePath = path.resolve(requestPath);
  const request = parseRunnerRequestJson(await readFile(absolutePath, "utf8"));
  return normalizeRunnerRequest(request, {
    baseDir: path.dirname(absolutePath),
    requestPath: absolutePath,
  });
}

/**
 * EN: Parses runner request JSON text.
 * @param {string} text JSON text.
 * @returns {object} Parsed request.
 */
export function parseRunnerRequestJson(text) {
  try {
    const value = JSON.parse(text);
    if (!isPlainObject(value)) {
      throw new Error("request must be a JSON object");
    }
    return value;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid runner request JSON: ${error.message}`);
    }
    throw error;
  }
}

/**
 * EN: Normalizes a structured runner request into Desktop probe options.
 * @param {object} request Structured request.
 * @param {{baseDir:string,requestPath?:string}} context Request context.
 * @returns {object} Normalized flat runner options.
 */
export function normalizeRunnerRequest(request, context) {
  assertKnownKeys(
    request,
    [
      "schemaVersion",
      "skillPath",
      "outDir",
      "browser",
      "computerUse",
      "codex",
      "watchdog",
    ],
    "request",
  );

  if (
    request.schemaVersion !== undefined &&
    request.schemaVersion !== RUNNER_REQUEST_SCHEMA_VERSION
  ) {
    throw new Error(
      `Unsupported runner request schemaVersion: ${String(request.schemaVersion)}`,
    );
  }

  const normalized = {
    requestJsonPath: context.requestPath ?? null,
  };
  if (request.skillPath !== undefined) {
    normalized.skillPath = resolveRequestPath(
      request.skillPath,
      context.baseDir,
      "skillPath",
    );
  }
  if (request.outDir !== undefined) {
    normalized.outDir = resolveRequestPath(
      request.outDir,
      context.baseDir,
      "outDir",
    );
  }

  applyBrowserRequest(normalized, request.browser);
  applyComputerUseRequest(normalized, request.computerUse);
  applyCodexRequest(normalized, request.codex, context.baseDir);
  applyWatchdogRequest(normalized, request.watchdog, context.baseDir);

  return normalized;
}

/**
 * EN: Applies normalized request options to existing CLI options.
 * CLI flags should call this before flag-specific overrides are parsed.
 * @param {object} options Existing options.
 * @param {object} requestOptions Normalized request options.
 * @returns {object} Mutated options.
 */
export function applyRunnerRequestOptions(options, requestOptions) {
  if (!requestOptions) {
    return options;
  }
  for (const [key, value] of Object.entries(requestOptions)) {
    if (value === undefined) {
      continue;
    }
    if (key === "acceptedComputerUseApps") {
      options.acceptedComputerUseApps = [
        ...new Set([...(options.acceptedComputerUseApps ?? []), ...value]),
      ];
    } else {
      options[key] = value;
    }
  }
  return options;
}

function applyBrowserRequest(normalized, browser) {
  if (browser === undefined) {
    return;
  }
  assertPlainObject(browser, "browser");
  assertKnownKeys(browser, ["enabled", "surface", "serveProbePage"], "browser");
  if (browser.enabled !== undefined) {
    normalized.includeBrowser = readBoolean(browser.enabled, "browser.enabled");
  }
  if (browser.surface !== undefined) {
    normalized.browserSurface = readEnum(
      browser.surface,
      ["iab", "chrome"],
      "browser.surface",
    );
  }
  if (browser.serveProbePage !== undefined) {
    normalized.serveProbePage = readNullableBoolean(
      browser.serveProbePage,
      "browser.serveProbePage",
    );
  }
}

function applyComputerUseRequest(normalized, computerUse) {
  if (computerUse === undefined) {
    return;
  }
  assertPlainObject(computerUse, "computerUse");
  assertKnownKeys(
    computerUse,
    [
      "enabled",
      "prepareTextEditTarget",
      "acceptedApps",
      "safeAutoReview",
      "task",
    ],
    "computerUse",
  );
  if (computerUse.enabled !== undefined) {
    normalized.includeComputerUse = readBoolean(
      computerUse.enabled,
      "computerUse.enabled",
    );
  }
  if (computerUse.prepareTextEditTarget !== undefined) {
    normalized.prepareTextEditTarget = readBoolean(
      computerUse.prepareTextEditTarget,
      "computerUse.prepareTextEditTarget",
    );
  }
  if (computerUse.acceptedApps !== undefined) {
    if (!Array.isArray(computerUse.acceptedApps)) {
      throw new Error("computerUse.acceptedApps must be an array");
    }
    normalized.acceptedComputerUseApps = computerUse.acceptedApps.map(
      (app, index) =>
        readNonEmptyString(app, `computerUse.acceptedApps[${index}]`),
    );
  }
  if (computerUse.safeAutoReview === true) {
    normalized.approvalPolicy = "on-request";
    normalized.approvalsReviewer = "auto_review";
  } else if (computerUse.safeAutoReview !== undefined) {
    readBoolean(computerUse.safeAutoReview, "computerUse.safeAutoReview");
  }
  if (computerUse.task !== undefined) {
    normalized.computerUseTask = readNonEmptyString(
      computerUse.task,
      "computerUse.task",
    );
  }
}

function applyCodexRequest(normalized, codex, baseDir) {
  if (codex === undefined) {
    return;
  }
  assertPlainObject(codex, "codex");
  assertKnownKeys(
    codex,
    [
      "bin",
      "socketPath",
      "approvalPolicy",
      "approvalsReviewer",
      "timeoutMs",
      "remoteEnvironmentScope",
      "startRemoteControl",
      "ephemeral",
      "threadTitle",
      "workspaceRoot",
    ],
    "codex",
  );
  if (codex.bin !== undefined) {
    normalized.codexBin = readNonEmptyString(codex.bin, "codex.bin");
  }
  if (codex.socketPath !== undefined) {
    normalized.socketPath = readNonEmptyString(
      codex.socketPath,
      "codex.socketPath",
    );
  }
  if (codex.approvalPolicy !== undefined) {
    normalized.approvalPolicy = readEnum(
      codex.approvalPolicy,
      ["never", "on-request", "on-failure", "untrusted"],
      "codex.approvalPolicy",
    );
  }
  if (codex.approvalsReviewer !== undefined) {
    normalized.approvalsReviewer =
      codex.approvalsReviewer === null
        ? null
        : readEnum(
            codex.approvalsReviewer,
            ["user", "auto_review", "guardian_subagent"],
            "codex.approvalsReviewer",
          );
  }
  if (codex.timeoutMs !== undefined) {
    normalized.timeoutMs = readPositiveInteger(
      codex.timeoutMs,
      "codex.timeoutMs",
    );
  }
  if (codex.remoteEnvironmentScope !== undefined) {
    normalized.remoteEnvironmentScope = readEnum(
      codex.remoteEnvironmentScope,
      ["none", "turn", "thread-turn"],
      "codex.remoteEnvironmentScope",
    );
  }
  if (codex.startRemoteControl !== undefined) {
    normalized.noStartRemoteControl = !readBoolean(
      codex.startRemoteControl,
      "codex.startRemoteControl",
    );
  }
  if (codex.ephemeral !== undefined) {
    normalized.threadEphemeral = readBoolean(
      codex.ephemeral,
      "codex.ephemeral",
    );
  }
  if (codex.threadTitle !== undefined) {
    normalized.threadTitle = readNonEmptyString(
      codex.threadTitle,
      "codex.threadTitle",
    );
  }
  if (codex.workspaceRoot !== undefined) {
    normalized.workspaceRoot = resolveRequestPath(
      codex.workspaceRoot,
      baseDir,
      "codex.workspaceRoot",
    );
  }
}

function applyWatchdogRequest(normalized, watchdog, baseDir) {
  if (watchdog === undefined) {
    return;
  }
  assertPlainObject(watchdog, "watchdog");
  assertKnownKeys(
    watchdog,
    [
      "scan",
      "codexHome",
      "codexBin",
      "resumeMode",
      "allowRealResume",
      "useTtyWrapper",
      "liveWindowMinutes",
      "delaySeconds",
      "maxAttempts",
      "maxSessions",
      "prompt",
      "resumeTimeoutMs",
    ],
    "watchdog",
  );
  if (watchdog.scan !== undefined) {
    normalized.watchdogScan = readBoolean(watchdog.scan, "watchdog.scan");
  }
  if (watchdog.codexHome !== undefined) {
    normalized.watchdogCodexHome = resolveRequestPath(
      watchdog.codexHome,
      baseDir,
      "watchdog.codexHome",
    );
  }
  if (watchdog.codexBin !== undefined) {
    normalized.watchdogCodexBin = readNonEmptyString(
      watchdog.codexBin,
      "watchdog.codexBin",
    );
  }
  if (watchdog.resumeMode !== undefined) {
    normalized.watchdogResumeMode = readEnum(
      watchdog.resumeMode,
      ["dry-run", "execute"],
      "watchdog.resumeMode",
    );
  }
  if (watchdog.allowRealResume !== undefined) {
    normalized.watchdogAllowRealResume = readBoolean(
      watchdog.allowRealResume,
      "watchdog.allowRealResume",
    );
  }
  if (watchdog.useTtyWrapper !== undefined) {
    normalized.watchdogUseTtyWrapper = readBoolean(
      watchdog.useTtyWrapper,
      "watchdog.useTtyWrapper",
    );
  }
  if (watchdog.liveWindowMinutes !== undefined) {
    normalized.watchdogLiveWindowMs =
      readPositiveNumber(
        watchdog.liveWindowMinutes,
        "watchdog.liveWindowMinutes",
      ) * 60_000;
  }
  if (watchdog.delaySeconds !== undefined) {
    normalized.watchdogDelayMs =
      readPositiveNumber(watchdog.delaySeconds, "watchdog.delaySeconds") *
      1_000;
  }
  if (watchdog.maxAttempts !== undefined) {
    normalized.watchdogMaxAttempts = readPositiveInteger(
      watchdog.maxAttempts,
      "watchdog.maxAttempts",
    );
  }
  if (watchdog.maxSessions !== undefined) {
    normalized.watchdogMaxSessions = readPositiveInteger(
      watchdog.maxSessions,
      "watchdog.maxSessions",
    );
  }
  if (watchdog.prompt !== undefined) {
    normalized.watchdogPrompt = readNonEmptyString(
      watchdog.prompt,
      "watchdog.prompt",
    );
  }
  if (watchdog.resumeTimeoutMs !== undefined) {
    normalized.watchdogResumeTimeoutMs = readPositiveInteger(
      watchdog.resumeTimeoutMs,
      "watchdog.resumeTimeoutMs",
    );
  }
}

function resolveRequestPath(value, baseDir, fieldName) {
  const raw = readNonEmptyString(value, fieldName);
  return path.resolve(baseDir, raw);
}

function assertKnownKeys(value, allowedKeys, label) {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) {
      throw new Error(`${label}.${key} is not supported`);
    }
  }
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readBoolean(value, label) {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean`);
  }
  return value;
}

function readNullableBoolean(value, label) {
  if (value === null) {
    return null;
  }
  return readBoolean(value, label);
}

function readNonEmptyString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function readEnum(value, allowed, label) {
  const stringValue = readNonEmptyString(value, label);
  if (!allowed.includes(stringValue)) {
    throw new Error(`${label} must be one of: ${allowed.join(", ")}`);
  }
  return stringValue;
}

function readPositiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return number;
}

function readPositiveNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${label} must be a positive number`);
  }
  return number;
}
