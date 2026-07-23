import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CloudPortableSnapshot } from "../src/cloud/contracts.js";
import type { LabSession, OpenClawSkill } from "../src/lab-api/contracts.js";
import type { RuntimeConfig } from "../src/runtime/config.js";
import type {
  ProductCapabilityProvider,
  ProductState,
} from "../src/product/contracts.js";
import { createProductEntityId } from "../src/product/identity.js";
import { openProductDatabase } from "../src/product/sqlite.js";
import { createProductStore } from "../src/product/store.js";
import { materializeWorkflowGraphArtifacts } from "../src/skill/workflow-graph.js";
import { normalizeWorkflowMergeProposal } from "../src/skill/workflow-merge.js";
import type { CandidateWorkflow } from "../src/types/contracts.js";

let tempRoot = "";
let previousHermesCommand: string | undefined;
let previousSkillsRoot: string | undefined;
let previousProfilesRoot: string | undefined;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "oyster-product-store-"));
  previousHermesCommand = process.env.OYSTERWORKFLOW_HERMES_COMMAND;
  previousSkillsRoot = process.env.OYSTERWORKFLOW_HERMES_SKILLS_ROOT;
  previousProfilesRoot = process.env.OYSTERWORKFLOW_HERMES_PROFILES_ROOT;
  const hermesPath = join(tempRoot, "fake-hermes");
  await writeFile(
    hermesPath,
    `#!/bin/sh
profiles_root="\${OYSTERWORKFLOW_HERMES_PROFILES_ROOT:-\${HERMES_HOME:-${tempRoot}/hermes-runtime}/profiles}"
if [ "$1" = "-p" ]; then
  profile="$2"
  shift 2
fi
if [ "$1" = "profile" ] && [ "$2" = "show" ]; then
  target="\${3:-$profile}"
  if [ -d "$profiles_root/$target" ]; then
    echo "Name: $target"
    echo "Path: $profiles_root/$target"
    exit 0
  fi
  echo "profile not found: $target" >&2
  exit 1
fi
if [ "$1" = "profile" ] && [ "$2" = "create" ]; then
  /bin/mkdir -p "$profiles_root/$3/skills"
  echo "created profile $3"
  exit 0
fi
echo "unknown fake-hermes command: $*" >&2
exit 1
`,
    "utf8",
  );
  await chmod(hermesPath, 0o755);
  process.env.OYSTERWORKFLOW_HERMES_COMMAND = hermesPath;
  process.env.OYSTERWORKFLOW_HERMES_SKILLS_ROOT = join(
    tempRoot,
    "hermes-skills",
  );
  process.env.OYSTERWORKFLOW_HERMES_PROFILES_ROOT = join(
    tempRoot,
    "hermes-profiles",
  );
});

afterEach(async () => {
  if (previousHermesCommand === undefined) {
    delete process.env.OYSTERWORKFLOW_HERMES_COMMAND;
  } else {
    process.env.OYSTERWORKFLOW_HERMES_COMMAND = previousHermesCommand;
  }
  if (previousSkillsRoot === undefined) {
    delete process.env.OYSTERWORKFLOW_HERMES_SKILLS_ROOT;
  } else {
    process.env.OYSTERWORKFLOW_HERMES_SKILLS_ROOT = previousSkillsRoot;
  }
  if (previousProfilesRoot === undefined) {
    delete process.env.OYSTERWORKFLOW_HERMES_PROFILES_ROOT;
  } else {
    process.env.OYSTERWORKFLOW_HERMES_PROFILES_ROOT = previousProfilesRoot;
  }
  await rm(tempRoot, { recursive: true, force: true });
});

describe("product store", () => {
  it("keeps a fresh production store free of demo workers and workflows", async () => {
    const runtimeConfig = createRuntimeConfig(tempRoot, "empty");
    const store = createProductStore({ runtimeConfig });

    const state = await store.getState();

    expect(state.devices).toEqual([]);
    expect(state.workers).toEqual([]);
    expect(state.workflows).toEqual([]);
    expect(state.installedWorkflows).toEqual([]);
    expect(state.runs).toEqual([]);
    expect(state.account).toMatchObject({
      id: "acct-local",
      name: "Local User",
      email: "",
      workspaceId: "workspace-local",
    });
    expect(state.workspace.id).toBe("workspace-local");
  });

  it("retries product-state initialization after a transient failure", async () => {
    let installCalls = 0;
    const workerExecutor = {
      kind: "retry-test-executor",
      skillScope: {},
      installSkill: async (input: { workflowId: string }) => {
        installCalls += 1;
        if (installCalls === 1) {
          throw new Error("transient skill materialization failure");
        }
        return {
          skillReference: `retry-skill:${input.workflowId}`,
          installReference: `retry-install:${input.workflowId}`,
          skillName: `retry-${input.workflowId}`,
          skillPath: join(
            tempRoot,
            "retry-skills",
            input.workflowId,
            "SKILL.md",
          ),
        };
      },
    };
    const store = createProductStore({
      runtimeConfig: createRuntimeConfig(tempRoot, "demo"),
      workerExecutor,
    } as never);

    await expect(store.getState()).rejects.toThrow(
      "transient skill materialization failure",
    );
    await expect(store.getState()).resolves.toMatchObject({
      workers: expect.arrayContaining([
        expect.objectContaining({ id: "marketing" }),
      ]),
    });
    expect(installCalls).toBeGreaterThan(1);
  });

  it("migrates an untouched historical demo seed to empty exactly once", async () => {
    const demoConfig = createRuntimeConfig(tempRoot, "demo");
    const demoStore = createProductStore({ runtimeConfig: demoConfig });
    await demoStore.recordPermissionSnapshot({
      checkedAt: "2026-07-17T01:00:00.000Z",
      allGranted: true,
      canStartRecording: true,
      source: "host-app",
      summary: "Permissions granted on this Mac",
      items: [],
    });

    const productionStore = createProductStore({
      runtimeConfig: createRuntimeConfig(tempRoot, "empty"),
    });
    const migrated = await productionStore.getState();

    expect(migrated.devices).toEqual([]);
    expect(migrated.workers).toEqual([]);
    expect(migrated.workflows).toEqual([]);
    expect(migrated.installedWorkflows).toEqual([]);
    expect(migrated.runs).toEqual([]);
    expect(migrated.permissionSnapshot?.allGranted).toBe(true);
    const database = new DatabaseSync(join(tempRoot, "product-state.sqlite"));
    expect(
      database
        .prepare(
          "SELECT value FROM product_meta WHERE key = 'data_migration.pure-demo-seed-to-empty-v1'",
        )
        .get(),
    ).toMatchObject({ value: "complete" });
    database.close();
  });

  it("preserves historical demo records when their fingerprint shows user changes", async () => {
    const demoStore = createProductStore({
      runtimeConfig: createRuntimeConfig(tempRoot, "demo"),
    });
    await demoStore.setupAccount({
      name: "User-owned workspace",
      email: "owner@example.com",
      workspaceName: "Customized workspace",
    });

    const productionStore = createProductStore({
      runtimeConfig: createRuntimeConfig(tempRoot, "empty"),
    });
    const preserved = await productionStore.getState();

    expect(preserved.account.name).toBe("User-owned workspace");
    expect(preserved.workspace.name).toBe("Customized workspace");
    expect(preserved.workers.map((worker) => worker.id)).toContain("marketing");
    expect(preserved.workflows.map((workflow) => workflow.id)).toContain(
      "inbound",
    );
  });

  it("rejects unknown workflows and persists only authoritative workflow fields", async () => {
    const store = createProductStore({
      runtimeConfig: createRuntimeConfig(tempRoot, "demo"),
    });

    await expect(
      store.installWorkflow({
        workerId: "sales",
        workflowId: "workflow-does-not-exist",
        workflowTitle: "Spoofed workflow",
        description: "Spoofed description",
        apps: ["Spoofed app"],
      }),
    ).rejects.toThrow("Unknown workflow: workflow-does-not-exist");
    await expect(
      store.deleteWorkflow({
        workflowId: "workflow-does-not-exist",
        workflowTitle: "Spoofed workflow",
      }),
    ).rejects.toThrow("Unknown workflow: workflow-does-not-exist");

    const installed = await store.installWorkflow({
      workerId: "sales",
      workflowId: "inbound",
      workflowTitle: "Spoofed workflow",
      description: "Spoofed description",
      apps: ["Spoofed app"],
    });
    expect(installed.installedWorkflow).toMatchObject({
      workflowId: "inbound",
      workflowTitle: "Handle inbound opportunity",
      description:
        "Qualify customer emails, check feasibility, and prepare follow-up",
      apps: ["Microsoft Outlook", "Gmail", "Slack", "Salesforce"],
    });

    const deleted = await store.deleteWorkflow({
      workflowId: "tracker",
      workflowTitle: "Spoofed tombstone title",
    });
    expect(deleted.tombstone.workflowTitle).toBe("Prepare follow-up tracker");

    const cascadeDeleted = await store.deleteWorkflow({
      workflowId: "inbound",
      workflowTitle: "Spoofed tombstone title",
    });
    expect(cascadeDeleted.tombstone.workflowTitle).toBe(
      "Handle inbound opportunity",
    );
    expect(
      cascadeDeleted.state.installedWorkflows.some(
        (workflow) => workflow.id === installed.installedWorkflow.id,
      ),
    ).toBe(false);
    expect(
      cascadeDeleted.state.approvalPolicies.some(
        (policy) => policy.scopeId === installed.installedWorkflow.id,
      ),
    ).toBe(false);
    expect(
      cascadeDeleted.state.workers.find((worker) => worker.id === "sales"),
    ).toMatchObject({
      selectedInstalledWorkflowId: null,
      status: "No active task",
      heartbeat: "Installed workflow removed",
      activities: [
        "Handle inbound opportunity removed",
        "Run history preserved",
        expect.any(String),
      ],
    });
  });

  it("uses durable installation namespaces and UUID ids under concurrent creation", async () => {
    const runtimeConfig = createRuntimeConfig(tempRoot, "empty");
    const store = createProductStore({ runtimeConfig });
    await store.getState();
    const firstDatabase = new DatabaseSync(
      join(tempRoot, "product-state.sqlite"),
    );
    const installationId = (
      firstDatabase
        .prepare("SELECT value FROM product_meta WHERE key = 'installation_id'")
        .get() as { value: string }
    ).value;
    firstDatabase.close();

    const reloaded = createProductStore({ runtimeConfig });
    await reloaded.getState();
    const secondDatabase = new DatabaseSync(
      join(tempRoot, "product-state.sqlite"),
    );
    expect(
      (
        secondDatabase
          .prepare(
            "SELECT value FROM product_meta WHERE key = 'installation_id'",
          )
          .get() as { value: string }
      ).value,
    ).toBe(installationId);
    secondDatabase.close();

    const [leftWorker, rightWorker] = await Promise.all([
      store.createWorker({
        mode: "new",
        name: "Concurrent Worker",
        description: "First concurrent worker",
      }),
      store.createWorker({
        mode: "new",
        name: "Concurrent Worker",
        description: "Second concurrent worker",
      }),
    ]);
    expect(leftWorker.worker.id).not.toBe(rightWorker.worker.id);
    expect(leftWorker.worker.id).toMatch(
      /^worker-concurrent-worker-[0-9a-f-]{36}$/u,
    );

    const workflows = await Promise.all([
      store.createWorkflow({
        mode: "new",
        title: "Concurrent workflow",
        description: "First concurrent workflow",
        apps: [],
      }),
      store.createWorkflow({
        mode: "new",
        title: "Concurrent workflow",
        description: "Second concurrent workflow",
        apps: [],
      }),
    ]);
    expect(workflows[0].workflow.id).not.toBe(workflows[1].workflow.id);
    expect(workflows[0].workflow.id).toMatch(
      /^manual-concurrent-workflow-[0-9a-f-]{36}$/u,
    );
    const runIds = Array.from({ length: 100 }, () =>
      createProductEntityId("run"),
    );
    expect(new Set(runIds).size).toBe(runIds.length);
    expect(runIds[0]).toMatch(/^run-[0-9a-f-]{36}$/u);
  });

  it("isolates every account-scoped record when switching cloud accounts", async () => {
    const runtimeConfig = createRuntimeConfig(tempRoot, "demo");
    const originalStore = createProductStore({ runtimeConfig });
    const original = await originalStore.getState();
    const now = "2026-07-17T02:00:00.000Z";
    const accountAState: ProductState = {
      ...original,
      account: {
        ...original.account,
        id: "account-a",
        cloudUserId: "account-a",
        email: "a@example.com",
      },
      workspace: {
        id: "workspace-account-a",
        name: "Account A workspace",
        mode: "cloud-linked",
      },
      captureSessions: [
        {
          id: "capture-a",
          labSessionId: "lab-a",
          sessionPath: "/account-a/session.json",
          artifactRoot: "/account-a/artifacts",
          status: "generated",
          title: "Account A capture",
          latestRunId: "ingest-a",
          latestRunDir: "/account-a/run",
          ingestSummaryPath: "/account-a/summary.json",
          workflowDiscoveryPath: "/account-a/workflow.json",
          selectedWorkflowId: "inbound",
          skillPath: "/account-a/skill.json",
          stats: {
            uiEvents: 1,
            ocrObservations: 1,
            voiceNotes: 0,
            duration: "0:01",
            decisionPoints: 1,
          },
          artifactMissing: false,
          createdAt: now,
          updatedAt: now,
        },
      ],
      artifacts: [
        {
          id: "artifact-a",
          captureSessionId: "capture-a",
          kind: "skill",
          path: "/account-a/skill.json",
          status: "available",
          sizeBytes: 10,
          updatedAt: now,
        },
      ],
      channelConnections: [
        {
          id: "connection-a",
          workerId: "sales",
          platform: "slack",
          label: "Account A Slack",
          setupMethod: "app_tokens",
          status: "connected",
          accountLabel: "A",
          hermesProfile: "hermes-profile:account-a",
          configuredFields: ["token"],
          missingFields: [],
          lastCheckedAt: now,
          lastConnectedAt: now,
          lastError: null,
          createdAt: now,
          updatedAt: now,
        },
      ],
      channelSetups: [
        {
          id: "setup-a",
          connectionId: "connection-a",
          workerId: "sales",
          platform: "whatsapp",
          status: "connected",
          qrPayload: null,
          qrExpiresAt: null,
          accountLabel: "A",
          processId: null,
          lastError: null,
          createdAt: now,
          updatedAt: now,
        },
      ],
      channelBindings: [
        {
          id: "binding-a",
          connectionId: "connection-a",
          workerId: "sales",
          platform: "slack",
          conversationId: "conversation-a",
          threadId: null,
          conversationLabel: "Account A",
          hermesProfile: "hermes-profile:account-a",
          hermesSessionId: "hermes-session-a",
          status: "bound",
          lastError: null,
          createdAt: now,
          updatedAt: now,
        },
      ],
      runEvents: [
        {
          id: "event-a",
          runId: original.runs[0]!.id,
          workerId: "sales",
          source: "user",
          status: "Account A event",
          body: "Account A only",
          createdAt: now,
        },
      ],
      commands: [
        {
          id: "command-a",
          runId: original.runs[0]!.id,
          workerId: "sales",
          command: "Account A command",
          source: "agent_chat",
          status: "accepted",
          createdAt: now,
          errorMessage: null,
        },
      ],
      workflowTombstones: [
        {
          workflowId: "account-a-deleted-workflow",
          workflowTitle: "Account A deleted workflow",
          deletedAt: now,
          deletedByAccountId: "account-a",
        },
      ],
      hermes: {
        ...original.hermes,
        available: true,
        configPath: "/account-a/hermes/config.json",
        runtimeHome: "/account-a/hermes",
        lastProbeSessionId: "probe-a",
      },
      workflows: original.workflows.map((workflow, index) =>
        index === 0
          ? { ...workflow, artifactPath: "/account-a/skill.json" }
          : workflow,
      ),
      installedWorkflows: original.installedWorkflows.map((workflow, index) =>
        index === 0
          ? {
              ...workflow,
              sourceSkillPath: "/account-a/source-skill.json",
              hermesSkillPath: "/account-a/hermes/SKILL.md",
            }
          : workflow,
      ),
    };
    openProductDatabase(join(tempRoot, "product-state.sqlite")).writeState(
      accountAState,
    );

    const accountStore = createProductStore({ runtimeConfig });
    const accountB = await accountStore.applyCloudSnapshot({
      snapshot: {
        devices: [],
        workers: [
          {
            schemaVersion: "oyster-worker-manifest-v1",
            workerId: "shared-worker",
            name: "Account B Worker",
            initials: "BW",
            description: "Account B only",
            avatarKey: "product",
            config: {
              identityScope: "Account B scope",
              runtimeProfile: "Account B runtime",
              toolAccess: [],
              memoryContext: "Account B memory",
              approvalPolicy: "allow_all",
              heartbeatPolicy: "Account B heartbeat",
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
        upserted: { workerIds: [] },
        deleted: { workerIds: [] },
      },
      user: {
        id: "account-b",
        email: "b@example.com",
        displayName: "Account B",
      },
      localDeviceId: "device-b",
      replacePortableState: false,
      syncRevision: 1,
    });

    expect(accountB.account.cloudUserId).toBe("account-b");
    expect(accountB.workers.map((worker) => worker.id)).toEqual([
      "shared-worker",
    ]);
    expect(accountB.workflows).toEqual([]);
    expect(accountB.installedWorkflows).toEqual([]);
    expect(accountB.captureSessions).toEqual([]);
    expect(accountB.artifacts).toEqual([]);
    expect(accountB.channelConnections).toEqual([]);
    expect(accountB.channelSetups).toEqual([]);
    expect(accountB.channelBindings).toEqual([]);
    expect(accountB.runs).toEqual([]);
    expect(accountB.runEvents).toEqual([]);
    expect(accountB.commands).toEqual([]);
    expect(accountB.workflowTombstones).toEqual([]);
    expect(accountB.hermes.configPath).toBeNull();
    expect(accountB.hermes.runtimeHome).toBeNull();
    expect(JSON.stringify(accountB)).not.toContain("/account-a/");
    expect(accountB.workers[0]?.config.hermesAgentReference).not.toBe(
      "hermes-profile:account-a",
    );
  });

  it("fully isolates anonymous account records on the first authoritative cloud link", async () => {
    const store = createProductStore({
      runtimeConfig: createRuntimeConfig(tempRoot, "demo"),
    });
    const anonymous = await store.getState();
    expect(anonymous.account.cloudUserId).toBeNull();
    expect(anonymous.workers.length).toBeGreaterThan(0);
    expect(anonymous.runs.length).toBeGreaterThan(0);

    const linked = await store.applyCloudSnapshot({
      snapshot: {
        devices: [],
        workers: [],
        upserted: { workerIds: [] },
        deleted: { workerIds: [] },
      },
      user: {
        id: "first-cloud-user",
        email: "first-cloud@example.com",
        displayName: "First Cloud User",
      },
      localDeviceId: "first-cloud-device",
      replacePortableState: true,
      syncRevision: 1,
    });

    expect(linked.account.cloudUserId).toBe("first-cloud-user");
    expect(linked.workers).toEqual([]);
    expect(linked.workflows).toEqual([]);
    expect(linked.installedWorkflows).toEqual([]);
    expect(linked.captureSessions).toEqual([]);
    expect(linked.artifacts).toEqual([]);
    expect(linked.channelConnections).toEqual([]);
    expect(linked.channelSetups).toEqual([]);
    expect(linked.channelBindings).toEqual([]);
    expect(linked.runs).toEqual([]);
    expect(linked.runEvents).toEqual([]);
    expect(linked.commands).toEqual([]);
    expect(linked.workflowTombstones).toEqual([]);
  });

  it("keeps a newer capability check result when an older prepare resolves late", async () => {
    const prepareResult = deferred<ProductCapabilityProvider>();
    const checkResult = deferred<ProductCapabilityProvider>();
    const readyProvider: ProductCapabilityProvider = {
      id: "chrome",
      kind: "browser",
      label: "Chrome",
      description: "Chrome provider",
      status: "ready",
      enabled: true,
      required: true,
      installed: true,
      version: "1.0.0",
      pinnedVersion: "1.0.0",
      commandPath: "/ready/browser-act",
      lastCheckedAt: "2026-07-17T03:00:00.000Z",
      lastError: null,
      lastSuccessAt: "2026-07-17T03:00:00.000Z",
      detail: "Ready",
    };
    const staleProvider: ProductCapabilityProvider = {
      ...readyProvider,
      status: "unavailable",
      installed: false,
      commandPath: null,
      lastCheckedAt: "2026-07-17T02:59:00.000Z",
      lastError: "Stale prepare failure",
      lastSuccessAt: null,
      detail: "Stale",
    };
    const capabilityRegistry = {
      list: async () => [staleProvider],
      prepare: async () => prepareResult.promise,
      check: async () => checkResult.promise,
    };
    const store = createProductStore({
      runtimeConfig: createRuntimeConfig(tempRoot, "empty"),
      capabilityRegistry,
    } as never);

    const preparing = store.prepareCapabilityProvider("chrome");
    const checking = store.checkCapabilityProvider("chrome");
    checkResult.resolve(readyProvider);
    await checking;
    prepareResult.resolve(staleProvider);
    const staleResponse = await preparing;

    expect(staleResponse.provider.status).toBe("ready");
    expect(
      (await store.getState()).capabilityProviders.find(
        (provider) => provider.id === "chrome",
      ),
    ).toMatchObject({
      status: "ready",
      installed: true,
      commandPath: "/ready/browser-act",
      lastError: null,
    });
  });

  it("coalesces concurrent capability checks and allows retry after a provider error", async () => {
    const firstCheck = deferred<ProductCapabilityProvider>();
    const checkStarted = deferred<void>();
    let checkCalls = 0;
    const readyProvider: ProductCapabilityProvider = {
      id: "chrome",
      kind: "browser",
      label: "Chrome",
      description: "Chrome provider",
      status: "ready",
      enabled: true,
      required: false,
      installed: true,
      version: "1.0.6",
      pinnedVersion: "1.0.6",
      commandPath: "/ready/browser-act",
      lastCheckedAt: "2026-07-17T04:00:00.000Z",
      lastError: null,
      lastSuccessAt: "2026-07-17T04:00:00.000Z",
      detail: "Ready",
    };
    const capabilityRegistry = {
      list: async () => [readyProvider],
      prepare: async () => readyProvider,
      check: async () => {
        checkCalls += 1;
        if (checkCalls === 1) {
          checkStarted.resolve();
          return firstCheck.promise;
        }
        throw new Error("provider crashed");
      },
    };
    const store = createProductStore({
      runtimeConfig: createRuntimeConfig(tempRoot, "empty"),
      capabilityRegistry,
    } as never);

    const left = store.checkCapabilityProvider("chrome");
    const right = store.checkCapabilityProvider("chrome");
    await checkStarted.promise;
    expect(checkCalls).toBe(1);
    firstCheck.resolve(readyProvider);
    await expect(Promise.all([left, right])).resolves.toEqual([
      expect.objectContaining({
        provider: expect.objectContaining({ status: "ready" }),
      }),
      expect.objectContaining({
        provider: expect.objectContaining({ status: "ready" }),
      }),
    ]);

    await expect(
      store.checkCapabilityProvider("chrome"),
    ).resolves.toMatchObject({
      provider: {
        status: "unavailable",
        lastError: "provider crashed",
      },
    });
    expect(checkCalls).toBe(2);
  });

  it("fences deferred capability operations once shutdown begins", async () => {
    const prepareResult = deferred<ProductCapabilityProvider>();
    const prepareStarted = deferred<void>();
    const checkResult = deferred<ProductCapabilityProvider>();
    const checkStarted = deferred<void>();
    let checkCalls = 0;
    let prepareCalls = 0;
    let shutdownCalls = 0;
    const readyProvider: ProductCapabilityProvider = {
      id: "chrome",
      kind: "browser",
      label: "Chrome",
      description: "Chrome provider",
      status: "ready",
      enabled: true,
      required: false,
      installed: true,
      version: "1.0.6",
      pinnedVersion: "1.0.6",
      commandPath: "/ready/browser-act",
      lastCheckedAt: "2026-07-17T05:00:00.000Z",
      lastError: null,
      lastSuccessAt: "2026-07-17T05:00:00.000Z",
      detail: "Ready",
    };
    const capabilityRegistry = {
      list: async () => [],
      shutdown: async () => {
        shutdownCalls += 1;
      },
      prepare: async () => {
        prepareCalls += 1;
        prepareStarted.resolve();
        return prepareResult.promise;
      },
      check: async () => {
        checkCalls += 1;
        checkStarted.resolve();
        return checkResult.promise;
      },
    };
    const store = createProductStore({
      runtimeConfig: createRuntimeConfig(tempRoot, "empty"),
      capabilityRegistry,
    } as never);

    const preparing = store.prepareCapabilityProvider("chrome");
    const checking = store.checkCapabilityProvider("chrome");
    await Promise.all([prepareStarted.promise, checkStarted.promise]);
    const shuttingDown = store.shutdown();
    prepareResult.resolve(readyProvider);
    checkResult.resolve(readyProvider);

    await expect(preparing).rejects.toThrow("Product store is shutting down");
    await expect(checking).rejects.toThrow("Product store is shutting down");
    await expect(shuttingDown).resolves.toBeUndefined();
    expect(checkCalls).toBe(1);
    expect(
      (await store.getState()).capabilityProviders.find(
        (provider) => provider.id === "chrome",
      )?.status,
    ).not.toBe("ready");
    await expect(store.prepareCapabilityProvider("chrome")).rejects.toThrow(
      "Product store is shutting down",
    );
    await expect(store.checkCapabilityProvider("chrome")).rejects.toThrow(
      "Product store is shutting down",
    );
    expect(prepareCalls).toBe(1);
    expect(checkCalls).toBe(1);
    expect(shutdownCalls).toBe(1);
  });

  it("repairs an interrupted persisted capability check on restart", async () => {
    const checkResult = deferred<ProductCapabilityProvider>();
    const checkStarted = deferred<void>();
    const capabilityRegistry = {
      list: async () => [],
      prepare: async () => {
        throw new Error("not used");
      },
      check: async () => {
        checkStarted.resolve();
        return checkResult.promise;
      },
    };
    const runtimeConfig = createRuntimeConfig(tempRoot, "empty");
    const store = createProductStore({
      runtimeConfig,
      capabilityRegistry,
    } as never);
    const checking = store.checkCapabilityProvider("chrome");
    await checkStarted.promise;

    const reloaded = createProductStore({
      runtimeConfig,
      capabilityRegistry,
    } as never);
    await expect(reloaded.getState()).resolves.toMatchObject({
      capabilityProviders: expect.arrayContaining([
        expect.objectContaining({
          id: "chrome",
          status: "not_checked",
          detail: expect.stringContaining("interrupted"),
        }),
      ]),
    });

    checkResult.resolve({
      id: "chrome",
      kind: "browser",
      label: "Chrome",
      description: "Chrome provider",
      status: "ready",
      enabled: true,
      required: false,
      installed: true,
      version: "1.0.6",
      pinnedVersion: "1.0.6",
      commandPath: "/ready/browser-act",
      lastCheckedAt: "2026-07-17T04:05:00.000Z",
      lastError: null,
      lastSuccessAt: "2026-07-17T04:05:00.000Z",
      detail: "Ready",
    });
    await checking;
  });

  it("persists a newly created workflow before it can be installed", async () => {
    const runtimeConfig = createRuntimeConfig(tempRoot);
    const store = createProductStore({ runtimeConfig });

    const created = await store.createWorkflow({
      mode: "new",
      title: "Prepare renewal risk packet",
      description: "Collect renewal risks and next steps for account review.",
      apps: ["Salesforce", "Slack", "Salesforce"],
      sourceText: "Review the account before preparing the handoff.",
    });

    expect(created.workflow).toMatchObject({
      id: expect.stringMatching(
        /^manual-prepare-renewal-risk-packet-[0-9a-f-]{36}$/u,
      ),
      status: "Needs review",
      sourceType: "imported",
      sourceText: "Review the account before preparing the handoff.",
      apps: ["Salesforce", "Slack"],
      detectedAt: "Manual entry",
    });
    const reloaded = createProductStore({ runtimeConfig });
    expect(
      (await reloaded.getState()).workflows.find(
        (workflow) => workflow.id === created.workflow.id,
      ),
    ).toEqual(created.workflow);
  });

  it("persists product entities in SQLite and installs workflows as Hermes skills", async () => {
    const runtimeConfig = createRuntimeConfig(tempRoot);
    const store = createProductStore({ runtimeConfig });

    const initial = await store.getState();
    expect(initial.account.email).toBe("alexyang@oysterworkflow.com");
    expect(initial.workflows.map((workflow) => workflow.id)).toContain(
      "inbound",
    );
    expect(initial.installedWorkflows).toHaveLength(32);
    const salesWorkflowTitles = initial.installedWorkflows
      .filter((workflow) => workflow.workerId === "sales")
      .map((workflow) => workflow.workflowTitle);
    expect(new Set(salesWorkflowTitles).size).toBe(salesWorkflowTitles.length);
    expect(initial.approvalPolicies.length).toBe(
      initial.workers.length + initial.installedWorkflows.length,
    );
    expect(initial.commands).toHaveLength(0);

    const databasePath = join(tempRoot, "product-state.sqlite");
    await expect(stat(databasePath)).resolves.toBeTruthy();
    const db = new DatabaseSync(databasePath);
    expect(
      (
        db
          .prepare("SELECT COUNT(*) AS count FROM installed_workflows")
          .get() as { count: number }
      ).count,
    ).toBe(32);
    expect(
      (
        db.prepare("SELECT COUNT(*) AS count FROM workflows").get() as {
          count: number;
        }
      ).count,
    ).toBe(initial.workflows.length);
    expect(
      (
        db.prepare("SELECT COUNT(*) AS count FROM approval_policies").get() as {
          count: number;
        }
      ).count,
    ).toBe(initial.workers.length + initial.installedWorkflows.length);
    expect(
      (
        db
          .prepare("SELECT COUNT(*) AS count FROM product_migrations")
          .get() as { count: number }
      ).count,
    ).toBe(2);
    expect(
      (
        db
          .prepare(
            "SELECT value FROM product_meta WHERE key = 'schema_version'",
          )
          .get() as { value: string }
      ).value,
    ).toBe("2");
    const migratedAtBefore = (
      db
        .prepare(
          "SELECT value FROM product_meta WHERE key = 'schema_migrated_at'",
        )
        .get() as { value: string }
    ).value;
    expect(migratedAtBefore).toEqual(expect.any(String));

    const accountUpdated = await store.setupAccount({
      name: "Alex Yang",
      email: "alexyang@oysterworkflow.com",
      workspaceName: "OysterWorkflow Demo",
    });
    expect(accountUpdated.state.workspace.name).toBe("OysterWorkflow Demo");
    expect(
      (
        db
          .prepare(
            "SELECT value FROM product_meta WHERE key = 'schema_migrated_at'",
          )
          .get() as { value: string }
      ).value,
    ).toBe(migratedAtBefore);

    const legacyConfigUpdated = await store.updateWorkerConfig("sales", {
      identityScope: "Sales AI Worker follows Alex's sales workflow.",
      runtimeProfile: "Hermes Agent / verified local profile",
      toolAccess: ["browser control", "mail", "crm"],
      memoryContext: "Local opportunity memory",
      approvalPolicy: "allow_all",
      heartbeatPolicy: "Recover and log every failure.",
      hermesAgentReference: "hermes-agent:sales",
    });
    expect(legacyConfigUpdated.worker.config.hermesAgentReference).toBe(
      "hermes-profile:ow-sales-sales-ai-worker",
    );

    const configUpdated = await store.updateWorkerConfig("sales", {
      identityScope: "Sales AI Worker follows Alex's sales workflow.",
      runtimeProfile: "Hermes Agent / verified local profile",
      toolAccess: ["browser control", "mail", "crm"],
      memoryContext: "Local opportunity memory",
      approvalPolicy: "allow_all",
      heartbeatPolicy: "Recover and log every failure.",
      hermesAgentReference: "hermes-agent:sales-verified",
    });
    expect(configUpdated.worker.config.hermesAgentReference).toBe(
      "hermes-agent:sales-verified",
    );

    const existingMeetingWorkflow = initial.installedWorkflows.find(
      (workflow) => workflow.id === "installed-meeting-actions",
    );
    const redeployed = await store.installWorkflow({
      workerId: "sales",
      workflowId: "workflow-meeting-actions",
      workflowTitle: "Extract action items from customer meeting",
      description: "Updated skill artifact for meeting action extraction.",
      apps: ["Google Docs", "Slack"],
    });
    expect(redeployed.installedWorkflow).toMatchObject({
      id: "installed-meeting-actions",
      baselineRuns: 34,
      baselineSuccesses: 33,
      baselineLastRun: "18 min ago",
      installedAt: existingMeetingWorkflow?.installedAt,
      description:
        "Turn call notes into owners, deadlines, CRM tasks, and follow-up reminders",
      apps: ["Google Docs", "Slack", "Salesforce", "Microsoft Outlook"],
    });
    expect(
      redeployed.state.installedWorkflows.filter(
        (workflow) => workflow.workflowId === "workflow-meeting-actions",
      ),
    ).toHaveLength(1);

    const inboundWorkflow = await store.createWorkflow({
      mode: "new",
      title: "Handle inbound opportunity",
      description: "Qualify customer email and prepare follow-up.",
      apps: ["Microsoft Outlook", "Slack", "HubSpot"],
    });
    const installed = await store.installWorkflow({
      workerId: "sales",
      workflowId: inboundWorkflow.workflow.id,
      workflowTitle: "Handle inbound opportunity",
      description: "Qualify customer email and prepare follow-up.",
      apps: ["Microsoft Outlook", "Slack", "HubSpot"],
    });
    expect(installed.installedWorkflow.baselineRuns).toBe(0);
    expect(
      installed.state.approvalPolicies.some(
        (policy) =>
          policy.scopeType === "installed_workflow" &&
          policy.scopeId === installed.installedWorkflow.id &&
          policy.mode === "allow_all",
      ),
    ).toBe(true);
    expect(installed.installedWorkflow.hermesSkillPath).toMatch(/SKILL\.md$/u);
    await expect(
      stat(installed.installedWorkflow.hermesSkillPath),
    ).resolves.toBeTruthy();
    const installedSkill = await readFile(
      installed.installedWorkflow.hermesSkillPath,
      "utf8",
    );
    expect(installedSkill).toContain("Handle inbound opportunity");
    expect(installedSkill).toMatch(
      /^---\nname: "handle-inbound-opportunity"\ndescription: /u,
    );
    expect(installedSkill).not.toContain("OYSTERWORKFLOW_EXTERNAL_ACTION");

    const deleted = await store.deleteWorkflow({
      workflowId: "inbound",
      workflowTitle: "Handle inbound opportunity",
    });
    expect(deleted.tombstone).toMatchObject({
      workflowId: "inbound",
      workflowTitle: "Handle inbound opportunity",
      deletedByAccountId: "acct-alex",
    });
    expect(
      (
        db
          .prepare("SELECT COUNT(*) AS count FROM workflow_tombstones")
          .get() as { count: number }
      ).count,
    ).toBe(1);
    expect(
      (
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'external_actions'",
          )
          .get() as { name: string } | undefined
      )?.name,
    ).toBeUndefined();
    db.close();

    const reloaded = createProductStore({ runtimeConfig });
    const persisted = await reloaded.getState();
    expect(persisted.workspace.name).toBe("OysterWorkflow Demo");
    expect(persisted.installedWorkflows[0]?.workflowId).toBe(
      inboundWorkflow.workflow.id,
    );
    expect(persisted.workflowTombstones[0]).toMatchObject({
      workflowId: "inbound",
      workflowTitle: "Handle inbound opportunity",
    });
    expect(
      persisted.runEvents.some(
        (event) => event.status === "External action logged",
      ),
    ).toBe(false);
    expect(
      persisted.workers.find((worker) => worker.id === "sales")?.config,
    ).toMatchObject({
      hermesAgentReference: "hermes-profile:ow-sales-sales-ai-worker",
      approvalPolicy: "allow_all",
    });
  }, 10_000);

  it("repairs duplicate seeded sales workflow library entries from existing SQLite state", async () => {
    const runtimeConfig = createRuntimeConfig(tempRoot);
    const store = createProductStore({ runtimeConfig });
    await store.getState();

    const databasePath = join(tempRoot, "product-state.sqlite");
    const db = new DatabaseSync(databasePath);
    db.prepare(
      "UPDATE installed_workflows SET workflow_title = ?, description = ?, apps_json = ?, hermes_skill_path = ? WHERE id = ?",
    ).run(
      "Prepare renewal risk note",
      "Duplicate legacy placeholder",
      JSON.stringify(["Chrome"]),
      "/tmp/legacy-skill.md",
      "installed-sales-library-9",
    );

    const reloaded = createProductStore({ runtimeConfig });
    const repaired = await reloaded.getState();
    const repairedWorkflow = repaired.installedWorkflows.find(
      (workflow) => workflow.id === "installed-sales-library-9",
    );
    expect(repairedWorkflow).toMatchObject({
      workflowTitle: "Collect legal redlines",
      description:
        "Find contract redlines, summarize asks, and prepare a legal handoff",
      apps: ["Microsoft Outlook", "Google Drive", "Microsoft Word"],
    });
    expect(repairedWorkflow?.hermesSkillPath).toContain(
      "oysterworkflow-collect-legal-redlines",
    );
    await expect(
      stat(repairedWorkflow?.hermesSkillPath ?? ""),
    ).resolves.toBeTruthy();
    const salesWorkflowTitles = repaired.installedWorkflows
      .filter((workflow) => workflow.workerId === "sales")
      .map((workflow) => workflow.workflowTitle);
    expect(new Set(salesWorkflowTitles).size).toBe(salesWorkflowTitles.length);
  });

  it("rematerializes installed workflow skills that still point at legacy global Hermes paths", async () => {
    const runtimeConfig = createRuntimeConfig(tempRoot);
    const store = createProductStore({ runtimeConfig });
    await store.getState();

    const databasePath = join(tempRoot, "product-state.sqlite");
    const db = new DatabaseSync(databasePath);
    db.prepare(
      "UPDATE installed_workflows SET hermes_skill_path = ? WHERE id = ?",
    ).run(
      "/Users/alex/.hermes/skills/oysterworkflow-legacy/SKILL.md",
      "installed-meeting-actions",
    );
    db.close();

    const reloaded = createProductStore({ runtimeConfig });
    const repaired = await reloaded.getState();
    const workflow = repaired.installedWorkflows.find(
      (item) => item.id === "installed-meeting-actions",
    );

    expect(workflow?.hermesSkillPath).toContain(
      runtimeConfig.hermesProfilesRoot,
    );
    expect(workflow?.hermesSkillPath).toContain(
      "ow-sales-sales-ai-worker/skills/oysterworkflow-extract-action-items-from-customer-meeting/SKILL.md",
    );
    await expect(stat(workflow?.hermesSkillPath ?? "")).resolves.toBeTruthy();
  });

  it("materializes lab sessions into product capture, workflow, and artifact records", async () => {
    const runtimeConfig = createRuntimeConfig(tempRoot);
    const store = createProductStore({ runtimeConfig });
    const sessionDir = join(tempRoot, "runs", "ui-recording-codex-test-1234");
    const skillPath = join(sessionDir, "skill", "skill.json");
    const skillSummaryPath = join(sessionDir, "skill", "summary.json");
    const canonicalGraphPath = join(sessionDir, "skill", "workflow.json");
    const workflowCandidatePath = join(
      sessionDir,
      "skill",
      "workflow-candidate.json",
    );
    const workflowFamilyMatchPath = join(
      sessionDir,
      "skill",
      "workflow-family-match.json",
    );
    const workflowMarkdownPath = join(sessionDir, "skill", "WORKFLOW.md");
    const workflowRevisionsDir = join(
      sessionDir,
      "skill",
      ".workflow-revisions",
    );
    const summaryPath = join(sessionDir, "ingest", "summary.json");
    const workflowPath = join(sessionDir, "workflow", "workflow.json");
    const sessionPath = join(sessionDir, "session.json");
    await writeFile(skillPath, JSON.stringify({ ok: true }), {
      encoding: "utf8",
      flag: "w",
    }).catch(async () => {
      await import("node:fs/promises").then(({ mkdir }) =>
        mkdir(join(sessionDir, "skill"), { recursive: true }),
      );
      await writeFile(skillPath, JSON.stringify({ ok: true }), "utf8");
    });
    await import("node:fs/promises").then(({ mkdir }) =>
      Promise.all([
        mkdir(join(sessionDir, "ingest"), { recursive: true }),
        mkdir(join(sessionDir, "workflow"), { recursive: true }),
      ]),
    );
    await writeFile(summaryPath, JSON.stringify({ summary: true }), "utf8");
    await writeFile(workflowPath, JSON.stringify({ workflow: true }), "utf8");
    await writeFile(sessionPath, JSON.stringify({ session: true }), "utf8");
    await writeFile(skillSummaryPath, JSON.stringify({ skill: true }), "utf8");
    await mkdir(workflowRevisionsDir, { recursive: true });
    await writeFile(
      canonicalGraphPath,
      JSON.stringify({ schemaVersion: "oyster-workflow-graph-v2" }),
      "utf8",
    );
    await writeFile(workflowMarkdownPath, "# Workflow\n", "utf8");
    await writeFile(
      workflowCandidatePath,
      JSON.stringify({ schemaVersion: "oyster-workflow-candidate-v2" }),
      "utf8",
    );
    await writeFile(
      workflowFamilyMatchPath,
      JSON.stringify({ schemaVersion: "oyster-workflow-family-match-v1" }),
      "utf8",
    );
    await writeFile(
      join(workflowRevisionsDir, "revision-0001-test.json"),
      JSON.stringify({ revision: 1 }),
      "utf8",
    );

    const skill: OpenClawSkill = {
      schemaVersion: "openclaw-skill-v1",
      promptSet: null,
      skillId: "skill-lab-1",
      skillName: "Qualify captured customer inquiry",
      generatedAt: "2026-06-24T10:30:00.000Z",
      source: {
        runId: "run-lab-1",
        runDir: join(sessionDir, "ingest", "runs", "run-lab-1"),
        episodeId: "episode-1",
        startTs: "2026-06-24T10:00:00.000Z",
        endTs: "2026-06-24T10:06:00.000Z",
      },
      executionMode: "autonomous",
      shortDescription: "Read an inbound inquiry and prepare a safe reply.",
      description: "Generated from a real lab capture.",
      goal: "Qualify the customer inquiry.",
      whenToUse: ["Use for captured inbound inquiries."],
      whenNotToUse: [],
      inputs: [],
      outputs: [],
      prerequisites: ["Outlook is available."],
      steps: [
        {
          step: 1,
          instruction: "Check sender domain",
          intent: "Validate the lead before replying.",
          operationApp: "Microsoft Outlook",
          hints: ["Reject generic requests."],
        },
        {
          step: 2,
          instruction: "Search LinkedIn for company profile",
          intent: "Confirm public company signals.",
          operationApp: "LinkedIn",
          hints: [],
        },
      ],
      successCriteria: ["Reply draft is prepared."],
      failureModes: [],
      fallback: [],
      examples: [],
      tags: ["sales"],
      assets: [],
      evidence: {
        totalEvents: 20,
        anchorEvents: 2,
        ocrEvents: 8,
        appsSeen: ["Microsoft Outlook", "LinkedIn"],
        windowsSeen: ["Outlook"],
      },
    };
    const extractionSummary = {
      runId: "run-lab-1",
      episodeId: "episode-1",
      skillId: skill.skillId,
      generatedAt: skill.generatedAt,
      sourceEvents: 20,
      stepsCount: skill.steps.length,
      output: {
        outDir: join(sessionDir, "skill"),
        skillPath,
        summaryPath: skillSummaryPath,
        workflowCandidatePath,
        workflowFamilyMatchPath,
        workflowGraphPath: canonicalGraphPath,
        workflowMarkdownPath,
        workflowRevisionsDir,
      },
      warnings: [],
    } as NonNullable<LabSession["skillExtraction"]["summary"]>;
    const session = {
      schemaVersion: "recording-session-v1",
      sessionId: "ui-recording-codex-test-1234",
      sessionName: null,
      createdAt: "2026-06-24T10:00:00.000Z",
      updatedAt: "2026-06-24T10:31:00.000Z",
      status: "ready",
      paths: {
        sessionDir,
        dataDir: join(sessionDir, "screenpipe-data"),
        ingestOutDir: join(sessionDir, "ingest"),
        workflowDir: join(sessionDir, "workflow"),
        skillDir: join(sessionDir, "skill"),
        generalizationDir: join(sessionDir, "generalization"),
        plannerOptimizationDir: join(sessionDir, "planner-optimization"),
        sessionPath,
        recordingLogPath: join(sessionDir, "recording.log"),
        queryLogPath: join(sessionDir, "query-mode.log"),
      },
      recordingConfig: {
        ocrLanguagePriority: ["chinese", "english"],
        enableAudio: false,
      },
      screenpipe: {
        recordingDataBaseUrl: null,
        recording: {
          state: "stopped",
          pid: null,
          port: null,
          workdir: join(tempRoot, "screenpipe-work"),
          command: [],
          logPath: join(sessionDir, "recording.log"),
          startedAt: "2026-06-24T10:00:00.000Z",
          stoppedAt: "2026-06-24T10:06:00.000Z",
          exitCode: 0,
        },
        queryMode: {
          state: "stopped",
          pid: null,
          port: null,
          workdir: join(tempRoot, "screenpipe-work"),
          command: [],
          logPath: join(sessionDir, "query-mode.log"),
          startedAt: null,
          stoppedAt: null,
          exitCode: null,
        },
      },
      recordingWindow: {
        startedAt: "2026-06-24T10:00:00.000Z",
        requestedStopAt: "2026-06-24T10:06:00.000Z",
        scheduledStopAt: null,
        autoStopMinutes: null,
      },
      generationProgress: {
        currentStage: null,
        failedStage: null,
        failedAt: null,
        completedAt: null,
        stages: {
          "analyzing-recording": {
            startedAt: "2026-06-24T10:06:00.000Z",
            completedAt: "2026-06-24T10:06:01.000Z",
          },
          "discovering-workflow": { startedAt: null, completedAt: null },
          "building-skill": { startedAt: null, completedAt: null },
          "building-workflow-graph": { startedAt: null, completedAt: null },
        },
      },
      ingest: {
        latestRunId: "run-lab-1",
        latestRunDir: join(sessionDir, "ingest", "runs", "run-lab-1"),
        summaryPath,
        summary: {
          fetch: {
            rawUiEventsCount: 77,
            rawOcrCount: 144,
            rawAudioCount: 3,
          },
          timeWindow: {
            observed: { durationMs: 360000 },
            requested: { durationMs: 360000 },
          },
        } as unknown as LabSession["ingest"]["summary"],
      },
      selection: {
        workflowId: "workflow-1",
        workflowPath,
      },
      workflowDiscovery: {
        latestPath: workflowPath,
        workflowCandidates: [
          {
            workflowId: "workflow-1",
            name: "Qualify captured customer inquiry",
            description: "Use the captured Outlook flow as a reusable skill.",
            goal: "Prepare a qualified response.",
            priority: 1,
            confidence: 0.91,
            startEventId: "event-1",
            endEventId: "event-20",
            startTs: "2026-06-24T10:00:00.000Z",
            endTs: "2026-06-24T10:06:00.000Z",
            eventCount: 20,
          },
        ],
      },
      skillExtraction: {
        latestOutDir: join(sessionDir, "skill"),
        skillPath,
        summaryPath: skillSummaryPath,
        skill,
        summary: extractionSummary,
        artifacts: [
          {
            workflowId: "workflow-1",
            workflowPath,
            latestOutDir: join(sessionDir, "skill"),
            skillPath,
            summaryPath: skillSummaryPath,
            skill,
            summary: extractionSummary,
          },
        ],
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
    } as LabSession;

    const synced = await store.syncLabSessions([session]);
    const workflow = synced.workflows.find(
      (item) => item.id === `runtime-${session.sessionId}`,
    );
    expect(workflow).toMatchObject({
      title: "Qualify captured customer inquiry",
      status: "Generated",
      sourceType: "runtime",
      confidence: 91,
      apps: ["Microsoft Outlook", "LinkedIn"],
      stats: {
        uiEvents: 77,
        ocrObservations: 144,
        voiceNotes: 3,
        duration: "6:00",
        decisionPoints: 2,
      },
      artifactPath: skillPath,
    });
    expect(synced.captureSessions[0]).toMatchObject({
      labSessionId: session.sessionId,
      status: "generated",
      latestRunId: "run-lab-1",
      artifactMissing: false,
    });
    expect(
      synced.artifacts.some(
        (artifact) =>
          artifact.kind === "skill" &&
          artifact.path === skillPath &&
          artifact.status === "available",
      ),
    ).toBe(true);
    expect(
      synced.artifacts.filter((artifact) =>
        ["workflow-candidate", "workflow-family-match"].includes(artifact.kind),
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "workflow-candidate",
          path: workflowCandidatePath,
          status: "available",
        }),
        expect.objectContaining({
          kind: "workflow-family-match",
          path: workflowFamilyMatchPath,
          status: "available",
        }),
      ]),
    );
    expect(
      synced.artifacts.filter((artifact) =>
        ["workflow-graph", "workflow-markdown", "workflow-revisions"].includes(
          artifact.kind,
        ),
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "workflow-graph",
          path: canonicalGraphPath,
          status: "available",
        }),
        expect.objectContaining({
          kind: "workflow-markdown",
          path: workflowMarkdownPath,
          status: "available",
        }),
        expect.objectContaining({
          kind: "workflow-revisions",
          path: workflowRevisionsDir,
          status: "available",
        }),
      ]),
    );
    if (!workflow) {
      throw new Error("Expected the synchronized Product workflow.");
    }

    await rm(join(workflowRevisionsDir, "revision-0001-test.json"), {
      force: true,
    });
    const baseSkill: OpenClawSkill = {
      ...skill,
      skillId: "skill-family-base",
      generatedAt: "2026-06-24T10:20:00.000Z",
      source: {
        ...skill.source,
        episodeId: "episode-family-base",
      },
    };
    await rm(canonicalGraphPath, { force: true });
    const baseGraph = await materializeWorkflowGraphArtifacts({
      skill: baseSkill,
      outDir: join(sessionDir, "skill"),
      now: new Date("2026-06-24T10:20:00.000Z"),
    });
    const candidate = {
      schemaVersion: "oyster-workflow-candidate-v2",
      candidateId: "candidate.skill-lab-1",
      skillId: skill.skillId,
      name: baseGraph.graph.name,
      goal: baseGraph.graph.goal,
      entryNodeId: baseGraph.graph.entryNodeId,
      nodes: baseGraph.graph.nodes.map(
        ({ sourceRefs: _sourceRefs, ...node }) => node,
      ),
      transitions: baseGraph.graph.transitions.map(
        ({ sourceRefs: _sourceRefs, ...transition }) => transition,
      ),
    } as CandidateWorkflow;
    const proposal = normalizeWorkflowMergeProposal({
      raw: {
        result: "no_change",
        mergedGraph: { ...baseGraph.graph, revision: undefined },
        nodeMappings: candidate.nodes.map((node) => ({
          candidateNodeId: node.id,
          mergedNodeIds: [node.id],
          disposition: "reuse",
        })),
        transitionMappings: candidate.transitions.map((transition) => ({
          candidateTransitionId: transition.id,
          mergedTransitionIds: [transition.id],
          disposition: "reuse",
        })),
      },
      candidate,
      canonicalGraph: baseGraph.graph,
      skill,
      now: new Date("2026-06-24T10:32:00.000Z"),
    });
    await writeFile(
      join(sessionDir, "skill", "workflow-merge-proposal.json"),
      `${JSON.stringify(proposal, null, 2)}\n`,
      "utf8",
    );

    const appliedMerge = await store.applyWorkflowMergeProposal(workflow.id);
    expect(appliedMerge).toMatchObject({
      sourceWorkflowId: workflow.id,
      canonicalProductWorkflowId: workflow.id,
      alreadyApplied: false,
      canonicalGraph: {
        revision: {
          number: 2,
          previousRevisionId: baseGraph.graph.revision.revisionId,
        },
      },
    });
    const repeatedMerge = await store.applyWorkflowMergeProposal(workflow.id);
    expect(repeatedMerge.alreadyApplied).toBe(true);
    expect(repeatedMerge.canonicalGraph.revision.revisionId).toBe(
      appliedMerge.canonicalGraph.revision.revisionId,
    );
    const mergedWorkflowUpdatedAt = appliedMerge.state.workflows.find(
      (item) => item.id === workflow.id,
    )?.updatedAt;
    const resyncedAfterMerge = await store.syncLabSessions([session]);
    expect(resyncedAfterMerge.workflows[0]?.id).toBe(workflow.id);
    expect(resyncedAfterMerge.workflows[0]?.updatedAt).toBe(
      mergedWorkflowUpdatedAt,
    );

    const editableAction = repeatedMerge.canonicalGraph.nodes.find(
      (node) => node.type === "action",
    );
    if (!editableAction || editableAction.type !== "action") {
      throw new Error("Expected an editable action node.");
    }
    const editedGraph = await store.editWorkflowGraph(workflow.id, {
      expectedRevisionId: repeatedMerge.canonicalGraph.revision.revisionId,
      target: { kind: "node", id: editableAction.id, type: "action" },
      patch: { title: "Review the latest captured inquiry" },
    });
    expect(editedGraph.canonicalGraph.revision).toMatchObject({
      number: 3,
      previousRevisionId: repeatedMerge.canonicalGraph.revision.revisionId,
    });
    expect(
      editedGraph.canonicalGraph.nodes.find(
        (node) => node.id === editableAction.id,
      )?.title,
    ).toBe("Review the latest captured inquiry");
    expect(
      (await store.listWorkflowVersions(workflow.id)).versions,
    ).toHaveLength(3);
    await expect(
      store.editWorkflowGraph(workflow.id, {
        expectedRevisionId: repeatedMerge.canonicalGraph.revision.revisionId,
        target: { kind: "node", id: editableAction.id, type: "action" },
        patch: { title: "Overwrite a newer revision" },
      }),
    ).rejects.toThrow("工作流图版本已更新");

    const db = new DatabaseSync(join(tempRoot, "product-state.sqlite"));
    expect(
      (
        db.prepare("SELECT COUNT(*) AS count FROM capture_sessions").get() as {
          count: number;
        }
      ).count,
    ).toBe(1);
    expect(
      (
        db.prepare("SELECT COUNT(*) AS count FROM product_artifacts").get() as {
          count: number;
        }
      ).count,
    ).toBeGreaterThan(0);

    const reloaded = createProductStore({ runtimeConfig });
    const persisted = await reloaded.getState();
    expect(
      persisted.captureSessions.find(
        (item) => item.labSessionId === session.sessionId,
      ),
    ).toMatchObject({
      title: "Qualify captured customer inquiry",
      status: "generated",
    });
    expect(
      persisted.workflows.find((item) => item.id === workflow?.id),
    ).toMatchObject({
      sourceType: "runtime",
      status: "Generated",
    });

    await rm(canonicalGraphPath, { force: true });
    await expect(
      reloaded.installWorkflow({
        workerId: "sales",
        workflowId: workflow!.id,
        workflowTitle: workflow!.title,
        description: workflow!.description,
        apps: workflow!.apps,
        skillPath,
      }),
    ).rejects.toThrow(/workflow\.json is missing/u);

    await rm(sessionDir, { recursive: true, force: true });
    const missing = await reloaded.syncLabSessions([]);
    expect(
      missing.captureSessions.find(
        (item) => item.labSessionId === session.sessionId,
      ),
    ).toMatchObject({
      artifactMissing: true,
    });
    expect(
      missing.artifacts
        .filter(
          (artifact) =>
            artifact.captureSessionId === `capture-${session.sessionId}`,
        )
        .every((artifact) => artifact.status === "missing"),
    ).toBe(true);
  });

  it("renders generated workflow skills into Hermes SKILL.md files when installing to a worker", async () => {
    const runtimeConfig = createRuntimeConfig(tempRoot);
    const seedStore = createProductStore({ runtimeConfig });
    const sourceDir = join(tempRoot, "generated-source-skill");
    const sourceSkillPath = join(sourceDir, "skill.json");
    await import("node:fs/promises").then(({ mkdir }) =>
      mkdir(sourceDir, { recursive: true }),
    );

    const sourceSkill: OpenClawSkill = {
      schemaVersion: "openclaw-skill-v1",
      promptSet: "specific-v2",
      skillId: "skill-captured-sales-inquiry",
      skillName: "Qualify captured customer inquiry",
      generatedAt: "2026-06-24T10:30:00.000Z",
      source: {
        runId: "run-captured-sales-inquiry",
        runDir: join(tempRoot, "runs", "run-captured-sales-inquiry"),
        episodeId: "episode-1",
        startTs: "2026-06-24T10:00:00.000Z",
        endTs: "2026-06-24T10:06:00.000Z",
      },
      executionMode: "autonomous",
      shortDescription: "Read an inbound inquiry and prepare a safe reply.",
      description:
        "Generated from a real capture where Alex qualifies an inbound customer email.",
      goal: "Qualify the customer inquiry and leave a reply draft ready.",
      whenToUse: ["Use when a new inbound sales inquiry arrives."],
      whenNotToUse: ["Do not use for spam or personal email."],
      inputs: [
        {
          name: "Inbound email thread",
          description: "The customer inquiry that should be qualified.",
          required: true,
        },
      ],
      outputs: [
        {
          name: "Qualified reply draft",
          description: "A reply draft that is reviewed but not sent.",
          required: true,
        },
      ],
      prerequisites: ["Outlook is signed in.", "LinkedIn is available."],
      steps: [
        {
          step: 1,
          instruction: "Check sender domain",
          intent: "Validate the lead before replying.",
          operationApp: "Microsoft Outlook",
          hints: ["Reject generic requests."],
        },
        {
          step: 2,
          instruction: "Search LinkedIn for company profile",
          intent: "Confirm public company signals.",
          operationApp: "LinkedIn",
          hints: ["Prefer official company pages over personal profiles."],
        },
      ],
      successCriteria: ["Reply draft is prepared but not sent."],
      failureModes: ["Company identity cannot be verified."],
      fallback: ["Ask Alex for clarification."],
      examples: [],
      tags: ["sales", "inbound"],
      assets: [],
      evidence: {
        totalEvents: 48,
        anchorEvents: 2,
        ocrEvents: 24,
        appsSeen: ["Microsoft Outlook", "LinkedIn"],
        windowsSeen: ["Outlook"],
      },
    };
    await writeFile(
      sourceSkillPath,
      JSON.stringify(sourceSkill, null, 2),
      "utf8",
    );
    await materializeWorkflowGraphArtifacts({
      skill: sourceSkill,
      outDir: sourceDir,
      sourceSkillPath,
    });

    await seedStore.getState();
    const database = new DatabaseSync(join(tempRoot, "product-state.sqlite"));
    database
      .prepare(
        "UPDATE workflows SET title = ?, description = ?, status = 'Generated', source_type = 'runtime', artifact_path = ?, updated_at = ? WHERE id = 'inbound'",
      )
      .run(
        sourceSkill.skillName,
        sourceSkill.description,
        sourceSkillPath,
        new Date().toISOString(),
      );
    database.close();
    const decoySkillPath = join(sourceDir, "cloud-decoy", "SKILL.md");
    await mkdir(join(sourceDir, "cloud-decoy"), { recursive: true });
    await writeFile(decoySkillPath, "# Incomplete cloud cache\n", "utf8");
    const store = createProductStore({ runtimeConfig });

    const installed = await store.installWorkflow({
      workerId: "sales",
      workflowId: "inbound",
      workflowTitle: sourceSkill.skillName,
      description: sourceSkill.description,
      apps: ["Microsoft Outlook", "LinkedIn"],
      skillPath: decoySkillPath,
    });

    expect(installed.installedWorkflow.workerId).toBe("sales");
    expect(installed.installedWorkflow.hermesSkillPath).toMatch(/SKILL\.md$/u);
    expect(installed.installedWorkflow.hermesSkillPath).toContain(
      join(tempRoot, "hermes-profiles", "ow-sales-sales-ai-worker", "skills"),
    );
    expect(installed.installedWorkflow.sourceSkillPath).toBe(sourceSkillPath);
    expect(installed.installedWorkflow.sourceWorkflowRevisionId).toEqual(
      expect.any(String),
    );
    const hermesSkill = await readFile(
      installed.installedWorkflow.hermesSkillPath,
      "utf8",
    );
    expect(hermesSkill).toMatch(
      /^---\nname: "qualify-captured-customer-inquiry"\ndescription: /u,
    );
    expect(hermesSkill).toContain("# Qualify captured customer inquiry");
    expect(hermesSkill).toContain("## Goal");
    expect(hermesSkill).toContain(
      "Qualify the customer inquiry and leave a reply draft ready.",
    );
    expect(hermesSkill).not.toContain("## Steps");
    expect(hermesSkill).toContain("## Failure Modes");
    expect(hermesSkill).toContain("Company identity cannot be verified.");
    expect(hermesSkill).toContain("## Fallback");
    expect(hermesSkill).toContain("Ask Alex for clarification.");
    expect(hermesSkill).toContain("## Canonical Execution Graph");
    expect(hermesSkill).toContain("read [WORKFLOW.md](./WORKFLOW.md)");
    expect(hermesSkill).toContain("## Connected App Capabilities");
    expect(hermesSkill).toContain(
      "use that direct app capability before browser automation, `computer_use`, or AppleScript",
    );
    expect(hermesSkill).toContain(
      "Prefer Composio hosted MCP, native MCP tools, or direct app APIs for supported apps",
    );
    expect(hermesSkill).toContain("## BrowserAct Browser");
    expect(hermesSkill).toContain(
      "start with the OysterWorkflow BrowserAct wrapper exposed at `$OYSTER_BROWSER_CLI`",
    );
    expect(hermesSkill).toContain(
      "Browser automation priority after direct app capabilities: `$OYSTER_BROWSER_CLI` first, then Hermes built-in browser automation, then `computer_use`, then AppleScript/`osascript`/System Events only as the last fallback.",
    );
    expect(hermesSkill).toContain(
      "Native desktop app priority after direct app capabilities: `computer_use` first, then AppleScript/`osascript`/System Events only as the last fallback.",
    );
    expect(hermesSkill).toContain("Permission model: allow_all");
    expect(hermesSkill).toContain("AppleScript");
    expect(hermesSkill).toContain("Failure rule");
    expect(hermesSkill).toContain("Evidence rule");
    expect(hermesSkill).toContain(
      "Do not treat previous run summaries, old session history, cached draft claims, or cached CRM claims as proof of completion.",
    );
    expect(hermesSkill).toContain("Skill rule");
    expect(hermesSkill).toContain("Noise rule");
    expect(hermesSkill).toContain("## User-facing response policy");
    expect(hermesSkill).toContain("do not mention Hermes, BrowserAct");
    expect(hermesSkill).toContain("Never include raw stdout or stderr");
    expect(hermesSkill).not.toContain("## Apps");
    const hermesSkillDir = join(
      tempRoot,
      "hermes-profiles",
      "ow-sales-sales-ai-worker",
      "skills",
      "oysterworkflow-qualify-captured-customer-inquiry",
    );
    await Promise.all([
      access(join(hermesSkillDir, "workflow.json")),
      access(join(hermesSkillDir, "WORKFLOW.md")),
      access(join(hermesSkillDir, ".workflow-revisions")),
    ]);
    await store.installWorkflow({
      workerId: "sales",
      workflowId: "inbound",
      workflowTitle: sourceSkill.skillName,
      description: sourceSkill.description,
      apps: ["Microsoft Outlook", "LinkedIn"],
      skillPath: installed.installedWorkflow.hermesSkillPath,
    });
    expect(
      await readdir(join(hermesSkillDir, ".workflow-revisions")),
    ).toHaveLength(1);
    expect(hermesSkill).not.toContain("## Evidence");
    expect(hermesSkill).not.toContain("1. **Check sender domain**");
    expect(hermesSkill).not.toContain("App: Microsoft Outlook");
    expect(hermesSkill).not.toContain(
      "2. **Search LinkedIn for company profile**",
    );
    expect(hermesSkill).not.toContain("OYSTERWORKFLOW_EXTERNAL_ACTION");
    expect(hermesSkill).not.toContain('"app":"Microsoft Outlook"');
    expect(hermesSkill).not.toContain('"schemaVersion"');

    const reloaded = createProductStore({ runtimeConfig });
    expect(
      (await reloaded.getState()).installedWorkflows.find(
        (workflow) => workflow.workflowId === "inbound",
      ),
    ).toMatchObject({
      sourceSkillPath,
      sourceWorkflowRevisionId: expect.any(String),
    });

    const exported = await store.exportCloudSnapshot();
    expect(JSON.stringify(exported)).not.toContain("inbound");
    expect(
      exported.workers.find((worker) => worker.workerId === "sales"),
    ).not.toHaveProperty("workflowIds");

    const preserved = await store.applyCloudSnapshot({
      snapshot: {
        ...exported,
        devices: [
          {
            schemaVersion: "oyster-device-manifest-v1",
            deviceId: "device-local-canonical-test",
            name: "Local canonical test computer",
            platform: "darwin",
            runtimeVersion: "OysterWorkflow 0.2.0",
            capabilities: ["local-ai-worker"],
            lastSeenAt: new Date().toISOString(),
            revokedAt: null,
          },
        ],
      },
      user: {
        id: "local-canonical-user",
        email: "local-canonical@example.com",
        displayName: "Local Canonical User",
      },
      localDeviceId: "device-local-canonical-test",
      replacePortableState: false,
      syncRevision: 20,
    });
    expect(
      preserved.workflows.find((workflow) => workflow.id === "inbound")
        ?.artifactPath,
    ).toBe(sourceSkillPath);
    expect(
      preserved.installedWorkflows.find(
        (workflow) => workflow.workflowId === "inbound",
      )?.sourceSkillPath,
    ).toBe(sourceSkillPath);
  });

  it("removes legacy OysterWorkflow external action markers when reinstalling Markdown Hermes skills", async () => {
    const runtimeConfig = createRuntimeConfig(tempRoot);
    const seedStore = createProductStore({ runtimeConfig });
    const sourceDir = join(tempRoot, "legacy-hermes-skill");
    const sourceSkillPath = join(sourceDir, "SKILL.md");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(
      sourceSkillPath,
      [
        "---",
        'name: "legacy-yc-review"',
        'description: "Review a YC profile and prepare talking points."',
        "---",
        "",
        "# Review a YC profile",
        "",
        "## OysterWorkflow",
        "",
        "- Workflow ID: workflow-yc-review",
        "- Worker Agent: hermes-profile:ow-sales-sales-ai-worker",
        "- External actions are allowed, but every meaningful action must be logged with the OysterWorkflow action marker below.",
        "",
        "## OysterWorkflow Action Log",
        "",
        "Before each external app action, emit this marker:",
        "",
        'OYSTERWORKFLOW_EXTERNAL_ACTION {"app":"Google Chrome","action":"Open YC Co-Founder Matching","risk":"low"}',
        "",
        "## Steps",
        "",
        "1. Open YC Co-Founder Matching in Google Chrome.",
        "2. Review the visible profile.",
      ].join("\n"),
      "utf8",
    );
    const created = await seedStore.createWorkflow({
      mode: "import",
      title: "Review a YC profile",
      description: "Review a YC profile and prepare talking points.",
      apps: ["Google Chrome"],
      sourceText: "Review the imported YC workflow.",
    });
    const database = new DatabaseSync(join(tempRoot, "product-state.sqlite"));
    database
      .prepare("UPDATE workflows SET artifact_path = ? WHERE id = ?")
      .run(sourceSkillPath, created.workflow.id);
    database.close();
    const store = createProductStore({ runtimeConfig });

    const installed = await store.installWorkflow({
      workerId: "sales",
      workflowId: created.workflow.id,
      workflowTitle: "Review a YC profile",
      description: "Review a YC profile and prepare talking points.",
      apps: ["Google Chrome"],
      skillPath: sourceSkillPath,
    });

    const hermesSkill = await readFile(
      installed.installedWorkflow.hermesSkillPath,
      "utf8",
    );
    expect(hermesSkill).toContain("# Review a YC profile");
    expect(hermesSkill).toContain("## OysterWorkflow");
    expect(hermesSkill).toContain("## Steps");
    expect(hermesSkill).toContain("1. Open YC Co-Founder Matching");
    expect(hermesSkill).not.toContain("## OysterWorkflow Action Log");
    expect(hermesSkill).not.toContain("OYSTERWORKFLOW_EXTERNAL_ACTION");
    expect(hermesSkill).not.toContain("External actions are allowed");
    expect(hermesSkill).not.toContain('"app":"Google Chrome"');
  });

  it("persists recorder permission snapshots without mutating device records", async () => {
    const runtimeConfig = createRuntimeConfig(tempRoot);
    const store = createProductStore({ runtimeConfig });
    const before = await store.getState();
    const devicesBefore = before.devices;

    const updated = await store.recordPermissionSnapshot({
      checkedAt: "2026-06-24T11:30:00.000Z",
      allGranted: false,
      canStartRecording: false,
      source: "screenpipe-probe",
      summary: "Accessibility permission is missing.",
      items: [
        {
          kind: "accessibility",
          label: "Accessibility",
          description: "Required for local automation.",
          state: "missing",
          detail: "Enable Accessibility for OysterWorkflow.",
        },
      ],
    });

    expect(updated.permissionSnapshot).toMatchObject({
      checkedAt: "2026-06-24T11:30:00.000Z",
      allGranted: false,
      canStartRecording: false,
      source: "screenpipe-probe",
      summary: "Accessibility permission is missing.",
    });
    expect(updated.devices).toEqual(devicesBefore);

    const db = new DatabaseSync(join(tempRoot, "product-state.sqlite"));
    expect(
      (
        db
          .prepare("SELECT COUNT(*) AS count FROM permission_snapshots")
          .get() as { count: number }
      ).count,
    ).toBe(1);

    const reloaded = createProductStore({ runtimeConfig });
    const persisted = await reloaded.getState();
    expect(persisted.permissionSnapshot).toMatchObject({
      source: "screenpipe-probe",
      items: [
        {
          kind: "accessibility",
          state: "missing",
        },
      ],
    });
    expect(persisted.devices).toEqual(devicesBefore);
  });

  it("blocks workflow Run when the deploy target is missing", async () => {
    const runtimeConfig = createRuntimeConfig(tempRoot);
    const store = createProductStore({ runtimeConfig });
    const before = await store.getState();
    const databasePath = join(tempRoot, "product-state.sqlite");
    const db = new DatabaseSync(databasePath);
    db.prepare(
      "UPDATE installed_workflows SET deploy_target_device_id = ? WHERE worker_id = ?",
    ).run("missing-device", "sales");

    const reloaded = createProductStore({ runtimeConfig });
    await expect(
      reloaded.runInstalledWorkflow("installed-meeting-actions"),
    ).rejects.toThrow(
      "Choose a valid deploy target before running this workflow.",
    );
    const after = await reloaded.getState();
    expect(after.runs).toHaveLength(before.runs.length);
  });

  it("assigns a trusted device to a worker and persists the assignment", async () => {
    const runtimeConfig = createRuntimeConfig(tempRoot);
    const store = createProductStore({ runtimeConfig });

    const result = await store.assignDevice({
      workerId: "finance",
      deviceId: "alex-mbp",
    });

    expect(result.worker).toMatchObject({
      id: "finance",
      deviceId: "alex-mbp",
      status: "No active task",
      tone: "idle",
      heartbeat: "Alex's MacBook Pro assigned",
    });
    expect(result.device).toMatchObject({
      id: "alex-mbp",
      assignedWorkerId: "finance",
    });
    expect(
      result.state.workers.find((worker) => worker.id === "sales"),
    ).toMatchObject({
      deviceId: null,
      status: "Needs device",
      heartbeat: "No computer assigned",
    });

    const reloaded = createProductStore({ runtimeConfig });
    const persisted = await reloaded.getState();
    expect(
      persisted.devices.find((device) => device.id === "alex-mbp"),
    ).toMatchObject({
      assignedWorkerId: "finance",
    });
    expect(
      persisted.workers.find((worker) => worker.id === "finance"),
    ).toMatchObject({
      deviceId: "alex-mbp",
    });
  });

  it("blocks workflow Run when the deploy target is unavailable", async () => {
    const runtimeConfig = createRuntimeConfig(tempRoot);
    const store = createProductStore({ runtimeConfig });
    const before = await store.getState();
    const databasePath = join(tempRoot, "product-state.sqlite");
    const db = new DatabaseSync(databasePath);
    db.prepare("UPDATE devices SET status = ? WHERE id = ?").run(
      "Needs attention",
      "alex-mbp",
    );

    const reloaded = createProductStore({ runtimeConfig });
    await expect(
      reloaded.runInstalledWorkflow("installed-meeting-actions"),
    ).rejects.toThrow("Deploy target is not available right now.");
    const after = await reloaded.getState();
    expect(after.runs).toHaveLength(before.runs.length);
  });

  it("validates workflow Run before touching Hermes when the deploy target is unavailable", async () => {
    const runtimeConfig = createRuntimeConfig(tempRoot);
    const hermesMarkerPath = join(tempRoot, "hermes-called-before-validation");
    const hermesPath = join(tempRoot, "fake-hermes-validation-order");
    await writeFile(
      hermesPath,
      `#!/bin/sh
touch "${hermesMarkerPath}"
echo "Hermes should not be called before deploy target validation" >&2
exit 1
`,
      "utf8",
    );
    await chmod(hermesPath, 0o755);
    process.env.OYSTERWORKFLOW_HERMES_COMMAND = hermesPath;
    const store = createProductStore({ runtimeConfig });
    const before = await store.getState();
    const databasePath = join(tempRoot, "product-state.sqlite");
    const db = new DatabaseSync(databasePath);
    db.prepare("UPDATE devices SET status = ? WHERE id = ?").run(
      "Needs attention",
      "alex-mbp",
    );
    db.close();

    const reloaded = createProductStore({ runtimeConfig });
    await expect(
      reloaded.runInstalledWorkflow("installed-meeting-actions"),
    ).rejects.toThrow("Deploy target is not available right now.");
    await expect(stat(hermesMarkerPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    const after = await reloaded.getState();
    expect(after.runs).toHaveLength(before.runs.length);
  });

  it("blocks workflow Run when the deploy target is assigned to another worker", async () => {
    const runtimeConfig = createRuntimeConfig(tempRoot);
    const store = createProductStore({ runtimeConfig });
    const before = await store.getState();
    const databasePath = join(tempRoot, "product-state.sqlite");
    const db = new DatabaseSync(databasePath);
    db.prepare("UPDATE devices SET assigned_worker_id = ? WHERE id = ?").run(
      "product",
      "alex-mbp",
    );

    const reloaded = createProductStore({ runtimeConfig });
    await expect(
      reloaded.runInstalledWorkflow("installed-meeting-actions"),
    ).rejects.toThrow("Deploy target is assigned to another worker.");
    const after = await reloaded.getState();
    expect(after.runs).toHaveLength(before.runs.length);
  });

  it("rejects status changes for unknown installed workflows", async () => {
    const runtimeConfig = createRuntimeConfig(tempRoot);
    const store = createProductStore({ runtimeConfig });

    await expect(
      store.toggleInstalledWorkflow("installed-does-not-exist", "Paused"),
    ).rejects.toThrow("Unknown installed workflow: installed-does-not-exist");
  });

  it("removes installed workflows without deleting historical runs", async () => {
    const runtimeConfig = createRuntimeConfig(tempRoot);
    const store = createProductStore({ runtimeConfig });
    const before = await store.getState();
    expect(
      before.installedWorkflows.some(
        (workflow) => workflow.id === "installed-meeting-actions",
      ),
    ).toBe(true);

    const removed = await store.deleteInstalledWorkflow(
      "installed-meeting-actions",
    );

    expect(removed.installedWorkflow).toMatchObject({
      id: "installed-meeting-actions",
      baselineRuns: 34,
      baselineSuccesses: 33,
    });
    expect(
      removed.state.installedWorkflows.some(
        (workflow) => workflow.id === "installed-meeting-actions",
      ),
    ).toBe(false);
    expect(
      removed.state.runs.some(
        (run) => run.installedWorkflowId === "installed-meeting-actions",
      ),
    ).toBe(true);
    expect(
      removed.state.approvalPolicies.some(
        (policy) =>
          policy.id === "approval-policy-installed-installed-meeting-actions",
      ),
    ).toBe(false);

    const reloaded = createProductStore({ runtimeConfig });
    const persisted = await reloaded.getState();
    expect(
      persisted.installedWorkflows.some(
        (workflow) => workflow.id === "installed-meeting-actions",
      ),
    ).toBe(false);
    expect(
      persisted.runs.some(
        (run) => run.installedWorkflowId === "installed-meeting-actions",
      ),
    ).toBe(true);
  });

  it("deletes a worker and workspace bindings while preserving run history", async () => {
    const runtimeConfig = createRuntimeConfig(tempRoot);
    const store = createProductStore({ runtimeConfig });
    const before = await store.getState();
    const salesAssignments = before.installedWorkflows.filter(
      (workflow) => workflow.workerId === "sales",
    );
    const salesRunIds = before.runs
      .filter((run) => run.workerId === "sales")
      .map((run) => run.id);

    const deleted = await store.deleteWorker("sales");

    expect(deleted.worker).toMatchObject({
      id: "sales",
      name: "Sales AI Worker",
    });
    expect(deleted.state.workers.some((worker) => worker.id === "sales")).toBe(
      false,
    );
    expect(
      deleted.state.installedWorkflows.some(
        (workflow) => workflow.workerId === "sales",
      ),
    ).toBe(false);
    expect(
      deleted.state.devices.some(
        (device) => device.assignedWorkerId === "sales",
      ),
    ).toBe(false);
    expect(
      deleted.state.approvalPolicies.some(
        (policy) =>
          (policy.scopeType === "worker" && policy.scopeId === "sales") ||
          (policy.scopeType === "installed_workflow" &&
            salesAssignments.some(
              (assignment) => assignment.id === policy.scopeId,
            )),
      ),
    ).toBe(false);
    expect(
      deleted.state.runs
        .filter((run) => run.workerId === "sales")
        .map((run) => run.id),
    ).toEqual(salesRunIds);
    expect(deleted.state.pendingCloudDeletes).toEqual([
      expect.objectContaining({ entityType: "worker", entityId: "sales" }),
    ]);

    const reloaded = createProductStore({ runtimeConfig });
    const persisted = await reloaded.getState();
    expect(persisted.workers.some((worker) => worker.id === "sales")).toBe(
      false,
    );
    expect(
      persisted.runs
        .filter((run) => run.workerId === "sales")
        .map((run) => run.id),
    ).toEqual(salesRunIds);
  });

  it("rejects deleting an unknown worker", async () => {
    const store = createProductStore({
      runtimeConfig: createRuntimeConfig(tempRoot),
    });

    await expect(store.deleteWorker("worker-does-not-exist")).rejects.toThrow(
      "Unknown worker: worker-does-not-exist",
    );
  });

  it("repairs stale active runs and working worker state on startup", async () => {
    const runtimeConfig = createRuntimeConfig(tempRoot);
    const store = createProductStore({ runtimeConfig });
    await store.getState();

    const databasePath = join(tempRoot, "product-state.sqlite");
    const db = new DatabaseSync(databasePath);
    db.prepare(
      "UPDATE runs SET status = 'running', ended_at = NULL, error_message = NULL WHERE id = ?",
    ).run("run-installed-meeting-actions-18");
    db.prepare(
      "UPDATE workers SET status = 'Working', tone = 'working', heartbeat = ?, activities_json = ? WHERE id = ?",
    ).run(
      "Hermes Agent connected",
      JSON.stringify(["Run was active before restart"]),
      "sales",
    );

    const reloaded = createProductStore({ runtimeConfig });
    const repaired = await reloaded.getState();
    expect(
      repaired.runs.find(
        (run) => run.id === "run-installed-meeting-actions-18",
      ),
    ).toMatchObject({
      status: "failed",
      errorMessage: "Runtime restarted before this run finished.",
    });
    expect(
      repaired.runs.find((run) => run.id === "run-installed-meeting-actions-18")
        ?.endedAt,
    ).toEqual(expect.any(String));
    expect(
      repaired.workers.find((worker) => worker.id === "sales"),
    ).toMatchObject({
      status: "No active task",
      tone: "idle",
      heartbeat: "Recovered after restart",
    });
    expect(
      repaired.runEvents.filter(
        (event) =>
          event.id === "event-recovered-run-installed-meeting-actions-18",
      ),
    ).toHaveLength(1);

    const reloadedAgain = createProductStore({ runtimeConfig });
    const stable = await reloadedAgain.getState();
    expect(
      stable.runEvents.filter(
        (event) =>
          event.id === "event-recovered-run-installed-meeting-actions-18",
      ),
    ).toHaveLength(1);
  });

  it("keeps a newer local mutation when an older cloud acknowledgement arrives", async () => {
    const store = createProductStore({
      runtimeConfig: createRuntimeConfig(tempRoot, "empty"),
    });
    const user = {
      id: "local-wins-user",
      email: "local-wins@example.com",
      displayName: "Local Wins User",
    };
    await store.applyCloudSnapshot({
      snapshot: {
        devices: [],
        workers: [
          {
            schemaVersion: "oyster-worker-manifest-v1",
            workerId: "local-wins-worker",
            name: "Local Wins Worker",
            initials: "LW",
            description: "Protect concurrent local edits.",
            avatarKey: "product",
            config: {
              identityScope: "Original scope",
              runtimeProfile: "Original runtime",
              toolAccess: [],
              memoryContext: "Original memory",
              approvalPolicy: "allow_all",
              heartbeatPolicy: "Original heartbeat",
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
        upserted: { workerIds: [] },
        deleted: { workerIds: [] },
      },
      user,
      localDeviceId: "local-wins-device",
      replacePortableState: true,
      syncRevision: 1,
    });
    const originalWorker = (await store.getState()).workers[0]!;
    await store.updateWorkerConfig(originalWorker.id, {
      ...originalWorker.config,
      memoryContext: "Exported version one",
    });
    const exportedVersionOne = await store.exportCloudSnapshot();
    const versionOneToken =
      exportedVersionOne.mutationTokens?.upserted.workerIds[originalWorker.id];
    expect(versionOneToken).toEqual(expect.any(String));

    await store.updateWorkerConfig(originalWorker.id, {
      ...originalWorker.config,
      memoryContext: "Newer local version two",
    });
    const afterStaleAcknowledgement = await store.applyCloudSnapshot({
      snapshot: exportedVersionOne,
      user,
      localDeviceId: "local-wins-device",
      replacePortableState: false,
      syncRevision: 2,
      acknowledgedCloudMutationTokens: exportedVersionOne.mutationTokens,
    });

    expect(
      afterStaleAcknowledgement.workers.find(
        (worker) => worker.id === originalWorker.id,
      )?.config.memoryContext,
    ).toBe("Newer local version two");
    expect(afterStaleAcknowledgement.pendingCloudUpserts).toContainEqual(
      expect.objectContaining({
        entityType: "worker",
        entityId: originalWorker.id,
      }),
    );
    const exportedVersionTwo = await store.exportCloudSnapshot();
    expect(
      exportedVersionTwo.mutationTokens?.upserted.workerIds[originalWorker.id],
    ).not.toBe(versionOneToken);

    const afterCurrentAcknowledgement = await store.applyCloudSnapshot({
      snapshot: exportedVersionTwo,
      user,
      localDeviceId: "local-wins-device",
      replacePortableState: false,
      syncRevision: 3,
      acknowledgedCloudMutationTokens: exportedVersionTwo.mutationTokens,
    });
    expect(afterCurrentAcknowledgement.pendingCloudUpserts).toEqual([]);
    expect(
      afterCurrentAcknowledgement.workers.find(
        (worker) => worker.id === originalWorker.id,
      )?.config.memoryContext,
    ).toBe("Newer local version two");
  });

  it("ignores legacy workflow content in incoming cloud snapshots", async () => {
    const store = createProductStore({
      runtimeConfig: createRuntimeConfig(tempRoot, "empty"),
    });
    await store.createWorkflow({
      mode: "new",
      title: "Local private workflow",
      description: "This workflow must remain on the current device.",
      apps: ["Private app"],
    });

    const applied = await store.applyCloudSnapshot({
      snapshot: {
        devices: [],
        workers: [],
        workflows: [
          {
            workflowId: "legacy-cloud-workflow",
            title: "Legacy sensitive workflow",
            skillPackage: {
              format: "skill-markdown-v1",
              sha256: "0".repeat(64),
              content: "Sensitive legacy cloud content",
            },
          },
        ],
        assignments: [],
        upserted: { workerIds: [] },
        deleted: { workerIds: [] },
      } as unknown as CloudPortableSnapshot,
      user: {
        id: "local-only-user",
        email: "local-only@example.com",
        displayName: "Local Only User",
      },
      localDeviceId: "local-only-device",
      replacePortableState: false,
      syncRevision: 1,
    });

    expect(applied.workflows.map((workflow) => workflow.title)).toEqual([
      "Local private workflow",
    ]);
    expect(JSON.stringify(applied)).not.toContain("Sensitive legacy cloud");
  });

  it("keeps workflow definitions and assignments out of cloud snapshots", async () => {
    const sourceRoot = join(tempRoot, "cloud-source");
    const sourceStore = createProductStore({
      runtimeConfig: createRuntimeConfig(sourceRoot),
    });
    const installed = await sourceStore.installWorkflow({
      workerId: "sales",
      workflowId: "inbound",
      workflowTitle: "Handle inbound opportunity",
      description: "Qualify customer emails and prepare follow-up.",
      apps: ["Microsoft Outlook", "Gmail", "Slack", "Salesforce"],
    });
    const exported = await sourceStore.exportCloudSnapshot();
    expect(
      exported.workers.find((worker) => worker.workerId === "sales"),
    ).not.toHaveProperty("workflowIds");
    expect(exported).not.toHaveProperty("workflows");
    expect(exported).not.toHaveProperty("assignments");
    expect(JSON.stringify(exported)).not.toContain("inbound");
    expect(installed.state.installedWorkflows).not.toHaveLength(0);

    const targetRoot = join(tempRoot, "cloud-target");
    const targetStore = createProductStore({
      runtimeConfig: createRuntimeConfig(targetRoot),
    });
    const imported = await targetStore.applyCloudSnapshot({
      snapshot: {
        ...exported,
        devices: [
          {
            schemaVersion: "oyster-device-manifest-v1",
            deviceId: "device-cloud-test",
            name: "Cloud test computer",
            platform: "darwin",
            runtimeVersion: "OysterWorkflow 0.1.0",
            capabilities: ["local-ai-worker"],
            lastSeenAt: new Date().toISOString(),
            revokedAt: null,
          },
        ],
      },
      user: {
        id: "cloud-user-test",
        email: "cloud@example.com",
        displayName: "Cloud User",
      },
      localDeviceId: "device-cloud-test",
      replacePortableState: true,
      syncRevision: 12,
    });

    expect(imported.account).toMatchObject({
      cloudProvider: "supabase",
      cloudUserId: "cloud-user-test",
      cloudSyncRevision: 12,
      email: "cloud@example.com",
      name: "Cloud User",
      setupCompleted: true,
    });
    expect(imported.workspace.mode).toBe("cloud-linked");
    expect(
      imported.workers.find((worker) => worker.id === "sales"),
    ).toMatchObject({
      deviceId: "device-cloud-test",
      heartbeat: "Synced to this computer",
    });
    expect(imported.workflows).toEqual([]);
    expect(imported.installedWorkflows).toEqual([]);
  });
});

function createRuntimeConfig(
  root: string,
  productSeedMode: RuntimeConfig["productSeedMode"] = "demo",
): RuntimeConfig {
  const hermesRuntimeRoot = join(root, "hermes-runtime");
  return {
    mode: "test",
    productSeedMode,
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
    hermesProfilesRoot:
      process.env.OYSTERWORKFLOW_HERMES_PROFILES_ROOT ??
      join(hermesRuntimeRoot, "profiles"),
    hermesSkillsRoot:
      process.env.OYSTERWORKFLOW_HERMES_SKILLS_ROOT ??
      join(hermesRuntimeRoot, "skills"),
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
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
