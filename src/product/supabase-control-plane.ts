import { createHash } from "node:crypto";
import { hostname, platform } from "node:os";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  OYSTER_SUPABASE_PUBLISHABLE_KEY,
  OYSTER_SUPABASE_URL,
} from "../cloud/config.js";
import { createDeadlineFetch } from "../cloud/bounded-fetch.js";
import type {
  CloudAuthenticatedUser,
  CloudDeviceManifest,
  CloudPortableEntityType,
  CloudPortableSnapshot,
  CloudSyncMode,
  CloudSyncResult,
  CloudSyncWarning,
} from "../cloud/contracts.js";
import type { RuntimeConfig } from "../runtime/config.js";
import type { ProductStore } from "./store.js";

interface SupabaseControlPlaneInput {
  accessToken: string;
  authenticatedUser: CloudAuthenticatedUser;
  productStore: ProductStore;
  runtimeConfig: RuntimeConfig;
  mode?: CloudSyncMode;
  client?: SupabaseClient;
  remoteRequestTimeoutMs?: number;
}

interface ManifestRow {
  manifest: unknown;
  device_id?: string;
  worker_id?: string;
}

interface VersionedManifestRow extends ManifestRow {
  deleted_at: string | null;
  sync_revision: number;
  worker_id?: string;
}

interface RemoteSnapshotReadResult {
  snapshot: CloudPortableSnapshot;
  warnings: CloudSyncWarning[];
}

interface ParsedManifestRows<T> {
  active: T[];
  warnings: CloudSyncWarning[];
}

export interface CloudSyncPlan {
  source: CloudSyncResult["source"];
  pushLocal: boolean;
  replaceLocal: boolean;
}

interface CloudSyncAttempt {
  generation: number;
  userId: string;
}

const activeCloudSyncAttempts = new WeakMap<ProductStore, CloudSyncAttempt>();
const cloudSyncRemoteQueues = new WeakMap<
  ProductStore,
  Map<string, Promise<void>>
>();
const DEFAULT_CLOUD_CONTROL_PLANE_TIMEOUT_MS = 90_000;

class CloudControlPlaneDeadlineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudControlPlaneDeadlineError";
  }
}

const workerManifestSchema = z.object({
  schemaVersion: z.literal("oyster-worker-manifest-v1"),
  workerId: z.string().min(1),
  name: z.string().min(1),
  initials: z.string(),
  description: z.string(),
  avatarKey: z.enum(["marketing", "product", "finance", "sales"]),
  config: z.object({
    identityScope: z.string(),
    runtimeProfile: z.string(),
    toolAccess: z.array(z.string()),
    memoryContext: z.string(),
    approvalPolicy: z.literal("allow_all"),
    heartbeatPolicy: z.string(),
    channel: z.object({
      platform: z.enum([
        "none",
        "telegram",
        "slack",
        "weixin",
        "whatsapp",
        "wecom",
      ]),
      label: z.string(),
      accessMode: z.enum(["disabled", "allow_all", "allowlist"]),
      homeChannel: z.string().nullable(),
      allowedUsers: z.array(z.string()),
    }),
  }),
});

const deviceManifestSchema = z.object({
  schemaVersion: z.literal("oyster-device-manifest-v1"),
  deviceId: z.string().min(1),
  name: z.string().min(1),
  platform: z.string().min(1),
  runtimeVersion: z.string().min(1),
  capabilities: z.array(z.string()),
  lastSeenAt: z.string(),
  revokedAt: z.string().nullable(),
});

/**
 * EN: Synchronizes local portable AI Worker state through Supabase under RLS.
 * 中文: 在 Supabase RLS 保护下同步本机可移植 AI Worker 状态。
 */
export async function syncProductControlPlane(
  input: SupabaseControlPlaneInput,
): Promise<CloudSyncResult> {
  if (!input.accessToken.trim()) {
    throw new Error("Missing Supabase access token.");
  }
  const timeoutMs = normalizeCloudControlPlaneTimeout(
    input.remoteRequestTimeoutMs,
  );
  const client =
    input.client ?? createAuthenticatedClient(input.accessToken, timeoutMs);
  const user = await runWithCloudControlPlaneDeadline(
    timeoutMs,
    "verifying the Supabase session / 验证 Supabase 会话",
    (signal) => readAuthenticatedUser(client, input.accessToken, signal),
  );
  if (user.id !== input.authenticatedUser.id) {
    throw new Error(
      "The Supabase session changed while cloud sync was starting. / 云同步启动时 Supabase 会话已发生变化。",
    );
  }
  const attempt = beginCloudSyncAttempt(input.productStore, user.id);
  try {
    return await serializeCloudSyncRemoteEffects(
      input.productStore,
      user.id,
      () =>
        runWithCloudControlPlaneDeadline(
          timeoutMs,
          "synchronizing the cloud control plane / 同步云控制面",
          async (signal) => {
            assertCurrentCloudSyncAttempt(input.productStore, attempt);
            throwIfCloudSyncAborted(signal);
            const localState = await input.productStore.getState();
            const firstLink = localState.account.cloudUserId !== user.id;
            const accountSwitch =
              localState.account.cloudUserId !== null && firstLink;
            let expectedCloudUserIdForFinal = localState.account.cloudUserId;
            const localDevice = buildLocalDeviceManifest(
              input.runtimeConfig,
              input.productStore.getInstallationId(),
            );
            const mode = input.mode ?? "pull";

            if (accountSwitch) {
              throwIfCloudSyncAborted(signal);
              await input.productStore.applyCloudSnapshot({
                snapshot: emptyCloudPortableSnapshot(),
                user,
                localDeviceId: localDevice.deviceId,
                replacePortableState: true,
                syncRevision: -1,
                expectedCloudUserId: localState.account.cloudUserId,
                isCurrentCloudSyncAttempt: () =>
                  isCurrentCloudSyncAttempt(input.productStore, attempt),
              });
              expectedCloudUserIdForFinal = user.id;
            }
            assertCurrentCloudSyncAttempt(input.productStore, attempt);
            throwIfCloudSyncAborted(signal);
            const plan = resolveCloudSyncPlan(mode, firstLink);

            await upsertDevice(client, user.id, localDevice, signal);
            assertCurrentCloudSyncAttempt(input.productStore, attempt);
            throwIfCloudSyncAborted(signal);
            const localSnapshot =
              await input.productStore.exportCloudSnapshot();
            let pushed = { workers: 0 };
            const hasPendingChanges = snapshotHasPendingChanges(localSnapshot);
            const flushedLocalChanges =
              !firstLink && (plan.pushLocal || hasPendingChanges);
            if (flushedLocalChanges) {
              pushed = await pushPortableChanges(
                client,
                user.id,
                localSnapshot,
                signal,
              );
              assertCurrentCloudSyncAttempt(input.productStore, attempt);
              throwIfCloudSyncAborted(signal);
            }

            const headRevision = await readCloudHeadRevision(
              client,
              user.id,
              signal,
            );
            assertCurrentCloudSyncAttempt(input.productStore, attempt);
            throwIfCloudSyncAborted(signal);
            const localRevision = firstLink
              ? -1
              : localState.account.cloudSyncRevision;
            const pullMode = resolvePullMode(
              localRevision,
              headRevision,
              firstLink,
            );
            const remoteRead =
              pullMode === "full"
                ? await readRemoteSnapshot(client, user.id, signal)
                : pullMode === "delta"
                  ? await readRemoteSnapshotSince(
                      client,
                      user.id,
                      localRevision,
                      headRevision,
                      signal,
                    )
                  : await readRemoteDevicesOnly(client, user.id, signal);
            assertCurrentCloudSyncAttempt(input.productStore, attempt);
            throwIfCloudSyncAborted(signal);
            const remoteAfter = remoteRead.snapshot;
            await input.productStore.applyCloudSnapshot({
              snapshot: remoteAfter,
              user,
              localDeviceId: localDevice.deviceId,
              replacePortableState: pullMode === "full",
              syncRevision: headRevision,
              expectedCloudUserId: expectedCloudUserIdForFinal,
              isCurrentCloudSyncAttempt: () =>
                isCurrentCloudSyncAttempt(input.productStore, attempt),
              acknowledgedCloudMutationTokens: flushedLocalChanges
                ? localSnapshot.mutationTokens
                : undefined,
            });

            return {
              phase: "synced",
              firstLink,
              source: plan.source,
              pullMode,
              revision: headRevision,
              userId: user.id,
              deviceId: localDevice.deviceId,
              pulled: {
                devices: remoteAfter.devices.length,
                workers:
                  remoteAfter.workers.length +
                  remoteAfter.deleted.workerIds.length,
              },
              pushed,
              syncedAt: new Date().toISOString(),
              warnings: remoteRead.warnings,
            };
          },
        ),
    );
  } catch (error) {
    if (error instanceof CloudControlPlaneDeadlineError) {
      supersedeCloudSyncAttempt(input.productStore, attempt);
    }
    throw error;
  }
}

/**
 * EN: Starts a latest-wins sync attempt for one ProductStore instance.
 * 中文: 为一个 ProductStore 实例启动“最新请求优先”的同步尝试。
 * @param productStore local account state owner.
 * @param userId identity captured before remote work begins.
 * @returns immutable generation token for stale-request checks.
 */
function beginCloudSyncAttempt(
  productStore: ProductStore,
  userId: string,
): CloudSyncAttempt {
  const current = activeCloudSyncAttempts.get(productStore);
  if (current?.userId === userId) {
    return current;
  }
  const generation = (current?.generation ?? 0) + 1;
  const attempt = { generation, userId };
  activeCloudSyncAttempts.set(productStore, attempt);
  return attempt;
}

function supersedeCloudSyncAttempt(
  productStore: ProductStore,
  attempt: CloudSyncAttempt,
): void {
  const current = activeCloudSyncAttempts.get(productStore);
  if (
    current?.generation !== attempt.generation ||
    current.userId !== attempt.userId
  ) {
    return;
  }
  activeCloudSyncAttempts.set(productStore, {
    generation: current.generation + 1,
    userId: current.userId,
  });
}

/**
 * EN: Stops an older sync from applying after another identity starts.
 * 中文: 阻止旧同步在另一个身份启动后继续落盘。
 * @param productStore local account state owner.
 * @param attempt generation token captured at request start.
 * @returns void while the attempt remains current.
 */
function assertCurrentCloudSyncAttempt(
  productStore: ProductStore,
  attempt: CloudSyncAttempt,
): void {
  if (!isCurrentCloudSyncAttempt(productStore, attempt)) {
    throw new Error(
      "Cloud sync was superseded by a newer signed-in account. / 云同步已被更新的登录账号取代。",
    );
  }
}

/**
 * EN: Checks whether a sync attempt still owns the ProductStore mutation slot.
 * 中文: 检查同步尝试是否仍持有 ProductStore 变更槽位。
 * @param productStore local account state owner.
 * @param attempt generation token captured at request start.
 * @returns true only for the newest attempt and identity.
 */
function isCurrentCloudSyncAttempt(
  productStore: ProductStore,
  attempt: CloudSyncAttempt,
): boolean {
  const current = activeCloudSyncAttempts.get(productStore);
  return Boolean(
    current?.generation === attempt.generation &&
    current.userId === attempt.userId,
  );
}

/**
 * EN: Serializes remote effects for one account while preserving cross-account
 * latest-wins cancellation through the generation guard.
 * 中文: 串行化同一账号的远端副作用，同时保留跨账号的最新请求优先取消语义。
 * @param productStore local durable state owner.
 * @param userId authoritative Supabase user id.
 * @param callback remote sync transaction to execute in order.
 * @returns callback result after earlier same-account effects finish.
 */
async function serializeCloudSyncRemoteEffects<T>(
  productStore: ProductStore,
  userId: string,
  callback: () => Promise<T>,
): Promise<T> {
  let accountQueues = cloudSyncRemoteQueues.get(productStore);
  if (!accountQueues) {
    accountQueues = new Map<string, Promise<void>>();
    cloudSyncRemoteQueues.set(productStore, accountQueues);
  }
  const previous = accountQueues.get(userId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  const tail = previous.catch(() => undefined).then(() => gate);
  accountQueues.set(userId, tail);
  await previous.catch(() => undefined);
  try {
    return await callback();
  } finally {
    release();
    if (accountQueues.get(userId) === tail) {
      accountQueues.delete(userId);
    }
  }
}

export function resolvePullMode(
  localRevision: number,
  headRevision: number,
  firstLink: boolean,
): CloudSyncResult["pullMode"] {
  if (firstLink || localRevision < 0 || localRevision > headRevision) {
    return "full";
  }
  return localRevision === headRevision ? "unchanged" : "delta";
}

/**
 * EN: Resolves sync direction before any cloud mutation occurs.
 * 中文: 在执行任何云端写入前确定同步方向。
 * @param mode pull on login/startup, push only after an authenticated local mutation.
 * @param firstLink whether this local database has already linked the authenticated user.
 * @returns explicit plan that keeps Supabase authoritative on startup.
 */
export function resolveCloudSyncPlan(
  mode: CloudSyncMode,
  firstLink: boolean,
): CloudSyncPlan {
  if (mode === "push" && firstLink) {
    throw new Error(
      "Pull the signed-in account before pushing local AI worker changes.",
    );
  }
  return {
    source: mode === "push" ? "local-push" : "cloud",
    pushLocal: mode === "push",
    replaceLocal: true,
  };
}

function createAuthenticatedClient(
  accessToken: string,
  timeoutMs: number,
): SupabaseClient {
  return createClient(OYSTER_SUPABASE_URL, OYSTER_SUPABASE_PUBLISHABLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      fetch: createDeadlineFetch({
        timeoutMs,
        timeoutMessage:
          "The Supabase control-plane network request timed out. / Supabase 控制面网络请求超时。",
      }),
    },
  });
}

function normalizeCloudControlPlaneTimeout(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_CLOUD_CONTROL_PLANE_TIMEOUT_MS;
  }
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("Cloud control-plane timeout must be positive.");
  }
  return Math.floor(value);
}

async function runWithCloudControlPlaneDeadline<T>(
  timeoutMs: number,
  label: string,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new CloudControlPlaneDeadlineError(
        `Timed out while ${label}. Try again. / ${label}超时，请重试。`,
      );
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function throwIfCloudSyncAborted(signal: AbortSignal): void {
  if (!signal.aborted) {
    return;
  }
  throw (
    signal.reason ??
    new CloudControlPlaneDeadlineError(
      "Cloud control-plane sync was cancelled. / 云控制面同步已取消。",
    )
  );
}

async function awaitRemoteOperation<T>(
  operation: PromiseLike<T>,
  signal: AbortSignal,
): Promise<T> {
  throwIfCloudSyncAborted(signal);
  const abortable = operation as PromiseLike<T> & {
    abortSignal?: (abortSignal: AbortSignal) => PromiseLike<T>;
  };
  const pending =
    typeof abortable.abortSignal === "function"
      ? abortable.abortSignal(signal)
      : operation;
  let rejectAbort: ((reason?: unknown) => void) | null = null;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const handleAbort = () => {
    rejectAbort?.(
      signal.reason ??
        new CloudControlPlaneDeadlineError(
          "Cloud control-plane sync was cancelled. / 云控制面同步已取消。",
        ),
    );
  };
  signal.addEventListener("abort", handleAbort, { once: true });
  try {
    return await Promise.race([Promise.resolve(pending), aborted]);
  } finally {
    signal.removeEventListener("abort", handleAbort);
  }
}

async function readAuthenticatedUser(
  client: SupabaseClient,
  accessToken: string,
  signal: AbortSignal,
): Promise<CloudAuthenticatedUser> {
  const { data, error } = await awaitRemoteOperation(
    client.auth.getUser(accessToken),
    signal,
  );
  if (error || !data.user) {
    throw new Error(error?.message ?? "Supabase rejected the current session.");
  }
  const metadata = data.user.user_metadata;
  return {
    id: data.user.id,
    email: data.user.email ?? "",
    displayName: optionalString(
      metadata.display_name ?? metadata.full_name ?? metadata.name,
    ),
  };
}

async function readRemoteSnapshot(
  client: SupabaseClient,
  ownerId: string,
  signal: AbortSignal,
): Promise<RemoteSnapshotReadResult> {
  const [devices, workers] = await Promise.all([
    awaitRemoteOperation(
      client
        .from("devices")
        .select("device_id,manifest")
        .eq("owner_id", ownerId)
        .is("revoked_at", null),
      signal,
    ),
    awaitRemoteOperation(
      client
        .from("ai_workers")
        .select("worker_id,manifest")
        .eq("owner_id", ownerId)
        .is("deleted_at", null),
      signal,
    ),
  ]);
  throwQueryError(devices.error);
  throwQueryError(workers.error);
  const parsedDevices = parseRows(
    devices.data,
    "device",
    "device_id",
    deviceManifestSchema,
  );
  const parsedWorkers = parseRows(
    workers.data,
    "worker",
    "worker_id",
    workerManifestSchema,
  );
  return {
    snapshot: {
      devices: parsedDevices.active,
      workers: parsedWorkers.active,
      upserted: emptyCloudChangeIds(),
      deleted: emptyCloudChangeIds(),
    },
    warnings: [...parsedDevices.warnings, ...parsedWorkers.warnings],
  };
}

async function readRemoteSnapshotSince(
  client: SupabaseClient,
  ownerId: string,
  afterRevision: number,
  headRevision: number,
  signal: AbortSignal,
): Promise<RemoteSnapshotReadResult> {
  const [devices, workers] = await Promise.all([
    readActiveDevices(client, ownerId, signal),
    awaitRemoteOperation(
      client
        .from("ai_workers")
        .select("worker_id,manifest,deleted_at,sync_revision")
        .eq("owner_id", ownerId)
        .gt("sync_revision", afterRevision)
        .lte("sync_revision", headRevision),
      signal,
    ),
  ]);
  throwQueryError(workers.error);
  const workerChanges = parseVersionedRows(
    workers.data,
    "worker",
    "worker_id",
    workerManifestSchema,
  );
  return {
    snapshot: {
      devices: devices.active,
      workers: workerChanges.active,
      upserted: {
        workerIds: workerChanges.activeIds,
      },
      deleted: {
        workerIds: workerChanges.deletedIds,
      },
    },
    warnings: [...devices.warnings, ...workerChanges.warnings],
  };
}

async function readRemoteDevicesOnly(
  client: SupabaseClient,
  ownerId: string,
  signal: AbortSignal,
): Promise<RemoteSnapshotReadResult> {
  const devices = await readActiveDevices(client, ownerId, signal);
  return {
    snapshot: {
      devices: devices.active,
      workers: [],
      upserted: emptyCloudChangeIds(),
      deleted: emptyCloudChangeIds(),
    },
    warnings: devices.warnings,
  };
}

async function readActiveDevices(
  client: SupabaseClient,
  ownerId: string,
  signal: AbortSignal,
): Promise<ParsedManifestRows<CloudDeviceManifest>> {
  const query = await awaitRemoteOperation(
    client
      .from("devices")
      .select("device_id,manifest")
      .eq("owner_id", ownerId)
      .is("revoked_at", null),
    signal,
  );
  throwQueryError(query.error);
  return parseRows(query.data, "device", "device_id", deviceManifestSchema);
}

async function readCloudHeadRevision(
  client: SupabaseClient,
  ownerId: string,
  signal: AbortSignal,
): Promise<number> {
  const { data, error } = await awaitRemoteOperation(
    client
      .from("workspace_sync_state")
      .select("revision")
      .eq("owner_id", ownerId)
      .maybeSingle(),
    signal,
  );
  throwQueryError(error);
  const revision = data?.revision;
  return typeof revision === "number" && Number.isFinite(revision)
    ? revision
    : 0;
}

async function upsertDevice(
  client: SupabaseClient,
  ownerId: string,
  device: CloudDeviceManifest,
  signal: AbortSignal,
): Promise<void> {
  const { error } = await awaitRemoteOperation(
    client.from("devices").upsert(
      {
        owner_id: ownerId,
        device_id: device.deviceId,
        name: device.name,
        platform: device.platform,
        runtime_version: device.runtimeVersion,
        manifest: device,
        last_seen_at: device.lastSeenAt,
      },
      { onConflict: "owner_id,device_id" },
    ),
    signal,
  );
  throwQueryError(error);
}

async function pushPortableChanges(
  client: SupabaseClient,
  ownerId: string,
  snapshot: CloudPortableSnapshot,
  signal: AbortSignal,
): Promise<CloudSyncResult["pushed"]> {
  const workersById = new Map(
    snapshot.workers.map((manifest) => [manifest.workerId, manifest]),
  );
  const changedWorkers = snapshot.upserted.workerIds.flatMap((id) => {
    const manifest = workersById.get(id);
    return manifest ? [manifest] : [];
  });

  if (changedWorkers.length > 0) {
    const { error } = await awaitRemoteOperation(
      client.from("ai_workers").upsert(
        changedWorkers.map((manifest) => ({
          owner_id: ownerId,
          worker_id: manifest.workerId,
          manifest,
          deleted_at: null,
        })),
        { onConflict: "owner_id,worker_id" },
      ),
      signal,
    );
    throwQueryError(error);
  }
  await applyExplicitDeletes(client, ownerId, snapshot, signal);
  return {
    workers: changedWorkers.length + snapshot.deleted.workerIds.length,
  };
}

/**
 * EN: Applies only durable local deletion intents; absence is never a delete.
 * 中文: 只应用持久化的本地删除意图；本地缺失永远不等于删除。
 * @param client authenticated Supabase client.
 * @param ownerId authenticated account id protected by RLS.
 * @param snapshot local snapshot carrying explicit deletion ids.
 * @returns void after the requested rows are soft-deleted.
 */
async function applyExplicitDeletes(
  client: SupabaseClient,
  ownerId: string,
  snapshot: CloudPortableSnapshot,
  signal: AbortSignal,
): Promise<void> {
  const deletedAt = new Date().toISOString();
  if (snapshot.deleted.workerIds.length > 0) {
    const { error } = await awaitRemoteOperation(
      client
        .from("ai_workers")
        .update({ deleted_at: deletedAt })
        .eq("owner_id", ownerId)
        .in("worker_id", snapshot.deleted.workerIds),
      signal,
    );
    throwQueryError(error);
  }
}

function snapshotHasPendingChanges(snapshot: CloudPortableSnapshot): boolean {
  return (
    [...snapshot.upserted.workerIds, ...snapshot.deleted.workerIds].length > 0
  );
}

function emptyCloudChangeIds(): CloudPortableSnapshot["deleted"] {
  return { workerIds: [] };
}

/**
 * EN: Creates a portable snapshot with no account-scoped records.
 * 中文: 创建不含任何账号级记录的可移植快照。
 * @returns an isolated snapshot used before touching the next account's cloud data.
 */
function emptyCloudPortableSnapshot(): CloudPortableSnapshot {
  return {
    devices: [],
    workers: [],
    upserted: emptyCloudChangeIds(),
    deleted: emptyCloudChangeIds(),
  };
}

function parseVersionedRows<T>(
  rows: VersionedManifestRow[] | null,
  entityType: Exclude<CloudPortableEntityType, "device">,
  idField: "worker_id",
  schema: z.ZodType<T>,
): {
  active: T[];
  activeIds: string[];
  deletedIds: string[];
  warnings: CloudSyncWarning[];
} {
  const active: T[] = [];
  const activeIds: string[] = [];
  const deletedIds: string[] = [];
  const warnings: CloudSyncWarning[] = [];
  for (const row of rows ?? []) {
    const id = row[idField];
    if (typeof id !== "string" || !id) {
      warnings.push(
        invalidRemoteManifestWarning(
          entityType,
          null,
          `Missing remote ${idField}.`,
        ),
      );
      continue;
    }
    if (row.deleted_at) {
      deletedIds.push(id);
      continue;
    }
    const parsed = schema.safeParse(row.manifest);
    if (!parsed.success) {
      warnings.push(invalidRemoteManifestWarning(entityType, id, parsed.error));
      continue;
    }
    if (manifestIdForEntity(parsed.data, entityType) !== id) {
      warnings.push(
        invalidRemoteManifestWarning(
          entityType,
          id,
          `Manifest id does not match remote ${idField}.`,
        ),
      );
      continue;
    }
    active.push(parsed.data);
    activeIds.push(id);
  }
  return { active, activeIds, deletedIds, warnings };
}

function buildLocalDeviceManifest(
  runtimeConfig: RuntimeConfig,
  installationId: string,
): CloudDeviceManifest {
  const platformName = platform();
  const host = hostname() || "OysterWorkflow computer";
  const deviceId = `device-${createHash("sha256")
    .update(`oyster-installation\0${installationId}`)
    .digest("hex")
    .slice(0, 20)}`;
  const capabilities = [
    runtimeConfig.hermesCommandPath ? "local-ai-worker" : null,
    runtimeConfig.screenpipeBinaryPath ? "screen-recording" : null,
    runtimeConfig.browserActCommandPath ? "logged-in-chrome" : null,
  ].filter((value): value is string => Boolean(value));
  return {
    schemaVersion: "oyster-device-manifest-v1",
    deviceId,
    name: host,
    platform: platformName,
    runtimeVersion: "OysterWorkflow 0.2.0",
    capabilities,
    lastSeenAt: new Date().toISOString(),
    revokedAt: null,
  };
}

function parseRows<T>(
  rows: ManifestRow[] | null,
  entityType: CloudPortableEntityType,
  idField: "device_id" | "worker_id",
  schema: z.ZodType<T>,
): ParsedManifestRows<T> {
  const active: T[] = [];
  const warnings: CloudSyncWarning[] = [];
  for (const row of rows ?? []) {
    const parsed = schema.safeParse(row.manifest);
    if (parsed.success) {
      const rawId = row[idField];
      if (
        typeof rawId === "string" &&
        rawId &&
        manifestIdForEntity(parsed.data, entityType) !== rawId
      ) {
        warnings.push(
          invalidRemoteManifestWarning(
            entityType,
            rawId,
            `Manifest id does not match remote ${idField}.`,
          ),
        );
        continue;
      }
      active.push(parsed.data);
      continue;
    }
    const rawId = row[idField];
    warnings.push(
      invalidRemoteManifestWarning(
        entityType,
        typeof rawId === "string" && rawId ? rawId : null,
        parsed.error,
      ),
    );
  }
  return { active, warnings };
}

function manifestIdForEntity(
  manifest: unknown,
  entityType: CloudPortableEntityType,
): string | null {
  if (!manifest || typeof manifest !== "object") {
    return null;
  }
  const record = manifest as Record<string, unknown>;
  const value = entityType === "device" ? record.deviceId : record.workerId;
  return typeof value === "string" && value ? value : null;
}

function invalidRemoteManifestWarning(
  entityType: CloudPortableEntityType,
  entityId: string | null,
  error: z.ZodError | string,
): CloudSyncWarning {
  const message =
    typeof error === "string"
      ? error
      : error.issues
          .slice(0, 3)
          .map((issue) => {
            const path =
              issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
            return `${path}${issue.message}`;
          })
          .join("; ");
  return {
    code: "invalid_remote_manifest",
    entityType,
    entityId,
    message,
  };
}

function throwQueryError(error: { message: string } | null): void {
  if (error) {
    throw new Error(`Supabase control plane: ${error.message}`);
  }
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
