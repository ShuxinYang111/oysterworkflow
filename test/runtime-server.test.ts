import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LabSession } from "../src/lab-api/contracts.js";
import type {
  CheckRecorderPermissionsInput,
  LabService,
} from "../src/lab-api/service.js";
import {
  resolveRuntimeConfig,
  RUNTIME_API_SECRET_HEADER,
} from "../src/runtime/config.js";
import {
  closeRuntimeHttpServer,
  closeRuntimeServerResources,
  createRuntimeHttpApp,
} from "../src/runtime/server.js";
import type { ProductStore } from "../src/product/store.js";
import type { ProductClawHubService } from "../src/product/clawhub.js";

describe("runtime http server cors", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolveClose, rejectClose) => {
            server.close((error) =>
              error ? rejectClose(error) : resolveClose(),
            );
          }),
      ),
    );
  });

  it("force-closes a persistent renderer request within the shutdown grace period", async () => {
    let markRequestReceived: (() => void) | null = null;
    const requestReceived = new Promise<void>((resolveRequest) => {
      markRequestReceived = resolveRequest;
    });
    const server = createServer(() => {
      markRequestReceived?.();
    });
    await new Promise<void>((resolveListen) => {
      server.listen(0, "127.0.0.1", resolveListen);
    });
    const address = server.address() as AddressInfo;
    const pendingRequest = fetch(`http://127.0.0.1:${address.port}`).catch(
      () => undefined,
    );
    await requestReceived;

    await closeRuntimeHttpServer(server, 10);
    await pendingRequest;

    expect(server.listening).toBe(false);
  });

  it("closes ProductStore and LabService together with the HTTP listener", async () => {
    const server = await createListeningCloseTestServer();
    const productStoreShutdown = vi.fn(async () => undefined);
    const labServiceShutdown = vi.fn(async () => undefined);

    try {
      await closeRuntimeServerResources({
        server,
        productStore: { shutdown: productStoreShutdown },
        service: { shutdown: labServiceShutdown },
      });

      expect(productStoreShutdown).toHaveBeenCalledOnce();
      expect(labServiceShutdown).toHaveBeenCalledOnce();
      expect(server.listening).toBe(false);
    } finally {
      await closeTestServerIfListening(server);
    }
  });

  it.each([
    ["ProductStore", true, false],
    ["LabService", false, true],
  ])(
    "still closes HTTP and the other resource when %s shutdown fails",
    async (_failedResource, productStoreFails, labServiceFails) => {
      const server = await createListeningCloseTestServer();
      const shutdownError = new Error(`${_failedResource} shutdown failed`);
      const productStoreShutdown = vi.fn(async () => {
        if (productStoreFails) {
          throw shutdownError;
        }
      });
      const labServiceShutdown = vi.fn(async () => {
        if (labServiceFails) {
          throw shutdownError;
        }
      });

      try {
        await expect(
          closeRuntimeServerResources({
            server,
            productStore: { shutdown: productStoreShutdown },
            service: { shutdown: labServiceShutdown },
          }),
        ).rejects.toBe(shutdownError);

        expect(productStoreShutdown).toHaveBeenCalledOnce();
        expect(labServiceShutdown).toHaveBeenCalledOnce();
        expect(server.listening).toBe(false);
      } finally {
        await closeTestServerIfListening(server);
      }
    },
  );

  it("rejects opaque browser origins instead of trusting every file-like page", async () => {
    const app = createRuntimeHttpApp({
      service: {} as LabService,
      config: resolveRuntimeConfig({
        mode: "test",
        apiPort: 0,
      }),
    });
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((resolveListen) =>
      server.once("listening", resolveListen),
    );

    const address = server.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/health`,
      {
        headers: {
          Origin: "null",
        },
      },
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("does not create product SQLite for non-product health requests", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "oyster-runtime-lazy-"));
    try {
      const app = createRuntimeHttpApp({
        service: {} as LabService,
        config: resolveRuntimeConfig({
          mode: "test",
          apiPort: 0,
          runsRoot: join(tempRoot, "runs"),
          projectRootDir: tempRoot,
        }),
      });
      const server = app.listen(0, "127.0.0.1");
      servers.push(server);
      await new Promise<void>((resolveListen) =>
        server.once("listening", resolveListen),
      );

      const address = server.address() as AddressInfo;
      const response = await fetch(
        `http://127.0.0.1:${address.port}/api/health`,
        {
          headers: {
            Origin: "http://localhost:5173",
          },
        },
      );

      expect(response.status).toBe(200);
      await expect(
        stat(join(tempRoot, "product-state.sqlite")),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("delegates explicit workflow merge acceptance to ProductStore", async () => {
    const applyWorkflowMergeProposal = vi.fn(async () => ({
      state: {},
      sourceWorkflowId: "workflow.source",
      canonicalProductWorkflowId: "workflow.base",
      canonicalGraph: {
        revision: { number: 2 },
      },
      graphPath: "/runs/base/workflow.json",
      alreadyApplied: false,
    }));
    const app = createRuntimeHttpApp({
      service: {} as LabService,
      productStore: {
        applyWorkflowMergeProposal,
      } as unknown as ProductStore,
      config: resolveRuntimeConfig({
        mode: "test",
        apiPort: 0,
      }),
    });
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((resolveListen) =>
      server.once("listening", resolveListen),
    );
    const address = server.address() as AddressInfo;

    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/product/workflows/workflow.source/merge-proposal/apply`,
      { method: "POST" },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      sourceWorkflowId: "workflow.source",
      canonicalProductWorkflowId: "workflow.base",
      canonicalGraph: { revision: { number: 2 } },
      alreadyApplied: false,
    });
    expect(applyWorkflowMergeProposal).toHaveBeenCalledWith(
      "workflow.source",
      undefined,
    );
  });

  it("validates Graph edits and maps stale revisions to conflict responses", async () => {
    const editWorkflowGraph = vi
      .fn()
      .mockResolvedValueOnce({
        state: {},
        workflowId: "workflow.source",
        canonicalGraph: { revision: { number: 3 } },
        graphPath: "/runs/source/workflow.json",
      })
      .mockRejectedValueOnce(
        new Error(
          "Workflow graph edit is stale because the canonical revision changed. Refresh the graph and try again. / 工作流图版本已更新，请刷新后重新编辑。",
        ),
      );
    const app = createRuntimeHttpApp({
      service: {} as LabService,
      productStore: { editWorkflowGraph } as unknown as ProductStore,
      config: resolveRuntimeConfig({ mode: "test", apiPort: 0 }),
    });
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((resolveListen) =>
      server.once("listening", resolveListen),
    );
    const address = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${address.port}/api/product/workflows/workflow.source/graph`;
    const validBody = {
      expectedRevisionId: "workflow.source:revision:2",
      target: { kind: "node", id: "action-review", type: "action" },
      patch: { title: "Review the newest request" },
    };

    const saved = await fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(saved.status).toBe(200);
    await expect(saved.json()).resolves.toMatchObject({
      canonicalGraph: { revision: { number: 3 } },
    });
    expect(editWorkflowGraph).toHaveBeenCalledWith(
      "workflow.source",
      validBody,
    );

    const invalid = await fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...validBody,
        patch: { from: "rewritten-node" },
      }),
    });
    expect(invalid.status).toBe(400);
    expect(editWorkflowGraph).toHaveBeenCalledTimes(1);

    const stale = await fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({
      error: { message: expect.stringContaining("工作流图版本已更新") },
    });
  });

  it("allows loopback browser origins used by the local dev server", async () => {
    const app = createRuntimeHttpApp({
      service: {} as LabService,
      config: resolveRuntimeConfig({
        mode: "test",
        apiPort: 0,
      }),
    });
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((resolveListen) =>
      server.once("listening", resolveListen),
    );

    const address = server.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/health`,
      {
        headers: {
          Origin: "http://localhost:5173",
        },
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:5173",
    );
  });

  it("rejects non-loopback browser origins from talking to the desktop runtime", async () => {
    const app = createRuntimeHttpApp({
      service: {} as LabService,
      config: resolveRuntimeConfig({
        mode: "test",
        apiPort: 0,
      }),
    });
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((resolveListen) =>
      server.once("listening", resolveListen),
    );

    const address = server.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/health`,
      {
        headers: {
          Origin: "https://evil.example",
        },
      },
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    await expect(response.json()).resolves.toEqual({
      error: {
        message: "Origin not allowed: https://evil.example",
      },
    });
  });

  it("requires the per-launch capability secret for non-public desktop routes", async () => {
    const productStore = {
      getState: vi.fn(() => ({ marker: "trusted" })),
    } as unknown as ProductStore;
    const app = createRuntimeHttpApp({
      service: {} as LabService,
      productStore,
      config: resolveRuntimeConfig({
        mode: "desktop",
        apiPort: 0,
        apiSecret: "desktop-launch-secret-value",
      }),
    });
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((resolveListen) =>
      server.once("listening", resolveListen),
    );
    const address = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${address.port}/api/product/state`;

    const unauthenticated = await fetch(url);
    expect(unauthenticated.status).toBe(401);
    expect(productStore.getState).not.toHaveBeenCalled();

    const authenticated = await fetch(url, {
      headers: {
        [RUNTIME_API_SECRET_HEADER]: "desktop-launch-secret-value",
      },
    });
    expect(authenticated.status).toBe(200);
    await expect(authenticated.json()).resolves.toEqual({
      state: { marker: "trusted" },
    });
  });

  it("answers local browser development preflight requests with a fixed header allowlist", async () => {
    const app = createRuntimeHttpApp({
      service: {} as LabService,
      config: resolveRuntimeConfig({
        mode: "test",
        apiPort: 0,
      }),
    });
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((resolveListen) =>
      server.once("listening", resolveListen),
    );

    const address = server.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/llm/config`,
      {
        method: "OPTIONS",
        headers: {
          Origin: "http://localhost:5173",
          "Access-Control-Request-Method": "PATCH",
          "Access-Control-Request-Headers": "content-type",
          "Access-Control-Request-Private-Network": "true",
        },
      },
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:5173",
    );
    expect(response.headers.get("access-control-allow-methods")).toContain(
      "PATCH",
    );
    expect(
      response.headers.get("access-control-allow-headers")?.toLowerCase(),
    ).toContain("content-type");
    expect(response.headers.get("access-control-allow-private-network")).toBe(
      "true",
    );
  });

  it("rejects cloud synchronization without a Supabase bearer token", async () => {
    const app = createRuntimeHttpApp({
      service: {} as LabService,
      config: resolveRuntimeConfig({
        mode: "test",
        apiPort: 0,
      }),
    });
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((resolveListen) =>
      server.once("listening", resolveListen),
    );

    const address = server.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/product/cloud/sync`,
      {
        method: "POST",
        headers: {
          Origin: "http://localhost:5173",
          "Content-Type": "application/json",
        },
        body: "{}",
      },
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Sign in before syncing this device.",
    });
  });

  it("records workflow deletion tombstones through the product runtime api", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "oyster-runtime-product-"));
    const previousSkillsRoot = process.env.OYSTERWORKFLOW_HERMES_SKILLS_ROOT;
    process.env.OYSTERWORKFLOW_HERMES_SKILLS_ROOT = join(
      tempRoot,
      "hermes-skills",
    );

    try {
      const app = createRuntimeHttpApp({
        service: {} as LabService,
        config: resolveRuntimeConfig({
          mode: "test",
          productSeedMode: "demo",
          apiPort: 0,
          runsRoot: join(tempRoot, "runs"),
          projectRootDir: tempRoot,
        }),
      });
      const server = app.listen(0, "127.0.0.1");
      servers.push(server);
      await new Promise<void>((resolveListen) =>
        server.once("listening", resolveListen),
      );

      const address = server.address() as AddressInfo;
      const response = await fetch(
        `http://127.0.0.1:${address.port}/api/product/workflows/inbound`,
        {
          method: "DELETE",
          headers: {
            Origin: "http://localhost:5173",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            workflowTitle: "Handle inbound opportunity",
          }),
        },
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        state: {
          workflows: Array<{ id: string; title: string }>;
          workflowTombstones: Array<{
            workflowId: string;
            workflowTitle: string;
            deletedByAccountId: string;
          }>;
        };
        tombstone: {
          workflowId: string;
          workflowTitle: string;
          deletedByAccountId: string;
        };
      };
      expect(body.tombstone).toMatchObject({
        workflowId: "inbound",
        workflowTitle: "Handle inbound opportunity",
        deletedByAccountId: "acct-alex",
      });
      expect(body.state.workflows.map((workflow) => workflow.id)).toContain(
        "inbound",
      );
      expect(body.state.workflowTombstones[0]).toMatchObject(body.tombstone);

      const removeInstalledResponse = await fetch(
        `http://127.0.0.1:${address.port}/api/product/installed-workflows/installed-meeting-actions`,
        {
          method: "DELETE",
          headers: {
            Origin: "http://localhost:5173",
          },
        },
      );

      expect(removeInstalledResponse.status).toBe(200);
      const removeInstalledBody = (await removeInstalledResponse.json()) as {
        installedWorkflow: {
          id: string;
          baselineRuns: number;
          baselineSuccesses: number;
        };
        state: {
          installedWorkflows: Array<{ id: string }>;
          runs: Array<{ installedWorkflowId: string }>;
        };
      };
      expect(removeInstalledBody.installedWorkflow).toMatchObject({
        id: "installed-meeting-actions",
        baselineRuns: 34,
        baselineSuccesses: 33,
      });
      expect(
        removeInstalledBody.state.installedWorkflows.some(
          (workflow) => workflow.id === "installed-meeting-actions",
        ),
      ).toBe(false);
      expect(
        removeInstalledBody.state.runs.some(
          (run) => run.installedWorkflowId === "installed-meeting-actions",
        ),
      ).toBe(true);

      const deleteWorkerResponse = await fetch(
        `http://127.0.0.1:${address.port}/api/product/workers/sales`,
        {
          method: "DELETE",
          headers: {
            Origin: "http://localhost:5173",
          },
        },
      );

      expect(deleteWorkerResponse.status).toBe(200);
      const deleteWorkerBody = (await deleteWorkerResponse.json()) as {
        worker: { id: string; name: string };
        state: {
          workers: Array<{ id: string }>;
          installedWorkflows: Array<{ workerId: string }>;
          runs: Array<{ workerId: string }>;
          pendingCloudDeletes: Array<{
            entityType: string;
            entityId: string;
          }>;
        };
      };
      expect(deleteWorkerBody.worker).toMatchObject({
        id: "sales",
        name: "Sales AI Worker",
      });
      expect(
        deleteWorkerBody.state.workers.some((worker) => worker.id === "sales"),
      ).toBe(false);
      expect(
        deleteWorkerBody.state.installedWorkflows.some(
          (workflow) => workflow.workerId === "sales",
        ),
      ).toBe(false);
      expect(
        deleteWorkerBody.state.runs.some((run) => run.workerId === "sales"),
      ).toBe(true);
      expect(deleteWorkerBody.state.pendingCloudDeletes).toContainEqual(
        expect.objectContaining({ entityType: "worker", entityId: "sales" }),
      );
    } finally {
      if (previousSkillsRoot === undefined) {
        delete process.env.OYSTERWORKFLOW_HERMES_SKILLS_ROOT;
      } else {
        process.env.OYSTERWORKFLOW_HERMES_SKILLS_ROOT = previousSkillsRoot;
      }
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("assigns devices through the product runtime api", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "oyster-runtime-assign-"));
    const previousSkillsRoot = process.env.OYSTERWORKFLOW_HERMES_SKILLS_ROOT;
    process.env.OYSTERWORKFLOW_HERMES_SKILLS_ROOT = join(
      tempRoot,
      "hermes-skills",
    );

    try {
      const app = createRuntimeHttpApp({
        service: {} as LabService,
        config: resolveRuntimeConfig({
          mode: "test",
          productSeedMode: "demo",
          apiPort: 0,
          runsRoot: join(tempRoot, "runs"),
          projectRootDir: tempRoot,
        }),
      });
      const server = app.listen(0, "127.0.0.1");
      servers.push(server);
      await new Promise<void>((resolveListen) =>
        server.once("listening", resolveListen),
      );

      const address = server.address() as AddressInfo;
      const response = await fetch(
        `http://127.0.0.1:${address.port}/api/product/devices/assign`,
        {
          method: "POST",
          headers: {
            Origin: "http://localhost:5173",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            workerId: "finance",
            deviceId: "alex-mbp",
          }),
        },
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        worker: { id: string; deviceId: string | null; status: string };
        device: { id: string; assignedWorkerId: string | null };
        state: {
          workers: Array<{ id: string; deviceId: string | null }>;
          devices: Array<{ id: string; assignedWorkerId: string | null }>;
        };
      };
      expect(body.worker).toMatchObject({
        id: "finance",
        deviceId: "alex-mbp",
        status: "No active task",
      });
      expect(body.device).toMatchObject({
        id: "alex-mbp",
        assignedWorkerId: "finance",
      });
      expect(
        body.state.workers.find((worker) => worker.id === "sales"),
      ).toMatchObject({
        deviceId: null,
      });
    } finally {
      if (previousSkillsRoot === undefined) {
        delete process.env.OYSTERWORKFLOW_HERMES_SKILLS_ROOT;
      } else {
        process.env.OYSTERWORKFLOW_HERMES_SKILLS_ROOT = previousSkillsRoot;
      }
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("syncs lab sessions into product state before returning product state", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "oyster-runtime-sync-"));
    const previousSkillsRoot = process.env.OYSTERWORKFLOW_HERMES_SKILLS_ROOT;
    process.env.OYSTERWORKFLOW_HERMES_SKILLS_ROOT = join(
      tempRoot,
      "hermes-skills",
    );

    try {
      const sessionDir = join(tempRoot, "runs", "ui-recording-codex-sync-1001");
      const sessionPath = join(sessionDir, "session.json");
      const summaryPath = join(sessionDir, "ingest", "summary.json");
      await mkdir(join(sessionDir, "ingest"), { recursive: true });
      await writeFile(sessionPath, JSON.stringify({ session: true }), "utf8");
      await writeFile(summaryPath, JSON.stringify({ summary: true }), "utf8");
      const session = {
        schemaVersion: "recording-session-v1",
        sessionId: "ui-recording-codex-sync-1001",
        sessionName: "Runtime captured sales workflow",
        createdAt: "2026-06-24T11:00:00.000Z",
        updatedAt: "2026-06-24T11:05:00.000Z",
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
            startedAt: "2026-06-24T11:00:00.000Z",
            stoppedAt: "2026-06-24T11:05:00.000Z",
            exitCode: 0,
          },
          queryMode: {
            state: "idle",
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
          startedAt: "2026-06-24T11:00:00.000Z",
          requestedStopAt: "2026-06-24T11:05:00.000Z",
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
              startedAt: "2026-06-24T11:05:00.000Z",
              completedAt: "2026-06-24T11:05:01.000Z",
            },
            "discovering-workflow": { startedAt: null, completedAt: null },
            "building-skill": { startedAt: null, completedAt: null },
            "building-workflow-graph": { startedAt: null, completedAt: null },
          },
        },
        ingest: {
          latestRunId: "run-sync-1",
          latestRunDir: join(sessionDir, "ingest", "runs", "run-sync-1"),
          summaryPath,
          summary: {
            fetch: {
              rawUiEventsCount: 42,
              rawOcrCount: 88,
              rawAudioCount: 0,
            },
            timeWindow: {
              observed: { durationMs: 300000 },
              requested: { durationMs: 300000 },
            },
          } as unknown as LabSession["ingest"]["summary"],
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
      } as LabSession;
      const app = createRuntimeHttpApp({
        service: {
          listSessions: async () => [session],
        } as LabService,
        config: resolveRuntimeConfig({
          mode: "test",
          apiPort: 0,
          runsRoot: join(tempRoot, "runs"),
          projectRootDir: tempRoot,
        }),
      });
      const server = app.listen(0, "127.0.0.1");
      servers.push(server);
      await new Promise<void>((resolveListen) =>
        server.once("listening", resolveListen),
      );

      const address = server.address() as AddressInfo;
      const response = await fetch(
        `http://127.0.0.1:${address.port}/api/product/state`,
        {
          headers: {
            Origin: "http://localhost:5173",
          },
        },
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        state: {
          captureSessions: Array<{
            labSessionId: string;
            status: string;
            artifactMissing: boolean;
          }>;
          workflows: Array<{
            id: string;
            title: string;
            sourceType: string;
            status: string;
            stats: { uiEvents: number; duration: string };
          }>;
          artifacts: Array<{ kind: string; status: string }>;
        };
      };
      expect(body.state.captureSessions[0]).toMatchObject({
        labSessionId: session.sessionId,
        status: "captured",
        artifactMissing: false,
      });
      expect(
        body.state.workflows.find(
          (workflow) => workflow.id === `runtime-${session.sessionId}`,
        ),
      ).toMatchObject({
        title: "Runtime captured sales workflow",
        sourceType: "runtime",
        status: "Captured",
        stats: {
          uiEvents: 42,
          duration: "5:00",
        },
      });
      expect(
        body.state.artifacts.filter(
          (artifact) => artifact.status === "available",
        ).length,
      ).toBeGreaterThanOrEqual(2);
    } finally {
      if (previousSkillsRoot === undefined) {
        delete process.env.OYSTERWORKFLOW_HERMES_SKILLS_ROOT;
      } else {
        process.env.OYSTERWORKFLOW_HERMES_SKILLS_ROOT = previousSkillsRoot;
      }
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("exposes the recorder permission check endpoint", async () => {
    const app = createRuntimeHttpApp({
      service: {
        checkRecorderPermissions: async () => ({
          checkedAt: "2026-04-05T22:00:00.000Z",
          allGranted: false,
          canStartRecording: false,
          source: "screenpipe-probe",
          summary:
            "Recording stays blocked until the missing permissions are enabled.",
          items: [
            {
              kind: "screen-recording",
              label: "Screen Recording",
              description: "Required for vision capture.",
              state: "missing",
              detail: "Screen Recording is still missing.",
            },
          ],
        }),
      } as LabService,
      config: resolveRuntimeConfig({
        mode: "test",
        apiPort: 0,
      }),
    });
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((resolveListen) =>
      server.once("listening", resolveListen),
    );

    const address = server.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/recorder/permissions/check`,
      {
        headers: {
          Origin: "http://localhost:5173",
        },
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      checkedAt: "2026-04-05T22:00:00.000Z",
      allGranted: false,
      canStartRecording: false,
      source: "screenpipe-probe",
      summary:
        "Recording stays blocked until the missing permissions are enabled.",
      items: [
        {
          kind: "screen-recording",
          label: "Screen Recording",
          description: "Required for vision capture.",
          state: "missing",
          detail: "Screen Recording is still missing.",
        },
      ],
    });
  });

  it("syncs lab sessions after probing Hermes product state", async () => {
    const calls: string[] = [];
    const state = {
      schemaVersion: 1,
      account: {
        id: "acct-test",
        name: "Alex Yang",
        email: "alexyang@oysterworkflow.com",
        workspaceId: "workspace-test",
        signedInLabel: "OysterWorkflow",
        cloudProvider: null,
        cloudUserId: null,
        setupCompleted: true,
        updatedAt: "2026-06-24T11:55:00.000Z",
      },
      workspace: {
        id: "workspace-test",
        name: "OysterWorkflow",
        mode: "local",
      },
      permissionSnapshot: null,
      devices: [],
      workers: [],
      workflows: [],
      captureSessions: [],
      artifacts: [],
      installedWorkflows: [],
      runs: [],
      runEvents: [],
      commands: [],
      approvalPolicies: [],
      workflowTombstones: [],
      hermes: {
        command: "hermes",
        available: true,
        model: null,
        provider: null,
        lastCheckedAt: "2026-06-24T11:55:00.000Z",
        lastProbeSessionId: null,
        lastError: null,
      },
      updatedAt: "2026-06-24T11:55:00.000Z",
    } as const;
    const productStore = {
      refreshHermes: async () => {
        calls.push("refreshHermes");
        return state;
      },
      syncLabSessions: async (sessions: LabSession[]) => {
        calls.push(`syncLabSessions:${sessions.length}`);
        return state;
      },
      getState: async () => state,
    } as unknown as ProductStore;
    const app = createRuntimeHttpApp({
      service: {
        listSessions: async () => [
          {
            sessionId: "session-for-probe",
          } as LabSession,
        ],
      } as LabService,
      productStore,
      config: resolveRuntimeConfig({
        mode: "test",
        apiPort: 0,
      }),
    });
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((resolveListen) =>
      server.once("listening", resolveListen),
    );

    const address = server.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/product/hermes/probe`,
      {
        method: "POST",
        headers: {
          Origin: "http://localhost:5173",
        },
      },
    );

    expect(response.status).toBe(200);
    expect(calls).toEqual(["refreshHermes", "syncLabSessions:1"]);
  });

  it("exposes the hosted Composio catalog, OAuth, polling, and disconnect APIs", async () => {
    const calls: Array<{ method: string; value: unknown }> = [];
    const connection = {
      id: "conn-github",
      toolkitSlug: "github",
      status: "ACTIVE",
      alias: null,
      statusReason: null,
      isDisabled: false,
      createdAt: null,
      updatedAt: null,
    };
    const productStore = {
      getComposioOverview: async (query: unknown) => {
        calls.push({ method: "overview", value: query });
        return {
          provider: {
            id: "composio",
            configured: true,
            apiKeySource: "local_file",
            sessionReady: true,
            sessionId: "session-full",
            lastError: null,
            features: {
              unrestrictedToolkits: true,
              dynamicDiscovery: true,
              fullToolCatalog: true,
              remoteSandbox: true,
              mcp: true,
            },
          },
          items: [
            {
              slug: "github",
              name: "GitHub",
              logo: null,
              noAuth: false,
              connected: true,
              connections: [connection],
            },
          ],
          nextCursor: null,
          totalPages: 1,
        };
      },
      authorizeComposioToolkit: async (input: unknown) => {
        calls.push({ method: "authorize", value: input });
        return {
          connectionId: "conn-github",
          redirectUrl: "https://connect.composio.dev/conn-github",
          status: "INITIATED",
        };
      },
      getComposioConnection: async (connectionId: string) => {
        calls.push({ method: "connection", value: connectionId });
        return connection;
      },
      disconnectComposioConnection: async (connectionId: string) => {
        calls.push({ method: "disconnect", value: connectionId });
      },
    } as unknown as ProductStore;
    const app = createRuntimeHttpApp({
      service: {} as LabService,
      productStore,
      config: resolveRuntimeConfig({ mode: "test", apiPort: 0 }),
    });
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((resolveListen) =>
      server.once("listening", resolveListen),
    );
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const overviewResponse = await fetch(
      `${baseUrl}/api/product/integrations/composio?search=git&filter=connected&limit=24`,
    );
    expect(overviewResponse.status).toBe(200);
    await expect(overviewResponse.json()).resolves.toMatchObject({
      items: [{ slug: "github", connected: true }],
    });

    const authorizeResponse = await fetch(
      `${baseUrl}/api/product/integrations/composio/toolkits/github/authorize`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          alias: "Work",
          toolkitName: "GitHub",
          language: "zh",
        }),
      },
    );
    expect(authorizeResponse.status).toBe(200);
    await expect(authorizeResponse.json()).resolves.toMatchObject({
      connectionId: "conn-github",
      status: "INITIATED",
    });

    const callbackResponse = await fetch(
      `${baseUrl}/api/product/integrations/composio/callback?status=success&toolkitName=YouTube&language=en`,
    );
    expect(callbackResponse.status).toBe(200);
    expect(callbackResponse.headers.get("cache-control")).toBe("no-store");
    const callbackHtml = await callbackResponse.text();
    expect(callbackHtml).toContain("Successfully connected");
    expect(callbackHtml).toContain("OysterWorkflow to YouTube");
    expect(callbackHtml).not.toContain("Composio");

    const connectionResponse = await fetch(
      `${baseUrl}/api/product/integrations/composio/connections/conn-github`,
    );
    expect(connectionResponse.status).toBe(200);
    await expect(connectionResponse.json()).resolves.toEqual({ connection });

    const disconnectResponse = await fetch(
      `${baseUrl}/api/product/integrations/composio/connections/conn-github`,
      { method: "DELETE" },
    );
    expect(disconnectResponse.status).toBe(200);
    await expect(disconnectResponse.json()).resolves.toEqual({
      disconnected: true,
      connectionId: "conn-github",
    });
    expect(calls).toEqual([
      {
        method: "overview",
        value: { search: "git", filter: "connected", limit: 24 },
      },
      {
        method: "authorize",
        value: {
          toolkitSlug: "github",
          alias: "Work",
          callbackUrl:
            "http://127.0.0.1:0/api/product/integrations/composio/callback?toolkitName=GitHub&language=zh",
        },
      },
      { method: "connection", value: "conn-github" },
      { method: "disconnect", value: "conn-github" },
    ]);
  });

  it("records recorder permission checks into product state without using devices", async () => {
    const tempRoot = await mkdtemp(
      join(tmpdir(), "oyster-runtime-permission-"),
    );
    const previousSkillsRoot = process.env.OYSTERWORKFLOW_HERMES_SKILLS_ROOT;
    process.env.OYSTERWORKFLOW_HERMES_SKILLS_ROOT = join(
      tempRoot,
      "hermes-skills",
    );

    try {
      const app = createRuntimeHttpApp({
        service: {
          checkRecorderPermissions: async () => ({
            checkedAt: "2026-06-24T11:40:00.000Z",
            allGranted: false,
            canStartRecording: false,
            source: "screenpipe-probe",
            summary: "Input Monitoring is missing.",
            items: [
              {
                kind: "input-monitoring",
                label: "Input Monitoring",
                description: "Required for keyboard capture.",
                state: "missing",
                detail: "Enable Input Monitoring.",
              },
            ],
          }),
        } as LabService,
        config: resolveRuntimeConfig({
          mode: "test",
          productSeedMode: "demo",
          apiPort: 0,
          runsRoot: join(tempRoot, "runs"),
          projectRootDir: tempRoot,
        }),
      });
      const server = app.listen(0, "127.0.0.1");
      servers.push(server);
      await new Promise<void>((resolveListen) =>
        server.once("listening", resolveListen),
      );

      const address = server.address() as AddressInfo;
      const permissionResponse = await fetch(
        `http://127.0.0.1:${address.port}/api/recorder/permissions/check`,
        {
          headers: {
            Origin: "http://localhost:5173",
          },
        },
      );
      expect(permissionResponse.status).toBe(200);

      const productResponse = await fetch(
        `http://127.0.0.1:${address.port}/api/product/state`,
        {
          headers: {
            Origin: "http://localhost:5173",
          },
        },
      );
      const body = (await productResponse.json()) as {
        state: {
          permissionSnapshot: {
            checkedAt: string;
            source: string;
            items: Array<{ kind: string; state: string }>;
          } | null;
          devices: Array<{ id: string; status: string }>;
        };
      };
      expect(body.state.permissionSnapshot).toMatchObject({
        checkedAt: "2026-06-24T11:40:00.000Z",
        source: "screenpipe-probe",
        items: [{ kind: "input-monitoring", state: "missing" }],
      });
      expect(body.state.devices).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "alex-mbp",
            status: "Available now",
          }),
        ]),
      );
    } finally {
      if (previousSkillsRoot === undefined) {
        delete process.env.OYSTERWORKFLOW_HERMES_SKILLS_ROOT;
      } else {
        process.env.OYSTERWORKFLOW_HERMES_SKILLS_ROOT = previousSkillsRoot;
      }
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("exposes the recorder bootstrap endpoint", async () => {
    const seenRequests: Array<{
      enableAudio?: boolean;
      ocrLanguagePriority?: string[];
    }> = [];
    const app = createRuntimeHttpApp({
      service: {
        bootstrapRecorder: async (input) => {
          seenRequests.push(input ?? {});
          return {
            startedAt: "2026-04-14T20:00:00.000Z",
            completedAt: "2026-04-14T20:01:00.000Z",
            stage: "ready",
            ready: true,
            summary: "Recorder dependencies are ready.",
            logPath: "/tmp/bootstrap/recording-bootstrap.log",
          };
        },
      } as LabService,
      config: resolveRuntimeConfig({
        mode: "test",
        apiPort: 0,
      }),
    });
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((resolveListen) =>
      server.once("listening", resolveListen),
    );

    const address = server.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/recorder/bootstrap`,
      {
        method: "POST",
        headers: {
          Origin: "http://localhost:5173",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          enableAudio: false,
          ocrLanguagePriority: ["chinese", "english"],
        }),
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      startedAt: "2026-04-14T20:00:00.000Z",
      completedAt: "2026-04-14T20:01:00.000Z",
      stage: "ready",
      ready: true,
      summary: "Recorder dependencies are ready.",
      logPath: "/tmp/bootstrap/recording-bootstrap.log",
    });
    expect(seenRequests).toEqual([
      {
        enableAudio: false,
        ocrLanguagePriority: ["chinese", "english"],
      },
    ]);
  });

  it("exposes the workflow artifact save endpoint", async () => {
    const seenRequests: Array<Record<string, unknown>> = [];
    const app = createRuntimeHttpApp({
      service: {
        saveWorkflowArtifact: async (sessionId, input) => {
          seenRequests.push({
            sessionId,
            input,
          });
          return {
            sessionId,
            status: "ready",
          } as Awaited<ReturnType<LabService["saveWorkflowArtifact"]>>;
        },
      } as LabService,
      config: resolveRuntimeConfig({
        mode: "test",
        apiPort: 0,
      }),
    });
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((resolveListen) =>
      server.once("listening", resolveListen),
    );

    const address = server.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/sessions/session-123/workflow-artifact`,
      {
        method: "POST",
        headers: {
          Origin: "http://localhost:5173",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          selectedWorkflowId: "manual-workflow-1",
          workflowCandidates: [
            {
              workflowId: "manual-workflow-1",
              name: "Manual workflow",
              description: "Describe the path.",
              goal: "Explain the goal.",
              priority: 1,
              startEventId: "manual-workflow-1-start",
              endEventId: "manual-workflow-1-end",
              startTs: "2026-04-01T10:00:00.000Z",
              endTs: "2026-04-01T10:05:00.000Z",
              eventCount: 12,
            },
          ],
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(seenRequests).toEqual([
      {
        sessionId: "session-123",
        input: {
          selectedWorkflowId: "manual-workflow-1",
          workflowCandidates: [
            {
              workflowId: "manual-workflow-1",
              name: "Manual workflow",
              description: "Describe the path.",
              goal: "Explain the goal.",
              priority: 1,
              startEventId: "manual-workflow-1-start",
              endEventId: "manual-workflow-1-end",
              startTs: "2026-04-01T10:00:00.000Z",
              endTs: "2026-04-01T10:05:00.000Z",
              eventCount: 12,
            },
          ],
        },
      },
    ]);
    await expect(response.json()).resolves.toEqual({
      session: {
        sessionId: "session-123",
        status: "ready",
      },
    });
  });

  it("forwards a force refresh flag to the recorder permission check endpoint", async () => {
    const seenInputs: Array<Record<string, unknown>> = [];
    const app = createRuntimeHttpApp({
      service: {
        checkRecorderPermissions: async (
          input?: CheckRecorderPermissionsInput,
        ) => {
          seenInputs.push((input ?? {}) as Record<string, unknown>);
          return {
            checkedAt: "2026-04-05T22:00:00.000Z",
            allGranted: false,
            canStartRecording: false,
            source: "screenpipe-probe",
            summary:
              "Recording stays blocked until the missing permissions are enabled.",
            items: [],
          };
        },
      } as unknown as LabService,
      config: resolveRuntimeConfig({
        mode: "test",
        apiPort: 0,
      }),
    });
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((resolveListen) =>
      server.once("listening", resolveListen),
    );

    const address = server.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/recorder/permissions/check?force=1`,
      {
        headers: {
          Origin: "http://localhost:5173",
        },
      },
    );

    expect(response.status).toBe(200);
    expect(seenInputs).toEqual([{ forceRefresh: true }]);
  });

  it("accepts recorder audio and OCR settings in the start payload", async () => {
    const seenBodies: Array<Record<string, unknown>> = [];
    const app = createRuntimeHttpApp({
      service: {
        startRecording: async (body) => {
          seenBodies.push(body as Record<string, unknown>);
          return {
            sessionId: "session-ocr-priority",
          };
        },
      } as LabService,
      config: resolveRuntimeConfig({
        mode: "test",
        apiPort: 0,
      }),
    });
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((resolveListen) =>
      server.once("listening", resolveListen),
    );

    const address = server.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/recorder/start`,
      {
        method: "POST",
        headers: {
          Origin: "http://localhost:5173",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          autoStopMinutes: 5,
          ocrLanguagePriority: ["japanese", "english", "chinese"],
          enableAudio: true,
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(seenBodies).toEqual([
      {
        autoStopMinutes: 5,
        ocrLanguagePriority: ["japanese", "english", "chinese"],
        enableAudio: true,
      },
    ]);
  });

  it("returns zod validation errors with the offending field path", async () => {
    const app = createRuntimeHttpApp({
      service: {} as LabService,
      config: resolveRuntimeConfig({
        mode: "test",
        apiPort: 0,
      }),
    });
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((resolveListen) =>
      server.once("listening", resolveListen),
    );

    const address = server.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/sessions/session-1/skill-artifact`,
      {
        method: "POST",
        headers: {
          Origin: "http://localhost:5173",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sourceType: "base",
          skillPath: "/tmp/skill.json",
          skill: {
            schemaVersion: "openclaw-skill-v1",
            promptSet: null,
            skillId: "skill-001",
            skillName: "Claim status check",
            generatedAt: "2026-04-17T12:00:00.000Z",
            source: {
              runId: "run-001",
              runDir: "/tmp/run-001",
              episodeId: "episode-001",
              startTs: "2026-04-17T12:00:00.000Z",
              endTs: "2026-04-17T12:05:00.000Z",
            },
            description: "Check the latest claim detail page.",
            goal: "Confirm the latest claim status.",
            whenToUse: ["Need to confirm the claim status."],
            whenNotToUse: [],
            inputs: [{ name: "Tracking Number", description: "" }],
            outputs: [],
            prerequisites: ["Open the claim system."],
            steps: [
              {
                step: 1,
                instruction: "",
                intent: "Inspect the latest claim status.",
                operationApp: "Google Chrome",
                hints: [],
              },
            ],
            successCriteria: ["The claim status is confirmed."],
            failureModes: [],
            fallback: [],
            examples: [],
            tags: [],
            assets: [],
            evidence: {
              totalEvents: 1,
              anchorEvents: 1,
              ocrEvents: 0,
              appsSeen: [],
              windowsSeen: [],
            },
          },
        }),
      },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        message:
          "skill.steps.0.instruction: Too small: expected string to have >=1 characters",
      },
    });
  });

  it("returns product operation conflicts as 409 client errors", async () => {
    const app = createRuntimeHttpApp({
      service: {} as LabService,
      productStore: {
        startWorker: async () => {
          throw new Error("This worker is already running a workflow.");
        },
      } as unknown as ProductStore,
      config: resolveRuntimeConfig({
        mode: "test",
        apiPort: 0,
      }),
    });
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((resolveListen) =>
      server.once("listening", resolveListen),
    );

    const address = server.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/product/workers/sales/start`,
      {
        method: "POST",
        headers: {
          Origin: "http://localhost:5173",
          "Content-Type": "application/json",
        },
      },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        message: "This worker is already running a workflow.",
      },
    });
  });

  it("reports unexpected runtime failures without returning a stack", async () => {
    const errorReporter = vi.fn(() => "event-runtime-123");
    const app = createRuntimeHttpApp({
      service: {
        getRecorderState: async () => {
          throw new Error("Unexpected recorder failure");
        },
      } as unknown as LabService,
      errorReporter,
      config: resolveRuntimeConfig({
        mode: "test",
        apiPort: 0,
      }),
    });
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((resolveListen) =>
      server.once("listening", resolveListen),
    );

    const address = server.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/recorder/state`,
      { headers: { Origin: "http://localhost:5173" } },
    );

    expect(response.status).toBe(500);
    expect(response.headers.get("x-oysterworkflow-event-id")).toBe(
      "event-runtime-123",
    );
    await expect(response.json()).resolves.toEqual({
      error: {
        message:
          "An internal Runtime error occurred. Try again or share the event ID with support. / Runtime 内部发生错误，请重试或向支持人员提供事件 ID。",
        eventId: "event-runtime-123",
      },
    });
    expect(errorReporter).toHaveBeenCalledWith(expect.any(Error), {
      method: "GET",
      route: "/api/recorder/state",
      status: 500,
    });
  });

  it("exposes ClawHub auth and workflow publishing APIs", async () => {
    const publishWorkflow = vi.fn(async () => ({
      status: "published" as const,
      ownerHandle: "alex",
      slug: "review-lead-1234abcd",
      version: "1.0.0",
      listingUrl: "https://clawhub.ai/alex/skills/review-lead-1234abcd",
      installCommand: "openclaw skills install @alex/review-lead-1234abcd",
    }));
    const clawHubService = {
      getAuthState: async () => ({
        status: "signed_in" as const,
        handle: "alex",
        siteUrl: "https://clawhub.ai",
      }),
      publishWorkflow,
    } as unknown as ProductClawHubService;
    const productStore = {
      getState: async () => ({
        workflows: [
          {
            id: "workflow-1",
            title: "Review inbound lead",
            status: "Generated",
            artifactPath: "/private/run/skill.json",
          },
        ],
      }),
    } as unknown as ProductStore;
    const app = createRuntimeHttpApp({
      service: {} as LabService,
      productStore,
      clawHubService,
      config: resolveRuntimeConfig({
        mode: "test",
        apiPort: 0,
      }),
    });
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((resolveListen) =>
      server.once("listening", resolveListen),
    );

    const address = server.address() as AddressInfo;
    const apiBaseUrl = `http://127.0.0.1:${address.port}`;
    const authResponse = await fetch(`${apiBaseUrl}/api/product/clawhub/auth`, {
      headers: { Origin: "http://localhost:5173" },
    });
    expect(authResponse.status).toBe(200);
    await expect(authResponse.json()).resolves.toEqual({
      status: "signed_in",
      handle: "alex",
      siteUrl: "https://clawhub.ai",
    });

    const publishResponse = await fetch(
      `${apiBaseUrl}/api/product/workflows/workflow-1/clawhub-publish`,
      {
        method: "POST",
        headers: {
          Origin: "http://localhost:5173",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ acceptMit0: true }),
      },
    );
    expect(publishResponse.status).toBe(200);
    await expect(publishResponse.json()).resolves.toMatchObject({
      ownerHandle: "alex",
      slug: "review-lead-1234abcd",
      version: "1.0.0",
    });
    expect(publishWorkflow).toHaveBeenCalledWith({
      workflowId: "workflow-1",
      title: "Review inbound lead",
      skillPath: "/private/run/skill.json",
    });
  });

  it("runs and stops a real ProductStore worker through HTTP", async () => {
    const tempRoot = await mkdtemp(
      join(tmpdir(), "oyster-runtime-hermes-http-"),
    );
    const hermesPath = join(tempRoot, "bin", "hermes");
    const startedMarker = join(tempRoot, "hermes-started");
    const stoppedMarker = join(tempRoot, "hermes-stopped");
    const hermesRoot = join(tempRoot, "managed-hermes");
    await mkdir(join(tempRoot, "bin"), { recursive: true });
    await writeFile(
      hermesPath,
      `#!/bin/sh
if [ "$1" = "-p" ] && [ "$3" = "profile" ] && [ "$4" = "show" ]; then
  if [ -d "$HERMES_HOME/profiles/$2" ]; then
    echo "Profile: $2"
    echo "Path: $HERMES_HOME/profiles/$2"
    exit 0
  fi
  echo "Profile not found" >&2
  exit 1
fi
if [ "$1" = "profile" ] && [ "$2" = "create" ]; then
  mkdir -p "$HERMES_HOME/profiles/$3/skills"
  echo "Created profile $3"
  exit 0
fi
if [ "$1" = "chat" ] || { [ "$1" = "-p" ] && [ "$3" = "chat" ]; }; then
  echo "Session: 20260626203000aa"
  echo "OYSTERWORKFLOW_WORKER_READY"
  touch "${startedMarker}"
  trap 'touch "${stoppedMarker}"; exit 143' TERM INT
  sleep 30 &
  wait $!
  exit 0
fi
echo "unknown fake-hermes command: $*" >&2
exit 1
`,
      "utf8",
    );
    await chmod(hermesPath, 0o755);

    try {
      const config = resolveRuntimeConfig({
        mode: "test",
        productSeedMode: "demo",
        apiPort: 0,
        runsRoot: join(tempRoot, "runs"),
        projectRootDir: tempRoot,
        hermesCommandPath: hermesPath,
        hermesRuntimeRoot: hermesRoot,
        hermesProfilesRoot: join(hermesRoot, "profiles"),
        hermesSkillsRoot: join(hermesRoot, "skills"),
      });
      const app = createRuntimeHttpApp({
        service: {} as LabService,
        config,
      });
      const server = app.listen(0, "127.0.0.1");
      servers.push(server);
      await new Promise<void>((resolveListen) =>
        server.once("listening", resolveListen),
      );
      const address = server.address() as AddressInfo;
      const apiBaseUrl = `http://127.0.0.1:${address.port}`;

      const runAt = Date.now();
      const runResponse = await fetch(
        `${apiBaseUrl}/api/product/installed-workflows/installed-meeting-actions/run`,
        {
          method: "POST",
          headers: {
            Origin: "http://localhost:5173",
            "Content-Type": "application/json",
          },
        },
      );
      const elapsedMs = Date.now() - runAt;
      const runBody = (await runResponse.json()) as {
        run: { id: string; status: string; hermesSessionId: string | null };
      };

      expect(runResponse.status).toBe(200);
      expect(elapsedMs).toBeLessThan(1_500);
      expect(runBody.run).toMatchObject({
        status: "running",
        hermesSessionId: "20260626203000aa",
      });
      await expect(waitForPath(startedMarker)).resolves.toBeUndefined();

      const stopResponse = await fetch(
        `${apiBaseUrl}/api/product/workers/sales/stop`,
        {
          method: "POST",
          headers: {
            Origin: "http://localhost:5173",
            "Content-Type": "application/json",
          },
        },
      );
      const stopBody = (await stopResponse.json()) as {
        state: {
          runs: Array<{ id: string; status: string; endedAt: string | null }>;
          runEvents: Array<{ runId: string; status: string; body: string }>;
        };
      };

      expect(stopResponse.status).toBe(200);
      await expect(waitForPath(stoppedMarker)).resolves.toBeUndefined();
      expect(
        stopBody.state.runs.find((run) => run.id === runBody.run.id),
      ).toMatchObject({
        status: "paused",
        endedAt: expect.any(String),
      });
      expect(
        stopBody.state.runEvents.find(
          (event) =>
            event.runId === runBody.run.id && event.status === "Paused",
        )?.body,
      ).toContain("AI worker process terminated");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }, 10_000);

  it("returns missing product entities as 404 client errors", async () => {
    const app = createRuntimeHttpApp({
      service: {} as LabService,
      productStore: {
        toggleInstalledWorkflow: async () => {
          throw new Error("Unknown installed workflow: installed-missing");
        },
      } as unknown as ProductStore,
      config: resolveRuntimeConfig({
        mode: "test",
        apiPort: 0,
      }),
    });
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((resolveListen) =>
      server.once("listening", resolveListen),
    );

    const address = server.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/product/installed-workflows/installed-missing/status`,
      {
        method: "POST",
        headers: {
          Origin: "http://localhost:5173",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          status: "Paused",
        }),
      },
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: {
        message: "Unknown installed workflow: installed-missing",
      },
    });
  });
});

async function waitForPath(path: string): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 2_000) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

/**
 * EN: Creates an ephemeral HTTP listener for Runtime close orchestration tests.
 * 中文: 为 Runtime 关闭编排测试创建临时 HTTP 监听器。
 * @returns listening HTTP server bound to an ephemeral local port.
 */
async function createListeningCloseTestServer(): Promise<Server> {
  const server = createServer((_request, response) => response.end("ok"));
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  return server;
}

/**
 * EN: Prevents a failed assertion from leaking a close-test listener.
 * 中文: 防止断言失败时泄漏关闭测试使用的监听器。
 * @param server close-test HTTP server.
 * @returns when the server is no longer listening.
 */
async function closeTestServerIfListening(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  await closeRuntimeHttpServer(server, 10);
}
