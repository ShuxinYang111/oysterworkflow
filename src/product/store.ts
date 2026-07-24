import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { LabSession, OpenClawSkill } from "../lab-api/contracts.js";
import type { RuntimeConfig } from "../runtime/config.js";
import type {
  CloudAuthenticatedUser,
  CloudDeviceManifest,
  CloudPortableMutationTokenSet,
  CloudPortableSnapshot,
  WorkerManifest,
} from "../cloud/contracts.js";
import { openProductDatabase } from "./sqlite.js";
import { retainProductStateHistory } from "./history-retention.js";
import {
  defaultProductWorkerChannelConfig,
  normalizePersistedProductWorkerChannel,
  normalizeProductWorkerChannelInput,
  productChannelBindingThreadId,
  productWorkerChannelConfigFromInput,
} from "./channels.js";
import {
  defaultHermesInstallReference,
  defaultHermesSkillName,
  defaultHermesSkillPath,
  managedHermesProfileReference,
} from "./hermes-references.js";
import {
  normalizeHermesProviderHealth,
  stripHermesProviderStatusLines,
} from "./hermes-provider-status.js";
import { SALES_LIBRARY_ENTRIES, seedProductState } from "./seed-state.js";
import {
  createHermesWorkerExecutor,
  type WorkerExecutor,
  type WorkerExecutorProgressEvent,
  type WorkerExecutorRunResult,
  type WorkerExecutorSkill,
  type WorkerExecutorSkillScope,
  type WorkerExecutorTurnHandle,
} from "./worker-executor.js";
import {
  createProductEntityId,
  installationAccountNamespace,
} from "./identity.js";
import {
  createCapabilityProviderRegistry,
  defaultCapabilityProviders,
  type CapabilityProviderRegistry,
} from "./capabilities.js";
import {
  createComposioProviderAdapter,
  productComposioUserId,
  type ComposioProviderAdapter,
} from "./composio.js";
import {
  productizeWorkerFacingText,
  START_WORKER_PREPARATION_MESSAGE,
  workerUserFacingResponsePolicyLines,
} from "./worker-presentation.js";
import {
  loadProductWorkflowMergeProposal,
  resolveProductWorkflowMergeBase,
  resolveProductWorkflowSiblingArtifactPath,
} from "./workflow-graph-view.js";
import {
  listPendingProductWorkflowMerges,
  readProductWorkflowMergeResolution,
  writeProductWorkflowMergeResolution,
} from "./workflow-merge-resolution.js";
import { persistProductWorkflowGraphEdit } from "./workflow-graph-edit.js";
import { applyWorkflowMergeProposal as applyCanonicalWorkflowMergeProposal } from "../skill/workflow-merge.js";
import { hermesConversationStatusRank } from "./agent-conversation.js";
import {
  listWorkflowGraphRevisions,
  restoreWorkflowGraphRevision,
  WORKFLOW_GRAPH_FILE_NAME,
} from "../skill/workflow-graph.js";
import type {
  ProductAccountSetupInput,
  ProductAccountSetupResponse,
  ProductApplyWorkflowMergeResponse,
  ProductApproveChannelPairingInput,
  ProductApproveChannelPairingResponse,
  ProductAssignDeviceInput,
  ProductAssignDeviceResponse,
  ProductApprovalPolicy,
  ProductArtifact,
  ProductCaptureSession,
  ProductBeginChannelSetupInput,
  ProductBindChannelInput,
  ProductChannelBinding,
  ProductChannelBindingResponse,
  ProductChannelConnection,
  ProductChannelPeer,
  ProductChannelPeersResponse,
  ProductChannelSetup,
  ProductChannelSetupResponse,
  ProductCapabilityProvider,
  ProductCapabilityProviderCheckResponse,
  ProductCapabilityProviderId,
  ProductCloudDelete,
  ProductCloudUpsert,
  ProductComposioAuthorizeResponse,
  ProductComposioConnection,
  ProductComposioOverviewResponse,
  ProductComposioToolkitFilter,
  ProductCommand,
  ProductCommandResponse,
  ProductCreateWorkflowInput,
  ProductCreateWorkflowResponse,
  ProductCreateWorkerInput,
  ProductCreateWorkerResponse,
  ProductDeleteWorkerResponse,
  ProductWorkerChannelConfigureResponse,
  ProductWorkerChannelConfig,
  ProductWorkerChannelInput,
  ProductWorkerChannelTestResponse,
  ProductDeleteWorkflowInput,
  ProductDeleteInstalledWorkflowResponse,
  ProductDeleteWorkflowResponse,
  ProductDisconnectChannelInput,
  ProductDisconnectChannelResponse,
  ProductDevice,
  ProductHermesStatus,
  ProductInstallWorkflowInput,
  ProductInstallWorkflowResponse,
  ProductInstalledWorkflow,
  ProductInstalledWorkflowStatus,
  ProductPendingWorkflowMerge,
  ProductPermissionSnapshot,
  ProductRun,
  ProductRunEvent,
  ProductRunWorkflowResponse,
  ProductStartWorkerResponse,
  ProductState,
  ProductTone,
  ProductWorker,
  ProductWorkerConfigInput,
  ProductWorkerConfigResponse,
  ProductWorkflow,
  ProductWorkflowGraphEditInput,
  ProductWorkflowGraphEditResponse,
  ProductWorkflowVersionsResponse,
  ProductRestoreWorkflowVersionResponse,
  ProductWorkflowTombstone,
} from "./contracts.js";

export interface ProductStore {
  getState: () => Promise<ProductState>;
  getInstallationId: () => string;
  shutdown: () => Promise<void>;
  syncLabSessions: (sessions: LabSession[]) => Promise<ProductState>;
  recordPermissionSnapshot: (
    snapshot: ProductPermissionSnapshot,
  ) => Promise<ProductState>;
  refreshHermes: () => Promise<ProductState>;
  refreshCapabilityProviders: () => Promise<ProductState>;
  prepareCapabilityProvider: (
    providerId: ProductCapabilityProviderId,
  ) => Promise<ProductCapabilityProviderCheckResponse>;
  checkCapabilityProvider: (
    providerId: ProductCapabilityProviderId,
  ) => Promise<ProductCapabilityProviderCheckResponse>;
  getComposioOverview: (input?: {
    cursor?: string;
    search?: string;
    filter?: ProductComposioToolkitFilter;
    limit?: number;
  }) => Promise<ProductComposioOverviewResponse>;
  authorizeComposioToolkit: (input: {
    toolkitSlug: string;
    alias?: string | null;
    callbackUrl?: string;
  }) => Promise<ProductComposioAuthorizeResponse>;
  getComposioConnection: (
    connectionId: string,
  ) => Promise<ProductComposioConnection>;
  disconnectComposioConnection: (connectionId: string) => Promise<void>;
  setupAccount: (
    input: ProductAccountSetupInput,
  ) => Promise<ProductAccountSetupResponse>;
  createWorker: (
    input: ProductCreateWorkerInput,
  ) => Promise<ProductCreateWorkerResponse>;
  deleteWorker: (workerId: string) => Promise<ProductDeleteWorkerResponse>;
  createWorkflow: (
    input: ProductCreateWorkflowInput,
  ) => Promise<ProductCreateWorkflowResponse>;
  applyWorkflowMergeProposal: (
    sourceWorkflowId: string,
    targetWorkflowId?: string,
  ) => Promise<ProductApplyWorkflowMergeResponse>;
  keepWorkflowAsNew: (sourceWorkflowId: string) => Promise<ProductState>;
  listPendingWorkflowMerges: () => Promise<ProductPendingWorkflowMerge[]>;
  listWorkflowVersions: (
    workflowId: string,
  ) => Promise<ProductWorkflowVersionsResponse>;
  restoreWorkflowVersion: (
    workflowId: string,
    revisionId: string,
  ) => Promise<ProductRestoreWorkflowVersionResponse>;
  editWorkflowGraph: (
    workflowId: string,
    input: ProductWorkflowGraphEditInput,
  ) => Promise<ProductWorkflowGraphEditResponse>;
  assignDevice: (
    input: ProductAssignDeviceInput,
  ) => Promise<ProductAssignDeviceResponse>;
  updateWorkerConfig: (
    workerId: string,
    input: ProductWorkerConfigInput,
  ) => Promise<ProductWorkerConfigResponse>;
  configureWorkerChannel: (
    workerId: string,
    input: ProductWorkerChannelInput,
  ) => Promise<ProductWorkerChannelConfigureResponse>;
  disconnectWorkerChannel: (
    workerId: string,
    input: ProductDisconnectChannelInput,
  ) => Promise<ProductDisconnectChannelResponse>;
  testWorkerChannel: (
    workerId: string,
  ) => Promise<ProductWorkerChannelTestResponse>;
  beginWorkerChannelSetup: (
    workerId: string,
    input: ProductBeginChannelSetupInput,
  ) => Promise<ProductChannelSetupResponse>;
  readWorkerChannelSetup: (
    workerId: string,
    setupId: string,
  ) => Promise<ProductChannelSetupResponse>;
  cancelWorkerChannelSetup: (
    workerId: string,
    setupId: string,
  ) => Promise<ProductChannelSetupResponse>;
  bindWorkerChannel: (
    workerId: string,
    input: ProductBindChannelInput,
  ) => Promise<ProductChannelBindingResponse>;
  approveWorkerChannelPairing: (
    workerId: string,
    input: ProductApproveChannelPairingInput,
  ) => Promise<ProductApproveChannelPairingResponse>;
  listWorkerChannelPeers: (
    workerId: string,
    connectionId: string,
  ) => Promise<ProductChannelPeersResponse>;
  installWorkflow: (
    input: ProductInstallWorkflowInput,
  ) => Promise<ProductInstallWorkflowResponse>;
  deleteWorkflow: (
    input: ProductDeleteWorkflowInput,
  ) => Promise<ProductDeleteWorkflowResponse>;
  deleteInstalledWorkflow: (
    installedWorkflowId: string,
  ) => Promise<ProductDeleteInstalledWorkflowResponse>;
  toggleInstalledWorkflow: (
    installedWorkflowId: string,
    status: ProductInstalledWorkflowStatus,
  ) => Promise<ProductState>;
  startWorker: (workerId: string) => Promise<ProductStartWorkerResponse>;
  runInstalledWorkflow: (
    installedWorkflowId: string,
  ) => Promise<ProductRunWorkflowResponse>;
  stopWorker: (workerId: string) => Promise<ProductState>;
  sendCommand: (
    workerId: string,
    command: string,
  ) => Promise<ProductCommandResponse>;
  exportCloudSnapshot: () => Promise<CloudPortableSnapshot>;
  applyCloudSnapshot: (input: {
    snapshot: CloudPortableSnapshot;
    user: CloudAuthenticatedUser;
    localDeviceId: string;
    replacePortableState: boolean;
    syncRevision: number;
    expectedCloudUserId?: string | null;
    isCurrentCloudSyncAttempt?: () => boolean;
    acknowledgedCloudMutationTokens?: CloudPortableSnapshot["mutationTokens"];
  }) => Promise<ProductState>;
}

interface ProductStoreInput {
  runtimeConfig: RuntimeConfig;
  workerExecutor?: WorkerExecutor;
  capabilityRegistry?: CapabilityProviderRegistry;
  composioAdapter?: ComposioProviderAdapter;
}

interface BufferedWorkerSignal {
  executionObserved: boolean;
  completionNotice: string | null;
  providerHealth: NonNullable<
    WorkerExecutorProgressEvent["providerHealth"]
  > | null;
  draining: boolean;
  discarded: boolean;
}

interface WorkerSignalCallbacks {
  onOutput: (chunk: { stream: "stdout" | "stderr"; text: string }) => void;
  onProgress: (event: WorkerExecutorProgressEvent) => void;
  close: () => void;
}

interface OwnedChannelSetupProcess {
  setupId: string;
  connectionId: string;
  workerAgentReference: string;
  processId: number | null;
}

const HERMES_WORKER_COMMAND_MAX_TURNS = 100;
const GENERAL_WORKER_SESSION_ID = "system-general-worker-session";
const GENERAL_WORKER_SESSION_TITLE = "General AI worker session";
const CHANNEL_SETUP_STARTUP_TIMEOUT_MS = 30_000;
const PURE_DEMO_SEED_MIGRATION_ID = "pure-demo-seed-to-empty-v1";
const PRODUCT_STORE_OPERATION_DRAIN_TIMEOUT_MS = 1_250;
const PRODUCT_STORE_STATE_SNAPSHOT_TIMEOUT_MS = 250;
const PRODUCT_STORE_PROCESS_CLEANUP_TIMEOUT_MS = 1_500;
const PRODUCT_STORE_CHANNEL_SETUP_CANCEL_TIMEOUT_MS = 1_500;
const PRODUCT_STORE_SHUTDOWN_ERROR_MESSAGE =
  "Product store is shutting down and cannot start another operation. / 产品存储正在关闭，无法启动新操作。";

/**
 * EN: Creates the local product store used by Runtime product APIs.
 * 中文: 创建 Runtime 产品 API 使用的本地产品状态存储。
 * @param input runtime config that determines where product state is written.
 * @returns product store instance.
 */
export function createProductStore(input: ProductStoreInput): ProductStore {
  const databasePath = resolve(
    dirname(input.runtimeConfig.runsRoot),
    "product-state.sqlite",
  );
  const legacyStatePath = resolve(
    dirname(input.runtimeConfig.runsRoot),
    "product-state.json",
  );
  const database = openProductDatabase(databasePath);
  const workflowInstallLogPath = resolve(
    dirname(input.runtimeConfig.runsRoot),
    "logs",
    "workflow-install.jsonl",
  );
  const composioAdapter =
    input.composioAdapter ??
    createComposioProviderAdapter({ runtimeConfig: input.runtimeConfig });
  const workerExecutor =
    input.workerExecutor ??
    createHermesWorkerExecutor(input.runtimeConfig, { composioAdapter });
  const capabilityRegistry =
    input.capabilityRegistry ??
    createCapabilityProviderRegistry(input.runtimeConfig, {
      composioAdapter,
      canRestartChrome: async () => {
        const state = await loadState();
        return !state.runs.some(
          (run) => run.status === "queued" || run.status === "running",
        );
      },
    });
  let statePromise: Promise<ProductState> | null = null;
  let updateQueue: Promise<void> = Promise.resolve();
  const activeHermesRuns = new Map<string, Set<WorkerExecutorTurnHandle>>();
  const manuallyStoppingHermesRuns = new Set<string>();
  const runCompletionNotices = new Map<string, string>();
  const capabilityOperationGeneration = new Map<
    ProductCapabilityProviderId,
    number
  >();
  const capabilityCheckPromises = new Map<
    ProductCapabilityProviderId,
    Promise<ProductCapabilityProviderCheckResponse>
  >();
  const activeExternalOperations = new Set<Promise<void>>();
  const observedWorkerAgentReferences = new Set<string>();
  const bufferedWorkerSignals = new Map<string, BufferedWorkerSignal>();
  const workerExecutionObservedRuns = new Set<string>();
  const activeWorkerSignalDrains = new Set<Promise<void>>();
  const workerSignalCleanupByHandle = new WeakMap<
    WorkerExecutorTurnHandle,
    () => void
  >();
  const ownedChannelSetupProcesses = new Map<
    string,
    OwnedChannelSetupProcess
  >();
  const channelSetupOperationQueues = new Map<string, Promise<void>>();
  let shutdownRequested = false;
  let shutdownPromise: Promise<void> | null = null;

  function storeShutdownError(operation: string): Error {
    return new Error(`${PRODUCT_STORE_SHUTDOWN_ERROR_MESSAGE} (${operation})`);
  }

  function assertStoreAcceptingOperations(operation: string): void {
    if (shutdownRequested) {
      throw storeShutdownError(operation);
    }
  }

  function registerExternalOperation(operation: string): () => void {
    assertStoreAcceptingOperations(operation);
    let resolveCompletion!: () => void;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    activeExternalOperations.add(completion);
    let finished = false;
    return () => {
      if (finished) {
        return;
      }
      finished = true;
      activeExternalOperations.delete(completion);
      resolveCompletion();
    };
  }

  async function withExternalOperation<T>(
    operation: string,
    callback: () => Promise<T>,
  ): Promise<T> {
    const finish = registerExternalOperation(operation);
    try {
      return await callback();
    } finally {
      finish();
    }
  }

  async function withChannelSetupOperation<T>(
    connectionId: string,
    callback: () => Promise<T>,
  ): Promise<T> {
    const previous =
      channelSetupOperationQueues.get(connectionId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    channelSetupOperationQueues.set(connectionId, tail);
    await previous.catch(() => undefined);
    try {
      return await callback();
    } finally {
      release();
      if (channelSetupOperationQueues.get(connectionId) === tail) {
        channelSetupOperationQueues.delete(connectionId);
      }
    }
  }

  async function cancelOwnedChannelSetup(
    setup: OwnedChannelSetupProcess,
  ): Promise<void> {
    const cancellation = Promise.resolve().then(() =>
      workerExecutor.cancelChannelSetup?.({
        processId: setup.processId,
        setupId: setup.setupId,
        workerAgentReference: setup.workerAgentReference,
      }),
    );
    await settleWithin(
      cancellation.catch(() => false),
      PRODUCT_STORE_CHANNEL_SETUP_CANCEL_TIMEOUT_MS,
    );
    ownedChannelSetupProcesses.delete(setup.setupId);
  }

  async function cancelChannelSetupRecord(
    setup: ProductChannelSetup,
    workerAgentReference: string,
  ): Promise<void> {
    await cancelOwnedChannelSetup(
      ownedChannelSetupProcesses.get(setup.id) ?? {
        setupId: setup.id,
        connectionId: setup.connectionId,
        workerAgentReference,
        processId: setup.processId,
      },
    );
  }

  async function cancelOpenChannelSetups(
    state: ProductState | null,
  ): Promise<void> {
    const cancellations = new Map<string, OwnedChannelSetupProcess>();
    for (const setup of ownedChannelSetupProcesses.values()) {
      cancellations.set(setup.setupId, setup);
    }
    for (const setup of state?.channelSetups ?? []) {
      if (isTerminalChannelSetupStatus(setup.status)) {
        continue;
      }
      const worker = state?.workers.find((item) => item.id === setup.workerId);
      if (!worker) {
        continue;
      }
      cancellations.set(
        setup.id,
        cancellations.get(setup.id) ?? {
          setupId: setup.id,
          connectionId: setup.connectionId,
          workerAgentReference: worker.config.hermesAgentReference,
          processId: setup.processId,
        },
      );
    }
    await Promise.allSettled(
      [...cancellations.values()].map((setup) =>
        cancelOwnedChannelSetup(setup),
      ),
    );
  }

  function isTerminalChannelSetupStatus(
    status: ProductChannelSetup["status"],
  ): boolean {
    return (
      status === "connected" || status === "failed" || status === "cancelled"
    );
  }

  function observeWorkerAgentReference(workerAgentReference: string): void {
    if (workerAgentReference.trim()) {
      observedWorkerAgentReferences.add(workerAgentReference);
    }
  }

  function beginCapabilityOperation(
    providerId: ProductCapabilityProviderId,
  ): number {
    const generation = (capabilityOperationGeneration.get(providerId) ?? 0) + 1;
    capabilityOperationGeneration.set(providerId, generation);
    return generation;
  }

  function isCurrentCapabilityOperation(
    providerId: ProductCapabilityProviderId,
    generation: number,
  ): boolean {
    return capabilityOperationGeneration.get(providerId) === generation;
  }

  /**
   * EN: Persists package handoff diagnostics without blocking deploy or run paths.
   * 中文: 持久化生成包交付诊断，同时避免日志故障阻塞部署或执行。
   * @param event stable diagnostic event name.
   * @param details paths and package metadata needed to trace the handoff.
   * @returns when the best-effort append finishes.
   */
  async function logWorkflowInstallDiagnostic(
    event: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    try {
      await mkdir(dirname(workflowInstallLogPath), { recursive: true });
      await appendFile(
        workflowInstallLogPath,
        `${JSON.stringify({
          timestamp: new Date().toISOString(),
          event,
          ...details,
        })}\n`,
        "utf8",
      );
    } catch {
      // EN: Diagnostics must not replace the original deploy/run result.
      // 中文: 诊断日志失败不能覆盖原始部署或执行结果。
    }
  }

  /**
   * EN: Describes whether a proposed canonical source package is readable.
   * 中文: 描述候选 canonical source package 是否可读取。
   * @param sourceSkillPath generated skill JSON path supplied to the installer.
   * @returns redaction-safe path and file metadata for diagnostics.
   */
  async function inspectWorkflowSourcePath(
    sourceSkillPath: string | null | undefined,
  ): Promise<Record<string, unknown>> {
    if (!sourceSkillPath) {
      return { provided: false, readable: false };
    }
    try {
      const sourceStat = await stat(sourceSkillPath);
      const workflowGraphPath = resolve(
        dirname(sourceSkillPath),
        "workflow.json",
      );
      let workflowGraphReadable = false;
      try {
        workflowGraphReadable = (await stat(workflowGraphPath)).isFile();
      } catch {
        workflowGraphReadable = false;
      }
      return {
        provided: true,
        readable: sourceStat.isFile(),
        path: sourceSkillPath,
        sizeBytes: sourceStat.size,
        workflowGraphPath,
        workflowGraphReadable,
      };
    } catch (error) {
      return {
        provided: true,
        readable: false,
        path: sourceSkillPath,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async function loadState(): Promise<ProductState> {
    if (!statePromise) {
      const finishInitialization = registerExternalOperation(
        "initialize product state",
      );
      const initialization = (async () => {
        const shouldMigratePureDemoSeed =
          input.runtimeConfig.productSeedMode === "empty" &&
          !database.hasDataMigration(PURE_DEMO_SEED_MIGRATION_ID);
        const existing = database.readState();
        if (existing) {
          const migrationResult = shouldMigratePureDemoSeed
            ? migratePureDemoSeedToEmpty(normalizeState(existing))
            : existing;
          const normalized = await materializeWorkerSkills(
            repairStaleRuntimeState(
              repairInstalledWorkflowLibraryState(
                normalizeState(migrationResult),
              ),
            ),
            { workerExecutor },
          );
          assertStoreAcceptingOperations("initialize product state");
          database.writeState(normalized);
          if (shouldMigratePureDemoSeed) {
            database.markDataMigration(PURE_DEMO_SEED_MIGRATION_ID);
          }
          return normalized;
        }
        const migrated = (await readLegacyState(legacyStatePath)) ?? null;
        const initialState =
          migrated ?? seedProductState(input.runtimeConfig.productSeedMode);
        const migrationResult = shouldMigratePureDemoSeed
          ? migratePureDemoSeedToEmpty(normalizeState(initialState))
          : initialState;
        const seeded = await materializeWorkerSkills(
          repairStaleRuntimeState(
            repairInstalledWorkflowLibraryState(
              normalizeState(migrationResult),
            ),
          ),
          { force: true, workerExecutor },
        );
        assertStoreAcceptingOperations("initialize product state");
        database.writeState(seeded);
        if (shouldMigratePureDemoSeed) {
          database.markDataMigration(PURE_DEMO_SEED_MIGRATION_ID);
        }
        return seeded;
      })();
      const trackedInitialization = initialization
        .catch((error: unknown) => {
          if (statePromise === trackedInitialization) {
            statePromise = null;
          }
          throw error;
        })
        .finally(finishInitialization);
      statePromise = trackedInitialization;
    }
    return statePromise;
  }

  async function updateState(
    mutator: (state: ProductState) => ProductState | Promise<ProductState>,
    options: { trackCloudChanges?: boolean } = {},
  ): Promise<ProductState> {
    assertStoreAcceptingOperations("update product state");
    const runUpdate = async () => {
      assertStoreAcceptingOperations("update product state");
      const current = await loadState();
      const mutated = normalizeState(await mutator(structuredClone(current)));
      assertStoreAcceptingOperations("update product state");
      const next =
        options.trackCloudChanges === false || !current.account.cloudUserId
          ? mutated
          : queuePortableCloudUpserts(current, mutated);
      database.writeState(next);
      statePromise = Promise.resolve(next);
      for (const run of next.runs) {
        if (!isOpenRunStatus(run.status)) {
          clearWorkerSignalState(run.id);
        }
      }
      return next;
    };
    const result = updateQueue.then(runUpdate, runUpdate);
    updateQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function drainLatestUpdateQueue(): Promise<void> {
    while (true) {
      const queueSnapshot = updateQueue;
      await queueSnapshot;
      if (queueSnapshot === updateQueue) {
        return;
      }
    }
  }

  async function applyHermesStartResult(
    runId: string,
    hermesResult: WorkerExecutorRunResult,
    okFallbackStatus: ProductRun["status"] = "running",
    okFallbackEventStatus = "AI worker started",
    okHeartbeat?: string,
  ): Promise<ProductState> {
    return updateState((draft) => {
      if (manuallyStoppingHermesRuns.has(runId)) {
        return draft;
      }
      const activeRun = draft.runs.find((item) => item.id === runId);
      if (!activeRun || activeRun.status !== "running") {
        return draft;
      }
      const now = new Date().toISOString();
      const providerHealth = hermesResult.providerHealth
        ? normalizeHermesProviderHealth(hermesResult.providerHealth)
        : null;
      const status = runStatusFromHermesResult(
        hermesResult,
        hermesResult.ok ? okFallbackStatus : "failed",
      );
      const eventStatus = hermesResult.ok
        ? runEventStatusFromRunStatus(status, okFallbackEventStatus)
        : "AI worker failed";
      const event = productEvent({
        runId: activeRun.id,
        workerId: activeRun.workerId,
        source: hermesResult.ok ? "hermes" : "system",
        status: eventStatus,
        body: hermesResult.ok
          ? hermesResultBodyForEvent(
              hermesResult,
              runCompletionNotices.get(activeRun.id),
              shouldPreferSessionStatusMessage(status, eventStatus),
            )
          : productizeWorkerFacingText(
              `AI worker could not start this run: ${
                hermesResult.errorMessage ?? "unknown error"
              }`,
            ),
      });
      draft.runs = draft.runs.map((item) =>
        item.id === activeRun.id
          ? {
              ...item,
              status,
              hermesSessionId:
                hermesResult.sessionId ?? activeRun.hermesSessionId,
              endedAt: isOpenRunStatus(status) ? null : now,
              errorMessage: hermesResult.errorMessage,
            }
          : item,
      );
      draft.runEvents = mergeProductRunEvent(draft.runEvents, event);
      draft.workers = draft.workers.map((worker) =>
        worker.id === activeRun.workerId
          ? {
              ...worker,
              status: hermesResult.ok
                ? workerStatusFromRunStatus(status, runKind(activeRun))
                : "Setup needed",
              tone: hermesResult.ok
                ? workerToneFromRunStatus(status, runKind(activeRun))
                : "danger",
              heartbeat: hermesResult.ok
                ? (okHeartbeat ??
                  workerHeartbeatFromRunStatus(status, runKind(activeRun)))
                : "AI worker failed",
              activities: hermesResult.ok
                ? [
                    okHeartbeat ??
                      runActivityFromRunStatus(
                        status,
                        activeRun.workflowTitle,
                        runKind(activeRun),
                      ),
                    "AI worker returned first response",
                    "Run events are live",
                  ]
                : [
                    "AI worker failed",
                    "Run stopped before workflow completion",
                    "Check AI worker setup before retry",
                  ],
            }
          : worker,
      );
      draft.hermes = {
        ...draft.hermes,
        available: hermesResult.ok,
        configSource: workerExecutor.kind,
        runtimeHome:
          workerExecutor.skillScope.runtimeHome ?? draft.hermes.runtimeHome,
        lastCheckedAt: now,
        lastProbeSessionId: hermesResult.sessionId,
        providerHealth: providerHealth ?? draft.hermes.providerHealth,
        lastError:
          providerHealth?.status === "degraded"
            ? (providerHealth.message ?? hermesResult.errorMessage)
            : hermesResult.errorMessage,
      };
      if (!isOpenRunStatus(status) || !hermesResult.ok) {
        runCompletionNotices.delete(activeRun.id);
      }
      return draft;
    });
  }

  async function applyHermesCommandResult(
    runId: string,
    hermesResult: WorkerExecutorRunResult,
  ): Promise<ProductState> {
    return updateState((draft) => {
      if (manuallyStoppingHermesRuns.has(runId)) {
        return draft;
      }
      const latestRun = draft.runs.find((item) => item.id === runId);
      if (!latestRun || latestRun.status !== "running") {
        return draft;
      }
      const now = new Date().toISOString();
      const providerHealth = hermesResult.providerHealth
        ? normalizeHermesProviderHealth(hermesResult.providerHealth)
        : null;
      const reportedStatus = runStatusFromHermesResult(
        hermesResult,
        hermesResult.ok ? "paused" : "failed",
      );
      const status = runStatusAfterWorkerCommand(
        reportedStatus,
        runKind(latestRun),
      );
      const eventStatus = hermesResult.ok
        ? runEventStatusFromRunStatus(reportedStatus, "AI worker response")
        : "AI worker failed";
      const event = productEvent({
        runId: latestRun.id,
        workerId: latestRun.workerId,
        source: hermesResult.ok ? "hermes" : "system",
        status: eventStatus,
        body: hermesResult.ok
          ? hermesResultBodyForEvent(
              hermesResult,
              runCompletionNotices.get(latestRun.id),
              shouldPreferSessionStatusMessage(reportedStatus, eventStatus),
            )
          : productizeWorkerFacingText(
              `AI worker could not process the command: ${
                hermesResult.errorMessage ?? "unknown error"
              }`,
            ),
      });
      draft.runs = draft.runs.map((item) =>
        item.id === latestRun.id
          ? {
              ...item,
              status,
              hermesSessionId:
                hermesResult.sessionId ?? latestRun.hermesSessionId,
              endedAt: isOpenRunStatus(status) ? null : now,
              errorMessage: hermesResult.errorMessage,
            }
          : item,
      );
      draft.runEvents = mergeProductRunEvent(draft.runEvents, event);
      draft.workers = draft.workers.map((item) =>
        item.id === latestRun.workerId
          ? {
              ...item,
              status: hermesResult.ok
                ? workerStatusFromRunStatus(status, runKind(latestRun))
                : "Setup needed",
              tone: hermesResult.ok
                ? workerToneFromRunStatus(status, runKind(latestRun))
                : "danger",
              heartbeat: hermesResult.ok
                ? workerHeartbeatFromRunStatus(status, runKind(latestRun))
                : "AI worker failed",
              activities: hermesResult.ok
                ? [
                    runActivityFromRunStatus(
                      status,
                      latestRun.workflowTitle,
                      runKind(latestRun),
                    ),
                    "AI worker response logged",
                    "Ready for next command",
                  ]
                : [
                    "AI worker command failed",
                    "Run stopped before next action",
                    "Check AI worker setup before retry",
                  ],
            }
          : item,
      );
      if (providerHealth) {
        draft.hermes = {
          ...draft.hermes,
          providerHealth,
          lastError:
            providerHealth.status === "degraded"
              ? (providerHealth.message ?? draft.hermes.lastError)
              : draft.hermes.lastError,
        };
      }
      if (!isOpenRunStatus(reportedStatus) || !hermesResult.ok) {
        runCompletionNotices.delete(latestRun.id);
      }
      return draft;
    });
  }

  function enqueueWorkerOutputEvent(
    runId: string,
    stream: "stdout" | "stderr",
    text: string,
  ): void {
    if (shutdownRequested || stream === "stderr") {
      return;
    }
    const body = stripHermesProtocolLines(text).trim();
    if (!body || workerExecutionObservedRuns.has(runId)) {
      return;
    }
    workerExecutionObservedRuns.add(runId);
    enqueueBufferedWorkerSignal(runId, { executionObserved: true });
  }

  /**
   * EN: Creates a turn-scoped signal gate so callbacks from a settled handle cannot recreate run state.
   * 中文: 创建单次 turn 作用域的信号闸门，避免已结算 handle 的迟到回调重新创建 run 状态。
   * @param runId run that owns the executor turn.
   * @returns guarded callbacks and an idempotent close function.
   */
  function createWorkerSignalCallbacks(runId: string): WorkerSignalCallbacks {
    let active = true;
    return {
      onOutput: (chunk) => {
        if (active) {
          enqueueWorkerOutputEvent(runId, chunk.stream, chunk.text);
        }
      },
      onProgress: (event) => {
        if (active) {
          enqueueWorkerProgressEvent(runId, event);
        }
      },
      close: () => {
        active = false;
      },
    };
  }

  /**
   * EN: Discards bounded callback state once a run has no live handle or reaches a terminal state.
   * 中文: 当 run 不再有活跃 handle 或进入终态时，丢弃其有界回调状态。
   * @param runId run whose callback state should be released.
   * @returns nothing.
   */
  function clearWorkerSignalState(runId: string): void {
    workerExecutionObservedRuns.delete(runId);
    const buffered = bufferedWorkerSignals.get(runId);
    if (!buffered) {
      return;
    }
    buffered.discarded = true;
    buffered.executionObserved = false;
    buffered.completionNotice = null;
    buffered.providerHealth = null;
    bufferedWorkerSignals.delete(runId);
  }

  /**
   * EN: Releases all callback state during store shutdown and invalidates active drain buffers.
   * 中文: Store 关闭时释放全部回调状态，并使活跃 drain 缓冲失效。
   * @returns nothing.
   */
  function clearAllWorkerSignalState(): void {
    const runIds = new Set([
      ...workerExecutionObservedRuns,
      ...bufferedWorkerSignals.keys(),
    ]);
    for (const runId of runIds) {
      clearWorkerSignalState(runId);
    }
    workerExecutionObservedRuns.clear();
  }

  function enqueueWorkerProgressEvent(
    runId: string,
    event: WorkerExecutorProgressEvent,
  ): void {
    if (shutdownRequested) {
      return;
    }
    const executionObserved = !workerExecutionObservedRuns.has(runId);
    if (executionObserved) {
      workerExecutionObservedRuns.add(runId);
    }
    enqueueBufferedWorkerSignal(runId, {
      executionObserved,
      completionNotice:
        event.status === "AI worker run limit reached"
          ? event.body.trim()
          : undefined,
      providerHealth: event.providerHealth,
    });
  }

  function enqueueBufferedWorkerSignal(
    runId: string,
    signal: {
      executionObserved?: boolean;
      completionNotice?: string;
      providerHealth?: WorkerExecutorProgressEvent["providerHealth"];
    },
  ): void {
    if (shutdownRequested) {
      return;
    }
    const buffered = bufferedWorkerSignals.get(runId) ?? {
      executionObserved: false,
      completionNotice: null,
      providerHealth: null,
      draining: false,
      discarded: false,
    };
    buffered.executionObserved ||= signal.executionObserved === true;
    if (signal.completionNotice !== undefined) {
      buffered.completionNotice = signal.completionNotice;
    }
    if (signal.providerHealth) {
      buffered.providerHealth = signal.providerHealth;
    }
    bufferedWorkerSignals.set(runId, buffered);
    if (buffered.draining) {
      return;
    }
    startWorkerSignalDrain(runId, buffered);
  }

  function startWorkerSignalDrain(
    runId: string,
    buffered: BufferedWorkerSignal,
  ): void {
    buffered.draining = true;
    const tracked = (async () => {
      while (!shutdownRequested && !buffered.discarded) {
        const executionObserved = buffered.executionObserved;
        const completionNotice = buffered.completionNotice;
        const providerHealth = buffered.providerHealth;
        buffered.executionObserved = false;
        buffered.completionNotice = null;
        buffered.providerHealth = null;
        if (!executionObserved && !completionNotice && !providerHealth) {
          return;
        }
        await updateState((draft) => {
          const activeRun = draft.runs.find((item) => item.id === runId);
          if (!activeRun || activeRun.status !== "running") {
            return draft;
          }
          if (completionNotice) {
            runCompletionNotices.set(activeRun.id, completionNotice);
          }
          if (providerHealth) {
            draft.hermes = {
              ...draft.hermes,
              providerHealth: normalizeHermesProviderHealth(providerHealth),
              lastError:
                providerHealth.status === "degraded"
                  ? (providerHealth.message ?? draft.hermes.lastError)
                  : draft.hermes.lastError,
            };
          }
          return executionObserved
            ? recordWorkerExecutionStarted(draft, activeRun)
            : draft;
        });
      }
    })()
      .catch(() => undefined)
      .finally(() => {
        activeWorkerSignalDrains.delete(tracked);
        buffered.draining = false;
        if (
          shutdownRequested ||
          buffered.discarded ||
          bufferedWorkerSignals.get(runId) !== buffered
        ) {
          return;
        }
        if (
          buffered.executionObserved ||
          buffered.completionNotice ||
          buffered.providerHealth
        ) {
          startWorkerSignalDrain(runId, buffered);
          return;
        }
        if (bufferedWorkerSignals.get(runId) === buffered) {
          bufferedWorkerSignals.delete(runId);
        }
      });
    activeWorkerSignalDrains.add(tracked);
  }

  /**
   * EN: Persists the first real executor activity for a run and marks the worker as working.
   * 中文: 持久化一次 run 的首个真实执行信号，并把 Worker 标记为正在工作。
   * @param draft mutable product state owned by the serialized update queue.
   * @param activeRun running workflow that emitted output or structured progress.
   * @returns the updated product state.
   */
  function recordWorkerExecutionStarted(
    draft: ProductState,
    activeRun: ProductRun,
  ): ProductState {
    const hasExecutionStartedEvent = draft.runEvents.some(
      (event) =>
        event.runId === activeRun.id &&
        event.source === "executor" &&
        event.status === "AI worker working",
    );
    if (!hasExecutionStartedEvent) {
      draft.runEvents = [
        productEvent({
          runId: activeRun.id,
          workerId: activeRun.workerId,
          source: "executor",
          status: "AI worker working",
          body: `AI worker started executing ${activeRun.workflowTitle}.`,
        }),
        ...draft.runEvents,
      ];
    }
    draft.workers = draft.workers.map((worker) =>
      worker.id === activeRun.workerId
        ? {
            ...worker,
            status: "Working",
            tone: "working",
            heartbeat: "AI worker working",
          }
        : worker,
    );
    return draft;
  }

  function trackActiveHermesHandle(
    runId: string,
    handle: WorkerExecutorTurnHandle,
    releaseWorkerSignals?: () => void,
  ): void {
    const handles = activeHermesRuns.get(runId) ?? new Set();
    handles.add(handle);
    activeHermesRuns.set(runId, handles);
    if (releaseWorkerSignals) {
      workerSignalCleanupByHandle.set(handle, releaseWorkerSignals);
    }
  }

  function releaseWorkerSignalsForHandle(
    handle: WorkerExecutorTurnHandle,
  ): void {
    const releaseWorkerSignals = workerSignalCleanupByHandle.get(handle);
    workerSignalCleanupByHandle.delete(handle);
    releaseWorkerSignals?.();
  }

  function untrackActiveHermesHandle(
    runId: string,
    handle: WorkerExecutorTurnHandle,
  ): void {
    const handles = activeHermesRuns.get(runId);
    releaseWorkerSignalsForHandle(handle);
    if (!handles) {
      clearWorkerSignalState(runId);
      return;
    }
    handles.delete(handle);
    if (handles.size === 0) {
      activeHermesRuns.delete(runId);
      clearWorkerSignalState(runId);
    }
  }

  function stopActiveHermesHandles(runId: string): boolean {
    const handles = activeHermesRuns.get(runId);
    if (!handles || handles.size === 0) {
      clearWorkerSignalState(runId);
      return false;
    }
    activeHermesRuns.delete(runId);
    let stoppedAny = false;
    for (const handle of handles) {
      releaseWorkerSignalsForHandle(handle);
      try {
        stoppedAny = handle.stop() || stoppedAny;
      } catch {
        // EN: One broken handle must not prevent the remaining run cleanup.
        // 中文: 单个 handle 清理失败不能阻塞其它运行实例的清理。
      }
    }
    clearWorkerSignalState(runId);
    return stoppedAny;
  }

  function stopUntrackedHermesHandle(
    handle: WorkerExecutorTurnHandle,
    releaseWorkerSignals?: () => void,
  ): boolean {
    releaseWorkerSignals?.();
    void handle.ready.catch(() => undefined);
    void handle.completion.catch(() => undefined);
    try {
      return handle.stop();
    } catch {
      return false;
    }
  }

  async function stopWorkerExecutorProcesses(
    workerAgentReference: string,
  ): Promise<boolean> {
    try {
      return (
        (await workerExecutor.stopWorkerProcesses?.({
          workerAgentReference,
        })) ?? false
      );
    } catch {
      return false;
    }
  }

  async function stopWorkerReferenceWithinShutdown(
    workerAgentReference: string,
  ): Promise<void> {
    observeWorkerAgentReference(workerAgentReference);
    await settleWithin(
      stopWorkerExecutorProcesses(workerAgentReference),
      PRODUCT_STORE_PROCESS_CLEANUP_TIMEOUT_MS,
    );
  }

  async function assertStoreOpenAfterWorkerReference(
    workerAgentReference: string,
    operation: string,
  ): Promise<void> {
    observeWorkerAgentReference(workerAgentReference);
    if (!shutdownRequested) {
      return;
    }
    await stopWorkerReferenceWithinShutdown(workerAgentReference);
    throw storeShutdownError(operation);
  }

  async function rejectLateHermesHandle(
    runId: string,
    handle: WorkerExecutorTurnHandle,
    workerAgentReference: string,
    operation: string,
    releaseWorkerSignals: () => void,
  ): Promise<never> {
    stopUntrackedHermesHandle(handle, releaseWorkerSignals);
    clearWorkerSignalState(runId);
    await stopWorkerReferenceWithinShutdown(workerAgentReference);
    throw storeShutdownError(operation);
  }

  function trackHermesRun(
    runId: string,
    handle: WorkerExecutorTurnHandle,
    options?: {
      readyOkEventStatus?: string;
      completionOkFallbackStatus?: ProductRun["status"];
      completionOkEventStatus?: string;
      okHeartbeat?: string;
      releaseWorkerSignals?: () => void;
    },
  ): void {
    trackActiveHermesHandle(runId, handle, options?.releaseWorkerSignals);
    void handle.ready
      .then(async (result) => {
        if (shutdownRequested) {
          return;
        }
        if (result.ok) {
          await applyHermesStartResult(
            runId,
            result,
            "running",
            options?.readyOkEventStatus ?? "AI worker started",
            options?.okHeartbeat,
          );
        }
      })
      .catch(async (error: unknown) => {
        if (shutdownRequested) {
          return;
        }
        await applyHermesStartResult(runId, failedWorkerExecutorResult(error));
      })
      .catch(() => undefined);
    void handle.completion
      .then(async (result) => {
        untrackActiveHermesHandle(runId, handle);
        if (shutdownRequested) {
          return;
        }
        await applyHermesStartResult(
          runId,
          result,
          options?.completionOkFallbackStatus ?? "paused",
          options?.completionOkEventStatus ?? "AI worker response",
          options?.okHeartbeat,
        );
      })
      .catch(async (error: unknown) => {
        untrackActiveHermesHandle(runId, handle);
        if (shutdownRequested) {
          return;
        }
        await applyHermesStartResult(runId, failedWorkerExecutorResult(error));
      })
      .catch(() => undefined);
  }

  function trackHermesCommand(
    runId: string,
    handle: WorkerExecutorTurnHandle,
    releaseWorkerSignals: () => void,
  ): void {
    trackActiveHermesHandle(runId, handle, releaseWorkerSignals);
    void handle.completion
      .then(async (result) => {
        untrackActiveHermesHandle(runId, handle);
        if (shutdownRequested) {
          return;
        }
        await applyHermesCommandResult(runId, result);
      })
      .catch(async (error: unknown) => {
        untrackActiveHermesHandle(runId, handle);
        if (shutdownRequested) {
          return;
        }
        await applyHermesCommandResult(
          runId,
          failedWorkerExecutorResult(error),
        );
      })
      .catch(() => undefined);
  }

  function requestStoreShutdown(): Promise<void> {
    if (shutdownPromise) {
      return shutdownPromise;
    }
    shutdownRequested = true;
    clearAllWorkerSignalState();
    for (const provider of defaultCapabilityProviders()) {
      beginCapabilityOperation(provider.id);
    }
    shutdownPromise = performStoreShutdown();
    return shutdownPromise;
  }

  async function performStoreShutdown(): Promise<void> {
    for (const runId of [...activeHermesRuns.keys()]) {
      stopActiveHermesHandles(runId);
    }
    runCompletionNotices.clear();

    const capabilityShutdown = Promise.resolve().then(() =>
      capabilityRegistry.shutdown?.(),
    );
    const ownedSetupCancellation = cancelOpenChannelSetups(null);
    const executorShutdown = ownedSetupCancellation.then(
      () => workerExecutor.shutdown?.(),
      () => workerExecutor.shutdown?.(),
    );
    const operationsAtShutdown = [
      updateQueue,
      ...activeWorkerSignalDrains,
      ...activeExternalOperations,
      ownedSetupCancellation,
      capabilityShutdown,
      executorShutdown,
    ];
    await settleWithin(
      Promise.allSettled(operationsAtShutdown),
      PRODUCT_STORE_OPERATION_DRAIN_TIMEOUT_MS,
    );

    for (const runId of [...activeHermesRuns.keys()]) {
      stopActiveHermesHandles(runId);
    }
    runCompletionNotices.clear();
    capabilityCheckPromises.clear();

    let current = statePromise
      ? await settleWithin(
          statePromise.catch(() => null),
          PRODUCT_STORE_STATE_SNAPSHOT_TIMEOUT_MS,
        )
      : null;
    if (!current) {
      try {
        current = database.readState();
      } catch {
        current = null;
      }
    }
    await cancelOpenChannelSetups(current);
    const workerAgentReferences = new Set(observedWorkerAgentReferences);
    for (const worker of current?.workers ?? []) {
      workerAgentReferences.add(worker.config.hermesAgentReference);
    }
    await settleWithin(
      Promise.allSettled(
        [...workerAgentReferences].map((workerAgentReference) =>
          stopWorkerExecutorProcesses(workerAgentReference),
        ),
      ),
      PRODUCT_STORE_PROCESS_CLEANUP_TIMEOUT_MS,
    );

    for (const runId of [...activeHermesRuns.keys()]) {
      stopActiveHermesHandles(runId);
    }
    await drainLatestUpdateQueue();
    database.close();
  }

  return {
    getState: async () => normalizeState(await loadState()),
    getInstallationId: () => database.installationId,
    shutdown: requestStoreShutdown,
    exportCloudSnapshot: () =>
      withExternalOperation("export cloud snapshot", async () => {
        const snapshot = await buildCloudPortableSnapshot(await loadState());
        assertStoreAcceptingOperations("export cloud snapshot");
        return snapshot;
      }),
    applyCloudSnapshot: (cloudInput) =>
      withExternalOperation("apply cloud snapshot", async () => {
        const current = await loadState();
        assertStoreAcceptingOperations("apply cloud snapshot");
        assertCurrentCloudSnapshotAttempt(cloudInput);
        assertExpectedCloudAccount(current, cloudInput.expectedCloudUserId);
        if (
          shouldIsolateCloudIdentity(
            current,
            cloudInput.user.id,
            cloudInput.replacePortableState,
          )
        ) {
          for (const runId of [...activeHermesRuns.keys()]) {
            stopActiveHermesHandles(runId);
          }
          runCompletionNotices.clear();
          await Promise.all(
            current.workers.map((worker) =>
              stopWorkerExecutorProcesses(worker.config.hermesAgentReference),
            ),
          );
          assertStoreAcceptingOperations("apply cloud snapshot");
        }
        return updateState(
          async (draft) => {
            assertCurrentCloudSnapshotAttempt(cloudInput);
            assertExpectedCloudAccount(draft, cloudInput.expectedCloudUserId);
            const merged = await mergeCloudPortableSnapshot(draft, cloudInput, {
              installationId: database.installationId,
            });
            assertCurrentCloudSnapshotAttempt(cloudInput);
            const materialized = await materializeWorkerSkills(merged, {
              workerExecutor,
            });
            assertCurrentCloudSnapshotAttempt(cloudInput);
            assertStoreAcceptingOperations("apply cloud snapshot");
            return materialized;
          },
          { trackCloudChanges: false },
        );
      }),
    syncLabSessions: (sessions) =>
      withExternalOperation("sync lab sessions", async () =>
        updateState(async (draft) => {
          const materialized = await materializeLabSessions(draft, sessions);
          assertStoreAcceptingOperations("sync lab sessions");
          return materialized;
        }),
      ),
    listPendingWorkflowMerges: () =>
      withExternalOperation("list pending workflow merges", async () =>
        listPendingProductWorkflowMerges(await loadState()),
      ),
    keepWorkflowAsNew: (sourceWorkflowId) =>
      withExternalOperation("keep workflow as new", async () =>
        updateState(async (draft) => {
          const sourceWorkflow = requireWorkflow(draft, sourceWorkflowId);
          const { proposal } =
            await loadProductWorkflowMergeProposal(sourceWorkflow);
          const targetWorkflows = draft.workflows.filter(
            (workflow) =>
              workflow.id !== sourceWorkflowId &&
              !draft.workflowTombstones.some(
                (item) => item.workflowId === workflow.id,
              ),
          );
          const resolution = await resolveProductWorkflowMergeBase({
            proposal,
            workflows: targetWorkflows,
          });
          if (
            proposal.result === "incompatible" ||
            resolution.status !== "ready" ||
            !resolution.productWorkflowId
          ) {
            throw new Error(
              "This workflow no longer has a valid merge choice. / 此工作流已没有可处理的有效合并选项。",
            );
          }
          await writeProductWorkflowMergeResolution({
            workflow: sourceWorkflow,
            proposal,
            decision: "create_new",
          });
          return draft;
        }),
      ),
    applyWorkflowMergeProposal: (sourceWorkflowId, targetWorkflowId) =>
      withExternalOperation("apply workflow merge proposal", async () => {
        const resultHolder: {
          value?: Omit<ProductApplyWorkflowMergeResponse, "state">;
        } = {};
        const state = await updateState(async (draft) => {
          const sourceWorkflow = requireWorkflow(draft, sourceWorkflowId);
          const { proposal } =
            await loadProductWorkflowMergeProposal(sourceWorkflow);
          const eligibleWorkflows = targetWorkflowId
            ? draft.workflows.filter(
                (workflow) =>
                  workflow.id === targetWorkflowId &&
                  !draft.workflowTombstones.some(
                    (item) => item.workflowId === workflow.id,
                  ),
              )
            : draft.workflows;
          const resolution = await resolveProductWorkflowMergeBase({
            proposal,
            workflows: eligibleWorkflows,
          });
          if (
            !resolution.graph ||
            !resolution.graphPath ||
            !resolution.productWorkflowId
          ) {
            const diagnostic = resolution.errors[0]
              ? ` Diagnostic / 诊断：${resolution.errors[0]}`
              : "";
            throw new Error(
              `The canonical workflow targeted by this proposal is missing. / 此提案对应的规范工作流已不存在。${diagnostic}`,
            );
          }
          if (resolution.status === "stale") {
            throw new Error(
              "This merge proposal is stale because the canonical workflow changed. Record or generate the case again before applying it. / 规范工作流已发生变化，此合并提案已经过期。请重新录制或生成后再应用。",
            );
          }
          const resolvedAt = new Date();
          const updatedAt = resolvedAt.toISOString();
          const canonicalProductWorkflowId = resolution.productWorkflowId;
          if (resolution.status === "applied") {
            const existingDecision = await readProductWorkflowMergeResolution(
              sourceWorkflow,
              proposal,
            );
            if (
              existingDecision?.decision === "merge" &&
              existingDecision.targetWorkflowId === canonicalProductWorkflowId
            ) {
              resultHolder.value = {
                sourceWorkflowId,
                canonicalProductWorkflowId,
                canonicalGraph: resolution.graph,
                graphPath: resolution.graphPath,
                alreadyApplied: true,
              };
              return draft;
            }
            await writeProductWorkflowMergeResolution({
              workflow: sourceWorkflow,
              proposal,
              decision: "merge",
              targetWorkflowId: canonicalProductWorkflowId,
              now: resolvedAt,
            });
            resultHolder.value = {
              sourceWorkflowId,
              canonicalProductWorkflowId,
              canonicalGraph: resolution.graph,
              graphPath: resolution.graphPath,
              alreadyApplied: true,
            };
            return finalizeProductWorkflowMergeState({
              draft,
              sourceWorkflow,
              targetWorkflowId: canonicalProductWorkflowId,
              updatedAt,
            });
          }
          const applied = await applyCanonicalWorkflowMergeProposal({
            proposal,
            currentGraph: resolution.graph,
            outDir: dirname(resolution.graphPath),
            sourceSkillPath: sourceWorkflow.artifactPath ?? undefined,
          });
          await writeProductWorkflowMergeResolution({
            workflow: sourceWorkflow,
            proposal,
            decision: "merge",
            targetWorkflowId: canonicalProductWorkflowId,
            now: resolvedAt,
          });
          resultHolder.value = {
            sourceWorkflowId,
            canonicalProductWorkflowId,
            canonicalGraph: applied.graph,
            graphPath: applied.graphPath,
            alreadyApplied: false,
          };
          return finalizeProductWorkflowMergeState({
            draft,
            sourceWorkflow,
            targetWorkflowId: canonicalProductWorkflowId,
            updatedAt,
          });
        });
        if (!resultHolder.value) {
          throw new Error(
            "The workflow merge did not produce a result. / 工作流合并未生成结果。",
          );
        }
        return { state, ...resultHolder.value };
      }),
    listWorkflowVersions: (workflowId) =>
      withExternalOperation("list workflow versions", async () => {
        const state = await loadState();
        const workflow = requireWorkflow(state, workflowId);
        const graphPath = requireProductWorkflowGraphPath(workflow);
        const versions = await listWorkflowGraphRevisions(graphPath);
        const current = versions.find((version) => version.isCurrent);
        if (!current) {
          throw new Error(
            "The current workflow revision is missing from version history. / 版本历史中缺少当前工作流版本。",
          );
        }
        return {
          workflowId: workflow.id,
          workflowTitle: workflow.title,
          currentRevisionId: current.graph.revision.revisionId,
          versions: versions.map(({ graph, isCurrent }) => ({
            revisionId: graph.revision.revisionId,
            revisionNumber: graph.revision.number,
            previousRevisionId: graph.revision.previousRevisionId,
            createdAt: graph.revision.createdAt,
            contentHash: graph.revision.contentHash,
            isCurrent,
          })),
        };
      }),
    restoreWorkflowVersion: (workflowId, revisionId) =>
      withExternalOperation("restore workflow version", async () => {
        let restoredResult:
          Omit<ProductRestoreWorkflowVersionResponse, "state"> | undefined;
        const state = await updateState(async (draft) => {
          const workflow = requireWorkflow(draft, workflowId);
          const graphPath = requireProductWorkflowGraphPath(workflow);
          const restored = await restoreWorkflowGraphRevision({
            graphPath,
            revisionId,
            sourceSkillPath: workflow.artifactPath ?? undefined,
          });
          const updatedAt = new Date().toISOString();
          restoredResult = {
            workflowId,
            restoredFromRevisionId: revisionId,
            canonicalGraph: restored.graph,
            graphPath: restored.graphPath,
          };
          const updatedWorkflow = { ...workflow, updatedAt };
          return {
            ...draft,
            workflows: [
              updatedWorkflow,
              ...draft.workflows.filter((item) => item.id !== workflowId),
            ],
          };
        });
        if (!restoredResult) {
          throw new Error(
            "The workflow version was not restored. / 工作流版本未恢复。",
          );
        }
        return { state, ...restoredResult };
      }),
    editWorkflowGraph: (workflowId, edit) =>
      withExternalOperation("edit workflow graph", async () => {
        let editResult:
          Omit<ProductWorkflowGraphEditResponse, "state"> | undefined;
        const state = await updateState(async (draft) => {
          const workflow = requireWorkflow(draft, workflowId);
          const graphPath = requireProductWorkflowGraphPath(workflow);
          const updatedAt = new Date().toISOString();
          const persisted = await persistProductWorkflowGraphEdit({
            graphPath,
            sourceSkillPath: workflow.artifactPath ?? undefined,
            edit,
            now: new Date(updatedAt),
          });
          editResult = {
            workflowId,
            canonicalGraph: persisted.graph,
            graphPath: persisted.graphPath,
          };
          const updatedWorkflow = { ...workflow, updatedAt };
          return {
            ...draft,
            workflows: [
              updatedWorkflow,
              ...draft.workflows.filter((item) => item.id !== workflowId),
            ],
          };
        });
        if (!editResult) {
          throw new Error(
            "The workflow graph edit was not saved. / 工作流图编辑未保存。",
          );
        }
        return { state, ...editResult };
      }),
    recordPermissionSnapshot: async (snapshot) =>
      updateState((draft) => ({
        ...draft,
        permissionSnapshot: snapshot,
      })),
    refreshHermes: () =>
      withExternalOperation("refresh Hermes", async () =>
        updateState(async (state) => {
          const hermes = await mergeWorkerExecutorStatus(
            state.hermes,
            workerExecutor,
          );
          assertStoreAcceptingOperations("refresh Hermes");
          return { ...state, hermes };
        }),
      ),
    refreshCapabilityProviders: () =>
      withExternalOperation("refresh capability providers", async () =>
        updateState(async (state) => {
          const snapshots = await capabilityRegistry.list();
          assertStoreAcceptingOperations("refresh capability providers");
          return {
            ...state,
            capabilityProviders: mergeCapabilityProviderSnapshots(
              state.capabilityProviders,
              snapshots,
            ),
          };
        }),
      ),
    prepareCapabilityProvider: (providerId) =>
      withExternalOperation("prepare capability provider", async () => {
        const generation = beginCapabilityOperation(providerId);
        const provider = await capabilityRegistry.prepare(providerId);
        assertStoreAcceptingOperations("prepare capability provider");
        let effectiveProvider = provider;
        const state = await updateState((draft) => {
          assertStoreAcceptingOperations("prepare capability provider");
          if (!isCurrentCapabilityOperation(providerId, generation)) {
            effectiveProvider =
              draft.capabilityProviders.find(
                (item) => item.id === providerId,
              ) ?? provider;
            return draft;
          }
          return {
            ...draft,
            capabilityProviders: upsertCapabilityProvider(
              draft.capabilityProviders,
              provider,
            ),
          };
        });
        return { state, provider: effectiveProvider };
      }),
    checkCapabilityProvider: (providerId) =>
      withExternalOperation("check capability provider", async () => {
        const activeCheck = capabilityCheckPromises.get(providerId);
        if (activeCheck) {
          return activeCheck;
        }

        const checkOperation = (async () => {
          const generation = beginCapabilityOperation(providerId);
          await updateState((state) => {
            assertStoreAcceptingOperations("check capability provider");
            return isCurrentCapabilityOperation(providerId, generation)
              ? {
                  ...state,
                  capabilityProviders: markCapabilityProviderChecking(
                    state.capabilityProviders,
                    providerId,
                  ),
                }
              : state;
          });
          assertStoreAcceptingOperations("check capability provider");
          let provider: ProductCapabilityProvider;
          try {
            provider = await capabilityRegistry.check(providerId);
          } catch (error) {
            assertStoreAcceptingOperations("check capability provider");
            const current = await loadState();
            const fallback =
              current.capabilityProviders.find(
                (item) => item.id === providerId,
              ) ??
              defaultCapabilityProviders().find(
                (item) => item.id === providerId,
              );
            if (!fallback) {
              throw error;
            }
            const message =
              error instanceof Error ? error.message : String(error);
            provider = {
              ...fallback,
              status: "unavailable",
              lastCheckedAt: new Date().toISOString(),
              lastError: message,
              detail:
                providerId === "chrome"
                  ? "Chrome could not be checked from this device. Keep Chrome open and try again."
                  : "This connection could not be checked. Try again.",
            };
          }
          assertStoreAcceptingOperations("check capability provider");
          let effectiveProvider = provider;
          const state = await updateState((draft) => {
            assertStoreAcceptingOperations("check capability provider");
            if (!isCurrentCapabilityOperation(providerId, generation)) {
              effectiveProvider =
                draft.capabilityProviders.find(
                  (item) => item.id === providerId,
                ) ?? provider;
              return draft;
            }
            return {
              ...draft,
              capabilityProviders: upsertCapabilityProvider(
                draft.capabilityProviders,
                provider,
              ),
            };
          });
          return { state, provider: effectiveProvider };
        })().finally(() => {
          if (capabilityCheckPromises.get(providerId) === checkOperation) {
            capabilityCheckPromises.delete(providerId);
          }
        });
        capabilityCheckPromises.set(providerId, checkOperation);
        return checkOperation;
      }),
    getComposioOverview: (overviewInput = {}) =>
      withExternalOperation("get Composio overview", async () => {
        const state = await loadState();
        assertStoreAcceptingOperations("get Composio overview");
        const overview = await composioAdapter.overview({
          userId: composioUserIdForState(state, database.installationId),
          ...overviewInput,
        });
        assertStoreAcceptingOperations("get Composio overview");
        return overview;
      }),
    authorizeComposioToolkit: (authorizeInput) =>
      withExternalOperation("authorize Composio toolkit", async () => {
        const state = await loadState();
        assertStoreAcceptingOperations("authorize Composio toolkit");
        const authorization = await composioAdapter.authorize({
          userId: composioUserIdForState(state, database.installationId),
          ...authorizeInput,
        });
        assertStoreAcceptingOperations("authorize Composio toolkit");
        return authorization;
      }),
    getComposioConnection: (connectionId) =>
      withExternalOperation("get Composio connection", async () => {
        const state = await loadState();
        assertStoreAcceptingOperations("get Composio connection");
        const connection = await composioAdapter.getConnection({
          userId: composioUserIdForState(state, database.installationId),
          connectionId,
        });
        assertStoreAcceptingOperations("get Composio connection");
        return connection;
      }),
    disconnectComposioConnection: (connectionId) =>
      withExternalOperation("disconnect Composio connection", async () => {
        const state = await loadState();
        assertStoreAcceptingOperations("disconnect Composio connection");
        await composioAdapter.disconnect({
          userId: composioUserIdForState(state, database.installationId),
          connectionId,
        });
      }),
    setupAccount: async (accountInput) => {
      const state = await updateState((draft) => {
        const now = new Date().toISOString();
        const workspaceName = accountInput.workspaceName.trim();
        const accountName = accountInput.name.trim();
        const email = accountInput.email.trim();
        return {
          ...draft,
          account: {
            ...draft.account,
            name: accountName,
            email,
            signedInLabel: workspaceName,
            setupCompleted: true,
            updatedAt: now,
          },
          workspace: {
            ...draft.workspace,
            name: workspaceName,
          },
        };
      });
      return { state };
    },
    createWorker: (workerInput) =>
      withExternalOperation("create worker", async () => {
        const name = workerInput.name.trim();
        const description = workerInput.description.trim();
        if (!name || !description) {
          throw new Error("Worker name and identity scope are required.");
        }
        const workerId = createProductEntityId("worker", name);
        const hermesAgent = await workerExecutor.provisionAgent({
          workerId,
          workerName: name,
        });
        await assertStoreOpenAfterWorkerReference(
          hermesAgent.agentReference,
          "create worker",
        );
        const channelInput = normalizeProductWorkerChannelInput(
          workerInput.channel,
          workerInput.commandChannel ?? null,
        );
        const channelConfig = await configureWorkerChannelWithExecutor(
          workerExecutor,
          hermesAgent.agentReference,
          channelInput,
        );
        await assertStoreOpenAfterWorkerReference(
          hermesAgent.agentReference,
          "create worker",
        );
        let createdWorker: ProductWorker | null = null;
        const state = await updateState((draft) => {
          assertStoreAcceptingOperations("create worker");
          const now = new Date().toISOString();
          createdWorker = {
            id: workerId,
            name,
            initials: workerInitials(name),
            description,
            status: "Needs device",
            tone: "warning",
            avatarKey: avatarKeyForWorkerName(name),
            deviceId: null,
            selectedInstalledWorkflowId: null,
            heartbeat: "AI worker setup created",
            activities: [
              "AI worker profile created",
              workerChannelActivity(channelConfig),
              "Device assignment needed",
              "Ready for workflow install",
            ],
            config: {
              identityScope:
                workerInput.sourceText?.trim() ||
                `${name} follows the configured operating scope.`,
              runtimeProfile: "Local AI worker profile",
              toolAccess: dedupe([
                "browser control",
                "desktop automation",
                "mail",
                "chat",
                workerChannelToolAccess(channelConfig),
              ]),
              memoryContext:
                "Local workspace memory, installed workflow context, and AI worker profile memory",
              approvalPolicy: "allow_all",
              heartbeatPolicy:
                "Check local AI worker health while idle and log recovery steps.",
              hermesAgentReference: hermesAgent.agentReference,
              channel: channelConfig,
            },
          };
          draft.workers = [createdWorker, ...draft.workers];
          draft.approvalPolicies = upsertApprovalPolicy(
            draft.approvalPolicies,
            {
              id: approvalPolicyIdForWorker(workerId),
              scopeType: "worker",
              scopeId: workerId,
              mode: "allow_all",
              description:
                "AI worker can proceed under allow_all; progress appears in run events.",
              updatedAt: now,
            },
          );
          return draft;
        });
        return {
          state,
          worker: createdWorker!,
        };
      }),
    deleteWorker: (workerIdInput) =>
      withExternalOperation("delete worker", async () => {
        const workerId = workerIdInput.trim();
        if (!workerId) {
          throw new Error("Worker id is required.");
        }

        const current = await loadState();
        const worker = requireWorker(current, workerId);
        const activeRun = current.runs.find(
          (run) => run.workerId === worker.id && isOpenRunStatus(run.status),
        );
        if (activeRun) {
          throw new Error(
            "Stop the active AI worker session before deleting it.",
          );
        }

        const workerConnections = current.channelConnections.filter(
          (connection) => connection.workerId === worker.id,
        );
        await Promise.allSettled(
          current.channelSetups
            .filter(
              (setup) =>
                setup.workerId === worker.id &&
                !isTerminalChannelSetupStatus(setup.status),
            )
            .map((setup) =>
              cancelChannelSetupRecord(
                setup,
                worker.config.hermesAgentReference,
              ),
            ),
        );
        if (workerConnections.length > 0 && workerExecutor.disconnectChannel) {
          for (const connection of workerConnections) {
            const bindings = current.channelBindings.filter(
              (binding) =>
                binding.workerId === worker.id &&
                binding.connectionId === connection.id,
            );
            await workerExecutor.disconnectChannel({
              workerAgentReference: worker.config.hermesAgentReference,
              platform: connection.platform,
              bindings: bindings.map((binding) => ({
                chatId: binding.conversationId,
                threadId: binding.threadId,
              })),
            });
          }
        }
        assertStoreAcceptingOperations("delete worker");

        const state = await updateState((draft) => {
          assertStoreAcceptingOperations("delete worker");
          requireWorker(draft, worker.id);
          const now = new Date().toISOString();
          const removedAssignments = draft.installedWorkflows.filter(
            (workflow) => workflow.workerId === worker.id,
          );
          const removedAssignmentIds = new Set(
            removedAssignments.map((workflow) => workflow.id),
          );
          const deletedEntities: ProductCloudDelete[] = [
            { entityType: "worker", entityId: worker.id, deletedAt: now },
          ];

          return {
            ...draft,
            workers: draft.workers.filter((item) => item.id !== worker.id),
            devices: draft.devices.map((device) =>
              device.assignedWorkerId === worker.id
                ? { ...device, assignedWorkerId: null }
                : device,
            ),
            installedWorkflows: draft.installedWorkflows.filter(
              (workflow) => workflow.workerId !== worker.id,
            ),
            channelConnections: draft.channelConnections.filter(
              (connection) => connection.workerId !== worker.id,
            ),
            channelSetups: draft.channelSetups.filter(
              (setup) => setup.workerId !== worker.id,
            ),
            channelBindings: draft.channelBindings.filter(
              (binding) => binding.workerId !== worker.id,
            ),
            approvalPolicies: draft.approvalPolicies.filter(
              (policy) =>
                !(
                  policy.scopeType === "worker" && policy.scopeId === worker.id
                ) &&
                !(
                  policy.scopeType === "installed_workflow" &&
                  removedAssignmentIds.has(policy.scopeId)
                ),
            ),
            pendingCloudUpserts: draft.pendingCloudUpserts.filter(
              (pending) =>
                !(
                  pending.entityType === "worker" &&
                  pending.entityId === worker.id
                ),
            ),
            pendingCloudDeletes: queueCloudDeletes(
              draft.pendingCloudDeletes,
              deletedEntities,
            ),
          };
        });

        return { state, worker };
      }),
    createWorkflow: async (workflowInput) => {
      const title = workflowInput.title.trim();
      const description = workflowInput.description.trim();
      if (!title || !description) {
        throw new Error("Workflow title and description are required.");
      }
      let createdWorkflow: ProductWorkflow | null = null;
      const state = await updateState((draft) => {
        const now = new Date().toISOString();
        createdWorkflow = {
          id: createProductEntityId(
            workflowInput.mode === "import" ? "imported" : "manual",
            title,
          ),
          title,
          description,
          status: "Needs review",
          sourceType: "imported",
          sourceText: workflowInput.sourceText?.trim() || null,
          confidence: null,
          apps: dedupe(workflowInput.apps),
          stats: {
            uiEvents: 0,
            ocrObservations: 0,
            voiceNotes: 0,
            duration: "--",
            decisionPoints: 0,
          },
          detectedAt:
            workflowInput.mode === "import" ? "Imported entry" : "Manual entry",
          artifactPath: null,
          createdAt: now,
          updatedAt: now,
        };
        draft.workflows = [createdWorkflow, ...draft.workflows];
        return draft;
      });
      return {
        state,
        workflow: createdWorkflow!,
      };
    },
    assignDevice: async (assignmentInput) => {
      let assignedWorker: ProductWorker | null = null;
      let assignedDevice: ProductDevice | null = null;
      const state = await updateState((draft) => {
        const worker = requireWorker(draft, assignmentInput.workerId);
        const device = requireDevice(draft, assignmentInput.deviceId);
        const hasInstalledWorkflow = draft.installedWorkflows.some(
          (workflow) => workflow.workerId === worker.id,
        );

        assignedDevice = {
          ...device,
          assignedWorkerId: worker.id,
          heartbeat:
            device.status === "Available now"
              ? "Assigned just now"
              : device.heartbeat,
        };
        assignedWorker = {
          ...worker,
          deviceId: device.id,
          status: "No active task",
          tone: "idle",
          heartbeat: `${device.name} assigned`,
          activities: [
            `${device.name} assigned`,
            hasInstalledWorkflow
              ? "Installed workflows ready"
              : "Ready for workflow install",
            "Approval policy allow_all",
          ],
        };

        draft.devices = draft.devices.map((item) => {
          if (item.id === device.id) {
            return assignedDevice!;
          }
          if (item.assignedWorkerId === worker.id) {
            return {
              ...item,
              assignedWorkerId: null,
            };
          }
          return item;
        });
        draft.workers = draft.workers.map((item) => {
          if (item.id === worker.id) {
            return assignedWorker!;
          }
          if (item.deviceId === device.id) {
            return {
              ...item,
              deviceId: null,
              status: "Needs device",
              tone: "warning",
              heartbeat: "No computer assigned",
              activities: [
                "Device assignment changed",
                "Device assignment needed",
                "No active task",
              ],
            };
          }
          return item;
        });
        draft.installedWorkflows = draft.installedWorkflows.map((workflow) =>
          workflow.workerId === worker.id
            ? {
                ...workflow,
                deployTargetDeviceId: device.id,
              }
            : workflow,
        );
        return draft;
      });
      return {
        state,
        worker: assignedWorker!,
        device: assignedDevice!,
      };
    },
    updateWorkerConfig: async (workerId, configInput) => {
      let updatedWorker: ProductWorker | null = null;
      const state = await updateState((draft) => {
        const updatedAt = new Date().toISOString();
        requireWorker(draft, workerId);
        return {
          ...draft,
          workers: draft.workers.map((worker) => {
            if (worker.id !== workerId) {
              return worker;
            }
            const hermesAgentReference = normalizeHermesAgentReference(
              worker,
              configInput.hermesAgentReference,
            );
            updatedWorker = {
              ...worker,
              config: {
                identityScope: configInput.identityScope,
                runtimeProfile: configInput.runtimeProfile,
                toolAccess: dedupe(configInput.toolAccess),
                memoryContext: configInput.memoryContext,
                approvalPolicy: "allow_all",
                heartbeatPolicy: configInput.heartbeatPolicy,
                hermesAgentReference,
                channel: normalizePersistedProductWorkerChannel(
                  configInput.channel ?? worker.config.channel,
                ),
              },
              activities: [
                "AI worker setup saved",
                "Runtime profile ready",
                "Approval policy allow_all",
              ],
            };
            return updatedWorker;
          }),
          approvalPolicies: upsertApprovalPolicy(draft.approvalPolicies, {
            id: approvalPolicyIdForWorker(workerId),
            scopeType: "worker",
            scopeId: workerId,
            mode: "allow_all",
            description:
              "AI worker can proceed under allow_all; progress appears in run events.",
            updatedAt,
          }),
        };
      });
      if (!updatedWorker) {
        throw new Error(`Unknown worker: ${workerId}`);
      }
      return {
        state,
        worker: updatedWorker,
      };
    },
    configureWorkerChannel: (workerId, channelInput) =>
      withExternalOperation("configure worker channel", async () => {
        const current = await loadState();
        const worker = requireWorker(current, workerId);
        const previousChannel = normalizePersistedProductWorkerChannel(
          worker.config.channel,
        );
        const configuredChannel = await configureWorkerChannelWithExecutor(
          workerExecutor,
          worker.config.hermesAgentReference,
          channelInput,
        );
        assertStoreAcceptingOperations("configure worker channel");
        const hasCredentialInput = Object.values(
          channelInput.credentials ?? {},
        ).some((value) => value.trim().length > 0);
        const channelConfig =
          !hasCredentialInput &&
          configuredChannel.platform === previousChannel.platform
            ? {
                ...configuredChannel,
                configuredFields: previousChannel.configuredFields,
                missingFields: previousChannel.missingFields,
                status: previousChannel.status,
                lastTestedAt: previousChannel.lastTestedAt,
                lastError: previousChannel.lastError,
              }
            : configuredChannel;
        const configuredAt = new Date().toISOString();
        const previousConnection = current.channelConnections.find(
          (item) =>
            item.workerId === workerId &&
            item.platform === channelConfig.platform,
        );
        const connection =
          channelConfig.platform === "none"
            ? null
            : ({
                id: channelConnectionId(workerId, channelConfig.platform),
                workerId,
                platform: channelConfig.platform,
                label: channelConfig.label,
                setupMethod: channelSetupMethod(channelConfig.platform),
                status: channelConnectionStatusFromWorkerChannel(channelConfig),
                accountLabel: previousConnection?.accountLabel ?? null,
                hermesProfile: worker.config.hermesAgentReference,
                configuredFields: channelConfig.configuredFields,
                missingFields: channelConfig.missingFields,
                lastCheckedAt: channelConfig.lastTestedAt,
                lastConnectedAt: previousConnection?.lastConnectedAt ?? null,
                lastError: channelConfig.lastError,
                createdAt: previousConnection?.createdAt ?? configuredAt,
                updatedAt: configuredAt,
              } satisfies ProductChannelConnection);
        let updatedWorker: ProductWorker | null = null;
        const state = await updateState((draft) => {
          assertStoreAcceptingOperations("configure worker channel");
          return {
            ...draft,
            channelConnections: connection
              ? upsertById(draft.channelConnections, connection)
              : draft.channelConnections,
            workers: draft.workers.map((item) => {
              if (item.id !== workerId) {
                return item;
              }
              updatedWorker = {
                ...item,
                config: {
                  ...item.config,
                  toolAccess: replaceWorkerChannelToolAccess(
                    item.config.toolAccess,
                    channelConfig,
                  ),
                  channel: channelConfig,
                },
                activities: [
                  workerChannelActivity(channelConfig),
                  ...item.activities.filter(
                    (activity) =>
                      !/channel (connected|test failed|configured|needs setup)/iu.test(
                        activity,
                      ) && activity !== "No message channel configured",
                  ),
                ].slice(0, 6),
              };
              return updatedWorker;
            }),
          };
        });
        const finalWorker =
          updatedWorker ?? state.workers.find((item) => item.id === workerId);
        if (!finalWorker) {
          throw new Error(`Unknown worker: ${workerId}`);
        }
        return {
          state,
          worker: finalWorker,
          channel: finalWorker.config.channel,
        };
      }),
    disconnectWorkerChannel: (workerId, disconnectInput) =>
      withExternalOperation("disconnect worker channel", async () => {
        const current = await loadState();
        const worker = requireWorker(current, workerId);
        const connection = requireChannelConnection(
          current,
          workerId,
          disconnectInput.connectionId,
        );
        if (!workerExecutor.disconnectChannel) {
          throw new Error(
            "Channel disconnection is not available in this runtime.",
          );
        }
        const connectionBindings = current.channelBindings.filter(
          (binding) =>
            binding.workerId === workerId &&
            binding.connectionId === connection.id,
        );
        await Promise.allSettled(
          current.channelSetups
            .filter(
              (setup) =>
                setup.connectionId === connection.id &&
                !isTerminalChannelSetupStatus(setup.status),
            )
            .map((setup) =>
              cancelChannelSetupRecord(
                setup,
                worker.config.hermesAgentReference,
              ),
            ),
        );
        await workerExecutor.disconnectChannel({
          workerAgentReference: worker.config.hermesAgentReference,
          platform: connection.platform,
          bindings: connectionBindings.map((binding) => ({
            chatId: binding.conversationId,
            threadId: binding.threadId,
          })),
        });
        assertStoreAcceptingOperations("disconnect worker channel");

        const disconnectedChannel = defaultProductWorkerChannelConfig("none");
        const state = await updateState((draft) => {
          assertStoreAcceptingOperations("disconnect worker channel");
          return {
            ...draft,
            channelConnections: draft.channelConnections.filter(
              (item) => item.id !== connection.id,
            ),
            channelSetups: draft.channelSetups.filter(
              (item) => item.connectionId !== connection.id,
            ),
            channelBindings: draft.channelBindings.filter(
              (item) => item.connectionId !== connection.id,
            ),
            workers: draft.workers.map((item) =>
              item.id !== workerId
                ? item
                : {
                    ...item,
                    config: {
                      ...item.config,
                      toolAccess: replaceWorkerChannelToolAccess(
                        item.config.toolAccess,
                        disconnectedChannel,
                      ),
                      channel: disconnectedChannel,
                    },
                    activities: [
                      `${connection.label} channel disconnected`,
                      ...item.activities.filter(
                        (activity) =>
                          !/channel (connected|test failed|configured|needs setup|disconnected)/iu.test(
                            activity,
                          ) && activity !== "No message channel configured",
                      ),
                    ].slice(0, 6),
                  },
            ),
          };
        });
        return { state, connection };
      }),
    testWorkerChannel: (workerId) =>
      withExternalOperation("test worker channel", async () => {
        const current = await loadState();
        const worker = requireWorker(current, workerId);
        const channel = normalizePersistedProductWorkerChannel(
          worker.config.channel,
        );
        if (channel.platform !== "none") {
          await workerExecutor.ensureChannelGateway?.({
            workerAgentReference: worker.config.hermesAgentReference,
            reload: true,
          });
          assertStoreAcceptingOperations("test worker channel");
        }
        const result =
          channel.platform === "none"
            ? {
                platform: "none" as const,
                status: "not_configured" as const,
                lastTestedAt: new Date().toISOString(),
                lastError: "Choose a channel before testing the connection.",
              }
            : workerExecutor.testChannel
              ? await workerExecutor.testChannel({
                  workerAgentReference: worker.config.hermesAgentReference,
                  platform: channel.platform,
                })
              : {
                  platform: channel.platform,
                  status: "failed" as const,
                  lastTestedAt: new Date().toISOString(),
                  lastError:
                    "Channel testing is not available in this runtime adapter.",
                };
        assertStoreAcceptingOperations("test worker channel");
        const testedAt = result.lastTestedAt;
        let updatedWorker: ProductWorker | null = null;
        const state = await updateState((draft) => {
          assertStoreAcceptingOperations("test worker channel");
          const existingConnection = draft.channelConnections.find(
            (item) =>
              item.workerId === workerId && item.platform === channel.platform,
          );
          const testedConnection = existingConnection
            ? {
                ...existingConnection,
                status:
                  result.status === "connected"
                    ? ("connecting" as const)
                    : ("failed" as const),
                lastCheckedAt: testedAt,
                lastConnectedAt: existingConnection.lastConnectedAt,
                lastError: result.lastError,
                updatedAt: testedAt,
              }
            : null;
          return {
            ...draft,
            channelConnections: testedConnection
              ? upsertById(draft.channelConnections, testedConnection)
              : draft.channelConnections,
            workers: draft.workers.map((item) => {
              if (item.id !== workerId) {
                return item;
              }
              const previousChannel = normalizePersistedProductWorkerChannel(
                item.config.channel,
              );
              const nextChannel: ProductWorkerChannelConfig = {
                ...previousChannel,
                status:
                  result.status === "connected" ? "configured" : result.status,
                lastTestedAt: result.lastTestedAt,
                lastError: result.lastError,
              };
              updatedWorker = {
                ...item,
                config: {
                  ...item.config,
                  channel: nextChannel,
                },
                activities: [
                  workerChannelTestActivity(nextChannel),
                  ...item.activities.filter(
                    (activity) =>
                      !/channel (connected|test failed|configured)/iu.test(
                        activity,
                      ),
                  ),
                ].slice(0, 6),
              };
              return updatedWorker;
            }),
          };
        });
        const finalWorker =
          updatedWorker ?? state.workers.find((item) => item.id === workerId);
        if (!finalWorker) {
          throw new Error(`Unknown worker: ${workerId}`);
        }
        return {
          state,
          worker: finalWorker,
          channel: finalWorker.config.channel,
        };
      }),
    beginWorkerChannelSetup: (workerId, setupInput) =>
      withExternalOperation("begin worker channel setup", () =>
        withChannelSetupOperation(
          channelConnectionId(workerId, setupInput.platform),
          async () => {
            const current = await loadState();
            const worker = requireWorker(current, workerId);
            if (!workerExecutor.beginChannelSetup) {
              throw new Error(
                "QR channel setup is not available in this runtime.",
              );
            }
            const now = new Date().toISOString();
            const connectionId = channelConnectionId(
              workerId,
              setupInput.platform,
            );
            const previousActiveSetups = current.channelSetups.filter(
              (setup) =>
                setup.connectionId === connectionId &&
                !isTerminalChannelSetupStatus(setup.status),
            );
            await Promise.allSettled(
              previousActiveSetups.map((setup) =>
                cancelChannelSetupRecord(
                  setup,
                  worker.config.hermesAgentReference,
                ),
              ),
            );
            assertStoreAcceptingOperations("begin worker channel setup");
            const setupId = createProductEntityId("channel-setup");
            const snapshot = await workerExecutor.beginChannelSetup({
              setupId,
              workerAgentReference: worker.config.hermesAgentReference,
              platform: setupInput.platform,
              mode: setupInput.mode,
              allowedUsers: setupInput.allowedUsers,
            });
            const ownedSetup: OwnedChannelSetupProcess = {
              setupId,
              connectionId,
              workerAgentReference: worker.config.hermesAgentReference,
              processId: snapshot.processId,
            };
            ownedChannelSetupProcesses.set(setupId, ownedSetup);
            if (shutdownRequested) {
              await cancelOwnedChannelSetup(ownedSetup);
              throw storeShutdownError("begin worker channel setup");
            }
            assertStoreAcceptingOperations("begin worker channel setup");
            const connection: ProductChannelConnection = {
              id: connectionId,
              workerId,
              platform: setupInput.platform,
              label: channelDisplayLabel(setupInput.platform),
              setupMethod: "qr_link",
              status: channelConnectionStatusFromSetup(snapshot.status),
              accountLabel: snapshot.accountLabel,
              hermesProfile: worker.config.hermesAgentReference,
              configuredFields: [],
              missingFields: ["QR_LINK"],
              lastCheckedAt: snapshot.updatedAt,
              lastConnectedAt: null,
              lastError: snapshot.lastError,
              createdAt:
                current.channelConnections.find(
                  (item) => item.id === connectionId,
                )?.createdAt ?? now,
              updatedAt: snapshot.updatedAt,
            };
            const setup: ProductChannelSetup = {
              id: setupId,
              connectionId,
              workerId,
              platform: setupInput.platform,
              status: snapshot.status,
              qrPayload: snapshot.qrPayload,
              qrExpiresAt: snapshot.qrExpiresAt,
              accountLabel: snapshot.accountLabel,
              processId: snapshot.processId,
              lastError: snapshot.lastError,
              createdAt: now,
              updatedAt: snapshot.updatedAt,
            };
            const state = await updateState((draft) => {
              assertStoreAcceptingOperations("begin worker channel setup");
              return {
                ...draft,
                channelConnections: upsertById(
                  draft.channelConnections,
                  connection,
                ),
                channelSetups: [
                  setup,
                  ...draft.channelSetups.map((item) =>
                    item.connectionId === connectionId &&
                    !["connected", "failed", "cancelled"].includes(item.status)
                      ? {
                          ...item,
                          status: "cancelled" as const,
                          updatedAt: now,
                        }
                      : item,
                  ),
                ],
                workers: draft.workers.map((item) =>
                  item.id === workerId
                    ? {
                        ...item,
                        config: {
                          ...item.config,
                          channel: {
                            ...normalizePersistedProductWorkerChannel(
                              item.config.channel,
                            ),
                            platform: setupInput.platform,
                            label: channelDisplayLabel(setupInput.platform),
                            status: "testing" as const,
                            allowedUsers: setupInput.allowedUsers ?? [],
                            lastError: null,
                          },
                        },
                      }
                    : item,
                ),
              };
            });
            return { state, connection, setup };
          },
        ),
      ),
    readWorkerChannelSetup: (workerId, setupId) =>
      withExternalOperation("read worker channel setup", async () => {
        const current = await loadState();
        const worker = requireWorker(current, workerId);
        const setup = requireChannelSetup(current, workerId, setupId);
        const previousConnection = requireChannelConnection(
          current,
          workerId,
          setup.connectionId,
        );
        const snapshot = workerExecutor.readChannelSetup
          ? await workerExecutor.readChannelSetup({
              setupId,
              workerAgentReference: worker.config.hermesAgentReference,
              platform: setup.platform,
              processId: setup.processId,
            })
          : null;
        assertStoreAcceptingOperations("read worker channel setup");
        const startupTimedOut =
          !snapshot &&
          !Number.isNaN(Date.parse(setup.createdAt)) &&
          Date.now() - Date.parse(setup.createdAt) >=
            CHANNEL_SETUP_STARTUP_TIMEOUT_MS;
        if (startupTimedOut) {
          await cancelChannelSetupRecord(
            setup,
            worker.config.hermesAgentReference,
          );
          assertStoreAcceptingOperations("read worker channel setup");
        }
        const nextSetup: ProductChannelSetup = snapshot
          ? {
              ...setup,
              status: snapshot.status,
              qrPayload: snapshot.qrPayload,
              qrExpiresAt: snapshot.qrExpiresAt,
              accountLabel: snapshot.accountLabel,
              processId: snapshot.processId,
              lastError: snapshot.lastError,
              updatedAt: snapshot.updatedAt,
            }
          : startupTimedOut
            ? {
                ...setup,
                status: "failed",
                processId: null,
                lastError:
                  "The QR setup process did not produce a connection code. Try again or restart OysterWorkflow.",
                updatedAt: new Date().toISOString(),
              }
            : setup;
        const paired = nextSetup.status === "connected";
        const ownerUserId =
          paired && setup.platform === "weixin"
            ? (snapshot?.ownerUserId?.trim() ?? "")
            : "";
        if (paired) {
          if (ownerUserId && workerExecutor.configureChannel) {
            await workerExecutor.configureChannel({
              workerAgentReference: worker.config.hermesAgentReference,
              channel: {
                platform: "weixin",
                accessMode: "allowlist",
                allowedUsers: [ownerUserId],
                credentials: {},
              },
            });
            assertStoreAcceptingOperations("read worker channel setup");
          }
          await workerExecutor.ensureChannelGateway?.({
            workerAgentReference: worker.config.hermesAgentReference,
            reload: true,
          });
          assertStoreAcceptingOperations("read worker channel setup");
        }
        const nextConnection: ProductChannelConnection = {
          ...previousConnection,
          status: channelConnectionStatusFromSetup(nextSetup.status),
          accountLabel:
            nextSetup.accountLabel ?? previousConnection.accountLabel,
          configuredFields: paired ? ["QR_LINK"] : [],
          missingFields: paired ? [] : ["QR_LINK"],
          lastCheckedAt: nextSetup.updatedAt,
          lastConnectedAt: previousConnection.lastConnectedAt,
          lastError: nextSetup.lastError,
          updatedAt: nextSetup.updatedAt,
        };
        const state = await updateState((draft) => {
          assertStoreAcceptingOperations("read worker channel setup");
          return {
            ...draft,
            channelSetups: upsertById(draft.channelSetups, nextSetup),
            channelConnections: upsertById(
              draft.channelConnections,
              nextConnection,
            ),
            workers: draft.workers.map((item) => {
              if (item.id !== workerId) {
                return item;
              }
              const previousChannel = normalizePersistedProductWorkerChannel(
                item.config.channel,
              );
              return {
                ...item,
                config: {
                  ...item.config,
                  channel: {
                    ...previousChannel,
                    platform: setup.platform,
                    label: channelDisplayLabel(setup.platform),
                    accessMode: ownerUserId
                      ? ("allowlist" as const)
                      : previousChannel.accessMode,
                    allowedUsers: ownerUserId
                      ? [ownerUserId]
                      : previousChannel.allowedUsers,
                    configuredFields: nextConnection.configuredFields,
                    missingFields: nextConnection.missingFields,
                    status: paired
                      ? ("configured" as const)
                      : nextSetup.status === "failed"
                        ? ("failed" as const)
                        : ("testing" as const),
                    lastTestedAt: nextSetup.updatedAt,
                    lastError: nextSetup.lastError,
                  },
                },
              };
            }),
          };
        });
        if (isTerminalChannelSetupStatus(nextSetup.status)) {
          ownedChannelSetupProcesses.delete(nextSetup.id);
        }
        return { state, connection: nextConnection, setup: nextSetup };
      }),
    cancelWorkerChannelSetup: (workerId, setupId) =>
      withExternalOperation("cancel worker channel setup", async () => {
        const current = await loadState();
        const worker = requireWorker(current, workerId);
        const setup = requireChannelSetup(current, workerId, setupId);
        const connection = requireChannelConnection(
          current,
          workerId,
          setup.connectionId,
        );
        await cancelChannelSetupRecord(
          setup,
          worker.config.hermesAgentReference,
        );
        assertStoreAcceptingOperations("cancel worker channel setup");
        const now = new Date().toISOString();
        const nextSetup: ProductChannelSetup = {
          ...setup,
          status: "cancelled",
          processId: null,
          updatedAt: now,
        };
        const nextConnection: ProductChannelConnection = {
          ...connection,
          status: "disconnected",
          updatedAt: now,
        };
        const state = await updateState((draft) => {
          assertStoreAcceptingOperations("cancel worker channel setup");
          return {
            ...draft,
            channelSetups: upsertById(draft.channelSetups, nextSetup),
            channelConnections: upsertById(
              draft.channelConnections,
              nextConnection,
            ),
            workers: draft.workers.map((item) => {
              if (item.id !== workerId) {
                return item;
              }
              const previousChannel = normalizePersistedProductWorkerChannel(
                item.config.channel,
              );
              return {
                ...item,
                config: {
                  ...item.config,
                  channel: {
                    ...previousChannel,
                    platform: setup.platform,
                    label: channelDisplayLabel(setup.platform),
                    configuredFields: [],
                    missingFields: ["QR_LINK"],
                    status: "not_configured" as const,
                    lastTestedAt: now,
                    lastError: null,
                  },
                },
              };
            }),
          };
        });
        return { state, connection: nextConnection, setup: nextSetup };
      }),
    listWorkerChannelPeers: (workerId, connectionId) =>
      withExternalOperation("list worker channel peers", async () => {
        const current = await loadState();
        const worker = requireWorker(current, workerId);
        const connection = requireChannelConnection(
          current,
          workerId,
          connectionId,
        );
        if (
          connection.status !== "connecting" &&
          connection.status !== "connected"
        ) {
          throw new Error(
            "Connect the channel before discovering conversations.",
          );
        }
        if (!workerExecutor.listChannelPeers) {
          throw new Error("Channel conversation discovery is not available.");
        }
        await workerExecutor.ensureChannelGateway?.({
          workerAgentReference: worker.config.hermesAgentReference,
        });
        assertStoreAcceptingOperations("list worker channel peers");
        const discovered = await workerExecutor.listChannelPeers({
          workerAgentReference: worker.config.hermesAgentReference,
          platform: connection.platform,
        });
        assertStoreAcceptingOperations("list worker channel peers");
        const peers: ProductChannelPeer[] = discovered.map((peer) => ({
          platform: connection.platform,
          conversationId: peer.chatId,
          threadId: peer.threadId,
          senderId: peer.senderId,
          conversationType: peer.chatType,
          discoveredSessionId: peer.sessionId,
          discoveredAt: peer.discoveredAt,
          bound: peer.bound,
        }));
        return { peers };
      }),
    approveWorkerChannelPairing: (workerId, pairingInput) =>
      withExternalOperation("approve worker channel pairing", async () => {
        const current = await loadState();
        const worker = requireWorker(current, workerId);
        const connection = requireChannelConnection(
          current,
          workerId,
          pairingInput.connectionId,
        );
        if (
          connection.status !== "connecting" &&
          connection.status !== "connected"
        ) {
          throw new Error(
            "Connect the channel before approving a pairing code.",
          );
        }
        if (!workerExecutor.approveChannelPairing) {
          throw new Error("Channel pairing approval is not available.");
        }
        const approved = await workerExecutor.approveChannelPairing({
          workerAgentReference: worker.config.hermesAgentReference,
          platform: connection.platform,
          code: pairingInput.code,
        });
        assertStoreAcceptingOperations("approve worker channel pairing");
        const approvedUserId = approved.userId.trim();
        const state = await updateState((draft) => {
          assertStoreAcceptingOperations("approve worker channel pairing");
          return {
            ...draft,
            workers: draft.workers.map((item) => {
              if (item.id !== workerId) {
                return item;
              }
              const channel = normalizePersistedProductWorkerChannel(
                item.config.channel,
              );
              return {
                ...item,
                activities: [
                  `Approved ${connection.platform} access for ${approved.userName || approvedUserId}`,
                  ...item.activities,
                ].slice(0, 12),
                config: {
                  ...item.config,
                  channel: {
                    ...channel,
                    allowedUsers: Array.from(
                      new Set([...channel.allowedUsers, approvedUserId]),
                    ),
                  },
                },
              };
            }),
          };
        });
        return {
          state,
          connection,
          approval: {
            platform: connection.platform,
            userId: approvedUserId,
            userName: approved.userName?.trim() || null,
          },
        };
      }),
    bindWorkerChannel: (workerId, bindInput) =>
      withExternalOperation("bind worker channel", async () => {
        const current = await loadState();
        const worker = requireWorker(current, workerId);
        const connection = requireChannelConnection(
          current,
          workerId,
          bindInput.connectionId,
        );
        if (
          connection.status !== "connecting" &&
          connection.status !== "connected"
        ) {
          throw new Error("Connect and verify the channel before binding it.");
        }
        if (bindInput.deliveryConfirmed !== true) {
          throw new Error("Confirm that the reply arrived before binding.");
        }
        if (!workerExecutor.bindChannelConversation) {
          throw new Error(
            "Channel session binding is not available in this runtime.",
          );
        }
        const targetRun = resolveWorkerBindingRun(
          current,
          workerId,
          bindInput.hermesSessionId,
        );
        const bindingThreadId = productChannelBindingThreadId({
          conversationType: bindInput.conversationType,
          threadId: bindInput.threadId,
        });
        const route = await workerExecutor.bindChannelConversation({
          workerAgentReference: worker.config.hermesAgentReference,
          platform: connection.platform,
          chatId: bindInput.conversationId,
          threadId: bindingThreadId,
          sessionId: targetRun.hermesSessionId!,
          connectionId: connection.id,
        });
        assertStoreAcceptingOperations("bind worker channel");
        const now = new Date().toISOString();
        const bindingId = channelBindingId(
          connection.id,
          route.chatId,
          route.threadId,
        );
        const existing = current.channelBindings.find(
          (item) => item.id === bindingId,
        );
        const binding: ProductChannelBinding = {
          id: bindingId,
          connectionId: connection.id,
          workerId,
          platform: connection.platform,
          conversationId: route.chatId,
          threadId: route.threadId,
          conversationLabel: bindInput.conversationLabel?.trim() || null,
          hermesProfile: worker.config.hermesAgentReference,
          hermesSessionId: route.sessionId,
          status: "bound",
          lastError: null,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };
        const verifiedConnection: ProductChannelConnection = {
          ...connection,
          status: "connected",
          lastCheckedAt: now,
          lastConnectedAt: now,
          lastError: null,
          updatedAt: now,
        };
        const state = await updateState((draft) => {
          assertStoreAcceptingOperations("bind worker channel");
          return {
            ...draft,
            channelConnections: upsertById(
              draft.channelConnections,
              verifiedConnection,
            ),
            channelBindings: upsertById(
              draft.channelBindings.filter(
                (item) =>
                  item.id === binding.id ||
                  item.connectionId !== connection.id ||
                  item.conversationId !== route.chatId,
              ),
              binding,
            ),
            workers: draft.workers.map((item) =>
              item.id === workerId
                ? {
                    ...item,
                    config: {
                      ...item.config,
                      channel: {
                        ...normalizePersistedProductWorkerChannel(
                          item.config.channel,
                        ),
                        platform: connection.platform,
                        label: connection.label,
                        status: "connected" as const,
                        lastTestedAt: now,
                        lastError: null,
                      },
                    },
                  }
                : item,
            ),
          };
        });
        return { state, connection: verifiedConnection, binding };
      }),
    installWorkflow: (installInput) =>
      withExternalOperation("install workflow", async () => {
        const current = await loadState();
        assertStoreAcceptingOperations("install workflow");
        const currentWorker = requireWorker(current, installInput.workerId);
        const authoritativeWorkflow = requireWorkflow(
          current,
          installInput.workflowId,
        );
        const requiresCanonicalGraph = workflowRequiresCanonicalGraph(
          authoritativeWorkflow,
        );
        const sourceSkillPath = await selectWorkflowSourcePath(
          [authoritativeWorkflow.artifactPath],
          requiresCanonicalGraph,
        );
        await logWorkflowInstallDiagnostic("deploy.requested", {
          workerId: installInput.workerId,
          workflowId: installInput.workflowId,
          workflowStatus: authoritativeWorkflow.status,
          requestSkillPath: installInput.skillPath ?? null,
          authoritativeArtifactPath: authoritativeWorkflow.artifactPath ?? null,
          selectedSourceSkillPath: sourceSkillPath,
          requiresCanonicalGraph,
          source: await inspectWorkflowSourcePath(sourceSkillPath),
        });
        try {
          await requireCanonicalWorkflowSource(
            authoritativeWorkflow,
            sourceSkillPath,
          );
        } catch (error) {
          await logWorkflowInstallDiagnostic("deploy.rejected", {
            workerId: installInput.workerId,
            workflowId: installInput.workflowId,
            selectedSourceSkillPath: sourceSkillPath,
            reason: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
        const hermesAgent = await workerExecutor.provisionAgent({
          workerId: currentWorker.id,
          workerName: currentWorker.name,
        });
        await assertStoreOpenAfterWorkerReference(
          hermesAgent.agentReference,
          "install workflow",
        );
        let hermesSkill: WorkerExecutorSkill;
        try {
          hermesSkill = await workerExecutor.installSkill({
            workflowId: authoritativeWorkflow.id,
            workflowTitle: authoritativeWorkflow.title,
            description: authoritativeWorkflow.description,
            apps: authoritativeWorkflow.apps,
            workerAgentReference: hermesAgent.agentReference,
            sourceSkillPath,
          });
          await assertStoreOpenAfterWorkerReference(
            hermesAgent.agentReference,
            "install workflow",
          );
          requireCanonicalWorkflowInstall(
            authoritativeWorkflow,
            sourceSkillPath,
            hermesSkill,
          );
        } catch (error) {
          await logWorkflowInstallDiagnostic("deploy.failed", {
            workerId: installInput.workerId,
            workflowId: installInput.workflowId,
            selectedSourceSkillPath: sourceSkillPath,
            reason: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
        await logWorkflowInstallDiagnostic("deploy.materialized", {
          workerId: installInput.workerId,
          workflowId: installInput.workflowId,
          requestSkillPath: installInput.skillPath ?? null,
          selectedSourceSkillPath: sourceSkillPath,
          installedSkillPath: hermesSkill.skillPath,
          workflowGraphPath: hermesSkill.workflowGraphPath ?? null,
          workflowMarkdownPath: hermesSkill.workflowMarkdownPath ?? null,
          workflowRevisionId: hermesSkill.workflowRevisionId ?? null,
        });
        await assertStoreOpenAfterWorkerReference(
          hermesAgent.agentReference,
          "install workflow",
        );
        let installedWorkflow: ProductInstalledWorkflow | null = null;
        const state = await updateState((draft) => {
          assertStoreAcceptingOperations("install workflow");
          const worker = requireWorker(draft, installInput.workerId);
          const currentWorkflow = requireWorkflow(
            draft,
            authoritativeWorkflow.id,
          );
          if (
            workflowAuthorityFingerprint(currentWorkflow) !==
            workflowAuthorityFingerprint(authoritativeWorkflow)
          ) {
            throw new Error(
              `Workflow changed during deployment: ${authoritativeWorkflow.id}. Retry with the latest workflow state.`,
            );
          }
          const deployTargetDeviceId =
            installInput.deployTargetDeviceId ?? worker.deviceId;
          const existing = draft.installedWorkflows.find(
            (workflow) =>
              workflow.workerId === worker.id &&
              workflow.workflowId === authoritativeWorkflow.id,
          );
          const installedAt = new Date().toISOString();
          const workflow: ProductInstalledWorkflow = {
            id: existing?.id ?? createProductEntityId("installed"),
            workerId: worker.id,
            workflowId: authoritativeWorkflow.id,
            workflowTitle: authoritativeWorkflow.title,
            description: authoritativeWorkflow.description,
            status: "Enabled",
            apps: dedupe(authoritativeWorkflow.apps),
            installedAt: existing?.installedAt ?? installedAt,
            deployTargetDeviceId,
            approvalPolicy: "allow_all",
            hermesSkillReference: hermesSkill.skillReference,
            hermesInstallReference: hermesSkill.installReference,
            hermesSkillName: hermesSkill.skillName,
            hermesSkillPath: hermesSkill.skillPath,
            sourceSkillPath,
            sourceWorkflowRevisionId: hermesSkill.workflowRevisionId ?? null,
            baselineRuns: existing?.baselineRuns ?? 0,
            baselineSuccesses: existing?.baselineSuccesses ?? 0,
            baselineLastRun: existing?.baselineLastRun ?? "Not run yet",
            updateAvailable: false,
          };
          installedWorkflow = workflow;
          draft.installedWorkflows = existing
            ? draft.installedWorkflows.map((item) =>
                item.id === existing.id ? workflow : item,
              )
            : [workflow, ...draft.installedWorkflows];
          draft.approvalPolicies = upsertApprovalPolicy(
            draft.approvalPolicies,
            {
              id: approvalPolicyIdForInstalledWorkflow(workflow.id),
              scopeType: "installed_workflow",
              scopeId: workflow.id,
              mode: "allow_all",
              description:
                "Installed workflow can proceed under allow_all; progress appears in run events.",
              updatedAt: installedAt,
            },
          );
          draft.workers = draft.workers.map((item) =>
            item.id === worker.id
              ? {
                  ...item,
                  selectedInstalledWorkflowId: workflow.id,
                  config: {
                    ...item.config,
                    hermesAgentReference: hermesAgent.agentReference,
                  },
                  status: "No active task",
                  tone: "idle",
                  heartbeat: "Workflow ready to start",
                  activities: [
                    `${workflow.workflowTitle} installed`,
                    "AI worker profile synced",
                    START_WORKER_PREPARATION_MESSAGE,
                  ],
                }
              : item,
          );
          return draft;
        });

        return {
          state,
          installedWorkflow: installedWorkflow!,
        };
      }),
    deleteWorkflow: async (deleteInput) => {
      let tombstone: ProductWorkflowTombstone | null = null;
      const workflowId = deleteInput.workflowId.trim();
      if (!workflowId) {
        throw new Error("Workflow id is required.");
      }

      const state = await updateState((draft) => {
        const workflow = requireWorkflow(draft, workflowId);
        const now = new Date().toISOString();
        const removedAssignments = draft.installedWorkflows.filter(
          (item) => item.workflowId === workflow.id,
        );
        const removedAssignmentIds = new Set(
          removedAssignments.map((assignment) => assignment.id),
        );
        const activeRun = draft.runs.find(
          (run) =>
            removedAssignmentIds.has(run.installedWorkflowId) &&
            isOpenRunStatus(run.status),
        );
        if (activeRun) {
          throw new Error(
            "Stop every active run for this workflow before deleting it. / 请先停止此工作流的所有活动运行，再执行删除。",
          );
        }
        tombstone = {
          workflowId: workflow.id,
          workflowTitle: workflow.title,
          deletedAt: now,
          deletedByAccountId: draft.account.id,
        };
        draft.workflowTombstones = [
          tombstone,
          ...draft.workflowTombstones.filter(
            (item) => item.workflowId !== workflow.id,
          ),
        ];
        const removedAssignmentByWorkerId = new Map(
          removedAssignments.map((assignment) => [
            assignment.workerId,
            assignment,
          ]),
        );
        draft.installedWorkflows = draft.installedWorkflows.filter(
          (item) => !removedAssignmentIds.has(item.id),
        );
        draft.approvalPolicies = draft.approvalPolicies.filter(
          (policy) =>
            policy.scopeType !== "installed_workflow" ||
            !removedAssignmentIds.has(policy.scopeId),
        );
        draft.workers = draft.workers.map((worker) => {
          const removedAssignment = removedAssignmentByWorkerId.get(worker.id);
          if (!removedAssignment) {
            return worker;
          }
          return {
            ...worker,
            selectedInstalledWorkflowId:
              worker.selectedInstalledWorkflowId === removedAssignment.id
                ? null
                : worker.selectedInstalledWorkflowId,
            status: worker.deviceId ? "No active task" : "Needs device",
            tone: worker.deviceId ? "idle" : "warning",
            heartbeat: "Installed workflow removed",
            activities: [
              `${workflow.title} removed`,
              "Run history preserved",
              START_WORKER_PREPARATION_MESSAGE,
            ],
          };
        });
        return draft;
      });

      return {
        state,
        tombstone: tombstone!,
      };
    },
    toggleInstalledWorkflow: async (installedWorkflowId, status) =>
      updateState((draft) => {
        if (
          !draft.installedWorkflows.some(
            (workflow) => workflow.id === installedWorkflowId,
          )
        ) {
          throw new Error(`Unknown installed workflow: ${installedWorkflowId}`);
        }
        return {
          ...draft,
          installedWorkflows: draft.installedWorkflows.map((workflow) =>
            workflow.id === installedWorkflowId
              ? { ...workflow, status }
              : workflow,
          ),
        };
      }),
    deleteInstalledWorkflow: async (installedWorkflowId) => {
      let deletedWorkflow: ProductInstalledWorkflow | null = null;
      const state = await updateState((draft) => {
        const workflow = draft.installedWorkflows.find(
          (item) => item.id === installedWorkflowId,
        );
        if (!workflow) {
          throw new Error(`Unknown installed workflow: ${installedWorkflowId}`);
        }
        const activeRun = draft.runs.find(
          (run) =>
            run.installedWorkflowId === workflow.id &&
            isOpenRunStatus(run.status),
        );
        if (activeRun) {
          throw new Error(
            "Stop the running workflow before removing this installed workflow.",
          );
        }

        deletedWorkflow = workflow;
        draft.installedWorkflows = draft.installedWorkflows.filter(
          (item) => item.id !== workflow.id,
        );
        draft.approvalPolicies = draft.approvalPolicies.filter(
          (policy) =>
            policy.id !== approvalPolicyIdForInstalledWorkflow(workflow.id),
        );
        draft.workers = draft.workers.map((worker) =>
          worker.id === workflow.workerId
            ? {
                ...worker,
                selectedInstalledWorkflowId:
                  worker.selectedInstalledWorkflowId === workflow.id
                    ? null
                    : worker.selectedInstalledWorkflowId,
                status: worker.deviceId ? "No active task" : "Needs device",
                tone: worker.deviceId ? "idle" : "warning",
                heartbeat: "Installed workflow removed",
                activities: [
                  `${workflow.workflowTitle} removed`,
                  "Run history preserved",
                  START_WORKER_PREPARATION_MESSAGE,
                ],
              }
            : worker,
        );
        return draft;
      });

      return {
        state,
        installedWorkflow: deletedWorkflow!,
      };
    },
    startWorker: (workerId) =>
      withExternalOperation("start worker", async () => {
        const current = await loadState();
        assertStoreAcceptingOperations("start worker");
        const currentWorker = requireWorker(current, workerId);
        const currentWorkflow = findWorkerSessionWorkflow(
          current,
          currentWorker,
        );
        if (currentWorkflow) {
          requireInstalledWorkflowReadyForRun(currentWorkflow);
        }
        requireNoActiveRun(current, currentWorker.id);
        requireWorkerDeviceReady(current, currentWorker);
        if (currentWorkflow) {
          requireDeployTargetReady(current, currentWorker, currentWorkflow);
        }
        const authoritativeWorkflow = currentWorkflow
          ? current.workflows.find(
              (workflow) => workflow.id === currentWorkflow.workflowId,
            )
          : undefined;
        let sourceSkillPath: string | null = null;
        if (currentWorkflow) {
          sourceSkillPath = await selectWorkflowSourcePath(
            [
              currentWorkflow.sourceSkillPath ===
              currentWorkflow.hermesSkillPath
                ? null
                : currentWorkflow.sourceSkillPath,
              authoritativeWorkflow?.artifactPath,
            ],
            workflowRequiresCanonicalGraph(authoritativeWorkflow),
          );
          await requireCanonicalWorkflowSource(
            authoritativeWorkflow,
            sourceSkillPath,
          );
          await logWorkflowInstallDiagnostic("start.refresh_requested", {
            workerId: currentWorker.id,
            workflowId: currentWorkflow.workflowId,
            sourceSkillPath,
            installedSkillPath: currentWorkflow.hermesSkillPath,
            source: await inspectWorkflowSourcePath(sourceSkillPath),
          });
        }
        assertStoreAcceptingOperations("start worker");
        const workerAgent = await workerExecutor.provisionAgent({
          workerId: currentWorker.id,
          workerName: currentWorker.name,
        });
        await assertStoreOpenAfterWorkerReference(
          workerAgent.agentReference,
          "start worker",
        );
        let workerSkill: WorkerExecutorSkill | null = null;
        if (currentWorkflow && sourceSkillPath) {
          workerSkill = await workerExecutor.installSkill({
            workflowId: currentWorkflow.workflowId,
            workflowTitle: currentWorkflow.workflowTitle,
            description: currentWorkflow.description,
            apps: currentWorkflow.apps,
            workerAgentReference: workerAgent.agentReference,
            sourceSkillPath,
          });
          await assertStoreOpenAfterWorkerReference(
            workerAgent.agentReference,
            "start worker",
          );
          requireCanonicalWorkflowInstall(
            authoritativeWorkflow,
            sourceSkillPath,
            workerSkill,
          );
          await logWorkflowInstallDiagnostic("start.refresh_materialized", {
            workerId: currentWorker.id,
            workflowId: currentWorkflow.workflowId,
            sourceSkillPath,
            installedSkillPath: workerSkill.skillPath,
            workflowGraphPath: workerSkill.workflowGraphPath ?? null,
            workflowRevisionId: workerSkill.workflowRevisionId ?? null,
          });
        }
        await assertStoreOpenAfterWorkerReference(
          workerAgent.agentReference,
          "start worker",
        );
        let run: ProductRun | null = null;
        const prepared = await updateState((draft) => {
          assertStoreAcceptingOperations("start worker");
          const worker = requireWorker(draft, workerId);
          const installedWorkflow = currentWorkflow
            ? requireInstalledWorkflow(draft, currentWorkflow.id)
            : null;
          requireWorkerDeviceReady(draft, worker);
          if (installedWorkflow) {
            requireInstalledWorkflowReadyForRun(installedWorkflow);
          }
          requireNoActiveRun(draft, worker.id);
          if (installedWorkflow && workerSkill && sourceSkillPath) {
            requireDeployTargetReady(draft, worker, installedWorkflow);
            draft.installedWorkflows = draft.installedWorkflows.map(
              (workflow) =>
                workflow.id === installedWorkflow.id
                  ? {
                      ...workflow,
                      hermesSkillReference: workerSkill.skillReference,
                      hermesInstallReference: workerSkill.installReference,
                      hermesSkillName: workerSkill.skillName,
                      hermesSkillPath: workerSkill.skillPath,
                      sourceSkillPath,
                      sourceWorkflowRevisionId:
                        workerSkill.workflowRevisionId ?? null,
                    }
                  : workflow,
            );
          }
          const now = new Date().toISOString();
          run = {
            id: createProductEntityId("run"),
            workerId: worker.id,
            installedWorkflowId:
              installedWorkflow?.id ?? GENERAL_WORKER_SESSION_ID,
            workflowTitle:
              installedWorkflow?.workflowTitle ?? GENERAL_WORKER_SESSION_TITLE,
            kind: "worker_session",
            status: "running",
            command: null,
            startedAt: now,
            endedAt: null,
            hermesSessionId: null,
            errorMessage: null,
          };
          draft.runs = [run, ...draft.runs];
          draft.runEvents = [
            productEvent({
              runId: run.id,
              workerId: worker.id,
              source: "system",
              status: "Initializing",
              body: `${worker.name} is starting an AI worker session.`,
            }),
            ...draft.runEvents,
          ];
          draft.workers = draft.workers.map((item) =>
            item.id === worker.id
              ? {
                  ...item,
                  selectedInstalledWorkflowId:
                    installedWorkflow?.id ?? item.selectedInstalledWorkflowId,
                  config: {
                    ...item.config,
                    hermesAgentReference: workerAgent.agentReference,
                  },
                  status: "Working",
                  tone: "working",
                  heartbeat: "AI worker initializing",
                  activities: [
                    "AI worker session starting",
                    "Agent panel will show the ready message",
                    "Run events are live",
                  ],
                }
              : item,
          );
          return draft;
        });
        await assertStoreOpenAfterWorkerReference(
          workerAgent.agentReference,
          "start worker",
        );

        const preparedRun = run!;
        const preparedWorker = requireWorker(prepared, preparedRun.workerId);
        const preparedWorkflow = installedWorkflowForRun(prepared, preparedRun);
        const workerSignals = createWorkerSignalCallbacks(preparedRun.id);
        let handle: WorkerExecutorTurnHandle | null = null;
        try {
          handle = await workerExecutor.startTurn({
            cwd: input.runtimeConfig.projectRootDir,
            runId: preparedRun.id,
            integrationUserId: composioUserIdForState(
              prepared,
              database.installationId,
            ),
            workerAgentReference: preparedWorker.config.hermesAgentReference,
            skills: preparedWorkflow ? [preparedWorkflow.hermesSkillName] : [],
            maxTurns: HERMES_WORKER_COMMAND_MAX_TURNS,
            prompt: buildInitializeWorkerPrompt(
              preparedWorker,
              preparedWorkflow,
            ),
            onOutput: workerSignals.onOutput,
            onProgress: workerSignals.onProgress,
          });
        } catch (error) {
          workerSignals.close();
          clearWorkerSignalState(preparedRun.id);
          if (shutdownRequested) {
            await stopWorkerReferenceWithinShutdown(
              preparedWorker.config.hermesAgentReference,
            );
            throw storeShutdownError("start worker");
          }
          const failed = await applyHermesStartResult(
            preparedRun.id,
            failedWorkerExecutorResult(error),
          );
          return {
            state: failed,
            worker: requireWorker(failed, workerId),
          };
        }

        if (shutdownRequested) {
          return rejectLateHermesHandle(
            preparedRun.id,
            handle,
            preparedWorker.config.hermesAgentReference,
            "start worker",
            workerSignals.close,
          );
        }

        trackHermesRun(preparedRun.id, handle, {
          readyOkEventStatus: "AI worker ready",
          completionOkFallbackStatus: "running",
          completionOkEventStatus: "AI worker ready",
          okHeartbeat: "AI worker ready",
          releaseWorkerSignals: workerSignals.close,
        });
        const readyResult = await settleWithin(handle.ready, 750);
        if (shutdownRequested) {
          await stopWorkerReferenceWithinShutdown(
            preparedWorker.config.hermesAgentReference,
          );
          throw storeShutdownError("start worker");
        }
        const finished = readyResult
          ? await applyHermesStartResult(
              preparedRun.id,
              readyResult,
              "running",
              "AI worker ready",
              "AI worker ready",
            )
          : await loadState();

        return {
          state: finished,
          worker: requireWorker(finished, workerId),
        };
      }),
    runInstalledWorkflow: (installedWorkflowId) =>
      withExternalOperation("run installed workflow", async () => {
        const current = await loadState();
        assertStoreAcceptingOperations("run installed workflow");
        const currentWorkflow = requireInstalledWorkflow(
          current,
          installedWorkflowId,
        );
        const currentWorker = requireWorker(current, currentWorkflow.workerId);
        requireInstalledWorkflowReadyForRun(currentWorkflow);
        requireNoActiveRun(current, currentWorker.id);
        requireDeployTargetReady(current, currentWorker, currentWorkflow);
        const authoritativeWorkflow = current.workflows.find(
          (workflow) => workflow.id === currentWorkflow.workflowId,
        );
        const sourceSkillPath = await selectWorkflowSourcePath(
          [
            currentWorkflow.sourceSkillPath === currentWorkflow.hermesSkillPath
              ? null
              : currentWorkflow.sourceSkillPath,
            authoritativeWorkflow?.artifactPath,
          ],
          workflowRequiresCanonicalGraph(authoritativeWorkflow),
        );
        try {
          await requireCanonicalWorkflowSource(
            authoritativeWorkflow,
            sourceSkillPath,
          );
        } catch (error) {
          await logWorkflowInstallDiagnostic("run.refresh_rejected", {
            workerId: currentWorker.id,
            workflowId: currentWorkflow.workflowId,
            installedWorkflowId,
            sourceSkillPath,
            reason: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
        await logWorkflowInstallDiagnostic("run.refresh_requested", {
          workerId: currentWorker.id,
          workflowId: currentWorkflow.workflowId,
          installedWorkflowId,
          sourceSkillPath,
          installedSkillPath: currentWorkflow.hermesSkillPath,
          source: await inspectWorkflowSourcePath(sourceSkillPath),
        });
        assertStoreAcceptingOperations("run installed workflow");
        const workerAgent = await workerExecutor.provisionAgent({
          workerId: currentWorker.id,
          workerName: currentWorker.name,
        });
        await assertStoreOpenAfterWorkerReference(
          workerAgent.agentReference,
          "run installed workflow",
        );
        const workerSkill = await workerExecutor.installSkill({
          workflowId: currentWorkflow.workflowId,
          workflowTitle: currentWorkflow.workflowTitle,
          description: currentWorkflow.description,
          apps: currentWorkflow.apps,
          workerAgentReference: workerAgent.agentReference,
          sourceSkillPath,
        });
        await assertStoreOpenAfterWorkerReference(
          workerAgent.agentReference,
          "run installed workflow",
        );
        requireCanonicalWorkflowInstall(
          authoritativeWorkflow,
          sourceSkillPath,
          workerSkill,
        );
        await logWorkflowInstallDiagnostic("run.refresh_materialized", {
          workerId: currentWorker.id,
          workflowId: currentWorkflow.workflowId,
          installedWorkflowId,
          sourceSkillPath,
          installedSkillPath: workerSkill.skillPath,
          workflowGraphPath: workerSkill.workflowGraphPath ?? null,
          workflowMarkdownPath: workerSkill.workflowMarkdownPath ?? null,
          workflowRevisionId: workerSkill.workflowRevisionId ?? null,
        });
        await assertStoreOpenAfterWorkerReference(
          workerAgent.agentReference,
          "run installed workflow",
        );
        let run: ProductRun | null = null;
        const prepared = await updateState((draft) => {
          assertStoreAcceptingOperations("run installed workflow");
          const installedWorkflow = requireInstalledWorkflow(
            draft,
            installedWorkflowId,
          );
          const worker = requireWorker(draft, installedWorkflow.workerId);
          requireInstalledWorkflowReadyForRun(installedWorkflow);
          requireNoActiveRun(draft, worker.id);
          requireDeployTargetReady(draft, worker, installedWorkflow);
          draft.installedWorkflows = draft.installedWorkflows.map((workflow) =>
            workflow.id === installedWorkflow.id
              ? {
                  ...workflow,
                  hermesSkillReference: workerSkill.skillReference,
                  hermesInstallReference: workerSkill.installReference,
                  hermesSkillName: workerSkill.skillName,
                  hermesSkillPath: workerSkill.skillPath,
                  sourceSkillPath,
                  sourceWorkflowRevisionId:
                    workerSkill.workflowRevisionId ?? null,
                }
              : workflow,
          );
          const now = new Date().toISOString();
          run = {
            id: createProductEntityId("run"),
            workerId: worker.id,
            installedWorkflowId: installedWorkflow.id,
            workflowTitle: installedWorkflow.workflowTitle,
            kind: "workflow",
            status: "running",
            command: null,
            startedAt: now,
            endedAt: null,
            hermesSessionId: null,
            errorMessage: null,
          };
          draft.runs = [run, ...draft.runs];
          draft.runEvents = [
            productEvent({
              runId: run.id,
              workerId: worker.id,
              source: "system",
              status: "Initialized",
              body: `${worker.name} initialized for ${installedWorkflow.workflowTitle}.`,
            }),
            ...draft.runEvents,
          ];
          draft.workers = draft.workers.map((item) =>
            item.id === worker.id
              ? {
                  ...item,
                  selectedInstalledWorkflowId: installedWorkflow.id,
                  config: {
                    ...item.config,
                    hermesAgentReference: workerAgent.agentReference,
                  },
                  status: "Working",
                  tone: "working",
                  heartbeat: "AI worker initializing",
                  activities: [
                    `${installedWorkflow.workflowTitle} starting`,
                    "AI worker requested",
                    "Run events are live",
                  ],
                }
              : item,
          );
          return draft;
        });
        await assertStoreOpenAfterWorkerReference(
          workerAgent.agentReference,
          "run installed workflow",
        );

        const preparedRun = run!;
        const preparedWorker = requireWorker(prepared, preparedRun.workerId);
        const preparedWorkflow = requireInstalledWorkflow(
          prepared,
          preparedRun.installedWorkflowId,
        );
        const workerSignals = createWorkerSignalCallbacks(preparedRun.id);
        let handle: WorkerExecutorTurnHandle | null = null;
        try {
          handle = await workerExecutor.startTurn({
            cwd: input.runtimeConfig.projectRootDir,
            runId: preparedRun.id,
            integrationUserId: composioUserIdForState(
              prepared,
              database.installationId,
            ),
            workerAgentReference: preparedWorker.config.hermesAgentReference,
            skills: [preparedWorkflow.hermesSkillName],
            maxTurns: HERMES_WORKER_COMMAND_MAX_TURNS,
            prompt: buildStartWorkerPrompt(preparedWorker, preparedWorkflow),
            onOutput: workerSignals.onOutput,
            onProgress: workerSignals.onProgress,
          });
        } catch (error) {
          workerSignals.close();
          clearWorkerSignalState(preparedRun.id);
          if (shutdownRequested) {
            await stopWorkerReferenceWithinShutdown(
              preparedWorker.config.hermesAgentReference,
            );
            throw storeShutdownError("run installed workflow");
          }
          const failed = await applyHermesStartResult(
            preparedRun.id,
            failedWorkerExecutorResult(error),
          );
          return {
            state: failed,
            run: failed.runs.find((item) => item.id === preparedRun.id)!,
          };
        }

        if (shutdownRequested) {
          return rejectLateHermesHandle(
            preparedRun.id,
            handle,
            preparedWorker.config.hermesAgentReference,
            "run installed workflow",
            workerSignals.close,
          );
        }

        trackHermesRun(preparedRun.id, handle, {
          releaseWorkerSignals: workerSignals.close,
        });
        const readyResult = await settleWithin(handle.ready, 750);
        if (shutdownRequested) {
          await stopWorkerReferenceWithinShutdown(
            preparedWorker.config.hermesAgentReference,
          );
          throw storeShutdownError("run installed workflow");
        }
        const finished = readyResult
          ? await applyHermesStartResult(preparedRun.id, readyResult)
          : await loadState();

        return {
          state: finished,
          run: finished.runs.find((item) => item.id === preparedRun.id)!,
        };
      }),
    stopWorker: async (workerId) => {
      const current = await loadState();
      const currentWorker = requireWorker(current, workerId);
      const currentActiveRun = current.runs.find(
        (run) => run.workerId === workerId && isOpenRunStatus(run.status),
      );
      if (currentActiveRun) {
        manuallyStoppingHermesRuns.add(currentActiveRun.id);
      }
      const stoppedTrackedHermesProcess = currentActiveRun
        ? stopActiveHermesHandles(currentActiveRun.id)
        : false;
      const stoppedPersistedHermesProcess =
        (await stopWorkerExecutorProcesses(
          currentWorker.config.hermesAgentReference,
        )) ?? false;
      const stoppedHermesProcess =
        stoppedTrackedHermesProcess || stoppedPersistedHermesProcess;
      const stopStateUpdate = updateState((draft) => {
        const now = new Date().toISOString();
        const activeRun = draft.runs.find(
          (run) => run.workerId === workerId && isOpenRunStatus(run.status),
        );
        if (activeRun) {
          draft.runs = draft.runs.map((run) =>
            run.id === activeRun.id
              ? { ...run, status: "paused", endedAt: now }
              : run,
          );
          draft.runEvents = [
            productEvent({
              runId: activeRun.id,
              workerId,
              source: "system",
              status: "Paused",
              body: stoppedHermesProcess
                ? "Worker stopped by Alex. AI worker process terminated."
                : "Worker stopped by Alex.",
            }),
            ...draft.runEvents,
          ];
        }
        draft.workers = draft.workers.map((worker) =>
          worker.id === workerId
            ? {
                ...worker,
                status: "No active task",
                tone: "idle",
                heartbeat: "AI worker stopped",
                activities: [
                  "AI worker session stopped",
                  "No active workflow running",
                  START_WORKER_PREPARATION_MESSAGE,
                ],
              }
            : worker,
        );
        return draft;
      });
      return stopStateUpdate.finally(() => {
        if (currentActiveRun) {
          manuallyStoppingHermesRuns.delete(currentActiveRun.id);
        }
      });
    },
    sendCommand: (workerId, command) =>
      withExternalOperation("send worker command", async () => {
        let commandEvent: ProductRunEvent | null = null;
        let commandRecord: ProductCommand | null = null;
        let run: ProductRun | null = null;
        const accepted = await updateState((draft) => {
          assertStoreAcceptingOperations("send worker command");
          const worker = requireWorker(draft, workerId);
          run =
            draft.runs.find(
              (item) =>
                item.workerId === worker.id && isOpenRunStatus(item.status),
            ) ?? null;
          if (!run) {
            throw new Error("Start worker before sending worker commands.");
          }
          if (!run.hermesSessionId) {
            throw new Error(
              "AI worker is still initializing. Wait for the Agent panel ready message before sending commands.",
            );
          }
          draft.runs = draft.runs.map((item) =>
            item.id === run!.id
              ? { ...item, command, status: "running", endedAt: null }
              : item,
          );
          commandRecord = {
            id: createProductEntityId("command"),
            runId: run.id,
            workerId: worker.id,
            command,
            source: "agent_chat",
            status: "accepted",
            createdAt: new Date().toISOString(),
            errorMessage: null,
          };
          commandEvent = productEvent({
            runId: run.id,
            workerId: worker.id,
            source: "user",
            status: "Command",
            body: command,
          });
          const generalSession =
            run.installedWorkflowId === GENERAL_WORKER_SESSION_ID;
          const workflowEvent = productEvent({
            runId: run.id,
            workerId: worker.id,
            source: "executor",
            status: generalSession ? "AI worker session" : "Workflow selected",
            body: generalSession
              ? "Using the general AI worker session. Sending the command with allow_all policy."
              : `Using ${run.workflowTitle}. Sending the command to the AI worker with allow_all policy.`,
          });
          draft.commands = [commandRecord, ...draft.commands];
          draft.runEvents = [workflowEvent, commandEvent, ...draft.runEvents];
          return draft;
        });
        assertStoreAcceptingOperations("send worker command");
        const activeRun = run!;
        const worker = requireWorker(accepted, activeRun.workerId);
        const installedWorkflow = installedWorkflowForRun(accepted, activeRun);
        observeWorkerAgentReference(worker.config.hermesAgentReference);
        const workerSignals = createWorkerSignalCallbacks(activeRun.id);
        let commandHandle: WorkerExecutorTurnHandle | null = null;
        try {
          commandHandle = await workerExecutor.startTurn({
            cwd: input.runtimeConfig.projectRootDir,
            runId: activeRun.id,
            integrationUserId: composioUserIdForState(
              accepted,
              database.installationId,
            ),
            workerAgentReference: worker.config.hermesAgentReference,
            skills: installedWorkflow
              ? [installedWorkflow.hermesSkillName]
              : [],
            resumeSessionId: activeRun.hermesSessionId,
            maxTurns: HERMES_WORKER_COMMAND_MAX_TURNS,
            prompt: buildWorkerCommandPrompt({
              worker,
              installedWorkflow,
              command,
            }),
            onOutput: workerSignals.onOutput,
            onProgress: workerSignals.onProgress,
          });
        } catch (error) {
          workerSignals.close();
          clearWorkerSignalState(activeRun.id);
          if (shutdownRequested) {
            await stopWorkerReferenceWithinShutdown(
              worker.config.hermesAgentReference,
            );
            throw storeShutdownError("send worker command");
          }
          const failed = await applyHermesCommandResult(
            activeRun.id,
            failedWorkerExecutorResult(error),
          );
          return {
            state: failed,
            run: failed.runs.find((item) => item.id === activeRun.id)!,
            event: commandEvent!,
            commandRecord: commandRecord!,
          };
        }
        if (shutdownRequested) {
          return rejectLateHermesHandle(
            activeRun.id,
            commandHandle,
            worker.config.hermesAgentReference,
            "send worker command",
            workerSignals.close,
          );
        }
        trackHermesCommand(activeRun.id, commandHandle, workerSignals.close);
        return {
          state: accepted,
          run: accepted.runs.find((item) => item.id === activeRun.id)!,
          event: commandEvent!,
          commandRecord: commandRecord!,
        };
      }),
  };
}

async function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | null> {
  let timeout: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolveTimeout) => {
        timeout = setTimeout(() => resolveTimeout(null), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function failedWorkerExecutorResult(error: unknown): WorkerExecutorRunResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    sessionId: null,
    sessionStatus: null,
    sessionStatusMessage: null,
    userAction: null,
    output: message,
    errorMessage: message,
  };
}

async function readLegacyState(path: string): Promise<ProductState | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as ProductState;
  } catch {
    return null;
  }
}

function migratePureDemoSeedToEmpty(state: ProductState): ProductState {
  const demoSeed = seedProductState("demo");
  if (demoStateFingerprint(state) !== demoStateFingerprint(demoSeed)) {
    return state;
  }
  const emptyState = seedProductState("empty");
  return {
    ...emptyState,
    permissionSnapshot: state.permissionSnapshot ?? null,
    hermes: state.hermes ?? emptyState.hermes,
    capabilityProviders:
      state.capabilityProviders ?? emptyState.capabilityProviders,
  };
}

function demoStateFingerprint(state: ProductState): string {
  return createHash("sha256")
    .update(JSON.stringify(demoStateCanonicalValue(state)))
    .digest("hex");
}

function demoStateCanonicalValue(state: ProductState): Record<string, unknown> {
  const byId = <T extends { id: string }>(items: T[] | undefined): T[] =>
    [...(items ?? [])].sort((left, right) => left.id.localeCompare(right.id));
  const canonical = {
    account: {
      id: state.account.id,
      name: state.account.name,
      email: state.account.email,
      workspaceId: state.account.workspaceId,
      signedInLabel: state.account.signedInLabel,
      cloudProvider: state.account.cloudProvider ?? null,
      cloudUserId: state.account.cloudUserId ?? null,
      setupCompleted: state.account.setupCompleted,
    },
    workspace: state.workspace,
    devices: byId(state.devices).map((device) => ({
      id: device.id,
      name: device.name,
      status: device.status,
      owner: device.owner,
      assignedWorkerId: device.assignedWorkerId,
      heartbeat: device.heartbeat,
      location: device.location,
      runtimeVersion: device.runtimeVersion,
      queue: device.queue,
    })),
    workers: byId(state.workers).map((worker) => ({
      id: worker.id,
      name: worker.name,
      initials: worker.initials,
      description: worker.description,
      status: worker.status,
      tone: worker.tone,
      avatarKey: worker.avatarKey,
      deviceId: worker.deviceId,
      selectedInstalledWorkflowId: worker.selectedInstalledWorkflowId,
      heartbeat: worker.heartbeat,
      activities: worker.activities,
      config: {
        identityScope: worker.config.identityScope,
        runtimeProfile: worker.config.runtimeProfile,
        toolAccess: worker.config.toolAccess,
        memoryContext: worker.config.memoryContext,
        approvalPolicy: worker.config.approvalPolicy,
        heartbeatPolicy: worker.config.heartbeatPolicy,
        hermesAgentReference: worker.config.hermesAgentReference,
        channel: {
          platform: worker.config.channel.platform,
          label: worker.config.channel.label,
          accessMode: worker.config.channel.accessMode,
          homeChannel: worker.config.channel.homeChannel,
          allowedUsers: worker.config.channel.allowedUsers,
          configuredFields: worker.config.channel.configuredFields,
          missingFields: worker.config.channel.missingFields,
          status: worker.config.channel.status,
          lastTestedAt: worker.config.channel.lastTestedAt,
          lastError: worker.config.channel.lastError,
        },
      },
    })),
    workflows: byId(state.workflows).map((workflow) => ({
      id: workflow.id,
      title: workflow.title,
      description: workflow.description,
      status: workflow.status,
      sourceType: workflow.sourceType,
      sourceText: workflow.sourceText ?? null,
      confidence: workflow.confidence,
      apps: workflow.apps,
      stats: workflow.stats,
      detectedAt: workflow.detectedAt,
      artifactPath: workflow.artifactPath ?? null,
    })),
    installedWorkflows: byId(state.installedWorkflows).map((workflow) => ({
      id: workflow.id,
      workerId: workflow.workerId,
      workflowId: workflow.workflowId,
      workflowTitle: workflow.workflowTitle,
      description: workflow.description,
      status: workflow.status,
      apps: workflow.apps,
      deployTargetDeviceId: workflow.deployTargetDeviceId,
      approvalPolicy: workflow.approvalPolicy,
      sourceSkillPath: workflow.sourceSkillPath ?? null,
      sourceWorkflowRevisionId: workflow.sourceWorkflowRevisionId ?? null,
      baselineRuns: workflow.baselineRuns,
      baselineSuccesses: workflow.baselineSuccesses,
      baselineLastRun: workflow.baselineLastRun,
      updateAvailable: Boolean(workflow.updateAvailable),
    })),
    runs: byId(state.runs).map((run) => ({
      id: run.id,
      workerId: run.workerId,
      installedWorkflowId: run.installedWorkflowId,
      workflowTitle: run.workflowTitle,
      kind: run.kind ?? "workflow",
      status: run.status,
      command: run.command,
      hermesSessionId: run.hermesSessionId,
      errorMessage: run.errorMessage,
    })),
    captureSessions: byId(state.captureSessions),
    artifacts: byId(state.artifacts),
    channelConnections: byId(state.channelConnections),
    channelSetups: byId(state.channelSetups),
    channelBindings: byId(state.channelBindings),
    runEvents: byId(state.runEvents),
    commands: byId(state.commands),
    approvalPolicies: byId(state.approvalPolicies).map((policy) => ({
      id: policy.id,
      scopeType: policy.scopeType,
      scopeId: policy.scopeId,
      mode: policy.mode,
      description: policy.description,
    })),
    workflowTombstones: [...(state.workflowTombstones ?? [])].sort(
      (left, right) => left.workflowId.localeCompare(right.workflowId),
    ),
    pendingCloudUpserts: byId(
      (state.pendingCloudUpserts ?? []).map((item) => ({
        ...item,
        id: `${item.entityType}:${item.entityId}`,
      })),
    ),
    pendingCloudDeletes: byId(
      (state.pendingCloudDeletes ?? []).map((item) => ({
        ...item,
        id: `${item.entityType}:${item.entityId}`,
      })),
    ),
  };
  return canonical;
}

/**
 * EN: Returns whether this generated workflow must carry its canonical graph.
 * 中文: 判断生成型 runtime workflow 是否必须携带 canonical graph。
 * @param workflow product workflow metadata, when available.
 * @returns true when graphless installation would lose execution semantics.
 */
function workflowRequiresCanonicalGraph(
  workflow: ProductWorkflow | undefined,
): boolean {
  return workflow?.status === "Generated" && workflow.sourceType === "runtime";
}

/**
 * EN: Checks for the canonical workflow.json beside a source skill.
 * 中文: 检查 source skill 同目录是否存在 canonical workflow.json。
 * @param sourceSkillPath candidate skill source path.
 * @returns true only when the graph is a readable file.
 */
async function workflowSourceHasGraph(
  sourceSkillPath: string | null | undefined,
): Promise<boolean> {
  if (!sourceSkillPath) {
    return false;
  }
  try {
    const graphStat = await stat(
      resolve(dirname(sourceSkillPath), "workflow.json"),
    );
    return graphStat.isFile();
  } catch {
    return false;
  }
}

/**
 * EN: Selects a readable source while preferring a complete graph package.
 * 中文: 从候选路径中选择可读 source，并在需要时优先选择完整 graph 包。
 * @param candidates ordered source paths from product state and the request.
 * @param requireGraph whether a sibling workflow.json is mandatory.
 * @returns selected source path or null when none is readable.
 */
async function selectWorkflowSourcePath(
  candidates: Array<string | null | undefined>,
  requireGraph: boolean,
): Promise<string | null> {
  let firstReadable: string | null = null;
  for (const candidate of dedupe(
    candidates.filter((item): item is string => Boolean(item?.trim())),
  )) {
    try {
      const sourceStat = await stat(candidate);
      if (!sourceStat.isFile()) {
        continue;
      }
    } catch {
      continue;
    }
    firstReadable ??= candidate;
    if (!requireGraph || (await workflowSourceHasGraph(candidate))) {
      return candidate;
    }
  }
  return firstReadable;
}

function incompleteWorkflowPackageError(
  workflowId: string,
  sourceSkillPath: string | null,
): Error {
  return new Error(
    `Generated workflow package is incomplete for ${workflowId}: workflow.json is missing beside ${sourceSkillPath ?? "the source skill"}. Regenerate or sync the canonical package before deployment. / 生成的工作流包不完整：缺少 workflow.json，请重新生成或同步完整包后再部署。`,
  );
}

async function requireCanonicalWorkflowSource(
  workflow: ProductWorkflow | undefined,
  sourceSkillPath: string | null,
): Promise<void> {
  if (
    workflowRequiresCanonicalGraph(workflow) &&
    !(await workflowSourceHasGraph(sourceSkillPath))
  ) {
    throw incompleteWorkflowPackageError(workflow!.id, sourceSkillPath);
  }
}

function requireCanonicalWorkflowInstall(
  workflow: ProductWorkflow | undefined,
  sourceSkillPath: string | null,
  installedSkill: WorkerExecutorSkill,
): void {
  if (
    workflowRequiresCanonicalGraph(workflow) &&
    (!installedSkill.workflowGraphPath || !installedSkill.workflowRevisionId)
  ) {
    throw incompleteWorkflowPackageError(workflow!.id, sourceSkillPath);
  }
}

async function materializeWorkerSkills(
  state: ProductState,
  options: {
    force?: boolean;
    workerExecutor: WorkerExecutor;
  },
): Promise<ProductState> {
  const installedWorkflows = await Promise.all(
    state.installedWorkflows.map(async (workflow) => {
      const worker = state.workers.find(
        (item) => item.id === workflow.workerId,
      );
      const productWorkflow = state.workflows.find(
        (item) => item.id === workflow.workflowId,
      );
      const sourceSkillPath = await selectWorkflowSourcePath(
        [
          workflow.sourceSkillPath === workflow.hermesSkillPath
            ? null
            : workflow.sourceSkillPath,
          productWorkflow?.artifactPath,
        ],
        workflowRequiresCanonicalGraph(productWorkflow),
      );
      if (
        workflow.hermesSkillPath &&
        !options.force &&
        isManagedHermesSkillPath(
          workflow,
          worker,
          options.workerExecutor.skillScope,
        )
      ) {
        return {
          ...workflow,
          sourceSkillPath,
        };
      }
      if (
        workflowRequiresCanonicalGraph(productWorkflow) &&
        !(await workflowSourceHasGraph(sourceSkillPath))
      ) {
        return {
          ...workflow,
          sourceSkillPath,
        };
      }
      const hermesSkill = await options.workerExecutor.installSkill({
        workflowId: workflow.workflowId,
        workflowTitle: workflow.workflowTitle,
        description: workflow.description,
        apps: workflow.apps,
        workerAgentReference:
          worker?.config.hermesAgentReference ??
          `hermes-agent:${workflow.workerId}`,
        sourceSkillPath,
      });
      return {
        ...workflow,
        hermesSkillReference: hermesSkill.skillReference,
        hermesInstallReference: hermesSkill.installReference,
        hermesSkillName: hermesSkill.skillName,
        hermesSkillPath: hermesSkill.skillPath,
        sourceSkillPath,
        sourceWorkflowRevisionId: hermesSkill.workflowRevisionId ?? null,
      };
    }),
  );
  return {
    ...state,
    installedWorkflows,
  };
}

function isManagedHermesSkillPath(
  workflow: ProductInstalledWorkflow,
  worker: ProductWorker | undefined,
  skillScope?: WorkerExecutorSkillScope,
): boolean {
  const profileReference =
    worker?.config.hermesAgentReference ?? `hermes-agent:${workflow.workerId}`;
  if (!profileReference.startsWith("hermes-profile:")) {
    return false;
  }
  const profilesRoot =
    skillScope?.profilesRoot ??
    (skillScope?.runtimeHome
      ? resolve(skillScope.runtimeHome, "profiles")
      : null);
  if (!profilesRoot) {
    return false;
  }
  const profileName = profileReference.replace(/^hermes-profile:/u, "");
  const managedRoot = resolve(profilesRoot, profileName, "skills");
  const normalizedPath = resolve(workflow.hermesSkillPath);
  return (
    normalizedPath === managedRoot ||
    normalizedPath.startsWith(`${managedRoot}/`)
  );
}

async function mergeWorkerExecutorStatus(
  previous: ProductHermesStatus,
  workerExecutor: WorkerExecutor,
): Promise<ProductHermesStatus> {
  const probed = await workerExecutor.probeStatus();
  return {
    ...previous,
    ...probed,
    lastProbeSessionId:
      probed.lastProbeSessionId ?? previous.lastProbeSessionId,
    providerHealth: normalizeHermesProviderHealth(
      probed.providerHealth ?? previous.providerHealth,
    ),
  };
}

/**
 * CN: 完成 Product 层的合并状态编排：目标置顶，来源卡片隐藏，录制与产物保持不变。
 * EN: Finalizes Product merge state by promoting the target and hiding only the source card.
 * @param input mutable state snapshot, source/target identities and completion timestamp.
 * @returns next Product state.
 */
export function finalizeProductWorkflowMergeState(input: {
  draft: ProductState;
  sourceWorkflow: ProductWorkflow;
  targetWorkflowId: string;
  updatedAt: string;
}): ProductState {
  const targetWorkflow = input.draft.workflows.find(
    (workflow) => workflow.id === input.targetWorkflowId,
  );
  if (!targetWorkflow) {
    throw new Error(
      `Unknown target workflow: ${input.targetWorkflowId}. / 找不到目标工作流：${input.targetWorkflowId}。`,
    );
  }
  const sourceIsTarget = input.sourceWorkflow.id === input.targetWorkflowId;
  const updatedTarget = { ...targetWorkflow, updatedAt: input.updatedAt };
  return {
    ...input.draft,
    workflows: [
      updatedTarget,
      ...input.draft.workflows.filter(
        (workflow) =>
          workflow.id !== input.targetWorkflowId &&
          (sourceIsTarget || workflow.id !== input.sourceWorkflow.id),
      ),
    ],
    workflowTombstones: sourceIsTarget
      ? input.draft.workflowTombstones
      : [
          {
            workflowId: input.sourceWorkflow.id,
            workflowTitle: input.sourceWorkflow.title,
            deletedAt: input.updatedAt,
            deletedByAccountId: input.draft.account.id,
          },
          ...input.draft.workflowTombstones.filter(
            (item) => item.workflowId !== input.sourceWorkflow.id,
          ),
        ],
  };
}

/**
 * CN: 从 Product workflow 的主产物路径解析 canonical workflow.json。
 * EN: Resolves canonical workflow.json from the Product workflow's primary artifact path.
 * @param workflow Product workflow with an artifact package.
 * @returns absolute canonical graph path.
 */
function requireProductWorkflowGraphPath(workflow: ProductWorkflow): string {
  if (!workflow.artifactPath) {
    throw new Error(
      `Workflow ${workflow.id} has no artifact package. / 工作流 ${workflow.id} 没有产物包。`,
    );
  }
  return resolveProductWorkflowSiblingArtifactPath(
    workflow.artifactPath,
    WORKFLOW_GRAPH_FILE_NAME,
  );
}

async function materializeLabSessions(
  state: ProductState,
  sessions: LabSession[],
): Promise<ProductState> {
  const materialized = await Promise.all(
    sessions.filter(isProductVisibleLabSession).map(async (session, index) => {
      const artifacts = await artifactRecordsForLabSession(session);
      const workflow = workflowFromLabSession(session, index);
      const existingWorkflow = state.workflows.find(
        (item) => item.id === workflow.id,
      );
      return {
        captureSession: captureSessionFromLabSession(session, artifacts),
        workflow:
          existingWorkflow &&
          existingWorkflow.updatedAt.localeCompare(workflow.updatedAt) > 0
            ? { ...workflow, updatedAt: existingWorkflow.updatedAt }
            : workflow,
        artifacts,
      };
    }),
  );
  const runtimeWorkflowIds = new Set(
    materialized.map(({ workflow }) => workflow.id),
  );
  const captureSessionIds = new Set(
    materialized.map(({ captureSession }) => captureSession.id),
  );
  const refreshedExisting = await Promise.all(
    state.captureSessions
      .filter((session) => !captureSessionIds.has(session.id))
      .map(async (session) => {
        const artifacts = await Promise.all(
          state.artifacts
            .filter((artifact) => artifact.captureSessionId === session.id)
            .map(refreshProductArtifact),
        );
        return {
          captureSession: {
            ...session,
            artifactMissing: artifacts.some(
              (artifact) => artifact.status === "missing",
            ),
            updatedAt: new Date().toISOString(),
          },
          artifacts,
        };
      }),
  );

  return {
    ...state,
    workflows: [
      ...materialized.map(({ workflow }) => workflow),
      ...state.workflows.filter(
        (workflow) => !runtimeWorkflowIds.has(workflow.id),
      ),
    ].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    captureSessions: [
      ...materialized.map(({ captureSession }) => captureSession),
      ...refreshedExisting.map(({ captureSession }) => captureSession),
    ],
    artifacts: [
      ...materialized.flatMap(({ artifacts }) => artifacts),
      ...refreshedExisting.flatMap(({ artifacts }) => artifacts),
      ...state.artifacts.filter((artifact) => {
        if (captureSessionIds.has(artifact.captureSessionId)) {
          return false;
        }
        return !refreshedExisting.some(
          ({ captureSession }) =>
            captureSession.id === artifact.captureSessionId,
        );
      }),
    ],
  };
}

function isProductVisibleLabSession(session: LabSession): boolean {
  return Boolean(session.ingest.summary) || isRecordingLikeLabSession(session);
}

function captureSessionFromLabSession(
  session: LabSession,
  artifacts: ProductArtifact[],
): ProductCaptureSession {
  const skill = selectLabSkill(session);
  return {
    id: `capture-${session.sessionId}`,
    labSessionId: session.sessionId,
    sessionPath: session.paths.sessionPath,
    artifactRoot: session.paths.sessionDir,
    status: captureStatusFromLabSession(session, skill),
    title: titleFromLabSession(session, skill),
    latestRunId: session.ingest.latestRunId,
    latestRunDir: session.ingest.latestRunDir,
    ingestSummaryPath: session.ingest.summaryPath,
    workflowDiscoveryPath: session.workflowDiscovery.latestPath,
    selectedWorkflowId: session.selection.workflowId,
    skillPath:
      session.skillExtraction.skillPath ??
      session.skillExtraction.artifacts[0]?.skillPath ??
      null,
    stats: statsFromLabSession(session, skill),
    artifactMissing: artifacts.some(
      (artifact) => artifact.status === "missing",
    ),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function workflowFromLabSession(
  session: LabSession,
  index: number,
): ProductWorkflow {
  const skill = selectLabSkill(session);
  const candidate = selectLabCandidate(session);
  const now = new Date().toISOString();
  return {
    id: `runtime-${session.sessionId}`,
    title: titleFromLabSession(session, skill),
    description: descriptionFromLabSession(session, skill, candidate),
    status: workflowStatusFromLabSession(session, skill),
    sourceType: "runtime",
    confidence: normalizeLabConfidence(candidate?.confidence),
    apps: skill ? appsFromLabSkill(skill) : [],
    stats: statsFromLabSession(session, skill),
    detectedAt: detectedAtFromLabSession(session, index),
    artifactPath:
      session.skillExtraction.skillPath ??
      session.skillExtraction.artifacts[0]?.skillPath ??
      session.workflowDiscovery.latestPath ??
      session.ingest.summaryPath ??
      session.paths.sessionPath,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt || now,
  };
}

async function artifactRecordsForLabSession(
  session: LabSession,
): Promise<ProductArtifact[]> {
  const captureSessionId = `capture-${session.sessionId}`;
  const graphOutputs = [
    session.skillExtraction.summary?.output,
    ...session.skillExtraction.artifacts.map(
      (artifact) => artifact.summary?.output,
    ),
    session.plannerOptimization.summary?.output,
    ...session.generalization.artifacts.flatMap((artifact) =>
      artifact.summary.variants.map((variant) => variant.output),
    ),
  ];
  const workflowLearningOutputs = [
    session.skillExtraction.summary?.output,
    ...session.skillExtraction.artifacts.map(
      (artifact) => artifact.summary?.output,
    ),
  ];
  const candidates: Array<{
    kind: ProductArtifact["kind"];
    path: string | null;
  }> = [
    { kind: "session", path: session.paths.sessionPath },
    { kind: "ingest-summary", path: session.ingest.summaryPath },
    { kind: "workflow-discovery", path: session.workflowDiscovery.latestPath },
    { kind: "skill", path: session.skillExtraction.skillPath },
    { kind: "skill-summary", path: session.skillExtraction.summaryPath },
    { kind: "planner-skill", path: session.plannerOptimization.skillPath },
    { kind: "planner-summary", path: session.plannerOptimization.summaryPath },
    ...session.skillExtraction.artifacts.flatMap((artifact) => [
      { kind: "skill" as const, path: artifact.skillPath },
      { kind: "skill-summary" as const, path: artifact.summaryPath },
    ]),
    ...workflowLearningOutputs.flatMap((output) => [
      {
        kind: "workflow-candidate" as const,
        path: output?.workflowCandidatePath ?? null,
      },
      {
        kind: "workflow-family-match" as const,
        path: output?.workflowFamilyMatchPath ?? null,
      },
      {
        kind: "workflow-merge-proposal" as const,
        path: output?.workflowMergeProposalPath ?? null,
      },
    ]),
    ...graphOutputs.flatMap((output) => [
      {
        kind: "workflow-graph" as const,
        path: output?.workflowGraphPath ?? null,
      },
      {
        kind: "workflow-markdown" as const,
        path: output?.workflowMarkdownPath ?? null,
      },
      {
        kind: "workflow-revisions" as const,
        path: output?.workflowRevisionsDir ?? null,
      },
    ]),
  ];
  const records = await Promise.all(
    candidates.map((candidate) =>
      artifactRecordForPath({
        captureSessionId,
        labSessionId: session.sessionId,
        kind: candidate.kind,
        path: candidate.path,
        updatedAt: session.updatedAt,
      }),
    ),
  );
  const byId = new Map<string, ProductArtifact>();
  records.forEach((record) => {
    if (record) {
      byId.set(record.id, record);
    }
  });
  return Array.from(byId.values());
}

async function artifactRecordForPath(input: {
  captureSessionId: string;
  labSessionId: string;
  kind: ProductArtifact["kind"];
  path: string | null;
  updatedAt: string;
}): Promise<ProductArtifact | null> {
  if (!input.path) {
    return null;
  }
  const pathStat = await stat(input.path).catch(() => null);
  return {
    id: `artifact-${input.labSessionId}-${input.kind}-${stablePathKey(input.path)}`,
    captureSessionId: input.captureSessionId,
    kind: input.kind,
    path: input.path,
    status: pathStat ? "available" : "missing",
    sizeBytes: pathStat?.size ?? null,
    updatedAt: input.updatedAt,
  };
}

async function refreshProductArtifact(
  artifact: ProductArtifact,
): Promise<ProductArtifact> {
  const pathStat = await stat(artifact.path).catch(() => null);
  return {
    ...artifact,
    status: pathStat ? "available" : "missing",
    sizeBytes: pathStat?.size ?? null,
    updatedAt: new Date().toISOString(),
  };
}

function stablePathKey(path: string): string {
  return Buffer.from(path).toString("base64url").slice(0, 48);
}

function selectLabSkill(session: LabSession): OpenClawSkill | null {
  return (
    session.skillExtraction.artifacts.find(
      (artifact) => artifact.workflowId === session.selection.workflowId,
    )?.skill ??
    session.skillExtraction.artifacts[0]?.skill ??
    session.skillExtraction.skill ??
    null
  );
}

function selectLabCandidate(session: LabSession) {
  const selectedId = session.selection.workflowId;
  return (
    session.workflowDiscovery.workflowCandidates.find(
      (candidate) => candidate.workflowId === selectedId,
    ) ??
    session.workflowDiscovery.workflowCandidates[0] ??
    null
  );
}

function captureStatusFromLabSession(
  session: LabSession,
  skill: OpenClawSkill | null,
): ProductCaptureSession["status"] {
  if (session.status === "failed") {
    return "failed";
  }
  if (session.status === "interrupted") {
    return "interrupted";
  }
  if (isRecordingLikeLabSession(session)) {
    return "recording";
  }
  return skill ? "generated" : "captured";
}

function workflowStatusFromLabSession(
  session: LabSession,
  skill: OpenClawSkill | null,
): ProductWorkflow["status"] {
  if (session.status === "failed" || session.status === "interrupted") {
    return "Needs review";
  }
  return skill ? "Generated" : "Captured";
}

function isRecordingLikeLabSession(session: LabSession): boolean {
  return (
    session.status === "recording" ||
    session.status === "starting" ||
    session.status === "stopping" ||
    session.status === "ingesting" ||
    session.status === "booting-query-mode"
  );
}

function titleFromLabSession(
  session: LabSession,
  skill: OpenClawSkill | null,
): string {
  return (
    skill?.skillName ||
    selectLabCandidate(session)?.name ||
    session.sessionName?.trim() ||
    (isRecordingLikeLabSession(session)
      ? "Active training capture"
      : "Captured training session")
  );
}

function descriptionFromLabSession(
  session: LabSession,
  skill: OpenClawSkill | null,
  candidate: ReturnType<typeof selectLabCandidate>,
): string {
  if (session.error?.message) {
    return session.error.message;
  }
  if (skill) {
    return (
      candidate?.description ||
      skill.shortDescription ||
      skill.description ||
      "Workflow draft is ready for review."
    );
  }
  if (!session.ingest.summary) {
    return "The capture is not ready for review yet.";
  }
  return "Capture is ready. Analyze it to build an editable workflow.";
}

function statsFromLabSession(
  session: LabSession,
  skill: OpenClawSkill | null,
): ProductWorkflow["stats"] {
  const summary = session.ingest.summary;
  return {
    uiEvents: summary?.fetch.rawUiEventsCount ?? 0,
    ocrObservations: summary?.fetch.rawOcrCount ?? 0,
    voiceNotes: summary?.fetch.rawAudioCount ?? 0,
    duration: formatDuration(
      summary?.timeWindow.observed.durationMs ??
        summary?.timeWindow.requested.durationMs ??
        durationBetween(
          session.recordingWindow.startedAt,
          session.recordingWindow.requestedStopAt ??
            session.screenpipe.recording.stoppedAt,
        ),
    ),
    decisionPoints: skill ? estimateLabDecisionPoints(skill) : 0,
  };
}

function appsFromLabSkill(skill: OpenClawSkill): string[] {
  return dedupe([
    ...skill.evidence.appsSeen,
    ...skill.steps.map((step) => step.operationApp).filter(Boolean),
  ]).slice(0, 8);
}

function estimateLabDecisionPoints(skill: OpenClawSkill): number {
  return skill.steps.filter((step) => {
    const text = `${step.instruction} ${step.intent} ${step.hints.join(
      " ",
    )}`.toLowerCase();
    return (
      text.includes("decide") ||
      text.includes("judge") ||
      text.includes("check") ||
      text.includes("determine") ||
      text.includes("validate") ||
      text.includes("confirm") ||
      text.includes("approval")
    );
  }).length;
}

function detectedAtFromLabSession(session: LabSession, index: number): string {
  const timestamp =
    session.recordingWindow.requestedStopAt ??
    session.screenpipe.recording.stoppedAt ??
    session.recordingWindow.startedAt ??
    session.createdAt;
  return `Captured on ${timestamp || `session ${index + 1}`}`;
}

function normalizeLabConfidence(value: number | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const normalized = value <= 1 ? value * 100 : value;
  return Math.max(0, Math.min(100, Math.round(normalized)));
}

function durationBetween(
  startTimestamp: string | null,
  endTimestamp: string | null,
): number | null {
  if (!startTimestamp || !endTimestamp) {
    return null;
  }
  const start = Date.parse(startTimestamp);
  const end = Date.parse(endTimestamp);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return null;
  }
  return end - start;
}

function formatDuration(durationMs: number | null | undefined): string {
  if (!durationMs || durationMs <= 0) {
    return "--";
  }
  const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function normalizeState(state: ProductState): ProductState {
  const now = new Date().toISOString();
  const normalizedRuns = (state.runs ?? []).map(normalizeProductRunState);
  const channelSetups = state.channelSetups ?? [];
  const normalizedWorkers = (state.workers ?? []).map((worker) =>
    normalizeStaleQrChannelState(
      normalizeProductWorkerState(worker, normalizedRuns),
      channelSetups,
    ),
  );
  const workersById = new Map(
    normalizedWorkers.map((worker) => [worker.id, worker]),
  );
  const normalized: ProductState = {
    ...state,
    schemaVersion: 1,
    account: {
      ...state.account,
      cloudSyncRevision: state.account.cloudSyncRevision ?? -1,
      setupCompleted: state.account.setupCompleted ?? true,
      updatedAt: state.account.updatedAt ?? now,
    },
    updatedAt: now,
    permissionSnapshot: state.permissionSnapshot ?? null,
    devices: state.devices ?? [],
    workflows: state.workflows ?? [],
    captureSessions: state.captureSessions ?? [],
    artifacts: state.artifacts ?? [],
    channelConnections: state.channelConnections ?? [],
    channelSetups,
    channelBindings: state.channelBindings ?? [],
    workers: normalizedWorkers,
    installedWorkflows: (state.installedWorkflows ?? []).map((workflow) =>
      normalizeInstalledWorkflowState(workflow, workersById),
    ),
    runs: normalizedRuns,
    runEvents: state.runEvents ?? [],
    commands: state.commands ?? [],
    workflowTombstones: state.workflowTombstones ?? [],
    pendingCloudUpserts: retainWorkerCloudMutations(state.pendingCloudUpserts),
    pendingCloudDeletes: retainWorkerCloudMutations(state.pendingCloudDeletes),
    approvalPolicies: [],
    hermes: {
      command: state.hermes?.command ?? "hermes",
      available: state.hermes?.available ?? false,
      model: state.hermes?.model ?? null,
      provider: state.hermes?.provider ?? null,
      providerHealth: normalizeHermesProviderHealth(
        state.hermes?.providerHealth,
      ),
      enabledToolsets: state.hermes?.enabledToolsets ?? [],
      missingComputerUseToolsets:
        state.hermes?.missingComputerUseToolsets ?? [],
      computerUseReady: state.hermes?.computerUseReady ?? false,
      computerUseSummary: state.hermes?.computerUseSummary ?? null,
      configSource: state.hermes?.configSource ?? null,
      configPath: state.hermes?.configPath ?? null,
      runtimeHome: state.hermes?.runtimeHome ?? null,
      lastCheckedAt: state.hermes?.lastCheckedAt ?? null,
      lastProbeSessionId: state.hermes?.lastProbeSessionId ?? null,
      lastError: state.hermes?.lastError ?? null,
    },
    capabilityProviders: normalizeCapabilityProviders(
      state.capabilityProviders ?? [],
    ),
  };
  return retainProductStateHistory({
    ...normalized,
    approvalPolicies: normalizeApprovalPolicies(
      normalized,
      state.approvalPolicies ?? [],
    ),
  });
}

/**
 * EN: Removes legacy workflow cloud mutations without reallocating clean arrays.
 * 中文: 清除旧版 workflow 云 mutation，同时避免为已干净数组重复分配内存。
 * @param items persisted cloud mutation records.
 * @returns the original worker-only array, or a filtered compatibility copy.
 */
function retainWorkerCloudMutations<T extends { entityType: unknown }>(
  items: T[] | undefined,
): T[] {
  const normalized = items ?? [];
  return normalized.some((item) => String(item.entityType) !== "worker")
    ? normalized.filter((item) => String(item.entityType) === "worker")
    : normalized;
}

function normalizeCapabilityProviders(
  providers: ProductCapabilityProvider[],
): ProductCapabilityProvider[] {
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  return defaultCapabilityProviders().map((defaultProvider) => {
    const existing = byId.get(defaultProvider.id);
    if (!existing) {
      return defaultProvider;
    }
    return {
      ...defaultProvider,
      ...existing,
      id: defaultProvider.id,
      kind: defaultProvider.kind,
      label: defaultProvider.label,
      description: defaultProvider.description,
      required: defaultProvider.required,
      pinnedVersion: defaultProvider.pinnedVersion,
      enabled: existing.enabled ?? defaultProvider.enabled,
      status: existing.status ?? defaultProvider.status,
      installed: existing.installed ?? defaultProvider.installed,
      version: existing.version ?? null,
      commandPath: existing.commandPath ?? null,
      lastCheckedAt: existing.lastCheckedAt ?? null,
      lastError: existing.lastError ?? null,
      lastSuccessAt: existing.lastSuccessAt ?? null,
      detail: existing.detail ?? defaultProvider.detail,
    };
  });
}

function mergeCapabilityProviderSnapshots(
  currentProviders: ProductCapabilityProvider[],
  snapshots: ProductCapabilityProvider[],
): ProductCapabilityProvider[] {
  const snapshotsById = new Map(
    snapshots.map((provider) => [provider.id, provider]),
  );
  return normalizeCapabilityProviders(currentProviders).map((provider) => {
    const snapshot = snapshotsById.get(provider.id);
    if (!snapshot) {
      return provider;
    }
    if (provider.status === "ready" || provider.status === "unavailable") {
      return {
        ...snapshot,
        status: provider.status,
        lastCheckedAt: provider.lastCheckedAt,
        lastError: provider.lastError,
        lastSuccessAt: provider.lastSuccessAt,
        detail: provider.detail,
      };
    }
    return snapshot;
  });
}

function markCapabilityProviderChecking(
  providers: ProductCapabilityProvider[],
  providerId: ProductCapabilityProviderId,
): ProductCapabilityProvider[] {
  return normalizeCapabilityProviders(providers).map((provider) =>
    provider.id === providerId
      ? {
          ...provider,
          status: "checking",
          detail:
            provider.id === "chrome"
              ? "Checking Chrome from this device..."
              : "Checking Composio cloud access...",
          lastError: null,
        }
      : provider,
  );
}

function upsertCapabilityProvider(
  providers: ProductCapabilityProvider[],
  provider: ProductCapabilityProvider,
): ProductCapabilityProvider[] {
  return normalizeCapabilityProviders(providers).map((item) =>
    item.id === provider.id ? provider : item,
  );
}

function composioUserIdForState(
  state: ProductState,
  installationId: string,
): string {
  const localNamespace = installationAccountNamespace(
    installationId,
    `${state.workspace.id}:${state.account.id}`,
  );
  return productComposioUserId({
    workspaceId: localNamespace,
    accountId: state.account.id,
    cloudUserId: state.account.cloudUserId,
  });
}

function normalizeProductRunState(run: ProductRun): ProductRun {
  return {
    ...run,
    kind: run.kind ?? "workflow",
  };
}

function normalizeProductWorkerState(
  worker: ProductWorker,
  runs: ProductRun[],
): ProductWorker {
  const withHermesReference = normalizeWorkerHermesReference(worker);
  const activeRun = runs.find(
    (run) => run.workerId === worker.id && isOpenRunStatus(run.status),
  );
  if (activeRun) {
    return {
      ...withHermesReference,
      status: workerStatusFromRunStatus(activeRun.status, runKind(activeRun)),
      tone: workerToneFromRunStatus(activeRun.status, runKind(activeRun)),
    };
  }
  if (
    withHermesReference.deviceId &&
    (withHermesReference.status === "Available" ||
      withHermesReference.status === "Working" ||
      withHermesReference.status === "Training")
  ) {
    return {
      ...withHermesReference,
      status: "No active task",
      tone: "idle",
      heartbeat: normalizeIdleWorkerHeartbeat(withHermesReference.heartbeat),
      activities: normalizeIdleWorkerActivities(withHermesReference.activities),
    };
  }
  if (withHermesReference.status === "No active task") {
    return {
      ...withHermesReference,
      tone: "idle",
      heartbeat: normalizeIdleWorkerHeartbeat(withHermesReference.heartbeat),
    };
  }
  return {
    ...withHermesReference,
    tone:
      withHermesReference.status === "Blocked"
        ? "danger"
        : withHermesReference.status === "Waiting for user" ||
            withHermesReference.status === "Setup needed" ||
            withHermesReference.status === "Needs device"
          ? "warning"
          : withHermesReference.tone,
  };
}

/**
 * EN: Recovers QR channels left in testing after their setup was cancelled or lost.
 * 中文: 恢复因二维码连接被取消或丢失而残留在 testing 状态的渠道。
 * @param worker normalized product worker.
 * @param setups persisted channel setup records.
 * @returns worker with a truthful non-loading channel state.
 */
function normalizeStaleQrChannelState(
  worker: ProductWorker,
  setups: ProductChannelSetup[],
): ProductWorker {
  const channel = normalizePersistedProductWorkerChannel(worker.config.channel);
  if (
    channel.status !== "testing" ||
    (channel.platform !== "weixin" && channel.platform !== "whatsapp")
  ) {
    return worker;
  }
  const matchingSetups = setups
    .filter(
      (setup) =>
        setup.workerId === worker.id && setup.platform === channel.platform,
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const activeSetup = matchingSetups.find((setup) =>
    ["starting", "installing", "awaiting_scan", "authorizing"].includes(
      setup.status,
    ),
  );
  if (activeSetup) {
    return worker;
  }
  const latestSetup = matchingSetups[0];
  const failed = latestSetup?.status === "failed";
  return {
    ...worker,
    config: {
      ...worker.config,
      channel: {
        ...channel,
        configuredFields: [],
        missingFields: ["QR_LINK"],
        status: failed ? "failed" : "not_configured",
        lastTestedAt: latestSetup?.updatedAt ?? channel.lastTestedAt,
        lastError: failed ? latestSetup.lastError : null,
      },
    },
  };
}

function normalizeIdleWorkerHeartbeat(heartbeat: string): string {
  if (
    /^(AI worker ready|AI worker working|Ready for next command|Recently active)$/iu.test(
      heartbeat.trim(),
    )
  ) {
    return START_WORKER_PREPARATION_MESSAGE;
  }
  return heartbeat;
}

function normalizeIdleWorkerActivities(activities: string[]): string[] {
  const normalized = activities.map((activity) =>
    /start worker to initialize hermes/iu.test(activity)
      ? START_WORKER_PREPARATION_MESSAGE
      : activity,
  );
  if (normalized.includes(START_WORKER_PREPARATION_MESSAGE)) {
    return normalized;
  }
  return [
    ...normalized.filter(
      (activity) => !/ready for next command|recently active/iu.test(activity),
    ),
    START_WORKER_PREPARATION_MESSAGE,
  ];
}

function normalizeInstalledWorkflowState(
  workflow: ProductInstalledWorkflow,
  workersById: Map<string, ProductWorker>,
): ProductInstalledWorkflow {
  const status: ProductInstalledWorkflowStatus =
    workflow.status === "Enabled" ? "Enabled" : "Paused";
  const base = {
    ...workflow,
    status,
    hermesSkillReference:
      workflow.hermesSkillReference ??
      `hermes-skill:${defaultHermesSkillName(workflow.workflowTitle)}`,
    hermesInstallReference:
      workflow.hermesInstallReference ??
      defaultHermesInstallReference(workflow, workersById),
    hermesSkillName:
      workflow.hermesSkillName ??
      defaultHermesSkillName(workflow.workflowTitle),
    hermesSkillPath:
      workflow.hermesSkillPath ??
      defaultHermesSkillPath(workflow.workflowTitle),
    sourceSkillPath: workflow.sourceSkillPath ?? null,
    sourceWorkflowRevisionId: workflow.sourceWorkflowRevisionId ?? null,
  };
  if (workflow.id.startsWith("installed-sales-library-")) {
    return {
      ...base,
      baselineRuns: 0,
      baselineSuccesses: 0,
      baselineLastRun: "Not run yet",
    };
  }
  return base;
}

function repairStaleRuntimeState(state: ProductState): ProductState {
  const staleRuns = state.runs.filter(isUnrecoverableActiveRun);
  const staleCapabilityProviderIds = new Set(
    state.capabilityProviders
      .filter((provider) => provider.status === "checking")
      .map((provider) => provider.id),
  );
  const activeWorkerIds = new Set(
    state.runs
      .filter((run) => isOpenRunStatus(run.status))
      .map((run) => run.workerId),
  );
  const orphanWorkingWorkers = state.workers.filter(
    (worker) => worker.status === "Working" && !activeWorkerIds.has(worker.id),
  );

  if (
    staleRuns.length === 0 &&
    orphanWorkingWorkers.length === 0 &&
    staleCapabilityProviderIds.size === 0
  ) {
    return state;
  }

  const now = new Date().toISOString();
  const staleRunIds = new Set(staleRuns.map((run) => run.id));
  const staleWorkerIds = new Set(staleRuns.map((run) => run.workerId));
  const recoveryEvents = staleRuns.map((run) =>
    recoveryEventForStaleRun(run, now),
  );

  return {
    ...state,
    runs: state.runs.map((run) =>
      staleRunIds.has(run.id)
        ? {
            ...run,
            status: "failed",
            endedAt: run.endedAt ?? now,
            errorMessage:
              run.errorMessage ?? "Runtime restarted before this run finished.",
          }
        : run,
    ),
    runEvents: [
      ...recoveryEvents,
      ...state.runEvents.filter(
        (event) => !recoveryEvents.some((recovery) => recovery.id === event.id),
      ),
    ],
    workers: state.workers.map((worker) =>
      staleWorkerIds.has(worker.id) ||
      orphanWorkingWorkers.some((orphan) => orphan.id === worker.id)
        ? {
            ...worker,
            status: "No active task",
            tone: "idle",
            heartbeat: "Recovered after restart",
            activities: [
              "Runtime recovered stale work",
              "No active workflow running",
              START_WORKER_PREPARATION_MESSAGE,
            ],
          }
        : worker,
    ),
    capabilityProviders: state.capabilityProviders.map((provider) => {
      if (!staleCapabilityProviderIds.has(provider.id)) {
        return provider;
      }
      const wasReady = Boolean(provider.lastSuccessAt);
      return {
        ...provider,
        status: wasReady ? "ready" : "not_checked",
        lastError: null,
        detail: wasReady
          ? provider.id === "chrome"
            ? "Chrome was ready at the last completed check."
            : "This connection was ready at the last completed check."
          : provider.id === "chrome"
            ? "The previous Chrome check was interrupted. Check again."
            : "The previous connection check was interrupted. Check again.",
      };
    }),
    updatedAt: now,
  };
}

function isUnrecoverableActiveRun(run: ProductRun): boolean {
  return run.status === "queued" || run.status === "running";
}

function isOpenRunStatus(status: ProductRun["status"]): boolean {
  return (
    status === "queued" ||
    status === "running" ||
    status === "waiting_for_user" ||
    status === "blocked"
  );
}

function runKind(run: ProductRun): NonNullable<ProductRun["kind"]> {
  return run.kind ?? "workflow";
}

function recoveryEventForStaleRun(
  run: ProductRun,
  createdAt: string,
): ProductRunEvent {
  return {
    id: `event-recovered-${run.id}`,
    runId: run.id,
    workerId: run.workerId,
    source: "system",
    status: "Runtime recovered",
    body: "OysterWorkflow restarted before this run finished, so the run was marked failed and the worker was returned to idle.",
    createdAt,
  };
}

function requireWorker(state: ProductState, workerId: string): ProductWorker {
  const worker = state.workers.find((item) => item.id === workerId);
  if (!worker) {
    throw new Error(`Unknown worker: ${workerId}`);
  }
  return worker;
}

function requireWorkflow(
  state: ProductState,
  workflowId: string,
): ProductWorkflow {
  if (state.workflowTombstones.some((item) => item.workflowId === workflowId)) {
    throw new Error(`Unknown workflow: ${workflowId}`);
  }
  const workflow = state.workflows.find((item) => item.id === workflowId);
  if (workflow) {
    return workflow;
  }
  const installed = state.installedWorkflows.find(
    (item) => item.workflowId === workflowId,
  );
  if (installed) {
    return {
      id: installed.workflowId,
      title: installed.workflowTitle,
      description: installed.description,
      status: "Installable",
      sourceType: "imported",
      sourceText: null,
      confidence: null,
      apps: [...installed.apps],
      stats: {
        uiEvents: 0,
        ocrObservations: 0,
        voiceNotes: 0,
        duration: "--",
        decisionPoints: 0,
      },
      detectedAt: installed.installedAt,
      artifactPath: installed.sourceSkillPath,
      createdAt: installed.installedAt,
      updatedAt: installed.installedAt,
    };
  }
  throw new Error(`Unknown workflow: ${workflowId}`);
}

function workflowAuthorityFingerprint(workflow: ProductWorkflow): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        id: workflow.id,
        title: workflow.title,
        description: workflow.description,
        status: workflow.status,
        sourceType: workflow.sourceType,
        apps: workflow.apps,
        artifactPath: workflow.artifactPath,
        updatedAt: workflow.updatedAt,
      }),
    )
    .digest("hex");
}

function requireInstalledWorkflow(
  state: ProductState,
  installedWorkflowId: string,
): ProductInstalledWorkflow {
  const workflow = state.installedWorkflows.find(
    (item) => item.id === installedWorkflowId,
  );
  if (!workflow) {
    throw new Error(`Unknown installed workflow: ${installedWorkflowId}`);
  }
  return workflow;
}

function findWorkerSessionWorkflow(
  state: ProductState,
  worker: ProductWorker,
): ProductInstalledWorkflow | null {
  const selected = worker.selectedInstalledWorkflowId
    ? state.installedWorkflows.find(
        (workflow) => workflow.id === worker.selectedInstalledWorkflowId,
      )
    : null;
  return (
    selected ??
    state.installedWorkflows.find(
      (item) => item.workerId === worker.id && item.status === "Enabled",
    ) ??
    null
  );
}

function installedWorkflowForRun(
  state: ProductState,
  run: ProductRun,
): ProductInstalledWorkflow | null {
  return run.installedWorkflowId === GENERAL_WORKER_SESSION_ID
    ? null
    : requireInstalledWorkflow(state, run.installedWorkflowId);
}

function requireDevice(state: ProductState, deviceId: string): ProductDevice {
  const device = state.devices.find((item) => item.id === deviceId);
  if (!device) {
    throw new Error(`Unknown device: ${deviceId}`);
  }
  return device;
}

function requireInstalledWorkflowReadyForRun(
  workflow: ProductInstalledWorkflow,
): void {
  if (workflow.status !== "Enabled") {
    throw new Error("Enable this workflow before running it.");
  }
  if (!workflow.deployTargetDeviceId) {
    throw new Error("Choose a deploy target before running this workflow.");
  }
}

function requireNoActiveRun(state: ProductState, workerId: string): void {
  const activeRun = state.runs.find(
    (run) => run.workerId === workerId && isOpenRunStatus(run.status),
  );
  if (!activeRun) {
    return;
  }
  throw new Error("This worker is already running a workflow.");
}

function requireWorkerDeviceReady(
  state: ProductState,
  worker: ProductWorker,
): ProductDevice {
  if (!worker.deviceId) {
    throw new Error("Assign an available device before starting this worker.");
  }
  const device = state.devices.find((item) => item.id === worker.deviceId);
  if (!device) {
    throw new Error("Assign a valid device before starting this worker.");
  }
  if (device.status !== "Available now") {
    throw new Error("Assigned device is not available right now.");
  }
  if (device.assignedWorkerId && device.assignedWorkerId !== worker.id) {
    throw new Error("Assigned device is linked to another worker.");
  }
  return device;
}

function requireDeployTargetReady(
  state: ProductState,
  worker: ProductWorker,
  workflow: ProductInstalledWorkflow,
): void {
  const device = state.devices.find(
    (item) => item.id === workflow.deployTargetDeviceId,
  );
  if (!device) {
    throw new Error(
      "Choose a valid deploy target before running this workflow.",
    );
  }
  if (device.status !== "Available now") {
    throw new Error("Deploy target is not available right now.");
  }
  if (device.assignedWorkerId && device.assignedWorkerId !== worker.id) {
    throw new Error("Deploy target is assigned to another worker.");
  }
}

function productEvent(input: {
  runId: string;
  workerId: string;
  source: ProductRunEvent["source"];
  status: string;
  body: string;
}): ProductRunEvent {
  return {
    id: createProductEntityId("event"),
    runId: input.runId,
    workerId: input.workerId,
    source: input.source,
    status: input.status,
    body: input.body,
    createdAt: new Date().toISOString(),
  };
}

function buildStartWorkerPrompt(
  worker: ProductWorker,
  workflow: ProductInstalledWorkflow,
): string {
  return [
    "You are the Hermes Agent instance backing an OysterWorkflow AI worker.",
    `Worker: ${worker.name}`,
    `Worker reference: ${worker.config.hermesAgentReference}`,
    ...workerConfigPromptLines(worker),
    `Installed skill: ${workflow.hermesSkillName}`,
    `Workflow: ${workflow.workflowTitle}`,
    `Workflow description: ${workflow.description}`,
    `Apps: ${workflow.apps.join(", ") || "Desktop app"}`,
    "Approval policy: allow_all. Execute according to the installed workflow. OysterWorkflow turns your concise responses and session status line into run events; do not inspect or write product databases to create run events.",
    ...oysterBrowserPromptLines(),
    ...workerUserFacingResponsePolicyLines(),
    "Execute the installed workflow end-to-end now. Do not stop after loading the skill, and do not wait for an extra user command such as start or continue.",
    "Keep operating through the workflow until the business result is complete, a concrete user action is required, the workflow is blocked, or execution fails.",
    "Use only evidence from this current run and current app/browser/tool state. Do not treat previous run summaries, old session history, cached draft claims, or cached CRM claims as proof of completion.",
    "Do not rewrite, self-improve, or create skills during workflow execution unless the user explicitly asks for skill editing.",
    "Avoid noisy repeated full-screen `computer_use` captures. Prefer targeted browser/tool/app evidence; if `computer_use` output is too large, switch methods or report the specific foreground app/window needed.",
    "Report concise real progress and the evidence you observed from the current screen, browser, app, or tool output. Do not invent completed work.",
    ...workerSessionStatusProtocolLines(),
  ].join("\n");
}

function buildInitializeWorkerPrompt(
  worker: ProductWorker,
  workflow: ProductInstalledWorkflow | null,
): string {
  const sessionContext = workflow
    ? [
        `Installed skill context: ${workflow.hermesSkillName}`,
        `Selected workflow: ${workflow.workflowTitle}`,
        `Workflow description: ${workflow.description}`,
        `Apps: ${workflow.apps.join(", ") || "Desktop app"}`,
        "Initialize the worker session only. Do not execute the installed workflow yet, do not navigate apps, and do not perform external actions.",
      ]
    : [
        "Session mode: General AI worker session (no workflow installed).",
        "No workflow skill is selected. Use the worker profile and available tools for the user's next command.",
        "Initialize the worker session only. Do not navigate apps or perform external actions.",
      ];
  return [
    "You are the Hermes Agent instance backing an OysterWorkflow AI worker.",
    `Worker: ${worker.name}`,
    `Worker reference: ${worker.config.hermesAgentReference}`,
    ...workerConfigPromptLines(worker),
    ...sessionContext,
    "Approval policy: allow_all.",
    "Reply with a concise ready message for the Agent panel, including that you are ready for the user's next command.",
    "Keep the session open for follow-up commands through the same Hermes session.",
    ...workerUserFacingResponsePolicyLines(),
    ...workerSessionStatusProtocolLines(),
    'For this initialization response, choose status "running" unless setup fails or a concrete user action is required.',
  ].join("\n");
}

function buildWorkerCommandPrompt(input: {
  worker: ProductWorker;
  installedWorkflow: ProductInstalledWorkflow | null;
  command: string;
}): string {
  const sessionContext = input.installedWorkflow
    ? [
        `Installed skill: ${input.installedWorkflow.hermesSkillName}`,
        `Workflow: ${input.installedWorkflow.workflowTitle}`,
        "Use the installed workflow skill as the operating guide.",
      ]
    : [
        "Session mode: General AI worker session (no workflow installed).",
        "Use the worker profile and available tools to carry out the user's command.",
      ];
  return [
    "Continue the OysterWorkflow worker run.",
    `Worker: ${input.worker.name}`,
    ...workerConfigPromptLines(input.worker),
    ...sessionContext,
    `User command: ${input.command}`,
    "Use only evidence from this current run and current app/browser/tool state. Do not treat previous run summaries, old session history, cached draft claims, or cached CRM claims as proof of completion.",
    "Do not rewrite, self-improve, or create skills during workflow execution unless the user explicitly asks for skill editing.",
    "Avoid noisy repeated full-screen `computer_use` captures. Prefer targeted browser/tool/app evidence; if `computer_use` output is too large, switch methods or report the specific foreground app/window needed.",
    ...oysterBrowserPromptLines(),
    ...workerUserFacingResponsePolicyLines(),
    "Return the actual AI worker response for the Agent panel. Include current progress, the next screen action, the app or website you are using, and any approval or evidence boundary.",
    ...workerSessionStatusProtocolLines(),
  ].join("\n");
}

function workerSessionStatusProtocolLines(): string[] {
  return [
    "Session status protocol:",
    'At the end of every response, output exactly one standalone machine line: OYSTERWORKFLOW_SESSION_STATUS {"status":"running","message":"...","user_action":null}',
    'Choose status yourself from exactly: "running", "waiting_for_user", "blocked", "succeeded", "failed".',
    'Use "running" when the workflow should continue in the active session.',
    'Use "waiting_for_user" only when a concrete user action such as sign-in, MFA, authorization, account selection, or additional input would let the session continue.',
    'Use "blocked" when the workflow cannot continue without missing evidence, missing app access, a workflow fix, or a different task setup.',
    'Use "succeeded" only after the requested business workflow result is actually completed. Use "failed" for unrecoverable execution failure.',
    "Keep the machine line separate from the user-facing explanation. Do not wrap it in Markdown.",
  ];
}

function oysterBrowserPromptLines(): string[] {
  return [
    "Connected app capability priority: when an MCP/API/composite provider can safely read or mutate the target app data, use that before browser automation, `computer_use`, or AppleScript.",
    "Use Composio hosted MCP, native MCP tools, or direct app APIs for supported apps such as email, calendar, chat, CRM, docs, sheets, storage, and issue trackers when available.",
    "Browser automation priority after direct app capabilities: use `$OYSTER_BROWSER_CLI` first, then Hermes built-in browser automation, then `computer_use`, then AppleScript/`osascript`/System Events only as the last fallback.",
    "For every browser, website, Chrome, or web-app step that cannot be completed through a direct app capability, start with the OysterWorkflow BrowserAct wrapper at `$OYSTER_BROWSER_CLI`.",
    "Native desktop app priority after direct app capabilities: use `computer_use` first, then AppleScript/`osascript`/System Events only as the last fallback.",
    "Before every `computer_use` action, verify the foreground app/window is the intended target. If the user changed the desktop unexpectedly, restore focus once or report waiting_for_user with the target app/window needed.",
    "Avoid temporary browser sessions for login-dependent browser work unless `$OYSTER_BROWSER_CLI` and the current local Chrome state cannot be used and the task can still be completed safely. Do not use Playwright, raw `browser-act`, or raw Chrome DevTools for browser work.",
    "The browser policy is allow_all: you may click, type, select, upload, submit, run page JavaScript, inspect network requests, and take screenshots when needed by the workflow.",
    "The wrapper uses BrowserAct chrome-direct with the user's current local Chrome login state.",
    "The wrapper may let BrowserAct restart local Chrome when chrome-direct is stale; try `$OYSTER_BROWSER_CLI` recovery before switching tools.",
    "If `$OYSTER_BROWSER_CLI` fails because Chrome cannot be attached or no active browser session exists, try Hermes built-in browser automation before `computer_use` on the visible target browser. Use AppleScript only as the last fallback. If login, MFA, or permission is blocked, report the diagnostic as waiting_for_user.",
    "OysterWorkflow injects `OYSTER_WORKFLOW_RUN_ID`, so `$OYSTER_BROWSER_CLI` can derive a stable run-scoped browser session when your JSON omits `session`.",
  ];
}

function workerConfigPromptLines(worker: ProductWorker): string[] {
  return [
    "Worker setup from OysterWorkflow:",
    `- Handles: ${promptLine(worker.config.identityScope)}`,
    `- Memory/context: ${promptLine(worker.config.memoryContext)}`,
    `- Recovery behavior: ${promptLine(worker.config.heartbeatPolicy)}`,
    `- Tool access: ${worker.config.toolAccess.map(promptToolAccessLine).filter(Boolean).join(", ") || "OysterWorkflow managed desktop tools"}`,
    `- Runtime profile: ${promptLine(worker.config.runtimeProfile)}`,
    `- Approval policy: ${worker.config.approvalPolicy}`,
  ];
}

function promptToolAccessLine(value: string): string {
  const normalized = promptLine(value);
  if (/^browser control$/iu.test(normalized)) {
    return "BrowserAct through the OysterWorkflow browser wrapper";
  }
  return normalized;
}

function promptLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function runStatusFromHermesResult(
  result: WorkerExecutorRunResult,
  fallback: ProductRun["status"],
): ProductRun["status"] {
  if (!result.ok) {
    return "failed";
  }
  if (!result.sessionStatus) {
    return fallback;
  }
  return result.sessionStatus;
}

/**
 * EN: Keeps an explicitly started worker session available after one command turn finishes.
 * 中文: 单次命令执行完成后，保持已显式启动的 Worker 会话继续可用。
 * @param reportedStatus structured status returned by Hermes for the command turn.
 * @param kind product run kind that owns the Hermes session.
 * @returns persisted run status used by the worker lifecycle.
 */
function runStatusAfterWorkerCommand(
  reportedStatus: ProductRun["status"],
  kind: NonNullable<ProductRun["kind"]>,
): ProductRun["status"] {
  if (
    kind === "worker_session" &&
    (reportedStatus === "succeeded" || reportedStatus === "paused")
  ) {
    return "running";
  }
  return reportedStatus;
}

function runEventStatusFromRunStatus(
  status: ProductRun["status"],
  fallback: string,
): string {
  if (status === "waiting_for_user") {
    return "Waiting for user";
  }
  if (status === "blocked") {
    return "Blocked";
  }
  if (status === "succeeded") {
    return "AI worker completed";
  }
  if (status === "failed") {
    return "AI worker failed";
  }
  return fallback;
}

function hermesResultBodyForEvent(
  result: WorkerExecutorRunResult,
  completionNotice?: string | null,
  preferSessionStatusMessage = false,
): string {
  const cleaned = productizeWorkerFacingText(
    cleanHermesOutputForEvent(result.output),
  );
  if (preferSessionStatusMessage) {
    const body =
      productizeOptionalWorkerFacingText(result.sessionStatusMessage) ||
      "AI worker returned successfully and is ready for the next workflow command.";
    return completionNotice?.trim()
      ? `${completionNotice.trim()}\n\n${body}`
      : body;
  }
  const body =
    cleaned !==
    "AI worker returned successfully and is ready for the next workflow command."
      ? cleaned
      : (() => {
          const details = [
            productizeOptionalWorkerFacingText(result.sessionStatusMessage),
            result.userAction
              ? `User action: ${productizeWorkerFacingText(result.userAction)}`
              : null,
          ].filter((value): value is string => Boolean(value));
          return details.length > 0 ? details.join("\n") : cleaned;
        })();
  if (completionNotice?.trim()) {
    return `${completionNotice.trim()}\n\n${body}`;
  }
  return body;
}

function productizeOptionalWorkerFacingText(
  value: string | null | undefined,
): string | null {
  return value?.trim() ? productizeWorkerFacingText(value.trim()) : null;
}

function shouldPreferSessionStatusMessage(
  status: ProductRun["status"],
  eventStatus: string,
): boolean {
  return (
    status === "running" && /ai worker (ready|started)/iu.test(eventStatus)
  );
}

function mergeProductRunEvent(
  events: ProductRunEvent[],
  event: ProductRunEvent,
): ProductRunEvent[] {
  if (
    event.source !== "hermes" ||
    !event.body.trim() ||
    !isHermesConversationEventStatus(event.status)
  ) {
    return [event, ...events];
  }

  const existingIndex = events.findIndex(
    (item) =>
      item.runId === event.runId &&
      item.workerId === event.workerId &&
      item.source === "hermes" &&
      isHermesConversationEventStatus(item.status) &&
      item.body.trim() === event.body.trim(),
  );
  if (existingIndex < 0) {
    return [event, ...events];
  }

  const merged = [...events];
  const existing = merged[existingIndex]!;
  merged[existingIndex] = {
    ...existing,
    status: preferHermesConversationStatus(existing.status, event.status),
    createdAt:
      hermesConversationStatusRank(event.status) >=
      hermesConversationStatusRank(existing.status)
        ? event.createdAt
        : existing.createdAt,
  };
  return merged;
}

function isHermesConversationEventStatus(status: string): boolean {
  return hermesConversationStatusRank(status) > 0;
}

function preferHermesConversationStatus(
  current: string,
  incoming: string,
): string {
  return hermesConversationStatusRank(incoming) >=
    hermesConversationStatusRank(current)
    ? incoming
    : current;
}

function workerHeartbeatFromRunStatus(
  status: ProductRun["status"],
  kind: NonNullable<ProductRun["kind"]>,
): string {
  if (status === "waiting_for_user") {
    return "Waiting for user";
  }
  if (status === "blocked") {
    return "Blocked";
  }
  if (status === "succeeded") {
    return kind === "worker_session"
      ? "No active task"
      : "Ready for next command";
  }
  if (status === "paused") {
    return "No active task";
  }
  if (status === "failed") {
    return "AI worker failed";
  }
  return kind === "worker_session" ? "AI worker ready" : "AI worker working";
}

function workerStatusFromRunStatus(
  status: ProductRun["status"],
  kind: NonNullable<ProductRun["kind"]>,
): ProductWorker["status"] {
  if (status === "waiting_for_user") {
    return "Waiting for user";
  }
  if (status === "blocked") {
    return "Blocked";
  }
  if (kind === "worker_session") {
    if (status === "running") {
      return "Available";
    }
    return status === "failed" ? "Setup needed" : "No active task";
  }
  if (status === "running" || status === "queued") {
    return "Working";
  }
  return status === "failed" ? "Setup needed" : "No active task";
}

function workerToneFromRunStatus(
  status: ProductRun["status"],
  kind: NonNullable<ProductRun["kind"]>,
): ProductTone {
  if (status === "failed") {
    return "danger";
  }
  if (status === "blocked") {
    return "danger";
  }
  if (status === "waiting_for_user") {
    return "warning";
  }
  if (kind === "worker_session" && status === "running") {
    return "ready";
  }
  if (status === "running" || status === "queued") {
    return "working";
  }
  return "idle";
}

function runActivityFromRunStatus(
  status: ProductRun["status"],
  workflowTitle: string,
  kind: NonNullable<ProductRun["kind"]>,
): string {
  if (status === "waiting_for_user") {
    return `${workflowTitle} waiting for user`;
  }
  if (status === "blocked") {
    return `${workflowTitle} blocked`;
  }
  if (status === "succeeded") {
    return "Workflow completed";
  }
  if (status === "paused") {
    return `${workflowTitle} paused`;
  }
  if (status === "failed") {
    return "Workflow failed";
  }
  return kind === "worker_session"
    ? "Ready for next command"
    : `${workflowTitle} running`;
}

function cleanHermesOutputForEvent(output: string): string {
  const cleaned = stripHermesProtocolLines(output)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter(
      (line) =>
        !/^Session:\s*/iu.test(line) &&
        !/^session_id:\s*/iu.test(line) &&
        !/OYSTERWORKFLOW_(WORKER|HERMES)_(READY|STARTED)/iu.test(line),
    )
    .join("\n");
  if (!cleaned) {
    return "AI worker returned successfully and is ready for the next workflow command.";
  }
  return cleaned;
}

function stripHermesProtocolLines(output: string): string {
  return stripHermesProviderStatusLines(output)
    .split(/\r?\n/u)
    .filter((line) => {
      const trimmed = line.trim();
      return (
        !/^OYSTERWORKFLOW_SESSION_STATUS\b/u.test(trimmed) &&
        !/^OYSTERWORKFLOW_(?:WORKER|HERMES)_(?:READY|STARTED)\b/u.test(
          trimmed,
        ) &&
        !/^Session:\s*/iu.test(trimmed) &&
        !/^session_id:\s*/iu.test(trimmed) &&
        !/^(?:↻\s*)?Resumed session\s+[0-9_a-f-]+(?:\s+\([^)]*\))?$/iu.test(
          trimmed,
        )
      );
    })
    .join("\n");
}

function normalizeApprovalPolicies(
  state: ProductState,
  existingPolicies: ProductApprovalPolicy[],
): ProductApprovalPolicy[] {
  const now = new Date().toISOString();
  const policies = new Map<string, ProductApprovalPolicy>();
  existingPolicies.forEach((policy) => policies.set(policy.id, policy));
  state.workers.forEach((worker) => {
    const id = approvalPolicyIdForWorker(worker.id);
    if (!policies.has(id)) {
      policies.set(id, {
        id,
        scopeType: "worker",
        scopeId: worker.id,
        mode: "allow_all",
        description:
          "AI worker can proceed under allow_all; progress appears in run events.",
        updatedAt: now,
      });
    }
  });
  state.installedWorkflows.forEach((workflow) => {
    const id = approvalPolicyIdForInstalledWorkflow(workflow.id);
    if (!policies.has(id)) {
      policies.set(id, {
        id,
        scopeType: "installed_workflow",
        scopeId: workflow.id,
        mode: "allow_all",
        description:
          "Installed workflow can proceed under allow_all; progress appears in run events.",
        updatedAt: now,
      });
    }
  });
  return Array.from(policies.values());
}

function upsertApprovalPolicy(
  policies: ProductApprovalPolicy[],
  policy: ProductApprovalPolicy,
): ProductApprovalPolicy[] {
  return [policy, ...policies.filter((existing) => existing.id !== policy.id)];
}

function approvalPolicyIdForWorker(workerId: string): string {
  return `approval-policy-worker-${workerId}`;
}

function approvalPolicyIdForInstalledWorkflow(
  installedWorkflowId: string,
): string {
  return `approval-policy-installed-${installedWorkflowId}`;
}

function workerInitials(name: string): string {
  const initials = name
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
  return initials || "AI";
}

function avatarKeyForWorkerName(name: string): ProductWorker["avatarKey"] {
  const normalized = name.toLowerCase();
  if (normalized.includes("marketing")) {
    return "marketing";
  }
  if (normalized.includes("product")) {
    return "product";
  }
  if (normalized.includes("finance")) {
    return "finance";
  }
  if (normalized.includes("sales")) {
    return "sales";
  }
  return "sales";
}

async function configureWorkerChannelWithExecutor(
  workerExecutor: WorkerExecutor,
  workerAgentReference: string,
  channelInput: ProductWorkerChannelInput,
): Promise<ProductWorkerChannelConfig> {
  if (workerExecutor.configureChannel) {
    const result = await workerExecutor.configureChannel({
      workerAgentReference,
      channel: channelInput,
    });
    return normalizePersistedProductWorkerChannel(result.channel);
  }
  return productWorkerChannelConfigFromInput(channelInput);
}

function upsertById<T extends { id: string }>(items: T[], value: T): T[] {
  const existingIndex = items.findIndex((item) => item.id === value.id);
  if (existingIndex < 0) {
    return [value, ...items];
  }
  return items.map((item) => (item.id === value.id ? value : item));
}

function channelConnectionId(
  workerId: string,
  platform: ProductChannelConnection["platform"],
): string {
  return `channel-${workerId}-${platform}`;
}

function channelDisplayLabel(
  platform: ProductChannelConnection["platform"],
): string {
  const labels: Record<ProductChannelConnection["platform"], string> = {
    telegram: "Telegram",
    slack: "Slack",
    weixin: "WeChat",
    whatsapp: "WhatsApp",
    wecom: "WeCom",
  };
  return labels[platform];
}

function channelSetupMethod(
  platform: ProductChannelConnection["platform"],
): ProductChannelConnection["setupMethod"] {
  if (platform === "telegram") {
    return "bot_token";
  }
  if (platform === "weixin" || platform === "whatsapp") {
    return "qr_link";
  }
  return "app_tokens";
}

function channelConnectionStatusFromWorkerChannel(
  channel: ProductWorkerChannelConfig,
): ProductChannelConnection["status"] {
  if (channel.status === "connected") {
    return "connected";
  }
  if (channel.status === "configured" || channel.status === "testing") {
    return "connecting";
  }
  if (channel.status === "failed") {
    return "failed";
  }
  return "not_configured";
}

function channelConnectionStatusFromSetup(
  status: ProductChannelSetup["status"],
): ProductChannelConnection["status"] {
  if (status === "connected") {
    return "connecting";
  }
  if (status === "installing") {
    return "installing";
  }
  if (status === "awaiting_scan") {
    return "awaiting_scan";
  }
  if (status === "authorizing") {
    return "authorizing";
  }
  if (status === "failed") {
    return "failed";
  }
  if (status === "cancelled") {
    return "disconnected";
  }
  return "connecting";
}

function requireChannelSetup(
  state: ProductState,
  workerId: string,
  setupId: string,
): ProductChannelSetup {
  const setup = state.channelSetups.find(
    (item) => item.id === setupId && item.workerId === workerId,
  );
  if (!setup) {
    throw new Error(`Unknown channel setup: ${setupId}`);
  }
  return setup;
}

function requireChannelConnection(
  state: ProductState,
  workerId: string,
  connectionId: string,
): ProductChannelConnection {
  const connection = state.channelConnections.find(
    (item) => item.id === connectionId && item.workerId === workerId,
  );
  if (!connection) {
    throw new Error(`Unknown channel connection: ${connectionId}`);
  }
  return connection;
}

function resolveWorkerBindingRun(
  state: ProductState,
  workerId: string,
  requestedSessionId?: string | null,
): ProductRun {
  const candidates = state.runs
    .filter(
      (run) =>
        run.workerId === workerId &&
        run.kind === "worker_session" &&
        Boolean(run.hermesSessionId),
    )
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  const run = requestedSessionId
    ? candidates.find((item) => item.hermesSessionId === requestedSessionId)
    : candidates[0];
  if (!run?.hermesSessionId) {
    throw new Error(
      requestedSessionId
        ? "The selected AI worker session does not belong to this worker."
        : "Start this AI worker before binding a message conversation.",
    );
  }
  return run;
}

function channelBindingId(
  connectionId: string,
  conversationId: string,
  threadId: string | null,
): string {
  const digest = createHash("sha256")
    .update(`${connectionId}\0${conversationId}\0${threadId ?? ""}`)
    .digest("hex")
    .slice(0, 16);
  return `binding-${digest}`;
}

function workerChannelToolAccess(channel: ProductWorkerChannelConfig): string {
  return channel.platform === "none" ? "" : `${channel.label} channel`;
}

function replaceWorkerChannelToolAccess(
  currentAccess: string[],
  channel: ProductWorkerChannelConfig,
): string[] {
  const withoutChannels = currentAccess.filter(
    (item) =>
      !/^(Telegram|Slack|WeChat|WhatsApp|WeCom) channel$/iu.test(item.trim()),
  );
  return dedupe([...withoutChannels, workerChannelToolAccess(channel)]);
}

function workerChannelActivity(channel: ProductWorkerChannelConfig): string {
  if (channel.platform === "none") {
    return "No message channel configured";
  }
  if (channel.status === "connected") {
    return `${channel.label} channel connected`;
  }
  if (channel.status === "configured") {
    return `${channel.label} channel configured`;
  }
  return `${channel.label} channel needs setup`;
}

function workerChannelTestActivity(
  channel: ProductWorkerChannelConfig,
): string {
  if (channel.status === "connected") {
    return `${channel.label} channel connected`;
  }
  if (channel.status === "failed") {
    return `${channel.label} channel test failed`;
  }
  return workerChannelActivity(channel);
}

function normalizeWorkerHermesReference(worker: ProductWorker): ProductWorker {
  const hermesAgentReference = normalizeHermesAgentReference(
    worker,
    worker.config.hermesAgentReference,
  );
  return {
    ...worker,
    selectedInstalledWorkflowId: worker.selectedInstalledWorkflowId ?? null,
    config: {
      ...worker.config,
      channel: normalizePersistedProductWorkerChannel(worker.config.channel),
      hermesAgentReference,
    },
  };
}

function normalizeHermesAgentReference(
  worker: ProductWorker,
  requestedReference: string,
): string {
  const legacyDefaultReference = `hermes-agent:${worker.id}`;
  if (requestedReference === legacyDefaultReference) {
    return managedHermesProfileReference(worker.id, worker.name);
  }
  return requestedReference;
}

function repairInstalledWorkflowLibraryState(
  state: ProductState,
): ProductState {
  return {
    ...state,
    installedWorkflows: state.installedWorkflows.map((workflow) => {
      const match = workflow.id.match(/^installed-sales-library-(\d+)$/u);
      if (!match) {
        return workflow;
      }
      const entry = SALES_LIBRARY_ENTRIES[Number(match[1]) - 1];
      if (!entry) {
        return workflow;
      }
      const hermesSkillName = defaultHermesSkillName(entry.name);
      const changed =
        workflow.workflowTitle !== entry.name ||
        workflow.description !== entry.description ||
        JSON.stringify(workflow.apps) !== JSON.stringify(entry.apps);
      return {
        ...workflow,
        workflowTitle: entry.name,
        description: entry.description,
        apps: entry.apps,
        hermesSkillReference: `hermes-skill:${hermesSkillName}`,
        hermesInstallReference: `hermes-install:${managedHermesProfileReference(
          "sales",
          "Sales AI Worker",
        )}:${hermesSkillName}`,
        hermesSkillName,
        hermesSkillPath: changed ? "" : workflow.hermesSkillPath,
      };
    }),
  };
}

async function buildCloudPortableSnapshot(
  state: ProductState,
): Promise<CloudPortableSnapshot> {
  const upsertedWorkerIds = new Set(
    state.pendingCloudUpserts
      .filter((item) => item.entityType === "worker")
      .map((item) => item.entityId),
  );
  const deletedWorkerIds = new Set(
    state.pendingCloudDeletes
      .filter((item) => item.entityType === "worker")
      .map((item) => item.entityId),
  );

  const workers: WorkerManifest[] = state.workers
    .filter((worker) => !deletedWorkerIds.has(worker.id))
    .map((worker) => ({
      schemaVersion: "oyster-worker-manifest-v1",
      workerId: worker.id,
      name: worker.name,
      initials: worker.initials,
      description: worker.description,
      avatarKey: worker.avatarKey,
      config: {
        identityScope: worker.config.identityScope,
        runtimeProfile: worker.config.runtimeProfile,
        toolAccess: [...worker.config.toolAccess],
        memoryContext: worker.config.memoryContext,
        approvalPolicy: "allow_all",
        heartbeatPolicy: worker.config.heartbeatPolicy,
        channel: {
          platform: worker.config.channel.platform,
          label: worker.config.channel.label,
          accessMode: worker.config.channel.accessMode,
          homeChannel: worker.config.channel.homeChannel,
          allowedUsers: [...worker.config.channel.allowedUsers],
        },
      },
    }));

  return {
    devices: [],
    workers,
    upserted: {
      workerIds: [...upsertedWorkerIds].filter(
        (id) => !deletedWorkerIds.has(id),
      ),
    },
    deleted: {
      workerIds: [...deletedWorkerIds],
    },
    mutationTokens: buildCloudPortableMutationTokens(state),
  };
}

async function mergeCloudPortableSnapshot(
  state: ProductState,
  input: {
    snapshot: CloudPortableSnapshot;
    user: CloudAuthenticatedUser;
    localDeviceId: string;
    replacePortableState: boolean;
    syncRevision: number;
    acknowledgedCloudMutationTokens?: CloudPortableSnapshot["mutationTokens"];
  },
  options: { installationId: string },
): Promise<ProductState> {
  const accountChanged = state.account.cloudUserId !== input.user.id;
  const localState = shouldIsolateCloudIdentity(
    state,
    input.user.id,
    input.replacePortableState,
  )
    ? isolateStateForCloudIdentity(state)
    : state;
  const accountNamespace = installationAccountNamespace(
    options.installationId,
    input.user.id,
  );
  const deleted = input.snapshot.deleted ?? { workerIds: [] };
  const currentMutationTokens = buildCloudPortableMutationTokens(localState);
  const protectedUpserts = unacknowledgedCloudMutationIds(
    accountChanged ? [] : localState.pendingCloudUpserts,
    currentMutationTokens.upserted,
    input.acknowledgedCloudMutationTokens?.upserted,
  );
  const locallyPendingWorkerIds = new Set(
    (accountChanged ? [] : localState.pendingCloudDeletes)
      .filter((item) => item.entityType === "worker")
      .map((item) => item.entityId),
  );
  const deletedWorkerIds = new Set([
    ...deleted.workerIds.filter((id) => !protectedUpserts.workerIds.has(id)),
    ...locallyPendingWorkerIds,
  ]);
  const remoteWorkerManifests = input.snapshot.workers.filter(
    (worker) => !protectedUpserts.workerIds.has(worker.workerId),
  );
  const remoteDevices = input.snapshot.devices
    .filter((device) => !device.revokedAt)
    .map((device) =>
      cloudProductDevice(device, input.user, input.localDeviceId),
    );
  const devices = remoteDevices;
  const localDevice = devices.find(
    (device) => device.id === input.localDeviceId,
  );

  const workflows = localState.workflows;

  const remoteWorkers: ProductWorker[] = remoteWorkerManifests.map(
    (manifest) => {
      const existing = localState.workers.find(
        (worker) => worker.id === manifest.workerId,
      );
      const preservesLocalChannel =
        existing?.config.channel.platform === manifest.config.channel.platform;
      return {
        id: manifest.workerId,
        name: manifest.name,
        initials: manifest.initials,
        description: manifest.description,
        status: localDevice ? "No active task" : "Needs device",
        tone: localDevice ? "idle" : "warning",
        avatarKey: manifest.avatarKey,
        deviceId: localDevice?.id ?? null,
        selectedInstalledWorkflowId:
          existing?.selectedInstalledWorkflowId ?? null,
        heartbeat: localDevice
          ? "Synced to this computer"
          : "No computer assigned",
        activities: [
          "WorkerManifest synced",
          localDevice ? "This computer assigned" : "Device assignment needed",
          "Local credentials stay on this computer",
        ],
        config: {
          identityScope: manifest.config.identityScope,
          runtimeProfile: manifest.config.runtimeProfile,
          toolAccess: [...manifest.config.toolAccess],
          memoryContext: manifest.config.memoryContext,
          approvalPolicy: "allow_all",
          heartbeatPolicy: manifest.config.heartbeatPolicy,
          hermesAgentReference: managedHermesProfileReference(
            installationAccountNamespace(
              options.installationId,
              `${input.user.id}:${manifest.workerId}`,
            ),
            manifest.name,
          ),
          channel: preservesLocalChannel
            ? existing!.config.channel
            : {
                platform: manifest.config.channel.platform,
                label: manifest.config.channel.label,
                accessMode: manifest.config.channel.accessMode,
                homeChannel: manifest.config.channel.homeChannel,
                allowedUsers: [...manifest.config.channel.allowedUsers],
                configuredFields: [],
                missingFields:
                  manifest.config.channel.platform === "none"
                    ? []
                    : ["Local credentials"],
                status: "not_configured",
                lastTestedAt: null,
                lastError: null,
              },
        },
      };
    },
  );
  const workers = mergePortableRecords(
    input.replacePortableState
      ? localState.workers.filter((worker) =>
          protectedUpserts.workerIds.has(worker.id),
        )
      : localState.workers,
    remoteWorkers,
    (worker) => worker.id,
  ).filter((worker) => !deletedWorkerIds.has(worker.id));
  const workersById = new Map(workers.map((worker) => [worker.id, worker]));
  const workflowsById = new Map(
    workflows.map((workflow) => [workflow.id, workflow]),
  );

  const installedWorkflows = localState.installedWorkflows.filter(
    (workflow) =>
      !deletedWorkerIds.has(workflow.workerId) &&
      workersById.has(workflow.workerId) &&
      workflowsById.has(workflow.workflowId),
  );

  const acknowledgedMutationTokens = input.acknowledgedCloudMutationTokens;
  return {
    ...localState,
    account: {
      ...localState.account,
      id: input.user.id,
      name:
        input.user.displayName ??
        (accountChanged ? input.user.email : localState.account.name),
      email: input.user.email,
      cloudProvider: "supabase",
      cloudUserId: input.user.id,
      cloudSyncRevision: input.syncRevision,
      setupCompleted: true,
      updatedAt: new Date().toISOString(),
    },
    workspace: {
      ...localState.workspace,
      id: `workspace-${accountNamespace}`,
      mode: "cloud-linked",
    },
    devices,
    workers,
    workflows,
    installedWorkflows,
    pendingCloudUpserts: accountChanged
      ? []
      : localState.pendingCloudUpserts.filter(
          (item) =>
            !cloudMutationWasAcknowledged(
              item,
              currentMutationTokens.upserted,
              acknowledgedMutationTokens?.upserted,
            ),
        ),
    pendingCloudDeletes: accountChanged
      ? []
      : localState.pendingCloudDeletes.filter(
          (item) =>
            !cloudMutationWasAcknowledged(
              item,
              currentMutationTokens.deleted,
              acknowledgedMutationTokens?.deleted,
            ),
        ),
  };
}

function shouldIsolateCloudIdentity(
  state: ProductState,
  nextCloudUserId: string,
  replacePortableState: boolean,
): boolean {
  return (
    state.account.cloudUserId !== nextCloudUserId &&
    (state.account.cloudUserId !== null || replacePortableState)
  );
}

/**
 * EN: Rechecks the service-owned sync generation inside the serialized store mutation.
 * 中文: 在串行化存储变更内部重新校验 service 持有的同步代次。
 * @param input cloud snapshot input with an optional current-attempt predicate.
 * @returns void while this snapshot is still the newest attempt.
 */
function assertCurrentCloudSnapshotAttempt(input: {
  isCurrentCloudSyncAttempt?: () => boolean;
}): void {
  if (input.isCurrentCloudSyncAttempt?.() === false) {
    throw new Error(
      "Cloud sync was superseded by a newer signed-in account. / 云同步已被更新的登录账号取代。",
    );
  }
}

/**
 * EN: Rejects a cloud snapshot when a newer authenticated account has already claimed the store.
 * 中文: 当更新的已认证账号已接管本地存储时，拒绝过期云快照。
 * @param state latest state observed inside the serialized ProductStore update.
 * @param expectedCloudUserId account identity that started this sync attempt.
 * @returns void when the attempt still owns the same account namespace.
 */
function assertExpectedCloudAccount(
  state: ProductState,
  expectedCloudUserId: string | null | undefined,
): void {
  if (
    expectedCloudUserId !== undefined &&
    state.account.cloudUserId !== expectedCloudUserId
  ) {
    throw new Error(
      "Cloud sync was superseded by a newer signed-in account. / 云同步已被更新的登录账号取代。",
    );
  }
}

/**
 * EN: Retains only installation-scoped capability/permission observations when
 * an authoritative cloud identity first links or replaces another identity.
 * 中文: 权威云身份首次绑定或替换身份时，只保留安装级权限与能力探测结果。
 * @param previous state owned by the previous local/cloud identity.
 * @returns reference-closed empty account state for the next identity.
 */
function isolateStateForCloudIdentity(previous: ProductState): ProductState {
  const isolated = seedProductState("empty");
  return {
    ...isolated,
    permissionSnapshot: previous.permissionSnapshot,
    capabilityProviders: previous.capabilityProviders,
  };
}

function cloudProductDevice(
  device: CloudDeviceManifest,
  user: CloudAuthenticatedUser,
  localDeviceId: string,
): ProductDevice {
  const isLocal = device.deviceId === localDeviceId;
  return {
    id: device.deviceId,
    name: device.name,
    status: isLocal ? "Available now" : "Idle today",
    owner: user.displayName ?? user.email,
    assignedWorkerId: null,
    heartbeat: isLocal ? "Synced just now" : device.lastSeenAt,
    location: isLocal
      ? "Local desktop runtime"
      : `Remote ${device.platform} device`,
    runtimeVersion: device.runtimeVersion,
    queue: [],
  };
}

function mergePortableRecords<T>(
  local: T[],
  remote: T[],
  key: (item: T) => string,
): T[] {
  const merged = new Map(local.map((item) => [key(item), item]));
  for (const item of remote) {
    merged.set(key(item), item);
  }
  return [...merged.values()];
}

function queuePortableCloudUpserts(
  current: ProductState,
  next: ProductState,
): ProductState {
  const before = portableRecordFingerprints(current);
  const after = portableRecordFingerprints(next);
  const updatedAt = new Date().toISOString();
  const additions: ProductCloudUpsert[] = [];
  const collectChanges = (
    entityType: ProductCloudUpsert["entityType"],
    previous: Map<string, string>,
    updated: Map<string, string>,
  ) => {
    for (const [entityId, fingerprint] of updated) {
      if (previous.get(entityId) !== fingerprint) {
        additions.push({ entityType, entityId, updatedAt });
      }
    }
  };
  collectChanges("worker", before.workers, after.workers);

  const deletedKeys = new Set(
    next.pendingCloudDeletes.map(
      (item) => `${item.entityType}:${item.entityId}`,
    ),
  );
  return {
    ...next,
    pendingCloudUpserts: queueCloudUpserts(
      next.pendingCloudUpserts,
      additions,
    ).filter((item) => !deletedKeys.has(`${item.entityType}:${item.entityId}`)),
  };
}

/**
 * EN: Captures the exact local portable values represented by one cloud export.
 * 中文: 记录一次云端导出所代表的本地可移植值精确指纹。
 * @param state current durable product state.
 * @returns per-entity mutation tokens for conditional acknowledgement.
 */
function buildCloudPortableMutationTokens(
  state: ProductState,
): NonNullable<CloudPortableSnapshot["mutationTokens"]> {
  const fingerprints = portableRecordFingerprints(state);
  const tokens: NonNullable<CloudPortableSnapshot["mutationTokens"]> = {
    upserted: emptyCloudMutationTokenSet(),
    deleted: emptyCloudMutationTokenSet(),
  };
  for (const item of state.pendingCloudUpserts) {
    const fingerprint = fingerprintForCloudEntity(fingerprints, item.entityId);
    if (!fingerprint) {
      continue;
    }
    setCloudMutationToken(
      tokens.upserted,
      item.entityId,
      createHash("sha256")
        .update(`upsert\0${item.entityType}\0${fingerprint}`)
        .digest("hex"),
    );
  }
  for (const item of state.pendingCloudDeletes) {
    setCloudMutationToken(
      tokens.deleted,
      item.entityId,
      createHash("sha256")
        .update(
          `delete\0${item.entityType}\0${item.entityId}\0${item.deletedAt}`,
        )
        .digest("hex"),
    );
  }
  return tokens;
}

function emptyCloudMutationTokenSet(): CloudPortableMutationTokenSet {
  return { workerIds: {} };
}

function fingerprintForCloudEntity(
  fingerprints: ReturnType<typeof portableRecordFingerprints>,
  entityId: string,
): string | undefined {
  return fingerprints.workers.get(entityId);
}

function setCloudMutationToken(
  tokens: CloudPortableMutationTokenSet,
  entityId: string,
  token: string,
): void {
  tokens.workerIds[entityId] = token;
}

function cloudMutationToken(
  tokens: CloudPortableMutationTokenSet | undefined,
  entityId: string,
): string | undefined {
  return tokens?.workerIds[entityId];
}

function cloudMutationWasAcknowledged(
  item: Pick<ProductCloudUpsert, "entityType" | "entityId">,
  currentTokens: CloudPortableMutationTokenSet,
  acknowledgedTokens: CloudPortableMutationTokenSet | undefined,
): boolean {
  const currentToken = cloudMutationToken(currentTokens, item.entityId);
  return (
    currentToken !== undefined &&
    cloudMutationToken(acknowledgedTokens, item.entityId) === currentToken
  );
}

function unacknowledgedCloudMutationIds(
  items: Array<Pick<ProductCloudUpsert, "entityType" | "entityId">>,
  currentTokens: CloudPortableMutationTokenSet,
  acknowledgedTokens: CloudPortableMutationTokenSet | undefined,
): {
  workerIds: Set<string>;
} {
  const result = {
    workerIds: new Set<string>(),
  };
  for (const item of items) {
    if (cloudMutationWasAcknowledged(item, currentTokens, acknowledgedTokens)) {
      continue;
    }
    result.workerIds.add(item.entityId);
  }
  return result;
}

function portableRecordFingerprints(state: ProductState): {
  workers: Map<string, string>;
} {
  const workers = new Map(
    state.workers.map((worker) => [
      worker.id,
      JSON.stringify({
        name: worker.name,
        initials: worker.initials,
        description: worker.description,
        avatarKey: worker.avatarKey,
        identityScope: worker.config.identityScope,
        runtimeProfile: worker.config.runtimeProfile,
        toolAccess: worker.config.toolAccess,
        memoryContext: worker.config.memoryContext,
        heartbeatPolicy: worker.config.heartbeatPolicy,
        channel: {
          platform: worker.config.channel.platform,
          label: worker.config.channel.label,
          accessMode: worker.config.channel.accessMode,
          homeChannel: worker.config.channel.homeChannel,
          allowedUsers: worker.config.channel.allowedUsers,
        },
      }),
    ]),
  );
  return { workers };
}

function queueCloudUpserts(
  current: ProductCloudUpsert[],
  additions: ProductCloudUpsert[],
): ProductCloudUpsert[] {
  const merged = new Map(
    current.map((item) => [`${item.entityType}:${item.entityId}`, item]),
  );
  for (const item of additions) {
    merged.set(`${item.entityType}:${item.entityId}`, item);
  }
  return [...merged.values()];
}

function queueCloudDeletes(
  current: ProductCloudDelete[],
  additions: ProductCloudDelete[],
): ProductCloudDelete[] {
  const merged = new Map(
    current.map((item) => [`${item.entityType}:${item.entityId}`, item]),
  );
  for (const item of additions) {
    merged.set(`${item.entityType}:${item.entityId}`, item);
  }
  return [...merged.values()];
}

function dedupe(items: string[]): string[] {
  return [...new Set(items.filter((item) => item.trim().length > 0))];
}
