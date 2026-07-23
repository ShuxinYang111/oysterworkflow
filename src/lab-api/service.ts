import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { EventEmitter } from "node:events";
import {
  parseOpenClawSkillInstallCliArgs,
  runOpenClawSkillExport,
  runOpenClawSkillInstall,
} from "../cli/commands/openclaw-skill.js";
import {
  runDiscoverWorkflows,
  type RunDiscoverWorkflowsOptions,
} from "../cli/commands/discover-workflows.js";
import {
  runExtractSkillLlm,
  type RunExtractSkillLlmOptions,
} from "../cli/commands/extract-skill-llm.js";
import { runIngest, type RunIngestOptions } from "../cli/commands/ingest.js";
import { ScreenpipeClient } from "../screenpipe/client.js";
import type { WorkflowDiscoveryArtifact } from "../skill/extract-openclaw-llm.js";
import {
  assertWorkflowGraphCompatibility,
  materializeWorkflowGraphArtifacts,
} from "../skill/workflow-graph.js";
import type { OpenClawSkill, WorkflowCandidate } from "../types/contracts.js";
import {
  runLabGeneralization,
  runLabPlannerOptimization,
  type RunLabGeneralizationOptions,
  type RunLabPlannerOptimizationOptions,
} from "./skill-components.js";
import {
  readLabLlmConfig,
  resolveLabLlmCredentials,
  writeLabLlmConfig,
} from "./llm-config.js";
import { discoverLlmModels } from "./llm-models.js";
import {
  listLabOpenClawPersonalSkills,
  uninstallLabOpenClawPersonalSkill,
  type UninstallLabOpenClawPersonalSkillOptions,
} from "./openclaw-skills.js";
import {
  listInstalledSkills,
  listSkillManagerPathCandidates,
  readSkillManagerConfig,
  uninstallInstalledSkill,
  writeSkillManagerConfig,
} from "./skill-manager.js";
import type {
  ArtifactResponse,
  LabLlmConfigUpdateInput,
  LabLlmModelsInput,
  LabManagedSkill,
  LabOpenClawInstallResult,
  LabOpenClawInstallSourceType,
  LabOpenClawPersonalSkill,
  LabOpenClawUninstallResult,
  LabProcessExitResult,
  LabProcessHandle,
  LabScreenpipeLanguage,
  LabSession,
  LabSessionError,
  LabSkillManagerConfig,
  LabSkillManagerExportResult,
  LlmConfigResponse,
  LlmModelsResponse,
  PlannerOptimizationSourceType,
  RecorderBootstrapResponse,
  RecorderPermissionItem,
  RecorderPermissionKind,
  RecorderPermissionsResponse,
  RecorderStateResponse,
  SkillExtractionSummary,
  SkillManagerPathCandidate,
  LabWorkflowGenerationStage,
} from "./contracts.js";
import { LAB_WORKFLOW_GENERATION_STAGES } from "./contracts.js";
import {
  normalizeEnableAudio,
  normalizeOcrLanguagePriority,
} from "./recording-config.js";
import { getArtifactPath } from "./session-store.js";
import { selectPreferredWorkflowCandidate } from "./workflow-selection.js";
import {
  createSession,
  deleteSessionArtifacts,
  deleteSessionRawCaptureArtifacts,
  ensureSessionDirectories,
  listSessions,
  readSession,
  type LabSessionStoreOptions,
  resolveLabSessionStoreOptions,
  writeSession,
} from "./session-store.js";
import {
  buildRuntimeWorkflowFamilyCatalog,
  collectSessionWorkflowFamilyArtifactSources,
  type WorkflowFamilyArtifactSource,
} from "./workflow-family-catalog.js";
import { resolveRuntimeConfig, type RuntimeConfig } from "../runtime/config.js";
import { signalProcessGroup } from "../process/child-process.js";
import { terminateWindowsProcessTree } from "../process/windows-tree.js";

const HEALTH_POLL_INTERVAL_MS = 1_000;
const RECORDING_READY_TIMEOUT_MS = 20_000;
const RECORDER_BOOTSTRAP_READY_TIMEOUT_MS = 1_200_000;
const QUERY_READY_TIMEOUT_MS = 20_000;
const PROCESS_STOP_TIMEOUT_MS = 15_000;
const RECORDING_PROCESS_STOP_TIMEOUT_MS = 30_000;
const PROCESS_FORCE_TIMEOUT_MS = 5_000;
const SHUTDOWN_PROCESS_INTERRUPT_TIMEOUT_MS = 650;
const SHUTDOWN_PROCESS_TERMINATE_TIMEOUT_MS = 500;
const SHUTDOWN_PROCESS_KILL_TIMEOUT_MS = 350;
const SHUTDOWN_AUXILIARY_DRAIN_TIMEOUT_MS = 2_000;
const SESSION_NAME_PREFIX_MAX_CHARS = 20;
const QUICK_HEALTH_PROBE_TIMEOUT_MS = 2_500;
const RECORDER_PERMISSION_PROBE_TIMEOUT_MS = 8_000;
const RECORDER_PERMISSION_GRANTED_CACHE_TTL_MS = 15_000;
const RECORDER_PERMISSION_BLOCKED_CACHE_TTL_MS = 10_000;
const PROCESS_COMMAND_PROBE_TIMEOUT_MS = 5_000;
const PROCESS_COMMAND_PROBE_MAX_BYTES = 64 * 1024;
const ENABLE_SCREENPIPE_PERMISSION_GATE = false;
const LAB_API_SHUTDOWN_WARNING =
  "lab-api shut down while the session was still in progress; managed processes were stopped when possible, and the session was marked as interrupted so you can continue from the saved progress.";
const LAB_API_RESTART_WARNING =
  "lab-api restarted while the session was still in progress; lingering managed processes were stopped when possible, and the session was marked as interrupted so you can continue from the saved progress.";
const RECORDER_BOOTSTRAP_CANCELLED_MESSAGE =
  "Recorder bootstrap was cancelled because the app is shutting down";
const LAB_API_SHUTDOWN_ERROR_MESSAGE =
  "Lab service is shutting down and cannot start another operation. / Lab 服务正在关闭，无法启动新操作。";

type LabMutatingAction<T> = () => Promise<T>;

interface EnqueueMutationOptions {
  allowDuringShutdown?: boolean;
  handlesShutdownCancellation?: boolean;
}

interface ProcessStopOptions {
  gracefulTimeoutMs?: number;
  terminateTimeoutMs?: number;
  killTimeoutMs?: number;
}

const SHUTDOWN_PROCESS_STOP_OPTIONS: Readonly<ProcessStopOptions> = {
  gracefulTimeoutMs: SHUTDOWN_PROCESS_INTERRUPT_TIMEOUT_MS,
  terminateTimeoutMs: SHUTDOWN_PROCESS_TERMINATE_TIMEOUT_MS,
  killTimeoutMs: SHUTDOWN_PROCESS_KILL_TIMEOUT_MS,
};

class RecorderBootstrapCancelledError extends Error {
  constructor() {
    super(RECORDER_BOOTSTRAP_CANCELLED_MESSAGE);
    this.name = "RecorderBootstrapCancelledError";
  }
}

class LabProcessFailureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LabProcessFailureError";
  }
}

interface MonitoredLabProcessHandle extends LabProcessHandle {
  onceFailure(): Promise<never>;
}

interface HealthWaitOptions {
  signal?: AbortSignal;
  processHandle?: LabProcessHandle;
  processLabel?: string;
}

interface LabRuntimeEntry {
  recordingProcess: LabProcessHandle | null;
  queryProcess: LabProcessHandle | null;
  recordingMode: "managed" | "reused";
  recordingBaseUrl: string | null;
  screenpipeApiToken: string | null;
  allowRecordingExit: boolean;
  allowQueryExit: boolean;
  autoStopTimer: NodeJS.Timeout | null;
}

interface SpawnProcessInput {
  command: string[];
  cwd: string;
  logPath: string;
  env?: Record<string, string>;
}

interface PersistedProcessStopInput {
  pid: number;
  expectedCommand: string[];
}

interface RecorderPermissionProbeResult {
  checkedAt: string;
  health: Record<string, unknown> | null;
  logPath: string;
  logText: string;
  error: string | null;
}

interface DeleteScreenpipeTimeRangeInput {
  baseUrl: string;
  start: string;
  end: string;
  apiToken: string | null;
}

interface LabServiceDependencies {
  runtimeConfig: RuntimeConfig;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  getLlmConfigPath: () => string;
  getSkillManagerConfigPath: () => string;
  isPortAvailable: (port: number) => Promise<boolean>;
  findFreePort: (fromPort: number) => Promise<number>;
  spawnProcess: (input: SpawnProcessInput) => Promise<LabProcessHandle>;
  isPersistedProcessAlive: (
    input: PersistedProcessStopInput,
  ) => Promise<boolean>;
  stopPersistedProcess: (
    input: PersistedProcessStopInput,
  ) => Promise<LabProcessExitResult | null>;
  probeHealth: (baseUrl: string) => Promise<Record<string, unknown>>;
  deleteScreenpipeTimeRangeFn: (
    input: DeleteScreenpipeTimeRangeInput,
  ) => Promise<void>;
  discoverLlmModelsFn: typeof discoverLlmModels;
  runIngestFn: (
    options: RunIngestOptions,
  ) => Promise<Awaited<ReturnType<typeof runIngest>>>;
  runDiscoverWorkflowsFn: (
    options: RunDiscoverWorkflowsOptions,
  ) => Promise<Awaited<ReturnType<typeof runDiscoverWorkflows>>>;
  runExtractSkillLlmFn: (
    options: RunExtractSkillLlmOptions,
  ) => Promise<Awaited<ReturnType<typeof runExtractSkillLlm>>>;
  listWorkflowFamilyArtifactSourcesFn: () => Promise<
    WorkflowFamilyArtifactSource[]
  >;
  runGeneralizationFn: (
    options: RunLabGeneralizationOptions,
  ) => Promise<Awaited<ReturnType<typeof runLabGeneralization>>>;
  runPlannerOptimizationFn: (
    options: RunLabPlannerOptimizationOptions,
  ) => Promise<Awaited<ReturnType<typeof runLabPlannerOptimization>>>;
  runOpenClawSkillInstallFn: (
    options: ReturnType<typeof parseOpenClawSkillInstallCliArgs>,
  ) => Promise<Awaited<ReturnType<typeof runOpenClawSkillInstall>>>;
  runSkillManagerExportFn: (
    options: ReturnType<typeof parseOpenClawSkillInstallCliArgs>,
  ) => Promise<Awaited<ReturnType<typeof runOpenClawSkillExport>>>;
  listOpenClawPersonalSkillsFn: () => Promise<LabOpenClawPersonalSkill[]>;
  uninstallOpenClawPersonalSkillFn: (
    options: UninstallLabOpenClawPersonalSkillOptions,
  ) => Promise<LabOpenClawUninstallResult>;
  readSkillManagerConfigFn: (
    configPath: string,
  ) => Promise<LabSkillManagerConfig>;
  writeSkillManagerConfigFn: (
    input: {
      skillPath: string;
      now?: Date;
    },
    configPath: string,
  ) => Promise<LabSkillManagerConfig>;
  listSkillManagerPathCandidatesFn: () => Promise<SkillManagerPathCandidate[]>;
  listInstalledSkillsFn: (input: {
    skillPath: string | null;
  }) => Promise<LabManagedSkill[]>;
  uninstallInstalledSkillFn: (input: {
    installRoot: string;
    installName: string;
    confirmName?: string;
  }) => Promise<LabOpenClawUninstallResult>;
}

export interface StartRecordingInput {
  autoStopMinutes?: number;
  ocrLanguagePriority?: LabScreenpipeLanguage[];
  enableAudio?: boolean;
}

export interface SkillExtractionInput {
  workflowPath: string;
  workflowId: string;
  generationGuidance?: string;
}

export interface SaveWorkflowArtifactInput {
  workflowCandidates: WorkflowCandidate[];
  selectedWorkflowId?: string | null;
}

export interface GeneralizationInput {
  skillPath: string;
}

export interface PlannerOptimizationInput {
  sourceType: PlannerOptimizationSourceType;
  skillPath: string;
}

export interface OpenClawInstallInput {
  sourceType: LabOpenClawInstallSourceType;
  skillPath: string;
}

export interface OpenClawUninstallInput {
  confirmName?: string;
}

export interface SkillManagerConfigInput {
  skillPath: string;
}

export interface SkillManagerExportInput {
  sourceType: LabOpenClawInstallSourceType;
  skillPath: string;
}

export interface UpdateSkillArtifactInput {
  sourceType: LabOpenClawInstallSourceType;
  skillPath: string;
  skill: OpenClawSkill;
}

export interface SkillManagerUninstallInput {
  confirmName?: string;
}

export interface CheckRecorderPermissionsInput {
  forceRefresh?: boolean;
}

export interface LabService {
  getRecorderState(): Promise<RecorderStateResponse>;
  checkRecorderPermissions(
    input?: CheckRecorderPermissionsInput,
  ): Promise<RecorderPermissionsResponse>;
  bootstrapRecorder(
    input?: StartRecordingInput,
  ): Promise<RecorderBootstrapResponse>;
  getLlmConfig(): Promise<LlmConfigResponse>;
  updateLlmConfig(input: LabLlmConfigUpdateInput): Promise<LlmConfigResponse>;
  listLlmModels(input: LabLlmModelsInput): Promise<LlmModelsResponse>;
  getSkillManagerConfig(): Promise<{
    path: string;
    config: LabSkillManagerConfig;
  }>;
  updateSkillManagerConfig(input: SkillManagerConfigInput): Promise<{
    path: string;
    config: LabSkillManagerConfig;
  }>;
  listSkillManagerPathCandidates(): Promise<SkillManagerPathCandidate[]>;
  listInstalledSkills(): Promise<LabManagedSkill[]>;
  exportSkillToManager(
    sessionId: string,
    input: SkillManagerExportInput,
  ): Promise<LabSkillManagerExportResult>;
  uninstallInstalledSkill(
    installName: string,
    input: SkillManagerUninstallInput,
  ): Promise<LabOpenClawUninstallResult>;
  listSessions(): Promise<LabSession[]>;
  getSession(sessionId: string): Promise<LabSession>;
  deleteSession(sessionId: string): Promise<void>;
  listOpenClawSkills(): Promise<LabOpenClawPersonalSkill[]>;
  installOpenClawSkill(
    sessionId: string,
    input: OpenClawInstallInput,
  ): Promise<LabOpenClawInstallResult>;
  uninstallOpenClawSkill(
    installName: string,
    input: OpenClawUninstallInput,
  ): Promise<LabOpenClawUninstallResult>;
  shutdown(): Promise<void>;
  startRecording(input: StartRecordingInput): Promise<LabSession>;
  stopRecording(): Promise<LabSession>;
  scheduleTimedStop(autoStopMinutes: number): Promise<LabSession>;
  retryIngest(sessionId: string): Promise<LabSession>;
  runWorkflowDiscovery(sessionId: string): Promise<LabSession>;
  saveWorkflowArtifact(
    sessionId: string,
    input: SaveWorkflowArtifactInput,
  ): Promise<LabSession>;
  runSkillExtraction(
    sessionId: string,
    input: SkillExtractionInput,
  ): Promise<LabSession>;
  runGeneralization(
    sessionId: string,
    input: GeneralizationInput,
  ): Promise<LabSession>;
  runPlannerOptimization(
    sessionId: string,
    input: PlannerOptimizationInput,
  ): Promise<LabSession>;
  updateSkillArtifact(
    sessionId: string,
    input: UpdateSkillArtifactInput,
  ): Promise<LabSession>;
  getArtifact(
    sessionId: string,
    kind: ArtifactResponse["kind"],
  ): Promise<ArtifactResponse>;
}

/**
 * EN: Creates the lab service and repairs stale in-flight sessions on startup.
 * @param overrides optional dependency overrides for tests.
 * @returns reusable lab service.
 */
export async function createLabService(
  overrides: Partial<LabServiceDependencies> = {},
): Promise<LabService> {
  const runtimeConfig = overrides.runtimeConfig ?? resolveRuntimeConfig();
  const dependencies: LabServiceDependencies = {
    runtimeConfig,
    now: () => new Date(),
    sleep: (ms) => new Promise((resolveTimer) => setTimeout(resolveTimer, ms)),
    getLlmConfigPath: () => runtimeConfig.llmConfigPath,
    getSkillManagerConfigPath: () => runtimeConfig.skillManagerConfigPath,
    isPortAvailable,
    findFreePort,
    spawnProcess: spawnLoggedProcess,
    isPersistedProcessAlive: isPersistedProcessAliveByPid,
    stopPersistedProcess: stopPersistedProcessByPid,
    probeHealth: async (baseUrl) => new ScreenpipeClient(baseUrl).health(),
    deleteScreenpipeTimeRangeFn: async (input) => {
      await new ScreenpipeClient(input.baseUrl, {
        apiToken: input.apiToken,
      }).deleteTimeRange({
        start: input.start,
        end: input.end,
      });
    },
    discoverLlmModelsFn: discoverLlmModels,
    runIngestFn: runIngest,
    runDiscoverWorkflowsFn: runDiscoverWorkflows,
    runExtractSkillLlmFn: runExtractSkillLlm,
    listWorkflowFamilyArtifactSourcesFn: async () => [],
    runGeneralizationFn: runLabGeneralization,
    runPlannerOptimizationFn: runLabPlannerOptimization,
    runOpenClawSkillInstallFn: runOpenClawSkillInstall,
    runSkillManagerExportFn: runOpenClawSkillExport,
    listOpenClawPersonalSkillsFn: () => listLabOpenClawPersonalSkills(),
    uninstallOpenClawPersonalSkillFn: uninstallLabOpenClawPersonalSkill,
    readSkillManagerConfigFn: readSkillManagerConfig,
    writeSkillManagerConfigFn: writeSkillManagerConfig,
    listSkillManagerPathCandidatesFn: listSkillManagerPathCandidates,
    listInstalledSkillsFn: listInstalledSkills,
    uninstallInstalledSkillFn: uninstallInstalledSkill,
    ...overrides,
  };
  const sessionStoreOptions: LabSessionStoreOptions =
    resolveLabSessionStoreOptions({
      runsRoot: dependencies.runtimeConfig.runsRoot,
      screenpipeWorkDir: dependencies.runtimeConfig.screenpipeWorkDir,
    });

  const runtimeBySession = new Map<string, LabRuntimeEntry>();
  let activeSessionId: string | null = null;
  let mutationQueue = Promise.resolve();
  let latestRecorderPermissionCheck: RecorderPermissionsResponse | null = null;
  let recorderPermissionCheckPromise: Promise<RecorderPermissionsResponse> | null =
    null;
  let recorderBootstrapPromise: Promise<RecorderBootstrapResponse> | null =
    null;
  let recorderBootstrapAbortController: AbortController | null = null;
  const serviceAbortController = new AbortController();
  let shutdownRequested = false;
  let shutdownPromise: Promise<void> | null = null;

  await repairStaleSessions({
    now: dependencies.now,
    sessionStoreOptions,
    isPersistedProcessAlive: dependencies.isPersistedProcessAlive,
    stopPersistedProcess: dependencies.stopPersistedProcess,
  });

  const service: LabService = {
    async getRecorderState() {
      if (!activeSessionId) {
        return { activeSession: null };
      }
      return {
        activeSession: await readSession(activeSessionId, sessionStoreOptions),
      };
    },
    async checkRecorderPermissions(input = {}) {
      if (shutdownRequested) {
        throw new Error(LAB_API_SHUTDOWN_ERROR_MESSAGE);
      }
      if (recorderPermissionCheckPromise) {
        return recorderPermissionCheckPromise;
      }

      const cacheAgeMs =
        latestRecorderPermissionCheck === null
          ? Number.POSITIVE_INFINITY
          : dependencies.now().getTime() -
            Date.parse(latestRecorderPermissionCheck.checkedAt);
      const cacheTtlMs = latestRecorderPermissionCheck?.canStartRecording
        ? RECORDER_PERMISSION_GRANTED_CACHE_TTL_MS
        : RECORDER_PERMISSION_BLOCKED_CACHE_TTL_MS;
      if (
        !input.forceRefresh &&
        latestRecorderPermissionCheck !== null &&
        cacheAgeMs <= cacheTtlMs
      ) {
        return latestRecorderPermissionCheck;
      }

      recorderPermissionCheckPromise = performRecorderPermissionCheck()
        .then((result) => {
          latestRecorderPermissionCheck = result;
          return result;
        })
        .finally(() => {
          recorderPermissionCheckPromise = null;
        });
      return recorderPermissionCheckPromise;
    },
    async bootstrapRecorder(input = {}) {
      if (recorderBootstrapPromise) {
        return recorderBootstrapPromise;
      }

      const abortController = new AbortController();
      recorderBootstrapAbortController = abortController;
      if (shutdownRequested) {
        abortController.abort(new RecorderBootstrapCancelledError());
      }
      const pendingBootstrap = enqueueMutation(
        async () =>
          performRecorderBootstrap(
            {
              enableAudio: normalizeEnableAudio(input.enableAudio),
              ocrLanguagePriority: normalizeOcrLanguagePriority(
                input.ocrLanguagePriority,
              ),
            },
            abortController.signal,
          ),
        {
          handlesShutdownCancellation: true,
        },
      ).finally(() => {
        if (recorderBootstrapAbortController === abortController) {
          recorderBootstrapAbortController = null;
        }
        if (recorderBootstrapPromise === pendingBootstrap) {
          recorderBootstrapPromise = null;
        }
      });
      recorderBootstrapPromise = pendingBootstrap;

      return recorderBootstrapPromise;
    },
    async getLlmConfig() {
      const configPath = dependencies.getLlmConfigPath();
      return {
        path: configPath,
        config: await readLabLlmConfig(configPath),
      };
    },
    async updateLlmConfig(input) {
      return enqueueMutation(async () => {
        const configPath = dependencies.getLlmConfigPath();
        return {
          path: configPath,
          config: await writeLabLlmConfig(input, configPath),
        };
      });
    },
    async listLlmModels(input) {
      const credentials = await resolveLabLlmCredentials(
        input,
        dependencies.getLlmConfigPath(),
      );
      return awaitInterruptibly(
        dependencies.discoverLlmModelsFn({
          baseUrl: input.baseUrl,
          apiKey: credentials.apiKey,
          ...(credentials.extraHeaders
            ? { extraHeaders: credentials.extraHeaders }
            : {}),
        }),
        { signal: serviceAbortController.signal },
      );
    },
    async getSkillManagerConfig() {
      const configPath = dependencies.getSkillManagerConfigPath();
      return {
        path: configPath,
        config: await dependencies.readSkillManagerConfigFn(configPath),
      };
    },
    async updateSkillManagerConfig(input) {
      return enqueueMutation(async () => {
        const configPath = dependencies.getSkillManagerConfigPath();
        return {
          path: configPath,
          config: await dependencies.writeSkillManagerConfigFn(
            {
              skillPath: input.skillPath,
              now: dependencies.now(),
            },
            configPath,
          ),
        };
      });
    },
    async listSkillManagerPathCandidates() {
      return dependencies.listSkillManagerPathCandidatesFn();
    },
    async listInstalledSkills() {
      const configPath = dependencies.getSkillManagerConfigPath();
      const config = await dependencies.readSkillManagerConfigFn(configPath);
      return dependencies.listInstalledSkillsFn({
        skillPath: config.skillPath,
      });
    },
    async exportSkillToManager(sessionId, input) {
      return enqueueMutation(async () => {
        const configPath = dependencies.getSkillManagerConfigPath();
        const config = await dependencies.readSkillManagerConfigFn(configPath);
        if (!config.skillPath) {
          throw new Error(
            "Skill Manager path is not configured. Save a Skill Path before exporting.",
          );
        }

        const session = await readSession(sessionId, sessionStoreOptions);
        const installSource = resolveOpenClawInstallSource(session, input);
        const exportOptions = parseOpenClawSkillInstallCliArgs({
          skillPath: installSource.skillPath,
          installRoot: config.skillPath,
        });
        const result =
          await dependencies.runSkillManagerExportFn(exportOptions);
        return {
          sourceType: input.sourceType,
          sourceSkillPath: installSource.skillPath,
          installName: result.installName,
          installDir: result.installDir,
          skillMdPath: result.skillMdPath,
          validation: result.validation,
        };
      });
    },
    async uninstallInstalledSkill(installName, input) {
      return enqueueMutation(async () => {
        const configPath = dependencies.getSkillManagerConfigPath();
        const config = await dependencies.readSkillManagerConfigFn(configPath);
        if (!config.skillPath) {
          throw new Error(
            "Skill Manager path is not configured. Save a Skill Path before uninstalling.",
          );
        }

        return dependencies.uninstallInstalledSkillFn({
          installRoot: config.skillPath,
          installName,
          confirmName: input.confirmName,
        });
      });
    },
    async listSessions() {
      return listSessions(sessionStoreOptions);
    },
    async getSession(sessionId) {
      return readSession(sessionId, sessionStoreOptions);
    },
    async deleteSession(sessionId) {
      return enqueueMutation(async () => {
        if (activeSessionId === sessionId) {
          throw new Error("Cannot delete the active recording session.");
        }

        await readSession(sessionId, sessionStoreOptions);
        clearAutoStopTimer(sessionId);
        runtimeBySession.delete(sessionId);
        await deleteSessionArtifacts(sessionId, sessionStoreOptions);
      });
    },
    async listOpenClawSkills() {
      return dependencies.listOpenClawPersonalSkillsFn();
    },
    async installOpenClawSkill(sessionId, input) {
      return enqueueMutation(async () => {
        const session = await readSession(sessionId, sessionStoreOptions);
        const installSource = resolveOpenClawInstallSource(session, input);
        const installOptions = parseOpenClawSkillInstallCliArgs({
          skillPath: installSource.skillPath,
        });
        const result =
          await dependencies.runOpenClawSkillInstallFn(installOptions);
        return {
          sourceType: input.sourceType,
          sourceSkillPath: installSource.skillPath,
          installName: result.installName,
          installDir: result.installDir,
          skillMdPath: result.skillMdPath,
          validation: result.validation,
        };
      });
    },
    async uninstallOpenClawSkill(installName, input) {
      return enqueueMutation(async () =>
        dependencies.uninstallOpenClawPersonalSkillFn({
          installName,
          confirmName: input.confirmName,
        }),
      );
    },
    async shutdown() {
      if (shutdownPromise) {
        return shutdownPromise;
      }
      shutdownRequested = true;
      serviceAbortController.abort(new Error(LAB_API_SHUTDOWN_ERROR_MESSAGE));
      recorderBootstrapAbortController?.abort(
        new RecorderBootstrapCancelledError(),
      );
      for (const sessionId of runtimeBySession.keys()) {
        clearAutoStopTimer(sessionId);
      }
      shutdownPromise = enqueueMutation(
        async () => {
          const sessions = await listSessions(sessionStoreOptions);
          const permissionCleanup = recorderPermissionCheckPromise
            ? withTimeoutPreservingError(
                recorderPermissionCheckPromise,
                SHUTDOWN_AUXILIARY_DRAIN_TIMEOUT_MS,
              ).then(
                () => undefined,
                () => undefined,
              )
            : Promise.resolve();
          await Promise.all([
            permissionCleanup,
            ...sessions.map(async (session) => {
              const runtime = getRuntime(session.sessionId);
              const hasActiveRuntime =
                runtime?.recordingProcess !== null ||
                runtime?.queryProcess !== null ||
                runtime?.autoStopTimer !== null ||
                activeSessionId === session.sessionId;
              const shouldFinalize =
                hasActiveRuntime || !isTerminalSessionStatus(session.status);
              if (!shouldFinalize) {
                runtimeBySession.delete(session.sessionId);
                return;
              }

              clearAutoStopTimer(session.sessionId);
              if (shouldPreserveCompletedSessionOnCleanup(session)) {
                const finalizedAt = dependencies.now().toISOString();
                await Promise.all([
                  finalizeRecordingState({
                    session,
                    runtime,
                    finalizedAt,
                    processStopOptions: SHUTDOWN_PROCESS_STOP_OPTIONS,
                  }),
                  finalizeQueryState({
                    session,
                    runtime,
                    finalizedAt,
                    processStopOptions: SHUTDOWN_PROCESS_STOP_OPTIONS,
                  }),
                ]);
                session.updatedAt = finalizedAt;
                await writeSession(session);
              } else {
                await finalizeSessionAfterInterruptedRun({
                  session,
                  now: dependencies.now,
                  runtime,
                  nextStatus: "interrupted",
                  errorMessage: null,
                  warningMessage: LAB_API_SHUTDOWN_WARNING,
                  processStopOptions: SHUTDOWN_PROCESS_STOP_OPTIONS,
                });
              }
              runtimeBySession.delete(session.sessionId);
            }),
          ]);

          activeSessionId = null;
        },
        {
          allowDuringShutdown: true,
        },
      );
      return shutdownPromise;
    },
    async startRecording(input) {
      return enqueueMutation(async () => {
        if (activeSessionId) {
          throw new Error("An active recording session is already running.");
        }

        const existingRecorderHealth = await tryProbeHealthQuick(
          dependencies.runtimeConfig.screenpipeBaseUrl,
          serviceAbortController.signal,
        );
        const shouldReuseExistingRecorder =
          existingRecorderHealth !== null &&
          isHealthyHealthPayload(existingRecorderHealth);
        if (
          dependencies.runtimeConfig.mode === "desktop" &&
          !shouldReuseExistingRecorder &&
          ENABLE_SCREENPIPE_PERMISSION_GATE
        ) {
          const permissionCheck = await requireRecorderPermissions();
          latestRecorderPermissionCheck = permissionCheck;
        }
        const portAvailable = shouldReuseExistingRecorder
          ? false
          : await awaitInterruptibly(
              dependencies.isPortAvailable(
                dependencies.runtimeConfig.screenpipeRecordingPort,
              ),
              { signal: serviceAbortController.signal },
            );
        if (!shouldReuseExistingRecorder && !portAvailable) {
          throw new Error(
            `Port ${dependencies.runtimeConfig.screenpipeRecordingPort} is already in use. Stop the existing localhost:${dependencies.runtimeConfig.screenpipeRecordingPort} Screenpipe instance before starting the lab recorder.`,
          );
        }

        const ocrLanguagePriority = normalizeOcrLanguagePriority(
          input.ocrLanguagePriority,
        );
        const enableAudio = normalizeEnableAudio(input.enableAudio);
        const session = createSession(dependencies.now(), sessionStoreOptions);
        session.status = "starting";
        session.recordingConfig.ocrLanguagePriority = ocrLanguagePriority;
        session.recordingConfig.enableAudio = enableAudio;
        session.recordingWindow.startedAt = session.createdAt;
        if (
          typeof input.autoStopMinutes === "number" &&
          Number.isFinite(input.autoStopMinutes) &&
          input.autoStopMinutes > 0
        ) {
          const scheduledStopAt = new Date(
            Date.parse(session.createdAt) + input.autoStopMinutes * 60_000,
          ).toISOString();
          session.recordingWindow.autoStopMinutes = input.autoStopMinutes;
          session.recordingWindow.scheduledStopAt = scheduledStopAt;
        }

        await ensureSessionDirectories(session);
        await writeSession(session);

        session.screenpipe.recording.command = [];
        session.screenpipe.recording.port =
          dependencies.runtimeConfig.screenpipeRecordingPort;
        session.screenpipe.recording.state = "starting";
        session.screenpipe.recording.startedAt = dependencies
          .now()
          .toISOString();
        await persistSession(session);

        const runtime = getOrCreateRuntime(session.sessionId);
        runtime.allowRecordingExit = false;
        runtime.recordingBaseUrl = dependencies.runtimeConfig.screenpipeBaseUrl;
        runtime.screenpipeApiToken = null;
        try {
          if (shouldReuseExistingRecorder) {
            runtime.recordingMode = "reused";
            session.screenpipe.recordingDataBaseUrl =
              dependencies.runtimeConfig.screenpipeBaseUrl;
            session.status = "recording";
            session.screenpipe.recording.state = "running";
            session.error = null;
            session.warnings = [
              ...session.warnings,
              `Reused external Screenpipe instance at ${dependencies.runtimeConfig.screenpipeBaseUrl}.`,
              `Requested OCR language priority ${formatLanguagePrioritySummary(ocrLanguagePriority)} was not applied because the existing Screenpipe recorder keeps its own language order.`,
              `Requested audio capture setting ${formatEnableAudioSummary(enableAudio)} may not be applied because the existing Screenpipe recorder keeps its own audio configuration.`,
            ];
            await persistSession(session);

            activeSessionId = session.sessionId;
            if (
              typeof session.recordingWindow.autoStopMinutes === "number" &&
              session.recordingWindow.autoStopMinutes > 0
            ) {
              setAutoStopTimer(
                session.sessionId,
                session.recordingWindow.autoStopMinutes,
              );
            }

            return session;
          }

          const command = buildRecordingCommand(
            dependencies.runtimeConfig,
            session.paths.dataDir,
            {
              enableAudio,
              ocrLanguagePriority,
            },
          );
          runtime.screenpipeApiToken = createScreenpipeApiToken();
          session.screenpipe.recording.command = command;
          runtime.recordingProcess = await awaitInterruptibly(
            dependencies.spawnProcess({
              command,
              cwd: dependencies.runtimeConfig.screenpipeWorkDir,
              logPath: session.paths.recordingLogPath,
              env: {
                SCREENPIPE_API_KEY: runtime.screenpipeApiToken,
              },
            }),
            { signal: serviceAbortController.signal },
          );
          runtime.recordingMode = "managed";
          session.screenpipe.recordingDataBaseUrl = null;
          session.screenpipe.recording.pid = runtime.recordingProcess.pid;
          await persistSession(session);

          runtime.recordingProcess.onExit((result) => {
            void handleUnexpectedExit({
              sessionId: session.sessionId,
              processType: "recording",
              result,
            });
          });

          await waitForRecordingReady(runtime.recordingProcess);

          session.status = "recording";
          session.screenpipe.recording.state = "running";
          session.error = null;
          await persistSession(session);

          activeSessionId = session.sessionId;

          if (
            typeof session.recordingWindow.autoStopMinutes === "number" &&
            session.recordingWindow.autoStopMinutes > 0
          ) {
            setAutoStopTimer(
              session.sessionId,
              session.recordingWindow.autoStopMinutes,
            );
          }

          return session;
        } catch (error) {
          runtime.allowRecordingExit = true;
          if (runtime.recordingProcess) {
            const exit = await stopProcess(
              runtime.recordingProcess,
              serviceAbortController.signal.aborted
                ? SHUTDOWN_PROCESS_STOP_OPTIONS
                : undefined,
            );
            runtime.recordingProcess = null;
            session.screenpipe.recording.state = "stopped";
            session.screenpipe.recording.pid = null;
            session.screenpipe.recording.stoppedAt = dependencies
              .now()
              .toISOString();
            session.screenpipe.recording.exitCode = exit.code;
          }
          runtime.recordingBaseUrl = null;
          runtime.screenpipeApiToken = null;
          session.screenpipe.recordingDataBaseUrl = null;
          session.status = "failed";
          session.error = toSessionError(error);
          await persistSession(session);
          throw error;
        }
      });
    },
    async stopRecording() {
      return enqueueMutation(async () => {
        const session = await requireActiveSession();
        return stopAndIngestSession(session);
      });
    },
    async scheduleTimedStop(autoStopMinutes) {
      return enqueueMutation(async () => {
        if (!Number.isFinite(autoStopMinutes) || autoStopMinutes <= 0) {
          throw new Error("autoStopMinutes must be a positive number.");
        }

        const session = await requireActiveSession();
        if (session.status !== "recording" && session.status !== "starting") {
          throw new Error("Timed stop can only be scheduled while recording.");
        }

        setAutoStopTimer(session.sessionId, autoStopMinutes);
        session.recordingWindow.autoStopMinutes = autoStopMinutes;
        session.recordingWindow.scheduledStopAt = new Date(
          dependencies.now().getTime() + autoStopMinutes * 60_000,
        ).toISOString();
        await persistSession(session);
        return session;
      });
    },
    async retryIngest(sessionId) {
      return enqueueMutation(async () => {
        if (activeSessionId === sessionId) {
          throw new Error(
            "Cannot retry ingest while the session is actively recording.",
          );
        }

        const session = await readSession(sessionId, sessionStoreOptions);
        if (
          !session.recordingWindow.startedAt ||
          !session.recordingWindow.requestedStopAt
        ) {
          throw new Error(
            "Retry ingest requires both startedAt and requestedStopAt timestamps.",
          );
        }

        clearDerivedArtifacts(session);
        await persistSession(session);
        return runIngestForSession(session);
      });
    },
    async runWorkflowDiscovery(sessionId) {
      return enqueueMutation(async () => {
        const session = await readSession(sessionId, sessionStoreOptions);
        if (!session.ingest.latestRunDir) {
          throw new Error(
            "Workflow discovery requires one completed ingest run.",
          );
        }
        const latestRunDir = session.ingest.latestRunDir;

        return runSessionStage({
          session,
          status: "workflow-discovering",
          generation: {
            stage: "discovering-workflow",
            completesWorkflow: false,
          },
          action: async () => {
            const outPath = join(
              session.paths.workflowDir,
              `${formatArtifactStamp(dependencies.now())}.json`,
            );
            const llmConfigPath = dependencies.getLlmConfigPath();
            const result = await awaitInterruptibly(
              dependencies.runDiscoverWorkflowsFn({
                runDir: latestRunDir,
                outPath,
                configPath: llmConfigPath,
              }),
              { signal: serviceAbortController.signal },
            );
            const latestPath = result.path ?? outPath;
            const artifact = sanitizeWorkflowArtifact(result.artifact);
            await writeJsonFile(latestPath, artifact);

            session.sessionName = deriveSessionNameFromWorkflowCandidates(
              artifact.workflowCandidates,
            );
            session.workflowDiscovery.latestPath = latestPath;
            session.workflowDiscovery.workflowCandidates =
              artifact.workflowCandidates;
            session.selection.workflowId = null;
            session.selection.workflowPath = latestPath;
            resetSkillSelection(session);
          },
        });
      });
    },
    async saveWorkflowArtifact(sessionId, input) {
      return enqueueMutation(async () => {
        const session = await readSession(sessionId, sessionStoreOptions);
        if (!session.ingest.latestRunDir || !session.ingest.summary) {
          throw new Error(
            "Saving workflow cards requires one completed ingest run.",
          );
        }

        const existingArtifact = await safeReadWorkflowArtifact(
          session.workflowDiscovery.latestPath,
        );
        const generatedAt = dependencies.now().toISOString();
        const nextPath =
          session.workflowDiscovery.latestPath ??
          join(
            session.paths.workflowDir,
            `${formatArtifactStamp(dependencies.now())}-manual.json`,
          );
        const artifact = sanitizeWorkflowArtifact({
          schemaVersion: "openclaw-workflow-discovery-v1",
          generatedAt,
          runId:
            existingArtifact?.runId ??
            session.ingest.summary.runId ??
            session.ingest.latestRunId ??
            "run-manual",
          episodeId: existingArtifact?.episodeId ?? "episode-manual",
          source:
            existingArtifact?.source ??
            buildWorkflowArtifactSourceFromSession(session),
          workflowCandidates: input.workflowCandidates,
          ...(existingArtifact?.llm ? { llm: existingArtifact.llm } : {}),
          warnings: existingArtifact?.warnings ?? [],
        });
        await writeJsonFile(nextPath, artifact);

        session.sessionName = deriveSessionNameFromWorkflowCandidates(
          artifact.workflowCandidates,
        );
        session.workflowDiscovery.latestPath = nextPath;
        session.workflowDiscovery.workflowCandidates =
          artifact.workflowCandidates;
        session.selection.workflowPath = nextPath;
        session.selection.workflowId = resolveSelectedWorkflowIdForSession({
          workflowCandidates: artifact.workflowCandidates,
          requestedWorkflowId: input.selectedWorkflowId ?? null,
          currentWorkflowId: session.selection.workflowId,
        });
        session.skillExtraction.artifacts = sortBaseSkillArtifacts(
          session.skillExtraction.artifacts,
          artifact.workflowCandidates,
        );
        await persistSession(session);
        return session;
      });
    },
    async runSkillExtraction(sessionId, input) {
      return enqueueMutation(async () => {
        const session = await readSession(sessionId, sessionStoreOptions);
        if (!session.ingest.latestRunDir) {
          throw new Error(
            "Skill extraction requires one completed ingest run.",
          );
        }
        const latestRunDir = session.ingest.latestRunDir;

        const workflowArtifact = await readWorkflowArtifact(input.workflowPath);
        const selectedWorkflow =
          workflowArtifact.workflowCandidates.find(
            (candidate) => candidate.workflowId === input.workflowId,
          ) ?? null;
        if (!selectedWorkflow) {
          throw new Error(
            `Workflow not found in artifact: ${input.workflowId}`,
          );
        }

        session.selection.workflowId = selectedWorkflow.workflowId;
        session.selection.workflowPath = input.workflowPath;

        return runSessionStage({
          session,
          status: "skill-extracting",
          generation: {
            stage: "building-skill",
            completesWorkflow: true,
          },
          action: async () => {
            const previousBaseSkillArtifact = findBaseSkillArtifactByWorkflowId(
              session,
              selectedWorkflow.workflowId,
            );
            const outDir = join(
              session.paths.skillDir,
              `${formatArtifactStamp(dependencies.now())}-${sanitizeFileSegment(input.workflowId)}`,
            );
            const llmConfigPath = dependencies.getLlmConfigPath();
            const persistedSessions = await listSessions(sessionStoreOptions);
            let externalFamilySources: WorkflowFamilyArtifactSource[] = [];
            try {
              externalFamilySources =
                await dependencies.listWorkflowFamilyArtifactSourcesFn();
            } catch (error) {
              appendSessionWarning(
                session,
                `Workflow family catalog source unavailable; continued with local sessions: ${toErrorMessage(error)} / 工作流家族目录来源不可用，已仅使用本地会话继续。`,
              );
            }
            const workflowFamilyCatalog =
              await buildRuntimeWorkflowFamilyCatalog([
                ...collectSessionWorkflowFamilyArtifactSources(
                  persistedSessions,
                ),
                ...externalFamilySources,
              ]);
            workflowFamilyCatalog.warnings.forEach((warning) =>
              appendSessionWarning(session, warning),
            );
            const result = await awaitInterruptibly(
              dependencies.runExtractSkillLlmFn({
                runDir: latestRunDir,
                outDir,
                workflowCandidates: workflowArtifact.workflowCandidates,
                selectedWorkflow,
                configPath: llmConfigPath,
                components: {
                  generalization: {
                    enabled: false,
                  },
                  plannerOptimization: {
                    enabled: false,
                  },
                },
                ...(workflowFamilyCatalog.families.length > 0
                  ? {
                      workflowFamilyCards: workflowFamilyCatalog.families,
                      workflowFamilyGraphs: workflowFamilyCatalog.graphs,
                      workflowFamilyGraphPaths:
                        workflowFamilyCatalog.graphPaths,
                    }
                  : {}),
                generationGuidance: input.generationGuidance,
                onProgress: async ({ stage }) => {
                  beginGenerationStage(session, stage, dependencies.now());
                  await persistSession(session);
                },
              }),
              { signal: serviceAbortController.signal },
            );

            const nextBaseSkillArtifact = {
              workflowId: selectedWorkflow.workflowId,
              workflowPath: input.workflowPath,
              latestOutDir: result.paths.outDir,
              skillPath: result.paths.skillPath,
              summaryPath: result.paths.summaryPath,
              skill: result.skill,
              summary: result.summary,
            };
            upsertBaseSkillArtifact(session, nextBaseSkillArtifact);
            syncLatestBaseSkillArtifact(session, nextBaseSkillArtifact);
            removeGeneralizationArtifactsForWorkflow(session, {
              workflowId: selectedWorkflow.workflowId,
              replacedSkillPath: previousBaseSkillArtifact?.skillPath ?? null,
            });
            prunePlannerOptimizationIfSourceMissing(session);
          },
        });
      });
    },
    async runGeneralization(sessionId, input) {
      return enqueueMutation(async () => {
        const session = await readSession(sessionId, sessionStoreOptions);
        const baseSkillArtifact = findBaseSkillArtifactBySkillPath(
          session,
          input.skillPath,
        );
        if (!baseSkillArtifact) {
          throw new Error(
            session.skillExtraction.artifacts.length === 0
              ? "Generalization requires one completed base skill extraction."
              : "Generalization source does not belong to this session.",
          );
        }

        return runSessionStage({
          session,
          status: "generalizing",
          action: async () => {
            const workflowId =
              baseSkillArtifact.workflowId ??
              baseSkillArtifact.summary.selectedWorkflowId ??
              "workflow";
            const outDir = join(
              session.paths.generalizationDir,
              `${formatArtifactStamp(dependencies.now())}-${sanitizeFileSegment(workflowId)}`,
            );
            const llmConfigPath = dependencies.getLlmConfigPath();
            const result = await awaitInterruptibly(
              dependencies.runGeneralizationFn({
                skillPath: baseSkillArtifact.skillPath,
                summaryPath: baseSkillArtifact.summaryPath,
                workflowPath: baseSkillArtifact.workflowPath ?? undefined,
                outDir,
                configPath: llmConfigPath,
                now: dependencies.now(),
              }),
              { signal: serviceAbortController.signal },
            );

            const generalizationArtifact = {
              sourceSkillPath: result.summary.sourceSkillPath,
              sourceSummaryPath: result.summary.sourceSummaryPath,
              selectedWorkflowId:
                result.summary.selectedWorkflowId ??
                baseSkillArtifact.workflowId ??
                null,
              latestOutDir: result.outDir,
              summaryPath: result.summaryPath,
              summary: result.summary,
            };
            upsertGeneralizationArtifact(session, generalizationArtifact);
            syncLatestGeneralizationArtifact(session, generalizationArtifact);
            prunePlannerOptimizationIfSourceMissing(session);
          },
        });
      });
    },
    async runPlannerOptimization(sessionId, input) {
      return enqueueMutation(async () => {
        const session = await readSession(sessionId, sessionStoreOptions);
        const sourceSelection = resolvePlannerOptimizationSource(
          session,
          input,
        );

        return runSessionStage({
          session,
          status: "planner-optimizing",
          action: async () => {
            const outDir = join(
              session.paths.plannerOptimizationDir,
              buildPlannerOptimizationDirectoryName({
                now: dependencies.now(),
                sourceType: input.sourceType,
                skillPath: input.skillPath,
              }),
            );
            const llmConfigPath = dependencies.getLlmConfigPath();
            const result = await awaitInterruptibly(
              dependencies.runPlannerOptimizationFn({
                sourceType: input.sourceType,
                skillPath: input.skillPath,
                outDir,
                configPath: llmConfigPath,
                now: dependencies.now(),
                selectedWorkflowId: sourceSelection.selectedWorkflowId,
              }),
              { signal: serviceAbortController.signal },
            );

            session.plannerOptimization.latestOutDir = result.outDir;
            session.plannerOptimization.skillPath = result.skillPath;
            session.plannerOptimization.summaryPath = result.summaryPath;
            session.plannerOptimization.skill = result.skill;
            session.plannerOptimization.summary = result.summary;
          },
        });
      });
    },
    async updateSkillArtifact(sessionId, input) {
      return enqueueMutation(async () => {
        const session = await readSession(sessionId, sessionStoreOptions);

        if (input.sourceType === "base") {
          const artifact = findBaseSkillArtifactBySkillPath(
            session,
            input.skillPath,
          );
          if (!artifact) {
            throw new Error(
              session.skillExtraction.artifacts.length === 0
                ? "Editing requires one completed base skill extraction."
                : "Edited base skill does not belong to this session.",
            );
          }

          const normalizedSkill = normalizeEditedSkillArtifact(input.skill);
          const skillChanged = !areSkillsEquivalent(
            artifact.skill,
            normalizedSkill,
          );
          artifact.skill = normalizedSkill;
          artifact.summary = syncSkillExtractionSummaryWithSkill(
            artifact.summary,
            normalizedSkill,
          );
          if (session.skillExtraction.skillPath === artifact.skillPath) {
            syncLatestBaseSkillArtifact(session, artifact);
          }
          await assertWorkflowGraphCompatibility({
            skill: normalizedSkill,
            outDir: dirname(artifact.skillPath),
          });
          await writeJsonFile(artifact.skillPath, normalizedSkill);
          const workflowArtifacts = await materializeWorkflowGraphArtifacts({
            skill: normalizedSkill,
            outDir: dirname(artifact.skillPath),
            sourceSkillPath: artifact.skillPath,
          });
          artifact.summary.output.workflowGraphPath =
            workflowArtifacts.graphPath;
          artifact.summary.output.workflowMarkdownPath =
            workflowArtifacts.markdownPath;
          artifact.summary.output.workflowRevisionsDir = dirname(
            workflowArtifacts.revisionPath,
          );
          await writeJsonFile(artifact.summaryPath, artifact.summary);
          if (skillChanged) {
            removeGeneralizationArtifactsForSourceSkillPath(
              session,
              artifact.skillPath,
            );
            clearPlannerOptimizationIfSourceSkillEdited(session, {
              sourceType: "base",
              skillPath: artifact.skillPath,
            });
            prunePlannerOptimizationIfSourceMissing(session);
          }
          await persistSession(session);
          return session;
        }

        if (input.sourceType === "planner-optimized") {
          if (
            !session.plannerOptimization.skillPath ||
            !session.plannerOptimization.summaryPath ||
            !session.plannerOptimization.skill
          ) {
            throw new Error(
              "Editing requires one completed planner optimization result.",
            );
          }

          if (session.plannerOptimization.skillPath !== input.skillPath) {
            throw new Error(
              "Edited planner-optimized skill does not belong to this session.",
            );
          }

          const normalizedSkill = normalizeEditedSkillArtifact(input.skill);
          session.plannerOptimization.skill = normalizedSkill;
          await assertWorkflowGraphCompatibility({
            skill: normalizedSkill,
            outDir: dirname(session.plannerOptimization.skillPath),
          });
          await writeJsonFile(
            session.plannerOptimization.skillPath,
            normalizedSkill,
          );
          const workflowArtifacts = await materializeWorkflowGraphArtifacts({
            skill: normalizedSkill,
            outDir: dirname(session.plannerOptimization.skillPath),
            sourceSkillPath: session.plannerOptimization.skillPath,
          });
          if (session.plannerOptimization.summary) {
            session.plannerOptimization.summary.output.workflowGraphPath =
              workflowArtifacts.graphPath;
            session.plannerOptimization.summary.output.workflowMarkdownPath =
              workflowArtifacts.markdownPath;
            session.plannerOptimization.summary.output.workflowRevisionsDir =
              dirname(workflowArtifacts.revisionPath);
            await writeJsonFile(
              session.plannerOptimization.summaryPath,
              session.plannerOptimization.summary,
            );
          }
          await persistSession(session);
          return session;
        }

        const matched = findGeneralizedVariantBySkillPath(
          session,
          input.skillPath,
        );
        if (!matched) {
          throw new Error(
            "Edited generalized skill does not belong to this session.",
          );
        }

        const normalizedSkill = normalizeEditedSkillArtifact(input.skill);
        const skillChanged = !areSkillsEquivalent(
          matched.variant.skill,
          normalizedSkill,
        );
        matched.variant.skill = normalizedSkill;
        await assertWorkflowGraphCompatibility({
          skill: normalizedSkill,
          outDir: dirname(matched.variant.summary.output.skillPath),
        });
        await writeJsonFile(
          matched.variant.summary.output.skillPath,
          normalizedSkill,
        );
        const workflowArtifacts = await materializeWorkflowGraphArtifacts({
          skill: normalizedSkill,
          outDir: dirname(matched.variant.summary.output.skillPath),
          sourceSkillPath: matched.variant.summary.output.skillPath,
        });
        matched.variant.summary.output.workflowGraphPath =
          workflowArtifacts.graphPath;
        matched.variant.summary.output.workflowMarkdownPath =
          workflowArtifacts.markdownPath;
        matched.variant.summary.output.workflowRevisionsDir = dirname(
          workflowArtifacts.revisionPath,
        );
        await writeJsonFile(
          matched.generalizationArtifact.summaryPath,
          matched.generalizationArtifact.summary,
        );
        if (skillChanged) {
          clearPlannerOptimizationIfSourceSkillEdited(session, {
            sourceType: "generalized",
            skillPath: matched.variant.summary.output.skillPath,
          });
        }
        syncLatestGeneralizationArtifact(
          session,
          getLatestGeneralizationArtifact(session),
        );
        await persistSession(session);
        return session;
      });
    },
    async getArtifact(sessionId, kind) {
      const session = await readSession(sessionId, sessionStoreOptions);
      const path = getArtifactPath(session, kind);
      if (!path) {
        throw new Error(`No artifact available for kind: ${kind}`);
      }

      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      return {
        kind,
        path,
        data:
          kind === "workflow"
            ? sanitizeWorkflowArtifact(parsed as WorkflowDiscoveryArtifact)
            : parsed,
      };
    },
  };

  return service;

  function enqueueMutation<T>(
    action: LabMutatingAction<T>,
    options: EnqueueMutationOptions = {},
  ): Promise<T> {
    const allowDuringShutdown = options.allowDuringShutdown === true;
    if (shutdownRequested && !allowDuringShutdown) {
      return Promise.reject(new Error(LAB_API_SHUTDOWN_ERROR_MESSAGE));
    }
    const guardedAction = async (): Promise<T> => {
      if (shutdownRequested && !allowDuringShutdown) {
        throw new Error(LAB_API_SHUTDOWN_ERROR_MESSAGE);
      }
      const operation = action();
      if (allowDuringShutdown || options.handlesShutdownCancellation === true) {
        return operation;
      }
      return awaitInterruptibly(operation, {
        signal: serviceAbortController.signal,
      });
    };
    const next = mutationQueue.then(guardedAction, guardedAction);
    mutationQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async function stopAndIngestSession(
    session: LabSession,
    reason: "manual" | "timer" = "manual",
  ): Promise<LabSession> {
    session.status = "stopping";
    session.recordingWindow.requestedStopAt = dependencies.now().toISOString();
    if (reason === "manual") {
      session.recordingWindow.scheduledStopAt = null;
      session.recordingWindow.autoStopMinutes = null;
    }
    clearAutoStopTimer(session.sessionId);
    await persistSession(session);

    const runtime = getRuntime(session.sessionId);
    if (!runtime) {
      throw new Error("Active recording process was not found.");
    }

    session.screenpipe.recording.state = "stopped";
    session.screenpipe.recording.stoppedAt = dependencies.now().toISOString();
    if (runtime.recordingMode === "reused") {
      session.screenpipe.recording.exitCode = null;
      await persistSession(session);
      activeSessionId = null;
      return runIngestForSession(session, runtime.recordingBaseUrl);
    }

    if (!runtime.recordingProcess) {
      throw new Error("Active recording process was not found.");
    }

    runtime.allowRecordingExit = true;
    const exit = await stopProcess(runtime.recordingProcess, {
      gracefulTimeoutMs: RECORDING_PROCESS_STOP_TIMEOUT_MS,
      terminateTimeoutMs: 2_000,
      killTimeoutMs: 1_000,
    });
    runtime.recordingProcess = null;
    session.screenpipe.recording.pid = null;
    session.screenpipe.recording.exitCode = exit.code;
    await persistSession(session);

    activeSessionId = null;
    return runIngestForSession(session);
  }

  async function runIngestForSession(
    session: LabSession,
    externalBaseUrl?: string | null,
  ): Promise<LabSession> {
    if (externalBaseUrl) {
      return ingestFromBaseUrl(session, externalBaseUrl);
    }

    session.status = "booting-query-mode";
    session.error = null;
    await persistSession(session);

    const queryPort = await awaitInterruptibly(
      dependencies.findFreePort(
        dependencies.runtimeConfig.screenpipeQueryPortStart,
      ),
      { signal: serviceAbortController.signal },
    );
    const queryCommand = buildQueryModeCommand(
      dependencies.runtimeConfig,
      queryPort,
      session.paths.dataDir,
    );
    const runtime = getOrCreateRuntime(session.sessionId);
    const apiToken = runtime.screenpipeApiToken ?? createScreenpipeApiToken();
    runtime.screenpipeApiToken = apiToken;
    runtime.allowQueryExit = false;
    runtime.queryProcess = await awaitInterruptibly(
      dependencies.spawnProcess({
        command: queryCommand,
        cwd: dependencies.runtimeConfig.screenpipeWorkDir,
        logPath: session.paths.queryLogPath,
        env: {
          SCREENPIPE_API_KEY: apiToken,
        },
      }),
      { signal: serviceAbortController.signal },
    );
    runtime.queryProcess.onExit((result) => {
      void handleUnexpectedExit({
        sessionId: session.sessionId,
        processType: "query",
        result,
      });
    });
    session.screenpipe.queryMode.command = queryCommand;
    session.screenpipe.queryMode.pid = runtime.queryProcess.pid;
    session.screenpipe.queryMode.port = queryPort;
    session.screenpipe.queryMode.state = "starting";
    session.screenpipe.queryMode.startedAt = dependencies.now().toISOString();
    await persistSession(session);

    try {
      await waitForHealth(
        `http://127.0.0.1:${queryPort}`,
        QUERY_READY_TIMEOUT_MS,
        undefined,
        undefined,
        {
          signal: serviceAbortController.signal,
          processHandle: runtime.queryProcess,
          processLabel: "Screenpipe query process",
        },
      );
      session.status = "ingesting";
      session.screenpipe.queryMode.state = "running";
      beginGenerationStage(session, "analyzing-recording", dependencies.now());
      await persistSession(session);

      const ingestResult = await awaitInterruptibly(
        dependencies.runIngestFn({
          from: requireIso(session.recordingWindow.startedAt, "startedAt"),
          to: requireIso(
            session.recordingWindow.requestedStopAt,
            "requestedStopAt",
          ),
          apps: "*",
          out: session.paths.ingestOutDir,
          baseUrl: `http://127.0.0.1:${queryPort}`,
          screenpipeApiToken: apiToken,
        }),
        { signal: serviceAbortController.signal },
      );

      session.ingest.latestRunId = ingestResult.manifest.runId;
      session.ingest.latestRunDir = ingestResult.manifest.paths.runDir;
      session.ingest.summaryPath = ingestResult.manifest.paths.summary;
      session.ingest.summary = ingestResult.summary;
      clearDerivedArtifacts(session);
      session.ingest.latestRunId = ingestResult.manifest.runId;
      session.ingest.latestRunDir = ingestResult.manifest.paths.runDir;
      session.ingest.summaryPath = ingestResult.manifest.paths.summary;
      session.ingest.summary = ingestResult.summary;
      session.status = "ready";
      session.error = null;
      completeCurrentGenerationStage(session, dependencies.now(), false);
      await persistSession(session);
      return session;
    } catch (error) {
      session.status = "failed";
      session.error = toSessionError(error);
      failCurrentGenerationStage(session, dependencies.now());
      await persistSession(session);
      throw error;
    } finally {
      runtime.allowQueryExit = true;
      if (runtime.queryProcess) {
        const exit = await stopProcess(
          runtime.queryProcess,
          serviceAbortController.signal.aborted
            ? SHUTDOWN_PROCESS_STOP_OPTIONS
            : undefined,
        );
        session.screenpipe.queryMode.state = "stopped";
        session.screenpipe.queryMode.pid = null;
        session.screenpipe.queryMode.stoppedAt = dependencies
          .now()
          .toISOString();
        session.screenpipe.queryMode.exitCode = exit.code;
        runtime.queryProcess = null;
        await persistSession(session);
      }
      runtime.screenpipeApiToken = null;
    }
  }

  async function ingestFromBaseUrl(
    session: LabSession,
    baseUrl: string,
  ): Promise<LabSession> {
    session.status = "ingesting";
    session.error = null;
    beginGenerationStage(session, "analyzing-recording", dependencies.now());
    await persistSession(session);

    try {
      const ingestResult = await awaitInterruptibly(
        dependencies.runIngestFn({
          from: requireIso(session.recordingWindow.startedAt, "startedAt"),
          to: requireIso(
            session.recordingWindow.requestedStopAt,
            "requestedStopAt",
          ),
          apps: "*",
          out: session.paths.ingestOutDir,
          baseUrl,
          screenpipeApiToken:
            getRuntime(session.sessionId)?.screenpipeApiToken ??
            process.env.SCREENPIPE_API_KEY ??
            null,
        }),
        { signal: serviceAbortController.signal },
      );

      session.ingest.latestRunId = ingestResult.manifest.runId;
      session.ingest.latestRunDir = ingestResult.manifest.paths.runDir;
      session.ingest.summaryPath = ingestResult.manifest.paths.summary;
      session.ingest.summary = ingestResult.summary;
      clearDerivedArtifacts(session);
      session.status = "ready";
      session.error = null;
      completeCurrentGenerationStage(session, dependencies.now(), false);
      await persistSession(session);
      return session;
    } catch (error) {
      session.status = "failed";
      session.error = toSessionError(error);
      failCurrentGenerationStage(session, dependencies.now());
      await persistSession(session);
      throw error;
    }
  }

  async function requireActiveSession(): Promise<LabSession> {
    if (!activeSessionId) {
      throw new Error("No active recording session is running.");
    }
    return readSession(activeSessionId, sessionStoreOptions);
  }

  function getRuntime(sessionId: string): LabRuntimeEntry | null {
    return runtimeBySession.get(sessionId) ?? null;
  }

  function getOrCreateRuntime(sessionId: string): LabRuntimeEntry {
    const existing = runtimeBySession.get(sessionId);
    if (existing) {
      return existing;
    }

    const created: LabRuntimeEntry = {
      recordingProcess: null,
      queryProcess: null,
      recordingMode: "managed",
      recordingBaseUrl: null,
      screenpipeApiToken: null,
      allowRecordingExit: false,
      allowQueryExit: false,
      autoStopTimer: null,
    };
    runtimeBySession.set(sessionId, created);
    return created;
  }

  function clearAutoStopTimer(sessionId: string): void {
    const runtime = getRuntime(sessionId);
    if (runtime?.autoStopTimer) {
      clearTimeout(runtime.autoStopTimer);
      runtime.autoStopTimer = null;
    }
  }

  function setAutoStopTimer(sessionId: string, autoStopMinutes: number): void {
    clearAutoStopTimer(sessionId);
    const runtime = getOrCreateRuntime(sessionId);
    runtime.autoStopTimer = setTimeout(() => {
      runtime.autoStopTimer = null;
      if (shutdownRequested) {
        return;
      }
      const autoStop = enqueueMutation(async () => {
        const session = await readSession(sessionId, sessionStoreOptions);
        if (session.status === "recording" || session.status === "starting") {
          await stopAndIngestSession(session, "timer");
        }
      });
      void autoStop.catch(async (error) => {
        if (shutdownRequested) {
          return;
        }
        try {
          await enqueueMutation(async () => {
            const session = await readSession(sessionId, sessionStoreOptions);
            if (isTerminalSessionStatus(session.status)) {
              return;
            }
            session.status = "failed";
            session.error = toSessionError(error);
            appendSessionWarning(
              session,
              `Scheduled recording stop failed: ${toErrorMessage(error)} / 录制定时停止失败。`,
            );
            await persistSession(session);
          });
        } catch {
          // Shutdown or a second persistence failure must not surface as an
          // unhandled rejection from this detached timer callback.
        }
      });
    }, autoStopMinutes * 60_000);
  }

  async function handleUnexpectedExit(input: {
    sessionId: string;
    processType: "recording" | "query";
    result: LabProcessExitResult;
  }): Promise<void> {
    if (shutdownRequested) {
      return;
    }
    const runtime = getRuntime(input.sessionId);
    if (!runtime) {
      return;
    }

    const allowExit =
      input.processType === "recording"
        ? runtime.allowRecordingExit
        : runtime.allowQueryExit;
    if (allowExit) {
      return;
    }

    try {
      const session = await readSession(input.sessionId, sessionStoreOptions);
      session.status = "failed";
      session.error = {
        message: `${input.processType} process exited unexpectedly.`,
        stack: JSON.stringify(input.result),
      };
      session.warnings = [
        ...session.warnings,
        `${input.processType} process exited unexpectedly with code=${input.result.code ?? "null"} signal=${input.result.signal ?? "null"}`,
      ];
      if (input.processType === "recording") {
        activeSessionId = null;
        clearAutoStopTimer(input.sessionId);
        session.screenpipe.recording.state = "stopped";
        session.screenpipe.recording.pid = null;
        session.screenpipe.recording.stoppedAt = dependencies
          .now()
          .toISOString();
        session.screenpipe.recording.exitCode = input.result.code;
      } else {
        session.screenpipe.queryMode.state = "stopped";
        session.screenpipe.queryMode.pid = null;
        session.screenpipe.queryMode.stoppedAt = dependencies
          .now()
          .toISOString();
        session.screenpipe.queryMode.exitCode = input.result.code;
      }
      await persistSession(session);
    } catch {
      // CN/EN: Avoid crashing the process on secondary persistence failures.
    }
  }

  async function waitForRecordingReady(
    processHandle: LabProcessHandle,
  ): Promise<void> {
    await waitForHealth(
      dependencies.runtimeConfig.screenpipeBaseUrl,
      RECORDING_READY_TIMEOUT_MS,
      `Screenpipe recorder did not become healthy on ${dependencies.runtimeConfig.screenpipeBaseUrl}`,
      undefined,
      {
        signal: serviceAbortController.signal,
        processHandle,
        processLabel: "Screenpipe recording process",
      },
    );
  }

  async function performRecorderBootstrap(
    input: {
      enableAudio: boolean;
      ocrLanguagePriority: readonly LabScreenpipeLanguage[];
    },
    signal: AbortSignal,
  ): Promise<RecorderBootstrapResponse> {
    const startedAt = dependencies.now().toISOString();
    let processHandle: LabProcessHandle | null = null;
    let logPath: string | null = null;

    try {
      throwIfAborted(signal);
      const existingRecorderHealth = await tryProbeHealthQuick(
        dependencies.runtimeConfig.screenpipeBaseUrl,
        signal,
      );
      if (
        existingRecorderHealth !== null &&
        isHealthyHealthPayload(existingRecorderHealth)
      ) {
        return {
          startedAt,
          completedAt: dependencies.now().toISOString(),
          stage: "ready",
          ready: true,
          summary: `Recorder is already ready at ${dependencies.runtimeConfig.screenpipeBaseUrl}.`,
          logPath: null,
        };
      }

      const portAvailable = await awaitInterruptibly(
        dependencies.isPortAvailable(
          dependencies.runtimeConfig.screenpipeRecordingPort,
        ),
        { signal },
      );
      if (!portAvailable) {
        return {
          startedAt,
          completedAt: dependencies.now().toISOString(),
          stage: "failed",
          ready: false,
          summary: `Recorder bootstrap could not start because port ${dependencies.runtimeConfig.screenpipeRecordingPort} is already in use.`,
          logPath: null,
        };
      }

      const bootstrapDir = join(
        dependencies.runtimeConfig.runsRoot,
        "bootstrap",
        formatArtifactStamp(dependencies.now()),
      );
      logPath = join(bootstrapDir, "recording-bootstrap.log");
      const dataDir = join(bootstrapDir, "screenpipe-data");
      const command = buildRecordingCommand(
        dependencies.runtimeConfig,
        dataDir,
        {
          enableAudio: input.enableAudio,
          ocrLanguagePriority: input.ocrLanguagePriority,
        },
      );
      processHandle = await dependencies.spawnProcess({
        command,
        cwd: dependencies.runtimeConfig.screenpipeWorkDir,
        logPath,
      });
      throwIfAborted(signal);
      await waitForHealth(
        dependencies.runtimeConfig.screenpipeBaseUrl,
        RECORDER_BOOTSTRAP_READY_TIMEOUT_MS,
        `Recorder bootstrap did not become healthy on ${dependencies.runtimeConfig.screenpipeBaseUrl}`,
        undefined,
        {
          signal,
          processHandle,
          processLabel: "Screenpipe bootstrap process",
        },
      );
      return {
        startedAt,
        completedAt: dependencies.now().toISOString(),
        stage: "ready",
        ready: true,
        summary:
          "Recorder dependencies are ready. You can start recording now.",
        logPath,
      };
    } catch (error) {
      const logText = logPath
        ? await readFile(logPath, "utf8").catch(() => "")
        : "";
      const diagnosticLogText =
        error instanceof RecorderBootstrapCancelledError ||
        error instanceof LabProcessFailureError
          ? ""
          : logText;
      return {
        startedAt,
        completedAt: dependencies.now().toISOString(),
        stage: "failed",
        ready: false,
        summary: summarizeRecorderBootstrapFailure({
          baseMessage: toErrorMessage(error),
          logPath,
          logText: diagnosticLogText,
        }),
        logPath,
      };
    } finally {
      if (processHandle) {
        await stopProcess(
          processHandle,
          signal.aborted ? SHUTDOWN_PROCESS_STOP_OPTIONS : undefined,
        ).catch(() => ({
          code: null,
          signal: "SIGKILL" as NodeJS.Signals,
        }));
      }
    }
  }

  async function performRecorderPermissionCheck(): Promise<RecorderPermissionsResponse> {
    const checkedAt = dependencies.now().toISOString();
    if (
      dependencies.runtimeConfig.mode !== "desktop" ||
      dependencies.runtimeConfig.platform !== "darwin"
    ) {
      return buildNonBlockingRecorderPermissionsResponse({
        checkedAt,
        summary: buildPlatformRecorderPermissionSummary(
          dependencies.runtimeConfig.platform,
        ),
      });
    }

    const existingRecorderHealth = await tryProbeHealthQuick(
      dependencies.runtimeConfig.screenpipeBaseUrl,
      serviceAbortController.signal,
    );
    if (
      existingRecorderHealth !== null &&
      isHealthyHealthPayload(existingRecorderHealth)
    ) {
      return buildRecorderPermissionsFromExistingRecorder({
        checkedAt,
        baseUrl: dependencies.runtimeConfig.screenpipeBaseUrl,
      });
    }

    const probe = await runRecorderPermissionProbe(
      checkedAt,
      serviceAbortController.signal,
    );
    return buildRecorderPermissionsFromProbe(probe);
  }

  async function requireRecorderPermissions(): Promise<RecorderPermissionsResponse> {
    const permissionCheck = await service.checkRecorderPermissions();
    if (permissionCheck.canStartRecording) {
      return permissionCheck;
    }

    const missing = permissionCheck.items.filter(
      (item) => item.state !== "granted",
    );
    const labels = missing.map((item) => item.label).join(", ");
    throw new Error(
      labels.length > 0
        ? `Recording is blocked until the packaged desktop recorder has these macOS permissions: ${labels}.`
        : "Recording is blocked until the packaged desktop recorder permissions have been confirmed.",
    );
  }

  function buildPlatformRecorderPermissionSummary(
    platform: NodeJS.Platform | string,
  ): string {
    void platform;
    return "";
  }

  async function runRecorderPermissionProbe(
    checkedAt: string,
    signal: AbortSignal,
  ): Promise<RecorderPermissionProbeResult> {
    const probeDir = join(
      dependencies.runtimeConfig.runsRoot,
      "permission-checks",
      formatArtifactStamp(dependencies.now()),
    );
    const logPath = join(probeDir, "probe.log");
    const command = [
      dependencies.runtimeConfig.screenpipeBinaryPath,
      "permissions",
      "--json",
    ];
    let processHandle: LabProcessHandle | null = null;
    let health: Record<string, unknown> | null = null;
    let error: string | null = null;
    let processExited = false;

    try {
      processHandle = await awaitInterruptibly(
        dependencies.spawnProcess({
          command,
          cwd: dependencies.runtimeConfig.screenpipeWorkDir,
          logPath,
        }),
        { signal },
      );
      const exitResult = await awaitInterruptibly(
        withTimeoutPreservingError(
          waitForProcessExitOrFailure(processHandle),
          RECORDER_PERMISSION_PROBE_TIMEOUT_MS,
        ),
        { signal },
      );
      if (!exitResult) {
        throw new Error("Recorder permission status check timed out.");
      }
      processExited = true;
      await awaitInterruptibly(dependencies.sleep(50), { signal });
      const logText = await readFile(logPath, "utf8").catch(() => "");
      health = parseRecorderPermissionJson(logText);
      if (exitResult.code !== 0 || !health) {
        throw new Error(
          "The packaged recorder could not read permission status without prompting.",
        );
      }
    } catch (probeError) {
      error = toErrorMessage(probeError);
    } finally {
      if (processHandle && !processExited) {
        await stopProcess(
          processHandle,
          signal.aborted ? SHUTDOWN_PROCESS_STOP_OPTIONS : undefined,
        ).catch(() => ({
          code: null,
          signal: "SIGKILL" as NodeJS.Signals,
        }));
      }
    }

    return {
      checkedAt,
      health,
      logPath,
      logText: await readFile(logPath, "utf8").catch(() => ""),
      error,
    };
  }

  async function tryProbeHealthQuick(
    baseUrl: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown> | null> {
    return awaitInterruptibly(
      withTimeout(
        dependencies.probeHealth(baseUrl),
        QUICK_HEALTH_PROBE_TIMEOUT_MS,
      ),
      { signal },
    );
  }

  async function waitForHealth(
    baseUrl: string,
    timeoutMs: number,
    failureMessage = `Screenpipe query mode did not become healthy on ${baseUrl}`,
    isReady: (
      health: Record<string, unknown>,
    ) => boolean = isHealthyHealthPayload,
    options: HealthWaitOptions = {},
  ): Promise<void> {
    const deadline = dependencies.now().getTime() + timeoutMs;
    let lastError: unknown = null;
    let lastHealth: Record<string, unknown> | null = null;
    const processInterruption = options.processHandle
      ? createProcessReadinessInterruption(
          options.processHandle,
          options.processLabel ?? "Managed process",
        )
      : undefined;
    while (dependencies.now().getTime() < deadline) {
      throwIfAborted(options.signal);
      try {
        const health = await awaitInterruptibly(
          dependencies.probeHealth(baseUrl),
          {
            signal: options.signal,
            processInterruption,
          },
        );
        lastHealth = health;
        if (isReady(health)) {
          return;
        }
      } catch (error) {
        if (
          options.signal?.aborted ||
          error instanceof RecorderBootstrapCancelledError ||
          error instanceof LabProcessFailureError
        ) {
          throw error;
        }
        lastError = error;
      }
      await awaitInterruptibly(dependencies.sleep(HEALTH_POLL_INTERVAL_MS), {
        signal: options.signal,
        processInterruption,
      });
    }

    throw new Error(
      lastHealth
        ? `${failureMessage}. Last health payload: ${JSON.stringify(lastHealth)}`
        : `${failureMessage}: ${toErrorMessage(lastError)}`,
    );
  }

  async function runSessionStage(input: {
    session: LabSession;
    status: LabSession["status"];
    action: () => Promise<void>;
    generation?: {
      stage: LabWorkflowGenerationStage;
      completesWorkflow: boolean;
    };
  }): Promise<LabSession> {
    input.session.status = input.status;
    input.session.error = null;
    if (input.generation) {
      beginGenerationStage(
        input.session,
        input.generation.stage,
        dependencies.now(),
      );
    }
    await persistSession(input.session);
    try {
      await input.action();
      if (input.generation?.completesWorkflow) {
        await deleteGeneratedWorkflowRawCapture(input.session);
      }
      input.session.status = "ready";
      input.session.error = null;
      if (input.generation) {
        completeCurrentGenerationStage(
          input.session,
          dependencies.now(),
          input.generation.completesWorkflow,
        );
      }
      await persistSession(input.session);
      return input.session;
    } catch (error) {
      input.session.status = "ready";
      input.session.error = toSessionError(error);
      if (input.generation) {
        failCurrentGenerationStage(input.session, dependencies.now());
      }
      await persistSession(input.session);
      throw error;
    }
  }

  /**
   * EN: Removes both reused-recorder data and session-local raw artifacts after successful workflow generation.
   * 中文: workflow 成功生成后，同时清理复用录制器中的数据和会话本地原始产物。
   * @param session completed workflow session.
   * @returns resolves only after every applicable raw-data source is deleted.
   */
  async function deleteGeneratedWorkflowRawCapture(
    session: LabSession,
  ): Promise<void> {
    const runtime = getRuntime(session.sessionId);
    const recordingDataBaseUrl =
      session.screenpipe.recordingDataBaseUrl ??
      (runtime?.recordingMode === "reused" ? runtime.recordingBaseUrl : null);

    if (recordingDataBaseUrl) {
      await dependencies.deleteScreenpipeTimeRangeFn({
        baseUrl: recordingDataBaseUrl,
        start: requireIso(session.recordingWindow.startedAt, "startedAt"),
        end: requireIso(
          session.recordingWindow.requestedStopAt,
          "requestedStopAt",
        ),
        apiToken:
          runtime?.screenpipeApiToken ?? process.env.SCREENPIPE_API_KEY ?? null,
      });
    }

    await deleteSessionRawCaptureArtifacts(
      session.sessionId,
      sessionStoreOptions,
    );
  }

  async function persistSession(session: LabSession): Promise<void> {
    if (shutdownRequested) {
      throw new Error(LAB_API_SHUTDOWN_ERROR_MESSAGE);
    }
    session.updatedAt = dependencies.now().toISOString();
    await writeSession(session);
  }
}

async function repairStaleSessions(input: {
  now: () => Date;
  sessionStoreOptions: LabSessionStoreOptions;
  isPersistedProcessAlive: (
    input: PersistedProcessStopInput,
  ) => Promise<boolean>;
  stopPersistedProcess: (
    input: PersistedProcessStopInput,
  ) => Promise<LabProcessExitResult | null>;
}): Promise<void> {
  const sessions = await listSessions(input.sessionStoreOptions);
  for (const session of sessions) {
    if (migrateLegacyInterruptedSession(session, input.now)) {
      await writeSession(session);
    }

    if (
      !(await shouldRepairInterruptedSession(
        session,
        input.isPersistedProcessAlive,
      ))
    ) {
      continue;
    }

    if (shouldPreserveCompletedSessionOnCleanup(session)) {
      const finalizedAt = input.now().toISOString();
      await finalizeRecordingState({
        session,
        runtime: null,
        finalizedAt,
        stopPersistedProcess: input.stopPersistedProcess,
      });
      await finalizeQueryState({
        session,
        runtime: null,
        finalizedAt,
        stopPersistedProcess: input.stopPersistedProcess,
      });
      session.updatedAt = finalizedAt;
      await writeSession(session);
      continue;
    }

    await finalizeSessionAfterInterruptedRun({
      session,
      now: input.now,
      runtime: null,
      nextStatus: "interrupted",
      errorMessage: null,
      warningMessage: LAB_API_RESTART_WARNING,
      stopPersistedProcess: input.stopPersistedProcess,
    });
  }
}

function migrateLegacyInterruptedSession(
  session: LabSession,
  now: () => Date,
): boolean {
  if (session.status !== "failed") {
    return false;
  }

  const origin = resolveInterruptedSessionOrigin(session);
  if (!origin) {
    return false;
  }

  session.status = "interrupted";
  session.error = null;
  session.warnings = session.warnings.filter(
    (warning) => !isLegacyInterruptedWarning(warning),
  );
  appendSessionWarning(
    session,
    origin === "shutdown" ? LAB_API_SHUTDOWN_WARNING : LAB_API_RESTART_WARNING,
  );
  session.updatedAt = now().toISOString();
  return true;
}

function resolveInterruptedSessionOrigin(
  session: LabSession,
): "shutdown" | "restart" | null {
  if (session.error?.message?.includes("lab-api shut down")) {
    return "shutdown";
  }
  if (session.error?.message?.includes("lab-api restarted")) {
    return "restart";
  }

  if (
    session.warnings.some((warning) => warning.includes("lab-api shut down"))
  ) {
    return "shutdown";
  }
  if (
    session.warnings.some((warning) => warning.includes("lab-api restarted"))
  ) {
    return "restart";
  }

  return null;
}

function isLegacyInterruptedWarning(warning: string): boolean {
  return (
    warning.includes(
      "lab-api shut down while the session was still in progress",
    ) ||
    warning.includes(
      "lab-api restarted while the session was still in progress",
    )
  );
}

async function finalizeSessionAfterInterruptedRun(input: {
  session: LabSession;
  now: () => Date;
  runtime: LabRuntimeEntry | null;
  nextStatus: LabSession["status"];
  errorMessage: string | null;
  warningMessage: string;
  stopPersistedProcess?: (
    input: PersistedProcessStopInput,
  ) => Promise<LabProcessExitResult | null>;
  processStopOptions?: Readonly<ProcessStopOptions>;
}): Promise<void> {
  const finalizedAt = input.now().toISOString();
  const session = input.session;

  if (session.recordingWindow.requestedStopAt === null) {
    session.recordingWindow.requestedStopAt = finalizedAt;
  }
  session.recordingWindow.scheduledStopAt = null;
  session.recordingWindow.autoStopMinutes = null;

  session.status = input.nextStatus;
  session.error = input.errorMessage
    ? {
        message: input.errorMessage,
      }
    : null;
  appendSessionWarning(session, input.warningMessage);

  await Promise.all([
    finalizeRecordingState({
      session,
      runtime: input.runtime,
      finalizedAt,
      stopPersistedProcess: input.stopPersistedProcess,
      processStopOptions: input.processStopOptions,
    }),
    finalizeQueryState({
      session,
      runtime: input.runtime,
      finalizedAt,
      stopPersistedProcess: input.stopPersistedProcess,
      processStopOptions: input.processStopOptions,
    }),
  ]);

  session.updatedAt = finalizedAt;
  await writeSession(session);
}

async function finalizeRecordingState(input: {
  session: LabSession;
  runtime: LabRuntimeEntry | null;
  finalizedAt: string;
  stopPersistedProcess?: (
    input: PersistedProcessStopInput,
  ) => Promise<LabProcessExitResult | null>;
  processStopOptions?: Readonly<ProcessStopOptions>;
}): Promise<void> {
  const recording = input.session.screenpipe.recording;
  recording.state = "stopped";
  recording.stoppedAt ??= input.finalizedAt;

  if (input.runtime?.recordingProcess) {
    input.runtime.allowRecordingExit = true;
    const exit = await stopProcess(
      input.runtime.recordingProcess,
      input.processStopOptions,
    );
    input.runtime.recordingProcess = null;
    recording.pid = null;
    recording.exitCode = exit.code;
    return;
  }

  if (
    typeof recording.pid === "number" &&
    recording.pid > 0 &&
    typeof input.stopPersistedProcess === "function"
  ) {
    const exit = await input.stopPersistedProcess({
      pid: recording.pid,
      expectedCommand: recording.command,
    });
    if (exit) {
      recording.pid = null;
      recording.exitCode = exit.code;
    }
  }
}

async function finalizeQueryState(input: {
  session: LabSession;
  runtime: LabRuntimeEntry | null;
  finalizedAt: string;
  stopPersistedProcess?: (
    input: PersistedProcessStopInput,
  ) => Promise<LabProcessExitResult | null>;
  processStopOptions?: Readonly<ProcessStopOptions>;
}): Promise<void> {
  const queryMode = input.session.screenpipe.queryMode;
  queryMode.state = "stopped";
  queryMode.stoppedAt ??= input.finalizedAt;

  if (input.runtime?.queryProcess) {
    input.runtime.allowQueryExit = true;
    const exit = await stopProcess(
      input.runtime.queryProcess,
      input.processStopOptions,
    );
    input.runtime.queryProcess = null;
    queryMode.pid = null;
    queryMode.exitCode = exit.code;
    return;
  }

  if (
    typeof queryMode.pid === "number" &&
    queryMode.pid > 0 &&
    typeof input.stopPersistedProcess === "function"
  ) {
    const exit = await input.stopPersistedProcess({
      pid: queryMode.pid,
      expectedCommand: queryMode.command,
    });
    if (exit) {
      queryMode.pid = null;
      queryMode.exitCode = exit.code;
    }
  }
}

function appendSessionWarning(session: LabSession, message: string): void {
  if (!session.warnings.includes(message)) {
    session.warnings = [...session.warnings, message];
  }
}

function isTerminalSessionStatus(status: LabSession["status"]): boolean {
  return (
    status === "ready" ||
    status === "interrupted" ||
    status === "failed" ||
    status === "idle"
  );
}

function shouldPreserveCompletedSessionOnCleanup(session: LabSession): boolean {
  if (session.status !== "ready") {
    return false;
  }

  if (!hasCompletedProcessSnapshot(session.screenpipe.recording)) {
    return false;
  }

  return (
    hasCompletedProcessSnapshot(session.screenpipe.queryMode) ||
    hasCompletedIngestArtifactSnapshot(session)
  );
}

function hasCompletedIngestArtifactSnapshot(session: LabSession): boolean {
  return (
    typeof session.ingest.latestRunId === "string" &&
    session.ingest.latestRunId.length > 0 &&
    typeof session.ingest.latestRunDir === "string" &&
    session.ingest.latestRunDir.length > 0 &&
    typeof session.ingest.summaryPath === "string" &&
    session.ingest.summaryPath.length > 0
  );
}

function hasCompletedProcessSnapshot(processState: {
  pid: number | null;
  state: string;
  stoppedAt: string | null;
}): boolean {
  if (!(typeof processState.pid === "number" && processState.pid > 0)) {
    return true;
  }

  return processState.state === "stopped" && processState.stoppedAt !== null;
}

async function shouldRepairInterruptedSession(
  session: LabSession,
  isPersistedProcessAlive: (
    input: PersistedProcessStopInput,
  ) => Promise<boolean>,
): Promise<boolean> {
  if (!isTerminalSessionStatus(session.status)) {
    return true;
  }

  if (
    await hasPersistedProcessNeedingCleanup(
      session.screenpipe.recording,
      isPersistedProcessAlive,
    )
  ) {
    return true;
  }

  return hasPersistedProcessNeedingCleanup(
    session.screenpipe.queryMode,
    isPersistedProcessAlive,
  );
}

async function hasPersistedProcessNeedingCleanup(
  processState: {
    pid: number | null;
    state: string;
    stoppedAt: string | null;
    command: string[];
  },
  isPersistedProcessAlive: (
    input: PersistedProcessStopInput,
  ) => Promise<boolean>,
): Promise<boolean> {
  if (!(typeof processState.pid === "number" && processState.pid > 0)) {
    return false;
  }

  if (processState.state !== "stopped" || processState.stoppedAt === null) {
    return true;
  }

  return isPersistedProcessAlive({
    pid: processState.pid,
    expectedCommand: processState.command,
  });
}

function buildRecordingCommand(
  runtimeConfig: RuntimeConfig,
  dataDir: string,
  options: {
    port?: number;
    ocrLanguagePriority?: readonly LabScreenpipeLanguage[];
    enableAudio?: boolean;
  } = {},
): string[] {
  const ocrLanguagePriority = normalizeOcrLanguagePriority(
    options.ocrLanguagePriority,
  );
  const enableAudio = normalizeEnableAudio(options.enableAudio);
  const cliProfile = readScreenpipeCliProfile(
    runtimeConfig.screenpipeBinaryPath,
  );
  return [
    runtimeConfig.screenpipeBinaryPath,
    ...(cliProfile.recordSubcommand ? ["record"] : []),
    "--port",
    String(options.port ?? runtimeConfig.screenpipeRecordingPort),
    enableAudio ? "--use-system-default-audio" : "--disable-audio",
    ...(enableAudio && cliProfile.supportsDisableSystemAudio
      ? ["--disable-system-audio"]
      : []),
    ...(enableAudio && cliProfile.supportsTranscriptionMode
      ? ["--transcription-mode", "realtime"]
      : []),
    ...(cliProfile.supportsAdaptiveFps ? ["--adaptive-fps"] : []),
    ...ocrLanguagePriority.flatMap((language) => ["--language", language]),
    ...(cliProfile.supportsUiEvents ? ["--enable-ui-events"] : []),
    "--data-dir",
    dataDir,
  ];
}

function buildQueryModeCommand(
  runtimeConfig: RuntimeConfig,
  port: number,
  dataDir: string,
): string[] {
  const cliProfile = readScreenpipeCliProfile(
    runtimeConfig.screenpipeBinaryPath,
  );
  return [
    runtimeConfig.screenpipeBinaryPath,
    ...(cliProfile.recordSubcommand ? ["record"] : []),
    "--port",
    String(port),
    "--disable-audio",
    "--disable-vision",
    "--data-dir",
    dataDir,
  ];
}

interface ScreenpipeCliProfile {
  recordSubcommand: boolean;
  supportsAdaptiveFps: boolean;
  supportsUiEvents: boolean;
  supportsTranscriptionMode: boolean;
  supportsDisableSystemAudio: boolean;
}

function readScreenpipeCliProfile(
  screenpipeBinaryPath: string,
): ScreenpipeCliProfile {
  const manifestPath =
    resolveScreenpipeBundleManifestPath(screenpipeBinaryPath);
  if (!manifestPath) {
    return {
      recordSubcommand: false,
      supportsAdaptiveFps: true,
      supportsUiEvents: true,
      supportsTranscriptionMode: false,
      supportsDisableSystemAudio: false,
    };
  }

  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      recordSubcommand?: unknown;
      supportsAdaptiveFps?: unknown;
      supportsUiEvents?: unknown;
      supportsTranscriptionMode?: unknown;
      supportsDisableSystemAudio?: unknown;
    };
    return {
      recordSubcommand: manifest.recordSubcommand === true,
      supportsAdaptiveFps: manifest.supportsAdaptiveFps !== false,
      supportsUiEvents: manifest.supportsUiEvents !== false,
      supportsTranscriptionMode: manifest.supportsTranscriptionMode === true,
      supportsDisableSystemAudio: manifest.supportsDisableSystemAudio === true,
    };
  } catch {
    return {
      recordSubcommand: false,
      supportsAdaptiveFps: true,
      supportsUiEvents: true,
      supportsTranscriptionMode: false,
      supportsDisableSystemAudio: false,
    };
  }
}

function resolveScreenpipeBundleManifestPath(
  screenpipeBinaryPath: string,
): string | null {
  const binaryDir = dirname(screenpipeBinaryPath);
  const candidates = [
    join(binaryDir, "screenpipe-bundle.json"),
    join(binaryDir, "bundle.json"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

async function stopProcess(
  processHandle: LabProcessHandle,
  options: Readonly<ProcessStopOptions> = {},
): Promise<LabProcessExitResult> {
  const exitPromise = processHandle.onceExit();

  processHandle.kill("SIGINT");
  const graceful = await withTimeout(
    exitPromise,
    options.gracefulTimeoutMs ?? PROCESS_STOP_TIMEOUT_MS,
  );
  if (graceful) {
    return graceful;
  }

  processHandle.kill("SIGTERM");
  const forced = await withTimeout(
    exitPromise,
    options.terminateTimeoutMs ?? PROCESS_FORCE_TIMEOUT_MS,
  );
  if (forced) {
    return forced;
  }

  processHandle.kill("SIGKILL");
  return (
    (await withTimeout(
      exitPromise,
      options.killTimeoutMs ?? PROCESS_FORCE_TIMEOUT_MS,
    )) ?? {
      code: null,
      signal: "SIGKILL",
    }
  );
}

/**
 * EN: Races one asynchronous operation against service cancellation and a managed-process failure.
 * 中文: 让一个异步操作同时响应 service 取消信号与托管进程故障。
 * @param operation operation currently in progress.
 * @param options optional cancellation signal and process interruption promise.
 * @returns the operation result unless lifecycle interruption wins first.
 */
async function awaitInterruptibly<T>(
  operation: Promise<T>,
  options: {
    signal?: AbortSignal;
    processInterruption?: Promise<never>;
  } = {},
): Promise<T> {
  throwIfAborted(options.signal);
  let abortListener: (() => void) | null = null;
  const candidates: Array<Promise<T>> = [operation];
  if (options.signal) {
    const signal = options.signal;
    candidates.push(
      new Promise<never>((_resolveAbort, rejectAbort) => {
        abortListener = () => rejectAbort(abortError(signal));
        signal.addEventListener("abort", abortListener, { once: true });
      }),
    );
  }
  if (options.processInterruption) {
    candidates.push(options.processInterruption);
  }

  try {
    return await Promise.race(candidates);
  } finally {
    if (abortListener && options.signal) {
      options.signal.removeEventListener("abort", abortListener);
    }
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw abortError(signal);
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new RecorderBootstrapCancelledError();
}

function readProcessFailurePromise(
  processHandle: LabProcessHandle,
): Promise<never> | null {
  const monitored = processHandle as Partial<MonitoredLabProcessHandle>;
  return typeof monitored.onceFailure === "function"
    ? monitored.onceFailure()
    : null;
}

function createProcessReadinessInterruption(
  processHandle: LabProcessHandle,
  processLabel: string,
): Promise<never> {
  const exitFailure = processHandle.onceExit().then<never>((result) => {
    throw new LabProcessFailureError(
      `${processLabel} exited before becoming healthy (code=${result.code ?? "null"}, signal=${result.signal ?? "null"})`,
    );
  });
  const runtimeFailure = readProcessFailurePromise(processHandle);
  return runtimeFailure
    ? Promise.race([runtimeFailure, exitFailure])
    : exitFailure;
}

function waitForProcessExitOrFailure(
  processHandle: LabProcessHandle,
): Promise<LabProcessExitResult> {
  const runtimeFailure = readProcessFailurePromise(processHandle);
  return runtimeFailure
    ? Promise.race([processHandle.onceExit(), runtimeFailure])
    : processHandle.onceExit();
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | null> {
  return new Promise((resolveTimeout) => {
    const timer = setTimeout(() => resolveTimeout(null), timeoutMs);
    void promise
      .then((value) => {
        clearTimeout(timer);
        resolveTimeout(value);
      })
      .catch(() => {
        clearTimeout(timer);
        resolveTimeout(null);
      });
  });
}

/**
 * EN: Applies a nullable timeout while preserving the source promise's diagnostic rejection.
 * 中文: 提供可空超时，同时保留源 Promise 的可诊断失败。
 * @param promise source operation.
 * @param timeoutMs timeout in milliseconds.
 * @returns source value, or null when the timeout wins.
 */
async function withTimeoutPreservingError<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | null> {
  return new Promise<T | null>((resolveTimeout, rejectTimeout) => {
    const timer = setTimeout(() => resolveTimeout(null), timeoutMs);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolveTimeout(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        rejectTimeout(error);
      },
    );
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * EN: Formats one OCR language priority list for warnings and debug output.
 * @param languages priority-ordered OCR languages.
 * @returns display string such as `chinese -> english`.
 */
function formatLanguagePrioritySummary(
  languages: readonly LabScreenpipeLanguage[],
): string {
  return languages.join(" -> ");
}

function formatEnableAudioSummary(enableAudio: boolean): string {
  return enableAudio ? '"enabled"' : '"disabled"';
}

function createScreenpipeApiToken(): string {
  return `ow-${randomBytes(24).toString("hex")}`;
}

async function spawnLoggedProcess(
  input: SpawnProcessInput,
): Promise<LabProcessHandle> {
  await mkdir(dirname(input.logPath), { recursive: true });

  const useProcessGroup = process.platform !== "win32";
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(input.command[0], input.command.slice(1), {
      cwd: input.cwd,
      detached: useProcessGroup,
      env: {
        ...process.env,
        ...input.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    throw loggedProcessError(input, "start process", error);
  }
  const logStream = createWriteStream(input.logPath, { flags: "a" });
  const exitEmitter = new EventEmitter();
  let processExited = false;
  const exitPromise = new Promise<LabProcessExitResult>((resolveExit) => {
    child.once("close", (code, signal) => {
      processExited = true;
      const result: LabProcessExitResult = {
        code,
        signal: signal as NodeJS.Signals | null,
      };
      resolveExit(result);
      exitEmitter.emit("exit", result);
      child.stdout?.unpipe(logStream);
      child.stderr?.unpipe(logStream);
      if (!logStream.destroyed) {
        logStream.end();
      }
    });
  });
  let rejectFailure!: (error: Error) => void;
  let failureSettled = false;
  const failurePromise = new Promise<never>((_resolveFailure, reject) => {
    rejectFailure = reject;
  });
  void failurePromise.catch(() => undefined);

  let childSpawned = false;
  let logOpened = false;
  let initializationSettled = false;
  let failureKillRequested = false;
  let resolveInitialization!: () => void;
  let rejectInitialization!: (error: Error) => void;
  const initializationPromise = new Promise<void>((resolve, reject) => {
    resolveInitialization = resolve;
    rejectInitialization = reject;
  });

  const maybeResolveInitialization = (): void => {
    if (initializationSettled || !childSpawned || !logOpened) {
      return;
    }
    initializationSettled = true;
    resolveInitialization();
  };
  const killAfterInfrastructureFailure = (): void => {
    if (
      failureKillRequested ||
      processExited ||
      !child.pid ||
      child.exitCode !== null ||
      child.signalCode !== null
    ) {
      return;
    }
    failureKillRequested = true;
    signalProcessGroup(child, "SIGKILL", useProcessGroup);
  };
  const reportInfrastructureFailure = (
    operation: string,
    error: unknown,
  ): void => {
    const diagnostic = loggedProcessError(input, operation, error);
    child.stdout?.unpipe(logStream);
    child.stderr?.unpipe(logStream);
    if (!initializationSettled) {
      initializationSettled = true;
      rejectInitialization(diagnostic);
    } else if (!failureSettled && !processExited) {
      failureSettled = true;
      rejectFailure(diagnostic);
    }
    killAfterInfrastructureFailure();
    if (!logStream.destroyed) {
      logStream.destroy();
    }
  };

  child.once("spawn", () => {
    childSpawned = true;
    maybeResolveInitialization();
  });
  child.on("error", (error) => {
    reportInfrastructureFailure("run process", error);
  });
  logStream.once("open", () => {
    logOpened = true;
    maybeResolveInitialization();
  });
  logStream.on("error", (error) => {
    reportInfrastructureFailure("write process log", error);
  });
  child.stdout?.pipe(logStream, { end: false });
  child.stderr?.pipe(logStream, { end: false });

  const handle: MonitoredLabProcessHandle = {
    pid: child.pid ?? null,
    kill(signal) {
      return signalProcessGroup(child, signal ?? "SIGTERM", useProcessGroup);
    },
    onceExit() {
      return exitPromise;
    },
    onExit(listener) {
      exitEmitter.on("exit", listener);
    },
    onceFailure() {
      return failurePromise;
    },
  };

  try {
    await initializationPromise;
  } catch (error) {
    killAfterInfrastructureFailure();
    if (child.pid) {
      await withTimeout(exitPromise, PROCESS_FORCE_TIMEOUT_MS);
    }
    throw error;
  }

  return handle;
}

function loggedProcessError(
  input: SpawnProcessInput,
  operation: string,
  error: unknown,
): LabProcessFailureError {
  const executable = input.command[0] || "<missing executable>";
  return new LabProcessFailureError(
    `Failed to ${operation} "${executable}" with log "${input.logPath}": ${toErrorMessage(error)}`,
  );
}

async function stopPersistedProcessByPid(
  input: PersistedProcessStopInput,
): Promise<LabProcessExitResult | null> {
  if (!(await isPersistedProcessAliveByPid(input))) {
    return null;
  }

  if (tryKillPid(input.pid, "SIGINT")) {
    const graceful = await waitForPidExit(input.pid, PROCESS_STOP_TIMEOUT_MS);
    if (graceful) {
      return graceful;
    }
  }

  if (tryKillPid(input.pid, "SIGTERM")) {
    const forced = await waitForPidExit(input.pid, PROCESS_FORCE_TIMEOUT_MS);
    if (forced) {
      return forced;
    }
  }

  if (process.platform === "win32") {
    const terminated = await terminateWindowsProcessTree(input.pid);
    if (!terminated) {
      tryKillPid(input.pid, "SIGKILL");
    }
  } else {
    tryKillPid(input.pid, "SIGKILL");
  }
  return (
    (await waitForPidExit(input.pid, PROCESS_FORCE_TIMEOUT_MS)) ?? {
      code: null,
      signal: "SIGKILL",
    }
  );
}

async function isPersistedProcessAliveByPid(
  input: PersistedProcessStopInput,
): Promise<boolean> {
  if (!Number.isInteger(input.pid) || input.pid <= 0) {
    return false;
  }

  const pidAlive = isPidAlive(input.pid);
  const processGroupAlive = isProcessGroupAlive(input.pid);
  if (!pidAlive && !processGroupAlive) {
    return false;
  }
  if (!pidAlive) {
    return processGroupAlive;
  }

  const expectedExecutable = input.expectedCommand[0] ?? "";
  if (expectedExecutable.length === 0) {
    return true;
  }

  const commandLine = await readProcessCommandLine(input.pid);
  return (
    typeof commandLine === "string" && commandLine.includes(expectedExecutable)
  );
}

async function readProcessCommandLine(pid: number): Promise<string | null> {
  if (process.platform === "win32") {
    return readWindowsProcessCommandLine(pid);
  }
  return readBoundedProcessCommand("ps", ["-p", String(pid), "-o", "command="]);
}

async function readWindowsProcessCommandLine(
  pid: number,
): Promise<string | null> {
  const escapedPid = String(pid);
  return readBoundedProcessCommand(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `$process = Get-CimInstance Win32_Process -Filter "ProcessId = ${escapedPid}" -ErrorAction SilentlyContinue; if ($process) { $process.CommandLine }`,
    ],
    { windowsHide: true },
  );
}

/**
 * EN: Runs a command-line identity probe with a hard deadline and bounded output.
 * 中文：以硬超时和有界输出执行进程命令行身份探测。
 * @param command probe executable.
 * @param args probe arguments.
 * @param options optional Windows process options.
 * @returns trimmed stdout for successful probes, otherwise `null`.
 */
async function readBoundedProcessCommand(
  command: string,
  args: string[],
  options: { windowsHide?: boolean } = {},
): Promise<string | null> {
  return new Promise((resolveCommand) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: options.windowsHide,
    });
    let stdout = Buffer.alloc(0);
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolveCommand(value);
    };
    const timeout = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // The probe may have exited between the deadline and the kill call.
      }
      finish(null);
    }, PROCESS_COMMAND_PROBE_TIMEOUT_MS);
    timeout.unref?.();
    child.stdout?.on("data", (chunk: Buffer | string) => {
      const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdout = Buffer.concat([stdout, next]);
      if (stdout.byteLength > PROCESS_COMMAND_PROBE_MAX_BYTES) {
        stdout = stdout.subarray(
          stdout.byteLength - PROCESS_COMMAND_PROBE_MAX_BYTES,
        );
      }
    });
    child.once("error", () => finish(null));
    child.once("close", (code) => {
      finish(code === 0 ? stdout.toString("utf8").trim() || null : null);
    });
  });
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isProcessGroupAlive(pid: number): boolean {
  if (process.platform === "win32") {
    return false;
  }
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function tryKillPid(pid: number, signal: NodeJS.Signals): boolean {
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return true;
    } catch {
      // EN/CN: Legacy persisted processes may not be process-group leaders.
    }
  }
  try {
    return process.kill(pid, signal);
  } catch {
    return false;
  }
}

async function waitForPidExit(
  pid: number,
  timeoutMs: number,
): Promise<LabProcessExitResult | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid) && !isProcessGroupAlive(pid)) {
      return {
        code: null,
        signal: null,
      };
    }
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 200));
  }
  return null;
}

async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolvePort) => {
    const server = createServer();
    server.once("error", () => {
      resolvePort(false);
    });
    server.once("listening", () => {
      server.close(() => resolvePort(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

async function findFreePort(fromPort: number): Promise<number> {
  for (let port = fromPort; port < fromPort + 100; port += 1) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }

  throw new Error(`No free port available starting from ${fromPort}.`);
}

async function readWorkflowArtifact(
  workflowPath: string,
): Promise<WorkflowDiscoveryArtifact> {
  const raw = await readFile(workflowPath, "utf8");
  return sanitizeWorkflowArtifact(JSON.parse(raw) as WorkflowDiscoveryArtifact);
}

async function safeReadWorkflowArtifact(
  workflowPath: string | null,
): Promise<WorkflowDiscoveryArtifact | null> {
  if (!workflowPath) {
    return null;
  }

  try {
    return await readWorkflowArtifact(workflowPath);
  } catch {
    return null;
  }
}

async function writeJsonFile(path: string, data: unknown): Promise<void> {
  const outputDir = dirname(path);
  const tempPath = join(
    outputDir,
    `.${sanitizeFileSegment(basename(path) || "artifact")}.${process.pid ?? "lab"}.tmp`,
  );

  await mkdir(outputDir, { recursive: true });
  await writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(tempPath, path);
}

function clearDerivedArtifacts(session: LabSession): void {
  session.sessionName = null;
  session.workflowDiscovery.latestPath = null;
  session.workflowDiscovery.workflowCandidates = [];
  resetSkillSelection(session);
  session.selection.workflowId = null;
  session.selection.workflowPath = null;
}

/**
 * CN: 开始一个真实工作流生成阶段，并完成前一个活动阶段。
 * EN: Starts one real workflow-generation stage and closes the prior active stage.
 * @param session mutable persisted session.
 * @param stage next real generation stage.
 * @param now transition timestamp.
 * @returns void.
 */
function beginGenerationStage(
  session: LabSession,
  stage: LabWorkflowGenerationStage,
  now: Date,
): void {
  const timestamp = now.toISOString();
  if (session.generationProgress.currentStage === stage) {
    return;
  }

  if (session.generationProgress.currentStage) {
    const activeTiming =
      session.generationProgress.stages[
        session.generationProgress.currentStage
      ];
    activeTiming.completedAt ??= timestamp;
  }

  const stageIndex = LAB_WORKFLOW_GENERATION_STAGES.indexOf(stage);
  for (
    let index = stageIndex;
    index < LAB_WORKFLOW_GENERATION_STAGES.length;
    index += 1
  ) {
    const resetStage = LAB_WORKFLOW_GENERATION_STAGES[index];
    session.generationProgress.stages[resetStage] = {
      startedAt: null,
      completedAt: null,
    };
  }

  session.generationProgress.currentStage = stage;
  session.generationProgress.failedStage = null;
  session.generationProgress.failedAt = null;
  session.generationProgress.completedAt = null;
  session.generationProgress.stages[stage].startedAt = timestamp;
}

/**
 * CN: 完成当前真实阶段，可选标记整个生成链路完成。
 * EN: Completes the current real stage and optionally the whole generation chain.
 * @param session mutable persisted session.
 * @param now completion timestamp.
 * @param completesWorkflow whether the workflow generation chain is complete.
 * @returns void.
 */
function completeCurrentGenerationStage(
  session: LabSession,
  now: Date,
  completesWorkflow: boolean,
): void {
  const timestamp = now.toISOString();
  const currentStage = session.generationProgress.currentStage;
  if (currentStage) {
    const timing = session.generationProgress.stages[currentStage];
    timing.startedAt ??= timestamp;
    timing.completedAt = timestamp;
  }
  session.generationProgress.currentStage = null;
  session.generationProgress.failedStage = null;
  session.generationProgress.failedAt = null;
  if (completesWorkflow) {
    session.generationProgress.completedAt = timestamp;
  }
}

/**
 * CN: 记录真实失败阶段，供 UI 精确展示失败位置。
 * EN: Persists the real failed stage for precise UI diagnostics.
 * @param session mutable persisted session.
 * @param now failure timestamp.
 * @returns void.
 */
function failCurrentGenerationStage(session: LabSession, now: Date): void {
  const currentStage = session.generationProgress.currentStage;
  session.generationProgress.failedStage = currentStage;
  session.generationProgress.failedAt = now.toISOString();
  session.generationProgress.currentStage = null;
  session.generationProgress.completedAt = null;
}

function resetSkillSelection(session: LabSession): void {
  session.skillExtraction.latestOutDir = null;
  session.skillExtraction.skillPath = null;
  session.skillExtraction.summaryPath = null;
  session.skillExtraction.skill = null;
  session.skillExtraction.summary = null;
  session.skillExtraction.artifacts = [];
  clearGeneralizationSelection(session);
}

function clearGeneralizationSelection(session: LabSession): void {
  session.generalization.latestOutDir = null;
  session.generalization.summaryPath = null;
  session.generalization.summary = null;
  session.generalization.artifacts = [];
  clearPlannerOptimizationSelection(session);
}

function clearPlannerOptimizationSelection(session: LabSession): void {
  session.plannerOptimization.latestOutDir = null;
  session.plannerOptimization.skillPath = null;
  session.plannerOptimization.summaryPath = null;
  session.plannerOptimization.skill = null;
  session.plannerOptimization.summary = null;
}

function clearPlannerOptimizationIfSourceSkillEdited(
  session: LabSession,
  input: {
    sourceType: PlannerOptimizationSourceType;
    skillPath: string;
  },
): boolean {
  const summary = session.plannerOptimization.summary;
  if (
    !summary ||
    summary.sourceType !== input.sourceType ||
    summary.sourceSkillPath !== input.skillPath
  ) {
    return false;
  }

  clearPlannerOptimizationSelection(session);
  return true;
}

function findBaseSkillArtifactByWorkflowId(
  session: LabSession,
  workflowId: string | null | undefined,
): LabSession["skillExtraction"]["artifacts"][number] | null {
  if (!workflowId) {
    return null;
  }
  return (
    session.skillExtraction.artifacts.find(
      (artifact) => artifact.workflowId === workflowId,
    ) ?? null
  );
}

function findBaseSkillArtifactBySkillPath(
  session: LabSession,
  skillPath: string,
): LabSession["skillExtraction"]["artifacts"][number] | null {
  return (
    session.skillExtraction.artifacts.find(
      (artifact) => artifact.skillPath === skillPath,
    ) ?? null
  );
}

function upsertBaseSkillArtifact(
  session: LabSession,
  artifact: LabSession["skillExtraction"]["artifacts"][number],
): void {
  const nextArtifacts = session.skillExtraction.artifacts.filter(
    (candidate) =>
      !(
        (artifact.workflowId && candidate.workflowId === artifact.workflowId) ||
        candidate.skillPath === artifact.skillPath
      ),
  );
  nextArtifacts.push(artifact);
  session.skillExtraction.artifacts = sortBaseSkillArtifacts(
    nextArtifacts,
    session.workflowDiscovery.workflowCandidates,
  );
}

function sortBaseSkillArtifacts(
  artifacts: LabSession["skillExtraction"]["artifacts"],
  workflowCandidates: LabSession["workflowDiscovery"]["workflowCandidates"],
): LabSession["skillExtraction"]["artifacts"] {
  const priorityByWorkflowId = new Map(
    workflowCandidates.map((candidate) => [
      candidate.workflowId,
      candidate.priority,
    ]),
  );
  return [...artifacts].sort((left, right) => {
    const leftPriority = priorityByWorkflowId.get(left.workflowId ?? "") ?? 999;
    const rightPriority =
      priorityByWorkflowId.get(right.workflowId ?? "") ?? 999;
    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }
    return right.summary.generatedAt.localeCompare(left.summary.generatedAt);
  });
}

function syncLatestBaseSkillArtifact(
  session: LabSession,
  artifact: LabSession["skillExtraction"]["artifacts"][number] | null,
): void {
  session.skillExtraction.latestOutDir = artifact?.latestOutDir ?? null;
  session.skillExtraction.skillPath = artifact?.skillPath ?? null;
  session.skillExtraction.summaryPath = artifact?.summaryPath ?? null;
  session.skillExtraction.skill = artifact?.skill ?? null;
  session.skillExtraction.summary = artifact?.summary ?? null;
}

function upsertGeneralizationArtifact(
  session: LabSession,
  artifact: LabSession["generalization"]["artifacts"][number],
): void {
  session.generalization.artifacts = [
    ...session.generalization.artifacts.filter(
      (candidate) => candidate.sourceSkillPath !== artifact.sourceSkillPath,
    ),
    artifact,
  ];
}

function getLatestGeneralizationArtifact(
  session: LabSession,
): LabSession["generalization"]["artifacts"][number] | null {
  return (
    [...session.generalization.artifacts].sort((left, right) =>
      right.summary.generatedAt.localeCompare(left.summary.generatedAt),
    )[0] ?? null
  );
}

function syncLatestGeneralizationArtifact(
  session: LabSession,
  artifact: LabSession["generalization"]["artifacts"][number] | null,
): void {
  session.generalization.latestOutDir = artifact?.latestOutDir ?? null;
  session.generalization.summaryPath = artifact?.summaryPath ?? null;
  session.generalization.summary = artifact?.summary ?? null;
}

function removeGeneralizationArtifactsForSourceSkillPath(
  session: LabSession,
  sourceSkillPath: string,
): void {
  session.generalization.artifacts = session.generalization.artifacts.filter(
    (artifact) => artifact.sourceSkillPath !== sourceSkillPath,
  );
  syncLatestGeneralizationArtifact(
    session,
    getLatestGeneralizationArtifact(session),
  );
}

function syncSkillExtractionSummaryWithSkill(
  summary: SkillExtractionSummary,
  skill: OpenClawSkill,
): SkillExtractionSummary {
  return {
    ...summary,
    skillId: skill.skillId,
    stepsCount: skill.steps.length,
  };
}

function removeGeneralizationArtifactsForWorkflow(
  session: LabSession,
  input: {
    workflowId: string | null;
    replacedSkillPath: string | null;
  },
): void {
  session.generalization.artifacts = session.generalization.artifacts.filter(
    (artifact) => {
      if (
        input.workflowId &&
        artifact.selectedWorkflowId === input.workflowId
      ) {
        return false;
      }
      if (
        input.replacedSkillPath &&
        artifact.sourceSkillPath === input.replacedSkillPath
      ) {
        return false;
      }
      return true;
    },
  );
  syncLatestGeneralizationArtifact(
    session,
    getLatestGeneralizationArtifact(session),
  );
}

function findGeneralizedVariantBySkillPath(
  session: LabSession,
  skillPath: string,
): {
  generalizationArtifact: LabSession["generalization"]["artifacts"][number];
  variant: LabSession["generalization"]["artifacts"][number]["summary"]["variantArtifacts"][number];
} | null {
  for (const generalizationArtifact of session.generalization.artifacts) {
    const variant =
      generalizationArtifact.summary.variantArtifacts.find(
        (candidate) => candidate.summary.output.skillPath === skillPath,
      ) ?? null;
    if (variant) {
      return {
        generalizationArtifact,
        variant,
      };
    }
  }
  return null;
}

function prunePlannerOptimizationIfSourceMissing(session: LabSession): void {
  const summary = session.plannerOptimization.summary;
  if (
    !summary ||
    !session.plannerOptimization.skillPath ||
    !session.plannerOptimization.summaryPath
  ) {
    return;
  }

  const sourceStillExists =
    summary.sourceType === "base"
      ? findBaseSkillArtifactBySkillPath(session, summary.sourceSkillPath) !==
        null
      : findGeneralizedVariantBySkillPath(session, summary.sourceSkillPath) !==
        null;
  if (!sourceStillExists) {
    clearPlannerOptimizationSelection(session);
  }
}

function formatArtifactStamp(date: Date): string {
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${yyyy}${mm}${dd}-${hh}${min}${ss}`;
}

function sanitizeFileSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function buildPlannerOptimizationDirectoryName(input: {
  now: Date;
  sourceType: PlannerOptimizationSourceType;
  skillPath: string;
}): string {
  const sourceLabel =
    basename(dirname(input.skillPath)) || basename(input.skillPath) || "skill";
  return `${formatArtifactStamp(input.now)}-${input.sourceType}-${sanitizeFileSegment(sourceLabel)}`;
}

function resolveOpenClawInstallSource(
  session: LabSession,
  input: OpenClawInstallInput,
): {
  skillPath: string;
  summaryPath: string;
} {
  if (input.sourceType === "base") {
    const artifact = findBaseSkillArtifactBySkillPath(session, input.skillPath);
    if (!artifact) {
      throw new Error(
        session.skillExtraction.artifacts.length === 0
          ? "OpenClaw install requires one completed base skill extraction."
          : "OpenClaw install source does not belong to this session.",
      );
    }
    return {
      skillPath: artifact.skillPath,
      summaryPath: artifact.summaryPath,
    };
  }

  if (input.sourceType === "planner-optimized") {
    if (
      !session.plannerOptimization.skillPath ||
      !session.plannerOptimization.summaryPath
    ) {
      throw new Error(
        "OpenClaw install requires one completed planner optimization result.",
      );
    }
    if (session.plannerOptimization.skillPath !== input.skillPath) {
      throw new Error(
        "OpenClaw install source does not belong to this session.",
      );
    }
    return {
      skillPath: session.plannerOptimization.skillPath,
      summaryPath: session.plannerOptimization.summaryPath,
    };
  }

  const matched = findGeneralizedVariantBySkillPath(session, input.skillPath);
  if (!matched) {
    throw new Error("OpenClaw install source does not belong to this session.");
  }
  return {
    skillPath: matched.variant.summary.output.skillPath,
    summaryPath: matched.variant.summary.output.summaryPath,
  };
}

function sanitizeWorkflowArtifact(
  artifact: WorkflowDiscoveryArtifact,
): WorkflowDiscoveryArtifact {
  return {
    ...artifact,
    workflowCandidates: artifact.workflowCandidates.map((candidate) => ({
      workflowId: candidate.workflowId,
      name: candidate.name,
      description: candidate.description,
      goal: candidate.goal,
      priority: candidate.priority,
      startEventId: candidate.startEventId,
      endEventId: candidate.endEventId,
      startTs: candidate.startTs,
      endTs: candidate.endTs,
      eventCount: candidate.eventCount,
      ...(candidate.whyThisWorkflow
        ? { whyThisWorkflow: candidate.whyThisWorkflow }
        : {}),
    })),
  };
}

function buildWorkflowArtifactSourceFromSession(
  session: LabSession,
): WorkflowDiscoveryArtifact["source"] {
  const observedWindow = session.ingest.summary?.timeWindow.observed;
  const requestedWindow = session.ingest.summary?.timeWindow.requested;
  return {
    runDir: session.ingest.latestRunDir ?? session.paths.ingestOutDir,
    startTs:
      observedWindow?.startTs ??
      requestedWindow?.startTs ??
      new Date(0).toISOString(),
    endTs:
      observedWindow?.endTs ??
      requestedWindow?.endTs ??
      observedWindow?.startTs ??
      requestedWindow?.startTs ??
      new Date(0).toISOString(),
  };
}

function resolveSelectedWorkflowIdForSession(input: {
  workflowCandidates: WorkflowCandidate[];
  requestedWorkflowId: string | null;
  currentWorkflowId: string | null;
}): string | null {
  const workflowIds = new Set(
    input.workflowCandidates.map((candidate) => candidate.workflowId),
  );
  if (input.requestedWorkflowId && workflowIds.has(input.requestedWorkflowId)) {
    return input.requestedWorkflowId;
  }
  if (input.currentWorkflowId && workflowIds.has(input.currentWorkflowId)) {
    return input.currentWorkflowId;
  }
  return (
    selectPreferredWorkflowCandidate(input.workflowCandidates)?.workflowId ??
    null
  );
}

function deriveSessionNameFromWorkflowCandidates(
  candidates: WorkflowCandidate[],
): string | null {
  let highestPriorityCandidate: WorkflowCandidate | null = null;
  for (const candidate of candidates) {
    if (
      highestPriorityCandidate === null ||
      candidate.priority < highestPriorityCandidate.priority
    ) {
      highestPriorityCandidate = candidate;
    }
  }

  if (!highestPriorityCandidate) {
    return null;
  }

  return toSessionNamePrefix(highestPriorityCandidate.name);
}

function toSessionNamePrefix(value: string): string | null {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }

  return Array.from(normalized)
    .slice(0, SESSION_NAME_PREFIX_MAX_CHARS)
    .join("");
}

function isHealthyHealthPayload(health: Record<string, unknown>): boolean {
  return (
    health.status === "healthy" ||
    health.status_code === 200 ||
    health.statusCode === 200
  );
}

function buildNonBlockingRecorderPermissionsResponse(input: {
  checkedAt: string;
  summary: string;
}): RecorderPermissionsResponse {
  const items = buildRecorderPermissionItems({
    screenRecording: {
      state: "granted",
      detail: "",
    },
    accessibility: {
      state: "granted",
      detail: "",
    },
    inputMonitoring: {
      state: "granted",
      detail: "",
    },
  });
  return {
    checkedAt: input.checkedAt,
    allGranted: true,
    canStartRecording: true,
    source: "not-needed",
    items,
    summary: input.summary,
  };
}

function buildRecorderPermissionsFromExistingRecorder(input: {
  checkedAt: string;
  baseUrl: string;
}): RecorderPermissionsResponse {
  const detail = "";
  const items = buildRecorderPermissionItems({
    screenRecording: {
      state: "granted",
      detail,
    },
    accessibility: {
      state: "granted",
      detail,
    },
    inputMonitoring: {
      state: "granted",
      detail,
    },
  });
  return {
    checkedAt: input.checkedAt,
    allGranted: true,
    canStartRecording: true,
    source: "existing-recorder",
    items,
    summary: `A healthy recorder is already running at ${input.baseUrl}.`,
  };
}

function buildRecorderPermissionsFromProbe(
  probe: RecorderPermissionProbeResult,
): RecorderPermissionsResponse {
  const healthText = probe.health ? JSON.stringify(probe.health) : "";
  const uiPermissions = parseUiPermissionStatus(probe.logText);
  const quietScreenRecording = parseRecorderPermissionState(
    probe.health?.screenRecording,
  );
  const quietAccessibility = parseRecorderPermissionState(
    probe.health?.accessibility,
  );
  const quietInputMonitoring = parseRecorderPermissionState(
    probe.health?.inputMonitoring,
  );
  const screenRecordingDenied =
    hasScreenRecordingDeniedSignal(probe.logText) ||
    hasKeywordInText(healthText, "screen recording permission denied");
  const responded = probe.health !== null;
  const screenRecordingState =
    quietScreenRecording ??
    (screenRecordingDenied ? "missing" : responded ? "granted" : "unknown");
  const accessibilityState =
    quietAccessibility ??
    (uiPermissions?.accessibility === true
      ? "granted"
      : uiPermissions?.accessibility === false
        ? "missing"
        : responded
          ? "granted"
          : "unknown");
  const inputMonitoringState =
    quietInputMonitoring ??
    (uiPermissions?.inputMonitoring === true
      ? "granted"
      : uiPermissions?.inputMonitoring === false
        ? "missing"
        : responded
          ? "granted"
          : "unknown");
  const items = buildRecorderPermissionItems({
    screenRecording: {
      state: screenRecordingState,
      detail:
        screenRecordingState === "missing"
          ? "Turn on Screen Recording in System Settings, then return here and refresh."
          : probe.error
            ? "We could not verify Screen Recording automatically."
            : "",
    },
    accessibility: {
      state: accessibilityState,
      detail:
        accessibilityState === "missing"
          ? "Turn on Accessibility in System Settings, then return here and refresh."
          : probe.error
            ? "We could not verify Accessibility automatically."
            : "",
    },
    inputMonitoring: {
      state: inputMonitoringState,
      detail:
        inputMonitoringState === "missing"
          ? "Turn on Input Monitoring in System Settings, then return here and refresh."
          : probe.error
            ? "We could not verify Input Monitoring automatically."
            : "",
    },
  });
  const allGranted = items.every((item) => item.state === "granted");
  return {
    checkedAt: probe.checkedAt,
    allGranted,
    canStartRecording: allGranted,
    source: "screenpipe-probe",
    items,
    summary: allGranted
      ? "All required macOS permissions are available."
      : `Open the missing System Settings pages below, then return here and refresh. Probe log: ${probe.logPath}`,
  };
}

function parseRecorderPermissionJson(
  logText: string,
): Record<string, unknown> | null {
  const lines = logText
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse();
  for (const line of lines) {
    try {
      const parsed = asRecord(JSON.parse(line));
      if (parsed && "screenRecording" in parsed) {
        return parsed;
      }
    } catch {
      continue;
    }
  }
  return null;
}

function parseRecorderPermissionState(
  value: unknown,
): RecorderPermissionItem["state"] | null {
  if (value === "granted") {
    return "granted";
  }
  if (value === "missing" || value === "not-determined") {
    return "missing";
  }
  return null;
}

function buildRecorderPermissionItems(input: {
  screenRecording: {
    state: RecorderPermissionsResponse["items"][number]["state"];
    detail: string;
  };
  accessibility: {
    state: RecorderPermissionsResponse["items"][number]["state"];
    detail: string;
  };
  inputMonitoring: {
    state: RecorderPermissionsResponse["items"][number]["state"];
    detail: string;
  };
}): RecorderPermissionItem[] {
  return [
    buildRecorderPermissionItem({
      kind: "screen-recording",
      label: "Screen Recording",
      description:
        "Lets OysterWorkflow read screen content so it can capture steps and visible text.",
      ...input.screenRecording,
    }),
    buildRecorderPermissionItem({
      kind: "accessibility",
      label: "Accessibility",
      description:
        "Lets OysterWorkflow notice app switches and UI changes while you work.",
      ...input.accessibility,
    }),
    buildRecorderPermissionItem({
      kind: "input-monitoring",
      label: "Input Monitoring",
      description:
        "Lets OysterWorkflow capture keyboard and pointer activity so recorded steps stay in sync.",
      ...input.inputMonitoring,
    }),
  ];
}

function buildRecorderPermissionItem(input: {
  kind: RecorderPermissionKind;
  label: string;
  description: string;
  state: RecorderPermissionItem["state"];
  detail: string;
}): RecorderPermissionItem {
  return {
    kind: input.kind,
    label: input.label,
    description: input.description,
    state: input.state,
    detail: input.detail,
  };
}

function parseUiPermissionStatus(logText: string): {
  accessibility: boolean;
  inputMonitoring: boolean;
} | null {
  const match =
    logText.match(
      /UI capture permissions not granted - accessibility:\s*(true|false), input_monitoring:\s*(true|false)/i,
    ) ??
    logText.match(
      /Missing permissions - accessibility:\s*(true|false), input_monitoring:\s*(true|false)/i,
    );
  if (!match) {
    return null;
  }

  return {
    accessibility: match[1] === "true",
    inputMonitoring: match[2] === "true",
  };
}

function hasScreenRecordingDeniedSignal(logText: string): boolean {
  return hasKeywordInText(logText, "screen recording permission denied");
}

function hasKeywordInText(value: string, keyword: string): boolean {
  return value.toLowerCase().includes(keyword.toLowerCase());
}

function summarizeRecorderBootstrapFailure(input: {
  baseMessage: string;
  logPath: string | null;
  logText: string;
}): string {
  const logSuffix = input.logPath ? ` Bootstrap log: ${input.logPath}` : "";

  if (
    hasKeywordInText(input.logText, "server listening on 0.0.0.0:3030") ||
    hasKeywordInText(input.logText, "server listening on")
  ) {
    return `Recorder bootstrap started Screenpipe, but /health did not become healthy before the timeout.${logSuffix}`;
  }

  if (
    hasKeywordInText(input.logText, "ffmpeg not found. installing") &&
    hasKeywordInText(input.logText, "no such file or directory")
  ) {
    return `Recorder bootstrap could not prepare ffmpeg automatically, so Screenpipe never became ready.${logSuffix}`;
  }

  if (
    hasKeywordInText(input.logText, 'downloading model "') ||
    hasKeywordInText(input.logText, "downloading whisper model") ||
    hasKeywordInText(input.logText, "downloading speaker model")
  ) {
    return `Recorder bootstrap timed out while Screenpipe was still downloading first-run models. Keep this window open a little longer and retry if needed.${logSuffix}`;
  }

  if (hasScreenRecordingDeniedSignal(input.logText)) {
    return `Recorder bootstrap is blocked because Screen Recording permission is still missing.${logSuffix}`;
  }

  const uiPermissions = parseUiPermissionStatus(input.logText);
  if (uiPermissions?.accessibility === false) {
    return `Recorder bootstrap is blocked because Accessibility permission is still missing.${logSuffix}`;
  }
  if (uiPermissions?.inputMonitoring === false) {
    return `Recorder bootstrap is blocked because Input Monitoring permission is still missing.${logSuffix}`;
  }

  return `${input.baseMessage}.${logSuffix}`.trim();
}

function areSkillsEquivalent(
  left: OpenClawSkill,
  right: OpenClawSkill,
): boolean {
  return (
    JSON.stringify(normalizeEditedSkillArtifact(left)) ===
    JSON.stringify(normalizeEditedSkillArtifact(right))
  );
}

function normalizeEditedSkillArtifact(skill: OpenClawSkill): OpenClawSkill {
  const shortDescription = normalizeOptionalEditedSkillText(
    skill.shortDescription,
  );

  return {
    ...skill,
    skillName: normalizeEditedSkillText(skill.skillName),
    ...(shortDescription === null ? {} : { shortDescription }),
    description: normalizeEditedSkillText(skill.description),
    goal: normalizeEditedSkillText(skill.goal),
    whenToUse: normalizeEditedSkillTextList(skill.whenToUse),
    whenNotToUse: normalizeEditedSkillTextList(skill.whenNotToUse),
    inputs: normalizeEditedSkillFields(skill.inputs),
    outputs: normalizeEditedSkillFields(skill.outputs),
    prerequisites: normalizeEditedSkillTextList(skill.prerequisites),
    steps: normalizeEditedSkillSteps(skill.steps),
    successCriteria: normalizeEditedSkillTextList(skill.successCriteria),
    failureModes: normalizeEditedSkillTextList(skill.failureModes),
    fallback: normalizeEditedSkillTextList(skill.fallback),
    examples: normalizeEditedSkillTextList(skill.examples),
    tags: normalizeEditedSkillTextList(skill.tags),
    assets: normalizeEditedSkillAssets(skill.assets),
    evidence: {
      ...skill.evidence,
      appsSeen: normalizeEditedSkillTextList(skill.evidence.appsSeen),
      windowsSeen: normalizeEditedSkillTextList(skill.evidence.windowsSeen),
    },
  };
}

function normalizeEditedSkillSteps(
  steps: OpenClawSkill["steps"],
): OpenClawSkill["steps"] {
  return steps.map((step, index) => ({
    ...step,
    step: index + 1,
    instruction: normalizeEditedSkillText(step.instruction),
    intent: normalizeEditedSkillText(step.intent),
    operationApp: normalizeEditedSkillText(step.operationApp),
    hints: normalizeEditedSkillTextList(step.hints),
  }));
}

function normalizeEditedSkillFields(
  fields: OpenClawSkill["inputs"] | OpenClawSkill["outputs"],
): OpenClawSkill["inputs"] {
  const deduped = new Map<
    string,
    {
      name: string;
      description: string;
      required?: boolean;
    }
  >();

  for (const field of fields) {
    const name = normalizeEditedSkillText(field.name);
    if (name.length === 0) {
      continue;
    }
    const description = normalizeEditedSkillText(field.description);
    const key = `${name.toLowerCase()}::${description.toLowerCase()}`;
    const existing = deduped.get(key);
    if (existing) {
      const nextRequired =
        existing.required === true || field.required === true;
      deduped.set(key, {
        name: existing.name,
        description: existing.description,
        ...(nextRequired ? { required: true } : {}),
      });
      continue;
    }
    deduped.set(key, {
      name,
      description,
      ...(field.required === true ? { required: true } : {}),
    });
  }

  return [...deduped.values()];
}

function normalizeEditedSkillAssets(
  assets: OpenClawSkill["assets"],
): OpenClawSkill["assets"] {
  const deduped = new Map<string, OpenClawSkill["assets"][number]>();

  for (const asset of assets) {
    const name = normalizeEditedSkillText(asset.name);
    if (name.length === 0) {
      continue;
    }

    const normalizedValue = normalizeEditedSkillAssetValue(asset.value);
    const notes = normalizeOptionalEditedSkillText(asset.notes);
    const candidate = {
      name,
      value: normalizedValue,
      ...(notes === null ? {} : { notes }),
    };
    const key = JSON.stringify(candidate);
    if (!deduped.has(key)) {
      deduped.set(key, candidate);
    }
  }

  return [...deduped.values()];
}

function normalizeEditedSkillAssetValue(
  value: OpenClawSkill["assets"][number]["value"],
): OpenClawSkill["assets"][number]["value"] {
  if (typeof value === "string") {
    return value.trim().length === 0 ? "" : value;
  }

  if (Array.isArray(value)) {
    return normalizeEditedSkillTextList(value);
  }

  const normalizedEntries = Object.entries(value).flatMap(
    ([key, fieldValue]) => {
      const normalizedKey = normalizeEditedSkillText(key);
      const normalizedValue = normalizeEditedSkillText(fieldValue);
      return normalizedKey.length === 0
        ? []
        : [[normalizedKey, normalizedValue]];
    },
  );

  return Object.fromEntries(normalizedEntries);
}

function normalizeEditedSkillTextList(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const value of values) {
    const nextValue = normalizeEditedSkillText(value);
    if (nextValue.length === 0) {
      continue;
    }
    const key = nextValue.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push(nextValue);
  }

  return normalized;
}

function normalizeEditedSkillText(value: string | null | undefined): string {
  return (value ?? "").trim();
}

function normalizeOptionalEditedSkillText(
  value: string | null | undefined,
): string | null {
  const normalized = normalizeEditedSkillText(value);
  return normalized.length > 0 ? normalized : null;
}

function resolvePlannerOptimizationSource(
  session: LabSession,
  input: PlannerOptimizationInput,
): {
  selectedWorkflowId: string | null;
} {
  if (input.sourceType === "base") {
    const artifact = findBaseSkillArtifactBySkillPath(session, input.skillPath);
    if (!artifact) {
      throw new Error(
        session.skillExtraction.artifacts.length === 0
          ? "Planner optimization requires one completed base skill extraction."
          : "Planner optimization source does not belong to this session.",
      );
    }
    return {
      selectedWorkflowId: artifact.summary.selectedWorkflowId ?? null,
    };
  }

  const matched = findGeneralizedVariantBySkillPath(session, input.skillPath);
  if (!matched) {
    throw new Error(
      "Planner optimization source does not belong to this session.",
    );
  }
  return {
    selectedWorkflowId:
      matched.generalizationArtifact.selectedWorkflowId ??
      matched.generalizationArtifact.summary.selectedWorkflowId ??
      null,
  };
}

function requireIso(value: string | null, fieldName: string): string {
  if (!value) {
    throw new Error(`Session is missing required timestamp: ${fieldName}`);
  }
  return value;
}

function toSessionError(error: unknown): LabSessionError {
  if (error instanceof Error) {
    return {
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
  return { message: String(error) };
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
