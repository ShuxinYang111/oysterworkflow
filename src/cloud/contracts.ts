export type CloudAuthStatus =
  "loading" | "signed_out" | "oauth_pending" | "signed_in";

export interface CloudAuthUser {
  id: string;
  email: string;
  displayName: string | null;
  provider: string | null;
  createdAt: string | null;
}

export interface CloudAuthState {
  status: CloudAuthStatus;
  configured: boolean;
  user: CloudAuthUser | null;
  expiresAt: string | null;
}

export interface CloudEmailAuthInput {
  email: string;
  password: string;
  displayName?: string;
}

export interface CloudSignUpResponse {
  state: CloudAuthState;
  requiresEmailConfirmation: boolean;
  email: string;
}

export interface CloudAuthActionResponse {
  state: CloudAuthState;
}

export type CloudRuntimeRequestMethod =
  "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface CloudIpcRequestOptions {
  requestId: string;
  timeoutMs: number;
}

export interface CloudRuntimeRequestInput {
  path: string;
  method?: CloudRuntimeRequestMethod;
  body?: string | null;
  requestId?: string;
  timeoutMs?: number;
}

export interface CloudRuntimeRequestResponse {
  status: number;
  body: string;
}

export type CloudSyncPhase = "idle" | "syncing" | "synced" | "error";

export type CloudSyncMode = "pull" | "push";

export type CloudPortableEntityType = "device" | "worker";

export interface CloudSyncWarning {
  code: "invalid_remote_manifest";
  entityType: CloudPortableEntityType;
  entityId: string | null;
  message: string;
}

export interface CloudSyncResult {
  phase: "synced";
  firstLink: boolean;
  source: "cloud" | "local-push";
  pullMode: "unchanged" | "full" | "delta";
  revision: number;
  userId: string;
  deviceId: string;
  pulled: {
    devices: number;
    workers: number;
  };
  pushed: {
    workers: number;
  };
  syncedAt: string;
  warnings?: CloudSyncWarning[];
}

export interface WorkerManifestChannel {
  platform: "none" | "telegram" | "slack" | "weixin" | "whatsapp" | "wecom";
  label: string;
  accessMode: "disabled" | "allow_all" | "allowlist";
  homeChannel: string | null;
  allowedUsers: string[];
}

/**
 * EN: Portable AI Worker definition. It deliberately excludes device identity,
 * local credentials, browser state, runtime paths, and active sessions.
 * 中文: 可移植的 AI Worker 定义，明确排除设备身份、本机凭据、浏览器状态、
 * runtime 路径和活动 session。
 */
export interface WorkerManifest {
  schemaVersion: "oyster-worker-manifest-v1";
  workerId: string;
  name: string;
  initials: string;
  description: string;
  avatarKey: "marketing" | "product" | "finance" | "sales";
  config: {
    identityScope: string;
    runtimeProfile: string;
    toolAccess: string[];
    memoryContext: string;
    approvalPolicy: "allow_all";
    heartbeatPolicy: string;
    channel: WorkerManifestChannel;
  };
}

export interface CloudDeviceManifest {
  schemaVersion: "oyster-device-manifest-v1";
  deviceId: string;
  name: string;
  platform: string;
  runtimeVersion: string;
  capabilities: string[];
  lastSeenAt: string;
  revokedAt: string | null;
}

export interface CloudPortableMutationTokenSet {
  workerIds: Record<string, string>;
}

export interface CloudPortableMutationTokens {
  upserted: CloudPortableMutationTokenSet;
  deleted: CloudPortableMutationTokenSet;
}

export interface CloudPortableSnapshot {
  devices: CloudDeviceManifest[];
  workers: WorkerManifest[];
  upserted: {
    workerIds: string[];
  };
  deleted: {
    workerIds: string[];
  };
  /**
   * EN: Exact fingerprints for the local mutations represented by this export.
   * A later local edit must not be acknowledged by an older sync response.
   * 中文: 本次导出所代表的本地变更精确指纹；旧同步响应不得确认后续新改动。
   */
  mutationTokens?: CloudPortableMutationTokens;
}

export interface CloudAuthenticatedUser {
  id: string;
  email: string;
  displayName: string | null;
}
