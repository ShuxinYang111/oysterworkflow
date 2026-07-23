import type {
  CandidateWorkflow,
  OysterWorkflowGraph,
  WorkflowMergeProposal,
} from "../types/contracts.js";

export type ProductTone = "ready" | "warning" | "idle" | "working" | "danger";

export type ProductWorkerStatus =
  | "Available"
  | "Needs device"
  | "Setup needed"
  // EN: Legacy display statuses are normalized before new state is written.
  // 中文: 历史展示状态会在写入新状态前被规范化。
  | "No active task"
  | "Waiting for user"
  | "Blocked"
  | "Working"
  | "Training";

export type ProductInstalledWorkflowStatus = "Enabled" | "Paused";

export type ProductRunStatus =
  | "queued"
  | "running"
  | "waiting_for_user"
  | "blocked"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "paused";

export type ProductRunKind = "workflow" | "worker_session";

export type ProductAgentSessionStatus =
  "running" | "waiting_for_user" | "blocked" | "succeeded" | "failed";

export type ProductRunEventSource = "system" | "user" | "hermes" | "executor";

export type ProductApprovalPolicyScope = "worker" | "installed_workflow";

export type ProductCapabilityProviderId = "chrome" | "composio";

export type ProductCapabilityProviderKind = "browser" | "integrations";

export type ProductCapabilityProviderStatus =
  "not_checked" | "checking" | "ready" | "unavailable";

export type ProductWorkerChannelPlatform =
  "none" | "telegram" | "slack" | "weixin" | "whatsapp" | "wecom";

export type ProductWorkerChannelStatus =
  "not_configured" | "configured" | "testing" | "connected" | "failed";

export type ProductWorkerChannelAccessMode =
  "disabled" | "allow_all" | "allowlist";

export type ProductChannelConnectionStatus =
  | "not_configured"
  | "installing"
  | "awaiting_scan"
  | "authorizing"
  | "connecting"
  | "connected"
  | "degraded"
  | "failed"
  | "disconnected";

export type ProductChannelSetupStatus =
  | "starting"
  | "installing"
  | "awaiting_scan"
  | "authorizing"
  | "connected"
  | "failed"
  | "cancelled";

export type ProductChannelBindingStatus = "pending" | "bound" | "failed";

export interface ProductChannelConnection {
  id: string;
  workerId: string;
  platform: Exclude<ProductWorkerChannelPlatform, "none">;
  label: string;
  setupMethod: "bot_token" | "app_tokens" | "qr_link";
  status: ProductChannelConnectionStatus;
  accountLabel: string | null;
  hermesProfile: string;
  configuredFields: string[];
  missingFields: string[];
  lastCheckedAt: string | null;
  lastConnectedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProductChannelSetup {
  id: string;
  connectionId: string;
  workerId: string;
  platform: "weixin" | "whatsapp";
  status: ProductChannelSetupStatus;
  qrPayload: string | null;
  qrExpiresAt: string | null;
  accountLabel: string | null;
  processId: number | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProductChannelBinding {
  id: string;
  connectionId: string;
  workerId: string;
  platform: Exclude<ProductWorkerChannelPlatform, "none">;
  conversationId: string;
  threadId: string | null;
  conversationLabel: string | null;
  hermesProfile: string;
  hermesSessionId: string;
  status: ProductChannelBindingStatus;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProductChannelPeer {
  platform: Exclude<ProductWorkerChannelPlatform, "none">;
  conversationId: string;
  threadId: string | null;
  senderId: string | null;
  conversationType: string;
  discoveredSessionId: string;
  discoveredAt: string;
  bound: boolean;
}

export interface ProductAccount {
  id: string;
  name: string;
  email: string;
  workspaceId: string;
  signedInLabel: string;
  cloudProvider: string | null;
  cloudUserId: string | null;
  cloudSyncRevision: number;
  setupCompleted: boolean;
  updatedAt: string;
}

export interface ProductWorkspace {
  id: string;
  name: string;
  mode: "local" | "cloud-linked";
}

export interface ProductDevice {
  id: string;
  name: string;
  status: "Available now" | "Idle today" | "Needs attention";
  owner: string;
  assignedWorkerId: string | null;
  heartbeat: string;
  location: string;
  runtimeVersion: string;
  queue: string[];
}

export interface ProductAssignDeviceInput {
  workerId: string;
  deviceId: string;
}

export interface ProductAssignDeviceResponse {
  state: ProductState;
  worker: ProductWorker;
  device: ProductDevice;
}

export interface ProductWorkerConfig {
  identityScope: string;
  runtimeProfile: string;
  toolAccess: string[];
  memoryContext: string;
  approvalPolicy: "allow_all";
  heartbeatPolicy: string;
  hermesAgentReference: string;
  channel: ProductWorkerChannelConfig;
}

export interface ProductWorkerChannelConfig {
  platform: ProductWorkerChannelPlatform;
  label: string;
  accessMode: ProductWorkerChannelAccessMode;
  homeChannel: string | null;
  allowedUsers: string[];
  configuredFields: string[];
  missingFields: string[];
  status: ProductWorkerChannelStatus;
  lastTestedAt: string | null;
  lastError: string | null;
}

export interface ProductWorker {
  id: string;
  name: string;
  initials: string;
  description: string;
  status: ProductWorkerStatus;
  tone: ProductTone;
  avatarKey: "marketing" | "product" | "finance" | "sales";
  deviceId: string | null;
  selectedInstalledWorkflowId: string | null;
  heartbeat: string;
  activities: string[];
  config: ProductWorkerConfig;
}

export interface ProductCreateWorkerInput {
  name: string;
  description: string;
  channel?: ProductWorkerChannelInput;
  commandChannel?: string;
  sourceText?: string;
  mode: "new";
}

export interface ProductWorkerChannelInput {
  platform: ProductWorkerChannelPlatform;
  accessMode?: ProductWorkerChannelAccessMode;
  homeChannel?: string | null;
  allowedUsers?: string[];
  credentials?: Record<string, string>;
  mode?: "bot" | "self-chat";
  testAfterCreate?: boolean;
}

export interface ProductBeginChannelSetupInput {
  platform: "weixin" | "whatsapp";
  mode?: "bot" | "self-chat";
  allowedUsers?: string[];
}

export interface ProductBindChannelInput {
  connectionId: string;
  conversationId: string;
  threadId?: string | null;
  conversationType?: string | null;
  conversationLabel?: string | null;
  hermesSessionId?: string | null;
  deliveryConfirmed: boolean;
}

export interface ProductDisconnectChannelInput {
  connectionId: string;
}

export interface ProductApproveChannelPairingInput {
  connectionId: string;
  code: string;
}

export interface ProductChannelPairingApproval {
  platform: Exclude<ProductWorkerChannelPlatform, "none">;
  userId: string;
  userName: string | null;
}

export interface ProductCreateWorkerResponse {
  state: ProductState;
  worker: ProductWorker;
}

export interface ProductDeleteWorkerResponse {
  state: ProductState;
  worker: ProductWorker;
}

export interface ProductInstalledWorkflow {
  id: string;
  workerId: string;
  workflowId: string;
  workflowTitle: string;
  description: string;
  status: ProductInstalledWorkflowStatus;
  apps: string[];
  installedAt: string;
  deployTargetDeviceId: string | null;
  approvalPolicy: "allow_all";
  hermesSkillReference: string;
  hermesInstallReference: string;
  hermesSkillName: string;
  hermesSkillPath: string;
  sourceSkillPath: string | null;
  sourceWorkflowRevisionId: string | null;
  baselineRuns: number;
  baselineSuccesses: number;
  baselineLastRun: string;
  updateAvailable?: boolean;
}

export interface ProductWorkflowStats {
  uiEvents: number;
  ocrObservations: number;
  voiceNotes: number;
  duration: string;
  decisionPoints: number;
}

export interface ProductWorkflow {
  id: string;
  title: string;
  description: string;
  status:
    "Captured" | "Generated" | "Installable" | "Needs review" | "Needs context";
  sourceType: "demo" | "runtime" | "imported";
  sourceText?: string | null;
  confidence: number | null;
  apps: string[];
  stats: ProductWorkflowStats;
  detectedAt: string;
  artifactPath: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProductCreateWorkflowInput {
  mode: "new" | "import";
  title: string;
  description: string;
  apps: string[];
  sourceText?: string;
}

export interface ProductCreateWorkflowResponse {
  state: ProductState;
  workflow: ProductWorkflow;
}

export type ProductClawHubAuthStatus = "signed_out" | "signed_in";

export interface ProductClawHubAuthState {
  status: ProductClawHubAuthStatus;
  handle: string | null;
  siteUrl: string;
}

export interface ProductClawHubLoginStartResponse {
  loginId: string;
  verificationUrl: string;
  userCode: string;
  expiresAt: string;
}

export interface ProductClawHubLoginStatusResponse {
  loginId: string;
  status: "pending" | "authorized" | "failed";
  auth: ProductClawHubAuthState;
  error: string | null;
}

export interface ProductClawHubPublishResponse {
  status: "unchanged" | "published";
  ownerHandle: string;
  slug: string;
  version: string;
  listingUrl: string;
  installCommand: string;
}

export interface ProductCaptureSession {
  id: string;
  labSessionId: string;
  sessionPath: string;
  artifactRoot: string;
  status: "recording" | "captured" | "generated" | "failed" | "interrupted";
  title: string;
  latestRunId: string | null;
  latestRunDir: string | null;
  ingestSummaryPath: string | null;
  workflowDiscoveryPath: string | null;
  selectedWorkflowId: string | null;
  skillPath: string | null;
  stats: ProductWorkflowStats;
  artifactMissing: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProductArtifact {
  id: string;
  captureSessionId: string;
  kind:
    | "session"
    | "ingest-summary"
    | "workflow-discovery"
    | "skill"
    | "skill-summary"
    | "workflow-candidate"
    | "workflow-family-match"
    | "workflow-merge-proposal"
    | "workflow-graph"
    | "workflow-markdown"
    | "workflow-revisions"
    | "planner-skill"
    | "planner-summary";
  path: string;
  status: "available" | "missing";
  sizeBytes: number | null;
  updatedAt: string;
}

export interface ProductPermissionItem {
  kind:
    "screen-recording" | "accessibility" | "input-monitoring" | "microphone";
  label: string;
  description: string;
  state: "granted" | "missing" | "unknown";
  detail: string;
}

export interface ProductPermissionSnapshot {
  checkedAt: string;
  allGranted: boolean;
  canStartRecording: boolean;
  source: "host-app" | "screenpipe-probe" | "existing-recorder" | "not-needed";
  summary: string;
  items: ProductPermissionItem[];
}

export interface ProductRun {
  id: string;
  workerId: string;
  installedWorkflowId: string;
  workflowTitle: string;
  kind?: ProductRunKind;
  status: ProductRunStatus;
  command: string | null;
  startedAt: string;
  endedAt: string | null;
  hermesSessionId: string | null;
  errorMessage: string | null;
}

export interface ProductRunEvent {
  id: string;
  runId: string;
  workerId: string;
  source: ProductRunEventSource;
  status: string;
  body: string;
  createdAt: string;
}

export interface ProductCommand {
  id: string;
  runId: string;
  workerId: string;
  command: string;
  source: "agent_chat" | "api" | "wechat";
  status: "accepted" | "rejected";
  createdAt: string;
  errorMessage: string | null;
}

export interface ProductApprovalPolicy {
  id: string;
  scopeType: ProductApprovalPolicyScope;
  scopeId: string;
  mode: "allow_all";
  description: string;
  updatedAt: string;
}

export interface ProductWorkflowTombstone {
  workflowId: string;
  workflowTitle: string;
  deletedAt: string;
  deletedByAccountId: string;
}

export type ProductCloudDeleteEntityType = "worker";

/**
 * EN: Durable local deletion intent awaiting acknowledgement from Supabase.
 * 中文: 等待 Supabase 确认的本地持久化删除意图。
 */
export interface ProductCloudDelete {
  entityType: ProductCloudDeleteEntityType;
  entityId: string;
  deletedAt: string;
}

/**
 * EN: Durable local portable-record change awaiting a cloud upsert.
 * 中文: 等待上传到云端的本地可移植记录变更。
 */
export interface ProductCloudUpsert {
  entityType: ProductCloudDeleteEntityType;
  entityId: string;
  updatedAt: string;
}

export type ProductHermesProviderConnectionStatus =
  "unknown" | "connected" | "degraded";

export interface ProductHermesProviderHealth {
  status: ProductHermesProviderConnectionStatus;
  kind: string | null;
  recoverability: string | null;
  provider: string | null;
  model: string | null;
  message: string | null;
  retryable: boolean | null;
  retryCount: number | null;
  maxRetries: number | null;
  statusCode: number | null;
  checkedAt: string | null;
}

export interface ProductHermesStatus {
  command: string;
  available: boolean;
  model: string | null;
  provider: string | null;
  providerHealth: ProductHermesProviderHealth;
  enabledToolsets: string[];
  missingComputerUseToolsets: string[];
  computerUseReady: boolean;
  computerUseSummary: string | null;
  configSource: string | null;
  configPath: string | null;
  runtimeHome: string | null;
  lastCheckedAt: string | null;
  lastProbeSessionId: string | null;
  lastError: string | null;
}

export interface ProductCapabilityProvider {
  id: ProductCapabilityProviderId;
  kind: ProductCapabilityProviderKind;
  label: string;
  description: string;
  status: ProductCapabilityProviderStatus;
  enabled: boolean;
  required: boolean;
  installed: boolean;
  version: string | null;
  pinnedVersion: string | null;
  commandPath: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  lastSuccessAt: string | null;
  detail: string | null;
}

export interface ProductState {
  schemaVersion: 1;
  account: ProductAccount;
  workspace: ProductWorkspace;
  permissionSnapshot: ProductPermissionSnapshot | null;
  devices: ProductDevice[];
  workers: ProductWorker[];
  channelConnections: ProductChannelConnection[];
  channelSetups: ProductChannelSetup[];
  channelBindings: ProductChannelBinding[];
  workflows: ProductWorkflow[];
  captureSessions: ProductCaptureSession[];
  artifacts: ProductArtifact[];
  installedWorkflows: ProductInstalledWorkflow[];
  runs: ProductRun[];
  runEvents: ProductRunEvent[];
  commands: ProductCommand[];
  approvalPolicies: ProductApprovalPolicy[];
  workflowTombstones: ProductWorkflowTombstone[];
  pendingCloudUpserts: ProductCloudUpsert[];
  pendingCloudDeletes: ProductCloudDelete[];
  hermes: ProductHermesStatus;
  capabilityProviders: ProductCapabilityProvider[];
  updatedAt: string;
}

export interface ProductStateResponse {
  state: ProductState;
}

export interface ProductWorkflowGraphResponse {
  workflowId: string;
  canonicalGraph: OysterWorkflowGraph | null;
  mergeBaseGraph: OysterWorkflowGraph | null;
  candidate: CandidateWorkflow | null;
  mergeProposal: WorkflowMergeProposal | null;
  mergeStatus: "ready" | "applied" | "stale" | null;
  paths: {
    graphPath: string | null;
    mergeBaseGraphPath: string | null;
    candidatePath: string | null;
    mergeProposalPath: string | null;
  };
  errors: Array<{
    artifact: "canonical" | "candidate" | "merge-proposal" | "merge-base";
    message: string;
  }>;
}

export type ProductWorkflowGraphNodeEditTarget =
  | { kind: "node"; id: string; type: "action" }
  | { kind: "node"; id: string; type: "decision" }
  | { kind: "node"; id: string; type: "wait" }
  | { kind: "node"; id: string; type: "terminal" };

export type ProductWorkflowGraphTransitionEditTarget =
  | { kind: "transition"; id: string; type: "conditional" }
  | { kind: "transition"; id: string; type: "resume" }
  | { kind: "transition"; id: string; type: "retry" };

export type ProductWorkflowGraphEditInput =
  | {
      expectedRevisionId: string;
      target: Extract<ProductWorkflowGraphNodeEditTarget, { type: "action" }>;
      patch: {
        title?: string;
        objective?: string;
        act?: string[];
        operationApp?: string;
        hints?: string[];
      };
    }
  | {
      expectedRevisionId: string;
      target: Extract<ProductWorkflowGraphNodeEditTarget, { type: "decision" }>;
      patch: { title?: string; decision?: string; hints?: string[] };
    }
  | {
      expectedRevisionId: string;
      target: Extract<ProductWorkflowGraphNodeEditTarget, { type: "wait" }>;
      patch: {
        title?: string;
        waitFor?: string;
        resumeCondition?: string;
        hints?: string[];
      };
    }
  | {
      expectedRevisionId: string;
      target: Extract<ProductWorkflowGraphNodeEditTarget, { type: "terminal" }>;
      patch: {
        title?: string;
        outcome?: "completed" | "stopped" | "rejected" | "failed";
        summary?: string;
        hints?: string[];
      };
    }
  | {
      expectedRevisionId: string;
      target: Extract<
        ProductWorkflowGraphTransitionEditTarget,
        { type: "conditional" | "resume" }
      >;
      patch: { when?: string };
    }
  | {
      expectedRevisionId: string;
      target: Extract<
        ProductWorkflowGraphTransitionEditTarget,
        { type: "retry" }
      >;
      patch: { when?: string; maxAttempts?: number };
    };

export interface ProductWorkflowGraphEditResponse {
  state: ProductState;
  workflowId: string;
  canonicalGraph: OysterWorkflowGraph;
  graphPath: string;
}

export interface ProductApplyWorkflowMergeResponse {
  state: ProductState;
  sourceWorkflowId: string;
  canonicalProductWorkflowId: string;
  canonicalGraph: OysterWorkflowGraph;
  graphPath: string;
  alreadyApplied: boolean;
}

export interface ProductWorkflowMergeTarget {
  workflowId: string;
  title: string;
  description: string;
  revisionNumber: number;
  revisionId: string;
}

export interface ProductPendingWorkflowMerge {
  sourceWorkflowId: string;
  sourceTitle: string;
  sourceDescription: string;
  proposalId: string;
  proposalHash: string;
  targets: ProductWorkflowMergeTarget[];
  recommendedTargetWorkflowId: string;
}

export interface ProductPendingWorkflowMergesResponse {
  items: ProductPendingWorkflowMerge[];
}

export interface ProductCreateNewWorkflowDecisionResponse {
  state: ProductState;
  sourceWorkflowId: string;
  decision: "create_new";
}

export interface ProductWorkflowVersion {
  revisionId: string;
  revisionNumber: number;
  previousRevisionId: string | null;
  createdAt: string;
  contentHash: string;
  isCurrent: boolean;
}

export interface ProductWorkflowVersionsResponse {
  workflowId: string;
  workflowTitle: string;
  currentRevisionId: string;
  versions: ProductWorkflowVersion[];
}

export interface ProductRestoreWorkflowVersionResponse {
  state: ProductState;
  workflowId: string;
  restoredFromRevisionId: string;
  canonicalGraph: OysterWorkflowGraph;
  graphPath: string;
}

export interface ProductCapabilityProviderCheckResponse {
  state: ProductState;
  provider: ProductCapabilityProvider;
}

export type ProductComposioApiKeySource =
  "hosted" | "local_file" | "environment" | "none";

export type ProductComposioToolkitFilter =
  "all" | "connected" | "not_connected";

export interface ProductComposioFeatureStatus {
  unrestrictedToolkits: true;
  dynamicDiscovery: true;
  fullToolCatalog: true;
  remoteSandbox: true;
  mcp: true;
}

export interface ProductComposioProviderStatus {
  id: "composio";
  configured: boolean;
  apiKeySource: ProductComposioApiKeySource;
  sessionReady: boolean;
  sessionId: string | null;
  lastError: string | null;
  features: ProductComposioFeatureStatus;
}

export interface ProductComposioConnection {
  id: string;
  toolkitSlug: string;
  status: string;
  alias: string | null;
  statusReason: string | null;
  isDisabled: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ProductComposioToolkit {
  slug: string;
  name: string;
  logo: string | null;
  noAuth: boolean;
  connected: boolean;
  connections: ProductComposioConnection[];
}

export interface ProductComposioOverviewResponse {
  provider: ProductComposioProviderStatus;
  items: ProductComposioToolkit[];
  nextCursor: string | null;
  totalPages: number;
}

export interface ProductComposioAuthorizeInput {
  alias?: string | null;
  toolkitName?: string;
  language?: "en" | "zh";
}

export interface ProductComposioAuthorizeResponse {
  connectionId: string;
  redirectUrl: string;
  status: string;
}

export interface ProductComposioConnectionResponse {
  connection: ProductComposioConnection;
}

export interface ProductComposioDisconnectResponse {
  disconnected: true;
  connectionId: string;
}

export interface ProductInstallWorkflowInput {
  workerId: string;
  workflowId: string;
  workflowTitle: string;
  description: string;
  apps: string[];
  deployTargetDeviceId?: string | null;
  skillPath?: string | null;
}

export interface ProductAccountSetupInput {
  name: string;
  email: string;
  workspaceName: string;
}

export interface ProductWorkerConfigInput {
  identityScope: string;
  runtimeProfile: string;
  toolAccess: string[];
  memoryContext: string;
  approvalPolicy: "allow_all";
  heartbeatPolicy: string;
  hermesAgentReference: string;
  channel?: ProductWorkerChannelConfig;
}

export interface ProductDeleteWorkflowInput {
  workflowId: string;
  workflowTitle: string;
}

export interface ProductInstallWorkflowResponse {
  state: ProductState;
  installedWorkflow: ProductInstalledWorkflow;
}

export interface ProductDeleteWorkflowResponse {
  state: ProductState;
  tombstone: ProductWorkflowTombstone;
}

export interface ProductDeleteInstalledWorkflowResponse {
  state: ProductState;
  installedWorkflow: ProductInstalledWorkflow;
}

export interface ProductAccountSetupResponse {
  state: ProductState;
}

export interface ProductWorkerConfigResponse {
  state: ProductState;
  worker: ProductWorker;
}

export interface ProductWorkerChannelTestResponse {
  state: ProductState;
  worker: ProductWorker;
  channel: ProductWorkerChannelConfig;
}

export interface ProductWorkerChannelConfigureResponse {
  state: ProductState;
  worker: ProductWorker;
  channel: ProductWorkerChannelConfig;
}

export interface ProductChannelSetupResponse {
  state: ProductState;
  connection: ProductChannelConnection;
  setup: ProductChannelSetup;
}

export interface ProductChannelBindingResponse {
  state: ProductState;
  connection: ProductChannelConnection;
  binding: ProductChannelBinding;
}

export interface ProductDisconnectChannelResponse {
  state: ProductState;
  connection: ProductChannelConnection;
}

export interface ProductApproveChannelPairingResponse {
  state: ProductState;
  connection: ProductChannelConnection;
  approval: ProductChannelPairingApproval;
}

export interface ProductChannelPeersResponse {
  peers: ProductChannelPeer[];
}

export interface ProductStartWorkerResponse {
  state: ProductState;
  worker: ProductWorker;
}

export interface ProductRunWorkflowResponse {
  state: ProductState;
  run: ProductRun;
}

export interface ProductCommandResponse {
  state: ProductState;
  run: ProductRun;
  event: ProductRunEvent;
  commandRecord: ProductCommand;
}
