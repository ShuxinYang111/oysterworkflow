import type { RuntimeConfig } from "../runtime/config.js";
import type { ComposioProviderAdapter } from "./composio.js";
import type {
  ProductAgentSessionStatus,
  ProductChannelSetupStatus,
  ProductHermesProviderHealth,
  ProductHermesStatus,
  ProductWorkerChannelConfig,
  ProductWorkerChannelInput,
  ProductWorkerChannelPlatform,
} from "./contracts.js";
import {
  approveHermesGatewayPairing,
  beginHermesGatewayChannelSetup,
  bindHermesGatewayConversation,
  cancelHermesGatewayChannelSetup,
  configureHermesGatewayChannel,
  disconnectHermesGatewayChannel,
  ensureHermesGatewayRunning,
  type HermesConfigSource,
  installHermesSkill,
  listHermesGatewayPeers,
  probeHermesStatus,
  provisionHermesAgent,
  readHermesGatewayChannelSetup,
  startHermesWorkerTurn,
  stopHermesWorkerProcesses,
  testHermesGatewayChannel,
} from "./hermes.js";

export interface WorkerExecutorSkillScope {
  runtimeHome?: string | null;
  profilesRoot?: string | null;
  skillsRoot?: string | null;
}

export interface WorkerExecutorRunResult {
  ok: boolean;
  sessionId: string | null;
  sessionStatus: ProductAgentSessionStatus | null;
  sessionStatusMessage: string | null;
  userAction: string | null;
  output: string;
  errorMessage: string | null;
  providerHealth?: ProductHermesProviderHealth;
}

export interface WorkerExecutorProgressEvent {
  status: string;
  body: string;
  providerHealth?: ProductHermesProviderHealth;
}

export interface WorkerExecutorTurnHandle {
  ready: Promise<WorkerExecutorRunResult>;
  completion: Promise<WorkerExecutorRunResult>;
  stop: () => boolean;
}

export interface WorkerExecutorAgent {
  agentReference: string;
  agentLabel: string;
  agentPath: string | null;
  output: string;
}

export interface WorkerExecutorSkill {
  skillReference: string;
  installReference: string;
  skillName: string;
  skillPath: string;
  workflowGraphPath?: string;
  workflowMarkdownPath?: string;
  workflowRevisionsDir?: string;
  workflowRevisionId?: string;
}

export interface WorkerExecutorChannelResult {
  channel: ProductWorkerChannelConfig;
}

export interface WorkerExecutorChannelTestResult {
  platform: ProductWorkerChannelPlatform;
  status: ProductWorkerChannelConfig["status"];
  lastError: string | null;
  lastTestedAt: string;
}

export interface WorkerExecutorChannelSetupResult {
  setupId: string;
  platform: "weixin" | "whatsapp";
  status: ProductChannelSetupStatus;
  qrPayload: string | null;
  qrExpiresAt: string | null;
  accountLabel: string | null;
  ownerUserId?: string | null;
  processId: number | null;
  lastError: string | null;
  updatedAt: string;
}

export interface WorkerExecutor {
  kind: string;
  skillScope: WorkerExecutorSkillScope;
  shutdown?: () => Promise<void>;
  probeStatus: () => Promise<ProductHermesStatus>;
  provisionAgent: (input: {
    workerId: string;
    workerName: string;
  }) => Promise<WorkerExecutorAgent>;
  configureChannel?: (input: {
    workerAgentReference: string;
    channel: ProductWorkerChannelInput;
  }) => Promise<WorkerExecutorChannelResult>;
  disconnectChannel?: (input: {
    workerAgentReference: string;
    platform: Exclude<ProductWorkerChannelPlatform, "none">;
    bindings: Array<{ chatId: string; threadId?: string | null }>;
  }) => Promise<void>;
  testChannel?: (input: {
    workerAgentReference: string;
    platform: ProductWorkerChannelPlatform;
  }) => Promise<WorkerExecutorChannelTestResult>;
  beginChannelSetup?: (input: {
    setupId: string;
    workerAgentReference: string;
    platform: "weixin" | "whatsapp";
    mode?: "bot" | "self-chat";
    allowedUsers?: string[];
  }) => Promise<WorkerExecutorChannelSetupResult>;
  readChannelSetup?: (input: {
    setupId: string;
    workerAgentReference: string;
    platform: "weixin" | "whatsapp";
    processId?: number | null;
  }) => Promise<WorkerExecutorChannelSetupResult | null>;
  cancelChannelSetup?: (input: {
    processId: number | null;
    setupId: string;
    workerAgentReference: string;
  }) => Promise<boolean>;
  bindChannelConversation?: (input: {
    workerAgentReference: string;
    platform: ProductWorkerChannelPlatform;
    chatId: string;
    threadId?: string | null;
    sessionId: string;
    connectionId?: string | null;
  }) => Promise<{
    platform: ProductWorkerChannelPlatform;
    chatId: string;
    threadId: string | null;
    sessionId: string;
    connectionId: string | null;
  }>;
  approveChannelPairing?: (input: {
    workerAgentReference: string;
    platform: ProductWorkerChannelPlatform;
    code: string;
  }) => Promise<{
    platform: ProductWorkerChannelPlatform;
    userId: string;
    userName: string | null;
  }>;
  ensureChannelGateway?: (input: {
    workerAgentReference: string;
    reload?: boolean;
  }) => Promise<void>;
  listChannelPeers?: (input: {
    workerAgentReference: string;
    platform: ProductWorkerChannelPlatform;
  }) => Promise<
    Array<{
      platform: ProductWorkerChannelPlatform;
      chatId: string;
      threadId: string | null;
      senderId: string | null;
      chatType: string;
      sessionId: string;
      discoveredAt: string;
      bound: boolean;
    }>
  >;
  installSkill: (input: {
    workflowId: string;
    workflowTitle: string;
    description: string;
    apps: string[];
    workerAgentReference: string;
    sourceSkillPath?: string | null;
  }) => Promise<WorkerExecutorSkill>;
  startTurn: (input: {
    prompt: string;
    cwd: string;
    runId?: string | null;
    integrationUserId?: string | null;
    workerAgentReference?: string | null;
    skills?: string[];
    resumeSessionId?: string | null;
    maxTurns?: number;
    onOutput?: (chunk: { stream: "stdout" | "stderr"; text: string }) => void;
    onProgress?: (event: WorkerExecutorProgressEvent) => void;
  }) => Promise<WorkerExecutorTurnHandle>;
  stopWorkerProcesses?: (input: {
    workerAgentReference: string;
  }) => Promise<boolean>;
}

/**
 * EN: Creates the default Hermes-backed worker executor adapter.
 * 中文: 创建默认的 Hermes worker executor 适配器。
 * @param runtimeConfig runtime configuration used to locate Hermes and skill roots.
 * @returns executor implementation used by ProductStore.
 */
export function createHermesWorkerExecutor(
  runtimeConfig: RuntimeConfig,
  input: { composioAdapter?: ComposioProviderAdapter } = {},
): WorkerExecutor {
  const configSource = resolveHermesConfigSource(runtimeConfig, input);
  const probeAbortController = new AbortController();
  const activeProbeOperations = new Set<Promise<ProductHermesStatus>>();
  let shutdownPromise: Promise<void> | null = null;

  /**
   * EN: Tracks status probes so executor shutdown can cancel and await their bounded settlement.
   * 中文: 跟踪状态探测，使 executor 关闭时能够取消并等待其有界结算。
   * @returns active Hermes status probe.
   */
  function runTrackedStatusProbe(): Promise<ProductHermesStatus> {
    const operation = probeHermesStatus(configSource, {
      signal: probeAbortController.signal,
    });
    activeProbeOperations.add(operation);
    void operation.then(
      () => activeProbeOperations.delete(operation),
      () => activeProbeOperations.delete(operation),
    );
    return operation;
  }

  /**
   * EN: Cancels active managed Hermes probes and waits until their runners settle.
   * 中文: 取消活跃的托管 Hermes 探测，并等待 runner 完成结算。
   * @returns shared idempotent shutdown promise.
   */
  function shutdownExecutor(): Promise<void> {
    if (shutdownPromise) {
      return shutdownPromise;
    }
    probeAbortController.abort();
    shutdownPromise = Promise.allSettled([...activeProbeOperations]).then(
      () => undefined,
    );
    return shutdownPromise;
  }

  return {
    kind: "hermes",
    skillScope: {
      runtimeHome: configSource.runtimeHome,
      profilesRoot: configSource.profilesRoot,
      skillsRoot: configSource.skillsRoot,
    },
    shutdown: shutdownExecutor,
    probeStatus: runTrackedStatusProbe,
    provisionAgent: async (input) => {
      const result = await provisionHermesAgent({
        workerId: input.workerId,
        workerName: input.workerName,
        configSource,
      });
      return {
        agentReference: result.agentReference,
        agentLabel: result.profileName,
        agentPath: result.profilePath,
        output: result.output,
      };
    },
    configureChannel: (input) =>
      configureHermesGatewayChannel({
        ...input,
        configSource,
      }),
    disconnectChannel: (input) =>
      disconnectHermesGatewayChannel({
        ...input,
        configSource,
      }),
    testChannel: (input) =>
      testHermesGatewayChannel({
        ...input,
        configSource,
      }),
    beginChannelSetup: (input) =>
      beginHermesGatewayChannelSetup({
        ...input,
        configSource,
      }),
    readChannelSetup: (input) =>
      readHermesGatewayChannelSetup({
        ...input,
        configSource,
      }),
    cancelChannelSetup: (input) =>
      cancelHermesGatewayChannelSetup({ ...input, configSource }),
    bindChannelConversation: (input) =>
      bindHermesGatewayConversation({
        ...input,
        configSource,
      }),
    approveChannelPairing: (input) =>
      approveHermesGatewayPairing({
        ...input,
        configSource,
      }),
    ensureChannelGateway: (input) =>
      ensureHermesGatewayRunning({ ...input, configSource }),
    listChannelPeers: (input) =>
      listHermesGatewayPeers({ ...input, configSource }),
    installSkill: (input) =>
      installHermesSkill({
        ...input,
        profilesRoot: configSource.profilesRoot,
        skillsRoot: configSource.skillsRoot,
      }),
    startTurn: (input) =>
      startHermesWorkerTurn({
        ...input,
        configSource,
      }),
    stopWorkerProcesses: (input) =>
      stopHermesWorkerProcesses({
        ...input,
        configSource,
      }),
  };
}

function resolveHermesConfigSource(
  runtimeConfig: RuntimeConfig,
  input: { composioAdapter?: ComposioProviderAdapter } = {},
): HermesConfigSource {
  return {
    label: "OysterWorkflow LLM config",
    llmConfigPath: runtimeConfig.llmConfigPath,
    codexEnvPath: runtimeConfig.codexEnvPath,
    commandPath: runtimeConfig.hermesCommandPath,
    browserActCommandPath: runtimeConfig.browserActCommandPath,
    runtimeHome: runtimeConfig.hermesRuntimeRoot,
    profilesRoot: runtimeConfig.hermesProfilesRoot,
    skillsRoot: runtimeConfig.hermesSkillsRoot,
    resolveMcpServers: input.composioAdapter
      ? async ({ integrationUserId }) => {
          if (!integrationUserId) {
            return [];
          }
          const server = await input.composioAdapter?.getMcpServer(
            integrationUserId,
            { allowMissing: true },
          );
          return server ? [server] : [];
        }
      : undefined,
  };
}
