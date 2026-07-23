import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import type { CloudPortableSnapshot } from "../src/cloud/contracts.js";
import type { ProductState } from "../src/product/contracts.js";
import type { RuntimeConfig } from "../src/runtime/config.js";
import { createProductStore, type ProductStore } from "../src/product/store.js";
import {
  resolveCloudSyncPlan,
  resolvePullMode,
  syncProductControlPlane,
} from "../src/product/supabase-control-plane.js";

describe("Supabase control-plane sync planning", () => {
  it("treats cloud state as authoritative during login and startup", () => {
    expect(resolveCloudSyncPlan("pull", true)).toEqual({
      source: "cloud",
      pushLocal: false,
      replaceLocal: true,
    });
    expect(resolveCloudSyncPlan("pull", false)).toEqual({
      source: "cloud",
      pushLocal: false,
      replaceLocal: true,
    });
  });

  it("allows local pushes only after the authenticated account is linked", () => {
    expect(resolveCloudSyncPlan("push", false)).toEqual({
      source: "local-push",
      pushLocal: true,
      replaceLocal: true,
    });
    expect(() => resolveCloudSyncPlan("push", true)).toThrow(
      "Pull the signed-in account before pushing local AI worker changes.",
    );
  });

  it("skips portable rows at the current revision and pulls only later deltas", () => {
    expect(resolvePullMode(-1, 0, false)).toBe("full");
    expect(resolvePullMode(0, 0, false)).toBe("unchanged");
    expect(resolvePullMode(12, 12, false)).toBe("unchanged");
    expect(resolvePullMode(12, 15, false)).toBe("delta");
    expect(resolvePullMode(15, 12, false)).toBe("full");
    expect(resolvePullMode(12, 12, true)).toBe("full");
  });

  it("keeps workflow content local during authenticated cloud pushes", async () => {
    const tempRoot = await mkdtemp(
      join(tmpdir(), "oyster-cloud-local-workflow-"),
    );
    const runtimeConfig = createRuntimeConfig(tempRoot);
    const productStore = createProductStore({ runtimeConfig });
    const user = {
      id: "local-workflow-user",
      email: "local-workflow@example.com",
      displayName: "Local Workflow User",
    };
    const touchedTables: string[] = [];

    try {
      await productStore.applyCloudSnapshot({
        snapshot: accountSnapshot("portable-worker", "Portable worker"),
        user,
        localDeviceId: "local-workflow-device",
        replacePortableState: true,
        syncRevision: 0,
      });
      await productStore.createWorkflow({
        mode: "new",
        title: "Sensitive local workflow",
        description: "Never include this workflow in cloud state.",
        apps: ["Private app"],
        sourceText: "Sensitive source text",
      });

      const exported = await productStore.exportCloudSnapshot();
      expect(JSON.stringify(exported)).not.toContain(
        "Sensitive local workflow",
      );
      expect(exported).not.toHaveProperty("workflows");
      expect(exported).not.toHaveProperty("assignments");

      await syncProductControlPlane({
        accessToken: "local-workflow-token",
        authenticatedUser: user,
        productStore,
        runtimeConfig,
        mode: "push",
        client: createPullClient(
          user.id,
          accountSnapshot("portable-worker", "Portable worker"),
          { onTable: (table) => touchedTables.push(table) },
        ),
      });

      expect(touchedTables).not.toContain("workflows");
      expect(touchedTables).not.toContain("worker_workflows");
    } finally {
      await productStore.shutdown();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps account B isolated when its first remote pull fails and the user continues offline", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "oyster-cloud-switch-"));
    const productStore = createProductStore({
      runtimeConfig: createRuntimeConfig(tempRoot),
    });
    let stateAtFirstRemoteWrite: ProductState | null = null;

    try {
      await productStore.applyCloudSnapshot({
        snapshot: accountASnapshot(),
        user: {
          id: "account-a",
          email: "a@example.com",
          displayName: "Account A",
        },
        localDeviceId: "device-a",
        replacePortableState: true,
        syncRevision: 8,
      });
      expect((await productStore.getState()).workers).toHaveLength(1);

      const client = {
        auth: {
          getUser: async () => ({
            data: {
              user: {
                id: "account-b",
                email: "b@example.com",
                user_metadata: { display_name: "Account B" },
              },
            },
            error: null,
          }),
        },
        from: (table: string) => {
          return {
            upsert: async () => {
              expect(table).toBe("devices");
              stateAtFirstRemoteWrite = await productStore.getState();
              return { error: null };
            },
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: { revision: 1 },
                  error: null,
                }),
                is: async () => ({
                  data: [],
                  error:
                    table === "ai_workers"
                      ? { message: "remote pull offline" }
                      : null,
                }),
              }),
            }),
          };
        },
      } as unknown as SupabaseClient;

      await expect(
        syncProductControlPlane({
          accessToken: "account-b-token",
          authenticatedUser: {
            id: "account-b",
            email: "b@example.com",
            displayName: "Account B",
          },
          productStore,
          runtimeConfig: createRuntimeConfig(tempRoot),
          mode: "pull",
          client,
        }),
      ).rejects.toThrow("Supabase control plane: remote pull offline");

      expect(stateAtFirstRemoteWrite).toMatchObject({
        account: {
          id: "account-b",
          cloudUserId: "account-b",
          email: "b@example.com",
          cloudSyncRevision: -1,
        },
        workflows: [],
        workers: [],
        installedWorkflows: [],
      });
      const offlineState = await productStore.getState();
      expect(offlineState.account.cloudUserId).toBe("account-b");
      expect(offlineState.workflows).toEqual([]);
      expect(JSON.stringify(offlineState)).not.toContain("Account A only");
    } finally {
      await productStore.shutdown();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps the current account unchanged until Supabase authoritatively verifies the bearer", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "oyster-cloud-auth-"));
    const runtimeConfig = createRuntimeConfig(tempRoot);
    const productStore = createProductStore({ runtimeConfig });

    try {
      await productStore.applyCloudSnapshot({
        snapshot: accountASnapshot(),
        user: {
          id: "account-a",
          email: "a@example.com",
          displayName: "Account A",
        },
        localDeviceId: "device-a",
        replacePortableState: true,
        syncRevision: 8,
      });
      const client = {
        auth: {
          getUser: async () => ({
            data: { user: null },
            error: { message: "auth endpoint offline" },
          }),
        },
        from: () => {
          throw new Error("Remote tables must not be reached.");
        },
      } as unknown as SupabaseClient;

      await expect(
        syncProductControlPlane({
          accessToken: "account-b-token",
          authenticatedUser: {
            id: "account-b",
            email: "b@example.com",
            displayName: "Account B",
          },
          productStore,
          runtimeConfig,
          mode: "pull",
          client,
        }),
      ).rejects.toThrow("auth endpoint offline");

      const offlineState = await productStore.getState();
      expect(offlineState.account).toMatchObject({
        id: "account-a",
        cloudUserId: "account-a",
        email: "a@example.com",
        cloudSyncRevision: 8,
      });
      expect(offlineState.workers.map((worker) => worker.name)).toEqual([
        "Account A only",
      ]);
    } finally {
      await productStore.shutdown();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("preserves anonymous local work when the first cloud account cannot be verified", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "oyster-cloud-first-link-"));
    const runtimeConfig = createRuntimeConfig(tempRoot);
    const productStore = createProductStore({ runtimeConfig });

    try {
      await productStore.createWorkflow({
        mode: "new",
        title: "Anonymous local workflow",
        description: "Keep this local workflow until first-link succeeds.",
        apps: [],
      });
      const client = {
        auth: {
          getUser: async () => ({
            data: { user: null },
            error: { message: "auth endpoint offline" },
          }),
        },
      } as unknown as SupabaseClient;

      await expect(
        syncProductControlPlane({
          accessToken: "account-b-token",
          authenticatedUser: {
            id: "account-b",
            email: "b@example.com",
            displayName: "Account B",
          },
          productStore,
          runtimeConfig,
          mode: "pull",
          client,
        }),
      ).rejects.toThrow("auth endpoint offline");

      const localState = await productStore.getState();
      expect(localState.account.cloudUserId).toBeNull();
      expect(localState.workflows.map((workflow) => workflow.title)).toEqual([
        "Anonymous local workflow",
      ]);
    } finally {
      await productStore.shutdown();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects a claimed account that does not match the bearer before changing local identity", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "oyster-cloud-mismatch-"));
    const runtimeConfig = createRuntimeConfig(tempRoot);
    const productStore = createProductStore({ runtimeConfig });
    try {
      await productStore.createWorkflow({
        mode: "new",
        title: "Keep before mismatch",
        description: "A forged body cannot claim this local state.",
        apps: [],
      });
      const client = {
        auth: {
          getUser: async () => ({
            data: {
              user: {
                id: "authoritative-user",
                email: "authoritative@example.com",
                user_metadata: {},
              },
            },
            error: null,
          }),
        },
        from: () => {
          throw new Error("Remote tables must not be reached.");
        },
      } as unknown as SupabaseClient;

      await expect(
        syncProductControlPlane({
          accessToken: "authoritative-token",
          authenticatedUser: {
            id: "claimed-user",
            email: "claimed@example.com",
            displayName: "Claimed User",
          },
          productStore,
          runtimeConfig,
          client,
        }),
      ).rejects.toThrow("Supabase session changed");
      const state = await productStore.getState();
      expect(state.account.cloudUserId).toBeNull();
      expect(state.workflows.map((workflow) => workflow.title)).toEqual([
        "Keep before mismatch",
      ]);
    } finally {
      await productStore.shutdown();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("serializes same-account Supabase mutations instead of overlapping them", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "oyster-cloud-serial-"));
    const runtimeConfig = createRuntimeConfig(tempRoot);
    const productStore = createProductStore({ runtimeConfig });
    const firstUpsertStarted = deferred<void>();
    const releaseFirstUpsert = deferred<void>();
    const secondAuthVerified = deferred<void>();
    let activeRemoteMutations = 0;
    let maximumRemoteMutations = 0;
    const enterRemoteMutation = async (blocked: boolean) => {
      activeRemoteMutations += 1;
      maximumRemoteMutations = Math.max(
        maximumRemoteMutations,
        activeRemoteMutations,
      );
      try {
        if (blocked) {
          firstUpsertStarted.resolve();
          await releaseFirstUpsert.promise;
        }
      } finally {
        activeRemoteMutations -= 1;
      }
    };

    try {
      const firstRun = syncProductControlPlane({
        accessToken: "serial-user-token-1",
        authenticatedUser: {
          id: "serial-user",
          email: "serial-user@example.com",
          displayName: "Serial User",
        },
        productStore,
        runtimeConfig,
        client: createPullClient(
          "serial-user",
          accountSnapshot("serial-workflow", "Serial workflow"),
          { onDeviceUpsert: () => enterRemoteMutation(true) },
        ),
      });
      await firstUpsertStarted.promise;
      const secondRun = syncProductControlPlane({
        accessToken: "serial-user-token-2",
        authenticatedUser: {
          id: "serial-user",
          email: "serial-user@example.com",
          displayName: "Serial User",
        },
        productStore,
        runtimeConfig,
        client: createPullClient(
          "serial-user",
          accountSnapshot("serial-workflow", "Serial workflow"),
          {
            onGetUser: () => secondAuthVerified.resolve(),
            onDeviceUpsert: () => enterRemoteMutation(false),
          },
        ),
      });
      await secondAuthVerified.promise;
      await Promise.resolve();
      expect(maximumRemoteMutations).toBe(1);

      releaseFirstUpsert.resolve();
      await expect(Promise.all([firstRun, secondRun])).resolves.toHaveLength(2);
      expect(maximumRemoteMutations).toBe(1);
    } finally {
      releaseFirstUpsert.resolve();
      await productStore.shutdown();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("aborts a stuck remote query and releases the account queue after the deadline", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "oyster-cloud-timeout-"));
    const runtimeConfig = createRuntimeConfig(tempRoot);
    const productStore = createProductStore({ runtimeConfig });
    let querySignal: AbortSignal | null = null;
    const stuckQuery = new Promise<never>(() => undefined);
    const client = {
      auth: {
        getUser: async () => ({
          data: {
            user: {
              id: "timeout-user",
              email: "timeout-user@example.com",
              user_metadata: {},
            },
          },
          error: null,
        }),
      },
      from: () => ({
        upsert: () => ({
          abortSignal: (signal: AbortSignal) => {
            querySignal = signal;
            return stuckQuery;
          },
          then: stuckQuery.then.bind(stuckQuery),
        }),
      }),
    } as unknown as SupabaseClient;

    try {
      await expect(
        syncProductControlPlane({
          accessToken: "timeout-token",
          authenticatedUser: {
            id: "timeout-user",
            email: "timeout-user@example.com",
            displayName: null,
          },
          productStore,
          runtimeConfig,
          client,
          remoteRequestTimeoutMs: 30,
        }),
      ).rejects.toThrow(
        "Timed out while synchronizing the cloud control plane",
      );
      expect(querySignal).not.toBeNull();
      expect((querySignal as unknown as AbortSignal).aborted).toBe(true);

      await expect(
        syncProductControlPlane({
          accessToken: "retry-token",
          authenticatedUser: {
            id: "timeout-user",
            email: "timeout-user@example.com",
            displayName: null,
          },
          productStore,
          runtimeConfig,
          client: createPullClient(
            "timeout-user",
            accountSnapshot("retry-workflow", "Retry workflow"),
          ),
          remoteRequestTimeoutMs: 2_000,
        }),
      ).resolves.toMatchObject({ phase: "synced", userId: "timeout-user" });
    } finally {
      await productStore.shutdown();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("uses the durable installation identity for device heartbeats without clearing revocation", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "oyster-cloud-device-"));
    const runtimeConfig = createRuntimeConfig(tempRoot);
    const firstStore = createProductStore({ runtimeConfig });
    const devicePayloads: Array<Record<string, unknown>> = [];
    try {
      const firstResult = await syncProductControlPlane({
        accessToken: "device-user-token-1",
        authenticatedUser: {
          id: "device-user",
          email: "device-user@example.com",
          displayName: "Device User",
        },
        productStore: firstStore,
        runtimeConfig,
        client: createPullClient(
          "device-user",
          accountSnapshot("device-wf", "Device workflow"),
          {
            onDeviceUpsert: (_payload) => undefined,
            captureDevicePayload: (payload) => devicePayloads.push(payload),
          },
        ),
      });
      const installationId = firstStore.getInstallationId();
      await firstStore.shutdown();

      const reloadedStore = createProductStore({ runtimeConfig });
      const secondResult = await syncProductControlPlane({
        accessToken: "device-user-token-2",
        authenticatedUser: {
          id: "device-user",
          email: "device-user@example.com",
          displayName: "Device User",
        },
        productStore: reloadedStore,
        runtimeConfig,
        client: createPullClient(
          "device-user",
          accountSnapshot("device-wf", "Device workflow"),
          {
            captureDevicePayload: (payload) => devicePayloads.push(payload),
          },
        ),
      });

      expect(reloadedStore.getInstallationId()).toBe(installationId);
      expect(secondResult.deviceId).toBe(firstResult.deviceId);
      expect(devicePayloads).toHaveLength(2);
      expect(devicePayloads[0]).not.toHaveProperty("revoked_at");
      expect(devicePayloads[1]).not.toHaveProperty("revoked_at");
      await reloadedStore.shutdown();
    } finally {
      await firstStore.shutdown();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("skips malformed remote rows and returns structured warnings", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "oyster-cloud-warning-"));
    const runtimeConfig = createRuntimeConfig(tempRoot);
    const productStore = createProductStore({ runtimeConfig });
    const validSnapshot = accountSnapshot("valid-workflow", "Valid workflow");
    const validWorker = validSnapshot.workers[0]!;
    const invalidWorker = {
      ...validWorker,
      workerId: "invalid-worker",
      name: "",
    };
    try {
      const result = await syncProductControlPlane({
        accessToken: "warning-user-token",
        authenticatedUser: {
          id: "warning-user",
          email: "warning-user@example.com",
          displayName: "Warning User",
        },
        productStore,
        runtimeConfig,
        client: createPullClient("warning-user", validSnapshot, {
          rawRows: {
            ai_workers: [
              {
                worker_id: invalidWorker.workerId,
                manifest: invalidWorker,
              },
              {
                worker_id: validWorker.workerId,
                manifest: validWorker,
              },
            ],
          },
        }),
      });

      expect(result.warnings).toContainEqual(
        expect.objectContaining({
          code: "invalid_remote_manifest",
          entityType: "worker",
          entityId: "invalid-worker",
        }),
      );
      expect(
        (await productStore.getState()).workers.map((item) => item.id),
      ).toEqual(["valid-workflow"]);
    } finally {
      await productStore.shutdown();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("atomically rejects Account A final apply after Account B supersedes it", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "oyster-cloud-race-"));
    const runtimeConfig = createRuntimeConfig(tempRoot);
    const baseStore = createProductStore({ runtimeConfig });
    const accountAFinalApplyStarted = deferred<void>();
    const releaseAccountAFinalApply = deferred<void>();

    try {
      await baseStore.applyCloudSnapshot({
        snapshot: accountASnapshot(),
        user: {
          id: "account-a",
          email: "a@example.com",
          displayName: "Account A",
        },
        localDeviceId: "device-a",
        replacePortableState: true,
        syncRevision: 8,
      });
      const productStore: ProductStore = {
        ...baseStore,
        applyCloudSnapshot: async (input) => {
          if (
            input.user.id === "account-a" &&
            input.expectedCloudUserId !== undefined
          ) {
            accountAFinalApplyStarted.resolve();
            await releaseAccountAFinalApply.promise;
          }
          return baseStore.applyCloudSnapshot(input);
        },
      };

      const accountARun = syncProductControlPlane({
        accessToken: "account-a-token",
        authenticatedUser: {
          id: "account-a",
          email: "a@example.com",
          displayName: "Account A",
        },
        productStore,
        runtimeConfig,
        mode: "pull",
        client: createPullClient("account-a", accountASnapshot()),
      });
      await accountAFinalApplyStarted.promise;

      const accountBSnapshot = accountSnapshot(
        "account-b-workflow",
        "Account B current",
      );
      await syncProductControlPlane({
        accessToken: "account-b-token",
        authenticatedUser: {
          id: "account-b",
          email: "b@example.com",
          displayName: "Account B",
        },
        productStore,
        runtimeConfig,
        mode: "pull",
        client: createPullClient("account-b", accountBSnapshot),
      });

      releaseAccountAFinalApply.resolve();
      await expect(accountARun).rejects.toThrow(
        "Cloud sync was superseded by a newer signed-in account.",
      );
      const finalState = await baseStore.getState();
      expect(finalState.account.cloudUserId).toBe("account-b");
      expect(finalState.workers.map((worker) => worker.name)).toEqual([
        "Account B current",
      ]);
      expect(JSON.stringify(finalState)).not.toContain("Account A only");
    } finally {
      releaseAccountAFinalApply.resolve();
      await baseStore.shutdown();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

function accountASnapshot(): CloudPortableSnapshot {
  return accountSnapshot("account-a-workflow", "Account A only");
}

function accountSnapshot(
  workerId: string,
  title: string,
): CloudPortableSnapshot {
  return {
    devices: [],
    workers: [
      {
        schemaVersion: "oyster-worker-manifest-v1",
        workerId,
        name: title,
        initials: "AW",
        description: `${title} worker`,
        avatarKey: "product",
        config: {
          identityScope: "Account-scoped worker",
          runtimeProfile: "Cloud worker runtime",
          toolAccess: [],
          memoryContext: "Account worker memory",
          approvalPolicy: "allow_all",
          heartbeatPolicy: "Manual",
          channel: {
            platform: "none",
            label: "No channel",
            accessMode: "disabled",
            homeChannel: null,
            allowedUsers: [],
          },
        },
      },
    ],
    upserted: { workerIds: [workerId] },
    deleted: { workerIds: [] },
  };
}

function createPullClient(
  userId: string,
  snapshot: CloudPortableSnapshot,
  options: {
    onGetUser?: () => void;
    onTable?: (table: string) => void;
    onDeviceUpsert?: (payload: Record<string, unknown>) => void | Promise<void>;
    captureDevicePayload?: (payload: Record<string, unknown>) => void;
    rawRows?: Partial<
      Record<"devices" | "ai_workers", Array<Record<string, unknown>>>
    >;
  } = {},
): SupabaseClient {
  return {
    auth: {
      getUser: async () => {
        options.onGetUser?.();
        return {
          data: {
            user: {
              id: userId,
              email: `${userId}@example.com`,
              user_metadata: { display_name: userId },
            },
          },
          error: null,
        };
      },
    },
    from: (table: string) => {
      options.onTable?.(table);
      return {
        upsert: async (payload: Record<string, unknown>) => {
          if (table === "devices") {
            options.captureDevicePayload?.(payload);
            await options.onDeviceUpsert?.(payload);
          }
          return { error: null };
        },
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: { revision: 0 },
              error: null,
            }),
            is: async () => ({
              data: remoteRowsForTable(table, snapshot, options.rawRows),
              error: null,
            }),
          }),
        }),
      };
    },
  } as unknown as SupabaseClient;
}

function remoteRowsForTable(
  table: string,
  snapshot: CloudPortableSnapshot,
  rawRows:
    | Partial<Record<"devices" | "ai_workers", Array<Record<string, unknown>>>>
    | undefined,
): Array<Record<string, unknown>> {
  if (table === "devices" || table === "ai_workers") {
    const supplied = rawRows?.[table];
    if (supplied) {
      return supplied;
    }
  }
  if (table === "devices") {
    return snapshot.devices.map((manifest) => ({
      device_id: manifest.deviceId,
      manifest,
    }));
  }
  if (table === "ai_workers") {
    return snapshot.workers.map((manifest) => ({
      worker_id: manifest.workerId,
      manifest,
    }));
  }
  return [];
}

function createRuntimeConfig(root: string): RuntimeConfig {
  const hermesRuntimeRoot = join(root, "hermes-runtime");
  return {
    mode: "test",
    productSeedMode: "empty",
    apiPort: 0,
    apiSecret: null,
    screenpipeBaseUrl: "http://127.0.0.1:3030",
    screenpipeBinaryPath: join(root, "screenpipe"),
    screenpipeWorkDir: join(root, "screenpipe-work"),
    screenpipeRecordingPort: 3030,
    screenpipeQueryPortStart: 3031,
    hermesCommandPath: null,
    browserActCommandPath: null,
    hermesRuntimeRoot,
    hermesProfilesRoot: join(hermesRuntimeRoot, "profiles"),
    hermesSkillsRoot: join(hermesRuntimeRoot, "skills"),
    runsRoot: join(root, "runs"),
    llmConfigPath: join(root, "llm.config.json"),
    skillManagerConfigPath: join(root, "skill-manager.config.json"),
    codexEnvPath: join(root, ".env"),
    platform: "darwin",
    projectRootDir: root,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
