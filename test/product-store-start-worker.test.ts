import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "../src/runtime/config.js";
import type {
  WorkerExecutor,
  WorkerExecutorTurnHandle,
} from "../src/product/worker-executor.js";
import { defaultHermesProviderHealth } from "../src/product/hermes-provider-status.js";

let tempRoot = "";
let previousHermesCommand: string | undefined;
let previousSkillsRoot: string | undefined;
let previousProfilesRoot: string | undefined;
let previousHermesTestKey: string | undefined;
let previousHome: string | undefined;
let previousPath: string | undefined;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "oyster-product-start-"));
  previousHermesCommand = process.env.OYSTERWORKFLOW_HERMES_COMMAND;
  previousSkillsRoot = process.env.OYSTERWORKFLOW_HERMES_SKILLS_ROOT;
  previousProfilesRoot = process.env.OYSTERWORKFLOW_HERMES_PROFILES_ROOT;
  previousHermesTestKey = process.env.OYSTERWORKFLOW_TEST_HERMES_KEY;
  previousHome = process.env.HOME;
  previousPath = process.env.PATH;
  delete process.env.OYSTERWORKFLOW_TEST_HERMES_KEY;
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
  if (previousHermesTestKey === undefined) {
    delete process.env.OYSTERWORKFLOW_TEST_HERMES_KEY;
  } else {
    process.env.OYSTERWORKFLOW_TEST_HERMES_KEY = previousHermesTestKey;
  }
  if (previousHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = previousHome;
  }
  if (previousPath === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = previousPath;
  }
  vi.resetModules();
  await rm(tempRoot, { recursive: true, force: true });
});

describe("product store worker run lifecycle", () => {
  it("installs workflows using Hermes from the user local bin when packaged PATH is minimal", async () => {
    const fakeHome = join(tempRoot, "home");
    const localBin = join(fakeHome, ".local", "bin");
    const hermesPath = join(localBin, "hermes");
    const profileRoot = join(tempRoot, "profiles");
    const markerPath = join(tempRoot, "used-user-local-hermes");
    await mkdir(localBin, { recursive: true });
    await mkdir(join(tempRoot, "empty-bin"), { recursive: true });
    await writeFile(
      hermesPath,
      `#!/bin/sh
/usr/bin/touch "${markerPath}"
if [ "$1" = "-p" ] && [ "$3" = "profile" ] && [ "$4" = "show" ]; then
  if [ -d "${profileRoot}/$2" ]; then
    echo "Profile: $2"
    echo "Path: ${profileRoot}/$2"
    exit 0
  fi
  echo "Profile not found" >&2
  exit 1
fi
if [ "$1" = "profile" ] && [ "$2" = "create" ]; then
  /bin/mkdir -p "${profileRoot}/$3/skills"
  echo "Created profile $3"
  exit 0
fi
echo "unknown fake-hermes command: $*" >&2
exit 1
`,
      "utf8",
    );
    await chmod(hermesPath, 0o755);
    delete process.env.OYSTERWORKFLOW_HERMES_COMMAND;
    process.env.HOME = fakeHome;
    process.env.PATH = join(tempRoot, "empty-bin");
    process.env.OYSTERWORKFLOW_HERMES_PROFILES_ROOT = profileRoot;
    vi.resetModules();

    const { createProductStore } = await import("../src/product/store.js");
    const runtimeConfig = createRuntimeConfig(tempRoot);
    const store = createProductStore({
      runtimeConfig,
    });
    const workflow = await store.createWorkflow({
      mode: "new",
      title: "Packaged app Hermes lookup",
      description: "Install a workflow from the packaged app environment.",
      apps: ["Microsoft Outlook"],
    });

    const installed = await store.installWorkflow({
      workerId: "sales",
      workflowId: workflow.workflow.id,
      workflowTitle: "Packaged app Hermes lookup",
      description: "Install a workflow from the packaged app environment.",
      apps: ["Microsoft Outlook"],
    });

    expect(installed.installedWorkflow.hermesSkillPath).toContain(profileRoot);
    await expect(readFile(markerPath, "utf8")).resolves.toEqual(
      expect.any(String),
    );
  });

  it("can initialize and run a workflow through an injected worker executor", async () => {
    const hermesPath = join(tempRoot, "hermes-should-not-be-used");
    const hermesMarkerPath = join(tempRoot, "unexpected-hermes-call");
    await writeFile(
      hermesPath,
      `#!/bin/sh
/usr/bin/touch "${hermesMarkerPath}"
echo "Hermes should not be called when a worker executor is injected" >&2
exit 1
`,
      "utf8",
    );
    await chmod(hermesPath, 0o755);
    process.env.OYSTERWORKFLOW_HERMES_COMMAND = hermesPath;
    vi.resetModules();

    const executorCalls: string[] = [];
    const workerExecutor = {
      kind: "test-executor",
      skillScope: {
        profilesRoot: join(tempRoot, "test-executor-profiles"),
        skillsRoot: join(tempRoot, "test-executor-skills"),
        runtimeHome: join(tempRoot, "test-executor-runtime"),
      },
      probeStatus: async () => ({
        command: "test-executor",
        available: true,
        model: "test-model",
        provider: "test-provider",
        providerHealth: defaultHermesProviderHealth(),
        enabledToolsets: ["computer-use"],
        missingComputerUseToolsets: [],
        computerUseReady: true,
        computerUseSummary: "Test executor ready",
        configSource: "Injected test executor",
        configPath: null,
        runtimeHome: join(tempRoot, "test-executor-runtime"),
        lastCheckedAt: new Date().toISOString(),
        lastProbeSessionId: "test-probe-session",
        lastError: null,
      }),
      provisionAgent: async (input: { workerId: string }) => {
        executorCalls.push(`provision:${input.workerId}`);
        return {
          agentReference: `test-agent:${input.workerId}`,
          agentLabel: `test-agent-${input.workerId}`,
          agentPath: null,
          output: "Test agent provisioned",
        };
      },
      installSkill: async (input: { workflowId: string }) => {
        executorCalls.push(`install:${input.workflowId}`);
        return {
          skillReference: `test-skill:${input.workflowId}`,
          installReference: `test-install:${input.workflowId}`,
          skillName: `test-${input.workflowId}`,
          skillPath: join(
            tempRoot,
            "test-executor-skills",
            input.workflowId,
            "SKILL.md",
          ),
        };
      },
      startTurn: async (input: {
        onOutput?: (chunk: {
          stream: "stdout" | "stderr";
          text: string;
        }) => void;
        onProgress?: (event: { status: string; body: string }) => void;
        workerAgentReference?: string | null;
        skills?: string[];
      }) => {
        executorCalls.push(
          `start:${input.workerAgentReference}:${input.skills?.join(",")}`,
        );
        input.onOutput?.({
          stream: "stdout",
          text: "Injected executor streamed output\n",
        });
        input.onProgress?.({
          status: "Desktop action completed",
          body: "Injected executor clicked the assigned desktop.",
        });
        return {
          ready: Promise.resolve({
            ok: true,
            sessionId: "test-executor-session",
            output: "Injected executor ready",
            errorMessage: null,
          }),
          completion: Promise.resolve({
            ok: true,
            sessionId: "test-executor-session",
            output: "Injected executor completed",
            errorMessage: null,
          }),
          stop: () => false,
        };
      },
    };

    const { createProductStore } = await import("../src/product/store.js");
    const store = createProductStore({
      runtimeConfig: createRuntimeConfig(tempRoot),
      workerExecutor,
    } as never);
    const workflow = await store.createWorkflow({
      mode: "new",
      title: "Run through custom executor",
      description: "Exercise the executor abstraction.",
      apps: ["Microsoft Outlook"],
    });

    const deployed = await store.installWorkflow({
      workerId: "sales",
      workflowId: workflow.workflow.id,
      workflowTitle: "Run through custom executor",
      description: "Exercise the executor abstraction.",
      apps: ["Microsoft Outlook"],
    });
    const initialized = await store.startWorker("sales");
    const initializedRun = initialized.state.runs[0]!;
    await expect(store.deleteWorker("sales")).rejects.toThrow(
      "Stop the active AI worker session before deleting it.",
    );
    const stoppedInitialized = await store.stopWorker("sales");
    const started = await store.runInstalledWorkflow(
      deployed.installedWorkflow.id,
    );

    expect(deployed.installedWorkflow).toMatchObject({
      hermesSkillReference: `test-skill:${workflow.workflow.id}`,
      hermesSkillName: `test-${workflow.workflow.id}`,
    });
    expect(initialized.worker).toMatchObject({
      id: "sales",
      status: "Available",
      heartbeat: "AI worker ready",
    });
    expect(initializedRun).toMatchObject({
      workerId: "sales",
      installedWorkflowId: deployed.installedWorkflow.id,
      status: "running",
      hermesSessionId: "test-executor-session",
    });
    expect(
      initialized.state.runEvents.some(
        (event) =>
          event.runId === initializedRun.id &&
          event.status === "AI worker ready",
      ),
    ).toBe(true);
    expect(
      stoppedInitialized.runs.find((run) => run.id === initializedRun.id),
    ).toMatchObject({
      status: "paused",
      endedAt: expect.any(String),
    });
    expect(started.run).toMatchObject({
      workerId: "sales",
      installedWorkflowId: deployed.installedWorkflow.id,
      hermesSessionId: "test-executor-session",
    });
    expect(executorCalls).toContain("provision:sales");
    expect(executorCalls).toContain(`install:${workflow.workflow.id}`);
    expect(executorCalls).toContain(
      `start:test-agent:sales:test-${workflow.workflow.id}`,
    );
    await waitForState(async () => {
      const state = await store.getState();
      return state.runEvents.some(
        (event) =>
          event.runId === started.run.id &&
          event.status === "AI worker response" &&
          event.body === "Injected executor completed",
      );
    });
    const executorState = await store.getState();
    const workingEvents = executorState.runEvents.filter(
      (event) =>
        event.runId === started.run.id &&
        event.source === "executor" &&
        event.status === "AI worker working",
    );
    expect(workingEvents).toHaveLength(1);
    expect(workingEvents[0]?.body).toBe(
      "AI worker started executing Run through custom executor.",
    );
    expect(
      executorState.runEvents.some(
        (event) =>
          event.runId === started.run.id && event.status === "AI worker output",
      ),
    ).toBe(false);
    expect(
      executorState.runEvents.some(
        (event) =>
          event.runId === started.run.id &&
          event.body === "Injected executor streamed output",
      ),
    ).toBe(false);
    expect(
      executorState.runEvents.some(
        (event) =>
          event.runId === started.run.id &&
          event.status === "Desktop action completed",
      ),
    ).toBe(false);
    await expect(access(hermesMarkerPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps a started worker session available after a command succeeds", async () => {
    const turnInputs: Array<{
      resumeSessionId?: string | null;
    }> = [];
    let turnCount = 0;
    const workerExecutor = {
      kind: "test-executor",
      skillScope: {},
      probeStatus: async () => ({
        command: "test-executor",
        available: true,
        model: "test-model",
        provider: "test-provider",
        providerHealth: defaultHermesProviderHealth(),
        enabledToolsets: [],
        missingComputerUseToolsets: [],
        computerUseReady: true,
        computerUseSummary: "Test executor ready",
        configSource: "Injected test executor",
        configPath: null,
        runtimeHome: null,
        lastCheckedAt: new Date().toISOString(),
        lastProbeSessionId: null,
        lastError: null,
      }),
      provisionAgent: async () => ({
        agentReference: "test-agent:sales",
        agentLabel: "test-agent-sales",
        agentPath: null,
        output: "Test agent provisioned",
      }),
      installSkill: async (input: { workflowId: string }) => ({
        skillReference: `test-skill:${input.workflowId}`,
        installReference: `test-install:${input.workflowId}`,
        skillName: `test-${input.workflowId}`,
        skillPath: join(tempRoot, "skills", input.workflowId, "SKILL.md"),
      }),
      startTurn: async (input: { resumeSessionId?: string | null }) => {
        turnInputs.push(input);
        turnCount += 1;
        const initializing = turnCount === 1;
        const result = {
          ok: true,
          sessionId: "persistent-worker-session",
          output: initializing
            ? "Worker ready for the next command."
            : "The requested task is complete.",
          errorMessage: null,
          sessionStatus: initializing ? "running" : "succeeded",
          sessionStatusMessage: initializing
            ? "Worker ready for the next command."
            : "The requested task is complete.",
          userAction: null,
        };
        return {
          ready: Promise.resolve(result),
          completion: Promise.resolve(result),
          stop: () => false,
        };
      },
    };

    const { createProductStore } = await import("../src/product/store.js");
    const store = createProductStore({
      runtimeConfig: createRuntimeConfig(tempRoot),
      workerExecutor,
    } as never);
    const workflow = await store.createWorkflow({
      mode: "new",
      title: "Persistent worker workflow",
      description: "Keep the worker available between commands.",
      apps: ["Google Chrome"],
    });

    await store.installWorkflow({
      workerId: "sales",
      workflowId: workflow.workflow.id,
      workflowTitle: "Persistent worker workflow",
      description: "Keep the worker available between commands.",
      apps: ["Google Chrome"],
    });
    const initialized = await store.startWorker("sales");
    const runId = initialized.state.runs[0]!.id;

    await store.sendCommand("sales", "Complete the current task");
    await waitForState(async () => {
      const state = await store.getState();
      return state.runEvents.some(
        (event) =>
          event.runId === runId && event.status === "AI worker completed",
      );
    });

    const completed = await store.getState();
    expect(completed.runs.find((run) => run.id === runId)).toMatchObject({
      status: "running",
      endedAt: null,
      hermesSessionId: "persistent-worker-session",
    });
    expect(
      completed.workers.find((worker) => worker.id === "sales"),
    ).toMatchObject({
      status: "Available",
      tone: "ready",
      heartbeat: "AI worker ready",
    });
    expect(turnInputs[1]).toMatchObject({
      resumeSessionId: "persistent-worker-session",
    });

    await expect(
      store.sendCommand("sales", "Accept another command"),
    ).resolves.toMatchObject({
      commandRecord: { status: "accepted" },
    });
    expect(turnInputs[2]).toMatchObject({
      resumeSessionId: "persistent-worker-session",
    });

    await store.stopWorker("sales");
  });

  it("asks the worker executor to stop lingering profile processes", async () => {
    const stopWorkerProcesses = vi.fn(async () => true);
    const workerExecutor = {
      kind: "test-executor",
      skillScope: {},
      probeStatus: async () => ({
        command: "test-executor",
        available: true,
        model: "test-model",
        provider: "test-provider",
        providerHealth: defaultHermesProviderHealth(),
        enabledToolsets: [],
        missingComputerUseToolsets: [],
        computerUseReady: true,
        computerUseSummary: "Test executor ready",
        configSource: "Injected test executor",
        configPath: null,
        runtimeHome: null,
        lastCheckedAt: new Date().toISOString(),
        lastProbeSessionId: null,
        lastError: null,
      }),
      provisionAgent: async (input: { workerId: string }) => ({
        agentReference: `hermes-profile:ow-${input.workerId}`,
        agentLabel: `ow-${input.workerId}`,
        agentPath: null,
        output: "agent ready",
      }),
      installSkill: async (input: { workflowId: string }) => ({
        skillReference: `test-skill:${input.workflowId}`,
        installReference: `test-install:${input.workflowId}`,
        skillName: `test-${input.workflowId}`,
        skillPath: join(tempRoot, "skills", input.workflowId, "SKILL.md"),
      }),
      startTurn: async () => {
        throw new Error("startTurn should not be called while stopping");
      },
      stopWorkerProcesses,
    };

    const { createProductStore } = await import("../src/product/store.js");
    const store = createProductStore({
      runtimeConfig: createRuntimeConfig(tempRoot),
      workerExecutor,
    } as never);

    const stopped = await store.stopWorker("sales");

    expect(stopWorkerProcesses).toHaveBeenCalledWith({
      workerAgentReference: "hermes-profile:ow-sales-sales-ai-worker",
    });
    expect(
      stopped.workers.find((worker) => worker.id === "sales"),
    ).toMatchObject({
      status: "No active task",
      tone: "idle",
      heartbeat: "AI worker stopped",
    });
  });

  it("shuts down every active handle and persisted worker process", async () => {
    const pendingCompletion = new Promise<never>(() => undefined);
    const firstHandleStop = vi.fn(() => {
      throw new Error("first handle stop failed");
    });
    const secondHandleStop = vi.fn(() => true);
    const handles: WorkerExecutorTurnHandle[] = [
      {
        ready: Promise.resolve({
          ok: true,
          sessionId: "shutdown-session",
          sessionStatus: "running",
          sessionStatusMessage: "Worker ready",
          userAction: null,
          output: "Worker ready",
          errorMessage: null,
        }),
        completion: pendingCompletion,
        stop: firstHandleStop,
      },
      {
        ready: Promise.resolve({
          ok: true,
          sessionId: "shutdown-session",
          sessionStatus: "running",
          sessionStatusMessage: "Worker ready",
          userAction: null,
          output: "Command accepted",
          errorMessage: null,
        }),
        completion: pendingCompletion,
        stop: secondHandleStop,
      },
    ];
    let startTurnIndex = 0;
    const stopWorkerProcesses = vi.fn(
      async (input: { workerAgentReference: string }) => {
        if (input.workerAgentReference === "shutdown-agent:sales") {
          throw new Error("sales process cleanup failed");
        }
        return true;
      },
    );
    const workerExecutor: WorkerExecutor = {
      kind: "test-executor",
      skillScope: {},
      probeStatus: async () => ({
        command: "test-executor",
        available: true,
        model: "test-model",
        provider: "test-provider",
        providerHealth: defaultHermesProviderHealth(),
        enabledToolsets: [],
        missingComputerUseToolsets: [],
        computerUseReady: true,
        computerUseSummary: "Test executor ready",
        configSource: "Injected test executor",
        configPath: null,
        runtimeHome: null,
        lastCheckedAt: new Date().toISOString(),
        lastProbeSessionId: null,
        lastError: null,
      }),
      provisionAgent: async (input) => ({
        agentReference: `shutdown-agent:${input.workerId}`,
        agentLabel: `shutdown-agent-${input.workerId}`,
        agentPath: null,
        output: "agent ready",
      }),
      installSkill: async (input) => ({
        skillReference: `shutdown-skill:${input.workflowId}`,
        installReference: `shutdown-install:${input.workflowId}`,
        skillName: `shutdown-${input.workflowId}`,
        skillPath: join(
          tempRoot,
          "shutdown-skills",
          input.workflowId,
          "SKILL.md",
        ),
      }),
      startTurn: async () => handles[startTurnIndex++]!,
      stopWorkerProcesses,
    };

    const { createProductStore } = await import("../src/product/store.js");
    const store = createProductStore({
      runtimeConfig: createRuntimeConfig(tempRoot),
      workerExecutor,
    });
    await runSeedSalesWorkflow(store);
    await store.sendCommand("sales", "Keep this command active");
    const expectedWorkerReferences = (await store.getState()).workers
      .map((worker) => worker.config.hermesAgentReference)
      .sort();

    await expect(store.shutdown()).resolves.toBeUndefined();

    expect(firstHandleStop).toHaveBeenCalledOnce();
    expect(secondHandleStop).toHaveBeenCalledOnce();
    expect(stopWorkerProcesses).toHaveBeenCalledTimes(
      expectedWorkerReferences.length,
    );
    expect(
      stopWorkerProcesses.mock.calls
        .map(([input]) => input.workerAgentReference)
        .sort(),
    ).toEqual(expectedWorkerReferences);
  });

  it("cancels an in-flight managed Hermes probe during ProductStore shutdown", async () => {
    const hermesPath = join(tempRoot, "fake-hermes-shutdown-probe");
    const llmConfigPath = join(tempRoot, "llm.config.json");
    const parentPidPath = join(tempRoot, "shutdown-probe-parent.pid");
    const descendantPidPath = join(tempRoot, "shutdown-probe-descendant.pid");
    const observedPids: number[] = [];
    await writeFile(
      llmConfigPath,
      `${JSON.stringify({
        provider: "test",
        baseUrl: "https://example.test/v1",
        wireApi: "responses",
        model: "gpt-test",
        apiKey: null,
      })}\n`,
      "utf8",
    );
    await writeFile(
      hermesPath,
      `#!/bin/sh
echo "$$" > "${parentPidPath}"
trap '' TERM
(
  trap '' TERM
  while true; do
    sleep 1
  done
) &
echo "$!" > "${descendantPidPath}"
wait
`,
      "utf8",
    );
    await chmod(hermesPath, 0o755);
    process.env.OYSTERWORKFLOW_HERMES_COMMAND = hermesPath;
    vi.resetModules();

    const { createProductStore } = await import("../src/product/store.js");
    const runtimeConfig = {
      ...createRuntimeConfig(tempRoot),
      productSeedMode: "empty" as const,
      hermesCommandPath: hermesPath,
      llmConfigPath,
    };
    const store = createProductStore({ runtimeConfig });
    const refreshing = store.refreshHermes();
    const refreshAssertion = expect(refreshing).rejects.toThrow(
      "Product store is shutting down",
    );

    try {
      await Promise.all([
        waitForPath(parentPidPath),
        waitForPath(descendantPidPath),
      ]);
      observedPids.push(
        Number((await readFile(parentPidPath, "utf8")).trim()),
        Number((await readFile(descendantPidPath, "utf8")).trim()),
      );

      const shutdownStartedAt = Date.now();
      await expect(store.shutdown()).resolves.toBeUndefined();
      expect(Date.now() - shutdownStartedAt).toBeLessThan(3_000);
      await refreshAssertion;
      for (const pid of observedPids) {
        await expect(waitForProcessExit(pid)).resolves.toBeUndefined();
      }
    } finally {
      await store.shutdown().catch(() => undefined);
      for (const pid of observedPids) {
        if (isProcessAlive(pid)) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // The bounded runner may have completed cleanup between checks.
          }
        }
      }
    }
  }, 10_000);

  it("stops a worker handle that arrives after shutdown has started", async () => {
    const startTurnStarted = deferred<void>();
    const lateStartTurn = deferred<WorkerExecutorTurnHandle>();
    const pendingTurnResult = new Promise<never>(() => undefined);
    const lateHandleStop = vi.fn(() => true);
    const stopWorkerProcesses = vi.fn(async () => true);
    const workerExecutor: WorkerExecutor = {
      kind: "test-executor",
      skillScope: {},
      probeStatus: async () => ({
        command: "test-executor",
        available: true,
        model: "test-model",
        provider: "test-provider",
        providerHealth: defaultHermesProviderHealth(),
        enabledToolsets: [],
        missingComputerUseToolsets: [],
        computerUseReady: true,
        computerUseSummary: "Test executor ready",
        configSource: "Injected test executor",
        configPath: null,
        runtimeHome: null,
        lastCheckedAt: new Date().toISOString(),
        lastProbeSessionId: null,
        lastError: null,
      }),
      provisionAgent: async (input) => ({
        agentReference: `late-agent:${input.workerId}`,
        agentLabel: `late-agent-${input.workerId}`,
        agentPath: null,
        output: "agent ready",
      }),
      installSkill: async (input) => ({
        skillReference: `late-skill:${input.workflowId}`,
        installReference: `late-install:${input.workflowId}`,
        skillName: `late-${input.workflowId}`,
        skillPath: join(tempRoot, "late-skills", input.workflowId, "SKILL.md"),
      }),
      startTurn: async () => {
        startTurnStarted.resolve();
        return lateStartTurn.promise;
      },
      stopWorkerProcesses,
    };

    const { createProductStore } = await import("../src/product/store.js");
    const store = createProductStore({
      runtimeConfig: createRuntimeConfig(tempRoot),
      workerExecutor,
    });
    const running = runSeedSalesWorkflow(store);
    await startTurnStarted.promise;

    const firstShutdown = store.shutdown();
    const secondShutdown = store.shutdown();
    expect(secondShutdown).toBe(firstShutdown);
    lateStartTurn.resolve({
      ready: pendingTurnResult,
      completion: pendingTurnResult,
      stop: lateHandleStop,
    });

    await expect(running).rejects.toThrow("Product store is shutting down");
    await expect(firstShutdown).resolves.toBeUndefined();
    expect(lateHandleStop).toHaveBeenCalledOnce();
    expect(stopWorkerProcesses).toHaveBeenCalledWith({
      workerAgentReference: "late-agent:sales",
    });

    const cleanupCalls = stopWorkerProcesses.mock.calls.length;
    await expect(store.shutdown()).resolves.toBeUndefined();
    expect(stopWorkerProcesses).toHaveBeenCalledTimes(cleanupCalls);
    expect(lateHandleStop).toHaveBeenCalledOnce();
    await expect(store.startWorker("sales")).rejects.toThrow(
      "Product store is shutting down",
    );
    await expect(
      store.runInstalledWorkflow("installed-meeting-actions"),
    ).rejects.toThrow("Product store is shutting down");
    await expect(store.sendCommand("sales", "Do not start")).rejects.toThrow(
      "Product store is shutting down",
    );
  });

  it("coalesces output bursts and drops every worker callback after shutdown", async () => {
    const completion =
      deferred<Awaited<WorkerExecutorTurnHandle["completion"]>>();
    let onOutput:
      | ((chunk: { stream: "stdout" | "stderr"; text: string }) => void)
      | undefined;
    let onProgress:
      ((event: { status: string; body: string }) => void) | undefined;
    const workerExecutor: WorkerExecutor = {
      kind: "callback-pressure-test",
      skillScope: {},
      probeStatus: async () => ({
        command: "callback-pressure-test",
        available: true,
        model: "test-model",
        provider: "test-provider",
        providerHealth: defaultHermesProviderHealth(),
        enabledToolsets: [],
        missingComputerUseToolsets: [],
        computerUseReady: true,
        computerUseSummary: "Ready",
        configSource: "test",
        configPath: null,
        runtimeHome: null,
        lastCheckedAt: new Date().toISOString(),
        lastProbeSessionId: null,
        lastError: null,
      }),
      provisionAgent: async ({ workerId }) => ({
        agentReference: `callback-agent:${workerId}`,
        agentLabel: workerId,
        agentPath: null,
        output: "ready",
      }),
      installSkill: async ({ workflowId }) => ({
        skillReference: `callback-skill:${workflowId}`,
        installReference: `callback-install:${workflowId}`,
        skillName: workflowId,
        skillPath: join(tempRoot, "callback-skills", workflowId, "SKILL.md"),
      }),
      startTurn: async (input) => {
        onOutput = input.onOutput;
        onProgress = input.onProgress;
        return {
          ready: Promise.resolve({
            ok: true,
            sessionId: "callback-session",
            sessionStatus: "running",
            sessionStatusMessage: "Ready",
            userAction: null,
            output: "Ready",
            errorMessage: null,
          }),
          completion: completion.promise,
          stop: () => true,
        };
      },
      stopWorkerProcesses: async () => true,
    };
    const { createProductStore } = await import("../src/product/store.js");
    const store = createProductStore({
      runtimeConfig: createRuntimeConfig(tempRoot),
      workerExecutor,
    });
    const started = await runSeedSalesWorkflow(store);
    const burstStartedAt = Date.now();
    for (let index = 0; index < 5_000; index += 1) {
      onOutput?.({ stream: "stdout", text: `worker chunk ${index}\n` });
    }
    await waitForState(async () => {
      const state = await store.getState();
      return state.runEvents.some(
        (event) =>
          event.runId === started.run.id &&
          event.status === "AI worker working",
      );
    });
    expect(Date.now() - burstStartedAt).toBeLessThan(2_000);
    const beforeShutdown = await store.getState();
    const runEventCount = beforeShutdown.runEvents.length;
    const unhandled: unknown[] = [];
    const captureUnhandled = (error: unknown) => unhandled.push(error);
    process.on("unhandledRejection", captureUnhandled);
    try {
      await store.shutdown();
      onOutput?.({ stream: "stdout", text: "late output\n" });
      onProgress?.({ status: "Late progress", body: "must be ignored" });
      completion.resolve({
        ok: true,
        sessionId: "callback-session",
        sessionStatus: "succeeded",
        sessionStatusMessage: "Late completion",
        userAction: null,
        output: "Late completion",
        errorMessage: null,
      });
      await new Promise((resolve) => setTimeout(resolve, 50));

      const afterShutdown = await store.getState();
      expect(afterShutdown.runEvents).toHaveLength(runEventCount);
      expect(
        afterShutdown.runEvents.some((event) =>
          event.body.includes("Late completion"),
        ),
      ).toBe(false);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", captureUnhandled);
    }
  });

  it("releases per-run signal state when a handle settles without accepting its late callbacks", async () => {
    const firstCompletion =
      deferred<Awaited<WorkerExecutorTurnHandle["completion"]>>();
    const secondCompletion =
      deferred<Awaited<WorkerExecutorTurnHandle["completion"]>>();
    let turnCount = 0;
    let firstTurnOutput:
      | ((chunk: { stream: "stdout" | "stderr"; text: string }) => void)
      | undefined;
    const workerExecutor: WorkerExecutor = {
      kind: "signal-lifecycle-test",
      skillScope: {},
      probeStatus: async () => ({
        command: "signal-lifecycle-test",
        available: true,
        model: "test-model",
        provider: "test-provider",
        providerHealth: defaultHermesProviderHealth(),
        enabledToolsets: [],
        missingComputerUseToolsets: [],
        computerUseReady: true,
        computerUseSummary: "Ready",
        configSource: "test",
        configPath: null,
        runtimeHome: null,
        lastCheckedAt: new Date().toISOString(),
        lastProbeSessionId: null,
        lastError: null,
      }),
      provisionAgent: async ({ workerId }) => ({
        agentReference: `signal-agent:${workerId}`,
        agentLabel: workerId,
        agentPath: null,
        output: "ready",
      }),
      installSkill: async ({ workflowId }) => ({
        skillReference: `signal-skill:${workflowId}`,
        installReference: `signal-install:${workflowId}`,
        skillName: workflowId,
        skillPath: join(tempRoot, "signal-skills", workflowId, "SKILL.md"),
      }),
      startTurn: async (input) => {
        turnCount += 1;
        const isFirstTurn = turnCount === 1;
        if (isFirstTurn) {
          firstTurnOutput = input.onOutput;
        }
        input.onOutput?.({
          stream: "stdout",
          text: isFirstTurn
            ? "first turn activity\n"
            : "second turn activity\n",
        });
        return {
          ready: Promise.resolve({
            ok: true,
            sessionId: "signal-lifecycle-session",
            sessionStatus: "running",
            sessionStatusMessage: "AI worker ready",
            userAction: null,
            output: "AI worker ready",
            errorMessage: null,
          }),
          completion: isFirstTurn
            ? firstCompletion.promise
            : secondCompletion.promise,
          stop: () => true,
        };
      },
      stopWorkerProcesses: async () => true,
    };
    const { createProductStore } = await import("../src/product/store.js");
    const store = createProductStore({
      runtimeConfig: createRuntimeConfig(tempRoot),
      workerExecutor,
    });

    const initialized = await store.startWorker("sales");
    const runId = initialized.state.runs[0]!.id;
    await waitForState(async () => {
      const state = await store.getState();
      return state.runEvents.some(
        (event) =>
          event.runId === runId && event.status === "AI worker working",
      );
    });
    firstCompletion.resolve({
      ok: true,
      sessionId: "signal-lifecycle-session",
      sessionStatus: "running",
      sessionStatusMessage: "First turn settled",
      userAction: null,
      output: "First turn settled",
      errorMessage: null,
    });
    await waitForState(async () => {
      const state = await store.getState();
      return (
        state.workers.find((worker) => worker.id === "sales")?.heartbeat ===
          "AI worker ready" &&
        state.runEvents.some(
          (event) =>
            event.runId === runId && event.body === "First turn settled",
        )
      );
    });

    firstTurnOutput?.({ stream: "stdout", text: "late first output\n" });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const afterLateOutput = await store.getState();
    expect(
      afterLateOutput.workers.find((worker) => worker.id === "sales"),
    ).toMatchObject({ heartbeat: "AI worker ready" });

    await store.sendCommand("sales", "Start the second turn");
    await waitForState(async () => {
      const state = await store.getState();
      return (
        state.workers.find((worker) => worker.id === "sales")?.heartbeat ===
        "AI worker working"
      );
    });
    const afterSecondOutput = await store.getState();
    expect(
      afterSecondOutput.runEvents.filter(
        (event) =>
          event.runId === runId && event.status === "AI worker working",
      ),
    ).toHaveLength(1);

    await store.stopWorker("sales");
  });

  it("installs workflow skills into the OysterWorkflow managed Hermes runtime", async () => {
    const fakeHome = join(tempRoot, "home");
    const managedRoot = join(tempRoot, "app-data", "hermes");
    const managedBin = join(managedRoot, "bin");
    const managedProfilesRoot = join(managedRoot, "profiles");
    const managedSkillsRoot = join(managedRoot, "skills");
    const hermesPath = join(managedBin, "hermes");
    const hermesHomeMarker = join(tempRoot, "hermes-home-used");
    await mkdir(managedBin, { recursive: true });
    await mkdir(join(tempRoot, "empty-bin"), { recursive: true });
    await writeFile(
      hermesPath,
      `#!/bin/sh
echo "$HERMES_HOME" > "${hermesHomeMarker}"
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
  /bin/mkdir -p "$HERMES_HOME/profiles/$3/skills"
  echo "Created profile $3"
  exit 0
fi
echo "unknown fake-hermes command: $*" >&2
exit 1
`,
      "utf8",
    );
    await chmod(hermesPath, 0o755);
    delete process.env.OYSTERWORKFLOW_HERMES_COMMAND;
    delete process.env.OYSTERWORKFLOW_HERMES_PROFILES_ROOT;
    delete process.env.OYSTERWORKFLOW_HERMES_SKILLS_ROOT;
    process.env.HOME = fakeHome;
    process.env.PATH = join(tempRoot, "empty-bin");
    vi.resetModules();

    const { createProductStore } = await import("../src/product/store.js");
    const store = createProductStore({
      runtimeConfig: {
        ...createRuntimeConfig(tempRoot),
        hermesCommandPath: hermesPath,
        hermesRuntimeRoot: managedRoot,
        hermesProfilesRoot: managedProfilesRoot,
        hermesSkillsRoot: managedSkillsRoot,
      },
    });
    const workflow = await store.createWorkflow({
      mode: "new",
      title: "Managed Hermes runtime install",
      description: "Install a workflow into an OysterWorkflow managed profile.",
      apps: ["Microsoft Outlook"],
    });

    const installed = await store.installWorkflow({
      workerId: "sales",
      workflowId: workflow.workflow.id,
      workflowTitle: "Managed Hermes runtime install",
      description: "Install a workflow into an OysterWorkflow managed profile.",
      apps: ["Microsoft Outlook"],
    });

    expect(installed.installedWorkflow.hermesSkillPath).toContain(
      managedProfilesRoot,
    );
    await expect(readFile(hermesHomeMarker, "utf8")).resolves.toBe(
      `${managedRoot}\n`,
    );
  });

  it("does not fall back to PATH when a packaged Hermes command path is configured but missing", async () => {
    const fakePathBin = join(tempRoot, "fake-path-bin");
    const fakePathHermes = join(fakePathBin, "hermes");
    const fallbackMarker = join(tempRoot, "path-hermes-was-used");
    const missingPackagedHermes = join(
      tempRoot,
      "Resources",
      "bin",
      "oysterworkflow-hermes",
    );
    await mkdir(fakePathBin, { recursive: true });
    await writeFile(
      fakePathHermes,
      `#!/bin/sh
/usr/bin/touch "${fallbackMarker}"
if [ "$1" = "status" ]; then
  echo "Model: fake-global-hermes"
  echo "Provider: should-not-be-used"
  exit 0
fi
if [ "$1" = "chat" ]; then
  echo "OYSTERWORKFLOW_AI_WORKER_READY"
  exit 0
fi
if [ "$1" = "tools" ] && [ "$2" = "list" ]; then
  echo "  ✓ enabled  browser"
  echo "  ✓ enabled  terminal"
  echo "  ✓ enabled  file"
  echo "  ✓ enabled  vision"
  exit 0
fi
exit 0
`,
      "utf8",
    );
    await chmod(fakePathHermes, 0o755);
    delete process.env.OYSTERWORKFLOW_HERMES_COMMAND;
    process.env.PATH = fakePathBin;
    vi.resetModules();

    const { createProductStore } = await import("../src/product/store.js");
    const store = createProductStore({
      runtimeConfig: {
        ...createRuntimeConfig(tempRoot),
        hermesCommandPath: missingPackagedHermes,
      },
    });

    const state = await store.refreshHermes();

    expect(state.hermes).toMatchObject({
      command: missingPackagedHermes,
      available: false,
      lastError: `Configured Hermes command is not executable: ${missingPackagedHermes}`,
    });
    await expect(access(fallbackMarker)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("creates a worker by provisioning a real Hermes profile reference", async () => {
    const hermesPath = join(tempRoot, "fake-hermes-profile");
    const profileMarker = join(tempRoot, "profile-created");
    const profileRoot = join(tempRoot, "profiles");
    await writeFile(
      hermesPath,
      `#!/bin/sh
if [ "$1" = "-p" ] && [ "$3" = "profile" ] && [ "$4" = "show" ]; then
  if [ -f "${profileMarker}" ]; then
    echo "Profile: $2"
    echo "Path: ${profileRoot}/$2"
    exit 0
  fi
  echo "Profile not found" >&2
  exit 1
fi
if [ "$1" = "profile" ] && [ "$2" = "create" ]; then
  mkdir -p "${profileRoot}/$3/skills"
  touch "${profileMarker}"
  echo "Created profile $3"
  exit 0
fi
if [ "$1" = "status" ]; then
  echo "Model: fake-hermes"
  echo "Provider: local-test"
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
    process.env.OYSTERWORKFLOW_HERMES_PROFILES_ROOT = profileRoot;
    vi.resetModules();

    const { createProductStore } = await import("../src/product/store.js");
    const store = createProductStore({
      runtimeConfig: createRuntimeConfig(tempRoot),
    });
    const created = await store.createWorker({
      mode: "new",
      name: "Renewal Worker",
      description: "Prepare renewal evidence and next steps.",
      commandChannel: "WeChat",
      sourceText: "Use Alex's renewal operating style.",
    });

    expect(created.worker.config.hermesAgentReference).toMatch(
      /^hermes-profile:ow-/u,
    );
    expect(created.worker.status).toBe("Needs device");
    expect(created.state.approvalPolicies).toContainEqual(
      expect.objectContaining({
        scopeType: "worker",
        scopeId: created.worker.id,
        mode: "allow_all",
      }),
    );
    const workflow = await store.createWorkflow({
      mode: "new",
      title: "Prepare renewal evidence",
      description: "Collect renewal evidence before account review.",
      apps: ["Microsoft Outlook", "Salesforce"],
    });

    const installed = await store.installWorkflow({
      workerId: created.worker.id,
      workflowId: workflow.workflow.id,
      workflowTitle: "Prepare renewal evidence",
      description: "Collect renewal evidence before account review.",
      apps: ["Microsoft Outlook", "Salesforce"],
    });
    expect(installed.installedWorkflow.hermesSkillPath).toContain(profileRoot);
  });

  it("configures and tests a worker message channel through the Hermes profile", async () => {
    const hermesPath = join(tempRoot, "fake-hermes-channel");
    const profileRoot = join(tempRoot, "profiles");
    await writeFile(
      hermesPath,
      `#!/bin/sh
if [ "$1" = "-p" ] && [ "$3" = "profile" ] && [ "$4" = "show" ]; then
  if [ -d "${profileRoot}/$2" ]; then
    echo "Profile: $2"
    echo "Path: ${profileRoot}/$2"
    exit 0
  fi
  echo "Profile not found" >&2
  exit 1
fi
if [ "$1" = "profile" ] && [ "$2" = "create" ]; then
  mkdir -p "${profileRoot}/$3/skills"
  echo "Created profile $3"
  exit 0
fi
if [ "$1" = "-p" ] && [ "$3" = "gateway" ] && [ "$4" = "status" ]; then
  echo "Gateway is running"
  exit 0
fi
echo "ok"
exit 0
`,
      "utf8",
    );
    await chmod(hermesPath, 0o755);
    process.env.OYSTERWORKFLOW_HERMES_COMMAND = hermesPath;
    process.env.OYSTERWORKFLOW_HERMES_PROFILES_ROOT = profileRoot;
    vi.resetModules();

    const { createProductStore } = await import("../src/product/store.js");
    const store = createProductStore({
      runtimeConfig: createRuntimeConfig(tempRoot),
    });
    const created = await store.createWorker({
      mode: "new",
      name: "Slack Intake Worker",
      description: "Handle approved Slack intake requests.",
      channel: {
        platform: "slack",
        accessMode: "allowlist",
        homeChannel: "C123",
        allowedUsers: ["U123"],
        credentials: {
          SLACK_BOT_TOKEN: "xoxb-test-token",
          SLACK_APP_TOKEN: "xapp-test-token",
        },
      },
    });
    const profileName = created.worker.config.hermesAgentReference.replace(
      "hermes-profile:",
      "",
    );
    const profileDir = join(profileRoot, profileName);
    const envContent = await readFile(join(profileDir, ".env"), "utf8");

    expect(envContent).toContain('SLACK_BOT_TOKEN="xoxb-test-token"');
    expect(envContent).toContain('SLACK_APP_TOKEN="xapp-test-token"');
    expect(envContent).toContain('SLACK_HOME_CHANNEL="C123"');
    expect(envContent).toContain('SLACK_ALLOWED_USERS="U123"');
    expect(created.worker.config.channel).toMatchObject({
      platform: "slack",
      label: "Slack",
      status: "configured",
      configuredFields: ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"],
    });
    expect(JSON.stringify(created.worker.config.channel)).not.toContain(
      "xoxb-test-token",
    );

    await expect(
      store.configureWorkerChannel(created.worker.id, {
        platform: "slack",
        accessMode: "allowlist",
        credentials: {
          SLACK_BOT_TOKEN: "A012APPID",
          SLACK_APP_TOKEN: "verification-token",
        },
      }),
    ).rejects.toThrow("Slack Bot token must start with xoxb-");
    await expect(readFile(join(profileDir, ".env"), "utf8")).resolves.toContain(
      'SLACK_BOT_TOKEN="xoxb-test-token"',
    );

    const reconfigured = await store.configureWorkerChannel(created.worker.id, {
      platform: "slack",
      accessMode: "allowlist",
      homeChannel: "C999",
      allowedUsers: ["U456"],
      credentials: {},
    });
    expect(reconfigured.channel).toMatchObject({
      platform: "slack",
      homeChannel: "C999",
      allowedUsers: ["U456"],
      configuredFields: ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"],
      status: "configured",
    });
    await expect(readFile(join(profileDir, ".env"), "utf8")).resolves.toContain(
      'SLACK_BOT_TOKEN="xoxb-test-token"',
    );

    await writeFile(
      join(profileDir, "gateway_state.json"),
      JSON.stringify({
        gateway_state: "running",
        platforms: {
          slack: {
            state: "connected",
          },
        },
      }),
      "utf8",
    );

    const tested = await store.testWorkerChannel(created.worker.id);
    expect(tested.channel.status).toBe("configured");
    expect(tested.channel.lastError).toBeNull();
    expect(tested.worker.activities[0]).toBe("Slack channel configured");
  });

  it("connects, discovers, and binds a QR channel to the selected worker session", async () => {
    const bindCalls: Array<{
      chatId: string;
      threadId?: string | null;
      sessionId: string;
      connectionId?: string | null;
    }> = [];
    const disconnectCalls: Array<{
      platform: string;
      bindings: Array<{ chatId: string; threadId?: string | null }>;
    }> = [];
    const cancelledSetupIds: string[] = [];
    const workerExecutor: WorkerExecutor = {
      kind: "channel-test",
      skillScope: {},
      probeStatus: async () => ({
        command: "channel-test",
        available: true,
        model: "test-model",
        provider: "test-provider",
        providerHealth: defaultHermesProviderHealth(),
        enabledToolsets: [],
        missingComputerUseToolsets: [],
        computerUseReady: true,
        computerUseSummary: "Ready",
        configSource: null,
        configPath: null,
        runtimeHome: null,
        lastCheckedAt: new Date().toISOString(),
        lastProbeSessionId: null,
        lastError: null,
      }),
      provisionAgent: async ({ workerId }) => ({
        agentReference: `hermes-profile:${workerId}`,
        agentLabel: workerId,
        agentPath: null,
        output: "ready",
      }),
      installSkill: async ({ workflowId }) => ({
        skillReference: `skill:${workflowId}`,
        installReference: `install:${workflowId}`,
        skillName: workflowId,
        skillPath: join(tempRoot, `${workflowId}.md`),
      }),
      startTurn: async () => ({
        ready: Promise.resolve({
          ok: true,
          sessionId: "worker-primary-session",
          sessionStatus: "running",
          sessionStatusMessage: "Ready",
          userAction: null,
          output: "Worker ready",
          errorMessage: null,
        }),
        completion: new Promise(() => undefined),
        stop: () => true,
      }),
      beginChannelSetup: async ({ setupId, platform }) => ({
        setupId,
        platform,
        status: "starting",
        qrPayload: null,
        qrExpiresAt: null,
        accountLabel: null,
        processId: 4321,
        lastError: null,
        updatedAt: new Date().toISOString(),
      }),
      readChannelSetup: async ({ setupId, platform }) => ({
        setupId,
        platform,
        status: "connected",
        qrPayload: "qr-payload",
        qrExpiresAt: null,
        accountLabel: "wx-owner",
        ownerUserId: "owner-123",
        processId: 4321,
        lastError: null,
        updatedAt: new Date().toISOString(),
      }),
      cancelChannelSetup: async ({ setupId }) => {
        cancelledSetupIds.push(setupId);
        return true;
      },
      ensureChannelGateway: async () => undefined,
      listChannelPeers: async ({ platform }) => [
        {
          platform,
          chatId: "conversation-123",
          threadId: "message-root-123",
          senderId: "owner-123",
          chatType: "dm",
          sessionId: "discovery-session",
          discoveredAt: new Date().toISOString(),
          bound: false,
        },
      ],
      bindChannelConversation: async (input) => {
        bindCalls.push(input);
        return {
          platform: input.platform,
          chatId: input.chatId,
          threadId: input.threadId ?? null,
          sessionId: input.sessionId,
          connectionId: input.connectionId ?? null,
        };
      },
      disconnectChannel: async (input) => {
        disconnectCalls.push(input);
      },
      approveChannelPairing: async ({ platform, code }) => {
        expect(code).toBe("AB23CDEF");
        return {
          platform,
          userId: "paired-user-456",
          userName: "Owner",
        };
      },
    };
    const { createProductStore } = await import("../src/product/store.js");
    const store = createProductStore({
      runtimeConfig: createRuntimeConfig(tempRoot),
      workerExecutor,
    });

    await store.startWorker("sales");
    const setupToCancel = await store.beginWorkerChannelSetup("sales", {
      platform: "weixin",
      allowedUsers: ["owner-123"],
    });
    const cancelled = await store.cancelWorkerChannelSetup(
      "sales",
      setupToCancel.setup.id,
    );
    expect(cancelled.setup.status).toBe("cancelled");
    expect(cancelled.connection.status).toBe("disconnected");
    expect(
      cancelled.state.workers.find((worker) => worker.id === "sales")?.config
        .channel,
    ).toMatchObject({
      platform: "weixin",
      status: "not_configured",
      missingFields: ["QR_LINK"],
    });

    const started = await store.beginWorkerChannelSetup("sales", {
      platform: "weixin",
      allowedUsers: ["owner-123"],
    });
    const replacement = await store.beginWorkerChannelSetup("sales", {
      platform: "weixin",
      allowedUsers: ["owner-123"],
    });
    expect(cancelledSetupIds).toContain(started.setup.id);
    const connected = await store.readWorkerChannelSetup(
      "sales",
      replacement.setup.id,
    );
    const peers = await store.listWorkerChannelPeers(
      "sales",
      connected.connection.id,
    );
    const approved = await store.approveWorkerChannelPairing("sales", {
      connectionId: connected.connection.id,
      code: "AB23CDEF",
    });
    const bound = await store.bindWorkerChannel("sales", {
      connectionId: connected.connection.id,
      conversationId: peers.peers[0]!.conversationId,
      conversationType: peers.peers[0]!.conversationType,
      threadId: peers.peers[0]!.threadId,
      hermesSessionId: "worker-primary-session",
      deliveryConfirmed: true,
    });

    expect(connected.connection).toMatchObject({
      platform: "weixin",
      status: "connecting",
      accountLabel: "wx-owner",
    });
    expect(bound.connection.status).toBe("connected");
    expect(approved.approval).toEqual({
      platform: "weixin",
      userId: "paired-user-456",
      userName: "Owner",
    });
    expect(
      approved.state.workers.find((worker) => worker.id === "sales")?.config
        .channel.allowedUsers,
    ).toContain("paired-user-456");
    expect(
      connected.state.workers.find((worker) => worker.id === "sales")?.config
        .channel.allowedUsers,
    ).toEqual(["owner-123"]);
    expect(bound.binding).toMatchObject({
      conversationId: "conversation-123",
      hermesSessionId: "worker-primary-session",
      status: "bound",
    });
    expect(bindCalls).toEqual([
      expect.objectContaining({
        chatId: "conversation-123",
        threadId: null,
        sessionId: "worker-primary-session",
        connectionId: connected.connection.id,
      }),
    ]);

    const disconnected = await store.disconnectWorkerChannel("sales", {
      connectionId: connected.connection.id,
    });
    expect(disconnectCalls).toEqual([
      {
        workerAgentReference: "hermes-profile:sales",
        platform: "weixin",
        bindings: [{ chatId: "conversation-123", threadId: null }],
      },
    ]);
    expect(disconnected.state.channelConnections).toEqual([]);
    expect(disconnected.state.channelBindings).toEqual([]);
    expect(disconnected.state.channelSetups).toEqual([]);
    expect(
      disconnected.state.workers.find((worker) => worker.id === "sales")?.config
        .channel,
    ).toMatchObject({ platform: "none", status: "not_configured" });
    const shutdownSetup = await store.beginWorkerChannelSetup("sales", {
      platform: "weixin",
      allowedUsers: ["owner-123"],
    });
    await store.shutdown();
    expect(cancelledSetupIds).toContain(shutdownSetup.setup.id);
  });

  it("syncs Hermes profile config from OysterWorkflow LLM config and runtime env file", async () => {
    const hermesPath = join(tempRoot, "fake-hermes-config");
    const profileRoot = join(tempRoot, "profiles");
    await writeFile(
      hermesPath,
      `#!/bin/sh
if [ "$1" = "-p" ] && [ "$3" = "profile" ] && [ "$4" = "show" ]; then
  if [ -d "${profileRoot}/$2" ]; then
    echo "Profile: $2"
    echo "Path: ${profileRoot}/$2"
    exit 0
  fi
  echo "Profile not found" >&2
  exit 1
fi
if [ "$1" = "profile" ] && [ "$2" = "create" ]; then
  mkdir -p "${profileRoot}/$3/skills"
  echo "Created profile $3"
  exit 0
fi
echo "ok"
exit 0
`,
      "utf8",
    );
    await chmod(hermesPath, 0o755);
    await writeFile(
      join(tempRoot, "llm.config.json"),
      `${JSON.stringify(
        {
          provider: "open-ai",
          baseUrl: "https://example.test",
          wireApi: "responses",
          model: "gpt-5.5",
          reasoningEffort: "xhigh",
          apiKey: "${OYSTERWORKFLOW_TEST_HERMES_KEY}",
          apiKeyEnv: "OYSTERWORKFLOW_TEST_HERMES_KEY",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(
      join(tempRoot, ".env"),
      'OYSTERWORKFLOW_TEST_HERMES_KEY="from-runtime-env-file"\n',
      "utf8",
    );
    process.env.OYSTERWORKFLOW_HERMES_COMMAND = hermesPath;
    process.env.OYSTERWORKFLOW_HERMES_PROFILES_ROOT = profileRoot;
    vi.resetModules();

    const { createProductStore } = await import("../src/product/store.js");
    const store = createProductStore({
      runtimeConfig: createRuntimeConfig(tempRoot),
    });
    const created = await store.createWorker({
      mode: "new",
      name: "Renewal Worker",
      description: "Prepare renewal evidence and next steps.",
      commandChannel: "WeChat",
      sourceText: "Use Alex's renewal operating style.",
    });
    const profileName = created.worker.config.hermesAgentReference.replace(
      "hermes-profile:",
      "",
    );
    const profileDir = join(profileRoot, profileName);

    const hermesConfig = await readFile(
      join(profileDir, "config.yaml"),
      "utf8",
    );
    expect(hermesConfig).toContain('provider: "custom:oysterworkflow"');
    expect(hermesConfig).toContain('base_url: "https://example.test/v1"');
    expect(hermesConfig).toContain('api_mode: "codex_responses"');
    expect(hermesConfig).toContain('model: "gpt-5.5"');
    expect(hermesConfig).toContain("auxiliary:");
    expect(hermesConfig).toContain("  vision:");
    expect(hermesConfig).toContain('    provider: "oysterworkflow"');
    expect(hermesConfig).toContain('    api_mode: "codex_responses"');
    expect(hermesConfig).toContain("    timeout: 120");
    expect(hermesConfig).not.toContain("toolsets:");
    expect(hermesConfig).not.toContain("- computer_use");
    await expect(readFile(join(profileDir, ".env"), "utf8")).resolves.toContain(
      'OYSTERWORKFLOW_TEST_HERMES_KEY="from-runtime-env-file"',
    );
  });

  it("passes the non-technical worker config into the Hermes run prompt", async () => {
    const hermesPath = join(tempRoot, "fake-hermes-worker-config");
    const profileRoot = join(tempRoot, "profiles");
    const promptLogPath = join(tempRoot, "hermes-argv.log");
    await writeFile(
      hermesPath,
      `#!/bin/sh
{
  echo "---"
  for arg in "$@"; do
    echo "$arg"
  done
} >> "${promptLogPath}"
if [ "$1" = "-p" ] && [ "$3" = "profile" ] && [ "$4" = "show" ]; then
  if [ -d "${profileRoot}/$2" ]; then
    echo "Profile: $2"
    echo "Path: ${profileRoot}/$2"
    exit 0
  fi
  echo "Profile not found" >&2
  exit 1
fi
if [ "$1" = "profile" ] && [ "$2" = "create" ]; then
  mkdir -p "${profileRoot}/$3/skills"
  echo "Created profile $3"
  exit 0
fi
if [ "$1" = "-p" ] && [ "$3" = "chat" ]; then
  echo "Hermes started with worker setup"
  echo "session_id: config-prompt-session" >&2
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
    process.env.OYSTERWORKFLOW_HERMES_PROFILES_ROOT = profileRoot;
    vi.resetModules();

    const { createProductStore } = await import("../src/product/store.js");
    const store = createProductStore({
      runtimeConfig: createRuntimeConfig(tempRoot),
    });

    await store.updateWorkerConfig("sales", {
      identityScope:
        "Qualify inbound customer emails, ask engineering before promises, and keep drafts unsent.",
      runtimeProfile: "Hermes Agent / OysterWorkflow managed profile",
      toolAccess: ["browser control", "mail", "chat", "crm"],
      memoryContext:
        "Use installed workflow context, prior customer notes, and local opportunity memory.",
      approvalPolicy: "allow_all",
      heartbeatPolicy:
        "When blocked, recover once, log evidence, and explain the next needed screen.",
      hermesAgentReference: "hermes-profile:ow-sales-sales-ai-worker",
    });
    await runSeedSalesWorkflow(store);

    const promptLog = await readFile(promptLogPath, "utf8");
    expect(promptLog).toMatch(/--max-turns\n100\n/);
    expect(promptLog).not.toContain("--toolsets");
    expect(promptLog).toContain(
      "Qualify inbound customer emails, ask engineering before promises, and keep drafts unsent.",
    );
    expect(promptLog).toContain(
      "Use installed workflow context, prior customer notes, and local opportunity memory.",
    );
    expect(promptLog).toContain(
      "When blocked, recover once, log evidence, and explain the next needed screen.",
    );
    expect(promptLog).toContain(
      "BrowserAct through the OysterWorkflow browser wrapper, mail, chat, crm",
    );
    expect(promptLog).toContain("Approval policy: allow_all");
    expect(promptLog).toContain(
      "do not inspect or write product databases to create run events",
    );
    expect(promptLog).toContain(
      "Use only evidence from this current run and current app/browser/tool state.",
    );
    expect(promptLog).toContain(
      "Do not rewrite, self-improve, or create skills during workflow execution",
    );
    expect(promptLog).toContain(
      "Avoid noisy repeated full-screen `computer_use` captures.",
    );
    expect(promptLog).toContain(
      "Connected app capability priority: when an MCP/API/composite provider can safely read or mutate the target app data",
    );
    expect(promptLog).toContain(
      "Use Composio hosted MCP, native MCP tools, or direct app APIs for supported apps",
    );
    expect(promptLog).toContain(
      "start with the OysterWorkflow BrowserAct wrapper at `$OYSTER_BROWSER_CLI`",
    );
    expect(promptLog).toContain(
      "Browser automation priority after direct app capabilities: use `$OYSTER_BROWSER_CLI` first, then Hermes built-in browser automation, then `computer_use`, then AppleScript/`osascript`/System Events only as the last fallback.",
    );
    expect(promptLog).toContain(
      "Native desktop app priority after direct app capabilities: use `computer_use` first, then AppleScript/`osascript`/System Events only as the last fallback.",
    );
    expect(promptLog).toContain(
      "Before every `computer_use` action, verify the foreground app/window is the intended target.",
    );
    expect(promptLog).toContain(
      "Avoid temporary browser sessions for login-dependent browser work unless `$OYSTER_BROWSER_CLI` and the current local Chrome state cannot be used",
    );
    expect(promptLog).toContain(
      "If `$OYSTER_BROWSER_CLI` fails because Chrome cannot be attached or no active browser session exists, try Hermes built-in browser automation before `computer_use` on the visible target browser.",
    );
    expect(promptLog).toContain("User-facing response policy:");
    expect(promptLog).toContain("do not mention Hermes, BrowserAct");
    expect(promptLog).toContain("Never include raw stdout or stderr");
    expect(promptLog).toContain(
      "Execute the installed workflow end-to-end now.",
    );
    expect(promptLog).toContain(
      "do not wait for an extra user command such as start or continue",
    );
    expect(promptLog).toContain(
      "Keep operating through the workflow until the business result is complete",
    );
    expect(promptLog).not.toContain(
      "returning a concise status update for the Agent panel",
    );
    expect(promptLog).not.toContain("Provider:");
    expect(promptLog).not.toContain("Model:");
  });

  it("runs the whole installed workflow from Run without requiring a follow-up start command", async () => {
    const hermesPath = join(tempRoot, "fake-hermes-end-to-end-run");
    const profileRoot = join(tempRoot, "profiles");
    await writeFile(
      hermesPath,
      `#!/bin/sh
if [ "$1" = "-p" ] && [ "$3" = "profile" ] && [ "$4" = "show" ]; then
  if [ -d "${profileRoot}/$2" ]; then
    echo "Profile: $2"
    echo "Path: ${profileRoot}/$2"
    exit 0
  fi
  echo "Profile not found" >&2
  exit 1
fi
if [ "$1" = "profile" ] && [ "$2" = "create" ]; then
  mkdir -p "${profileRoot}/$3/skills"
  echo "Created profile $3"
  exit 0
fi
${hermesSessionExportBranch({
  "20260706010100aa": [
    "Reviewed the profile and prepared invite talking points without submitting an invite.",
    'OYSTERWORKFLOW_SESSION_STATUS {"status":"succeeded","message":"Workflow completed end-to-end","user_action":null}',
  ].join("\n"),
})}
if [ "$1" = "-p" ] && [ "$3" = "chat" ]; then
  echo "Session: 20260706010100aa"
  echo "Reviewed the profile and prepared invite talking points without submitting an invite."
  echo 'OYSTERWORKFLOW_SESSION_STATUS {"status":"succeeded","message":"Workflow completed end-to-end","user_action":null}'
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
    process.env.OYSTERWORKFLOW_HERMES_PROFILES_ROOT = profileRoot;
    vi.resetModules();

    const { createProductStore } = await import("../src/product/store.js");
    const store = createProductStore({
      runtimeConfig: createRuntimeConfig(tempRoot),
    });

    const started = await runSeedSalesWorkflow(store);

    await waitForState(async () => {
      const state = await store.getState();
      const run = state.runs.find((item) => item.id === started.run.id);
      return run?.status === "succeeded";
    });

    const state = await store.getState();
    const run = state.runs.find((item) => item.id === started.run.id);
    expect(run).toMatchObject({
      status: "succeeded",
      command: null,
      hermesSessionId: "20260706010100aa",
      errorMessage: null,
    });
    expect(run?.endedAt).toEqual(expect.any(String));
    expect(
      state.commands.some((command) => command.runId === started.run.id),
    ).toBe(false);
    expect(
      state.runEvents.some(
        (event) =>
          event.runId === started.run.id &&
          event.status === "Command" &&
          /start|continue/iu.test(event.body),
      ),
    ).toBe(false);
    expect(
      state.runEvents.find(
        (event) =>
          event.runId === started.run.id &&
          event.status === "AI worker completed",
      )?.body,
    ).toContain("Reviewed the profile and prepared invite talking points");
  });

  it("pauses a finished worker turn when Hermes omits structured session status", async () => {
    const hermesPath = join(tempRoot, "fake-hermes-missing-session-status");
    const profileRoot = join(tempRoot, "profiles");
    await writeFile(
      hermesPath,
      `#!/bin/sh
if [ "$1" = "-p" ] && [ "$3" = "profile" ] && [ "$4" = "show" ]; then
  if [ -d "${profileRoot}/$2" ]; then
    echo "Profile: $2"
    echo "Path: ${profileRoot}/$2"
    exit 0
  fi
  echo "Profile not found" >&2
  exit 1
fi
if [ "$1" = "profile" ] && [ "$2" = "create" ]; then
  mkdir -p "${profileRoot}/$3/skills"
  echo "Created profile $3"
  exit 0
fi
${hermesSessionExportBranch({
  "20260706021100aa":
    "Skill loaded. Status: ready to continue, but no business result is complete.",
})}
if [ "$1" = "-p" ] && [ "$3" = "chat" ]; then
  echo "Session: 20260706021100aa"
  echo "Skill loaded. Status: ready to continue, but no business result is complete."
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
    process.env.OYSTERWORKFLOW_HERMES_PROFILES_ROOT = profileRoot;
    vi.resetModules();

    const { createProductStore } = await import("../src/product/store.js");
    const store = createProductStore({
      runtimeConfig: createRuntimeConfig(tempRoot),
    });

    const started = await runSeedSalesWorkflow(store);

    await waitForState(async () => {
      const state = await store.getState();
      const run = state.runs.find((item) => item.id === started.run.id);
      return Boolean(run && run.status !== "running");
    });

    const state = await store.getState();
    const run = state.runs.find((item) => item.id === started.run.id);
    expect(run).toMatchObject({
      status: "paused",
      hermesSessionId: "20260706021100aa",
      errorMessage: null,
    });
    expect(run?.endedAt).toEqual(expect.any(String));
    expect(
      state.runEvents.some(
        (event) =>
          event.runId === started.run.id &&
          event.status === "AI worker completed",
      ),
    ).toBe(false);
  });

  it("pauses a follow-up command when Hermes returns ok without structured session status", async () => {
    const hermesPath = join(tempRoot, "fake-hermes-command-missing-status");
    const profileRoot = join(tempRoot, "profiles");
    const chatCountPath = join(tempRoot, "chat-count-command-missing-status");
    await writeFile(
      hermesPath,
      `#!/bin/sh
if [ "$1" = "-p" ] && [ "$3" = "profile" ] && [ "$4" = "show" ]; then
  if [ -d "${profileRoot}/$2" ]; then
    echo "Profile: $2"
    echo "Path: ${profileRoot}/$2"
    exit 0
  fi
  echo "Profile not found" >&2
  exit 1
fi
if [ "$1" = "profile" ] && [ "$2" = "create" ]; then
  mkdir -p "${profileRoot}/$3/skills"
  echo "Created profile $3"
  exit 0
fi
${hermesSessionExportBranch({
  "20260706021500aa":
    "Follow-up command received; no business result is complete yet.",
})}
if [ "$1" = "-p" ] && [ "$3" = "chat" ]; then
  count=0
  if [ -f "${chatCountPath}" ]; then
    count="$(cat "${chatCountPath}")"
  fi
  next_count=$((count + 1))
  echo "$next_count" > "${chatCountPath}"
  if [ "$count" = "0" ]; then
    echo "Session: 20260706021500aa"
    echo "Worker ready for follow-up command"
    echo 'OYSTERWORKFLOW_SESSION_STATUS {"status":"running","message":"Ready for a follow-up command","user_action":null}'
    exit 0
  fi
  echo "Session: 20260706021500aa"
  echo "Resumed session 20260706021500aa (1 user message, 5 total messages)"
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
    process.env.OYSTERWORKFLOW_HERMES_PROFILES_ROOT = profileRoot;
    vi.resetModules();

    const { createProductStore } = await import("../src/product/store.js");
    const store = createProductStore({
      runtimeConfig: createRuntimeConfig(tempRoot),
    });

    const started = await runSeedSalesWorkflow(store);
    await store.sendCommand("sales", "ok, start");

    await waitForState(async () => {
      const state = await store.getState();
      const run = state.runs.find((item) => item.id === started.run.id);
      return run?.status === "paused";
    });

    const state = await store.getState();
    const run = state.runs.find((item) => item.id === started.run.id);
    const responseEvent = state.runEvents.find(
      (event) =>
        event.runId === started.run.id && event.status === "AI worker response",
    );
    expect(run).toMatchObject({
      status: "paused",
      command: "ok, start",
      hermesSessionId: "20260706021500aa",
      errorMessage: null,
    });
    expect(run?.endedAt).toEqual(expect.any(String));
    expect(responseEvent?.body).toContain("Follow-up command received");
    expect(responseEvent?.body).not.toContain("Resumed session");
    expect(
      state.runEvents.some(
        (event) =>
          event.runId === started.run.id &&
          event.body.includes("Resumed session"),
      ),
    ).toBe(false);
    expect(
      state.runEvents.some(
        (event) =>
          event.runId === started.run.id &&
          event.status === "AI worker completed",
      ),
    ).toBe(false);
  });

  it("passes the non-technical worker config into follow-up Hermes command prompts", async () => {
    const hermesPath = join(tempRoot, "fake-hermes-command-config");
    const profileRoot = join(tempRoot, "profiles");
    const promptLogPath = join(tempRoot, "hermes-command-argv.log");
    const chatCountPath = join(tempRoot, "hermes-command-count");
    await writeFile(
      hermesPath,
      `#!/bin/sh
{
  echo "---"
  for arg in "$@"; do
    echo "$arg"
  done
} >> "${promptLogPath}"
if [ "$1" = "-p" ] && [ "$3" = "profile" ] && [ "$4" = "show" ]; then
  if [ -d "${profileRoot}/$2" ]; then
    echo "Profile: $2"
    echo "Path: ${profileRoot}/$2"
    exit 0
  fi
  echo "Profile not found" >&2
  exit 1
fi
if [ "$1" = "profile" ] && [ "$2" = "create" ]; then
  mkdir -p "${profileRoot}/$3/skills"
  echo "Created profile $3"
  exit 0
fi
${hermesSessionExportBranch({
  "20260627063127aa": [
    "Worker ready for command",
    'OYSTERWORKFLOW_SESSION_STATUS {"status":"running","message":"Worker ready for follow-up command","user_action":null}',
  ].join("\n"),
  "20260627063127bb": "Hermes command handled with worker setup",
})}
if [ "$1" = "-p" ] && [ "$3" = "chat" ]; then
  count=0
  if [ -f "${chatCountPath}" ]; then
    count="$(cat "${chatCountPath}")"
  fi
  next_count=$((count + 1))
  echo "$next_count" > "${chatCountPath}"
  if [ "$count" = "0" ]; then
    echo "Session: 20260627063127aa"
    echo "Hermes worker ready"
    exit 0
  fi
  echo "Session: 20260627063127bb"
  echo "Hermes command handled with worker setup"
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
    process.env.OYSTERWORKFLOW_HERMES_PROFILES_ROOT = profileRoot;
    vi.resetModules();

    const { createProductStore } = await import("../src/product/store.js");
    const store = createProductStore({
      runtimeConfig: createRuntimeConfig(tempRoot),
    });

    await store.updateWorkerConfig("sales", {
      identityScope:
        "Continue qualifying inbound customers without sending final replies.",
      runtimeProfile: "Hermes Agent / OysterWorkflow managed profile",
      toolAccess: ["browser control", "mail", "chat", "crm"],
      memoryContext:
        "Use local customer notes and the active installed workflow context.",
      approvalPolicy: "allow_all",
      heartbeatPolicy:
        "If the screen changes unexpectedly, re-check visible evidence and report the recovery step.",
      hermesAgentReference: "hermes-profile:ow-sales-sales-ai-worker",
    });
    const started = await runSeedSalesWorkflow(store);
    expect(started.run.hermesSessionId).toBe("20260627063127aa");

    await store.sendCommand("sales", "continue process inbound customer email");
    await waitForFileIncludes(promptLogPath, "--resume");

    const promptLog = await readFile(promptLogPath, "utf8");
    expect(promptLog).toContain("--resume");
    expect(promptLog).toContain("20260627063127aa");
    expect(promptLog).toMatch(/--max-turns\n100\n/);
    expect(promptLog).not.toContain("--toolsets");
    expect(promptLog).toContain("continue process inbound customer email");
    expect(promptLog).toContain(
      "Continue qualifying inbound customers without sending final replies.",
    );
    expect(promptLog).toContain(
      "Use local customer notes and the active installed workflow context.",
    );
    expect(promptLog).toContain(
      "If the screen changes unexpectedly, re-check visible evidence and report the recovery step.",
    );
    expect(promptLog).toContain(
      "BrowserAct through the OysterWorkflow browser wrapper, mail, chat, crm",
    );
    expect(promptLog).toContain("Approval policy: allow_all");
    expect(promptLog).toContain(
      "Use only evidence from this current run and current app/browser/tool state.",
    );
    expect(promptLog).toContain(
      "Do not rewrite, self-improve, or create skills during workflow execution",
    );
    expect(promptLog).toContain(
      "Avoid noisy repeated full-screen `computer_use` captures.",
    );
    expect(promptLog).toContain(
      "Connected app capability priority: when an MCP/API/composite provider can safely read or mutate the target app data",
    );
    expect(promptLog).toContain(
      "Use Composio hosted MCP, native MCP tools, or direct app APIs for supported apps",
    );
    expect(promptLog).toContain(
      "start with the OysterWorkflow BrowserAct wrapper at `$OYSTER_BROWSER_CLI`",
    );
    expect(promptLog).toContain(
      "Browser automation priority after direct app capabilities: use `$OYSTER_BROWSER_CLI` first, then Hermes built-in browser automation, then `computer_use`, then AppleScript/`osascript`/System Events only as the last fallback.",
    );
    expect(promptLog).toContain(
      "Native desktop app priority after direct app capabilities: use `computer_use` first, then AppleScript/`osascript`/System Events only as the last fallback.",
    );
    expect(promptLog).toContain(
      "Before every `computer_use` action, verify the foreground app/window is the intended target.",
    );
    expect(promptLog).toContain(
      "Avoid temporary browser sessions for login-dependent browser work unless `$OYSTER_BROWSER_CLI` and the current local Chrome state cannot be used",
    );
    expect(promptLog).toContain(
      "OysterWorkflow injects `OYSTER_WORKFLOW_RUN_ID`",
    );
    expect(promptLog).toContain("User-facing response policy:");
    expect(promptLog).toContain("do not mention Hermes, BrowserAct");
    expect(promptLog).toContain("Never include raw stdout or stderr");
    expect(promptLog).not.toContain("Provider:");
    expect(promptLog).not.toContain("Model:");
  });

  it("records Hermes stdout as AI worker response without action-log conversion", async () => {
    const hermesPath = join(tempRoot, "fake-hermes-external-action");
    const profileRoot = join(tempRoot, "profiles");
    const chatCountPath = join(tempRoot, "hermes-external-action-count");
    await writeFile(
      hermesPath,
      `#!/bin/sh
if [ "$1" = "-p" ] && [ "$3" = "profile" ] && [ "$4" = "show" ]; then
  if [ -d "${profileRoot}/$2" ]; then
    echo "Profile: $2"
    echo "Path: ${profileRoot}/$2"
    exit 0
  fi
  echo "Profile not found" >&2
  exit 1
fi
if [ "$1" = "profile" ] && [ "$2" = "create" ]; then
  mkdir -p "${profileRoot}/$3/skills"
  echo "Created profile $3"
  exit 0
fi
${hermesSessionExportBranch({
  "20260627065000aa": [
    "Worker ready for command",
    'OYSTERWORKFLOW_SESSION_STATUS {"status":"running","message":"Worker ready for follow-up command","user_action":null}',
  ].join("\n"),
  "20260627065000bb":
    "I saved the Outlook draft and left it unsent for review.",
})}
if [ "$1" = "-p" ] && [ "$3" = "chat" ]; then
  count=0
  if [ -f "${chatCountPath}" ]; then
    count="$(cat "${chatCountPath}")"
  fi
  next_count=$((count + 1))
  echo "$next_count" > "${chatCountPath}"
	      if [ "$count" = "0" ]; then
			  echo "Session: 20260627065000aa"
			  echo "Worker ready for command"
			  echo 'OYSTERWORKFLOW_SESSION_STATUS {"status":"running","message":"Worker ready for follow-up command","user_action":null}'
			  exit 0
			fi
	echo "Session: 20260627065000bb"
	echo "I saved the Outlook draft and left it unsent for review."
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
    process.env.OYSTERWORKFLOW_HERMES_PROFILES_ROOT = profileRoot;
    vi.resetModules();

    const { createProductStore } = await import("../src/product/store.js");
    const runtimeConfig = createRuntimeConfig(tempRoot);
    const store = createProductStore({ runtimeConfig });

    const started = await runSeedSalesWorkflow(store);
    expect(started.run.hermesSessionId).toBe("20260627065000aa");

    const command = await store.sendCommand(
      "sales",
      "continue process inbound customer email",
    );

    expect(command.state.runEvents).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: started.run.id,
          source: "executor",
          status: "External action logged",
        }),
      ]),
    );
    await waitForState(async () => {
      const state = await store.getState();
      const hermesResponse = state.runEvents.find(
        (event) =>
          event.runId === started.run.id &&
          event.status === "AI worker response",
      );
      return Boolean(
        hermesResponse?.body.includes(
          "I saved the Outlook draft and left it unsent for review.",
        ),
      );
    });

    const finalState = await store.getState();
    const pausedRun = finalState.runs.find((run) => run.id === started.run.id);
    const salesWorker = finalState.workers.find(
      (worker) => worker.id === "sales",
    );
    expect(pausedRun).toMatchObject({
      status: "paused",
      errorMessage: null,
    });
    expect(pausedRun?.endedAt).toEqual(expect.any(String));
    expect(salesWorker).toMatchObject({
      status: "No active task",
      tone: "idle",
      heartbeat: "No active task",
    });
  });

  it("keeps Hermes stdout diagnostics out of Agent messages while preserving exported assistant text", async () => {
    const hermesPath = join(tempRoot, "fake-hermes-message-export");
    const profileRoot = join(tempRoot, "profiles");
    const sessionId = "20260708010101aa";
    const longAssistantMessage = [
      "Summary so far:",
      "The Outlook draft is prepared and left unsent for review.",
      `Qualification notes: ${"Harbor operations context ".repeat(90)}`,
      "Next step: review the draft before sending.",
    ].join("\n");
    await writeFile(
      hermesPath,
      `#!/bin/sh
if [ "$1" = "-p" ] && [ "$3" = "profile" ] && [ "$4" = "show" ]; then
  if [ -d "${profileRoot}/$2" ]; then
    echo "Profile: $2"
    echo "Path: ${profileRoot}/$2"
    exit 0
  fi
  echo "Profile not found" >&2
  exit 1
fi
if [ "$1" = "profile" ] && [ "$2" = "create" ]; then
  mkdir -p "${profileRoot}/$3/skills" "${profileRoot}/$3/logs"
  echo "Created profile $3"
  exit 0
fi
${hermesSessionExportBranch({
  [sessionId]: longAssistantMessage,
})}
if [ "$1" = "-p" ] && [ "$3" = "chat" ]; then
  mkdir -p "${profileRoot}/$2/logs"
  echo "Session: ${sessionId}"
  echo "OYSTERWORKFLOW_WORKER_READY"
  echo "┊ review diff"
  echo "--- /tmp/outlook_message.applescript"
  echo "+++ /tmp/outlook_message.applescript"
  echo "2026-07-08 15:54:01,000 INFO [${sessionId}] agent.runner: Turn ended: reason=max_iterations_reached(100/100)" >> "${profileRoot}/$2/logs/agent.log"
  exit 0
fi
echo "unknown fake-hermes command: $*" >&2
exit 1
`,
      "utf8",
    );
    await chmod(hermesPath, 0o755);
    process.env.OYSTERWORKFLOW_HERMES_COMMAND = hermesPath;
    process.env.OYSTERWORKFLOW_HERMES_PROFILES_ROOT = profileRoot;
    vi.resetModules();

    const { createProductStore } = await import("../src/product/store.js");
    const store = createProductStore({
      runtimeConfig: createRuntimeConfig(tempRoot),
    });

    const started = await runSeedSalesWorkflow(store);

    await waitForState(async () => {
      const state = await store.getState();
      const run = state.runs.find((item) => item.id === started.run.id);
      return run?.status === "paused";
    });

    const state = await store.getState();
    const runEvents = state.runEvents.filter(
      (event) => event.runId === started.run.id,
    );
    const finalMessage = runEvents.find(
      (event) => event.status === "AI worker response",
    );

    expect(finalMessage?.body).toContain(
      "AI worker stopped after reaching the maximum tool iterations (100/100).",
    );
    expect(finalMessage?.body).toContain(
      "The Outlook draft is prepared and left unsent for review.",
    );
    expect(finalMessage?.body).toContain("Harbor operations context");
    expect(finalMessage?.body).toContain(
      "Next step: review the draft before sending.",
    );
    expect(finalMessage?.body.length).toBeGreaterThan(1600);
    expect(finalMessage?.body.endsWith("...")).toBe(false);
    expect(runEvents.some((event) => event.status === "AI worker output")).toBe(
      false,
    );
    expect(runEvents.some((event) => event.body.includes("review diff"))).toBe(
      false,
    );
    expect(
      runEvents.some((event) =>
        event.body.includes("/tmp/outlook_message.applescript"),
      ),
    ).toBe(false);
  });

  it("deduplicates the same Hermes message when ready and completion return it", async () => {
    const hermesPath = join(tempRoot, "fake-hermes-duplicate-message");
    const profileRoot = join(tempRoot, "profiles");
    const sessionId = "20260708020202aa";
    const assistantMessage = [
      "Ready once",
      'OYSTERWORKFLOW_SESSION_STATUS {"status":"running","message":"Ready once","user_action":null}',
    ].join("\n");
    await writeFile(
      hermesPath,
      `#!/bin/sh
if [ "$1" = "-p" ] && [ "$3" = "profile" ] && [ "$4" = "show" ]; then
  if [ -d "${profileRoot}/$2" ]; then
    echo "Profile: $2"
    echo "Path: ${profileRoot}/$2"
    exit 0
  fi
  echo "Profile not found" >&2
  exit 1
fi
if [ "$1" = "profile" ] && [ "$2" = "create" ]; then
  mkdir -p "${profileRoot}/$3/skills" "${profileRoot}/$3/logs"
  echo "Created profile $3"
  exit 0
fi
${hermesSessionExportBranch({
  [sessionId]: assistantMessage,
})}
if [ "$1" = "-p" ] && [ "$3" = "chat" ]; then
  echo "Session: ${sessionId}"
  echo "Ready once"
  echo 'OYSTERWORKFLOW_SESSION_STATUS {"status":"running","message":"Ready once","user_action":null}'
  exit 0
fi
echo "unknown fake-hermes command: $*" >&2
exit 1
`,
      "utf8",
    );
    await chmod(hermesPath, 0o755);
    process.env.OYSTERWORKFLOW_HERMES_COMMAND = hermesPath;
    process.env.OYSTERWORKFLOW_HERMES_PROFILES_ROOT = profileRoot;
    vi.resetModules();

    const { createProductStore } = await import("../src/product/store.js");
    const store = createProductStore({
      runtimeConfig: createRuntimeConfig(tempRoot),
    });

    const started = await runSeedSalesWorkflow(store);

    await waitForState(async () => {
      const state = await store.getState();
      return state.runEvents.some(
        (event) =>
          event.runId === started.run.id &&
          event.status === "AI worker response" &&
          event.body === "Ready once",
      );
    });

    const state = await store.getState();
    const matchingEvents = state.runEvents.filter(
      (event) =>
        event.runId === started.run.id &&
        event.source === "hermes" &&
        event.body === "Ready once",
    );

    expect(matchingEvents).toHaveLength(1);
    expect(matchingEvents[0]?.status).toBe("AI worker response");

    await store.stopWorker("sales");
  });

  it("uses Hermes structured session status without inferring from prose", async () => {
    const hermesPath = join(tempRoot, "fake-hermes-session-status");
    const profileRoot = join(tempRoot, "profiles");
    const chatCountPath = join(tempRoot, "chat-count-session-status");
    await writeFile(
      hermesPath,
      `#!/bin/sh
if [ "$1" = "-p" ] && [ "$3" = "profile" ] && [ "$4" = "show" ]; then
  if [ -d "${profileRoot}/$2" ]; then
    echo "Profile: $2"
    echo "Path: ${profileRoot}/$2"
    exit 0
  fi
  echo "Profile not found" >&2
  exit 1
fi
if [ "$1" = "profile" ] && [ "$2" = "create" ]; then
  mkdir -p "${profileRoot}/$3/skills"
  echo "Created profile $3"
  exit 0
fi
${hermesSessionExportBranch({
  "20260627065500aa": [
    "I reached the Outlook sign-in screen.",
    'OYSTERWORKFLOW_SESSION_STATUS {"status":"waiting_for_user","message":"Needs mailbox login","user_action":"Sign in to Outlook"}',
  ].join("\n"),
})}
if [ "$1" = "-p" ] && [ "$3" = "chat" ]; then
  count=0
  if [ -f "${chatCountPath}" ]; then
    count="$(cat "${chatCountPath}")"
  fi
  next_count=$((count + 1))
  echo "$next_count" > "${chatCountPath}"
	  if [ "$count" = "0" ]; then
	    echo "Session: 20260627065500aa"
	    echo "Worker ready for command"
	    echo 'OYSTERWORKFLOW_SESSION_STATUS {"status":"running","message":"Worker ready for follow-up command","user_action":null}'
	    exit 0
	  fi
	  echo "Session: 20260627065500aa"
	  if [ "$count" = "1" ]; then
	    echo "I reached the Outlook sign-in screen."
	    echo 'OYSTERWORKFLOW_SESSION_STATUS {"status":"waiting_for_user","message":"Needs mailbox login","user_action":"Sign in to Outlook"}'
	    exit 0
	  fi
	  echo "The mailbox account is unavailable for this workflow."
	  echo 'OYSTERWORKFLOW_SESSION_STATUS {"status":"blocked","message":"Mailbox access unavailable","user_action":"Reconnect the mailbox account"}'
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
    process.env.OYSTERWORKFLOW_HERMES_PROFILES_ROOT = profileRoot;
    vi.resetModules();

    const { createProductStore } = await import("../src/product/store.js");
    const runtimeConfig = createRuntimeConfig(tempRoot);
    const store = createProductStore({ runtimeConfig });

    const started = await runSeedSalesWorkflow(store);
    await store.sendCommand("sales", "continue process inbound customer email");

    await waitForState(async () => {
      const state = await store.getState();
      const run = state.runs.find((item) => item.id === started.run.id);
      return run?.status === "waiting_for_user";
    });

    const state = await store.getState();
    const run = state.runs.find((item) => item.id === started.run.id);
    const statusEvent = state.runEvents.find(
      (event) =>
        event.runId === started.run.id && event.status === "Waiting for user",
    );
    expect(run).toMatchObject({
      status: "waiting_for_user",
      errorMessage: null,
      endedAt: null,
    });
    expect(statusEvent?.body).toContain(
      "I reached the Outlook sign-in screen.",
    );
    expect(statusEvent?.body).not.toContain("OYSTERWORKFLOW_SESSION_STATUS");
    expect(state.workers.find((worker) => worker.id === "sales")).toMatchObject(
      {
        status: "Waiting for user",
        tone: "warning",
        heartbeat: "Waiting for user",
      },
    );

    await store.sendCommand("sales", "try the mailbox again");
    await waitForState(async () => {
      const blockedState = await store.getState();
      const blockedRun = blockedState.runs.find(
        (item) => item.id === started.run.id,
      );
      return blockedRun?.status === "blocked";
    });

    const blockedState = await store.getState();
    const blockedRun = blockedState.runs.find(
      (item) => item.id === started.run.id,
    );
    const blockedEvent = blockedState.runEvents.find(
      (event) => event.runId === started.run.id && event.status === "Blocked",
    );
    expect(blockedRun).toMatchObject({
      status: "blocked",
      errorMessage: null,
      endedAt: null,
    });
    expect(blockedEvent?.body).not.toContain("OYSTERWORKFLOW_SESSION_STATUS");
    expect(
      blockedState.workers.find((worker) => worker.id === "sales"),
    ).toMatchObject({
      status: "Blocked",
      tone: "danger",
      heartbeat: "Blocked",
    });
  });

  it("rejects running another workflow while the worker already has a running run", async () => {
    const hermesPath = join(tempRoot, "fake-hermes");
    const profileRoot = join(tempRoot, "profiles");
    await writeFile(
      hermesPath,
      `#!/bin/sh
if [ "$1" = "-p" ] && [ "$3" = "profile" ] && [ "$4" = "show" ]; then
  if [ -d "${profileRoot}/$2" ]; then
    echo "Profile: $2"
    echo "Path: ${profileRoot}/$2"
    exit 0
  fi
  echo "Profile not found" >&2
  exit 1
fi
if [ "$1" = "profile" ] && [ "$2" = "create" ]; then
  mkdir -p "${profileRoot}/$3/skills"
  echo "Created profile $3"
  exit 0
fi
if [ "$1" = "chat" ] || { [ "$1" = "-p" ] && [ "$3" = "chat" ]; }; then
  echo "Session: 20260624115500abcd"
  echo "OYSTERWORKFLOW_WORKER_READY"
  exit 0
fi
if [ "$1" = "status" ]; then
  echo "Model: fake-hermes"
  echo "Provider: local-test"
  exit 0
fi
echo "unknown fake-hermes command" >&2
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
    process.env.OYSTERWORKFLOW_HERMES_PROFILES_ROOT = profileRoot;
    vi.resetModules();

    const { createProductStore } = await import("../src/product/store.js");
    const store = createProductStore({
      runtimeConfig: createRuntimeConfig(tempRoot),
    });

    const firstStart = await runSeedSalesWorkflow(store);
    expect(firstStart.run).toMatchObject({
      workerId: "sales",
      status: "running",
      hermesSessionId: "20260624115500abcd",
    });

    await expect(runSeedSalesWorkflow(store)).rejects.toThrow(
      "This worker is already running a workflow.",
    );
    const after = await store.getState();
    expect(
      after.runs.filter(
        (run) =>
          run.workerId === "sales" &&
          (run.status === "queued" || run.status === "running"),
      ),
    ).toHaveLength(1);
  });

  it("starts the workflow that was most recently deployed to the worker", async () => {
    const hermesPath = join(tempRoot, "fake-hermes-selected-deploy");
    const profileRoot = join(tempRoot, "profiles");
    const promptLogPath = join(tempRoot, "hermes-selected-deploy-argv.log");
    await writeFile(
      hermesPath,
      `#!/bin/sh
printf '%s\\n' "$@" >> "${promptLogPath}"
if [ "$1" = "-p" ] && [ "$3" = "profile" ] && [ "$4" = "show" ]; then
  if [ -d "${profileRoot}/$2" ]; then
    echo "Profile: $2"
    echo "Path: ${profileRoot}/$2"
    exit 0
  fi
  echo "Profile not found" >&2
  exit 1
fi
if [ "$1" = "profile" ] && [ "$2" = "create" ]; then
  mkdir -p "${profileRoot}/$3/skills"
  echo "Created profile $3"
  exit 0
fi
if [ "$1" = "chat" ] || { [ "$1" = "-p" ] && [ "$3" = "chat" ]; }; then
  echo "Session: 20260630101500abcd"
  echo "OYSTERWORKFLOW_WORKER_READY"
  exit 0
fi
if [ "$1" = "status" ]; then
  echo "Model: fake-hermes"
  echo "Provider: local-test"
  exit 0
fi
echo "unknown fake-hermes command" >&2
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
    process.env.OYSTERWORKFLOW_HERMES_PROFILES_ROOT = profileRoot;
    vi.resetModules();

    const { createProductStore } = await import("../src/product/store.js");
    const store = createProductStore({
      runtimeConfig: createRuntimeConfig(tempRoot),
    });

    const deployed = await store.installWorkflow({
      workerId: "sales",
      workflowId: "workflow-unanswered-questions",
      workflowTitle: "Track unanswered customer questions",
      description:
        "The existing workflow Alex just redeployed from the workflow page.",
      apps: ["Microsoft Outlook", "Slack"],
    });

    const started = await store.runInstalledWorkflow(
      deployed.installedWorkflow.id,
    );

    expect(started.run).toMatchObject({
      workerId: "sales",
      installedWorkflowId: deployed.installedWorkflow.id,
      workflowTitle: "Track unanswered customer questions",
    });
    await expect(readFile(promptLogPath, "utf8")).resolves.toContain(
      "oysterworkflow-track-unanswered-customer-questions",
    );
    await waitForState(async () => {
      const state = await store.getState();
      return (
        state.runs.find((run) => run.id === started.run.id)?.status !==
        "running"
      );
    });
  });

  it("runs an installed workflow even when recorder permissions are incomplete", async () => {
    const hermesPath = join(tempRoot, "fake-hermes-recorder-permissions");
    const profileRoot = join(tempRoot, "profiles");
    await writeFile(
      hermesPath,
      `#!/bin/sh
if [ "$1" = "-p" ] && [ "$3" = "profile" ] && [ "$4" = "show" ]; then
  if [ -d "${profileRoot}/$2" ]; then
    echo "Profile: $2"
    echo "Path: ${profileRoot}/$2"
    exit 0
  fi
  echo "Profile not found" >&2
  exit 1
fi
if [ "$1" = "profile" ] && [ "$2" = "create" ]; then
  mkdir -p "${profileRoot}/$3/skills"
  echo "Created profile $3"
  exit 0
fi
if [ "$1" = "chat" ] || { [ "$1" = "-p" ] && [ "$3" = "chat" ]; }; then
  echo "Session: 20260626214500ab"
  echo "OYSTERWORKFLOW_WORKER_READY"
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
    process.env.OYSTERWORKFLOW_HERMES_PROFILES_ROOT = profileRoot;
    vi.resetModules();

    const { createProductStore } = await import("../src/product/store.js");
    const store = createProductStore({
      runtimeConfig: createRuntimeConfig(tempRoot),
    });
    await store.recordPermissionSnapshot({
      checkedAt: "2026-06-26T21:45:00.000Z",
      allGranted: false,
      canStartRecording: false,
      source: "screenpipe-probe",
      summary: "Screen Recording is missing.",
      items: [
        {
          kind: "screen-recording",
          label: "Screen Recording",
          description: "Required for training captures.",
          state: "missing",
          detail: "Enable Screen Recording before recording a training run.",
        },
      ],
    });

    const started = await runSeedSalesWorkflow(store);

    expect(started.run).toMatchObject({
      workerId: "sales",
      status: "running",
      hermesSessionId: "20260626214500ab",
    });
    expect(started.state.permissionSnapshot).toMatchObject({
      canStartRecording: false,
      source: "screenpipe-probe",
    });
  });

  it("starts Hermes in the background and stops the running process", async () => {
    const hermesPath = join(tempRoot, "fake-hermes-background");
    const profileRoot = join(tempRoot, "profiles");
    const startedMarker = join(tempRoot, "background-started");
    const pidPath = join(tempRoot, "background.pid");
    await writeFile(
      hermesPath,
      `#!/bin/sh
if [ "$1" = "-p" ] && [ "$3" = "profile" ] && [ "$4" = "show" ]; then
  if [ -d "${profileRoot}/$2" ]; then
    echo "Profile: $2"
    echo "Path: ${profileRoot}/$2"
    exit 0
  fi
  echo "Profile not found" >&2
  exit 1
fi
if [ "$1" = "profile" ] && [ "$2" = "create" ]; then
  mkdir -p "${profileRoot}/$3/skills"
  echo "Created profile $3"
  exit 0
fi
if [ "$1" = "chat" ] || { [ "$1" = "-p" ] && [ "$3" = "chat" ]; }; then
  echo "$$" > "${pidPath}"
  echo "Session: 20260626191500ab"
  echo "OYSTERWORKFLOW_WORKER_READY"
  touch "${startedMarker}"
  trap 'exit 143' TERM INT
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
    process.env.OYSTERWORKFLOW_HERMES_COMMAND = hermesPath;
    process.env.OYSTERWORKFLOW_HERMES_PROFILES_ROOT = profileRoot;
    vi.resetModules();

    const { createProductStore } = await import("../src/product/store.js");
    const store = createProductStore({
      runtimeConfig: createRuntimeConfig(tempRoot),
    });

    const startedAt = Date.now();
    const started = await runSeedSalesWorkflow(store);
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(1_500);
    expect(started.run).toMatchObject({
      workerId: "sales",
      status: "running",
      hermesSessionId: "20260626191500ab",
    });
    await expect(waitForPath(startedMarker)).resolves.toBeUndefined();
    const hermesPid = Number((await readFile(pidPath, "utf8")).trim());
    expect(hermesPid).toBeGreaterThan(0);

    const stopped = await store.stopWorker("sales");
    await expect(waitForProcessExit(hermesPid)).resolves.toBeUndefined();
    expect(stopped.runs.find((run) => run.id === started.run.id)).toMatchObject(
      {
        status: "paused",
        endedAt: expect.any(String),
      },
    );
  }, 10_000);

  it("records delayed AI worker readiness after Run has returned", async () => {
    const hermesPath = join(tempRoot, "fake-hermes-delayed-ready");
    const profileRoot = join(tempRoot, "profiles");
    await writeFile(
      hermesPath,
      `#!/bin/sh
if [ "$1" = "-p" ] && [ "$3" = "profile" ] && [ "$4" = "show" ]; then
  if [ -d "${profileRoot}/$2" ]; then
    echo "Profile: $2"
    echo "Path: ${profileRoot}/$2"
    exit 0
  fi
  echo "Profile not found" >&2
  exit 1
fi
if [ "$1" = "profile" ] && [ "$2" = "create" ]; then
  mkdir -p "${profileRoot}/$3/skills"
  echo "Created profile $3"
  exit 0
fi
if [ "$1" = "chat" ] || { [ "$1" = "-p" ] && [ "$3" = "chat" ]; }; then
  sleep 1
  printf '%s\\n%s\\n%s\\n' "Session: 20260627033500ab" "I found the installed workflow and I am checking the screen next." "OYSTERWORKFLOW_WORKER_READY"
  trap 'exit 143' TERM INT
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
    process.env.OYSTERWORKFLOW_HERMES_COMMAND = hermesPath;
    process.env.OYSTERWORKFLOW_HERMES_PROFILES_ROOT = profileRoot;
    vi.resetModules();

    const { createProductStore } = await import("../src/product/store.js");
    const store = createProductStore({
      runtimeConfig: createRuntimeConfig(tempRoot),
    });

    const started = await runSeedSalesWorkflow(store);
    expect(started.run).toMatchObject({
      workerId: "sales",
      status: "running",
      hermesSessionId: null,
    });

    await expect(
      store.sendCommand("sales", "continue process inbound customer email"),
    ).rejects.toThrow(
      "AI worker is still initializing. Wait for the Agent panel ready message before sending commands.",
    );

    await waitForState(async () => {
      const state = await store.getState();
      const run = state.runs.find((item) => item.id === started.run.id);
      return (
        run?.hermesSessionId === "20260627033500ab" &&
        state.runEvents.some(
          (event) =>
            event.runId === started.run.id &&
            event.source === "hermes" &&
            event.status === "AI worker started" &&
            event.body.includes("ready for the next workflow command"),
        )
      );
    });

    const ready = await store.getState();
    expect(
      ready.runEvents.some(
        (event) =>
          event.runId === started.run.id &&
          event.body.includes("checking the screen next"),
      ),
    ).toBe(false);
    const readyWorker = ready.workers.find((worker) => worker.id === "sales");
    expect(readyWorker).toMatchObject({
      status: "Working",
      heartbeat: "AI worker working",
    });
    await store.stopWorker("sales");
  }, 10_000);

  it("keeps Hermes computer-use progress out of Agent run events", async () => {
    const hermesPath = join(tempRoot, "fake-hermes-progress-log");
    const profileRoot = join(tempRoot, "profiles");
    const resultPath = join(tempRoot, "blank-page-result.json");
    await writeFile(
      hermesPath,
      `#!/bin/sh
if [ "$1" = "-p" ] && [ "$3" = "profile" ] && [ "$4" = "show" ]; then
  if [ -d "${profileRoot}/$2" ]; then
    echo "Profile: $2"
    echo "Path: ${profileRoot}/$2"
    exit 0
  fi
  echo "Profile not found" >&2
  exit 1
fi
if [ "$1" = "profile" ] && [ "$2" = "create" ]; then
  mkdir -p "${profileRoot}/$3/skills" "${profileRoot}/$3/logs"
  echo "Created profile $3"
  exit 0
fi
if [ "$1" = "chat" ] || { [ "$1" = "-p" ] && [ "$3" = "chat" ]; }; then
  profile="$2"
  mkdir -p "${profileRoot}/$profile/logs"
  cat > "${resultPath}" <<'JSON'
{"tool_result":"computer_use result stored by Hermes for the worker run."}
JSON
  echo "Session: 20260627065000cc"
  echo "OYSTERWORKFLOW_WORKER_READY"
  {
    echo "2026-07-05 12:24:32,493 INFO [20260627065000cc] agent.tool_executor: tool computer_use completed (1.00s, 73 chars)"
    echo "2026-07-05 12:24:54,393 INFO [20260627065000cc] tools.vision_tools: Image analysis completed (471 characters)"
    echo "2026-07-05 12:25:28,990 INFO [20260627065000cc] tools.tool_result_storage: Persisted large tool result: computer_use (call_test, 115855 chars -> ${resultPath})"
  } >> "${profileRoot}/$profile/logs/agent.log"
  trap 'exit 143' TERM INT
  sleep 3 &
  wait $!
  exit 0
fi
echo "unknown fake-hermes command: $*" >&2
exit 1
`,
      "utf8",
    );
    await chmod(hermesPath, 0o755);
    process.env.OYSTERWORKFLOW_HERMES_COMMAND = hermesPath;
    process.env.OYSTERWORKFLOW_HERMES_PROFILES_ROOT = profileRoot;
    vi.resetModules();

    const { createProductStore } = await import("../src/product/store.js");
    const store = createProductStore({
      runtimeConfig: createRuntimeConfig(tempRoot),
    });

    const started = await runSeedSalesWorkflow(store);

    await waitForState(async () => {
      const state = await store.getState();
      const run = state.runs.find((item) => item.id === started.run.id);
      return run?.hermesSessionId === "20260627065000cc";
    });
    await new Promise((resolve) => setTimeout(resolve, 1200));

    const state = await store.getState();
    expect(
      state.runEvents.some(
        (event) =>
          event.runId === started.run.id &&
          (event.status === "Desktop action completed" ||
            event.status === "Screen analyzed" ||
            event.status === "Evidence captured"),
      ),
    ).toBe(false);

    await store.stopWorker("sales");
  }, 10_000);

  it("records Hermes provider health protocol events from worker output", async () => {
    const hermesPath = join(tempRoot, "fake-hermes-provider-health");
    const profileRoot = join(tempRoot, "profiles");
    const sessionId = "20260707030300aa";
    await writeFile(
      hermesPath,
      `#!/bin/sh
if [ "$1" = "-p" ] && [ "$3" = "profile" ] && [ "$4" = "show" ]; then
  if [ -d "${profileRoot}/$2" ]; then
    echo "Profile: $2"
    echo "Path: ${profileRoot}/$2"
    exit 0
  fi
  echo "Profile not found" >&2
  exit 1
fi
if [ "$1" = "profile" ] && [ "$2" = "create" ]; then
  mkdir -p "${profileRoot}/$3/skills"
  echo "Created profile $3"
  exit 0
fi
${hermesSessionExportBranch({
  [sessionId]:
    'Workflow completed after retry.\\nOYSTERWORKFLOW_SESSION_STATUS {"status":"succeeded","message":"Workflow completed","user_action":null}',
})}
if [ "$1" = "-p" ] && [ "$3" = "chat" ]; then
  echo "Session: ${sessionId}"
  echo "OYSTERWORKFLOW_WORKER_READY"
  printf '%s' 'OYSTERWORKFLOW_PROVIDER_STATUS {"status":"degraded","kind":"llm_timeout","recoverability":"retryable",' >&2
  printf '%s\\n' '"provider":"test-provider","model":"gpt-test","message":"Provider timed out while answering the worker.","retryable":true,"retryCount":1,"maxRetries":3,"checkedAt":"2026-07-07T10:00:00.000Z"}' >&2
  echo "Workflow completed after retry."
  echo 'OYSTERWORKFLOW_SESSION_STATUS {"status":"succeeded","message":"Workflow completed","user_action":null}'
  exit 0
fi
echo "unknown fake-hermes command: $*" >&2
exit 1
`,
      "utf8",
    );
    await chmod(hermesPath, 0o755);
    process.env.OYSTERWORKFLOW_HERMES_COMMAND = hermesPath;
    process.env.OYSTERWORKFLOW_HERMES_PROFILES_ROOT = profileRoot;
    vi.resetModules();

    const { createProductStore } = await import("../src/product/store.js");
    const store = createProductStore({
      runtimeConfig: createRuntimeConfig(tempRoot),
    });

    const started = await runSeedSalesWorkflow(store);

    await waitForState(async () => {
      const state = await store.getState();
      const run = state.runs.find((item) => item.id === started.run.id);
      return (
        run?.status === "succeeded" &&
        (state.hermes as any).providerHealth?.kind === "llm_timeout"
      );
    }, 12_000);

    const state = await store.getState();
    expect((state.hermes as any).providerHealth).toMatchObject({
      status: "degraded",
      kind: "llm_timeout",
      recoverability: "retryable",
      provider: "test-provider",
      model: "gpt-test",
      message: "Provider timed out while answering the worker.",
      retryable: true,
      retryCount: 1,
      maxRetries: 3,
      checkedAt: "2026-07-07T10:00:00.000Z",
    });
    expect(
      state.runEvents.some(
        (event) =>
          event.runId === started.run.id &&
          event.status === "LLM provider degraded",
      ),
    ).toBe(false);
    expect(
      state.runEvents.some((event) =>
        event.body.includes("OYSTERWORKFLOW_PROVIDER_STATUS"),
      ),
    ).toBe(false);
  });

  it("preserves a newly started run when a slow Hermes refresh writes back later", async () => {
    const hermesPath = join(tempRoot, "fake-hermes-refresh-race");
    const profileRoot = join(tempRoot, "profiles");
    const refreshStartedMarker = join(tempRoot, "refresh-started");
    await writeFile(
      hermesPath,
      `#!/bin/sh
if [ "$1" = "-p" ] && [ "$3" = "profile" ] && [ "$4" = "show" ]; then
  if [ -d "${profileRoot}/$2" ]; then
    echo "Profile: $2"
    echo "Path: ${profileRoot}/$2"
    exit 0
  fi
  echo "Profile not found" >&2
  exit 1
fi
if [ "$1" = "profile" ] && [ "$2" = "create" ]; then
  mkdir -p "${profileRoot}/$3/skills"
  echo "Created profile $3"
  exit 0
fi
if [ "$1" = "status" ]; then
  touch "${refreshStartedMarker}"
  sleep 1
  echo "Model: fake-hermes"
  echo "Provider: local-test"
  exit 0
fi
if [ "$1" = "tools" ] && [ "$2" = "list" ]; then
  echo "computer_use terminal file vision skills memory todo"
  exit 0
fi
if [ "$1" = "chat" ] || { [ "$1" = "-p" ] && [ "$3" = "chat" ]; }; then
  echo "Session: 20260627045800ab"
  echo "OYSTERWORKFLOW_AI_WORKER_READY"
  echo "OYSTERWORKFLOW_WORKER_READY"
  exit 0
fi
echo "unknown fake-hermes command: $*" >&2
exit 1
`,
      "utf8",
    );
    await chmod(hermesPath, 0o755);
    process.env.OYSTERWORKFLOW_HERMES_COMMAND = hermesPath;
    process.env.OYSTERWORKFLOW_HERMES_PROFILES_ROOT = profileRoot;
    vi.resetModules();

    const { createProductStore } = await import("../src/product/store.js");
    const store = createProductStore({
      runtimeConfig: createRuntimeConfig(tempRoot),
    });

    const refreshPromise = store.refreshHermes();
    await expect(waitForPath(refreshStartedMarker)).resolves.toBeUndefined();

    const started = await runSeedSalesWorkflow(store);
    await refreshPromise;

    const finalState = await store.getState();
    expect(
      finalState.runs.find((item) => item.id === started.run.id),
    ).toMatchObject({
      workerId: "sales",
      status: "running",
      hermesSessionId: "20260627045800ab",
    });
    await store.stopWorker("sales");
  }, 10_000);

  it("stops an in-flight Hermes command process when the worker is stopped", async () => {
    const hermesPath = join(tempRoot, "fake-hermes-command-background");
    const profileRoot = join(tempRoot, "profiles");
    const commandStartedMarker = join(tempRoot, "command-started");
    const commandStoppedMarker = join(tempRoot, "command-stopped");
    const chatCountPath = join(tempRoot, "chat-count");
    await writeFile(
      hermesPath,
      `#!/bin/sh
if [ "$1" = "-p" ] && [ "$3" = "profile" ] && [ "$4" = "show" ]; then
  if [ -d "${profileRoot}/$2" ]; then
    echo "Profile: $2"
    echo "Path: ${profileRoot}/$2"
    exit 0
  fi
  echo "Profile not found" >&2
  exit 1
fi
if [ "$1" = "profile" ] && [ "$2" = "create" ]; then
  mkdir -p "${profileRoot}/$3/skills"
  echo "Created profile $3"
  exit 0
fi
${hermesSessionExportBranch({
  "20260626221000aa": [
    "Worker ready for command",
    'OYSTERWORKFLOW_SESSION_STATUS {"status":"running","message":"Worker ready for follow-up command","user_action":null}',
  ].join("\n"),
})}
if [ "$1" = "chat" ] || { [ "$1" = "-p" ] && [ "$3" = "chat" ]; }; then
  count=0
  if [ -f "${chatCountPath}" ]; then
    count="$(cat "${chatCountPath}")"
  fi
  next_count=$((count + 1))
  echo "$next_count" > "${chatCountPath}"
	  if [ "$count" = "0" ]; then
	    echo "Session: 20260626221000aa"
	    echo "OYSTERWORKFLOW_WORKER_READY"
	    echo 'OYSTERWORKFLOW_SESSION_STATUS {"status":"running","message":"Worker ready for follow-up command","user_action":null}'
	    exit 0
	  fi
  echo "Session: 20260626221000bb"
  echo "OYSTERWORKFLOW_WORKER_READY"
  touch "${commandStartedMarker}"
  trap 'touch "${commandStoppedMarker}"; exit 143' TERM INT
  sleep 3 &
  wait $!
  exit 0
fi
echo "unknown fake-hermes command: $*" >&2
exit 1
`,
      "utf8",
    );
    await chmod(hermesPath, 0o755);
    process.env.OYSTERWORKFLOW_HERMES_COMMAND = hermesPath;
    process.env.OYSTERWORKFLOW_HERMES_PROFILES_ROOT = profileRoot;
    vi.resetModules();

    const { createProductStore } = await import("../src/product/store.js");
    const store = createProductStore({
      runtimeConfig: createRuntimeConfig(tempRoot),
    });

    const started = await runSeedSalesWorkflow(store);
    expect(started.run).toMatchObject({
      status: "running",
      hermesSessionId: "20260626221000aa",
    });

    const commandPromise = store.sendCommand(
      "sales",
      "continue process inbound customer email",
    );
    await expect(waitForPath(commandStartedMarker)).resolves.toBeUndefined();
    await expect(commandPromise).resolves.toMatchObject({
      commandRecord: { status: "accepted" },
    });

    const stopped = await store.stopWorker("sales");

    await expect(waitForPath(commandStoppedMarker)).resolves.toBeUndefined();
    expect(stopped.runs.find((run) => run.id === started.run.id)).toMatchObject(
      {
        status: "paused",
        endedAt: expect.any(String),
      },
    );
  }, 10_000);

  it("stops every active Hermes process for the same run", async () => {
    const hermesPath = join(tempRoot, "fake-hermes-multiple-processes");
    const profileRoot = join(tempRoot, "profiles");
    const startStartedMarker = join(tempRoot, "start-process-started");
    const startStoppedMarker = join(tempRoot, "start-process-stopped");
    const commandStartedMarker = join(tempRoot, "command-process-started");
    const commandStoppedMarker = join(tempRoot, "command-process-stopped");
    const chatCountPath = join(tempRoot, "multi-chat-count");
    await writeFile(
      hermesPath,
      `#!/bin/sh
if [ "$1" = "-p" ] && [ "$3" = "profile" ] && [ "$4" = "show" ]; then
  if [ -d "${profileRoot}/$2" ]; then
    echo "Profile: $2"
    echo "Path: ${profileRoot}/$2"
    exit 0
  fi
  echo "Profile not found" >&2
  exit 1
fi
if [ "$1" = "profile" ] && [ "$2" = "create" ]; then
  mkdir -p "${profileRoot}/$3/skills"
  echo "Created profile $3"
  exit 0
fi
if [ "$1" = "chat" ] || { [ "$1" = "-p" ] && [ "$3" = "chat" ]; }; then
  count=0
  if [ -f "${chatCountPath}" ]; then
    count="$(cat "${chatCountPath}")"
  fi
  next_count=$((count + 1))
  echo "$next_count" > "${chatCountPath}"
  if [ "$count" = "0" ]; then
    echo "Session: 20260626223000aa"
    echo "OYSTERWORKFLOW_WORKER_READY"
    touch "${startStartedMarker}"
    trap 'touch "${startStoppedMarker}"; exit 143' TERM INT
    sleep 4 &
    wait $!
    exit 0
  fi
  echo "Session: 20260626223000bb"
  echo "OYSTERWORKFLOW_WORKER_READY"
  touch "${commandStartedMarker}"
  trap 'touch "${commandStoppedMarker}"; exit 143' TERM INT
  sleep 4 &
  wait $!
  exit 0
fi
echo "unknown fake-hermes command: $*" >&2
exit 1
`,
      "utf8",
    );
    await chmod(hermesPath, 0o755);
    process.env.OYSTERWORKFLOW_HERMES_COMMAND = hermesPath;
    process.env.OYSTERWORKFLOW_HERMES_PROFILES_ROOT = profileRoot;
    vi.resetModules();

    const { createProductStore } = await import("../src/product/store.js");
    const store = createProductStore({
      runtimeConfig: createRuntimeConfig(tempRoot),
    });

    const started = await runSeedSalesWorkflow(store);
    expect(started.run).toMatchObject({
      status: "running",
      hermesSessionId: "20260626223000aa",
    });
    await expect(waitForPath(startStartedMarker)).resolves.toBeUndefined();

    const commandPromise = store.sendCommand(
      "sales",
      "continue process inbound customer email",
    );
    await expect(waitForPath(commandStartedMarker)).resolves.toBeUndefined();

    const stopped = await store.stopWorker("sales");

    await expect(waitForPath(startStoppedMarker)).resolves.toBeUndefined();
    await expect(waitForPath(commandStoppedMarker)).resolves.toBeUndefined();
    expect(stopped.runs.find((run) => run.id === started.run.id)).toMatchObject(
      {
        status: "paused",
        endedAt: expect.any(String),
      },
    );
    await commandPromise.catch(() => undefined);
  }, 10_000);

  it("records a concise setup failure when Hermes exits without model output", async () => {
    const hermesPath = join(tempRoot, "fake-hermes-failure");
    const profileRoot = join(tempRoot, "profiles");
    await writeFile(
      hermesPath,
      `#!/bin/sh
if [ "$1" = "-p" ] && [ "$3" = "profile" ] && [ "$4" = "show" ]; then
  if [ -d "${profileRoot}/$2" ]; then
    echo "Profile: $2"
    echo "Path: ${profileRoot}/$2"
    exit 0
  fi
  echo "Profile not found" >&2
  exit 1
fi
if [ "$1" = "profile" ] && [ "$2" = "create" ]; then
  mkdir -p "${profileRoot}/$3/skills"
  echo "Created profile $3"
  exit 0
fi
if [ "$1" = "chat" ] || { [ "$1" = "-p" ] && [ "$3" = "chat" ]; }; then
  echo "session_id: 20260625003308f8fbf3" >&2
  exit 1
fi
if [ "$1" = "status" ]; then
  echo "Model: fake-hermes"
  echo "Provider: local-test"
  exit 0
fi
echo "unknown fake-hermes command" >&2
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
    process.env.OYSTERWORKFLOW_HERMES_PROFILES_ROOT = profileRoot;
    vi.resetModules();

    const { createProductStore } = await import("../src/product/store.js");
    const store = createProductStore({
      runtimeConfig: createRuntimeConfig(tempRoot),
    });

    const started = await runSeedSalesWorkflow(store);
    expect(started.run).toMatchObject({
      workerId: "sales",
      status: "failed",
      hermesSessionId: "20260625003308f8fbf3",
    });
    expect(started.run.endedAt).toEqual(expect.any(String));
    expect(started.run.errorMessage).toBe(
      "Hermes exited before returning a model response. Check Hermes provider credentials and run hermes doctor.",
    );

    const setupEvent = started.state.runEvents.find(
      (event) =>
        event.runId === started.run.id && event.status === "AI worker failed",
    );
    expect(setupEvent?.body).toContain(
      "Check the AI worker model connection in Settings.",
    );
    expect(setupEvent?.body).not.toContain("Command failed:");
    expect(setupEvent?.body).not.toContain("--query");
    expect(setupEvent?.body).not.toContain("You are the Hermes Agent");
  });

  it("marks Hermes unavailable when status passes but the readiness chat fails", async () => {
    const hermesPath = join(tempRoot, "fake-hermes-readiness");
    await writeFile(
      hermesPath,
      `#!/bin/sh
if [ "$1" = "status" ]; then
  echo "Model: fake-hermes"
  echo "Provider: local-test"
  exit 0
fi
if [ "$1" = "chat" ]; then
  echo "session_id: 20260625004408674bd1" >&2
  exit 1
fi
echo "unknown fake-hermes command" >&2
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
    vi.resetModules();

    const { createProductStore } = await import("../src/product/store.js");
    const store = createProductStore({
      runtimeConfig: createRuntimeConfig(tempRoot),
    });

    const state = await store.refreshHermes();
    expect(state.hermes).toMatchObject({
      available: false,
      model: "gpt-5.5",
      provider: "codex-local",
      configSource: "OysterWorkflow LLM config",
      lastError:
        "Hermes exited before returning a model response. Check Hermes provider credentials and run hermes doctor.",
    });
  });

  it("maps enabled Hermes desktop tools to computer-use readiness", async () => {
    const hermesPath = join(tempRoot, "fake-hermes-computer-use");
    await writeFile(
      hermesPath,
      `#!/bin/sh
if [ "$1" = "status" ]; then
  echo "Model: fake-hermes"
  echo "Provider: local-test"
  exit 0
fi
if [ "$1" = "chat" ]; then
  echo "OYSTERWORKFLOW_AI_WORKER_READY"
  echo "session_id: computer-use-ready-session" >&2
  exit 0
fi
if [ "$1" = "tools" ] && [ "$2" = "list" ]; then
  echo "Built-in toolsets (cli):"
  echo "  ✓ enabled  computer_use  Computer Use"
  echo "  ✓ enabled  terminal  Terminal & Processes"
  echo "  ✓ enabled  file  File Operations"
  echo "  ✓ enabled  vision  Vision / Image Analysis"
  echo "  ✓ enabled  skills  Skills"
  echo "  ✓ enabled  memory  Memory"
  exit 0
fi
echo "unknown fake-hermes command" >&2
exit 1
`,
      "utf8",
    );
    await chmod(hermesPath, 0o755);
    process.env.OYSTERWORKFLOW_HERMES_COMMAND = hermesPath;
    vi.resetModules();

    const { createProductStore } = await import("../src/product/store.js");
    const store = createProductStore({
      runtimeConfig: createRuntimeConfig(tempRoot),
    });

    const state = await store.refreshHermes();
    expect((state.hermes as any).computerUseReady).toBe(true);
    expect((state.hermes as any).enabledToolsets).toEqual(
      expect.arrayContaining([
        "computer_use",
        "terminal",
        "file",
        "vision",
        "skills",
        "memory",
      ]),
    );
    expect((state.hermes as any).missingComputerUseToolsets).toEqual([]);
    expect((state.hermes as any).computerUseSummary).toBe(
      "Computer control is ready",
    );
  });
});

function createRuntimeConfig(root: string): RuntimeConfig {
  const hermesRuntimeRoot = join(root, "hermes-runtime");
  return {
    mode: "test",
    productSeedMode: "demo",
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

async function runSeedSalesWorkflow(store: {
  runInstalledWorkflow: (installedWorkflowId: string) => Promise<{
    state: {
      permissionSnapshot: unknown;
      runEvents: Array<{
        body: string;
        runId: string;
        source: string;
        status: string;
      }>;
    };
    run: {
      endedAt: string | null;
      errorMessage: string | null;
      hermesSessionId: string | null;
      id: string;
      installedWorkflowId: string;
      status: string;
      workerId: string;
      workflowTitle: string;
    };
  }>;
}) {
  return store.runInstalledWorkflow("installed-meeting-actions");
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

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

function hermesSessionExportBranch(
  messagesBySessionId: Record<string, string>,
): string {
  const cases = Object.entries(messagesBySessionId)
    .map(([sessionId, content]) => {
      const payload = JSON.stringify({
        id: sessionId,
        source: "oysterworkflow-worker",
        messages: [
          {
            id: 1,
            session_id: sessionId,
            role: "assistant",
            content,
            timestamp: 1,
            active: 1,
          },
        ],
      });
      return `    "${sessionId}")
      cat <<'JSON'
${payload}
JSON
      exit 0
      ;;`;
    })
    .join("\n");
  return `if [ "$1" = "-p" ] && [ "$3" = "sessions" ] && [ "$4" = "export" ]; then
  if [ "$5" != "-" ] || [ "$6" != "--session-id" ]; then
    echo "unexpected sessions export args: $*" >&2
    exit 1
  fi
  case "$7" in
${cases}
  esac
  echo "Session '$7' not found." >&2
  exit 1
fi`;
}

async function waitForFileIncludes(
  path: string,
  expected: string,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 2_000) {
    try {
      const content = await readFile(path, "utf8");
      if (content.includes(expected)) {
        return;
      }
    } catch {
      // Keep polling until the file is created.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${path} to include ${expected}`);
}

async function waitForState(
  predicate: () => Promise<boolean>,
  timeoutMs = 3_000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for product state");
}

async function waitForProcessExit(pid: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 3_000) {
    if (!isProcessAlive(pid)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for process ${pid} to exit`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
