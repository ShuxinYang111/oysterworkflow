import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  DEFAULT_RECORDING_ENABLE_AUDIO,
  DEFAULT_RECORDING_OCR_LANGUAGE_PRIORITY,
  LAB_SESSION_SCHEMA_VERSION,
  LAB_SESSION_STATUS,
  LAB_WORKFLOW_GENERATION_STAGES,
  type LabArtifactKind,
  type LabSession,
} from "./contracts.js";
import {
  normalizeEnableAudio,
  normalizeOcrLanguagePriority,
} from "./recording-config.js";
import { resolveRuntimeConfig } from "../runtime/config.js";

const SESSION_DIR_PREFIX = "ui-recording-codex-";

export interface LabSessionStoreOptions {
  runsRoot: string;
  screenpipeWorkDir: string;
}

/**
 * EN: Resolves the default path config used by the session store.
 * @param overrides optional overrides.
 * @returns normalized store config.
 */
export function resolveLabSessionStoreOptions(
  overrides: Partial<LabSessionStoreOptions> = {},
): LabSessionStoreOptions {
  const runtimeConfig = resolveRuntimeConfig();
  return {
    runsRoot: overrides.runsRoot ?? runtimeConfig.runsRoot,
    screenpipeWorkDir:
      overrides.screenpipeWorkDir ?? runtimeConfig.screenpipeWorkDir,
  };
}

/**
 * EN: Returns the root directory that stores lab sessions.
 * @param overrides optional path overrides.
 * @returns absolute `.runs` path.
 */
export function getLabRunsRoot(
  overrides: Partial<LabSessionStoreOptions> = {},
): string {
  return resolve(resolveLabSessionStoreOptions(overrides).runsRoot);
}

/**
 * EN: Builds one session directory id using local timestamp + random suffix.
 * @param now current time.
 * @returns session id.
 */
export function buildSessionId(now: Date): string {
  return `${SESSION_DIR_PREFIX}${formatLocalStamp(now)}-${buildRandomSuffix()}`;
}

/**
 * EN: Calculates canonical directories and log paths for one session id.
 * @param sessionId session id.
 * @param overrides optional path overrides.
 * @returns session path collection.
 */
export function buildSessionPaths(
  sessionId: string,
  overrides: Partial<LabSessionStoreOptions> = {},
): LabSession["paths"] {
  const sessionDir = resolve(getLabRunsRoot(overrides), sessionId);
  return {
    sessionDir,
    dataDir: join(sessionDir, "screenpipe-data"),
    ingestOutDir: join(sessionDir, "ingest"),
    workflowDir: join(sessionDir, "workflow"),
    skillDir: join(sessionDir, "skill"),
    generalizationDir: join(sessionDir, "generalization"),
    plannerOptimizationDir: join(sessionDir, "planner-optimization"),
    sessionPath: join(sessionDir, "session.json"),
    recordingLogPath: join(sessionDir, "recording.log"),
    queryLogPath: join(sessionDir, "query-mode.log"),
  };
}

/**
 * EN: Creates a new empty session object.
 * @param now current time.
 * @param overrides optional path overrides.
 * @returns initialized session.
 */
export function createSession(
  now: Date,
  overrides: Partial<LabSessionStoreOptions> = {},
): LabSession {
  const storeOptions = resolveLabSessionStoreOptions(overrides);
  const sessionId = buildSessionId(now);
  const iso = now.toISOString();
  const paths = buildSessionPaths(sessionId, storeOptions);

  return {
    schemaVersion: LAB_SESSION_SCHEMA_VERSION,
    sessionId,
    sessionName: null,
    createdAt: iso,
    updatedAt: iso,
    status: "idle",
    paths,
    recordingConfig: {
      ocrLanguagePriority: [...DEFAULT_RECORDING_OCR_LANGUAGE_PRIORITY],
      enableAudio: DEFAULT_RECORDING_ENABLE_AUDIO,
    },
    screenpipe: {
      recordingDataBaseUrl: null,
      recording: {
        state: "idle",
        pid: null,
        port: null,
        workdir: storeOptions.screenpipeWorkDir,
        command: [],
        logPath: paths.recordingLogPath,
        startedAt: null,
        stoppedAt: null,
        exitCode: null,
      },
      queryMode: {
        state: "idle",
        pid: null,
        port: null,
        workdir: storeOptions.screenpipeWorkDir,
        command: [],
        logPath: paths.queryLogPath,
        startedAt: null,
        stoppedAt: null,
        exitCode: null,
      },
    },
    recordingWindow: {
      startedAt: null,
      requestedStopAt: null,
      scheduledStopAt: null,
      autoStopMinutes: null,
    },
    generationProgress: createEmptyGenerationProgress(),
    ingest: {
      latestRunId: null,
      latestRunDir: null,
      summaryPath: null,
      summary: null,
    },
    selection: {
      workflowId: null,
      workflowPath: null,
    },
    workflowDiscovery: {
      latestPath: null,
      workflowCandidates: [],
    },
    skillExtraction: {
      latestOutDir: null,
      skillPath: null,
      summaryPath: null,
      skill: null,
      summary: null,
      artifacts: [],
    },
    generalization: {
      latestOutDir: null,
      summaryPath: null,
      summary: null,
      artifacts: [],
    },
    plannerOptimization: {
      latestOutDir: null,
      skillPath: null,
      summaryPath: null,
      skill: null,
      summary: null,
    },
    warnings: [],
    error: null,
  };
}

/**
 * EN: Ensures that the canonical session directories exist.
 * @param session target session.
 * @returns resolves when directories exist.
 */
export async function ensureSessionDirectories(
  session: LabSession,
): Promise<void> {
  await mkdir(session.paths.sessionDir, { recursive: true });
  await mkdir(session.paths.dataDir, { recursive: true });
  await mkdir(session.paths.ingestOutDir, { recursive: true });
  await mkdir(session.paths.workflowDir, { recursive: true });
  await mkdir(session.paths.skillDir, { recursive: true });
  await mkdir(session.paths.generalizationDir, { recursive: true });
  await mkdir(session.paths.plannerOptimizationDir, { recursive: true });
}

/**
 * EN: Persists the session into `session.json`.
 * @param session session to persist.
 * @returns resolves after write.
 */
export async function writeSession(session: LabSession): Promise<void> {
  const sessionDir = dirname(session.paths.sessionPath);
  const tempPath = join(
    sessionDir,
    `.session.${process.pid ?? "lab"}.${Date.now()}.tmp`,
  );

  await mkdir(sessionDir, { recursive: true });
  await writeFile(tempPath, `${JSON.stringify(session, null, 2)}\n`, "utf8");
  await rename(tempPath, session.paths.sessionPath);
}

/**
 * EN: Reads one persisted session from disk.
 * @param sessionId session id.
 * @param overrides optional path overrides.
 * @returns parsed session.
 */
export async function readSession(
  sessionId: string,
  overrides: Partial<LabSessionStoreOptions> = {},
): Promise<LabSession> {
  const storeOptions = resolveLabSessionStoreOptions(overrides);
  const raw = await readFile(
    buildSessionPaths(sessionId, storeOptions).sessionPath,
    "utf8",
  );
  return normalizeStoredSession(JSON.parse(raw), sessionId, storeOptions);
}

/**
 * EN: Deletes one session directory together with all generated artifacts.
 * @param sessionId session id.
 * @param overrides optional path overrides.
 * @returns resolves after recursive removal.
 */
export async function deleteSessionArtifacts(
  sessionId: string,
  overrides: Partial<LabSessionStoreOptions> = {},
): Promise<void> {
  await rm(buildSessionPaths(sessionId, overrides).sessionDir, {
    recursive: true,
    force: true,
  });
}

/**
 * EN: Deletes sensitive Screenpipe source data and every ingest raw directory after workflow generation succeeds.
 * 中文: 在 workflow 成功生成后删除敏感的 Screenpipe 源数据和所有 ingest raw 目录。
 * @param sessionId canonical lab session id.
 * @param overrides optional path overrides.
 * @returns resolves after every eligible raw-data target has been removed.
 */
export async function deleteSessionRawCaptureArtifacts(
  sessionId: string,
  overrides: Partial<LabSessionStoreOptions> = {},
): Promise<void> {
  const storeOptions = resolveLabSessionStoreOptions(overrides);
  const runsRoot = getLabRunsRoot(storeOptions);
  const paths = buildSessionPaths(sessionId, storeOptions);
  if (
    dirname(paths.sessionDir) !== runsRoot ||
    !basename(paths.sessionDir).startsWith(SESSION_DIR_PREFIX)
  ) {
    throw new Error(
      `Refusing to clean an invalid lab session id: ${sessionId}`,
    );
  }

  const targets = [paths.dataDir];
  const ingestRunsDir = join(paths.ingestOutDir, "runs");
  let entries: Array<{ isDirectory: () => boolean; name: string }> = [];
  try {
    entries = await readdir(ingestRunsDir, { withFileTypes: true });
  } catch (error) {
    if (!isFileSystemError(error, "ENOENT")) {
      throw error;
    }
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      targets.push(join(ingestRunsDir, entry.name, "raw"));
    }
  }

  const results = await Promise.allSettled(
    targets.map((target) => rm(target, { recursive: true, force: true })),
  );
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `Failed to delete raw capture artifacts for session: ${sessionId}`,
    );
  }
}

function isFileSystemError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

/**
 * EN: Lists all persisted lab sessions ordered by newest first.
 * @param overrides optional path overrides.
 * @returns session list.
 */
export async function listSessions(
  overrides: Partial<LabSessionStoreOptions> = {},
): Promise<LabSession[]> {
  const storeOptions = resolveLabSessionStoreOptions(overrides);
  await mkdir(getLabRunsRoot(storeOptions), { recursive: true });
  const entries = await readdir(getLabRunsRoot(storeOptions), {
    withFileTypes: true,
  });
  const sessions: LabSession[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(SESSION_DIR_PREFIX)) {
      continue;
    }

    try {
      sessions.push(await readSession(entry.name, storeOptions));
    } catch {
      // CN/EN: Ignore incomplete directories so one bad session doesn't break the lab.
    }
  }

  return sessions.sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt),
  );
}

function normalizeStoredSession(
  raw: unknown,
  sessionIdHint: string,
  overrides: Partial<LabSessionStoreOptions> = {},
): LabSession {
  const storeOptions = resolveLabSessionStoreOptions(overrides);
  const record = asRecord(raw) ?? {};
  const sessionId = asString(record.sessionId) ?? sessionIdHint;
  const createdAt = asString(record.createdAt) ?? new Date(0).toISOString();
  const updatedAt = asString(record.updatedAt) ?? createdAt;
  const paths = buildSessionPaths(sessionId, storeOptions);
  const recordingConfig = asRecord(record.recordingConfig) ?? {};
  const screenpipe = asRecord(record.screenpipe) ?? {};
  const recordingWindow = asRecord(record.recordingWindow) ?? {};
  const ingest = asRecord(record.ingest) ?? {};
  const selection = asRecord(record.selection) ?? {};
  const workflowDiscovery = asRecord(record.workflowDiscovery) ?? {};
  const skillExtraction = asRecord(record.skillExtraction) ?? {};
  const generalization = asRecord(record.generalization) ?? {};
  const plannerOptimization = asRecord(record.plannerOptimization) ?? {};
  const normalizedSelection = {
    workflowId: asNullableString(selection.workflowId),
    workflowPath: asNullableString(selection.workflowPath),
  };

  return {
    schemaVersion: LAB_SESSION_SCHEMA_VERSION,
    sessionId,
    sessionName: asNullableString(record.sessionName),
    createdAt,
    updatedAt,
    status: normalizeStatus(record.status),
    paths,
    recordingConfig: {
      ocrLanguagePriority: normalizeOcrLanguagePriority(
        recordingConfig.ocrLanguagePriority,
      ),
      enableAudio: normalizeEnableAudio(recordingConfig.enableAudio),
    },
    screenpipe: {
      recordingDataBaseUrl: asNullableString(screenpipe.recordingDataBaseUrl),
      recording: normalizeProcessSnapshot(
        asRecord(screenpipe.recording) ?? {},
        storeOptions.screenpipeWorkDir,
        paths.recordingLogPath,
      ),
      queryMode: normalizeProcessSnapshot(
        asRecord(screenpipe.queryMode) ?? {},
        storeOptions.screenpipeWorkDir,
        paths.queryLogPath,
      ),
    },
    recordingWindow: {
      startedAt: asNullableString(recordingWindow.startedAt),
      requestedStopAt: asNullableString(recordingWindow.requestedStopAt),
      scheduledStopAt: asNullableString(recordingWindow.scheduledStopAt),
      autoStopMinutes: asNullableNumber(recordingWindow.autoStopMinutes),
    },
    generationProgress: normalizeGenerationProgress(
      record.generationProgress,
      ingest.summary,
    ),
    ingest: {
      latestRunId: asNullableString(ingest.latestRunId),
      latestRunDir: asNullableString(ingest.latestRunDir),
      summaryPath: asNullableString(ingest.summaryPath),
      summary: asObjectOrNull(
        ingest.summary,
      ) as LabSession["ingest"]["summary"],
    },
    selection: normalizedSelection,
    workflowDiscovery: {
      latestPath: asNullableString(workflowDiscovery.latestPath),
      workflowCandidates: asArray(
        workflowDiscovery.workflowCandidates,
      ) as LabSession["workflowDiscovery"]["workflowCandidates"],
    },
    skillExtraction: {
      latestOutDir: asNullableString(skillExtraction.latestOutDir),
      skillPath: asNullableString(skillExtraction.skillPath),
      summaryPath: asNullableString(skillExtraction.summaryPath),
      skill: asObjectOrNull(
        skillExtraction.skill,
      ) as LabSession["skillExtraction"]["skill"],
      summary: asObjectOrNull(
        skillExtraction.summary,
      ) as LabSession["skillExtraction"]["summary"],
      artifacts: normalizeStoredBaseSkillArtifacts({
        rawArtifacts: skillExtraction.artifacts,
        legacyState: skillExtraction,
        selection: normalizedSelection,
      }),
    },
    generalization: {
      latestOutDir: asNullableString(generalization.latestOutDir),
      summaryPath: asNullableString(generalization.summaryPath),
      summary: asObjectOrNull(
        generalization.summary,
      ) as LabSession["generalization"]["summary"],
      artifacts: normalizeStoredGeneralizationArtifacts({
        rawArtifacts: generalization.artifacts,
        legacyState: generalization,
      }),
    },
    plannerOptimization: {
      latestOutDir: asNullableString(plannerOptimization.latestOutDir),
      skillPath: asNullableString(plannerOptimization.skillPath),
      summaryPath: asNullableString(plannerOptimization.summaryPath),
      skill: asObjectOrNull(
        plannerOptimization.skill,
      ) as LabSession["plannerOptimization"]["skill"],
      summary: asObjectOrNull(
        plannerOptimization.summary,
      ) as LabSession["plannerOptimization"]["summary"],
    },
    warnings: asStringArray(record.warnings),
    error: normalizeSessionError(record.error),
  };
}

/**
 * CN: 创建持久化工作流生成阶段的空状态。
 * EN: Creates an empty persisted workflow-generation progress state.
 * @returns empty generation progress.
 */
function createEmptyGenerationProgress(): LabSession["generationProgress"] {
  return {
    currentStage: null,
    failedStage: null,
    failedAt: null,
    completedAt: null,
    stages: {
      "analyzing-recording": { startedAt: null, completedAt: null },
      "discovering-workflow": { startedAt: null, completedAt: null },
      "building-skill": { startedAt: null, completedAt: null },
      "building-workflow-graph": { startedAt: null, completedAt: null },
    },
  };
}

/**
 * CN: 兼容读取旧 session，并用真实 ingest 时间补齐分析阶段。
 * EN: Normalizes stored progress and backfills analysis from real ingest timestamps.
 * @param value stored generation progress.
 * @param legacyIngestSummary pre-progress ingest summary.
 * @returns normalized generation progress.
 */
function normalizeGenerationProgress(
  value: unknown,
  legacyIngestSummary: unknown,
): LabSession["generationProgress"] {
  const output = createEmptyGenerationProgress();
  const progress = asRecord(value) ?? {};
  const storedStages = asRecord(progress.stages) ?? {};

  for (const stage of LAB_WORKFLOW_GENERATION_STAGES) {
    const timing = asRecord(storedStages[stage]) ?? {};
    output.stages[stage] = {
      startedAt: asNullableString(timing.startedAt),
      completedAt: asNullableString(timing.completedAt),
    };
  }

  output.currentStage = normalizeGenerationStage(progress.currentStage);
  output.failedStage = normalizeGenerationStage(progress.failedStage);
  output.failedAt = asNullableString(progress.failedAt);
  output.completedAt = asNullableString(progress.completedAt);

  const legacySummary = asRecord(legacyIngestSummary);
  const analysisTiming = output.stages["analyzing-recording"];
  if (
    !analysisTiming.startedAt &&
    !analysisTiming.completedAt &&
    legacySummary
  ) {
    analysisTiming.startedAt = asNullableString(legacySummary.startedAt);
    analysisTiming.completedAt = asNullableString(legacySummary.completedAt);
  }

  return output;
}

function normalizeGenerationStage(
  value: unknown,
): LabSession["generationProgress"]["currentStage"] {
  if (
    typeof value === "string" &&
    LAB_WORKFLOW_GENERATION_STAGES.includes(
      value as (typeof LAB_WORKFLOW_GENERATION_STAGES)[number],
    )
  ) {
    return value as (typeof LAB_WORKFLOW_GENERATION_STAGES)[number];
  }
  return null;
}

function normalizeProcessSnapshot(
  raw: Record<string, unknown>,
  workdir: string,
  logPath: string,
): LabSession["screenpipe"]["recording"] {
  return {
    state: normalizeProcessState(raw?.state),
    pid: asNullableNumber(raw?.pid),
    port: asNullableNumber(raw?.port),
    workdir: asString(raw?.workdir) ?? workdir,
    command: asStringArray(raw?.command),
    logPath: asNullableString(raw?.logPath) ?? logPath,
    startedAt: asNullableString(raw?.startedAt),
    stoppedAt: asNullableString(raw?.stoppedAt),
    exitCode: asNullableNumber(raw?.exitCode),
  };
}

function normalizeStatus(value: unknown): LabSession["status"] {
  return LAB_SESSION_STATUS.includes(value as LabSession["status"])
    ? (value as LabSession["status"])
    : "idle";
}

function normalizeProcessState(
  value: unknown,
): LabSession["screenpipe"]["recording"]["state"] {
  switch (value) {
    case "idle":
    case "starting":
    case "running":
    case "stopped":
      return value;
    default:
      return "idle";
  }
}

function normalizeSessionError(value: unknown): LabSession["error"] {
  const record = asRecord(value) ?? {};
  const message = asString(record.message);
  if (!message) {
    return null;
  }
  const stack = asString(record.stack);
  return stack ? { message, stack } : { message };
}

function normalizeStoredBaseSkillArtifacts(input: {
  rawArtifacts: unknown;
  legacyState: Record<string, unknown>;
  selection: LabSession["selection"];
}): LabSession["skillExtraction"]["artifacts"] {
  const artifacts = asArray(input.rawArtifacts)
    .map((item) => normalizeBaseSkillArtifact(asRecord(item), input.selection))
    .filter(
      (item): item is LabSession["skillExtraction"]["artifacts"][number] =>
        item !== null,
    );
  if (artifacts.length > 0) {
    return artifacts;
  }

  const legacyArtifact = buildLegacyBaseSkillArtifact(
    input.legacyState,
    input.selection,
  );
  return legacyArtifact ? [legacyArtifact] : [];
}

function normalizeBaseSkillArtifact(
  raw: Record<string, unknown> | null,
  selection: LabSession["selection"],
): LabSession["skillExtraction"]["artifacts"][number] | null {
  if (!raw) {
    return null;
  }

  const skill = asObjectOrNull(
    raw.skill,
  ) as LabSession["skillExtraction"]["skill"];
  const summary = asObjectOrNull(
    raw.summary,
  ) as LabSession["skillExtraction"]["summary"];
  const skillPath = asString(raw.skillPath);
  const summaryPath = asString(raw.summaryPath);
  const latestOutDir =
    asString(raw.latestOutDir) ??
    (skillPath
      ? dirname(skillPath)
      : summaryPath
        ? dirname(summaryPath)
        : null);
  const summaryRecord = asRecord(raw.summary) ?? {};
  if (!skill || !summary || !skillPath || !summaryPath || !latestOutDir) {
    return null;
  }

  return {
    workflowId:
      asNullableString(raw.workflowId) ??
      asNullableString(summaryRecord.selectedWorkflowId) ??
      selection.workflowId,
    workflowPath: asNullableString(raw.workflowPath) ?? selection.workflowPath,
    latestOutDir,
    skillPath,
    summaryPath,
    skill,
    summary,
  };
}

function buildLegacyBaseSkillArtifact(
  legacyState: Record<string, unknown>,
  selection: LabSession["selection"],
): LabSession["skillExtraction"]["artifacts"][number] | null {
  return normalizeBaseSkillArtifact(
    {
      workflowId: selection.workflowId,
      workflowPath: selection.workflowPath,
      latestOutDir: legacyState.latestOutDir,
      skillPath: legacyState.skillPath,
      summaryPath: legacyState.summaryPath,
      skill: legacyState.skill,
      summary: legacyState.summary,
    },
    selection,
  );
}

function normalizeStoredGeneralizationArtifacts(input: {
  rawArtifacts: unknown;
  legacyState: Record<string, unknown>;
}): LabSession["generalization"]["artifacts"] {
  const artifacts = asArray(input.rawArtifacts)
    .map((item) => normalizeGeneralizationArtifact(asRecord(item)))
    .filter(
      (item): item is LabSession["generalization"]["artifacts"][number] =>
        item !== null,
    );
  if (artifacts.length > 0) {
    return artifacts;
  }

  const legacyArtifact = buildLegacyGeneralizationArtifact(input.legacyState);
  return legacyArtifact ? [legacyArtifact] : [];
}

function normalizeGeneralizationArtifact(
  raw: Record<string, unknown> | null,
): LabSession["generalization"]["artifacts"][number] | null {
  if (!raw) {
    return null;
  }

  const summary = asObjectOrNull(
    raw.summary,
  ) as LabSession["generalization"]["summary"];
  const summaryPath = asString(raw.summaryPath);
  const summaryRecord = asRecord(raw.summary) ?? {};
  const sourceSkillPath =
    asString(raw.sourceSkillPath) ?? asString(summaryRecord.sourceSkillPath);
  const sourceSummaryPath =
    asString(raw.sourceSummaryPath) ??
    asString(summaryRecord.sourceSummaryPath);
  const latestOutDir =
    asString(raw.latestOutDir) ?? (summaryPath ? dirname(summaryPath) : null);
  if (
    !summary ||
    !summaryPath ||
    !sourceSkillPath ||
    !sourceSummaryPath ||
    !latestOutDir
  ) {
    return null;
  }

  return {
    sourceSkillPath,
    sourceSummaryPath,
    selectedWorkflowId:
      asNullableString(raw.selectedWorkflowId) ??
      asNullableString(summaryRecord.selectedWorkflowId),
    latestOutDir,
    summaryPath,
    summary,
  };
}

function buildLegacyGeneralizationArtifact(
  legacyState: Record<string, unknown>,
): LabSession["generalization"]["artifacts"][number] | null {
  return normalizeGeneralizationArtifact({
    latestOutDir: legacyState.latestOutDir,
    summaryPath: legacyState.summaryPath,
    summary: legacyState.summary,
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    return null;
  }
  return value as Record<string, unknown>;
}

function asObjectOrNull(value: unknown): Record<string, unknown> | null {
  return asRecord(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asStringArray(value: unknown): string[] {
  return asArray(value).filter(
    (item): item is string => typeof item === "string",
  );
}

/**
 * EN: Resolves the latest artifact path for a given artifact kind.
 * @param session session object.
 * @param kind artifact kind.
 * @returns matching absolute path.
 */
export function getArtifactPath(
  session: LabSession,
  kind: LabArtifactKind,
): string | null {
  switch (kind) {
    case "ingest-summary":
      return session.ingest.summaryPath;
    case "workflow":
      return session.workflowDiscovery.latestPath;
    case "skill":
      return session.skillExtraction.skillPath;
    case "skill-summary":
      return session.skillExtraction.summaryPath;
    case "generalization-summary":
      return session.generalization.summaryPath;
    case "planner-skill":
      return session.plannerOptimization.skillPath;
    case "planner-summary":
      return session.plannerOptimization.summaryPath;
    default:
      return null;
  }
}

function formatLocalStamp(date: Date): string {
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${yyyy}${mm}${dd}-${hh}${min}${ss}`;
}

function buildRandomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}
