import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Episode,
  GeneralizedSkillVariantSummary,
  IngestSummary,
  OpenClawSkill,
  SkillExtractionSummary,
  WorkflowCandidate,
} from "../src/types/contracts.js";
import { loadCodexEnv } from "../src/lab-api/env.js";
import type {
  LabProcessExitResult,
  LabProcessHandle,
} from "../src/lab-api/contracts.js";
import {
  LAB_LLM_CALL_PROFILE_KEYS,
  type LabLlmCallProfileKey,
  type LabLlmCallProfileUpdateInput,
} from "../src/lab-api/api-contracts.js";
import { createLabService } from "../src/lab-api/service.js";
import { resolveRuntimeConfig } from "../src/runtime/config.js";
import {
  createSession,
  ensureSessionDirectories,
  writeSession,
} from "../src/lab-api/session-store.js";
import { materializeWorkflowGraphArtifacts } from "../src/skill/workflow-graph.js";

class FakeProcess implements LabProcessHandle {
  pid: number | null;
  killSignals: Array<NodeJS.Signals | undefined> = [];
  private readonly emitter = new EventEmitter();
  private resolveExit!: (result: LabProcessExitResult) => void;
  private readonly exitPromise: Promise<LabProcessExitResult>;
  private exited = false;

  constructor(pid: number) {
    this.pid = pid;
    this.exitPromise = new Promise((resolveExit) => {
      this.resolveExit = resolveExit;
    });
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.killSignals.push(signal);
    if (!this.exited) {
      this.finish({
        code: 0,
        signal: signal ?? null,
      });
    }
    return true;
  }

  onceExit(): Promise<LabProcessExitResult> {
    return this.exitPromise;
  }

  onExit(listener: (result: LabProcessExitResult) => void): void {
    this.emitter.on("exit", listener);
  }

  finish(result: LabProcessExitResult): void {
    if (this.exited) {
      return;
    }
    this.exited = true;
    this.resolveExit(result);
    this.emitter.emit("exit", result);
  }
}

describe.sequential("lab api service", () => {
  const originalCwd = process.cwd();
  let tempRoot = "";

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "oysterworkflow-lab-"));
    process.chdir(tempRoot);
  });

  afterEach(async () => {
    vi.useRealTimers();
    process.chdir(originalCwd);
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("loads env values from a provided codex env file", async () => {
    const envPath = path.join(tempRoot, "lab.env");
    await writeFile(
      envPath,
      "TEST_LLM_API_KEY=test-value\nOTHER_FLAG=yes\n",
      "utf8",
    );
    delete process.env.TEST_LLM_API_KEY;

    const result = loadCodexEnv(envPath);

    expect(result.path).toBe(envPath);
    expect(result.parsed?.TEST_LLM_API_KEY).toBe("test-value");
    expect(process.env.TEST_LLM_API_KEY).toBe("test-value");
  });

  it("reads the current lab LLM config and reports direct-key auth without exposing the secret", async () => {
    await writeLabLlmConfigFile(tempRoot, {
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-5.4",
      wireApi: "responses",
      reasoningEffort: "xhigh",
      responseReadTimeoutMs: 120000,
      responseTimeoutMode: "idle",
      callProfiles: {
        "workflow-discovery": {
          reasoningEffort: "xhigh",
          responseReadTimeoutMs: 180000,
        },
      },
      clientProfile: "openai-js",
      apiKey: "live-secret-key",
      components: {
        generalization: {
          enabled: true,
        },
      },
    });

    const service = await createLabService({
      getLlmConfigPath: () => getTempLabLlmConfigPath(tempRoot),
    });
    const response = await service.getLlmConfig();

    expect(response.path).toBe(getTempLabLlmConfigPath(tempRoot));
    expect(response.config).toEqual({
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-5.4",
      wireApi: "responses",
      reasoningEffort: "xhigh",
      responseReadTimeoutMs: 120000,
      responseTimeoutMode: "idle",
      callProfiles: buildExpectedLabCallProfiles({
        "workflow-discovery": {
          reasoningEffort: "xhigh",
          responseReadTimeoutMs: 180000,
        },
      }),
      clientProfile: "openai-js",
      authMode: "direct",
      apiKeyEnv: null,
      hasStoredApiKey: true,
      hasResolvedApiKey: true,
    });
  });

  it("uses the first-open LLM defaults when no local lab config exists yet", async () => {
    const service = await createLabService({
      getLlmConfigPath: () => getTempLabLlmConfigPath(tempRoot),
    });

    const response = await service.getLlmConfig();

    expect(response.path).toBe(getTempLabLlmConfigPath(tempRoot));
    expect(response.config).toEqual({
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-5.4",
      wireApi: "responses",
      reasoningEffort: "high",
      responseReadTimeoutMs: 180000,
      responseTimeoutMode: "idle",
      callProfiles: buildExpectedLabCallProfiles(),
      clientProfile: null,
      authMode: "direct",
      apiKeyEnv: null,
      hasStoredApiKey: false,
      hasResolvedApiKey: false,
    });
  });

  it("updates same-origin LLM settings while preserving advanced fields and the existing direct api key", async () => {
    await writeLabLlmConfigFile(tempRoot, {
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-5.4",
      wireApi: "responses",
      reasoningEffort: "xhigh",
      responseReadTimeoutMs: 120000,
      responseTimeoutMode: "idle",
      clientProfile: "openai-js",
      apiKey: "live-secret-key",
      callProfiles: {
        "workflow-discovery": {
          reasoningEffort: "xhigh",
          responseReadTimeoutMs: 180000,
        },
      },
      components: {
        generalization: {
          enabled: true,
        },
        plannerOptimization: {
          enabled: true,
        },
      },
    });

    const service = await createLabService({
      getLlmConfigPath: () => getTempLabLlmConfigPath(tempRoot),
    });
    const response = await service.updateLlmConfig({
      provider: "custom-gateway",
      baseUrl: "https://API.OPENAI.COM:443/compatible/v1",
      model: "gpt-4.1-mini",
      wireApi: "chat-completions",
      reasoningEffort: null,
      responseReadTimeoutMs: 60000,
      responseTimeoutMode: "fixed",
      callProfiles: {
        "workflow-discovery": {
          reasoningEffort: "low",
        },
        "planner-optimization": {
          reasoningEffort: null,
        },
      },
      clientProfile: null,
      authMode: "direct",
      apiKey: "",
      apiKeyEnv: null,
    });
    const saved = JSON.parse(
      await readFile(getTempLabLlmConfigPath(tempRoot), "utf8"),
    ) as Record<string, unknown>;
    const savedFile = await stat(getTempLabLlmConfigPath(tempRoot));

    expect(response.config).toEqual({
      provider: "custom-gateway",
      baseUrl: "https://API.OPENAI.COM:443/compatible/v1",
      model: "gpt-4.1-mini",
      wireApi: "chat-completions",
      reasoningEffort: null,
      responseReadTimeoutMs: 60000,
      responseTimeoutMode: "fixed",
      callProfiles: buildExpectedLabCallProfiles({
        "workflow-discovery": {
          reasoningEffort: "low",
          responseReadTimeoutMs: 180000,
        },
      }),
      clientProfile: null,
      authMode: "direct",
      apiKeyEnv: null,
      hasStoredApiKey: true,
      hasResolvedApiKey: true,
    });
    expect(saved).toMatchObject({
      mode: "openai-compatible",
      provider: "custom-gateway",
      baseUrl: "https://API.OPENAI.COM:443/compatible/v1",
      model: "gpt-4.1-mini",
      wireApi: "chat-completions",
      responseReadTimeoutMs: 60000,
      responseTimeoutMode: "fixed",
      apiKey: "live-secret-key",
      callProfiles: {
        "workflow-discovery": {
          reasoningEffort: "low",
          responseReadTimeoutMs: 180000,
        },
      },
      components: {
        generalization: {
          enabled: true,
        },
        plannerOptimization: {
          enabled: true,
        },
      },
    });
    expect(saved).not.toHaveProperty("reasoningEffort");
    expect(saved).not.toHaveProperty("clientProfile");
    expect(saved).not.toHaveProperty("apiKeyEnv");
    expect(savedFile.mode & 0o777).toBe(0o600);
  });

  it("requires a new direct api key when the provider origin changes", async () => {
    await writeLabLlmConfigFile(tempRoot, {
      provider: "provider-a",
      baseUrl: "https://provider-a.example.com/v1",
      model: "model-a",
      wireApi: "responses",
      apiKey: "provider-a-secret",
      extraHeaders: {
        "X-Api-Key": "hidden-provider-secret",
        "X-Provider-Version": "2026-07-17",
      },
    });
    const configPath = getTempLabLlmConfigPath(tempRoot);
    const service = await createLabService({
      getLlmConfigPath: () => configPath,
    });

    await expect(
      service.updateLlmConfig({
        provider: "provider-b",
        baseUrl: "https://provider-b.example.com/v1",
        model: "model-b",
        wireApi: "responses",
        authMode: "direct",
        apiKey: null,
      }),
    ).rejects.toThrow("Base URL origin changed");
    const unchanged = JSON.parse(await readFile(configPath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(unchanged).toMatchObject({
      baseUrl: "https://provider-a.example.com/v1",
      apiKey: "provider-a-secret",
    });

    const response = await service.updateLlmConfig({
      provider: "provider-b",
      baseUrl: "https://provider-b.example.com/v1",
      model: "model-b",
      wireApi: "responses",
      authMode: "direct",
      apiKey: "provider-b-secret",
    });
    const saved = JSON.parse(await readFile(configPath, "utf8")) as Record<
      string,
      unknown
    >;

    expect(response.config).toMatchObject({
      provider: "provider-b",
      baseUrl: "https://provider-b.example.com/v1",
      model: "model-b",
      authMode: "direct",
      hasStoredApiKey: true,
      hasResolvedApiKey: true,
    });
    expect(saved).toMatchObject({
      baseUrl: "https://provider-b.example.com/v1",
      apiKey: "provider-b-secret",
      extraHeaders: {
        "X-Provider-Version": "2026-07-17",
      },
    });
  });

  it("allows a cross-origin keyless config without retaining the old direct key", async () => {
    await writeLabLlmConfigFile(tempRoot, {
      baseUrl: "https://provider-a.example.com/v1",
      model: "model-a",
      wireApi: "responses",
      apiKey: "provider-a-secret",
      extraHeaders: {
        Authorization: "Bearer hidden-provider-secret",
        "X-Provider-Version": "2026-07-17",
      },
    });
    const configPath = getTempLabLlmConfigPath(tempRoot);
    const service = await createLabService({
      getLlmConfigPath: () => configPath,
    });

    const response = await service.updateLlmConfig({
      provider: "keyless-provider",
      baseUrl: "http://127.0.0.1:18080/v1",
      model: "local-model",
      wireApi: "chat-completions",
      authMode: "none",
      apiKey: null,
      apiKeyEnv: null,
    });
    const saved = JSON.parse(await readFile(configPath, "utf8")) as Record<
      string,
      unknown
    >;

    expect(response.config).toMatchObject({
      baseUrl: "http://127.0.0.1:18080/v1",
      authMode: "none",
      hasStoredApiKey: false,
      hasResolvedApiKey: false,
    });
    expect(saved).not.toHaveProperty("apiKey");
    expect(saved).not.toHaveProperty("apiKeyEnv");
    expect(saved.extraHeaders).toEqual({
      "X-Provider-Version": "2026-07-17",
    });
  });

  it("can switch the lab LLM config to environment-variable auth", async () => {
    await writeLabLlmConfigFile(tempRoot, {
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-5.4",
      wireApi: "responses",
      apiKey: "old-direct-key",
    });

    const service = await createLabService({
      getLlmConfigPath: () => getTempLabLlmConfigPath(tempRoot),
    });
    const response = await service.updateLlmConfig({
      provider: null,
      baseUrl: "https://proxy.example.com/openai",
      model: "gpt-5.4",
      wireApi: "responses",
      reasoningEffort: "medium",
      responseReadTimeoutMs: 180000,
      responseTimeoutMode: "idle",
      callProfiles: {
        "scenario-prediction": {
          reasoningEffort: "high",
        },
      },
      clientProfile: "default",
      authMode: "env",
      apiKey: null,
      apiKeyEnv: "LLM_API_KEY",
    });
    const saved = JSON.parse(
      await readFile(getTempLabLlmConfigPath(tempRoot), "utf8"),
    ) as Record<string, unknown>;

    expect(response.config).toEqual({
      provider: null,
      baseUrl: "https://proxy.example.com/openai",
      model: "gpt-5.4",
      wireApi: "responses",
      reasoningEffort: "medium",
      responseReadTimeoutMs: 180000,
      responseTimeoutMode: "idle",
      callProfiles: buildExpectedLabCallProfiles({
        "scenario-prediction": {
          reasoningEffort: "high",
        },
      }),
      clientProfile: "default",
      authMode: "env",
      apiKeyEnv: "LLM_API_KEY",
      hasStoredApiKey: false,
      hasResolvedApiKey: false,
    });
    expect(saved).toMatchObject({
      mode: "openai-compatible",
      baseUrl: "https://proxy.example.com/openai",
      model: "gpt-5.4",
      wireApi: "responses",
      reasoningEffort: "medium",
      responseReadTimeoutMs: 180000,
      responseTimeoutMode: "idle",
      callProfiles: {
        "scenario-prediction": {
          reasoningEffort: "high",
        },
      },
      clientProfile: "default",
      apiKey: "${LLM_API_KEY}",
      apiKeyEnv: "LLM_API_KEY",
    });
  });

  it("blocks recording when port 3030 is already in use", async () => {
    const service = await createLabService({
      isPortAvailable: async () => false,
      probeHealth: async () => {
        throw new Error("connection refused");
      },
    });

    await expect(service.startRecording({})).rejects.toThrow(
      /Port 3030 is already in use/,
    );
  });

  it("reports missing macOS recorder permissions from the bundled screenpipe probe", async () => {
    const runtimeConfig = resolveRuntimeConfig({
      mode: "desktop",
      platform: "darwin",
      cwd: tempRoot,
      projectRootDir: tempRoot,
      runsRoot: path.join(tempRoot, "runs"),
      screenpipeBinaryPath: path.join(tempRoot, "screenpipe"),
      screenpipeWorkDir: tempRoot,
    });
    const probeProcess = new FakeProcess(611);
    let permissionCommand: string[] = [];

    const service = await createLabService({
      runtimeConfig,
      spawnProcess: async (input) => {
        permissionCommand = input.command;
        await mkdir(path.dirname(input.logPath), { recursive: true });
        await writeFile(
          input.logPath,
          JSON.stringify({
            screenRecording: "missing",
            accessibility: "missing",
            inputMonitoring: "missing",
            microphone: "not-determined",
          }),
          "utf8",
        );
        probeProcess.finish({ code: 0, signal: null });
        return probeProcess;
      },
      probeHealth: async (baseUrl) => {
        if (baseUrl === runtimeConfig.screenpipeBaseUrl) {
          throw new Error("connection refused");
        }
        return { status: "degraded", status_code: 503 };
      },
    });

    const result = await service.checkRecorderPermissions();

    expect(probeProcess.killSignals).toEqual([]);
    expect(permissionCommand).toEqual([
      runtimeConfig.screenpipeBinaryPath,
      "permissions",
      "--json",
    ]);
    expect(result.canStartRecording).toBe(false);
    expect(result.source).toBe("screenpipe-probe");
    expect(result.items).toEqual([
      expect.objectContaining({
        kind: "screen-recording",
        state: "missing",
      }),
      expect.objectContaining({
        kind: "accessibility",
        state: "missing",
      }),
      expect.objectContaining({
        kind: "input-monitoring",
        state: "missing",
      }),
    ]);
  });

  it("does not block desktop recording on the legacy bundled recorder permission gate", async () => {
    const runtimeConfig = resolveRuntimeConfig({
      mode: "desktop",
      platform: "darwin",
      cwd: tempRoot,
      projectRootDir: tempRoot,
      runsRoot: path.join(tempRoot, "runs"),
      screenpipeBinaryPath: path.join(tempRoot, "screenpipe"),
      screenpipeWorkDir: tempRoot,
    });
    let spawnCalls = 0;
    const recordingProcess = new FakeProcess(612);

    const service = await createLabService({
      runtimeConfig,
      spawnProcess: async (input) => {
        spawnCalls += 1;
        await mkdir(path.dirname(input.logPath), { recursive: true });
        await writeFile(
          input.logPath,
          "UI capture permissions not granted - accessibility: false, input_monitoring: false\n",
          "utf8",
        );
        return recordingProcess;
      },
      probeHealth: async (baseUrl) => {
        if (baseUrl === runtimeConfig.screenpipeBaseUrl) {
          if (spawnCalls === 0) {
            throw new Error("connection refused");
          }
          return { status: "healthy", status_code: 200 };
        }
        return { status: "healthy", status_code: 200 };
      },
    });

    const session = await service.startRecording({});

    expect(session.status).toBe("recording");
    expect(spawnCalls).toBe(1);
    await expect(service.listSessions()).resolves.toEqual([
      expect.objectContaining({
        sessionId: session.sessionId,
        status: "recording",
      }),
    ]);
  });

  it("caches blocked recorder permission checks unless a force refresh is requested", async () => {
    let nowMs = Date.parse("2026-04-05T22:00:00.000Z");
    const runtimeConfig = resolveRuntimeConfig({
      mode: "desktop",
      platform: "darwin",
      cwd: tempRoot,
      projectRootDir: tempRoot,
      runsRoot: path.join(tempRoot, "runs"),
      screenpipeBinaryPath: path.join(tempRoot, "screenpipe"),
      screenpipeWorkDir: tempRoot,
    });
    let spawnCalls = 0;

    const service = await createLabService({
      now: () => new Date(nowMs),
      runtimeConfig,
      spawnProcess: async (input) => {
        spawnCalls += 1;
        await mkdir(path.dirname(input.logPath), { recursive: true });
        await writeFile(
          input.logPath,
          JSON.stringify({
            screenRecording: "missing",
            accessibility: "missing",
            inputMonitoring: "missing",
            microphone: "not-determined",
          }),
          "utf8",
        );
        const process = new FakeProcess(613);
        process.finish({ code: 0, signal: null });
        return process;
      },
      probeHealth: async (baseUrl) => {
        if (baseUrl === runtimeConfig.screenpipeBaseUrl) {
          throw new Error("connection refused");
        }
        return { status: "degraded", status_code: 503 };
      },
    });

    await service.checkRecorderPermissions();
    nowMs += 2_000;
    await service.checkRecorderPermissions();
    nowMs += 2_000;
    await service.checkRecorderPermissions({ forceRefresh: true });

    expect(spawnCalls).toBe(2);
  });

  it("reports recorder bootstrap ready immediately when an existing recorder is already healthy", async () => {
    const runtimeConfig = resolveRuntimeConfig({
      mode: "desktop",
      platform: "darwin",
      cwd: tempRoot,
      projectRootDir: tempRoot,
      runsRoot: path.join(tempRoot, "runs"),
      screenpipeBinaryPath: path.join(tempRoot, "screenpipe"),
      screenpipeWorkDir: tempRoot,
    });
    let spawnCalls = 0;

    const service = await createLabService({
      runtimeConfig,
      spawnProcess: async () => {
        spawnCalls += 1;
        return new FakeProcess(614);
      },
      probeHealth: async () => ({ status: "healthy", status_code: 200 }),
    });

    const result = await service.bootstrapRecorder({});

    expect(result).toMatchObject({
      stage: "ready",
      ready: true,
      logPath: null,
    });
    expect(result.summary).toMatch(/already ready/);
    expect(spawnCalls).toBe(0);
  });

  it("bootstraps the recorder, waits for health, and stops the warm-up process", async () => {
    let nowMs = Date.parse("2026-04-06T09:00:00.000Z");
    const runtimeConfig = resolveRuntimeConfig({
      mode: "desktop",
      platform: "darwin",
      cwd: tempRoot,
      projectRootDir: tempRoot,
      runsRoot: path.join(tempRoot, "runs"),
      screenpipeBinaryPath: path.join(tempRoot, "screenpipe"),
      screenpipeWorkDir: tempRoot,
    });
    const bootstrapProcess = new FakeProcess(615);
    const spawnedCommands: string[][] = [];
    let recorderProbeCalls = 0;

    const service = await createLabService({
      now: () => new Date(nowMs),
      sleep: async (ms) => {
        nowMs += ms;
      },
      runtimeConfig,
      isPortAvailable: async () => true,
      spawnProcess: async (input) => {
        spawnedCommands.push(input.command);
        await mkdir(path.dirname(input.logPath), { recursive: true });
        await writeFile(input.logPath, "warming up\n", "utf8");
        return bootstrapProcess;
      },
      probeHealth: async () => {
        recorderProbeCalls += 1;
        return recorderProbeCalls >= 2
          ? { status: "healthy", status_code: 200 }
          : { status: "degraded", status_code: 503 };
      },
    });

    const result = await service.bootstrapRecorder({
      enableAudio: false,
      ocrLanguagePriority: ["chinese", "english"],
    });

    expect(result.stage).toBe("ready");
    expect(result.ready).toBe(true);
    expect(result.summary).toMatch(/dependencies are ready/i);
    expect(toPortablePath(result.logPath)).toMatch(/runs\/bootstrap\//);
    expect(bootstrapProcess.killSignals[0]).toBe("SIGINT");
    expect(spawnedCommands[0]).toContain("--disable-audio");
    expect(readRecordingLanguageFlags(spawnedCommands[0])).toEqual([
      "chinese",
      "english",
    ]);
  });

  it("waits for healthy health during recorder bootstrap after startup stays degraded briefly", async () => {
    let nowMs = Date.parse("2026-04-06T09:00:00.000Z");
    const runtimeConfig = resolveRuntimeConfig({
      mode: "desktop",
      platform: "darwin",
      cwd: tempRoot,
      projectRootDir: tempRoot,
      runsRoot: path.join(tempRoot, "runs"),
      screenpipeBinaryPath: path.join(tempRoot, "screenpipe"),
      screenpipeWorkDir: tempRoot,
    });
    const bootstrapProcess = new FakeProcess(617);
    let recorderProbeCalls = 0;

    const service = await createLabService({
      now: () => new Date(nowMs),
      sleep: async (ms) => {
        nowMs += ms;
      },
      runtimeConfig,
      isPortAvailable: async () => true,
      spawnProcess: async (input) => {
        await mkdir(path.dirname(input.logPath), { recursive: true });
        await writeFile(input.logPath, "warming up\n", "utf8");
        return bootstrapProcess;
      },
      probeHealth: async () => {
        recorderProbeCalls += 1;
        return recorderProbeCalls >= 3
          ? { status: "healthy", status_code: 200 }
          : {
              status: "degraded",
              status_code: 503,
              frame_status: "not_started",
              audio_status: "disabled",
            };
      },
    });

    const result = await service.bootstrapRecorder({});

    expect(result.stage).toBe("ready");
    expect(result.ready).toBe(true);
    expect(recorderProbeCalls).toBe(3);
    expect(bootstrapProcess.killSignals[0]).toBe("SIGINT");
  });

  it("returns a failed recorder bootstrap response when first-run model downloads do not finish in time", async () => {
    let nowMs = Date.parse("2026-04-06T09:00:00.000Z");
    const runtimeConfig = resolveRuntimeConfig({
      mode: "desktop",
      platform: "darwin",
      cwd: tempRoot,
      projectRootDir: tempRoot,
      runsRoot: path.join(tempRoot, "runs"),
      screenpipeBinaryPath: path.join(tempRoot, "screenpipe"),
      screenpipeWorkDir: tempRoot,
    });
    const bootstrapProcess = new FakeProcess(616);

    const service = await createLabService({
      now: () => new Date(nowMs),
      sleep: async (ms) => {
        nowMs += ms;
      },
      runtimeConfig,
      isPortAvailable: async () => true,
      spawnProcess: async (input) => {
        await mkdir(path.dirname(input.logPath), { recursive: true });
        await writeFile(
          input.logPath,
          'downloading model "ggml-large-v3-turbo-q8_0.bin"\n',
          "utf8",
        );
        return bootstrapProcess;
      },
      probeHealth: async () => ({ status: "degraded", status_code: 503 }),
    });

    const result = await service.bootstrapRecorder({});

    expect(result.stage).toBe("failed");
    expect(result.ready).toBe(false);
    expect(result.summary).toMatch(/downloading first-run models/i);
    expect(toPortablePath(result.logPath)).toMatch(/runs\/bootstrap\//);
    expect(bootstrapProcess.killSignals[0]).toBe("SIGINT");
  });

  it("returns a health-timeout bootstrap summary after Screenpipe starts but never becomes healthy", async () => {
    let nowMs = Date.parse("2026-04-06T09:00:00.000Z");
    const runtimeConfig = resolveRuntimeConfig({
      mode: "desktop",
      platform: "darwin",
      cwd: tempRoot,
      projectRootDir: tempRoot,
      runsRoot: path.join(tempRoot, "runs"),
      screenpipeBinaryPath: path.join(tempRoot, "screenpipe"),
      screenpipeWorkDir: tempRoot,
    });
    const bootstrapProcess = new FakeProcess(618);

    const service = await createLabService({
      now: () => new Date(nowMs),
      sleep: async (ms) => {
        nowMs += ms;
      },
      runtimeConfig,
      isPortAvailable: async () => true,
      spawnProcess: async (input) => {
        await mkdir(path.dirname(input.logPath), { recursive: true });
        await writeFile(
          input.logPath,
          "Server listening on 0.0.0.0:3030\n",
          "utf8",
        );
        return bootstrapProcess;
      },
      probeHealth: async () => ({ status: "degraded", status_code: 503 }),
    });

    const result = await service.bootstrapRecorder({});

    expect(result.stage).toBe("failed");
    expect(result.ready).toBe(false);
    expect(result.summary).toMatch(
      /did not become healthy before the timeout/i,
    );
    expect(bootstrapProcess.killSignals[0]).toBe("SIGINT");
  });

  it("cancels an active recorder bootstrap before shutdown waits on the mutation queue", async () => {
    const runtimeConfig = resolveRuntimeConfig({
      mode: "desktop",
      platform: "darwin",
      cwd: tempRoot,
      projectRootDir: tempRoot,
      runsRoot: path.join(tempRoot, "runs"),
      screenpipeBinaryPath: path.join(tempRoot, "screenpipe"),
      screenpipeWorkDir: tempRoot,
    });
    const bootstrapProcess = new FakeProcess(619);
    let markHealthWaitStarted!: () => void;
    const healthWaitStarted = new Promise<void>((resolveStarted) => {
      markHealthWaitStarted = resolveStarted;
    });

    const service = await createLabService({
      runtimeConfig,
      isPortAvailable: async () => true,
      probeHealth: async () => ({ status: "degraded", status_code: 503 }),
      sleep: async () => {
        markHealthWaitStarted();
        return new Promise<void>(() => undefined);
      },
      spawnProcess: async (input) => {
        await mkdir(path.dirname(input.logPath), { recursive: true });
        await writeFile(
          input.logPath,
          "Server listening on 0.0.0.0:3030\n",
          "utf8",
        );
        return bootstrapProcess;
      },
    });

    const bootstrapPromise = service.bootstrapRecorder({});
    await healthWaitStarted;
    const shutdownPromise = service.shutdown();
    const [bootstrapResult] = await Promise.all([
      bootstrapPromise,
      shutdownPromise,
    ]);

    expect(bootstrapResult).toMatchObject({
      stage: "failed",
      ready: false,
    });
    expect(bootstrapResult.summary).toMatch(/cancelled.*shutting down/i);
    expect(bootstrapProcess.killSignals[0]).toBe("SIGINT");
  });

  it("rejects mutations queued after shutdown begins", async () => {
    const runtimeConfig = resolveRuntimeConfig({
      mode: "desktop",
      platform: "darwin",
      cwd: tempRoot,
      projectRootDir: tempRoot,
      runsRoot: path.join(tempRoot, "runs-shutdown-fence"),
      screenpipeBinaryPath: path.join(tempRoot, "screenpipe"),
      screenpipeWorkDir: tempRoot,
    });
    let spawnCalls = 0;
    const service = await createLabService({
      runtimeConfig,
      isPortAvailable: async () => true,
      probeHealth: async () => ({ status: "ok", status_code: 200 }),
      spawnProcess: async () => {
        spawnCalls += 1;
        return new FakeProcess(621);
      },
    });

    const firstShutdown = service.shutdown();
    const repeatedShutdown = service.shutdown();

    await expect(service.startRecording({})).rejects.toThrow(
      "Lab service is shutting down",
    );
    await expect(service.bootstrapRecorder({})).rejects.toThrow(
      "Lab service is shutting down",
    );
    await expect(
      Promise.all([firstShutdown, repeatedShutdown]),
    ).resolves.toEqual([undefined, undefined]);
    expect(spawnCalls).toBe(0);
  });

  it("fails promptly when the bootstrap process exits before health becomes ready", async () => {
    const runtimeConfig = resolveRuntimeConfig({
      mode: "desktop",
      platform: "darwin",
      cwd: tempRoot,
      projectRootDir: tempRoot,
      runsRoot: path.join(tempRoot, "runs-early-exit"),
      screenpipeBinaryPath: path.join(tempRoot, "screenpipe"),
      screenpipeWorkDir: tempRoot,
    });
    const bootstrapProcess = new FakeProcess(620);
    const service = await createLabService({
      runtimeConfig,
      isPortAvailable: async () => true,
      probeHealth: async () => ({ status: "degraded", status_code: 503 }),
      sleep: async () => new Promise<void>(() => undefined),
      spawnProcess: async (input) => {
        await mkdir(path.dirname(input.logPath), { recursive: true });
        await writeFile(input.logPath, "startup failed\n", "utf8");
        queueMicrotask(() => {
          bootstrapProcess.finish({ code: 127, signal: null });
        });
        return bootstrapProcess;
      },
    });

    const result = await service.bootstrapRecorder({});

    expect(result).toMatchObject({ stage: "failed", ready: false });
    expect(result.summary).toMatch(
      /bootstrap process exited before becoming healthy \(code=127/i,
    );
    expect(bootstrapProcess.killSignals[0]).toBe("SIGINT");
  });

  it("reports ENOENT and EACCES recorder spawn failures without an unhandled process error", async () => {
    const inaccessibleBinaryPath = path.join(
      tempRoot,
      "screenpipe-not-executable",
    );
    await writeFile(inaccessibleBinaryPath, "not executable\n", "utf8");
    await chmod(inaccessibleBinaryPath, 0o644);
    const cases = [
      {
        code: "ENOENT",
        binaryPath: path.join(tempRoot, "screenpipe-missing"),
      },
      {
        code: "EACCES",
        binaryPath: inaccessibleBinaryPath,
      },
    ];

    for (const failureCase of cases) {
      const runtimeConfig = resolveRuntimeConfig({
        mode: "desktop",
        platform: "darwin",
        cwd: tempRoot,
        projectRootDir: tempRoot,
        runsRoot: path.join(tempRoot, `runs-${failureCase.code}`),
        screenpipeBinaryPath: failureCase.binaryPath,
        screenpipeWorkDir: tempRoot,
      });
      const service = await createLabService({
        runtimeConfig,
        isPortAvailable: async () => true,
        probeHealth: async () => ({ status: "degraded", status_code: 503 }),
      });

      const result = await service.bootstrapRecorder({});

      expect(result).toMatchObject({ stage: "failed", ready: false });
      expect(result.summary).toContain(failureCase.code);
      expect(result.summary).toContain(failureCase.binaryPath);
    }
  });

  it("turns a recorder log stream error into a diagnostic failure and reaps the spawned process", async () => {
    const fixedNow = new Date(2026, 6, 16, 12, 34, 56);
    const runsRoot = path.join(tempRoot, "runs-log-error");
    const logPath = path.join(
      runsRoot,
      "bootstrap",
      "20260716-123456",
      "recording-bootstrap.log",
    );
    const binaryPath = path.join(tempRoot, "screenpipe-log-error");
    const pidMarkerPath = path.join(tempRoot, "screenpipe-log-error.pid");
    await mkdir(logPath, { recursive: true });
    await writeFile(
      binaryPath,
      `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(pidMarkerPath)}, String(process.pid));
setInterval(() => undefined, 1_000);
`,
      "utf8",
    );
    await chmod(binaryPath, 0o755);
    const runtimeConfig = resolveRuntimeConfig({
      mode: "desktop",
      platform: "darwin",
      cwd: tempRoot,
      projectRootDir: tempRoot,
      runsRoot,
      screenpipeBinaryPath: binaryPath,
      screenpipeWorkDir: tempRoot,
    });
    const service = await createLabService({
      runtimeConfig,
      now: () => new Date(fixedNow),
      isPortAvailable: async () => true,
      probeHealth: async () => ({ status: "degraded", status_code: 503 }),
    });

    const result = await service.bootstrapRecorder({});

    expect(result).toMatchObject({ stage: "failed", ready: false, logPath });
    expect(result.summary).toMatch(/write process log.*EISDIR/i);
    const pidText = await readFile(pidMarkerPath, "utf8").catch(() => null);
    if (pidText) {
      const pid = Number(pidText.trim());
      let processAlive = true;
      try {
        process.kill(pid, 0);
      } catch {
        processAlive = false;
      }
      expect(processAlive).toBe(false);
    }
  });

  it("fails recording startup when Screenpipe stays in the first-frame grace state", async () => {
    let nowMs = Date.parse("2026-04-01T10:00:00.000Z");
    const recordingProcess = new FakeProcess(619);
    const service = await createLabService({
      now: () => new Date(nowMs),
      sleep: async (ms) => {
        nowMs += ms;
      },
      spawnProcess: async () => recordingProcess,
      probeHealth: async () => ({
        status: "degraded",
        status_code: 503,
        frame_status: "not_started",
        audio_status: "disabled",
      }),
    });

    await expect(service.startRecording({})).rejects.toThrow(
      /did not become healthy/,
    );

    expect(recordingProcess.killSignals[0]).toBe("SIGINT");
  });

  it("fails recording startup if health never becomes healthy and cleans up the process", async () => {
    let nowMs = Date.parse("2026-04-01T10:00:00.000Z");
    const recordingProcess = new FakeProcess(111);
    const service = await createLabService({
      now: () => new Date(nowMs),
      sleep: async (ms) => {
        nowMs += ms;
      },
      spawnProcess: async () => recordingProcess,
      probeHealth: async () => ({ status: "degraded", status_code: 503 }),
    });

    await expect(service.startRecording({})).rejects.toThrow(
      /did not become healthy/,
    );

    expect(recordingProcess.killSignals[0]).toBe("SIGINT");
    const [session] = await service.listSessions();
    expect(session?.status).toBe("failed");
    expect(session?.error?.message).toMatch(/did not become healthy/);
  });

  it("stops recording and automatically runs ingest through query mode", async () => {
    let probeCalls = 0;
    const recordingProcess = new FakeProcess(101);
    const queryProcess = new FakeProcess(202);
    const spawnedCommands: string[][] = [];
    const spawnedEnv: Array<Record<string, string> | undefined> = [];
    const ingestCalls: string[] = [];
    const ingestTokens: Array<string | null | undefined> = [];
    const runtimeConfig = resolveRuntimeConfig({
      cwd: tempRoot,
      projectRootDir: tempRoot,
      screenpipeBinaryPath: path.join(tempRoot, "screenpipe"),
      screenpipeWorkDir: tempRoot,
    });

    const service = await createLabService({
      runtimeConfig,
      spawnProcess: async (input) => {
        spawnedCommands.push(input.command);
        spawnedEnv.push(input.env);
        return spawnedCommands.length === 1 ? recordingProcess : queryProcess;
      },
      probeHealth: async () => {
        probeCalls += 1;
        return probeCalls === 1
          ? { status: "degraded", status_code: 503 }
          : { status: "healthy", status_code: 200 };
      },
      runIngestFn: async (options) => {
        ingestCalls.push(options.baseUrl);
        ingestTokens.push(options.screenpipeApiToken);
        return buildIngestResult(options.out);
      },
    });

    const started = await service.startRecording({});
    const stopped = await service.stopRecording();

    expect(started.status).toBe("recording");
    expect(started.recordingConfig.enableAudio).toBe(false);
    expect(recordingProcess.killSignals[0]).toBe("SIGINT");
    expect(queryProcess.killSignals[0]).toBe("SIGINT");
    expect(spawnedCommands[0]).toContain("--adaptive-fps");
    expect(spawnedCommands[0]).toContain("--disable-audio");
    expect(spawnedCommands[0]).not.toContain("--use-system-default-audio");
    expect(spawnedCommands[0]).toContain("--enable-ui-events");
    expect(readRecordingLanguageFlags(spawnedCommands[0])).toEqual([
      "chinese",
      "english",
    ]);
    expect(spawnedCommands[1]).toContain("--disable-audio");
    expect(spawnedCommands[1]).toContain("--disable-vision");
    expect(spawnedEnv[0]?.SCREENPIPE_API_KEY).toMatch(/^ow-[a-f0-9]{48}$/);
    expect(spawnedEnv[1]?.SCREENPIPE_API_KEY).toBe(
      spawnedEnv[0]?.SCREENPIPE_API_KEY,
    );
    expect(ingestCalls[0]).toMatch(/^http:\/\/127\.0\.0\.1:3031$/);
    expect(ingestTokens[0]).toBe(spawnedEnv[0]?.SCREENPIPE_API_KEY);
    expect(stopped.status).toBe("ready");
    expect(stopped.screenpipe.recording.pid).toBeNull();
    expect(stopped.screenpipe.queryMode.pid).toBeNull();
    expect(stopped.ingest.latestRunId).toBe("run-001");
    expect(stopped.ingest.summary?.fetch.rawUiEventsCount).toBe(14);
  });

  it("builds the managed recording command with the requested OCR language priority order and audio setting", async () => {
    const recordingProcess = new FakeProcess(1201);
    const spawnedCommands: string[][] = [];
    const service = await createLabService({
      spawnProcess: async (input) => {
        spawnedCommands.push(input.command);
        return recordingProcess;
      },
      probeHealth: buildManagedScreenpipeProbeHealth(),
    });

    const started = await service.startRecording({
      ocrLanguagePriority: ["japanese", "english", "chinese"],
      enableAudio: true,
    });

    expect(started.recordingConfig.ocrLanguagePriority).toEqual([
      "japanese",
      "english",
      "chinese",
    ]);
    expect(started.recordingConfig.enableAudio).toBe(true);
    expect(readRecordingLanguageFlags(spawnedCommands[0] ?? [])).toEqual([
      "japanese",
      "english",
      "chinese",
    ]);
    expect(spawnedCommands[0]).toContain("--use-system-default-audio");
    expect(spawnedCommands[0]).not.toContain("--disable-audio");
  });

  it("uses the bundled Screenpipe CLI profile for record-subcommand Windows builds", async () => {
    const screenpipeDir = path.join(tempRoot, "screenpipe-bundle");
    const screenpipeBinaryPath = path.join(screenpipeDir, "screenpipe.exe");
    await mkdir(screenpipeDir, { recursive: true });
    await writeFile(
      path.join(screenpipeDir, "screenpipe-bundle.json"),
      JSON.stringify({
        schemaVersion: 1,
        recordSubcommand: true,
        supportsAdaptiveFps: false,
        supportsUiEvents: false,
        supportsTranscriptionMode: true,
        supportsDisableSystemAudio: true,
      }),
      "utf8",
    );
    const recordingProcess = new FakeProcess(1202);
    const spawnedCommands: string[][] = [];
    const runtimeConfig = resolveRuntimeConfig({
      mode: "desktop",
      platform: "win32",
      cwd: tempRoot,
      projectRootDir: tempRoot,
      runsRoot: path.join(tempRoot, "runs"),
      screenpipeBinaryPath,
      screenpipeWorkDir: screenpipeDir,
    });
    const service = await createLabService({
      runtimeConfig,
      spawnProcess: async (input) => {
        spawnedCommands.push(input.command);
        return recordingProcess;
      },
      probeHealth: buildManagedScreenpipeProbeHealth(),
    });

    await service.startRecording({ enableAudio: true });

    expect(spawnedCommands[0]?.slice(0, 2)).toEqual([
      screenpipeBinaryPath,
      "record",
    ]);
    expect(spawnedCommands[0]).not.toContain("--adaptive-fps");
    expect(spawnedCommands[0]).not.toContain("--enable-ui-events");
    expect(spawnedCommands[0]).toContain("--transcription-mode");
    expect(spawnedCommands[0]).toContain("realtime");
    expect(spawnedCommands[0]).toContain("--disable-system-audio");
  });

  it("shuts down an in-progress managed recording and marks the session interrupted", async () => {
    const recordingProcess = new FakeProcess(901);
    const service = await createLabService({
      spawnProcess: async () => recordingProcess,
      probeHealth: buildManagedScreenpipeProbeHealth(),
    });

    const started = await service.startRecording({});
    await service.shutdown();
    const stopped = await service.getSession(started.sessionId);

    expect(recordingProcess.killSignals[0]).toBe("SIGINT");
    expect(stopped.status).toBe("interrupted");
    expect(stopped.error).toBeNull();
    expect(stopped.warnings).toContain(
      "lab-api shut down while the session was still in progress; managed processes were stopped when possible, and the session was marked as interrupted so you can continue from the saved progress.",
    );
    expect(stopped.screenpipe.recording.state).toBe("stopped");
    expect(stopped.screenpipe.recording.stoppedAt).not.toBeNull();
    await expect(service.getRecorderState()).resolves.toEqual({
      activeSession: null,
    });
  });

  it("does not queue shutdown behind a long workflow discovery operation", async () => {
    const runsRoot = path.join(tempRoot, ".runs");
    const runtimeConfig = resolveRuntimeConfig({
      mode: "test",
      cwd: tempRoot,
      projectRootDir: tempRoot,
      runsRoot,
      screenpipeWorkDir: tempRoot,
    });
    const session = createSession(new Date("2026-07-17T10:00:00.000Z"), {
      runsRoot,
      screenpipeWorkDir: tempRoot,
    });
    session.status = "ready";
    session.ingest.latestRunDir = path.join(
      session.paths.ingestOutDir,
      "runs",
      "run-long-discovery",
    );
    await ensureSessionDirectories(session);
    await writeSession(session);
    let markDiscoveryStarted!: () => void;
    const discoveryStarted = new Promise<void>((resolveStarted) => {
      markDiscoveryStarted = resolveStarted;
    });
    const service = await createLabService({
      runtimeConfig,
      runDiscoverWorkflowsFn: async () => {
        markDiscoveryStarted();
        return new Promise<never>(() => undefined);
      },
    });
    const discovering = service.runWorkflowDiscovery(session.sessionId);
    const discoveryOutcome = discovering.then(
      () => null,
      (error: unknown) => error,
    );
    await discoveryStarted;
    const shutdownStartedAt = Date.now();

    await expect(service.shutdown()).resolves.toBeUndefined();

    expect(Date.now() - shutdownStartedAt).toBeLessThan(1_000);
    await expect(discoveryOutcome).resolves.toMatchObject({
      message: expect.stringMatching(/shutting down/i),
    });
    await expect(service.getSession(session.sessionId)).resolves.toMatchObject({
      status: "interrupted",
    });
  });

  it("reuses an existing healthy screenpipe recorder instead of spawning a new process", async () => {
    const ingestCalls: string[] = [];
    const service = await createLabService({
      isPortAvailable: async () => false,
      probeHealth: async () => ({ status: "healthy", status_code: 200 }),
      spawnProcess: async () => {
        throw new Error("spawn should not be called when reusing screenpipe");
      },
      runIngestFn: async (options) => {
        ingestCalls.push(options.baseUrl);
        return buildIngestResult(options.out);
      },
    });

    const started = await service.startRecording({});
    const stopped = await service.stopRecording();

    expect(started.status).toBe("recording");
    expect(started.screenpipe.recording.pid).toBeNull();
    expect(started.recordingConfig.enableAudio).toBe(false);
    expect(started.warnings).toContain(
      "Reused external Screenpipe instance at http://127.0.0.1:3030.",
    );
    expect(started.warnings).toContain(
      'Requested audio capture setting "disabled" may not be applied because the existing Screenpipe recorder keeps its own audio configuration.',
    );
    expect(ingestCalls).toEqual(["http://127.0.0.1:3030"]);
    expect(stopped.status).toBe("ready");
  });

  it("schedules timed stop for an active recording session", async () => {
    const recordingProcess = new FakeProcess(303);
    const service = await createLabService({
      spawnProcess: async () => recordingProcess,
      probeHealth: buildManagedScreenpipeProbeHealth(),
    });

    const started = await service.startRecording({});
    const updated = await service.scheduleTimedStop(5);

    expect(started.status).toBe("recording");
    expect(updated.recordingWindow.autoStopMinutes).toBe(5);
    expect(updated.recordingWindow.scheduledStopAt).not.toBeNull();
  });

  it("runs timed stop through the same stop -> query mode -> ingest flow", async () => {
    const recordingProcess = new FakeProcess(707);
    const queryProcess = new FakeProcess(708);
    const service = await createLabService({
      spawnProcess: async (input) =>
        input.command.includes("--disable-vision")
          ? queryProcess
          : recordingProcess,
      probeHealth: buildManagedScreenpipeProbeHealth(),
      runIngestFn: async (options) => buildIngestResult(options.out),
    });

    const started = await service.startRecording({ autoStopMinutes: 0.001 });
    let stopped = await service.getSession(started.sessionId);
    for (
      let attempt = 0;
      attempt < 5 && stopped.status !== "ready";
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      stopped = await service.getSession(started.sessionId);
    }

    expect(stopped.status).toBe("ready");
    expect(recordingProcess.killSignals[0]).toBe("SIGINT");
    expect(queryProcess.killSignals[0]).toBe("SIGINT");
    expect(stopped.ingest.latestRunId).toBe("run-001");
  });

  it("records timed-stop failures without leaking a detached rejection", async () => {
    const recordingProcess = new FakeProcess(711);
    const queryProcess = new FakeProcess(712);
    const service = await createLabService({
      isPortAvailable: async () => true,
      findFreePort: async () => 3031,
      spawnProcess: async (input) =>
        input.command.includes("--disable-vision")
          ? queryProcess
          : recordingProcess,
      probeHealth: buildManagedScreenpipeProbeHealth(),
      runIngestFn: async () => {
        throw new Error("timer ingest failed");
      },
    });

    const started = await service.startRecording({ autoStopMinutes: 0.001 });
    let failed = await service.getSession(started.sessionId);
    for (
      let attempt = 0;
      attempt < 10 && failed.status !== "failed";
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      failed = await service.getSession(started.sessionId);
    }

    expect(failed.status).toBe("failed");
    expect(failed.error?.message).toContain("timer ingest failed");
  });

  it("allows manually stopping a timed recording early and clears the pending schedule", async () => {
    const recordingProcess = new FakeProcess(709);
    const queryProcess = new FakeProcess(710);
    const service = await createLabService({
      spawnProcess: async (input) =>
        input.command.includes("--disable-vision")
          ? queryProcess
          : recordingProcess,
      probeHealth: buildManagedScreenpipeProbeHealth(),
      runIngestFn: async (options) => buildIngestResult(options.out),
    });

    const started = await service.startRecording({ autoStopMinutes: 10 });
    expect(started.recordingWindow.scheduledStopAt).not.toBeNull();
    expect(started.recordingWindow.autoStopMinutes).toBe(10);

    const stopped = await service.stopRecording();

    expect(stopped.status).toBe("ready");
    expect(stopped.recordingWindow.scheduledStopAt).toBeNull();
    expect(stopped.recordingWindow.autoStopMinutes).toBeNull();
    expect(stopped.recordingWindow.requestedStopAt).not.toBeNull();
    expect(recordingProcess.killSignals[0]).toBe("SIGINT");
    expect(queryProcess.killSignals[0]).toBe("SIGINT");
  });

  it("repairs stale sessions on startup and attempts to stop lingering recording processes", async () => {
    const runsRoot = path.join(tempRoot, ".runs");
    const staleSession = createSession(new Date("2026-04-01T10:00:00.000Z"), {
      runsRoot,
      screenpipeWorkDir: tempRoot,
    });
    staleSession.status = "recording";
    staleSession.recordingWindow.startedAt = staleSession.createdAt;
    staleSession.screenpipe.recording.state = "running";
    staleSession.screenpipe.recording.pid = 4242;
    staleSession.screenpipe.recording.command = [
      "/Applications/OysterWorkflow.app/Contents/Resources/bin/oysterworkflow-screenpipe",
      "--port",
      "3030",
    ];
    staleSession.screenpipe.recording.startedAt = staleSession.createdAt;
    await ensureSessionDirectories(staleSession);
    await writeSession(staleSession);

    const stopPersistedProcess = vi.fn(async () => ({
      code: null,
      signal: "SIGINT" as NodeJS.Signals,
    }));

    const service = await createLabService({
      stopPersistedProcess,
    });
    const repaired = await service.getSession(staleSession.sessionId);

    expect(stopPersistedProcess).toHaveBeenCalledWith({
      pid: 4242,
      expectedCommand: staleSession.screenpipe.recording.command,
    });
    expect(repaired.status).toBe("interrupted");
    expect(repaired.error).toBeNull();
    expect(repaired.screenpipe.recording.state).toBe("stopped");
    expect(repaired.screenpipe.recording.pid).toBeNull();
    expect(repaired.screenpipe.recording.stoppedAt).not.toBeNull();
    expect(repaired.warnings).toContain(
      "lab-api restarted while the session was still in progress; lingering managed processes were stopped when possible, and the session was marked as interrupted so you can continue from the saved progress.",
    );
  });

  it("repairs legacy failed sessions that still hold a lingering managed recording pid", async () => {
    const runsRoot = path.join(tempRoot, ".runs");
    const staleSession = createSession(new Date("2026-04-01T10:00:00.000Z"), {
      runsRoot,
      screenpipeWorkDir: tempRoot,
    });
    staleSession.status = "failed";
    staleSession.error = {
      message: "lab-api restarted while the session was still in progress.",
    };
    staleSession.warnings = [
      "lab-api restarted while the session was still in progress; the session was marked as failed.",
    ];
    staleSession.recordingWindow.startedAt = staleSession.createdAt;
    staleSession.recordingWindow.requestedStopAt = staleSession.createdAt;
    staleSession.screenpipe.recording.state = "stopped";
    staleSession.screenpipe.recording.pid = 4242;
    staleSession.screenpipe.recording.command = [
      "/Applications/OysterWorkflow.app/Contents/Resources/bin/oysterworkflow-screenpipe",
      "--port",
      "3030",
    ];
    staleSession.screenpipe.recording.startedAt = staleSession.createdAt;
    staleSession.screenpipe.recording.stoppedAt = null;
    await ensureSessionDirectories(staleSession);
    await writeSession(staleSession);

    const stopPersistedProcess = vi.fn(async () => ({
      code: null,
      signal: "SIGINT" as NodeJS.Signals,
    }));

    const service = await createLabService({
      stopPersistedProcess,
    });
    const repaired = await service.getSession(staleSession.sessionId);

    expect(stopPersistedProcess).toHaveBeenCalledWith({
      pid: 4242,
      expectedCommand: staleSession.screenpipe.recording.command,
    });
    expect(repaired.status).toBe("interrupted");
    expect(repaired.error).toBeNull();
    expect(repaired.screenpipe.recording.state).toBe("stopped");
    expect(repaired.screenpipe.recording.pid).toBeNull();
    expect(repaired.screenpipe.recording.stoppedAt).not.toBeNull();
    expect(repaired.warnings).toContain(
      "lab-api restarted while the session was still in progress; lingering managed processes were stopped when possible, and the session was marked as interrupted so you can continue from the saved progress.",
    );
  });

  it("migrates legacy shutdown-failed sessions to interrupted even when no lingering processes remain", async () => {
    const runsRoot = path.join(tempRoot, ".runs");
    const staleSession = createSession(new Date("2026-04-01T10:00:00.000Z"), {
      runsRoot,
      screenpipeWorkDir: tempRoot,
    });
    staleSession.status = "failed";
    staleSession.error = {
      message: "lab-api shut down while the session was still in progress.",
    };
    staleSession.warnings = [
      "lab-api shut down while the session was still in progress; managed processes were stopped when possible and the session was marked as failed.",
    ];
    staleSession.recordingWindow.startedAt = staleSession.createdAt;
    staleSession.recordingWindow.requestedStopAt = "2026-04-01T10:10:00.000Z";
    staleSession.screenpipe.recording.state = "stopped";
    staleSession.screenpipe.recording.stoppedAt = "2026-04-01T10:10:00.000Z";
    await ensureSessionDirectories(staleSession);
    await writeSession(staleSession);

    const service = await createLabService();
    const repaired = await service.getSession(staleSession.sessionId);

    expect(repaired.status).toBe("interrupted");
    expect(repaired.error).toBeNull();
    expect(repaired.warnings).toContain(
      "lab-api shut down while the session was still in progress; managed processes were stopped when possible, and the session was marked as interrupted so you can continue from the saved progress.",
    );
    expect(repaired.warnings).not.toContain(
      "lab-api shut down while the session was still in progress; managed processes were stopped when possible and the session was marked as failed.",
    );
  });

  it("repairs terminal sessions when a matching managed pid is still alive", async () => {
    const runsRoot = path.join(tempRoot, ".runs");
    const staleSession = createSession(new Date("2026-04-01T10:00:00.000Z"), {
      runsRoot,
      screenpipeWorkDir: tempRoot,
    });
    staleSession.status = "failed";
    staleSession.recordingWindow.startedAt = staleSession.createdAt;
    staleSession.recordingWindow.requestedStopAt = staleSession.createdAt;
    staleSession.screenpipe.recording.state = "stopped";
    staleSession.screenpipe.recording.pid = 4242;
    staleSession.screenpipe.recording.command = [
      "/Applications/OysterWorkflow.app/Contents/Resources/bin/oysterworkflow-screenpipe",
      "--port",
      "3030",
    ];
    staleSession.screenpipe.recording.startedAt = staleSession.createdAt;
    staleSession.screenpipe.recording.stoppedAt = "2026-04-01T10:10:00.000Z";
    await ensureSessionDirectories(staleSession);
    await writeSession(staleSession);

    const isPersistedProcessAlive = vi.fn(async () => true);
    const stopPersistedProcess = vi.fn(async () => ({
      code: null,
      signal: "SIGTERM" as NodeJS.Signals,
    }));

    const service = await createLabService({
      isPersistedProcessAlive,
      stopPersistedProcess,
    });
    const repaired = await service.getSession(staleSession.sessionId);

    expect(isPersistedProcessAlive).toHaveBeenCalledWith({
      pid: 4242,
      expectedCommand: staleSession.screenpipe.recording.command,
    });
    expect(stopPersistedProcess).toHaveBeenCalledWith({
      pid: 4242,
      expectedCommand: staleSession.screenpipe.recording.command,
    });
    expect(repaired.status).toBe("interrupted");
    expect(repaired.error).toBeNull();
    expect(repaired.screenpipe.recording.pid).toBeNull();
    expect(repaired.screenpipe.recording.stoppedAt).toBe(
      "2026-04-01T10:10:00.000Z",
    );
  });

  it("keeps completed sessions ready when startup cleanup only clears stale managed pids", async () => {
    const runsRoot = path.join(tempRoot, ".runs");
    const completedSession = createSession(
      new Date("2026-04-01T10:00:00.000Z"),
      {
        runsRoot,
        screenpipeWorkDir: tempRoot,
      },
    );
    completedSession.status = "ready";
    completedSession.recordingWindow.startedAt = completedSession.createdAt;
    completedSession.recordingWindow.requestedStopAt =
      "2026-04-01T10:10:00.000Z";
    completedSession.screenpipe.recording.state = "stopped";
    completedSession.screenpipe.recording.pid = 4242;
    completedSession.screenpipe.recording.command = [
      "/Applications/OysterWorkflow.app/Contents/Resources/bin/oysterworkflow-screenpipe",
      "--port",
      "3030",
    ];
    completedSession.screenpipe.recording.startedAt =
      completedSession.createdAt;
    completedSession.screenpipe.recording.stoppedAt =
      "2026-04-01T10:10:00.000Z";
    await ensureSessionDirectories(completedSession);
    await writeSession(completedSession);

    const isPersistedProcessAlive = vi.fn(async () => true);
    const stopPersistedProcess = vi.fn(async () => ({
      code: null,
      signal: "SIGTERM" as NodeJS.Signals,
    }));

    const service = await createLabService({
      isPersistedProcessAlive,
      stopPersistedProcess,
    });
    const repaired = await service.getSession(completedSession.sessionId);

    expect(isPersistedProcessAlive).toHaveBeenCalledWith({
      pid: 4242,
      expectedCommand: completedSession.screenpipe.recording.command,
    });
    expect(stopPersistedProcess).toHaveBeenCalledWith({
      pid: 4242,
      expectedCommand: completedSession.screenpipe.recording.command,
    });
    expect(repaired.status).toBe("ready");
    expect(repaired.error).toBeNull();
    expect(repaired.screenpipe.recording.pid).toBeNull();
    expect(repaired.screenpipe.recording.stoppedAt).toBe(
      "2026-04-01T10:10:00.000Z",
    );
  });

  it("keeps ingest-complete sessions ready when startup cleanup clears a lingering query pid", async () => {
    const runsRoot = path.join(tempRoot, ".runs");
    const completedSession = createSession(
      new Date("2026-04-01T10:00:00.000Z"),
      {
        runsRoot,
        screenpipeWorkDir: tempRoot,
      },
    );
    completedSession.status = "ready";
    completedSession.recordingWindow.startedAt = completedSession.createdAt;
    completedSession.recordingWindow.requestedStopAt =
      "2026-04-01T10:10:00.000Z";
    completedSession.screenpipe.recording.state = "stopped";
    completedSession.screenpipe.recording.stoppedAt =
      "2026-04-01T10:10:00.000Z";
    completedSession.screenpipe.queryMode.state = "running";
    completedSession.screenpipe.queryMode.pid = 4343;
    completedSession.screenpipe.queryMode.command = [
      "/Applications/OysterWorkflow.app/Contents/Resources/bin/oysterworkflow-screenpipe",
      "--port",
      "3031",
      "--disable-audio",
      "--disable-vision",
    ];
    completedSession.screenpipe.queryMode.startedAt =
      "2026-04-01T10:10:01.000Z";
    await ensureSessionDirectories(completedSession);
    const ingestResult = buildIngestResult(completedSession.paths.ingestOutDir);
    completedSession.ingest.latestRunId = ingestResult.manifest.runId;
    completedSession.ingest.latestRunDir = ingestResult.manifest.paths.runDir;
    completedSession.ingest.summaryPath = ingestResult.manifest.paths.summary;
    completedSession.ingest.summary = ingestResult.summary;
    await writeSession(completedSession);

    const stopPersistedProcess = vi.fn(async () => ({
      code: null,
      signal: "SIGTERM" as NodeJS.Signals,
    }));

    const service = await createLabService({
      stopPersistedProcess,
    });
    const repaired = await service.getSession(completedSession.sessionId);

    expect(stopPersistedProcess).toHaveBeenCalledWith({
      pid: 4343,
      expectedCommand: completedSession.screenpipe.queryMode.command,
    });
    expect(repaired.status).toBe("ready");
    expect(repaired.error).toBeNull();
    expect(repaired.warnings).not.toContain(
      "lab-api restarted while the session was still in progress; lingering managed processes were stopped when possible, and the session was marked as interrupted so you can continue from the saved progress.",
    );
    expect(repaired.screenpipe.queryMode.state).toBe("stopped");
    expect(repaired.screenpipe.queryMode.pid).toBeNull();
    expect(repaired.screenpipe.queryMode.stoppedAt).not.toBeNull();
  });

  it("deletes an inactive session together with its artifacts", async () => {
    const recordingProcess = new FakeProcess(711);
    const queryProcess = new FakeProcess(712);
    const service = await createLabService({
      spawnProcess: async (input) =>
        input.command.includes("--disable-vision")
          ? queryProcess
          : recordingProcess,
      probeHealth: buildManagedScreenpipeProbeHealth(),
      runIngestFn: async (options) => buildIngestResult(options.out),
    });

    const ready = await service.stopRecording.call(
      await createStartedService(service),
    );
    await service.deleteSession(ready.sessionId);

    expect(await service.listSessions()).toHaveLength(0);
    await expect(readFile(ready.paths.sessionPath, "utf8")).rejects.toThrow();
  });

  it("blocks deleting the active recording session", async () => {
    const recordingProcess = new FakeProcess(713);
    const service = await createLabService({
      spawnProcess: async () => recordingProcess,
      probeHealth: buildManagedScreenpipeProbeHealth(),
    });

    const started = await service.startRecording({});

    await expect(service.deleteSession(started.sessionId)).rejects.toThrow(
      /Cannot delete the active recording session/,
    );
  });

  it("lists OpenClaw personal skills from the lab service", async () => {
    const service = await createLabService({
      listOpenClawPersonalSkillsFn: async () => [
        {
          name: "generated-claim-check",
          description: "Generated skill",
          baseDir: "/tmp/.agents/skills/generated-claim-check",
          filePath: "/tmp/.agents/skills/generated-claim-check/SKILL.md",
          sourceType: "generated-managed",
          eligible: true,
          disabled: false,
          missing: {
            bins: [],
            anyBins: [],
            env: [],
            config: [],
            os: [],
          },
          marker: {
            installName: "generated-claim-check",
            installDir: "/tmp/.agents/skills/generated-claim-check",
            generatedAt: "2026-04-02T00:00:00.000Z",
            sourceSkillPath: "/tmp/source/skill.json",
            sourceSummaryPath: "/tmp/source/summary.json",
            originalSkillName: "Claim check",
            skillId: "skill-001",
          },
        },
      ],
    });

    const skills = await service.listOpenClawSkills();

    expect(skills).toHaveLength(1);
    expect(skills[0]?.sourceType).toBe("generated-managed");
  });

  it("reads and updates the Skill Manager config through the lab service", async () => {
    const seenWrites: Array<{
      skillPath: string;
      configPath: string;
    }> = [];
    const service = await createLabService({
      runtimeConfig: resolveRuntimeConfig({
        mode: "test",
        cwd: tempRoot,
        projectRootDir: tempRoot,
      }),
      readSkillManagerConfigFn: async () => ({
        skillPath: "/Users/test/.codex/skills",
        updatedAt: "2026-04-16T18:00:00.000Z",
      }),
      writeSkillManagerConfigFn: async (input, configPath) => {
        seenWrites.push({
          skillPath: input.skillPath,
          configPath,
        });
        return {
          skillPath: input.skillPath,
          updatedAt: "2026-04-16T18:30:00.000Z",
        };
      },
      listSkillManagerPathCandidatesFn: async () => [
        {
          id: "codex-default",
          label: "Codex (.codex/skills)",
          agentFamily: "codex",
          path: "/Users/test/.codex/skills",
          exists: true,
        },
      ],
    });

    const config = await service.getSkillManagerConfig();
    const updated = await service.updateSkillManagerConfig({
      skillPath: "/Users/test/.agents/skills",
    });
    const candidates = await service.listSkillManagerPathCandidates();

    expect(config.config.skillPath).toBe("/Users/test/.codex/skills");
    expect(updated.config.skillPath).toBe("/Users/test/.agents/skills");
    expect(
      seenWrites[0]?.configPath.endsWith(
        path.join("config", "skill-manager.config.json"),
      ),
    ).toBe(true);
    expect(candidates).toHaveLength(1);
  });

  it("lists installed skills from the configured Skill Manager directory", async () => {
    const service = await createLabService({
      readSkillManagerConfigFn: async () => ({
        skillPath: "/Users/test/.agents/skills",
        updatedAt: "2026-04-16T18:00:00.000Z",
      }),
      listInstalledSkillsFn: async (input) => {
        expect(input.skillPath).toBe("/Users/test/.agents/skills");
        return [
          {
            name: "generated-claim-check",
            description: "Generated managed skill",
            baseDir: "/Users/test/.agents/skills/generated-claim-check",
            filePath:
              "/Users/test/.agents/skills/generated-claim-check/SKILL.md",
            sourceType: "generated-managed",
            marker: {
              installName: "generated-claim-check",
              installDir: "/Users/test/.agents/skills/generated-claim-check",
              generatedAt: "2026-04-16T18:00:00.000Z",
              sourceSkillPath: "/tmp/source/skill.json",
              sourceSummaryPath: "/tmp/source/summary.json",
              originalSkillName: "Claim check",
              skillId: "skill-001",
            },
          },
        ];
      },
    });

    const skills = await service.listInstalledSkills();

    expect(skills).toHaveLength(1);
    expect(skills[0]?.name).toBe("generated-claim-check");
  });

  it("runs workflow discovery on the latest ingest run without passing episodeId", async () => {
    const recordingProcess = new FakeProcess(404);
    const queryProcess = new FakeProcess(405);
    const seenOptions: Array<{
      runDir: string;
      episodeId?: string;
      outPath?: string;
    }> = [];

    const service = await createLabService({
      spawnProcess: async (input) =>
        input.command.includes("--disable-vision")
          ? queryProcess
          : recordingProcess,
      probeHealth: buildManagedScreenpipeProbeHealth(),
      runIngestFn: async (options) => buildIngestResult(options.out),
      runDiscoverWorkflowsFn: async (options) => {
        seenOptions.push({
          runDir: options.runDir,
          episodeId: options.episodeId,
          outPath: options.outPath,
        });
        const artifact = buildWorkflowArtifact(options.runDir);
        if (options.outPath) {
          await mkdir(path.dirname(options.outPath), { recursive: true });
          await writeFile(
            options.outPath,
            `${JSON.stringify(artifact, null, 2)}\n`,
            "utf8",
          );
        }
        return {
          runId: "run-001",
          episode: buildEpisode(),
          workflowCandidates: artifact.workflowCandidates,
          artifact,
          path: options.outPath ?? null,
        };
      },
    });

    const started = await service.startRecording({});
    const ready = await service.stopRecording();
    const discovered = await service.runWorkflowDiscovery(ready.sessionId);

    expect(started.status).toBe("recording");
    expect(seenOptions[0]?.runDir).toBe(ready.ingest.latestRunDir);
    expect(seenOptions[0]?.episodeId).toBeUndefined();
    expect(discovered.workflowDiscovery.workflowCandidates).toHaveLength(2);
    expect(
      discovered.workflowDiscovery.workflowCandidates[0],
    ).not.toHaveProperty("confidence");
    expect(toPortablePath(discovered.workflowDiscovery.latestPath)).toMatch(
      /workflow\/\d{8}-\d{6}\.json$/,
    );

    const artifact = await service.getArtifact(ready.sessionId, "workflow");
    expect(
      (
        artifact.data as {
          workflowCandidates: WorkflowCandidate[];
        }
      ).workflowCandidates[0],
    ).not.toHaveProperty("confidence");
  });

  it("persists real generation stages from ingest through workflow graph construction", async () => {
    const recordingProcess = new FakeProcess(1404);
    const queryProcess = new FakeProcess(1405);
    const observedStages: Array<string | null> = [];
    const observedSelections: Array<string | null> = [];
    const service = await createLabService({
      spawnProcess: async (input) =>
        input.command.includes("--disable-vision")
          ? queryProcess
          : recordingProcess,
      probeHealth: buildManagedScreenpipeProbeHealth(),
      runIngestFn: async (options) => buildIngestResult(options.out),
      runDiscoverWorkflowsFn: async (options) => {
        observedStages.push(
          (await service.getSession(activeSessionId!)).generationProgress
            .currentStage,
        );
        const artifact = buildWorkflowArtifact(options.runDir);
        if (options.outPath) {
          await mkdir(path.dirname(options.outPath), { recursive: true });
          await writeFile(
            options.outPath,
            `${JSON.stringify(artifact, null, 2)}\n`,
            "utf8",
          );
        }
        return {
          runId: "run-001",
          episode: buildEpisode(),
          workflowCandidates: artifact.workflowCandidates,
          artifact,
          path: options.outPath ?? null,
        };
      },
      runExtractSkillLlmFn: async (options) => {
        const extractingSession = await service.getSession(activeSessionId!);
        observedStages.push(extractingSession.generationProgress.currentStage);
        observedSelections.push(extractingSession.selection.workflowId);
        await options.onProgress?.({ stage: "building-skill" });
        await options.onProgress?.({ stage: "building-workflow-graph" });
        observedStages.push(
          (await service.getSession(activeSessionId!)).generationProgress
            .currentStage,
        );
        return buildSkillExtractionResult(
          options.outDir ?? path.join(tempRoot, "fallback-skill"),
          options.selectedWorkflow!,
        );
      },
    });

    const started = await service.startRecording({});
    const activeSessionId = started.sessionId;
    const ready = await service.stopRecording();
    expect(ready.generationProgress.stages["analyzing-recording"]).toEqual({
      startedAt: expect.any(String),
      completedAt: expect.any(String),
    });

    const discovered = await service.runWorkflowDiscovery(activeSessionId);
    expect(
      discovered.generationProgress.stages["discovering-workflow"],
    ).toEqual({
      startedAt: expect.any(String),
      completedAt: expect.any(String),
    });
    const extracted = await service.runSkillExtraction(activeSessionId, {
      workflowPath: discovered.workflowDiscovery.latestPath!,
      workflowId: "workflow-claim",
    });

    expect(observedStages).toEqual([
      "discovering-workflow",
      "building-skill",
      "building-workflow-graph",
    ]);
    expect(observedSelections).toEqual(["workflow-claim"]);
    expect(extracted.generationProgress.currentStage).toBeNull();
    expect(extracted.generationProgress.completedAt).toEqual(
      expect.any(String),
    );
    expect(extracted.generationProgress.stages["building-skill"]).toEqual({
      startedAt: expect.any(String),
      completedAt: expect.any(String),
    });
    expect(
      extracted.generationProgress.stages["building-workflow-graph"],
    ).toEqual({
      startedAt: expect.any(String),
      completedAt: expect.any(String),
    });
  });

  it("stores the session name from the highest-priority workflow prefix after discovery", async () => {
    const recordingProcess = new FakeProcess(406);
    const queryProcess = new FakeProcess(407);

    const service = await createLabService({
      spawnProcess: async (input) =>
        input.command.includes("--disable-vision")
          ? queryProcess
          : recordingProcess,
      probeHealth: buildManagedScreenpipeProbeHealth(),
      runIngestFn: async (options) => buildIngestResult(options.out),
      runDiscoverWorkflowsFn: async (options) => {
        const artifact = {
          schemaVersion: "openclaw-workflow-discovery-v1" as const,
          generatedAt: "2026-04-01T10:05:00.000Z",
          runId: "run-001",
          episodeId: "episode-001",
          source: {
            runDir: options.runDir,
            startTs: "2026-04-01T10:00:00.000Z",
            endTs: "2026-04-01T10:00:10.000Z",
          },
          workflowCandidates: [
            {
              workflowId: "workflow-notes",
              name: "Write follow-up notes",
              description: "Capture a short summary after the check.",
              goal: "Write short follow-up notes.",
              priority: 2,
              startEventId: "e3",
              endEventId: "e4",
              startTs: "2026-04-01T10:00:06.000Z",
              endTs: "2026-04-01T10:00:10.000Z",
              eventCount: 3,
            },
            {
              workflowId: "workflow-claim",
              name: "Claim status check workflow for portal review",
              description: "Check the latest claim detail page.",
              goal: "Confirm the latest claim status.",
              priority: 1,
              startEventId: "e1",
              endEventId: "e2",
              startTs: "2026-04-01T10:00:00.000Z",
              endTs: "2026-04-01T10:00:06.000Z",
              eventCount: 4,
            },
          ],
          warnings: [],
        };
        if (options.outPath) {
          await mkdir(path.dirname(options.outPath), { recursive: true });
          await writeFile(
            options.outPath,
            `${JSON.stringify(artifact, null, 2)}\n`,
            "utf8",
          );
        }
        return {
          runId: "run-001",
          episode: buildEpisode(),
          workflowCandidates: artifact.workflowCandidates,
          artifact,
          path: options.outPath ?? null,
        };
      },
    });

    const ready = await service.stopRecording.call(
      await createStartedService(service),
    );
    const discovered = await service.runWorkflowDiscovery(ready.sessionId);
    const reloaded = await service.getSession(ready.sessionId);

    expect(discovered.sessionName).toBe("Claim status check w");
    expect(reloaded.sessionName).toBe("Claim status check w");
  });

  it("saves a manual workflow artifact so base skill generation can use it without discovery", async () => {
    const recordingProcess = new FakeProcess(408);
    const queryProcess = new FakeProcess(409);
    const seenSelectedWorkflow: string[] = [];

    const service = await createLabService({
      spawnProcess: async (input) =>
        input.command.includes("--disable-vision")
          ? queryProcess
          : recordingProcess,
      probeHealth: buildManagedScreenpipeProbeHealth(),
      runIngestFn: async (options) => buildIngestResult(options.out),
      runExtractSkillLlmFn: async (options) => {
        seenSelectedWorkflow.push(
          options.selectedWorkflow?.workflowId ?? "missing",
        );
        return buildSkillExtractionResult(
          options.outDir ?? path.join(tempRoot, "fallback-skill"),
          options.selectedWorkflow!,
        );
      },
    });

    const ready = await service.stopRecording.call(
      await createStartedService(service),
    );
    const saved = await service.saveWorkflowArtifact(ready.sessionId, {
      selectedWorkflowId: "manual-workflow-1",
      workflowCandidates: [
        {
          workflowId: "manual-workflow-1",
          name: "Manual claim review",
          description: "Open the portal and review the latest claim details.",
          goal: "Confirm the latest claim status.",
          priority: 1,
          startEventId: "manual-workflow-1-start",
          endEventId: "manual-workflow-1-end",
          startTs: "2026-04-01T10:00:00.000Z",
          endTs: "2026-04-01T10:10:00.000Z",
          eventCount: 14,
        },
      ],
    });
    const extracted = await service.runSkillExtraction(ready.sessionId, {
      workflowPath: saved.workflowDiscovery.latestPath!,
      workflowId: "manual-workflow-1",
    });

    expect(toPortablePath(saved.workflowDiscovery.latestPath)).toMatch(
      /workflow\/\d{8}-\d{6}-manual\.json$/,
    );
    expect(saved.workflowDiscovery.workflowCandidates).toEqual([
      expect.objectContaining({
        workflowId: "manual-workflow-1",
        name: "Manual claim review",
      }),
    ]);
    expect(saved.selection.workflowId).toBe("manual-workflow-1");
    expect(saved.selection.workflowPath).toBe(
      saved.workflowDiscovery.latestPath,
    );
    expect(seenSelectedWorkflow).toEqual(["manual-workflow-1"]);
    expect(extracted.skillExtraction.skill?.skillName).toBe(
      "Manual claim review",
    );
  });

  it("extracts a skill from the selected workflow artifact", async () => {
    const recordingProcess = new FakeProcess(505);
    const queryProcess = new FakeProcess(506);
    const seenSelectedWorkflow: string[] = [];
    const seenComponents: Array<{
      generalizationEnabled?: boolean;
      plannerOptimizationEnabled?: boolean;
    }> = [];
    const seenGuidance: Array<string | undefined> = [];

    const service = await createLabService({
      spawnProcess: async (input) =>
        input.command.includes("--disable-vision")
          ? queryProcess
          : recordingProcess,
      probeHealth: buildManagedScreenpipeProbeHealth(),
      runIngestFn: async (options) => buildIngestResult(options.out),
      runExtractSkillLlmFn: async (options) => {
        seenSelectedWorkflow.push(
          options.selectedWorkflow?.workflowId ?? "missing",
        );
        seenComponents.push({
          generalizationEnabled: options.components?.generalization?.enabled,
          plannerOptimizationEnabled:
            options.components?.plannerOptimization?.enabled,
        });
        seenGuidance.push(options.generationGuidance);
        return buildSkillExtractionResult(
          options.outDir ?? path.join(tempRoot, "fallback-skill"),
          options.selectedWorkflow!,
        );
      },
    });

    const ready = await service.stopRecording.call(
      await createStartedService(service),
    );
    const workflowPath = path.join(
      ready.paths.workflowDir,
      "manual-workflow.json",
    );
    const workflowArtifact = buildWorkflowArtifact(ready.ingest.latestRunDir!);
    await mkdir(path.dirname(workflowPath), { recursive: true });
    await writeFile(
      workflowPath,
      `${JSON.stringify(workflowArtifact, null, 2)}\n`,
      "utf8",
    );
    const rawDir = path.join(ready.ingest.latestRunDir!, "raw");
    const normalizedPath = path.join(
      ready.ingest.latestRunDir!,
      "normalized",
      "events.ndjson",
    );
    await mkdir(rawDir, { recursive: true });
    await mkdir(path.dirname(normalizedPath), { recursive: true });
    await writeFile(path.join(ready.paths.dataDir, "db.sqlite"), "private");
    await writeFile(path.join(rawDir, "ui_events.ndjson"), "{}\n");
    await writeFile(normalizedPath, "{}\n");

    const extracted = await service.runSkillExtraction(ready.sessionId, {
      workflowPath,
      workflowId: "workflow-claim",
      generationGuidance: "Avoid storing temporary portal URLs.",
    });

    expect(seenSelectedWorkflow).toEqual(["workflow-claim"]);
    expect(seenComponents).toEqual([
      {
        generalizationEnabled: false,
        plannerOptimizationEnabled: false,
      },
    ]);
    expect(seenGuidance).toEqual(["Avoid storing temporary portal URLs."]);
    expect(extracted.selection.workflowId).toBe("workflow-claim");
    expect(extracted.skillExtraction.skill?.skillName).toBe(
      "Claim status check",
    );
    await expect(stat(ready.paths.dataDir)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(rawDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(normalizedPath, "utf8")).resolves.toBe("{}\n");
  });

  it("passes existing canonical workflows to family matching and merge proposal calls", async () => {
    const recordingProcess = new FakeProcess(507);
    const queryProcess = new FakeProcess(508);
    const familyDirectory = path.join(tempRoot, "existing-family");
    const sourceWorkflow =
      buildWorkflowArtifact(tempRoot).workflowCandidates[0]!;
    const sourceResult = buildSkillExtractionResult(
      familyDirectory,
      sourceWorkflow,
    );
    const savedFamily = await materializeWorkflowGraphArtifacts({
      skill: sourceResult.skill,
      outDir: familyDirectory,
      sourceSkillPath: path.join(familyDirectory, "skill.json"),
      now: new Date("2026-07-20T20:00:00.000Z"),
    });
    const seenCatalogs: Array<{
      cards: string[];
      graphs: string[];
      graphPaths: Record<string, string>;
    }> = [];
    const service = await createLabService({
      spawnProcess: async (input) =>
        input.command.includes("--disable-vision")
          ? queryProcess
          : recordingProcess,
      probeHealth: buildManagedScreenpipeProbeHealth(),
      runIngestFn: async (options) => buildIngestResult(options.out),
      listWorkflowFamilyArtifactSourcesFn: async () => [
        {
          artifactPath: path.join(familyDirectory, "skill.json"),
          updatedAt: "2026-07-20T20:00:00.000Z",
        },
      ],
      runExtractSkillLlmFn: async (options) => {
        seenCatalogs.push({
          cards:
            options.workflowFamilyCards?.map((card) => card.workflowId) ?? [],
          graphs: Object.keys(options.workflowFamilyGraphs ?? {}),
          graphPaths: options.workflowFamilyGraphPaths ?? {},
        });
        return buildSkillExtractionResult(
          options.outDir ?? path.join(tempRoot, "fallback-skill"),
          options.selectedWorkflow!,
        );
      },
    });
    await service.startRecording({});
    const ready = await service.stopRecording();
    const workflowPath = path.join(
      ready.paths.workflowDir,
      "manual-workflow.json",
    );
    await mkdir(path.dirname(workflowPath), { recursive: true });
    await writeFile(
      workflowPath,
      `${JSON.stringify(buildWorkflowArtifact(ready.ingest.latestRunDir!), null, 2)}\n`,
      "utf8",
    );

    await service.runSkillExtraction(ready.sessionId, {
      workflowPath,
      workflowId: "workflow-claim",
    });

    expect(seenCatalogs).toEqual([
      {
        cards: [savedFamily.graph.workflowId],
        graphs: [savedFamily.graph.workflowId],
        graphPaths: {
          [savedFamily.graph.workflowId]: savedFamily.graphPath,
        },
      },
    ]);
  });

  it("deletes the reused Screenpipe recording window after workflow generation succeeds", async () => {
    const deletedRanges: Array<{
      baseUrl: string;
      start: string;
      end: string;
      apiToken: string | null;
    }> = [];
    const service = await createLabService({
      probeHealth: async () => ({ status: "healthy", status_code: 200 }),
      deleteScreenpipeTimeRangeFn: async (input) => {
        deletedRanges.push(input);
      },
      runIngestFn: async (options) => buildIngestResult(options.out),
      runExtractSkillLlmFn: async (options) =>
        buildSkillExtractionResult(
          options.outDir ?? path.join(tempRoot, "fallback-skill"),
          options.selectedWorkflow!,
        ),
    });

    const started = await service.startRecording({});
    const ready = await service.stopRecording();
    const workflowPath = path.join(
      ready.paths.workflowDir,
      "manual-workflow.json",
    );
    const workflowArtifact = buildWorkflowArtifact(ready.ingest.latestRunDir!);
    const rawDir = path.join(ready.ingest.latestRunDir!, "raw");
    await mkdir(path.dirname(workflowPath), { recursive: true });
    await mkdir(rawDir, { recursive: true });
    await writeFile(
      workflowPath,
      `${JSON.stringify(workflowArtifact, null, 2)}\n`,
      "utf8",
    );
    await writeFile(path.join(rawDir, "ocr.ndjson"), "{}\n");

    await service.runSkillExtraction(ready.sessionId, {
      workflowPath,
      workflowId: "workflow-claim",
    });

    expect(started.screenpipe.recordingDataBaseUrl).toBe(
      "http://127.0.0.1:3030",
    );
    expect(deletedRanges).toEqual([
      {
        baseUrl: "http://127.0.0.1:3030",
        start: ready.recordingWindow.startedAt,
        end: ready.recordingWindow.requestedStopAt,
        apiToken: null,
      },
    ]);
    await expect(stat(rawDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps local raw data and reports failure when reused Screenpipe cleanup fails", async () => {
    const service = await createLabService({
      probeHealth: async () => ({ status: "healthy", status_code: 200 }),
      deleteScreenpipeTimeRangeFn: async () => {
        throw new Error("Screenpipe time-range cleanup failed");
      },
      runIngestFn: async (options) => buildIngestResult(options.out),
      runExtractSkillLlmFn: async (options) =>
        buildSkillExtractionResult(
          options.outDir ?? path.join(tempRoot, "fallback-skill"),
          options.selectedWorkflow!,
        ),
    });

    await service.startRecording({});
    const ready = await service.stopRecording();
    const workflowPath = path.join(
      ready.paths.workflowDir,
      "manual-workflow.json",
    );
    const workflowArtifact = buildWorkflowArtifact(ready.ingest.latestRunDir!);
    const rawDir = path.join(ready.ingest.latestRunDir!, "raw");
    await mkdir(path.dirname(workflowPath), { recursive: true });
    await mkdir(rawDir, { recursive: true });
    await writeFile(
      workflowPath,
      `${JSON.stringify(workflowArtifact, null, 2)}\n`,
      "utf8",
    );
    await writeFile(path.join(rawDir, "ocr.ndjson"), "{}\n");

    await expect(
      service.runSkillExtraction(ready.sessionId, {
        workflowPath,
        workflowId: "workflow-claim",
      }),
    ).rejects.toThrow("Screenpipe time-range cleanup failed");

    const failed = await service.getSession(ready.sessionId);
    expect(failed.generationProgress.failedStage).toBe("building-skill");
    expect(failed.error?.message).toBe("Screenpipe time-range cleanup failed");
    await expect(stat(rawDir)).resolves.toBeDefined();
  });

  it("keeps raw capture data when workflow generation fails", async () => {
    const recordingProcess = new FakeProcess(507);
    const queryProcess = new FakeProcess(508);
    const service = await createLabService({
      spawnProcess: async (input) =>
        input.command.includes("--disable-vision")
          ? queryProcess
          : recordingProcess,
      probeHealth: buildManagedScreenpipeProbeHealth(),
      runIngestFn: async (options) => buildIngestResult(options.out),
      runExtractSkillLlmFn: async () => {
        throw new Error("workflow generation failed");
      },
    });

    const ready = await service.stopRecording.call(
      await createStartedService(service),
    );
    const workflowPath = path.join(
      ready.paths.workflowDir,
      "manual-workflow.json",
    );
    const workflowArtifact = buildWorkflowArtifact(ready.ingest.latestRunDir!);
    const rawDir = path.join(ready.ingest.latestRunDir!, "raw");
    await mkdir(path.dirname(workflowPath), { recursive: true });
    await mkdir(rawDir, { recursive: true });
    await writeFile(
      workflowPath,
      `${JSON.stringify(workflowArtifact, null, 2)}\n`,
      "utf8",
    );
    await writeFile(path.join(ready.paths.dataDir, "db.sqlite"), "private");
    await writeFile(path.join(rawDir, "ocr.ndjson"), "{}\n");

    await expect(
      service.runSkillExtraction(ready.sessionId, {
        workflowPath,
        workflowId: "workflow-claim",
      }),
    ).rejects.toThrow("workflow generation failed");

    await expect(stat(ready.paths.dataDir)).resolves.toBeDefined();
    await expect(stat(rawDir)).resolves.toBeDefined();
  });

  it("runs generalization from the latest base skill and keeps the base skill intact", async () => {
    const recordingProcess = new FakeProcess(601);
    const queryProcess = new FakeProcess(602);

    const service = await createLabService({
      spawnProcess: async (input) =>
        input.command.includes("--disable-vision")
          ? queryProcess
          : recordingProcess,
      probeHealth: buildManagedScreenpipeProbeHealth(),
      runIngestFn: async (options) => buildIngestResult(options.out),
      runExtractSkillLlmFn: async (options) =>
        buildSkillExtractionResult(
          options.outDir ?? path.join(tempRoot, "fallback-skill"),
          options.selectedWorkflow!,
        ),
      runGeneralizationFn: async (options) =>
        buildGeneralizationResult(
          options.outDir,
          options.skillPath,
          options.summaryPath,
        ),
    });

    const ready = await service.stopRecording.call(
      await createStartedService(service),
    );
    const workflowPath = path.join(
      ready.paths.workflowDir,
      "manual-workflow.json",
    );
    const workflowArtifact = buildWorkflowArtifact(ready.ingest.latestRunDir!);
    await mkdir(path.dirname(workflowPath), { recursive: true });
    await writeFile(
      workflowPath,
      `${JSON.stringify(workflowArtifact, null, 2)}\n`,
      "utf8",
    );

    const extracted = await service.runSkillExtraction(ready.sessionId, {
      workflowPath,
      workflowId: "workflow-claim",
    });
    const generalized = await service.runGeneralization(extracted.sessionId, {
      skillPath: extracted.skillExtraction.skillPath!,
    });

    expect(generalized.status).toBe("ready");
    expect(generalized.skillExtraction.skill?.skillName).toBe(
      "Claim status check",
    );
    expect(generalized.generalization.summary?.scenarioCount).toBe(1);
    expect(generalized.generalization.summary?.variantArtifacts).toHaveLength(
      1,
    );
    expect(toPortablePath(generalized.generalization.summaryPath)).toMatch(
      /generalization\/\d{8}-\d{6}-workflow-claim\/summary\.json$/,
    );

    const artifact = await service.getArtifact(
      ready.sessionId,
      "generalization-summary",
    );
    expect(
      (
        artifact.data as {
          variantArtifacts: Array<{ skill: { skillName: string } }>;
        }
      ).variantArtifacts[0]?.skill.skillName,
    ).toBe("Generalized claim status check");
  });

  it("keeps base skills for multiple workflows and can generalize a non-latest base skill", async () => {
    const recordingProcess = new FakeProcess(681);
    const queryProcess = new FakeProcess(682);
    const seenGeneralizationInputs: Array<{
      skillPath: string;
      summaryPath: string;
    }> = [];

    const service = await createLabService({
      spawnProcess: async (input) =>
        input.command.includes("--disable-vision")
          ? queryProcess
          : recordingProcess,
      probeHealth: buildManagedScreenpipeProbeHealth(),
      runIngestFn: async (options) => buildIngestResult(options.out),
      runExtractSkillLlmFn: async (options) =>
        buildSkillExtractionResult(
          options.outDir ?? path.join(tempRoot, "fallback-skill"),
          options.selectedWorkflow!,
        ),
      runGeneralizationFn: async (options) => {
        seenGeneralizationInputs.push({
          skillPath: options.skillPath,
          summaryPath: options.summaryPath,
        });
        return buildGeneralizationResult(
          options.outDir,
          options.skillPath,
          options.summaryPath,
        );
      },
    });

    const ready = await service.stopRecording.call(
      await createStartedService(service),
    );
    const workflowPath = path.join(
      ready.paths.workflowDir,
      "manual-workflow.json",
    );
    const workflowArtifact = buildWorkflowArtifact(ready.ingest.latestRunDir!);
    await mkdir(path.dirname(workflowPath), { recursive: true });
    await writeFile(
      workflowPath,
      `${JSON.stringify(workflowArtifact, null, 2)}\n`,
      "utf8",
    );

    await service.runSkillExtraction(ready.sessionId, {
      workflowPath,
      workflowId: "workflow-claim",
    });
    const extractedNotes = await service.runSkillExtraction(ready.sessionId, {
      workflowPath,
      workflowId: "workflow-notes",
    });
    const claimArtifact =
      extractedNotes.skillExtraction.artifacts.find(
        (artifact) => artifact.workflowId === "workflow-claim",
      ) ?? null;

    expect(
      extractedNotes.skillExtraction.artifacts.map(
        (artifact) => artifact.workflowId,
      ),
    ).toEqual(["workflow-claim", "workflow-notes"]);
    expect(extractedNotes.skillExtraction.skill?.skillName).toBe(
      "Write follow-up notes",
    );
    expect(claimArtifact?.skill.skillName).toBe("Claim status check");

    const generalized = await service.runGeneralization(ready.sessionId, {
      skillPath: claimArtifact?.skillPath ?? "",
    });

    expect(seenGeneralizationInputs).toEqual([
      {
        skillPath: claimArtifact?.skillPath ?? "",
        summaryPath: claimArtifact?.summaryPath ?? "",
      },
    ]);
    expect(generalized.generalization.summary?.sourceSkillPath).toBe(
      claimArtifact?.skillPath,
    );
    expect(generalized.generalization.artifacts).toHaveLength(1);
  });

  it("runs planner optimization from the base skill", async () => {
    const recordingProcess = new FakeProcess(603);
    const queryProcess = new FakeProcess(604);

    const service = await createLabService({
      spawnProcess: async (input) =>
        input.command.includes("--disable-vision")
          ? queryProcess
          : recordingProcess,
      probeHealth: buildManagedScreenpipeProbeHealth(),
      runIngestFn: async (options) => buildIngestResult(options.out),
      runExtractSkillLlmFn: async (options) =>
        buildSkillExtractionResult(
          options.outDir ?? path.join(tempRoot, "fallback-skill"),
          options.selectedWorkflow!,
        ),
      runPlannerOptimizationFn: async (options) =>
        buildPlannerOptimizationResult(
          options.outDir,
          options.skillPath,
          "base",
          options.selectedWorkflowId ?? null,
        ),
    });

    const ready = await service.stopRecording.call(
      await createStartedService(service),
    );
    const workflowPath = path.join(
      ready.paths.workflowDir,
      "manual-workflow.json",
    );
    const workflowArtifact = buildWorkflowArtifact(ready.ingest.latestRunDir!);
    await mkdir(path.dirname(workflowPath), { recursive: true });
    await writeFile(
      workflowPath,
      `${JSON.stringify(workflowArtifact, null, 2)}\n`,
      "utf8",
    );

    const extracted = await service.runSkillExtraction(ready.sessionId, {
      workflowPath,
      workflowId: "workflow-claim",
    });
    const optimized = await service.runPlannerOptimization(
      extracted.sessionId,
      {
        sourceType: "base",
        skillPath: extracted.skillExtraction.skillPath!,
      },
    );

    expect(optimized.status).toBe("ready");
    expect(optimized.plannerOptimization.summary?.sourceType).toBe("base");
    expect(optimized.plannerOptimization.skill?.skillName).toBe(
      "Optimized claim status check",
    );
  });

  it("passes the active lab llm config path into discovery and downstream skill actions", async () => {
    const recordingProcess = new FakeProcess(607);
    const queryProcess = new FakeProcess(608);
    const llmConfigPath = getTempLabLlmConfigPath(tempRoot);
    const seenConfigPaths: {
      discovery: string[];
      extraction: string[];
      generalization: string[];
      plannerOptimization: string[];
    } = {
      discovery: [],
      extraction: [],
      generalization: [],
      plannerOptimization: [],
    };

    const service = await createLabService({
      getLlmConfigPath: () => llmConfigPath,
      spawnProcess: async (input) =>
        input.command.includes("--disable-vision")
          ? queryProcess
          : recordingProcess,
      probeHealth: buildManagedScreenpipeProbeHealth(),
      runIngestFn: async (options) => buildIngestResult(options.out),
      runDiscoverWorkflowsFn: async (options) => {
        seenConfigPaths.discovery.push(options.configPath ?? "");
        const artifact = buildWorkflowArtifact(options.runDir);
        if (options.outPath) {
          await mkdir(path.dirname(options.outPath), { recursive: true });
          await writeFile(
            options.outPath,
            `${JSON.stringify(artifact, null, 2)}\n`,
            "utf8",
          );
        }
        return {
          runId: "run-001",
          episode: buildEpisode(),
          workflowCandidates: artifact.workflowCandidates,
          artifact,
          path: options.outPath ?? null,
        };
      },
      runExtractSkillLlmFn: async (options) => {
        seenConfigPaths.extraction.push(options.configPath ?? "");
        return buildSkillExtractionResult(
          options.outDir ?? path.join(tempRoot, "fallback-skill"),
          options.selectedWorkflow!,
        );
      },
      runGeneralizationFn: async (options) => {
        seenConfigPaths.generalization.push(options.configPath ?? "");
        return buildGeneralizationResult(
          options.outDir,
          options.skillPath,
          options.summaryPath,
        );
      },
      runPlannerOptimizationFn: async (options) => {
        seenConfigPaths.plannerOptimization.push(options.configPath ?? "");
        return buildPlannerOptimizationResult(
          options.outDir,
          options.skillPath,
          "base",
          options.selectedWorkflowId ?? null,
        );
      },
    });

    const ready = await service.stopRecording.call(
      await createStartedService(service),
    );
    const discovered = await service.runWorkflowDiscovery(ready.sessionId);
    const extracted = await service.runSkillExtraction(discovered.sessionId, {
      workflowPath: discovered.workflowDiscovery.latestPath!,
      workflowId: "workflow-claim",
    });
    await service.runGeneralization(extracted.sessionId, {
      skillPath: extracted.skillExtraction.skillPath!,
    });
    await service.runPlannerOptimization(extracted.sessionId, {
      sourceType: "base",
      skillPath: extracted.skillExtraction.skillPath!,
    });

    expect(seenConfigPaths.discovery).toEqual([llmConfigPath]);
    expect(seenConfigPaths.extraction).toEqual([llmConfigPath]);
    expect(seenConfigPaths.generalization).toEqual([llmConfigPath]);
    expect(seenConfigPaths.plannerOptimization).toEqual([llmConfigPath]);
  });

  it("runs planner optimization from a generalized variant and rejects foreign paths", async () => {
    const recordingProcess = new FakeProcess(605);
    const queryProcess = new FakeProcess(606);

    const service = await createLabService({
      spawnProcess: async (input) =>
        input.command.includes("--disable-vision")
          ? queryProcess
          : recordingProcess,
      probeHealth: buildManagedScreenpipeProbeHealth(),
      runIngestFn: async (options) => buildIngestResult(options.out),
      runExtractSkillLlmFn: async (options) =>
        buildSkillExtractionResult(
          options.outDir ?? path.join(tempRoot, "fallback-skill"),
          options.selectedWorkflow!,
        ),
      runGeneralizationFn: async (options) =>
        buildGeneralizationResult(
          options.outDir,
          options.skillPath,
          options.summaryPath,
        ),
      runPlannerOptimizationFn: async (options) =>
        buildPlannerOptimizationResult(
          options.outDir,
          options.skillPath,
          options.sourceType,
          options.selectedWorkflowId ?? null,
        ),
    });

    const ready = await service.stopRecording.call(
      await createStartedService(service),
    );
    const workflowPath = path.join(
      ready.paths.workflowDir,
      "manual-workflow.json",
    );
    const workflowArtifact = buildWorkflowArtifact(ready.ingest.latestRunDir!);
    await mkdir(path.dirname(workflowPath), { recursive: true });
    await writeFile(
      workflowPath,
      `${JSON.stringify(workflowArtifact, null, 2)}\n`,
      "utf8",
    );

    const extracted = await service.runSkillExtraction(ready.sessionId, {
      workflowPath,
      workflowId: "workflow-claim",
    });
    const generalized = await service.runGeneralization(extracted.sessionId, {
      skillPath: extracted.skillExtraction.skillPath!,
    });
    const generalizedSkillPath =
      generalized.generalization.summary?.variantArtifacts[0]?.summary.output
        .skillPath ?? "";

    const optimized = await service.runPlannerOptimization(
      generalized.sessionId,
      {
        sourceType: "generalized",
        skillPath: generalizedSkillPath,
      },
    );

    expect(optimized.plannerOptimization.summary?.sourceType).toBe(
      "generalized",
    );

    await expect(
      service.runPlannerOptimization(generalized.sessionId, {
        sourceType: "generalized",
        skillPath: path.join(tempRoot, "not-this-session", "skill.json"),
      }),
    ).rejects.toThrow(/does not belong to this session/);
  });

  it("updates edited base skills, normalizes saved content, and clears derived artifacts", async () => {
    const recordingProcess = new FakeProcess(607);
    const queryProcess = new FakeProcess(608);

    const service = await createLabService({
      spawnProcess: async (input) =>
        input.command.includes("--disable-vision")
          ? queryProcess
          : recordingProcess,
      probeHealth: buildManagedScreenpipeProbeHealth(),
      runIngestFn: async (options) => buildIngestResult(options.out),
      runExtractSkillLlmFn: async (options) =>
        buildSkillExtractionResult(
          options.outDir ?? path.join(tempRoot, "fallback-skill"),
          options.selectedWorkflow!,
        ),
      runGeneralizationFn: async (options) =>
        buildGeneralizationResult(
          options.outDir,
          options.skillPath,
          options.summaryPath,
        ),
      runPlannerOptimizationFn: async (options) =>
        buildPlannerOptimizationResult(
          options.outDir,
          options.skillPath,
          "base",
          options.selectedWorkflowId ?? null,
        ),
    });

    const ready = await service.stopRecording.call(
      await createStartedService(service),
    );
    const workflowPath = path.join(
      ready.paths.workflowDir,
      "manual-workflow.json",
    );
    const workflowArtifact = buildWorkflowArtifact(ready.ingest.latestRunDir!);
    await mkdir(path.dirname(workflowPath), { recursive: true });
    await writeFile(
      workflowPath,
      `${JSON.stringify(workflowArtifact, null, 2)}\n`,
      "utf8",
    );

    const extracted = await service.runSkillExtraction(ready.sessionId, {
      workflowPath,
      workflowId: "workflow-claim",
    });
    await service.runGeneralization(extracted.sessionId, {
      skillPath: extracted.skillExtraction.skillPath!,
    });
    await service.runPlannerOptimization(extracted.sessionId, {
      sourceType: "base",
      skillPath: extracted.skillExtraction.skillPath!,
    });

    const editedSkill: OpenClawSkill = {
      ...extracted.skillExtraction.skill!,
      skillName: "  Claim status check refined  ",
      whenToUse: [
        "Need to confirm the claim status.",
        "need to confirm the claim status.",
        " ",
      ],
      whenNotToUse: [
        " ",
        "Not for filing a new claim.",
        "not for filing a new claim.",
      ],
      inputs: [
        { name: " Tracking Number ", description: "", required: true },
        { name: "tracking number", description: "", required: false },
      ],
      outputs: [
        {
          name: " Status ",
          description: " Latest status ",
          required: false,
        },
      ],
      steps: [
        {
          step: 99,
          instruction: " Open the claim detail. ",
          intent: " Inspect the latest claim status. ",
          operationApp: " Google Chrome ",
          hints: [" Copy the claim id ", "copy the claim id", " "],
        },
        {
          step: 3,
          instruction: " Capture the visible claim status. ",
          intent: " Record the current result. ",
          operationApp: " Google Chrome ",
          hints: [],
        },
      ],
      successCriteria: [
        "The claim status is confirmed.",
        "the claim status is confirmed.",
      ],
      failureModes: [" Missing access ", "missing access"],
      fallback: [" Contact support ", "contact support"],
      examples: [" Example path ", "example path"],
      tags: [" Claims ", "claims"],
      assets: [
        {
          name: " Portal URL ",
          notes: "  ",
          value: [" https://claims.example ", "https://claims.example", ""],
        },
      ],
    };

    const updated = await service.updateSkillArtifact(extracted.sessionId, {
      sourceType: "base",
      skillPath: extracted.skillExtraction.skillPath!,
      skill: editedSkill,
    });

    expect(updated.skillExtraction.skill?.skillName).toBe(
      "Claim status check refined",
    );
    expect(
      updated.skillExtraction.skill?.steps.map((step) => step.step),
    ).toEqual([1, 2]);
    expect(updated.skillExtraction.skill?.steps[0]?.hints).toEqual([
      "Copy the claim id",
    ]);
    expect(updated.skillExtraction.skill?.whenNotToUse).toEqual([
      "Not for filing a new claim.",
    ]);
    expect(updated.skillExtraction.skill?.inputs).toEqual([
      {
        name: "Tracking Number",
        description: "",
        required: true,
      },
    ]);
    expect(updated.skillExtraction.skill?.outputs).toEqual([
      {
        name: "Status",
        description: "Latest status",
      },
    ]);
    expect(updated.skillExtraction.skill?.tags).toEqual(["Claims"]);
    expect(updated.skillExtraction.skill?.assets).toEqual([
      {
        name: "Portal URL",
        value: ["https://claims.example"],
      },
    ]);
    expect(updated.skillExtraction.summary?.stepsCount).toBe(2);
    expect(updated.generalization.artifacts).toHaveLength(0);
    expect(updated.generalization.summary).toBeNull();
    expect(updated.plannerOptimization.skillPath).toBeNull();

    const savedSummary = JSON.parse(
      await readFile(extracted.skillExtraction.summaryPath!, "utf8"),
    ) as SkillExtractionSummary;
    expect(savedSummary.stepsCount).toBe(2);
    expect(savedSummary.output.workflowGraphPath).toBeTruthy();
    expect(savedSummary.output.workflowMarkdownPath).toBeTruthy();
    expect(savedSummary.output.workflowRevisionsDir).toBeTruthy();

    const savedSkill = JSON.parse(
      await readFile(extracted.skillExtraction.skillPath!, "utf8"),
    ) as OpenClawSkill;
    expect(savedSkill.skillName).toBe("Claim status check refined");
    expect(savedSkill.steps).toHaveLength(2);
    const savedGraph = JSON.parse(
      await readFile(savedSummary.output.workflowGraphPath!, "utf8"),
    ) as {
      name?: string;
      nodes?: Array<{ type?: string }>;
      revision?: { number?: number };
    };
    expect(savedGraph.name).toBe("Claim status check refined");
    expect(savedGraph.nodes).toHaveLength(3);
    expect(savedGraph.nodes?.at(-1)?.type).toBe("terminal");
    expect(savedGraph.revision?.number).toBe(1);
  });

  it("clears planner optimization when editing a generalized variant", async () => {
    const recordingProcess = new FakeProcess(609);
    const queryProcess = new FakeProcess(610);

    const service = await createLabService({
      spawnProcess: async (input) =>
        input.command.includes("--disable-vision")
          ? queryProcess
          : recordingProcess,
      probeHealth: buildManagedScreenpipeProbeHealth(),
      runIngestFn: async (options) => buildIngestResult(options.out),
      runExtractSkillLlmFn: async (options) =>
        buildSkillExtractionResult(
          options.outDir ?? path.join(tempRoot, "fallback-skill"),
          options.selectedWorkflow!,
        ),
      runGeneralizationFn: async (options) =>
        buildGeneralizationResult(
          options.outDir,
          options.skillPath,
          options.summaryPath,
        ),
      runPlannerOptimizationFn: async (options) =>
        buildPlannerOptimizationResult(
          options.outDir,
          options.skillPath,
          options.sourceType,
          options.selectedWorkflowId ?? null,
        ),
    });

    const ready = await service.stopRecording.call(
      await createStartedService(service),
    );
    const workflowPath = path.join(
      ready.paths.workflowDir,
      "manual-workflow.json",
    );
    const workflowArtifact = buildWorkflowArtifact(ready.ingest.latestRunDir!);
    await mkdir(path.dirname(workflowPath), { recursive: true });
    await writeFile(
      workflowPath,
      `${JSON.stringify(workflowArtifact, null, 2)}\n`,
      "utf8",
    );

    const extracted = await service.runSkillExtraction(ready.sessionId, {
      workflowPath,
      workflowId: "workflow-claim",
    });
    const generalized = await service.runGeneralization(extracted.sessionId, {
      skillPath: extracted.skillExtraction.skillPath!,
    });
    const generalizedVariant =
      generalized.generalization.summary?.variantArtifacts[0];
    expect(generalizedVariant).toBeTruthy();

    const optimized = await service.runPlannerOptimization(
      generalized.sessionId,
      {
        sourceType: "generalized",
        skillPath: generalizedVariant!.summary.output.skillPath,
      },
    );
    expect(optimized.plannerOptimization.skillPath).toBeTruthy();

    const updated = await service.updateSkillArtifact(generalized.sessionId, {
      sourceType: "generalized",
      skillPath: generalizedVariant!.summary.output.skillPath,
      skill: {
        ...generalizedVariant!.skill,
        skillName: " Generalized claim follow-up ",
      },
    });

    expect(
      updated.generalization.summary?.variantArtifacts[0]?.skill.skillName,
    ).toBe("Generalized claim follow-up");
    expect(updated.plannerOptimization.skillPath).toBeNull();
    expect(updated.plannerOptimization.summary).toBeNull();
  });

  it("installs the base skill into OpenClaw with only the skill path", async () => {
    const recordingProcess = new FakeProcess(801);
    const queryProcess = new FakeProcess(802);
    const seenInstallOptions: Array<{
      skillPath: string;
    }> = [];

    const service = await createLabService({
      spawnProcess: async (input) =>
        input.command.includes("--disable-vision")
          ? queryProcess
          : recordingProcess,
      probeHealth: buildManagedScreenpipeProbeHealth(),
      runIngestFn: async (options) => buildIngestResult(options.out),
      runExtractSkillLlmFn: async (options) =>
        buildSkillExtractionResult(
          options.outDir ?? path.join(tempRoot, "fallback-skill"),
          options.selectedWorkflow!,
        ),
      runOpenClawSkillInstallFn: async (options) => {
        seenInstallOptions.push({
          skillPath: options.skillPath,
        });
        return buildOpenClawInstallResult(options.skillPath);
      },
    });

    const ready = await service.stopRecording.call(
      await createStartedService(service),
    );
    const workflowPath = path.join(
      ready.paths.workflowDir,
      "manual-workflow.json",
    );
    const workflowArtifact = buildWorkflowArtifact(ready.ingest.latestRunDir!);
    await mkdir(path.dirname(workflowPath), { recursive: true });
    await writeFile(
      workflowPath,
      `${JSON.stringify(workflowArtifact, null, 2)}\n`,
      "utf8",
    );

    const extracted = await service.runSkillExtraction(ready.sessionId, {
      workflowPath,
      workflowId: "workflow-claim",
    });
    const installResult = await service.installOpenClawSkill(
      extracted.sessionId,
      {
        sourceType: "base",
        skillPath: extracted.skillExtraction.skillPath!,
      },
    );

    expect(seenInstallOptions).toEqual([
      {
        skillPath: extracted.skillExtraction.skillPath!,
      },
    ]);
    expect(installResult.sourceType).toBe("base");
    expect(installResult.sourceSkillPath).toBe(
      extracted.skillExtraction.skillPath,
    );
  });

  it("installs the planner optimized skill with only the skill path", async () => {
    const recordingProcess = new FakeProcess(803);
    const queryProcess = new FakeProcess(804);
    const seenInstallOptions: Array<{
      skillPath: string;
    }> = [];

    const service = await createLabService({
      spawnProcess: async (input) =>
        input.command.includes("--disable-vision")
          ? queryProcess
          : recordingProcess,
      probeHealth: buildManagedScreenpipeProbeHealth(),
      runIngestFn: async (options) => buildIngestResult(options.out),
      runExtractSkillLlmFn: async (options) =>
        buildSkillExtractionResult(
          options.outDir ?? path.join(tempRoot, "fallback-skill"),
          options.selectedWorkflow!,
        ),
      runPlannerOptimizationFn: async (options) =>
        buildPlannerOptimizationResult(
          options.outDir,
          options.skillPath,
          "base",
          options.selectedWorkflowId ?? null,
        ),
      runOpenClawSkillInstallFn: async (options) => {
        seenInstallOptions.push({
          skillPath: options.skillPath,
        });
        return buildOpenClawInstallResult(options.skillPath);
      },
    });

    const ready = await service.stopRecording.call(
      await createStartedService(service),
    );
    const workflowPath = path.join(
      ready.paths.workflowDir,
      "manual-workflow.json",
    );
    const workflowArtifact = buildWorkflowArtifact(ready.ingest.latestRunDir!);
    await mkdir(path.dirname(workflowPath), { recursive: true });
    await writeFile(
      workflowPath,
      `${JSON.stringify(workflowArtifact, null, 2)}\n`,
      "utf8",
    );

    const extracted = await service.runSkillExtraction(ready.sessionId, {
      workflowPath,
      workflowId: "workflow-claim",
    });
    const optimized = await service.runPlannerOptimization(
      extracted.sessionId,
      {
        sourceType: "base",
        skillPath: extracted.skillExtraction.skillPath!,
      },
    );
    const installResult = await service.installOpenClawSkill(
      optimized.sessionId,
      {
        sourceType: "planner-optimized",
        skillPath: optimized.plannerOptimization.skillPath!,
      },
    );

    expect(seenInstallOptions).toEqual([
      {
        skillPath: optimized.plannerOptimization.skillPath!,
      },
    ]);
    expect(installResult.skillMdPath).toMatch(/SKILL\.md$/u);
  });

  it("rejects OpenClaw install sources that do not belong to the current session", async () => {
    const recordingProcess = new FakeProcess(805);
    const queryProcess = new FakeProcess(806);

    const service = await createLabService({
      spawnProcess: async (input) =>
        input.command.includes("--disable-vision")
          ? queryProcess
          : recordingProcess,
      probeHealth: buildManagedScreenpipeProbeHealth(),
      runIngestFn: async (options) => buildIngestResult(options.out),
      runExtractSkillLlmFn: async (options) =>
        buildSkillExtractionResult(
          options.outDir ?? path.join(tempRoot, "fallback-skill"),
          options.selectedWorkflow!,
        ),
    });

    const ready = await service.stopRecording.call(
      await createStartedService(service),
    );
    const workflowPath = path.join(
      ready.paths.workflowDir,
      "manual-workflow.json",
    );
    const workflowArtifact = buildWorkflowArtifact(ready.ingest.latestRunDir!);
    await mkdir(path.dirname(workflowPath), { recursive: true });
    await writeFile(
      workflowPath,
      `${JSON.stringify(workflowArtifact, null, 2)}\n`,
      "utf8",
    );

    const extracted = await service.runSkillExtraction(ready.sessionId, {
      workflowPath,
      workflowId: "workflow-claim",
    });

    await expect(
      service.installOpenClawSkill(extracted.sessionId, {
        sourceType: "base",
        skillPath: path.join(tempRoot, "foreign", "skill.json"),
      }),
    ).rejects.toThrow(/does not belong to this session/);
  });

  it("exports the selected skill into the configured Skill Manager directory", async () => {
    const recordingProcess = new FakeProcess(901);
    const queryProcess = new FakeProcess(902);
    const seenExportOptions: Array<{
      installRoot: string;
      skillPath: string;
    }> = [];

    const service = await createLabService({
      spawnProcess: async (input) =>
        input.command.includes("--disable-vision")
          ? queryProcess
          : recordingProcess,
      probeHealth: buildManagedScreenpipeProbeHealth(),
      runIngestFn: async (options) => buildIngestResult(options.out),
      runExtractSkillLlmFn: async (options) =>
        buildSkillExtractionResult(
          options.outDir ?? path.join(tempRoot, "fallback-skill"),
          options.selectedWorkflow!,
        ),
      readSkillManagerConfigFn: async () => ({
        skillPath: "/Users/test/.agents/skills",
        updatedAt: "2026-04-16T18:00:00.000Z",
      }),
      runSkillManagerExportFn: async (options) => {
        seenExportOptions.push({
          installRoot: options.installRoot,
          skillPath: options.skillPath,
        });
        return {
          installName: "generated-claim-check",
          installDir: "/Users/test/.agents/skills/generated-claim-check",
          skillMdPath:
            "/Users/test/.agents/skills/generated-claim-check/SKILL.md",
          sourceSkillPath: options.skillPath,
          validation: {
            skill: {
              ok: true,
              skillId: "skill-001",
              stepsCount: 1,
              whenToUseCount: 1,
              prerequisitesCount: 1,
              successCriteriaCount: 1,
            },
          },
        };
      },
    });

    const ready = await service.stopRecording.call(
      await createStartedService(service),
    );
    const workflowPath = path.join(
      ready.paths.workflowDir,
      "manual-workflow.json",
    );
    const workflowArtifact = buildWorkflowArtifact(ready.ingest.latestRunDir!);
    await mkdir(path.dirname(workflowPath), { recursive: true });
    await writeFile(
      workflowPath,
      `${JSON.stringify(workflowArtifact, null, 2)}\n`,
      "utf8",
    );

    const extracted = await service.runSkillExtraction(ready.sessionId, {
      workflowPath,
      workflowId: "workflow-claim",
    });
    const exportResult = await service.exportSkillToManager(
      extracted.sessionId,
      {
        sourceType: "base",
        skillPath: extracted.skillExtraction.skillPath!,
      },
    );

    expect(seenExportOptions).toEqual([
      {
        installRoot: expect.stringMatching(
          /Users[\\/]test[\\/]\.agents[\\/]skills$/,
        ),
        skillPath: extracted.skillExtraction.skillPath!,
      },
    ]);
    expect(toPortablePath(exportResult.installDir)).toMatch(
      /Users\/test\/\.agents\/skills\/generated-claim-check$/,
    );
  });

  it("forwards uninstalls through the configured Skill Manager directory", async () => {
    const seenUninstallOptions: Array<{
      installRoot: string;
      installName: string;
      confirmName?: string;
    }> = [];
    const service = await createLabService({
      readSkillManagerConfigFn: async () => ({
        skillPath: "/Users/test/.agents/skills",
        updatedAt: "2026-04-16T18:00:00.000Z",
      }),
      uninstallInstalledSkillFn: async (options) => {
        seenUninstallOptions.push({
          installRoot: options.installRoot,
          installName: options.installName,
          confirmName: options.confirmName,
        });
        return {
          installName: options.installName,
          installDir: `/Users/test/.agents/skills/${options.installName}`,
          removed: true,
          sourceType: "manual-personal",
        };
      },
    });

    const result = await service.uninstallInstalledSkill("claim-helper", {
      confirmName: "claim-helper",
    });

    expect(seenUninstallOptions).toEqual([
      {
        installRoot: "/Users/test/.agents/skills",
        installName: "claim-helper",
        confirmName: "claim-helper",
      },
    ]);
    expect(result.removed).toBe(true);
  });

  it("forwards manual uninstall confirmation to the OpenClaw skill manager", async () => {
    const seenUninstallOptions: Array<{
      installName: string;
      confirmName?: string;
    }> = [];
    const service = await createLabService({
      uninstallOpenClawPersonalSkillFn: async (options) => {
        seenUninstallOptions.push({
          installName: options.installName,
          confirmName: options.confirmName,
        });
        return {
          installName: options.installName,
          installDir: `/tmp/.agents/skills/${options.installName}`,
          removed: true,
          sourceType: "manual-personal",
        };
      },
    });

    const result = await service.uninstallOpenClawSkill("imessage", {
      confirmName: "imessage",
    });

    expect(seenUninstallOptions).toEqual([
      {
        installName: "imessage",
        confirmName: "imessage",
      },
    ]);
    expect(result.removed).toBe(true);
  });
});

async function createStartedService(
  service: Awaited<ReturnType<typeof createLabService>>,
) {
  await service.startRecording({});
  return service;
}

function buildManagedScreenpipeProbeHealth() {
  let recordingStartupProbeSeen = false;

  return async (baseUrl: string) => {
    if (baseUrl === "http://127.0.0.1:3030" && !recordingStartupProbeSeen) {
      recordingStartupProbeSeen = true;
      return { status: "degraded", status_code: 503 };
    }

    return { status: "healthy", status_code: 200 };
  };
}

async function writeLabLlmConfigFile(
  rootDir: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const configPath = getTempLabLlmConfigPath(rootDir);
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function getTempLabLlmConfigPath(rootDir: string): string {
  return path.join(rootDir, "config", "llm.config.json");
}

function buildExpectedLabCallProfiles(
  overrides: Partial<
    Record<LabLlmCallProfileKey, LabLlmCallProfileUpdateInput>
  > = {},
) {
  return Object.fromEntries(
    LAB_LLM_CALL_PROFILE_KEYS.map((key) => [
      key,
      {
        reasoningEffort: overrides[key]?.reasoningEffort ?? null,
        responseReadTimeoutMs: overrides[key]?.responseReadTimeoutMs ?? null,
      },
    ]),
  ) as Record<
    LabLlmCallProfileKey,
    {
      reasoningEffort: string | null;
      responseReadTimeoutMs: number | null;
    }
  >;
}

function buildIngestResult(
  outDir: string,
): Awaited<
  ReturnType<typeof import("../src/cli/commands/ingest.js").runIngest>
> {
  const runDir = path.join(outDir, "runs", "run-001");
  const summary: IngestSummary = {
    runId: "run-001",
    startedAt: "2026-04-01T10:00:00.000Z",
    completedAt: "2026-04-01T10:00:10.000Z",
    durationMs: 10_000,
    timeWindow: {
      requested: {
        startTs: "2026-04-01T10:00:00.000Z",
        endTs: "2026-04-01T10:00:10.000Z",
        durationMs: 10_000,
      },
      observed: {
        startTs: "2026-04-01T10:00:01.000Z",
        endTs: "2026-04-01T10:00:09.000Z",
        durationMs: 8_000,
      },
    },
    fetch: {
      ocrPages: 1,
      audioPages: 1,
      uiPages: 1,
      rawOcrCount: 7,
      rawAudioCount: 3,
      rawUiEventsCount: 14,
    },
    transform: {
      normalizedCount: 15,
      dedupedCount: 14,
      droppedDuplicates: 1,
    },
    episodes: {
      count: 1,
      avgDurationMs: 10_000,
      medianDurationMs: 10_000,
    },
    warnings: [],
  };

  return {
    manifest: {
      runId: "run-001",
      createdAt: "2026-04-01T10:00:00.000Z",
      status: "success",
      args: {
        from: "2026-04-01T10:00:00.000Z",
        to: "2026-04-01T10:00:10.000Z",
        apps: "*",
        out: outDir,
        baseUrl: "http://localhost:3031",
      },
      paths: {
        runDir,
        rawUiEvents: path.join(runDir, "raw", "ui_events.ndjson"),
        rawOcr: path.join(runDir, "raw", "ocr.ndjson"),
        rawAudio: path.join(runDir, "raw", "audio.ndjson"),
        normalizedEvents: path.join(runDir, "normalized", "events.ndjson"),
        episodes: path.join(runDir, "episodes.json"),
        summary: path.join(runDir, "summary.json"),
      },
      capabilities: null,
      segmenter: {
        idleGapMs: 1,
        appSwitchSplitGapMs: 1,
        maxEpisodeMs: 1,
        version: "segmenter_v1",
      },
      warnings: [],
      error: null,
    },
    summary,
  };
}

function buildWorkflowArtifact(runDir: string): {
  schemaVersion: "openclaw-workflow-discovery-v1";
  generatedAt: string;
  runId: string;
  episodeId: string;
  source: {
    runDir: string;
    startTs: string;
    endTs: string;
  };
  workflowCandidates: WorkflowCandidate[];
  warnings: string[];
} {
  return {
    schemaVersion: "openclaw-workflow-discovery-v1",
    generatedAt: "2026-04-01T10:05:00.000Z",
    runId: "run-001",
    episodeId: "episode-001",
    source: {
      runDir,
      startTs: "2026-04-01T10:00:00.000Z",
      endTs: "2026-04-01T10:00:10.000Z",
    },
    workflowCandidates: [
      {
        workflowId: "workflow-claim",
        name: "Claim status check",
        description: "Check the latest claim detail page.",
        goal: "Confirm the latest claim status.",
        priority: 1,
        confidence: 88,
        startEventId: "e1",
        endEventId: "e2",
        startTs: "2026-04-01T10:00:00.000Z",
        endTs: "2026-04-01T10:00:06.000Z",
        eventCount: 4,
      },
      {
        workflowId: "workflow-notes",
        name: "Write follow-up notes",
        description: "Capture a short summary after the check.",
        goal: "Write short follow-up notes.",
        priority: 2,
        startEventId: "e3",
        endEventId: "e4",
        startTs: "2026-04-01T10:00:06.000Z",
        endTs: "2026-04-01T10:00:10.000Z",
        eventCount: 3,
      },
    ],
    warnings: [],
  };
}

function buildEpisode(): Episode {
  return {
    id: "episode-001",
    runId: "run-001",
    startTs: "2026-04-01T10:00:00.000Z",
    endTs: "2026-04-01T10:00:10.000Z",
    durationMs: 10_000,
    eventsCount: 1,
    events: [],
  };
}

function buildSkillExtractionResult(
  outDir: string,
  selectedWorkflow: WorkflowCandidate,
): Awaited<
  ReturnType<
    typeof import("../src/cli/commands/extract-skill-llm.js").runExtractSkillLlm
  >
> {
  const skill: OpenClawSkill = {
    schemaVersion: "openclaw-skill-v1",
    promptSet: "specific-v13",
    skillId: "skill-001",
    skillName: selectedWorkflow.name,
    generatedAt: "2026-04-01T10:20:00.000Z",
    source: {
      runId: "run-001",
      runDir: "/tmp/run-001",
      episodeId: "episode-001",
      startTs: selectedWorkflow.startTs,
      endTs: selectedWorkflow.endTs,
    },
    executionMode: "autonomous",
    description: selectedWorkflow.description,
    goal: selectedWorkflow.goal,
    whenToUse: ["Need to confirm the claim status."],
    whenNotToUse: [],
    inputs: [],
    outputs: [],
    prerequisites: ["Open the claim system."],
    steps: [
      {
        step: 1,
        instruction: "Open the claim detail.",
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
      totalEvents: 4,
      anchorEvents: 2,
      ocrEvents: 2,
      appsSeen: ["Google Chrome"],
      windowsSeen: ["Claim detail"],
    },
  };
  const summary: SkillExtractionSummary = {
    runId: "run-001",
    episodeId: "episode-001",
    skillId: skill.skillId,
    generatedAt: skill.generatedAt,
    sourceEvents: 4,
    stepsCount: 1,
    workflowCandidates: [selectedWorkflow],
    selectedWorkflowId: selectedWorkflow.workflowId,
    selectedWorkflowPriority: selectedWorkflow.priority,
    output: {
      outDir,
      skillPath: path.join(outDir, "skill.json"),
      summaryPath: path.join(outDir, "summary.json"),
    },
    warnings: [],
  };

  return {
    skill,
    summary,
    paths: {
      outDir,
      skillPath: path.join(outDir, "skill.json"),
      summaryPath: path.join(outDir, "summary.json"),
      workflowGraphPath: path.join(outDir, "workflow.json"),
      workflowMarkdownPath: path.join(outDir, "WORKFLOW.md"),
      workflowRevisionsDir: path.join(outDir, ".workflow-revisions"),
    },
    selectedWorkflow,
    workflowCandidates: [selectedWorkflow],
  };
}

async function buildGeneralizationResult(
  outDir: string,
  sourceSkillPath: string,
  sourceSummaryPath: string,
): Promise<
  Awaited<
    ReturnType<
      typeof import("../src/lab-api/skill-components.js").runLabGeneralization
    >
  >
> {
  const generalizedOutDir = path.join(outDir, "generalized", "01-scenario-one");
  const generalizedSkillPath = path.join(generalizedOutDir, "skill.json");
  const generalizedSummaryPath = path.join(generalizedOutDir, "summary.json");
  const generalizedSkill: OpenClawSkill = {
    schemaVersion: "openclaw-skill-v1",
    promptSet: "specific-v13",
    skillId: "generalized-skill-001",
    skillName: "Generalized claim status check",
    generatedAt: "2026-04-01T10:30:00.000Z",
    source: {
      runId: "run-001",
      runDir: "/tmp/run-001",
      episodeId: "episode-001",
      startTs: "2026-04-01T10:00:00.000Z",
      endTs: "2026-04-01T10:00:06.000Z",
    },
    executionMode: "autonomous",
    description: "Generalized claim workflow.",
    goal: "Check another claim status with the same path.",
    whenToUse: ["Need the same workflow for a different claim."],
    whenNotToUse: [],
    inputs: [],
    outputs: [],
    prerequisites: ["Open the claim system."],
    steps: [
      {
        step: 1,
        instruction: "Open another claim detail.",
        intent: "Reuse the same navigation path.",
        operationApp: "Google Chrome",
        hints: [],
      },
    ],
    successCriteria: ["See the claim status."],
    failureModes: [],
    fallback: [],
    examples: [],
    tags: [],
    assets: [],
    evidence: {
      totalEvents: 4,
      anchorEvents: 1,
      ocrEvents: 1,
      appsSeen: ["Google Chrome"],
      windowsSeen: ["Claim Center"],
    },
  };
  const variantSummary: GeneralizedSkillVariantSummary = {
    schemaVersion: "openclaw-generalized-skill-summary-v1",
    generatedAt: "2026-04-01T10:30:00.000Z",
    sourceSkillId: "skill-001",
    scenarioId: "scenario-one",
    nextUseHypothesis: "Use the same flow for a different claim.",
    skillId: generalizedSkill.skillId,
    output: {
      outDir: generalizedOutDir,
      skillPath: generalizedSkillPath,
      summaryPath: generalizedSummaryPath,
    },
    warnings: [],
  };
  const summary = {
    schemaVersion: "lab-generalization-summary-v1" as const,
    generatedAt: "2026-04-01T10:30:00.000Z",
    sourceSkillPath,
    sourceSummaryPath,
    selectedWorkflowId: "workflow-claim",
    predictedScenariosPath: path.join(outDir, "predicted-scenarios.json"),
    scenarioCount: 1,
    variants: [variantSummary],
    variantArtifacts: [
      {
        summary: variantSummary,
        skill: generalizedSkill,
      },
    ],
    warnings: [],
  };

  await mkdir(generalizedOutDir, { recursive: true });
  await writeFile(
    generalizedSkillPath,
    `${JSON.stringify(generalizedSkill, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    generalizedSummaryPath,
    `${JSON.stringify(variantSummary, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(outDir, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
    "utf8",
  );

  return {
    outDir,
    summaryPath: path.join(outDir, "summary.json"),
    summary,
  };
}

async function buildPlannerOptimizationResult(
  outDir: string,
  sourceSkillPath: string,
  sourceType: "base" | "generalized",
  selectedWorkflowId: string | null,
): Promise<
  Awaited<
    ReturnType<
      typeof import("../src/lab-api/skill-components.js").runLabPlannerOptimization
    >
  >
> {
  const skill: OpenClawSkill = {
    schemaVersion: "openclaw-skill-v1",
    promptSet: "specific-v13",
    skillId: "optimized-skill-001",
    skillName: "Optimized claim status check",
    generatedAt: "2026-04-01T10:40:00.000Z",
    source: {
      runId: "run-001",
      runDir: "/tmp/run-001",
      episodeId: "episode-001",
      startTs: "2026-04-01T10:00:00.000Z",
      endTs: "2026-04-01T10:00:06.000Z",
    },
    executionMode: "autonomous",
    description: "Planner-friendly claim workflow.",
    goal: "Confirm the latest claim status.",
    whenToUse: ["Need a planner-priority claim workflow."],
    whenNotToUse: [],
    inputs: [],
    outputs: [],
    prerequisites: ["Open the claim system."],
    steps: [
      {
        step: 1,
        instruction: "Open the claim detail.",
        intent: "Inspect the latest claim status.",
        operationApp: "Google Chrome",
        hints: [],
      },
    ],
    successCriteria: ["See the claim status."],
    failureModes: [],
    fallback: [],
    examples: [],
    tags: [],
    assets: [],
    evidence: {
      totalEvents: 4,
      anchorEvents: 1,
      ocrEvents: 1,
      appsSeen: ["Google Chrome"],
      windowsSeen: ["Claim Center"],
    },
  };
  const summary = {
    schemaVersion: "lab-planner-optimization-summary-v1" as const,
    generatedAt: "2026-04-01T10:40:00.000Z",
    sourceType,
    sourceSkillPath,
    sourceSkillId: "skill-001",
    sourceSkillName: "Claim status check",
    ...(selectedWorkflowId !== null ? { selectedWorkflowId } : {}),
    output: {
      outDir,
      skillPath: path.join(outDir, "skill.json"),
      summaryPath: path.join(outDir, "summary.json"),
    },
    warnings: [],
  };

  await mkdir(outDir, { recursive: true });
  await writeFile(
    summary.output.skillPath,
    `${JSON.stringify(skill, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    summary.output.summaryPath,
    `${JSON.stringify(summary, null, 2)}\n`,
    "utf8",
  );

  return {
    outDir,
    skillPath: summary.output.skillPath,
    summaryPath: summary.output.summaryPath,
    skill,
    summary,
  };
}

function buildOpenClawInstallResult(
  skillPath: string,
): Awaited<
  ReturnType<
    typeof import("../src/cli/commands/openclaw-skill.js").runOpenClawSkillInstall
  >
> {
  return {
    installName: "generated-claim-check",
    installDir: "/tmp/.agents/skills/generated-claim-check",
    skillMdPath: "/tmp/.agents/skills/generated-claim-check/SKILL.md",
    sourceSkillPath: skillPath,
    validation: {
      skill: {
        ok: true,
        skillId: "skill-001",
        stepsCount: 1,
        whenToUseCount: 1,
        prerequisitesCount: 1,
        successCriteriaCount: 1,
      },
    },
  };
}

function readRecordingLanguageFlags(command: string[]): string[] {
  const languages: string[] = [];
  for (let index = 0; index < command.length; index += 1) {
    if (command[index] !== "--language") {
      continue;
    }
    const nextValue = command[index + 1];
    if (typeof nextValue === "string") {
      languages.push(nextValue);
    }
  }
  return languages;
}

function toPortablePath(filePath: string | null | undefined): string {
  return filePath?.replace(/\\/g, "/") ?? "";
}
