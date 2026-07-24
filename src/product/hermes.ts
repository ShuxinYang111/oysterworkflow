import { execFile, spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";
import dotenv from "dotenv";
import { writeTextAtomic } from "../io/atomic-json.js";
import { getDefaultLlmConfigPath } from "../io/project-paths.js";
import { terminateWindowsProcessTree } from "../process/windows-tree.js";
import {
  allowedProductWorkerChannelCredentialKeys,
  productWorkerChannelConfigFromInput,
  requiredProductWorkerChannelCredentialKeys,
  validateProductWorkerChannelCredentials,
} from "./channels.js";
import { ensureManagedBrowserActCommand } from "./browser-act.js";
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
  connectedHermesProviderHealth,
  degradedHermesProviderHealth,
  normalizeHermesProviderHealth,
  OYSTERWORKFLOW_PROVIDER_STATUS_MARKER,
  parseHermesProviderStatusEvents,
} from "./hermes-provider-status.js";
import type {
  OpenClawSkill,
  OpenClawSkillAsset,
  OpenClawSkillField,
  OpenClawSkillStep,
} from "../types/contracts.js";
import {
  appendWorkflowGraphSkillGuide,
  assertWorkflowGraphSourceSkill,
  loadSiblingWorkflowGraph,
  materializeWorkflowGraphPackage,
  removeWorkflowGraphPackage,
} from "../skill/workflow-graph-package.js";
import { workerUserFacingResponsePolicyLines } from "./worker-presentation.js";

const execFileAsync = promisify(execFile);
const HERMES_COMMAND_ENV_NAME = "OYSTERWORKFLOW_HERMES_COMMAND";
const HERMES_COMMAND_NAME = "hermes";
const HERMES_SKILLS_ROOT_ENV_NAME = "OYSTERWORKFLOW_HERMES_SKILLS_ROOT";
const HERMES_PROFILES_ROOT_ENV_NAME = "OYSTERWORKFLOW_HERMES_PROFILES_ROOT";
const OYSTERWORKFLOW_HERMES_PROVIDER_NAME = "oysterworkflow";
const OYSTERWORKFLOW_HERMES_PROVIDER_REFERENCE = `custom:${OYSTERWORKFLOW_HERMES_PROVIDER_NAME}`;
const OYSTERWORKFLOW_HERMES_KEY_ENV_NAME = "OYSTERWORKFLOW_HERMES_API_KEY";
const OYSTERWORKFLOW_HERMES_PROVIDER_STATUS_PLUGIN = "oysterworkflow_status";
const OYSTERWORKFLOW_COMPUTER_USE_REQUIRED_TOOLSETS = [
  "computer_use",
  "terminal",
  "file",
  "vision",
] as const;
export const HERMES_STATUS_TIMEOUT_MS = 300_000;
const HERMES_MODEL_READINESS_TIMEOUT_MS =
  process.platform === "win32" ? 90_000 : 30_000;
const HERMES_COMMAND_TERMINATION_GRACE_MS = 750;
const HERMES_COMMAND_FORCE_SETTLE_MS = 250;
const HERMES_COMMAND_MAX_BUFFER_BYTES = 1024 * 1024;
const HERMES_STOP_KILL_AFTER_MS = 750;
const HERMES_STOP_FORCE_SETTLE_MS = 250;
const HERMES_CHANNEL_SETUP_TERMINATION_GRACE_MS = 500;
const HERMES_CHANNEL_SETUP_FORCE_SETTLE_MS = 250;
const HERMES_PROCESS_INSPECTION_TIMEOUT_MS = 2_000;
const HERMES_WORKER_OUTPUT_TAIL_BYTES = 2 * 1024 * 1024;
const HERMES_WORKER_READINESS_TAIL_BYTES = 64 * 1024;
const HERMES_PROVIDER_PROTOCOL_PENDING_BYTES = 64 * 1024;
const HERMES_PROGRESS_LOG_POLL_MS = 750;
const HERMES_PROGRESS_LOG_READ_CHUNK_BYTES = 64 * 1024;
const HERMES_PROGRESS_LOG_MAX_BYTES_PER_POLL = 512 * 1024;
const HERMES_PROGRESS_PENDING_MAX_BYTES = 64 * 1024;
const HERMES_PROGRESS_SEEN_LIMIT = 256;
const HERMES_PROGRESS_EVENT_BODY_MAX = 900;
const OYSTERWORKFLOW_SESSION_STATUS_MARKER = "OYSTERWORKFLOW_SESSION_STATUS";
const OYSTER_BROWSER_CLI_ENV_NAME = "OYSTER_BROWSER_CLI";
const OYSTER_BROWSER_PROVIDER_ENV_NAME = "OYSTER_BROWSER_PROVIDER";
const OYSTER_BROWSER_LOG_DIR_ENV_NAME = "OYSTER_BROWSER_LOG_DIR";
const OYSTER_BROWSER_SESSION_ENV_NAME = "OYSTER_BROWSER_SESSION";
const OYSTER_WORKFLOW_RUN_ID_ENV_NAME = "OYSTER_WORKFLOW_RUN_ID";
const OYSTER_BROWSER_PROVIDER_ID = "browseract.chrome-direct";

class ConfiguredHermesCommandError extends Error {
  constructor(readonly commandPath: string) {
    super(`Configured Hermes command is not executable: ${commandPath}`);
  }
}

class HermesCommandExecutionError extends Error {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;

  constructor(input: {
    message: string;
    stdout: string;
    stderr: string;
    code: number | null;
    signal: NodeJS.Signals | null;
  }) {
    super(input.message);
    this.name = "HermesCommandExecutionError";
    this.stdout = input.stdout;
    this.stderr = input.stderr;
    this.code = input.code;
    this.signal = input.signal;
  }
}

export interface HermesConfigSource {
  label: string;
  llmConfigPath: string;
  codexEnvPath?: string | null;
  commandPath?: string | null;
  browserActCommandPath?: string | null;
  runtimeHome?: string | null;
  profilesRoot?: string | null;
  skillsRoot?: string | null;
  resolveMcpServers?: (input: {
    integrationUserId?: string | null;
  }) => Promise<HermesMcpServerConfig[]>;
}

export interface HermesStatusProbeOptions {
  signal?: AbortSignal;
  statusTimeoutMs?: number;
  terminationGraceMs?: number;
  forceSettleMs?: number;
}

export interface HermesMcpServerConfig {
  name: string;
  url: string;
  headers: Record<string, string>;
  timeoutSeconds?: number;
}

interface ResolvedHermesLlmConfig {
  sourceLabel: string;
  configPath: string;
  providerLabel: string;
  model: string;
  baseUrl: string;
  apiMode: "chat_completions" | "codex_responses";
  reasoningEffort: string | null;
  keyEnv: string | null;
  apiKey: string | null;
}

interface StoredLlmConfig {
  provider?: unknown;
  baseUrl?: unknown;
  model?: unknown;
  wireApi?: unknown;
  reasoningEffort?: unknown;
  apiKey?: unknown;
  apiKeyEnv?: unknown;
}

export interface HermesRunResult {
  ok: boolean;
  sessionId: string | null;
  sessionStatus: ProductAgentSessionStatus | null;
  sessionStatusMessage: string | null;
  userAction: string | null;
  output: string;
  errorMessage: string | null;
  providerHealth?: ProductHermesProviderHealth;
}

export interface HermesWorkerTurnHandle {
  pid: number | null;
  ready: Promise<HermesRunResult>;
  completion: Promise<HermesRunResult>;
  stop: () => boolean;
}

export interface HermesAgentProvisionResult {
  profileName: string;
  agentReference: string;
  profilePath: string | null;
  output: string;
}

export interface HermesSkillInstallResult {
  skillName: string;
  skillDir: string;
  skillPath: string;
  skillReference: string;
  installReference: string;
  workflowGraphPath?: string;
  workflowMarkdownPath?: string;
  workflowRevisionsDir?: string;
  workflowRevisionId?: string;
}

export interface HermesWorkerProgressEvent {
  status: string;
  body: string;
  providerHealth?: ProductHermesProviderHealth;
}

export interface HermesGatewayChannelConfigResult {
  channel: ProductWorkerChannelConfig;
}

export interface HermesGatewayChannelTestResult {
  platform: ProductWorkerChannelPlatform;
  status: ProductWorkerChannelConfig["status"];
  lastError: string | null;
  lastTestedAt: string;
}

export interface HermesGatewayChannelSetupSnapshot {
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

export interface HermesGatewayBindingResult {
  platform: ProductWorkerChannelPlatform;
  chatId: string;
  threadId: string | null;
  sessionId: string;
  connectionId: string | null;
}

export interface HermesGatewayPairingApprovalResult {
  platform: ProductWorkerChannelPlatform;
  userId: string;
  userName: string | null;
}

export interface HermesGatewayPeer {
  platform: ProductWorkerChannelPlatform;
  chatId: string;
  threadId: string | null;
  senderId: string | null;
  chatType: string;
  sessionId: string;
  discoveredAt: string;
  bound: boolean;
}

interface HermesGatewayRuntimeStatus {
  gateway_state?: unknown;
  platforms?: Record<string, { state?: unknown; error_message?: unknown }>;
}

interface BoundedHermesCommandOptions {
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  terminationGraceMs?: number;
  forceSettleMs?: number;
  maxBufferBytes: number;
}

interface HermesCommandOutput {
  stdout: string;
  stderr: string;
}

/**
 * EN: Runs a short-lived Hermes command with bounded process-tree termination and settlement.
 * 中文: 运行短时 Hermes 命令，并为整个进程树提供有界终止与最终结算。
 * @param command resolved Hermes launcher or executable.
 * @param args command arguments.
 * @param options environment, timeout, cancellation, and termination bounds.
 * @returns captured stdout and stderr when the command exits successfully.
 */
function runBoundedHermesCommand(
  command: string,
  args: string[],
  options: BoundedHermesCommandOptions,
): Promise<HermesCommandOutput> {
  const terminationGraceMs =
    options.terminationGraceMs ?? HERMES_COMMAND_TERMINATION_GRACE_MS;
  const forceSettleMs = options.forceSettleMs ?? HERMES_COMMAND_FORCE_SETTLE_MS;
  const cancellationDiagnostic =
    "Hermes command was cancelled and terminated. / Hermes 命令已取消并终止。";
  if (options.signal?.aborted) {
    return Promise.reject(
      new HermesCommandExecutionError({
        message: cancellationDiagnostic,
        stdout: "",
        stderr: cancellationDiagnostic,
        code: null,
        signal: null,
      }),
    );
  }

  return new Promise<HermesCommandOutput>((resolveRun, rejectRun) => {
    const useProcessGroup = process.platform !== "win32";
    const commandInvocation = resolveHermesCommandInvocation(command, args);
    const child = spawn(commandInvocation.command, commandInvocation.args, {
      detached: useProcessGroup,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let terminationDiagnostic: string | null = null;
    let settled = false;
    let spawned = false;
    let forceKillTimer: NodeJS.Timeout | null = null;
    let forceSettleTimer: NodeJS.Timeout | null = null;

    const appendOutput = (current: string, chunk: Buffer): string => {
      const availableBytes =
        options.maxBufferBytes - Buffer.byteLength(current, "utf8");
      if (availableBytes <= 0) {
        return current;
      }
      return `${current}${chunk.subarray(0, availableBytes).toString("utf8")}`;
    };
    const stderrWithDiagnostic = (): string =>
      terminationDiagnostic
        ? [stderr.trimEnd(), terminationDiagnostic].filter(Boolean).join("\n")
        : stderr;
    const clearLifecycle = (): void => {
      clearTimeout(timeoutTimer);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      if (forceSettleTimer) {
        clearTimeout(forceSettleTimer);
      }
      options.signal?.removeEventListener("abort", abortCommand);
    };
    const settleOnce = (
      exitCode: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearLifecycle();
      const finalStderr = stderrWithDiagnostic();
      if (terminationDiagnostic || exitCode !== 0) {
        rejectRun(
          new HermesCommandExecutionError({
            message:
              terminationDiagnostic ??
              (finalStderr.trim() ||
                `Hermes command exited with code ${String(exitCode)}.`),
            stdout,
            stderr: finalStderr,
            code: exitCode,
            signal,
          }),
        );
        return;
      }
      resolveRun({ stdout, stderr: finalStderr });
    };
    const beginTermination = (diagnostic: string): void => {
      if (settled || terminationDiagnostic) {
        return;
      }
      terminationDiagnostic = diagnostic;
      signalHermesProcessGroup(child, "SIGTERM", useProcessGroup);
      forceKillTimer = setTimeout(() => {
        if (settled) {
          return;
        }
        signalHermesProcessGroup(child, "SIGKILL", useProcessGroup);
        forceSettleTimer = setTimeout(() => {
          if (settled) {
            return;
          }
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
          settleOnce(null, "SIGKILL");
        }, forceSettleMs);
        forceSettleTimer.unref?.();
      }, terminationGraceMs);
      forceKillTimer.unref?.();
    };
    const abortCommand = (): void => {
      beginTermination(cancellationDiagnostic);
    };
    const timeoutTimer = setTimeout(() => {
      beginTermination(
        `Hermes command timed out after ${options.timeoutMs}ms and was terminated. / Hermes 命令在 ${options.timeoutMs}ms 后超时并已终止。`,
      );
    }, options.timeoutMs);
    timeoutTimer.unref?.();

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendOutput(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendOutput(stderr, chunk);
    });
    child.once("spawn", () => {
      spawned = true;
    });
    child.once("error", (error) => {
      if (settled) {
        return;
      }
      if (spawned) {
        beginTermination(
          `Hermes command process failed: ${error.message} / Hermes 命令进程失败。`,
        );
        return;
      }
      settled = true;
      clearLifecycle();
      child.stdout.destroy();
      child.stderr.destroy();
      rejectRun(error);
    });
    child.stdout.once("error", (error) => {
      beginTermination(
        `Hermes stdout failed: ${error.message} / Hermes 标准输出流失败。`,
      );
    });
    child.stderr.once("error", (error) => {
      beginTermination(
        `Hermes stderr failed: ${error.message} / Hermes 标准错误流失败。`,
      );
    });
    child.once("close", (exitCode, signal) => {
      settleOnce(exitCode, signal);
    });
    options.signal?.addEventListener("abort", abortCommand, { once: true });
    if (options.signal?.aborted) {
      abortCommand();
    }
  });
}

/**
 * EN: Reads local Hermes status without sending a model request.
 * 中文: 读取本机 Hermes 状态，不触发模型调用。
 * @param configSource runtime paths and LLM configuration source.
 * @param options cancellation and bounded command timing overrides.
 * @returns Hermes status fields safe for the product UI.
 */
export async function probeHermesStatus(
  configSource?: HermesConfigSource,
  options: HermesStatusProbeOptions = {},
): Promise<ProductHermesStatus> {
  const checkedAt = new Date().toISOString();
  let hermesCommand =
    configSource?.commandPath ??
    process.env[HERMES_COMMAND_ENV_NAME]?.trim() ??
    HERMES_COMMAND_NAME;
  try {
    hermesCommand = await resolveHermesCommand(configSource);
    const resolvedConfig = await resolveHermesLlmConfig(configSource);
    const runtimeHome = await ensureHermesRuntimeHome(
      resolvedConfig,
      configSource?.runtimeHome,
    );
    const execEnv = buildHermesEnv(resolvedConfig, runtimeHome);
    const { stdout, stderr } = await runBoundedHermesCommand(
      hermesCommand,
      ["status"],
      {
        env: execEnv,
        timeoutMs: options.statusTimeoutMs ?? HERMES_STATUS_TIMEOUT_MS,
        signal: options.signal,
        terminationGraceMs: options.terminationGraceMs,
        forceSettleMs: options.forceSettleMs,
        maxBufferBytes: HERMES_COMMAND_MAX_BUFFER_BYTES,
      },
    );
    const output = `${stdout}\n${stderr}`;
    const [readiness, toolsets] = await Promise.all([
      probeHermesModelReadiness(
        hermesCommand,
        resolvedConfig,
        runtimeHome,
        options,
      ),
      probeHermesToolsets(hermesCommand, resolvedConfig, runtimeHome, options),
    ]);
    const computerUseReady =
      readiness.ok && toolsets.missingComputerUseToolsets.length === 0;
    return {
      command: hermesCommand,
      available: readiness.ok,
      model: resolvedConfig.model ?? matchStatusValue(output, "Model"),
      provider:
        resolvedConfig.providerLabel ?? matchStatusValue(output, "Provider"),
      providerHealth: readiness.ok
        ? connectedHermesProviderHealth({
            provider: resolvedConfig.providerLabel,
            model: resolvedConfig.model,
            checkedAt,
          })
        : degradedHermesProviderHealth({
            provider: resolvedConfig.providerLabel,
            model: resolvedConfig.model,
            message: readiness.errorMessage,
            checkedAt,
          }),
      enabledToolsets: toolsets.enabledToolsets,
      missingComputerUseToolsets: toolsets.missingComputerUseToolsets,
      computerUseReady,
      computerUseSummary: computerUseReady
        ? "Computer control is ready"
        : toolsets.computerUseSummary,
      configSource: resolvedConfig.sourceLabel,
      configPath: resolvedConfig.configPath,
      runtimeHome,
      lastCheckedAt: checkedAt,
      lastProbeSessionId: readiness.sessionId,
      lastError: readiness.errorMessage,
    };
  } catch (error) {
    if (error instanceof ConfiguredHermesCommandError) {
      hermesCommand = error.commandPath;
    }
    return {
      command: hermesCommand,
      available: false,
      model: null,
      provider: null,
      providerHealth: degradedHermesProviderHealth({
        provider: null,
        model: null,
        message: toErrorMessage(error),
        checkedAt,
      }),
      enabledToolsets: [],
      missingComputerUseToolsets: [
        ...OYSTERWORKFLOW_COMPUTER_USE_REQUIRED_TOOLSETS,
      ],
      computerUseReady: false,
      computerUseSummary: "Computer control could not be checked",
      configSource: configSource?.label ?? null,
      configPath: configSource?.llmConfigPath ?? null,
      runtimeHome: configSource?.runtimeHome ?? null,
      lastCheckedAt: checkedAt,
      lastProbeSessionId: null,
      lastError: toErrorMessage(error),
    };
  }
}

async function probeHermesToolsets(
  hermesCommand: string,
  resolvedConfig: ResolvedHermesLlmConfig,
  runtimeHome: string,
  options: HermesStatusProbeOptions,
): Promise<{
  enabledToolsets: string[];
  missingComputerUseToolsets: string[];
  computerUseSummary: string | null;
}> {
  try {
    const { stdout, stderr } = await runBoundedHermesCommand(
      hermesCommand,
      ["tools", "list"],
      {
        env: buildHermesEnv(resolvedConfig, runtimeHome),
        timeoutMs: 20_000,
        signal: options.signal,
        terminationGraceMs: options.terminationGraceMs,
        forceSettleMs: options.forceSettleMs,
        maxBufferBytes: HERMES_COMMAND_MAX_BUFFER_BYTES,
      },
    );
    const enabledToolsets = parseEnabledHermesToolsets(`${stdout}\n${stderr}`);
    const missingComputerUseToolsets =
      OYSTERWORKFLOW_COMPUTER_USE_REQUIRED_TOOLSETS.filter(
        (toolset) => !enabledToolsets.includes(toolset),
      );
    return {
      enabledToolsets,
      missingComputerUseToolsets,
      computerUseSummary:
        missingComputerUseToolsets.length === 0
          ? "Computer control is ready"
          : "Computer control needs setup",
    };
  } catch {
    return {
      enabledToolsets: [],
      missingComputerUseToolsets: [
        ...OYSTERWORKFLOW_COMPUTER_USE_REQUIRED_TOOLSETS,
      ],
      computerUseSummary: "Computer control could not be checked",
    };
  }
}

async function probeHermesModelReadiness(
  hermesCommand: string,
  resolvedConfig: ResolvedHermesLlmConfig,
  runtimeHome: string,
  options: HermesStatusProbeOptions,
): Promise<{
  ok: boolean;
  sessionId: string | null;
  errorMessage: string | null;
}> {
  try {
    const { stdout, stderr } = await runBoundedHermesCommand(
      hermesCommand,
      [
        "chat",
        "--max-turns",
        "1",
        "--source",
        "oysterworkflow-health",
        "--quiet",
        "--query",
        "Return exactly OYSTERWORKFLOW_AI_WORKER_READY.",
      ],
      {
        env: buildHermesEnv(resolvedConfig, runtimeHome),
        timeoutMs: HERMES_MODEL_READINESS_TIMEOUT_MS,
        signal: options.signal,
        terminationGraceMs: options.terminationGraceMs,
        forceSettleMs: options.forceSettleMs,
        maxBufferBytes: HERMES_COMMAND_MAX_BUFFER_BYTES,
      },
    );
    const output = `${stdout}\n${stderr}`;
    return {
      ok: output.includes("OYSTERWORKFLOW_AI_WORKER_READY"),
      sessionId: matchSessionId(output),
      errorMessage: output.includes("OYSTERWORKFLOW_AI_WORKER_READY")
        ? null
        : "Hermes returned without the expected readiness response. Check Hermes provider credentials and run hermes doctor.",
    };
  } catch (error) {
    const output = commandErrorOutput(error);
    return {
      ok: false,
      sessionId: matchSessionId(output),
      errorMessage: conciseHermesError(output) ?? fallbackHermesErrorMessage(),
    };
  }
}

/**
 * EN: Creates or reuses a named Hermes profile for an OysterWorkflow worker.
 * 中文: 为 OysterWorkflow worker 创建或复用一个具名 Hermes profile。
 * @param input worker identity used to derive the Hermes profile name.
 * @returns stable Hermes profile reference stored on the worker.
 */
export async function provisionHermesAgent(input: {
  workerId: string;
  workerName: string;
  configSource?: HermesConfigSource;
}): Promise<HermesAgentProvisionResult> {
  const hermesCommand = await resolveHermesCommand(input.configSource);
  const profileName = profileNameForWorker(input.workerId, input.workerName);
  const existing = await readHermesProfile(
    hermesCommand,
    profileName,
    input.configSource,
  );
  if (existing.ok) {
    await syncHermesProfileConfig(profileName, input.configSource);
    return {
      profileName,
      agentReference: `hermes-profile:${profileName}`,
      profilePath: matchProfilePath(existing.output),
      output: existing.output,
    };
  }

  const createInvocation = resolveHermesCommandInvocation(hermesCommand, [
    "profile",
    "create",
    profileName,
    "--clone",
    "--no-alias",
  ]);
  const created = await execFileAsync(
    createInvocation.command,
    createInvocation.args,
    {
      env: buildHermesProfileEnv(input.configSource),
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    },
  ).catch((error: unknown) => {
    const output = commandErrorOutput(error);
    if (/already exists|exists already/iu.test(output)) {
      return { stdout: output, stderr: "" };
    }
    throw error;
  });
  const checked = await readHermesProfile(
    hermesCommand,
    profileName,
    input.configSource,
  );
  if (!checked.ok) {
    throw new Error(
      conciseHermesError(checked.output) ??
        `Hermes profile ${profileName} could not be created.`,
    );
  }
  await syncHermesProfileConfig(profileName, input.configSource);
  const output = `${created.stdout}\n${created.stderr}\n${checked.output}`;
  return {
    profileName,
    agentReference: `hermes-profile:${profileName}`,
    profilePath: matchProfilePath(output),
    output,
  };
}

/**
 * EN: Writes gateway channel credentials into the worker's Hermes profile.
 * 中文: 将网关渠道凭证写入 worker 对应的 Hermes profile。
 * @param input worker profile reference and channel setup values.
 * @returns sanitized channel config safe to persist in product state.
 */
export async function configureHermesGatewayChannel(input: {
  workerAgentReference: string;
  channel: ProductWorkerChannelInput;
  configSource?: HermesConfigSource;
}): Promise<HermesGatewayChannelConfigResult> {
  const credentialIssues = validateProductWorkerChannelCredentials(
    input.channel.platform,
    input.channel.credentials ?? {},
  );
  if (credentialIssues.length > 0) {
    throw new Error(credentialIssues[0].message);
  }
  const profileDir = resolveHermesProfileDir(
    input.workerAgentReference,
    input.configSource,
  );
  const channel = productWorkerChannelConfigFromInput(input.channel);
  if (channel.platform !== "none") {
    await mkdir(profileDir, { recursive: true });
    const envUpdates = hermesGatewayChannelEnv(input.channel);
    if (Object.keys(envUpdates).length > 0) {
      await upsertEnvValues(join(profileDir, ".env"), envUpdates);
    }
  }
  return { channel };
}

/**
 * EN: Removes one platform from a worker profile, including routes and local credentials.
 * 中文: 从 worker profile 中移除一个平台，包括路由和本地凭证。
 * @param input worker profile, platform, and persisted conversation routes.
 * @returns none after Hermes state and profile files have been updated.
 */
export async function disconnectHermesGatewayChannel(input: {
  workerAgentReference: string;
  platform: Exclude<ProductWorkerChannelPlatform, "none">;
  bindings: Array<{ chatId: string; threadId?: string | null }>;
  configSource?: HermesConfigSource;
}): Promise<void> {
  const hermesCommand = await resolveHermesCommand(input.configSource);
  const profileName = requiredProfileName(input.workerAgentReference);
  const profileDir = resolveHermesProfileDir(
    input.workerAgentReference,
    input.configSource,
  );
  const environment = buildHermesProfileEnv(input.configSource);

  for (const binding of input.bindings) {
    const args = [
      "-p",
      profileName,
      "gateway",
      "bindings",
      "unbind",
      "--platform",
      input.platform,
      "--chat-id",
      binding.chatId,
    ];
    if (binding.threadId?.trim()) {
      args.push("--thread-id", binding.threadId.trim());
    }
    const commandInvocation = resolveHermesCommandInvocation(
      hermesCommand,
      args,
    );
    const { stdout } = await execFileAsync(
      commandInvocation.command,
      commandInvocation.args,
      {
        env: environment,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      },
    );
    const payload = parseLastJsonObject(stdout);
    if (payload?.ok !== true) {
      throw new Error(
        readOptionalString(payload?.error) ??
          `Hermes did not confirm the ${input.platform} route removal.`,
      );
    }
  }

  await removeEnvValues(
    join(profileDir, ".env"),
    allowedProductWorkerChannelCredentialKeys(input.platform),
  );
  for (const pairingRoot of [
    join(profileDir, "platforms", "pairing"),
    join(profileDir, "pairing"),
  ]) {
    await Promise.all([
      rm(join(pairingRoot, `${input.platform}-approved.json`), { force: true }),
      rm(join(pairingRoot, `${input.platform}-pending.json`), { force: true }),
    ]);
  }
  if (input.platform === "whatsapp") {
    await rm(join(profileDir, "whatsapp", "session"), {
      force: true,
      recursive: true,
    });
  }

  const restartInvocation = resolveHermesCommandInvocation(hermesCommand, [
    "-p",
    profileName,
    "gateway",
    "restart",
  ]);
  await execFileAsync(restartInvocation.command, restartInvocation.args, {
    env: environment,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
}

/**
 * EN: Reads Hermes gateway runtime status for a worker channel.
 * 中文: 读取 worker 渠道对应的 Hermes gateway 运行状态。
 * @param input worker profile reference and channel platform.
 * @returns connection test result derived from gateway_state.json.
 */
export async function testHermesGatewayChannel(input: {
  workerAgentReference: string;
  platform: ProductWorkerChannelPlatform;
  configSource?: HermesConfigSource;
}): Promise<HermesGatewayChannelTestResult> {
  const lastTestedAt = new Date().toISOString();
  if (input.platform === "none") {
    return {
      platform: "none",
      status: "not_configured",
      lastTestedAt,
      lastError: "Choose a channel before testing the connection.",
    };
  }

  const profileDir = resolveHermesProfileDir(
    input.workerAgentReference,
    input.configSource,
  );
  const credentialValues = await readHermesGatewayCredentials(profileDir);
  const missingCredentials = requiredProductWorkerChannelCredentialKeys(
    input.platform,
  ).filter(
    (key) =>
      credentialValues[key]?.trim().length === 0 || !credentialValues[key],
  );
  if (missingCredentials.length > 0) {
    return {
      platform: input.platform,
      status: "failed",
      lastTestedAt,
      lastError: `Missing channel credentials: ${missingCredentials.join(", ")}.`,
    };
  }
  const credentialIssues = validateProductWorkerChannelCredentials(
    input.platform,
    credentialValues,
  );
  if (credentialIssues.length > 0) {
    return {
      platform: input.platform,
      status: "failed",
      lastTestedAt,
      lastError: credentialIssues[0].message,
    };
  }

  let runtime: HermesGatewayRuntimeStatus | null = null;
  for (let attempt = 0; attempt < 13; attempt += 1) {
    runtime = await readHermesGatewayRuntimeStatus(profileDir);
    const candidate = runtime?.platforms?.[input.platform] ?? null;
    if (readRuntimeStatusString(candidate?.state) === "connected") {
      break;
    }
    if (attempt < 12) {
      await sleep(750);
    }
  }
  if (!runtime) {
    return {
      platform: input.platform,
      status: "failed",
      lastTestedAt,
      lastError:
        "Gateway runtime status is not available yet. Start the channel gateway and test again.",
    };
  }

  const platformRecord = runtime.platforms?.[input.platform] ?? null;
  const platformState = readRuntimeStatusString(platformRecord?.state);
  if (platformState === "connected") {
    return {
      platform: input.platform,
      status: "connected",
      lastTestedAt,
      lastError: null,
    };
  }
  const message =
    readRuntimeStatusString(platformRecord?.error_message) ??
    (platformState
      ? `Channel is ${platformState}.`
      : `Gateway is ${readRuntimeStatusString(runtime.gateway_state) ?? "unknown"}, but this channel has not connected yet.`);
  return {
    platform: input.platform,
    status: "failed",
    lastTestedAt,
    lastError: message,
  };
}

/**
 * EN: Starts a profile-scoped QR setup subprocess and returns immediately.
 * 中文: 启动指定 Hermes profile 的二维码连接子进程并立即返回。
 * @param input worker profile, platform, and safe setup preferences.
 * @returns initial structured setup snapshot including the subprocess id.
 */
export async function beginHermesGatewayChannelSetup(input: {
  setupId: string;
  workerAgentReference: string;
  platform: "weixin" | "whatsapp";
  mode?: "bot" | "self-chat";
  allowedUsers?: string[];
  configSource?: HermesConfigSource;
}): Promise<HermesGatewayChannelSetupSnapshot> {
  const hermesCommand = await resolveHermesCommand(input.configSource);
  const profileName = requiredProfileName(input.workerAgentReference);
  const profileDir = resolveHermesProfileDir(
    input.workerAgentReference,
    input.configSource,
  );
  const setupDirectory = join(profileDir, "gateway-setups");
  const logPath = join(setupDirectory, `${input.setupId}.log`);
  await mkdir(setupDirectory, { recursive: true });
  const logHandle = await open(logPath, "w", 0o600);
  const args = [
    "-p",
    profileName,
    "gateway",
    "channel-setup",
    "run",
    "--platform",
    input.platform,
    "--setup-id",
    input.setupId,
  ];
  if (input.platform === "whatsapp") {
    args.push("--mode", input.mode ?? "self-chat");
  }
  const allowedUsers = dedupeNonEmpty(input.allowedUsers ?? []).join(",");
  if (allowedUsers) {
    args.push("--allowed-users", allowedUsers);
  }
  const commandInvocation = resolveHermesCommandInvocation(hermesCommand, args);
  const child = spawn(commandInvocation.command, commandInvocation.args, {
    env: buildHermesProfileEnv(input.configSource),
    detached: true,
    stdio: ["ignore", "ignore", logHandle.fd],
    windowsHide: true,
  });
  try {
    await waitForChildSpawn(child);
    const earlyExit = await waitForChildEarlyExit(child, 1_500);
    if (earlyExit) {
      throw new Error(
        await readHermesChannelSetupFailure(logPath, earlyExit.code),
      );
    }
    child.unref();
  } finally {
    await logHandle.close();
  }
  return {
    setupId: input.setupId,
    platform: input.platform,
    status: "starting",
    qrPayload: null,
    qrExpiresAt: null,
    accountLabel: null,
    processId: child.pid ?? null,
    lastError: null,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * EN: Reads the structured, non-secret progress file emitted by Hermes setup.
 * 中文: 读取 Hermes 连接流程写出的结构化、无敏感信息进度文件。
 * @param input worker profile and setup id.
 * @returns latest setup snapshot, or null before the subprocess publishes it.
 */
export async function readHermesGatewayChannelSetup(input: {
  setupId: string;
  workerAgentReference: string;
  platform: "weixin" | "whatsapp";
  processId?: number | null;
  configSource?: HermesConfigSource;
}): Promise<HermesGatewayChannelSetupSnapshot | null> {
  const profileDir = resolveHermesProfileDir(
    input.workerAgentReference,
    input.configSource,
  );
  const content = await readOptionalFile(
    join(profileDir, "gateway-setups", `${input.setupId}.json`),
  );
  if (!content) {
    if (input.processId && !isProcessAlive(input.processId)) {
      return {
        setupId: input.setupId,
        platform: input.platform,
        status: "failed",
        qrPayload: null,
        qrExpiresAt: null,
        accountLabel: null,
        processId: null,
        lastError: await readHermesChannelSetupFailure(
          join(profileDir, "gateway-setups", `${input.setupId}.log`),
          null,
        ),
        updatedAt: new Date().toISOString(),
      };
    }
    return null;
  }
  try {
    const value = JSON.parse(content) as Record<string, unknown>;
    const status = normalizeChannelSetupStatus(value.state);
    return {
      setupId: readOptionalString(value.setupId) ?? input.setupId,
      platform: input.platform,
      status,
      qrPayload: readOptionalString(value.qrPayload),
      qrExpiresAt: channelSetupExpiry(value.expiresAt),
      accountLabel:
        readOptionalString(value.accountLabel) ??
        readOptionalString(value.accountId) ??
        readOptionalString(value.userId),
      ownerUserId: readOptionalString(value.userId),
      processId:
        typeof value.pid === "number" ? value.pid : (input.processId ?? null),
      lastError: readOptionalString(value.error),
      updatedAt:
        readOptionalString(value.updatedAt) ?? new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

/**
 * EN: Cancels a QR setup subprocess owned by OysterWorkflow.
 * 中文: 取消由 OysterWorkflow 启动的二维码连接子进程。
 * @param input subprocess, setup, and worker profile identifiers.
 * @returns true when a termination signal was sent.
 */
export async function cancelHermesGatewayChannelSetup(input: {
  processId: number | null;
  setupId: string;
  workerAgentReference: string;
  configSource?: HermesConfigSource;
}): Promise<boolean> {
  const processId = input.processId;
  let terminated = false;
  if (processId && processId > 0) {
    const profileName = requiredProfileName(input.workerAgentReference);
    const commandLine = await readProcessCommandLine(processId);
    if (
      commandLine &&
      isHermesChannelSetupProcess(commandLine, profileName, input.setupId)
    ) {
      if (process.platform === "win32") {
        terminated = await terminateWindowsProcessTree(
          processId,
          HERMES_CHANNEL_SETUP_TERMINATION_GRACE_MS +
            HERMES_CHANNEL_SETUP_FORCE_SETTLE_MS,
        );
      } else {
        terminated = signalProcessIdOrGroup(processId, "SIGTERM");
        const exitedAfterTerminate = await waitForProcessIdOrGroupExit(
          processId,
          HERMES_CHANNEL_SETUP_TERMINATION_GRACE_MS,
        );
        if (!exitedAfterTerminate) {
          terminated =
            signalProcessIdOrGroup(processId, "SIGKILL") || terminated;
          await waitForProcessIdOrGroupExit(
            processId,
            HERMES_CHANNEL_SETUP_FORCE_SETTLE_MS,
          );
        }
      }
    }
  }
  const profileDir = resolveHermesProfileDir(
    input.workerAgentReference,
    input.configSource,
  );
  await rm(join(profileDir, "gateway-setups", `${input.setupId}.json`), {
    force: true,
  });
  return terminated;
}

/**
 * EN: Persists an explicit conversation-to-session route in Hermes.
 * 中文: 在 Hermes 中持久化指定会话到 worker session 的路由。
 * @param input channel conversation and target worker session.
 * @returns canonical binding returned by the structured Hermes CLI.
 */
export async function bindHermesGatewayConversation(input: {
  workerAgentReference: string;
  platform: ProductWorkerChannelPlatform;
  chatId: string;
  threadId?: string | null;
  sessionId: string;
  connectionId?: string | null;
  configSource?: HermesConfigSource;
}): Promise<HermesGatewayBindingResult> {
  const hermesCommand = await resolveHermesCommand(input.configSource);
  const profileName = requiredProfileName(input.workerAgentReference);
  const args = [
    "-p",
    profileName,
    "gateway",
    "bindings",
    "bind",
    "--platform",
    input.platform,
    "--chat-id",
    input.chatId,
    "--session-id",
    input.sessionId,
  ];
  if (input.threadId?.trim()) {
    args.push("--thread-id", input.threadId.trim());
  }
  if (input.connectionId?.trim()) {
    args.push("--connection-id", input.connectionId.trim());
  }
  const commandInvocation = resolveHermesCommandInvocation(hermesCommand, args);
  const { stdout } = await execFileAsync(
    commandInvocation.command,
    commandInvocation.args,
    {
      env: buildHermesProfileEnv(input.configSource),
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    },
  );
  const payload = parseLastJsonObject(stdout);
  const binding =
    payload && typeof payload.binding === "object" && payload.binding
      ? (payload.binding as Record<string, unknown>)
      : null;
  if (payload?.ok !== true || !binding) {
    throw new Error(
      readOptionalString(payload?.error) ??
        "Hermes did not confirm the channel session binding.",
    );
  }
  return {
    platform: input.platform,
    chatId: readOptionalString(binding.chat_id) ?? input.chatId,
    threadId: readOptionalString(binding.thread_id),
    sessionId: readOptionalString(binding.session_id) ?? input.sessionId,
    connectionId: readOptionalString(binding.connection_id),
  };
}

/**
 * EN: Approves a one-time gateway pairing code through structured Hermes output.
 * 中文: 通过 Hermes 结构化输出批准一次性 Gateway 配对码。
 * @param input worker profile, platform, and user-visible pairing code.
 * @returns approved platform user identity.
 */
export async function approveHermesGatewayPairing(input: {
  workerAgentReference: string;
  platform: ProductWorkerChannelPlatform;
  code: string;
  configSource?: HermesConfigSource;
}): Promise<HermesGatewayPairingApprovalResult> {
  const hermesCommand = await resolveHermesCommand(input.configSource);
  const profileName = requiredProfileName(input.workerAgentReference);
  const commandInvocation = resolveHermesCommandInvocation(hermesCommand, [
    "-p",
    profileName,
    "gateway",
    "bindings",
    "approve-pairing",
    "--platform",
    input.platform,
    "--code",
    input.code.trim().toUpperCase(),
  ]);
  const { stdout } = await execFileAsync(
    commandInvocation.command,
    commandInvocation.args,
    {
      env: buildHermesProfileEnv(input.configSource),
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    },
  );
  const payload = parseLastJsonObject(stdout);
  const pairing =
    payload && typeof payload.pairing === "object" && payload.pairing
      ? (payload.pairing as Record<string, unknown>)
      : null;
  const userId = pairing ? readOptionalString(pairing.user_id) : null;
  if (payload?.ok !== true || !pairing || !userId) {
    throw new Error(
      readOptionalString(payload?.error) ??
        "Hermes did not confirm the pairing approval.",
    );
  }
  return {
    platform: input.platform,
    userId,
    userName: readOptionalString(pairing.user_name),
  };
}

/**
 * EN: Lists conversations the profile gateway has actually observed.
 * 中文: 列出该 profile 的 Gateway 实际收到过消息的会话。
 * @param input worker profile and channel platform.
 * @returns recent conversation candidates for a no-copy-paste binding step.
 */
export async function listHermesGatewayPeers(input: {
  workerAgentReference: string;
  platform: ProductWorkerChannelPlatform;
  configSource?: HermesConfigSource;
}): Promise<HermesGatewayPeer[]> {
  const hermesCommand = await resolveHermesCommand(input.configSource);
  const profileName = requiredProfileName(input.workerAgentReference);
  const commandInvocation = resolveHermesCommandInvocation(hermesCommand, [
    "-p",
    profileName,
    "gateway",
    "bindings",
    "peers",
    "--platform",
    input.platform,
  ]);
  const { stdout } = await execFileAsync(
    commandInvocation.command,
    commandInvocation.args,
    {
      env: buildHermesProfileEnv(input.configSource),
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    },
  );
  const payload = parseLastJsonObject(stdout);
  if (payload?.ok !== true || !Array.isArray(payload.peers)) {
    throw new Error(
      readOptionalString(payload?.error) ??
        "Hermes did not return recent channel conversations.",
    );
  }
  return payload.peers.flatMap((value) => {
    if (!value || typeof value !== "object") {
      return [];
    }
    const peer = value as Record<string, unknown>;
    const chatId = readOptionalString(peer.chat_id);
    const sessionId = readOptionalString(peer.session_id);
    if (!chatId || !sessionId) {
      return [];
    }
    const startedAt =
      typeof peer.started_at === "number" ? peer.started_at : Date.now() / 1000;
    return [
      {
        platform: input.platform,
        chatId,
        threadId: readOptionalString(peer.thread_id),
        senderId: readOptionalString(peer.user_id),
        chatType: readOptionalString(peer.chat_type) ?? "conversation",
        sessionId,
        discoveredAt: new Date(startedAt * 1000).toISOString(),
        bound: peer.is_bound === 1 || peer.is_bound === true,
      },
    ];
  });
}

/**
 * EN: Ensures a profile gateway process is running for inbound discovery.
 * 中文: 确保指定 profile 的 Gateway 正在运行，以便发现入站会话。
 * @param input worker profile reference.
 * @returns none after the start request has been issued.
 */
export async function ensureHermesGatewayRunning(input: {
  workerAgentReference: string;
  reload?: boolean;
  configSource?: HermesConfigSource;
}): Promise<void> {
  const hermesCommand = await resolveHermesCommand(input.configSource);
  const profileName = requiredProfileName(input.workerAgentReference);
  const environment = buildHermesProfileEnv(input.configSource);
  const baseArgs = ["-p", profileName, "gateway"];
  const invokeHermes = (args: string[]) => {
    const commandInvocation = resolveHermesCommandInvocation(
      hermesCommand,
      args,
    );
    return execFileAsync(commandInvocation.command, commandInvocation.args, {
      env: environment,
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
    });
  };
  const configChanged = await syncHermesProfileConfig(
    profileName,
    input.configSource,
  );
  const isRunning = async () => {
    try {
      const status = await invokeHermes([...baseArgs, "status"]);
      return hermesGatewayStatusIsRunning(`${status.stdout}\n${status.stderr}`);
    } catch {
      return false;
    }
  };
  const wasRunning = await isRunning();
  if (wasRunning && !input.reload && !configChanged) return;
  if (wasRunning) {
    try {
      await invokeHermes([...baseArgs, "restart"]);
      await sleep(500);
      if (await isRunning()) return;
    } catch {
      // Fall through to the managed start and foreground fallback paths.
    }
  }
  try {
    await invokeHermes([...baseArgs, "start"]);
  } catch {
    // The profile may not have an installed service; foreground fallback below.
  }
  await sleep(500);
  if (await isRunning()) return;
  const profileDir = resolveHermesProfileDir(
    input.workerAgentReference,
    input.configSource,
  );
  const logDirectory = join(profileDir, "logs");
  const logPath = join(logDirectory, "oysterworkflow-gateway.log");
  await mkdir(logDirectory, { recursive: true });
  const logHandle = await open(logPath, "a", 0o600);
  const gatewayInvocation = resolveHermesCommandInvocation(hermesCommand, [
    ...baseArgs,
    "run",
    "--force",
  ]);
  const child = spawn(gatewayInvocation.command, gatewayInvocation.args, {
    env: environment,
    detached: true,
    stdio: ["ignore", logHandle.fd, logHandle.fd],
    windowsHide: true,
  });
  try {
    await waitForChildSpawn(child);
    const earlyExit = await waitForChildEarlyExit(child, 1_500);
    if (earlyExit) {
      throw new Error(await readHermesGatewayFailure(logPath, earlyExit.code));
    }
    child.unref();
  } finally {
    await logHandle.close();
  }
}

/**
 * EN: Interprets profile-scoped Hermes gateway status without treating "not running" as healthy.
 * 中文: 解析指定 profile 的 Hermes Gateway 状态, 避免把 "not running" 误判为健康。
 * @param output combined gateway status stdout and stderr.
 * @returns whether the selected profile gateway is running.
 */
export function hermesGatewayStatusIsRunning(output: string): boolean {
  const normalized = stripAnsiEscapeSequences(output);
  if (/\bgateway is not running\b/iu.test(normalized)) {
    return false;
  }
  return (
    /\bgateway is running\b/iu.test(normalized) ||
    /\bgateway (?:service )?status:\s*(?:running|active)\b/iu.test(
      normalized,
    ) ||
    /\bgateway is supervised by (?:launchd|systemd)\b/iu.test(normalized)
  );
}

/**
 * EN: Starts a Hermes Agent turn as a background process that can be stopped.
 * 中文: 以后台进程启动 Hermes Agent turn，允许 UI 的 Stop worker 真实终止进程。
 * @param input prompt and runtime context.
 * @returns process handle with readiness and completion promises.
 */
export async function startHermesWorkerTurn(input: {
  prompt: string;
  cwd: string;
  runId?: string | null;
  integrationUserId?: string | null;
  workerAgentReference?: string | null;
  configSource?: HermesConfigSource;
  skills?: string[];
  resumeSessionId?: string | null;
  maxTurns?: number;
  onOutput?: (chunk: { stream: "stdout" | "stderr"; text: string }) => void;
  onProgress?: (event: HermesWorkerProgressEvent) => void;
}): Promise<HermesWorkerTurnHandle> {
  const invocation = await resolveHermesWorkerTurnInvocation(input);
  const stopProgressWatcher =
    invocation.logPath && input.onProgress
      ? await startHermesProgressLogWatcher({
          logPath: invocation.logPath,
          onProgress: input.onProgress,
        })
      : null;
  const useProcessGroup = process.platform !== "win32";
  const workerCommandInvocation = resolveHermesCommandInvocation(
    invocation.hermesCommand,
    invocation.args,
  );
  const child = spawn(
    workerCommandInvocation.command,
    workerCommandInvocation.args,
    {
      cwd: invocation.cwd,
      env: invocation.env,
      detached: useProcessGroup,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let stdout = "";
  let stderr = "";
  let readinessTail = "";
  let observedSessionId: string | null = null;
  let observedSessionStatus = emptyHermesSessionStatus();
  let latestProviderHealth: ProductHermesProviderHealth | null = null;
  let stdoutProviderStatusPending = "";
  let stderrProviderStatusPending = "";
  let stopRequested = false;
  let killTimer: NodeJS.Timeout | null = null;
  let hardSettleTimer: NodeJS.Timeout | null = null;
  let settledReady = false;
  let settledCompletion = false;
  let settleReady: (result: HermesRunResult) => void = () => undefined;
  let settleCompletion: (result: HermesRunResult) => void = () => undefined;
  const ready = new Promise<HermesRunResult>((resolveReady) => {
    settleReady = (result) => {
      if (settledReady) {
        return;
      }
      settledReady = true;
      resolveReady(result);
    };
  });
  const completion = new Promise<HermesRunResult>((resolveCompletion) => {
    settleCompletion = (result) => {
      if (settledCompletion) {
        return;
      }
      settledCompletion = true;
      resolveCompletion(result);
    };
  });

  const currentOutput = () => `${stdout}\n${stderr}`;
  const readyFromOutput = (text: string) => {
    readinessTail = appendUtf8Tail(
      readinessTail,
      text,
      HERMES_WORKER_READINESS_TAIL_BYTES,
    );
    observedSessionId = matchSessionId(readinessTail) ?? observedSessionId;
    const parsedStatus = hermesSessionStatusFromOutput(readinessTail);
    if (parsedStatus.sessionStatus) {
      observedSessionStatus = parsedStatus;
    }
    const output = currentOutput();
    if (
      !readinessTail.includes("OYSTERWORKFLOW_WORKER_READY") &&
      !observedSessionStatus.sessionStatus
    ) {
      return;
    }
    settleReady({
      ok: true,
      sessionId: observedSessionId ?? matchSessionId(output),
      ...observedSessionStatus,
      output,
      errorMessage: null,
      ...(latestProviderHealth ? { providerHealth: latestProviderHealth } : {}),
    });
  };
  const handleWorkerOutput = (stream: "stdout" | "stderr", text: string) => {
    const extracted = extractHermesProviderStatusProtocol(
      stream === "stdout"
        ? stdoutProviderStatusPending
        : stderrProviderStatusPending,
      text,
    );
    if (stream === "stdout") {
      stdoutProviderStatusPending = appendUtf8Tail(
        "",
        extracted.pendingLine,
        HERMES_PROVIDER_PROTOCOL_PENDING_BYTES,
      );
    } else {
      stderrProviderStatusPending = appendUtf8Tail(
        "",
        extracted.pendingLine,
        HERMES_PROVIDER_PROTOCOL_PENDING_BYTES,
      );
    }
    for (const providerHealth of extracted.providerHealthEvents) {
      latestProviderHealth = providerHealth;
      input.onProgress?.(hermesProviderHealthProgressEvent(providerHealth));
    }
    const visibleText = extracted.visibleText;
    if (visibleText.trim().length > 0) {
      input.onOutput?.({ stream, text: visibleText });
    }
  };
  const flushWorkerOutput = () => {
    if (stdoutProviderStatusPending) {
      handleWorkerOutput("stdout", "\n");
    }
    if (stderrProviderStatusPending) {
      handleWorkerOutput("stderr", "\n");
    }
  };

  child.stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stdout = appendUtf8Tail(stdout, text, HERMES_WORKER_OUTPUT_TAIL_BYTES);
    handleWorkerOutput("stdout", text);
    readyFromOutput(text);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stderr = appendUtf8Tail(stderr, text, HERMES_WORKER_OUTPUT_TAIL_BYTES);
    handleWorkerOutput("stderr", text);
    readyFromOutput(text);
  });
  child.once("error", (error) => {
    void (async () => {
      if (killTimer) {
        clearTimeout(killTimer);
      }
      if (hardSettleTimer) {
        clearTimeout(hardSettleTimer);
      }
      await stopProgressWatcher?.();
      flushWorkerOutput();
      const output = `${currentOutput()}\n${toErrorMessage(error)}`;
      const result = {
        ok: false,
        sessionId: matchSessionId(output),
        ...hermesSessionStatusFromOutput(output),
        output,
        errorMessage:
          conciseHermesError(output) ?? fallbackHermesErrorMessage(),
        ...(latestProviderHealth
          ? { providerHealth: latestProviderHealth }
          : {}),
      };
      settleReady(result);
      settleCompletion(result);
    })();
  });
  child.once("close", (code, signal) => {
    if (killTimer) {
      clearTimeout(killTimer);
    }
    if (hardSettleTimer) {
      clearTimeout(hardSettleTimer);
    }
    flushWorkerOutput();
    void (async () => {
      await stopProgressWatcher?.();
      const rawOutput = currentOutput();
      let finalOutput: ResolvedHermesWorkerFinalOutput;
      let exportError: string | null = null;
      try {
        finalOutput =
          code === 0
            ? await resolveHermesWorkerFinalOutput(invocation, rawOutput)
            : {
                output: rawOutput,
                sessionId: matchSessionId(rawOutput),
                sessionStatus: hermesSessionStatusFromOutput(rawOutput),
              };
      } catch (error) {
        exportError = toErrorMessage(error);
        finalOutput = {
          output: rawOutput,
          sessionId: matchSessionId(rawOutput),
          sessionStatus: hermesSessionStatusFromOutput(rawOutput),
        };
      }
      const ok =
        code === 0 && !exportError && finalOutput.output.trim().length > 0;
      const result = {
        ok,
        sessionId: finalOutput.sessionId,
        ...finalOutput.sessionStatus,
        output: finalOutput.output,
        errorMessage: ok
          ? null
          : (exportError ??
            conciseHermesError(rawOutput) ??
            (signal
              ? `Hermes stopped with signal ${signal}.`
              : fallbackHermesErrorMessage())),
        ...(latestProviderHealth
          ? { providerHealth: latestProviderHealth }
          : {}),
      };
      settleReady(result);
      settleCompletion(result);
    })();
  });

  return {
    pid: child.pid ?? null,
    ready,
    completion,
    stop: () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return false;
      }
      if (stopRequested) {
        return false;
      }
      stopRequested = true;
      const stopped = signalHermesProcessGroup(
        child,
        "SIGTERM",
        useProcessGroup,
      );
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          signalHermesProcessGroup(child, "SIGKILL", useProcessGroup);
          hardSettleTimer = setTimeout(() => {
            if (settledCompletion) {
              return;
            }
            child.stdout.destroy();
            child.stderr.destroy();
            child.unref();
            flushWorkerOutput();
            void (async () => {
              await stopProgressWatcher?.();
              const output = currentOutput();
              const finalSessionStatus =
                observedSessionStatus.sessionStatus === null
                  ? hermesSessionStatusFromOutput(output)
                  : observedSessionStatus;
              const result: HermesRunResult = {
                ok: false,
                sessionId: observedSessionId ?? matchSessionId(output),
                ...finalSessionStatus,
                output,
                errorMessage:
                  "Hermes worker was force-stopped after the process did not settle. / Hermes Worker 在进程未及时退出后被强制停止。",
                ...(latestProviderHealth
                  ? { providerHealth: latestProviderHealth }
                  : {}),
              };
              settleReady(result);
              settleCompletion(result);
            })();
          }, HERMES_STOP_FORCE_SETTLE_MS);
          hardSettleTimer.unref?.();
        }
      }, HERMES_STOP_KILL_AFTER_MS);
      killTimer.unref?.();
      return stopped;
    },
  };
}

/**
 * EN: Stops lingering OysterWorkflow Hermes worker processes for one profile.
 * 中文: 按 worker profile 终止遗留的 OysterWorkflow Hermes worker 进程。
 * @param input worker profile reference and optional Hermes runtime config.
 * @returns true when at least one matching process was signaled.
 */
export async function stopHermesWorkerProcesses(input: {
  workerAgentReference: string;
  configSource?: HermesConfigSource;
}): Promise<boolean> {
  const profileName = profileFromAgentReference(input.workerAgentReference);
  if (!profileName) {
    return false;
  }
  const processes = await listSystemProcesses();
  const matchingPids = processes
    .filter((processInfo) =>
      isOysterWorkflowHermesWorkerProcess(processInfo.command, profileName),
    )
    .map((processInfo) => processInfo.pid)
    .filter((pid) => pid !== process.pid);
  if (matchingPids.length === 0) {
    return false;
  }
  return stopHermesProcessIds(dedupeNumbers(matchingPids));
}

function hermesProviderHealthProgressEvent(
  value: ProductHermesProviderHealth,
): HermesWorkerProgressEvent {
  const providerHealth = normalizeHermesProviderHealth(value);
  const label =
    providerHealth.status === "connected"
      ? "LLM provider connected"
      : "LLM provider degraded";
  return {
    status: label,
    body:
      providerHealth.message ??
      (providerHealth.status === "connected"
        ? "LLM provider responded successfully."
        : "LLM provider reported a problem."),
    providerHealth,
  };
}

function extractHermesProviderStatusProtocol(
  pendingLine: string,
  text: string,
): {
  pendingLine: string;
  visibleText: string;
  providerHealthEvents: ProductHermesProviderHealth[];
} {
  const combined = `${pendingLine}${text}`;
  if (
    !pendingLine &&
    !combined.includes(OYSTERWORKFLOW_PROVIDER_STATUS_MARKER) &&
    !isPotentialHermesProviderStatusLine(combined)
  ) {
    return {
      pendingLine: "",
      visibleText: text,
      providerHealthEvents: [],
    };
  }

  const hasTrailingNewline = /\r?\n$/u.test(combined);
  const splitLines = combined.split(/\r?\n/u);
  const nextPendingLine = hasTrailingNewline ? "" : (splitLines.pop() ?? "");
  const completeLines = hasTrailingNewline
    ? splitLines.slice(0, -1)
    : splitLines;
  const visibleLines: string[] = [];
  const providerHealthEvents: ProductHermesProviderHealth[] = [];

  for (const line of completeLines) {
    if (isHermesProviderStatusLine(line)) {
      const events = parseHermesProviderStatusEvents(line);
      providerHealthEvents.push(...events);
      continue;
    }
    visibleLines.push(line);
  }

  let visibleText = visibleLines.join("\n");
  if (visibleText && hasTrailingNewline) {
    visibleText = `${visibleText}\n`;
  }
  if (
    nextPendingLine &&
    !isPotentialHermesProviderStatusLine(nextPendingLine)
  ) {
    visibleText = visibleText
      ? `${visibleText}${visibleText.endsWith("\n") ? "" : "\n"}${nextPendingLine}`
      : nextPendingLine;
    return {
      pendingLine: "",
      visibleText,
      providerHealthEvents,
    };
  }

  return {
    pendingLine: nextPendingLine,
    visibleText,
    providerHealthEvents,
  };
}

function isHermesProviderStatusLine(line: string): boolean {
  return line.trimStart().startsWith(OYSTERWORKFLOW_PROVIDER_STATUS_MARKER);
}

function isPotentialHermesProviderStatusLine(line: string): boolean {
  const trimmed = line.trimStart();
  return (
    trimmed.length > 0 &&
    (OYSTERWORKFLOW_PROVIDER_STATUS_MARKER.startsWith(trimmed) ||
      trimmed.startsWith(OYSTERWORKFLOW_PROVIDER_STATUS_MARKER))
  );
}

function signalHermesProcessGroup(
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals,
  useProcessGroup: boolean,
): boolean {
  if (!child.pid) {
    return false;
  }
  if (process.platform === "win32") {
    void terminateWindowsProcessTree(child.pid).catch(() => undefined);
    return true;
  }
  if (useProcessGroup) {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch {
      // Fall through to the direct child; process groups are best-effort on macOS.
    }
  }
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}

function resolveHermesCommandInvocation(
  command: string,
  args: string[],
): { command: string; args: string[] } {
  if (process.platform !== "win32") {
    return { command, args };
  }
  if (/\.ps1$/iu.test(command)) {
    return {
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        command,
        ...args,
      ],
    };
  }
  if (/\.(?:cmd|bat)$/iu.test(command)) {
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", command, ...args],
    };
  }
  return { command, args };
}

async function readProcessCommandLine(pid: number): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  try {
    if (process.platform === "win32") {
      const script = [
        `$process = Get-CimInstance Win32_Process -Filter "ProcessId = ${String(pid)}" -ErrorAction SilentlyContinue`,
        "if ($null -ne $process) { [Console]::Out.Write($process.CommandLine) }",
      ].join("; ");
      const { stdout } = await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        {
          timeout: HERMES_PROCESS_INSPECTION_TIMEOUT_MS,
          maxBuffer: 64 * 1024,
          windowsHide: true,
        },
      );
      return String(stdout).trim() || null;
    }
    const { stdout } = await execFileAsync(
      "ps",
      ["-p", String(pid), "-o", "command="],
      {
        timeout: HERMES_PROCESS_INSPECTION_TIMEOUT_MS,
        maxBuffer: 64 * 1024,
      },
    );
    return String(stdout).trim() || null;
  } catch {
    return null;
  }
}

function isHermesChannelSetupProcess(
  commandLine: string,
  profileName: string,
  setupId: string,
): boolean {
  return (
    commandLine.includes("gateway") &&
    commandLine.includes("channel-setup") &&
    commandLineArgumentMatches(commandLine, "-p", profileName) &&
    commandLineArgumentMatches(commandLine, "--setup-id", setupId)
  );
}

function commandLineArgumentMatches(
  commandLine: string,
  flag: string,
  value: string,
): boolean {
  return new RegExp(
    `(?:^|\\s)${escapeRegExp(flag)}(?:=|\\s+)["']?${escapeRegExp(value)}(?:["']?(?:\\s|$))`,
    "u",
  ).test(commandLine);
}

async function waitForProcessIdOrGroupExit(
  pid: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessIdOrGroupAlive(pid)) {
      return true;
    }
    await sleep(25);
  }
  return !isProcessIdOrGroupAlive(pid);
}

function isProcessIdOrGroupAlive(pid: number): boolean {
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, 0);
      return true;
    } catch {
      // The process group may be gone while the direct process still exists.
    }
  }
  return isProcessAlive(pid);
}

async function listSystemProcesses(): Promise<
  Array<{ pid: number; command: string }>
> {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,command="], {
    timeout: HERMES_PROCESS_INSPECTION_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout
    .split(/\r?\n/u)
    .map((line) => {
      const match = line.match(/^\s*(\d+)\s+(.+)$/u);
      if (!match) {
        return null;
      }
      return {
        pid: Number(match[1]),
        command: match[2],
      };
    })
    .filter(
      (processInfo): processInfo is { pid: number; command: string } =>
        processInfo !== null && Number.isInteger(processInfo.pid),
    );
}

function isOysterWorkflowHermesWorkerProcess(
  command: string,
  profileName: string,
): boolean {
  return (
    command.includes("--source oysterworkflow-worker") &&
    new RegExp(
      `(?:^|\\s)-p\\s+${escapeRegExp(profileName)}(?:\\s|$)`,
      "u",
    ).test(command)
  );
}

async function stopHermesProcessIds(pids: number[]): Promise<boolean> {
  let signaled = false;
  for (const pid of pids) {
    signaled = signalProcessIdOrGroup(pid, "SIGTERM") || signaled;
  }
  await sleep(HERMES_STOP_KILL_AFTER_MS);
  for (const pid of pids) {
    if (isProcessAlive(pid)) {
      signaled = signalProcessIdOrGroup(pid, "SIGKILL") || signaled;
    }
  }
  return signaled;
}

function signalProcessIdOrGroup(pid: number, signal: NodeJS.Signals): boolean {
  let signaled = false;
  if (process.platform === "win32") {
    void terminateWindowsProcessTree(pid).catch(() => undefined);
    return true;
  }
  try {
    process.kill(-pid, signal);
    signaled = true;
  } catch {
    // Process groups are best-effort for orphan cleanup.
  }
  try {
    process.kill(pid, signal);
    signaled = true;
  } catch {
    // The process may have already exited after the group signal.
  }
  return signaled;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function dedupeNumbers(values: number[]): number[] {
  return Array.from(new Set(values));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForChildSpawn(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
}

/**
 * EN: Gives a newly spawned setup helper a short window to report startup failure.
 * 中文: 给刚启动的渠道连接子进程一个短窗口，用于报告启动失败。
 * @param child spawned Hermes setup process.
 * @param timeoutMs startup observation window.
 * @returns exit details when the process stops early, otherwise null.
 */
function waitForChildEarlyExit(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null } | null> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({
      code: child.exitCode,
      signal: child.signalCode,
    });
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", handleExit);
      resolve(null);
    }, timeoutMs);
    const handleExit = (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      resolve({ code, signal });
    };
    child.once("exit", handleExit);
  });
}

/**
 * EN: Converts a setup subprocess log into a concise user-facing diagnosis.
 * 中文: 将渠道连接子进程日志转换为简洁、可面向用户展示的诊断。
 * @param logPath profile-scoped setup log.
 * @param exitCode optional subprocess exit code.
 * @returns safe diagnosis without QR or credential material.
 */
async function readHermesChannelSetupFailure(
  logPath: string,
  exitCode: number | null,
): Promise<string> {
  const raw = (await readOptionalFile(logPath)) ?? "";
  const normalized = stripAnsiEscapeSequences(raw)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-4)
    .join(" ");
  if (/invalid choice: ['"]channel-setup['"]/iu.test(normalized)) {
    return "The installed AI worker runtime is out of date and cannot start QR setup. Install the latest OysterWorkflow build, then try again.";
  }
  if (normalized) {
    return normalized.slice(0, 600);
  }
  return exitCode === null
    ? "The QR setup process stopped before it produced a connection code. Try again."
    : `The QR setup process stopped before it produced a connection code (exit ${exitCode}). Try again.`;
}

/**
 * EN: Converts a gateway startup log into a concise, credential-safe diagnosis.
 * 中文: 将 Gateway 启动日志转换为简洁且不泄露凭据的诊断。
 * @param logPath profile-scoped gateway log.
 * @param exitCode gateway process exit code.
 * @returns actionable startup failure message.
 */
async function readHermesGatewayFailure(
  logPath: string,
  exitCode: number | null,
): Promise<string> {
  const raw = (await readOptionalFile(logPath)) ?? "";
  const normalized = stripAnsiEscapeSequences(
    raw.replace(/xox[bap]-[A-Za-z0-9-]+/gu, "[redacted Slack token]"),
  )
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-6)
    .join(" ");
  const concise = conciseHermesError(normalized);
  if (concise) {
    return concise.slice(0, 600);
  }
  if (normalized) {
    return normalized.slice(0, 600);
  }
  return exitCode === null
    ? "The channel gateway stopped during startup. Review the app credentials and try again."
    : `The channel gateway stopped during startup (exit ${exitCode}). Review the app credentials and try again.`;
}

function stripAnsiEscapeSequences(value: string): string {
  const escapeCharacter = String.fromCharCode(27);
  return value.replace(new RegExp(`${escapeCharacter}\\[[0-9;]*m`, "gu"), "");
}

async function resolveHermesWorkerTurnInvocation(input: {
  prompt: string;
  cwd: string;
  runId?: string | null;
  integrationUserId?: string | null;
  workerAgentReference?: string | null;
  configSource?: HermesConfigSource;
  skills?: string[];
  resumeSessionId?: string | null;
  maxTurns?: number;
}): Promise<{
  hermesCommand: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  logPath: string | null;
  profileDir: string | null;
  profileName: string | null;
}> {
  const hermesCommand = await resolveHermesCommand(input.configSource);
  const profileName = profileFromAgentReference(input.workerAgentReference);
  const resolvedConfig = await resolveHermesLlmConfig(input.configSource);
  const mcpServers = input.configSource?.resolveMcpServers
    ? await input.configSource.resolveMcpServers({
        integrationUserId: input.integrationUserId,
      })
    : [];
  const runtimeHome = profileName
    ? (input.configSource?.runtimeHome ?? null)
    : await ensureHermesRuntimeHome(
        resolvedConfig,
        input.configSource?.runtimeHome,
        mcpServers,
      );
  if (profileName) {
    await syncHermesProfileConfig(profileName, input.configSource, mcpServers);
  }
  const profileDir = profileName
    ? join(
        resolveHermesProfilesRoot(input.configSource?.profilesRoot),
        profileName,
      )
    : null;
  const browserRuntime = await ensureOysterBrowserRuntime({
    cwd: input.cwd,
    runId: input.runId ?? null,
    profileDir,
    runtimeHome,
    browserActCommandPath: input.configSource?.browserActCommandPath ?? null,
  });
  return {
    hermesCommand,
    cwd: input.cwd,
    env: {
      ...buildHermesEnv(resolvedConfig, runtimeHome),
      ...browserRuntime.env,
    },
    logPath: profileDir ? join(profileDir, "logs", "agent.log") : null,
    profileDir,
    profileName,
    args: [
      ...(profileName ? ["-p", profileName] : []),
      "chat",
      "--max-turns",
      String(input.maxTurns ?? 6),
      "--source",
      "oysterworkflow-worker",
      "--quiet",
      "--yolo",
      ...dedupe(input.skills ?? []).flatMap((skill) => ["--skills", skill]),
      ...(input.resumeSessionId ? ["--resume", input.resumeSessionId] : []),
      "--query",
      input.prompt,
    ],
  };
}

async function ensureOysterBrowserRuntime(input: {
  cwd: string;
  runId: string | null;
  profileDir: string | null;
  runtimeHome: string | null;
  browserActCommandPath: string | null;
}): Promise<{ launcherPath: string; env: Record<string, string> }> {
  await ensureManagedBrowserActCommand(input.browserActCommandPath);
  const runtimeRoot =
    input.profileDir ?? input.runtimeHome ?? join(input.cwd, ".runs", "hermes");
  const binDir = join(runtimeRoot, "bin");
  const logDir = join(runtimeRoot, "logs", "browser-act");
  const launcherPath = join(binDir, "oyster-browser");
  await mkdir(binDir, { recursive: true });
  await mkdir(logDir, { recursive: true });
  await writeFile(launcherPath, renderOysterBrowserLauncher(input.cwd), "utf8");
  await chmod(launcherPath, 0o755).catch(() => undefined);
  const normalizedRunId = input.runId?.trim() || null;
  const browserSession = normalizedRunId
    ? `oyster-${slugifyBrowserSession(normalizedRunId)}`
    : null;
  return {
    launcherPath,
    env: {
      [OYSTER_BROWSER_CLI_ENV_NAME]: launcherPath,
      [OYSTER_BROWSER_PROVIDER_ENV_NAME]: OYSTER_BROWSER_PROVIDER_ID,
      [OYSTER_BROWSER_LOG_DIR_ENV_NAME]: logDir,
      ...(normalizedRunId
        ? { [OYSTER_WORKFLOW_RUN_ID_ENV_NAME]: normalizedRunId }
        : {}),
      ...(browserSession
        ? { [OYSTER_BROWSER_SESSION_ENV_NAME]: browserSession }
        : {}),
      ...(input.browserActCommandPath
        ? { OYSTER_BROWSER_ACT_COMMAND: input.browserActCommandPath }
        : {}),
    },
  };
}

function renderOysterBrowserLauncher(projectRoot: string): string {
  const currentModulePath = fileURLToPath(import.meta.url);
  if (currentModulePath.includes("/src/product/")) {
    return [
      "#!/bin/sh",
      "set -eu",
      `exec npm --prefix ${shellQuote(projectRoot)} run -s dev -- oyster-browser "$@"`,
      "",
    ].join("\n");
  }
  const cliEntrypoint = join(
    dirname(currentModulePath),
    "..",
    "cli",
    "index.js",
  );
  return [
    "#!/bin/sh",
    "set -eu",
    `ELECTRON_RUN_AS_NODE=1 exec ${shellQuote(process.execPath)} ${shellQuote(
      cliEntrypoint,
    )} oyster-browser "$@"`,
    "",
  ].join("\n");
}

function slugifyBrowserSession(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48);
  return normalized || "run";
}

interface ResolvedHermesWorkerFinalOutput {
  output: string;
  sessionId: string | null;
  sessionStatus: ParsedHermesSessionStatus;
}

interface HermesSessionExportInvocation {
  hermesCommand: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  profileName: string | null;
}

/**
 * EN: Replaces Hermes CLI banners with the official exported assistant message.
 * 中文: 用 Hermes 正式导出的 assistant 消息替换 CLI 横幅。
 * @param invocation resolved Hermes profile invocation.
 * @param rawOutput stdout/stderr captured from the Hermes process.
 * @returns user-facing output and parsed session status.
 */
async function resolveHermesWorkerFinalOutput(
  invocation: HermesSessionExportInvocation,
  rawOutput: string,
): Promise<ResolvedHermesWorkerFinalOutput> {
  const sessionId = matchSessionId(rawOutput);
  if (invocation.profileName && !sessionId) {
    throw new Error(
      "Hermes did not report a session id for transcript export.",
    );
  }
  const output = invocation.profileName
    ? await exportLatestHermesAssistantMessage(invocation, sessionId!)
    : rawOutput;
  return {
    output,
    sessionId,
    sessionStatus: hermesSessionStatusFromOutput(`${output}\n${rawOutput}`),
  };
}

async function exportLatestHermesAssistantMessage(
  invocation: HermesSessionExportInvocation,
  sessionId: string,
): Promise<string> {
  let stdout = "";
  let exportDirectory: string | null = null;
  try {
    const needsFileOutput =
      process.platform === "win32" && /\.ps1$/iu.test(invocation.hermesCommand);
    exportDirectory = needsFileOutput
      ? await mkdtemp(join(tmpdir(), "oysterworkflow-hermes-export-"))
      : null;
    const exportTarget = exportDirectory
      ? join(exportDirectory, "session.jsonl")
      : "-";
    const args = [
      ...(invocation.profileName ? ["-p", invocation.profileName] : []),
      "sessions",
      "export",
      exportTarget,
      "--session-id",
      sessionId,
    ];
    const commandInvocation = resolveHermesCommandInvocation(
      invocation.hermesCommand,
      args,
    );
    const result = await execFileAsync(
      commandInvocation.command,
      commandInvocation.args,
      {
        cwd: invocation.cwd,
        env: invocation.env,
        timeout: 30_000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    stdout = exportDirectory
      ? await readFile(join(exportDirectory, "session.jsonl"), "utf8")
      : result.stdout;
  } catch (error) {
    const output = commandErrorOutput(error).trim();
    throw new Error(
      output || `Hermes sessions export failed for ${sessionId}.`,
    );
  } finally {
    if (exportDirectory) {
      await rm(exportDirectory, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  }
  const message = latestAssistantMessageFromSessionExport(stdout);
  if (!message) {
    throw new Error(
      `Hermes sessions export returned no assistant message for ${sessionId}.`,
    );
  }
  return message;
}

function latestAssistantMessageFromSessionExport(
  output: string,
): string | null {
  const session = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseJsonLine)
    .find(isHermesSessionExport);
  const messages = session?.messages ?? [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message &&
      typeof message === "object" &&
      (message as { role?: unknown }).role === "assistant"
    ) {
      const content = (message as { content?: unknown }).content;
      if (typeof content === "string" && content.trim()) {
        return content.trim();
      }
    }
  }
  return null;
}

function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return null;
  }
}

function isHermesSessionExport(
  value: unknown,
): value is { messages: unknown[] } {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    Array.isArray((value as { messages?: unknown }).messages)
  );
}

/**
 * EN: Watches a Hermes profile log and emits concise product-level progress.
 * 中文: 监听 Hermes profile 日志，并抽取简洁的产品级运行进度。
 * @param input log path and progress callback.
 * @returns function that stops log polling.
 */
export async function startHermesProgressLogWatcher(input: {
  logPath: string;
  onProgress: (event: HermesWorkerProgressEvent) => void;
}): Promise<() => Promise<void>> {
  let offset = await readFileSize(input.logPath);
  let pending = "";
  let decoder = new StringDecoder("utf8");
  let stopped = false;
  const seen = new Set<string>();
  const seenOrder: string[] = [];

  const rememberEvent = (key: string): boolean => {
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    seenOrder.push(key);
    while (seenOrder.length > HERMES_PROGRESS_SEEN_LIMIT) {
      const expired = seenOrder.shift();
      if (expired) {
        seen.delete(expired);
      }
    }
    return true;
  };

  const poll = async (force = false) => {
    if (stopped && !force) {
      return;
    }
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    let next = "";
    try {
      handle = await open(input.logPath, "r");
      const size = (await handle.stat()).size;
      if (size < offset) {
        offset = 0;
        pending = "";
        decoder = new StringDecoder("utf8");
      }
      let remaining = Math.min(
        Math.max(0, size - offset),
        HERMES_PROGRESS_LOG_MAX_BYTES_PER_POLL,
      );
      while (remaining > 0) {
        const readLength = Math.min(
          remaining,
          HERMES_PROGRESS_LOG_READ_CHUNK_BYTES,
        );
        const buffer = Buffer.allocUnsafe(readLength);
        const result = await handle.read(buffer, 0, readLength, offset);
        if (result.bytesRead <= 0) {
          break;
        }
        offset += result.bytesRead;
        remaining -= result.bytesRead;
        next += decoder.write(buffer.subarray(0, result.bytesRead));
      }
    } catch {
      return;
    } finally {
      await handle?.close().catch(() => undefined);
    }
    if (force) {
      next += decoder.end();
      decoder = new StringDecoder("utf8");
    }
    if (!next && !(force && pending.trim())) {
      return;
    }
    const lines = `${pending}${next}`.split(/\r?\n/u);
    pending = appendUtf8Tail(
      "",
      lines.pop() ?? "",
      HERMES_PROGRESS_PENDING_MAX_BYTES,
    );
    if (force && pending.trim()) {
      lines.push(pending);
      pending = "";
    }
    for (const line of lines) {
      const events = progressEventsFromHermesLogLine(line);
      for (const event of events) {
        const key = `${event.status}:${event.body}`;
        if (!rememberEvent(key)) {
          continue;
        }
        input.onProgress(event);
      }
    }
  };

  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;
  const scheduleNextPoll = () => {
    if (stopped || timer || inFlight) {
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      if (stopped) {
        return;
      }
      const current = poll().catch(() => undefined);
      inFlight = current;
      void current.finally(() => {
        if (inFlight === current) {
          inFlight = null;
        }
        scheduleNextPoll();
      });
    }, HERMES_PROGRESS_LOG_POLL_MS);
    timer.unref?.();
  };
  scheduleNextPoll();
  return () => {
    if (stopPromise) {
      return stopPromise;
    }
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const activePoll = inFlight;
    stopPromise = (async () => {
      await activePoll?.catch(() => undefined);
      await poll(true).catch(() => undefined);
    })();
    return stopPromise;
  };
}

async function readFileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

function progressEventsFromHermesLogLine(
  line: string,
): HermesWorkerProgressEvent[] {
  const maxIterationsMatch = line.match(
    /Turn ended:\s+reason=max_iterations_reached\((\d+)\/(\d+)\)/iu,
  );
  if (maxIterationsMatch) {
    const [, used, limit] = maxIterationsMatch;
    return [
      {
        status: "AI worker run limit reached",
        body: `AI worker stopped after reaching the maximum tool iterations (${used}/${limit}).`,
      },
    ];
  }

  const toolMatch = line.match(
    /agent\.tool_executor: tool\s+([a-z0-9_-]+)\s+completed\s+\(([^)]+)\)/iu,
  );
  if (toolMatch) {
    const [, toolName, details] = toolMatch;
    return [
      {
        status:
          toolName === "computer_use"
            ? "Desktop action completed"
            : "Tool action completed",
        body:
          toolName === "computer_use"
            ? `Used the assigned computer through computer_use (${details}).`
            : `Used ${toolName} (${details}).`,
      },
    ];
  }

  const visionMatch = line.match(
    /tools\.vision_tools: Image analysis completed \(([^)]+)\)/iu,
  );
  if (visionMatch) {
    return [
      {
        status: "Screen analyzed",
        body: `Analyzed the current desktop screen (${visionMatch[1]}).`,
      },
    ];
  }

  const storedResultMatch = line.match(
    /tools\.tool_result_storage: Persisted large tool result:\s+([a-z0-9_-]+)\s+\(([^)]*?)\s+->\s+(.+?)\)$/iu,
  );
  if (storedResultMatch) {
    const [, toolName, details] = storedResultMatch;
    return [
      {
        status: "Evidence captured",
        body: `Saved ${toolName} evidence (${details.trim()}).`,
      },
    ];
  }

  const warningMatch = line.match(
    /agent\.tool_executor: Tool\s+([a-z0-9_-]+)\s+returned error\s+\(([^)]+)\):\s+(.+)$/iu,
  );
  if (warningMatch) {
    const [, toolName, details, message] = warningMatch;
    return [
      {
        status: "Tool warning",
        body: truncateProgressBody(
          `${toolName} returned an error (${details}): ${stripJsonNoise(
            message,
          )}`,
        ),
      },
    ];
  }

  const driverUpdateMatch = line.match(
    /computer_use: (cua-driver .+?available.+)$/iu,
  );
  if (driverUpdateMatch) {
    return [
      {
        status: "Computer control update available",
        body: driverUpdateMatch[1],
      },
    ];
  }

  return [];
}

function stripJsonNoise(value: string): string {
  return value
    .replace(/^["'{\s]+/u, "")
    .replace(/["'}\s]+$/u, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function truncateProgressBody(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length > HERMES_PROGRESS_EVENT_BODY_MAX
    ? `${normalized.slice(0, HERMES_PROGRESS_EVENT_BODY_MAX - 3)}...`
    : normalized;
}

/**
 * EN: Writes an OysterWorkflow workflow as a local Hermes skill directory.
 * 中文: 将 OysterWorkflow workflow 写成本地 Hermes skill 目录。
 * @param input workflow and worker metadata used to build the skill.
 * @returns installed Hermes skill paths and references.
 */
export async function installHermesSkill(input: {
  workflowId: string;
  workflowTitle: string;
  description: string;
  apps: string[];
  workerAgentReference: string;
  sourceSkillPath?: string | null;
  profilesRoot?: string | null;
  skillsRoot?: string | null;
}): Promise<HermesSkillInstallResult> {
  const skillName = `oysterworkflow-${slugify(input.workflowTitle)}`;
  const skillDir = join(
    resolveHermesSkillsRoot({
      workerAgentReference: input.workerAgentReference,
      profilesRoot: input.profilesRoot,
      skillsRoot: input.skillsRoot,
    }),
    skillName,
  );
  const skillPath = join(skillDir, "SKILL.md");
  if (
    input.sourceSkillPath &&
    resolve(input.sourceSkillPath) === resolve(skillPath)
  ) {
    throw new Error(
      `Cannot install a workflow from its managed Hermes target: ${skillPath}. Use the generated source skill package instead. / 不能从 Hermes 安装目标反向安装工作流，请使用生成阶段的原始 skill 包。`,
    );
  }

  let sourceSkillBody: string | null = null;
  if (input.sourceSkillPath) {
    try {
      sourceSkillBody = await readFile(input.sourceSkillPath, "utf8");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Cannot read workflow source skill: ${input.sourceSkillPath}. ${detail} / 无法读取工作流原始 skill。`,
      );
    }
    if (!sourceSkillBody.trim()) {
      throw new Error(
        `Workflow source skill is empty: ${input.sourceSkillPath}. / 工作流原始 skill 为空。`,
      );
    }
  }
  const sourceWorkflowGraph = input.sourceSkillPath
    ? await loadSiblingWorkflowGraph(input.sourceSkillPath)
    : null;
  const structuredSourceSkill = sourceSkillBody
    ? parseStructuredAgentSkill(sourceSkillBody)
    : null;
  if (sourceWorkflowGraph && structuredSourceSkill) {
    assertWorkflowGraphSourceSkill(
      sourceWorkflowGraph.graph,
      structuredSourceSkill.skillId,
    );
  }
  await mkdir(skillDir, { recursive: true });
  const baseSkillBody = renderHermesSkillBody({
    workflowTitle: input.workflowTitle,
    description: input.description,
    apps: input.apps,
    workflowId: input.workflowId,
    workerAgentReference: input.workerAgentReference,
    sourceSkillBody,
  });
  const skillBody = sourceWorkflowGraph
    ? appendWorkflowGraphSkillGuide(baseSkillBody, sourceWorkflowGraph.graph)
    : baseSkillBody;
  await writeFile(skillPath, skillBody, "utf8");
  const graphArtifacts = sourceWorkflowGraph
    ? await materializeWorkflowGraphPackage({
        graph: sourceWorkflowGraph.graph,
        sourceGraphPath: sourceWorkflowGraph.graphPath,
        targetDir: skillDir,
      })
    : null;
  if (!sourceWorkflowGraph) {
    await removeWorkflowGraphPackage(skillDir);
  }
  await writeFile(
    join(skillDir, "oysterworkflow-install.json"),
    `${JSON.stringify(
      {
        workflowId: input.workflowId,
        workflowTitle: input.workflowTitle,
        workerAgentReference: input.workerAgentReference,
        apps: input.apps,
        installedAt: new Date().toISOString(),
        sourceSkillPath: input.sourceSkillPath ?? null,
        workflowGraph: sourceWorkflowGraph
          ? {
              workflowId: sourceWorkflowGraph.graph.workflowId,
              revisionId: sourceWorkflowGraph.graph.revision.revisionId,
              graphPath: graphArtifacts?.graphPath ?? null,
              markdownPath: graphArtifacts?.markdownPath ?? null,
              revisionsDir: graphArtifacts?.revisionsDir ?? null,
            }
          : null,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return {
    skillName,
    skillDir,
    skillPath,
    skillReference: `hermes-skill:${skillName}`,
    installReference: `hermes-install:${input.workerAgentReference}:${skillName}`,
    ...(sourceWorkflowGraph && graphArtifacts
      ? {
          workflowGraphPath: graphArtifacts.graphPath,
          workflowMarkdownPath: graphArtifacts.markdownPath,
          workflowRevisionsDir: graphArtifacts.revisionsDir,
          workflowRevisionId: sourceWorkflowGraph.graph.revision.revisionId,
        }
      : {}),
  };
}

function renderHermesSkillBody(input: {
  workflowTitle: string;
  description: string;
  apps: string[];
  workflowId: string;
  workerAgentReference: string;
  sourceSkillBody: string | null;
}): string {
  const sourceSkill = input.sourceSkillBody
    ? parseStructuredAgentSkill(input.sourceSkillBody)
    : null;
  if (sourceSkill) {
    return stripLegacyOysterWorkflowExternalActionProtocol(
      renderHermesSkillFromStructuredAgentSkill({
        skill: sourceSkill,
        workflowTitle: input.workflowTitle,
        description: input.description,
        apps: input.apps,
        workflowId: input.workflowId,
        workerAgentReference: input.workerAgentReference,
      }),
    );
  }
  return stripLegacyOysterWorkflowExternalActionProtocol(
    input.sourceSkillBody ??
      renderHermesSkill({
        workflowTitle: input.workflowTitle,
        description: input.description,
        apps: input.apps,
        workflowId: input.workflowId,
        workerAgentReference: input.workerAgentReference,
      }),
  );
}

/**
 * EN: Removes legacy Product-to-Hermes action marker instructions from materialized skills.
 * 中文: 从物化后的 skill 中移除旧版 Product/Hermes 外部动作 marker 协议。
 * @param content Hermes skill Markdown content before installation.
 * @returns Markdown content safe for the current Product message relay.
 */
function stripLegacyOysterWorkflowExternalActionProtocol(
  content: string,
): string {
  const output: string[] = [];
  let skippingActionLogSection = false;

  for (const line of content.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (/^##\s+OysterWorkflow Action Log\s*$/iu.test(trimmed)) {
      skippingActionLogSection = true;
      continue;
    }
    if (skippingActionLogSection) {
      if (!/^##\s+/u.test(trimmed)) {
        continue;
      }
      skippingActionLogSection = false;
    }
    if (trimmed.includes("OYSTERWORKFLOW_EXTERNAL_ACTION")) {
      continue;
    }
    if (
      /external actions are allowed.*oysterworkflow action marker/iu.test(
        trimmed,
      )
    ) {
      continue;
    }
    output.push(line);
  }

  return `${output
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trimEnd()}\n`;
}

function resolveHermesSkillsRoot(input: {
  workerAgentReference?: string | null;
  profilesRoot?: string | null;
  skillsRoot?: string | null;
}): string {
  const profileName = profileFromAgentReference(input.workerAgentReference);
  if (profileName) {
    return join(
      resolveHermesProfilesRoot(input.profilesRoot),
      profileName,
      "skills",
    );
  }
  return (
    input.skillsRoot ??
    process.env[HERMES_SKILLS_ROOT_ENV_NAME] ??
    join(homedir(), ".hermes", "skills")
  );
}

function resolveHermesProfilesRoot(configuredRoot?: string | null): string {
  return (
    configuredRoot ??
    process.env[HERMES_PROFILES_ROOT_ENV_NAME] ??
    join(homedir(), ".hermes", "profiles")
  );
}

/**
 * EN: Resolves the Hermes CLI path for packaged macOS apps that do not inherit a login-shell PATH.
 * 中文: 为不继承登录 shell PATH 的 macOS 打包应用解析 Hermes CLI 路径。
 * @returns executable path or the command name so downstream errors stay diagnostic.
 */
async function resolveHermesCommand(
  configSource?: HermesConfigSource,
): Promise<string> {
  const configured = process.env[HERMES_COMMAND_ENV_NAME]?.trim();
  if (configured) {
    return configured;
  }

  if (configSource?.commandPath) {
    if (await canExecute(configSource.commandPath)) {
      return configSource.commandPath;
    }
    throw new ConfiguredHermesCommandError(configSource.commandPath);
  }

  const pathCommand = await resolveCommandFromPath(HERMES_COMMAND_NAME);
  if (pathCommand) {
    return pathCommand;
  }

  for (const candidate of candidateHermesCommands()) {
    if (await canExecute(candidate)) {
      return candidate;
    }
  }
  return HERMES_COMMAND_NAME;
}

function candidateHermesCommands(): string[] {
  return [
    join(homedir(), ".local", "bin", HERMES_COMMAND_NAME),
    "/opt/homebrew/bin/hermes",
    "/usr/local/bin/hermes",
  ];
}

async function resolveCommandFromPath(command: string): Promise<string | null> {
  if (isAbsolute(command)) {
    return (await canExecute(command)) ? command : null;
  }
  const pathEntries = (process.env.PATH ?? "")
    .split(delimiter)
    .filter((entry) => entry.trim().length > 0);
  for (const entry of pathEntries) {
    const candidate = join(entry, command);
    if (await canExecute(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function canExecute(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function ensureHermesRuntimeHome(
  resolvedConfig: ResolvedHermesLlmConfig,
  runtimeHome?: string | null,
  mcpServers: HermesMcpServerConfig[] = [],
): Promise<string> {
  const home = runtimeHome ?? join(homedir(), ".hermes", "oysterworkflow");
  await writeHermesConfigFiles(home, resolvedConfig, mcpServers);
  return home;
}

async function syncHermesProfileConfig(
  profileName: string,
  configSource?: HermesConfigSource,
  mcpServers: HermesMcpServerConfig[] = [],
): Promise<boolean> {
  const resolvedConfig = await resolveHermesLlmConfig(configSource);
  return writeHermesConfigFiles(
    join(resolveHermesProfilesRoot(configSource?.profilesRoot), profileName),
    resolvedConfig,
    mcpServers,
  );
}

async function writeHermesConfigFiles(
  hermesHome: string,
  resolvedConfig: ResolvedHermesLlmConfig,
  mcpServers: HermesMcpServerConfig[] = [],
): Promise<boolean> {
  await mkdir(hermesHome, { recursive: true });
  const configPath = join(hermesHome, "config.yaml");
  const nextConfig = renderHermesConfigYaml(resolvedConfig, mcpServers);
  const configChanged = (await readOptionalFile(configPath)) !== nextConfig;
  if (configChanged) {
    await writeTextAtomic(configPath, nextConfig, { mode: 0o600 });
  }
  await chmod(configPath, 0o600);
  if (resolvedConfig.keyEnv && resolvedConfig.apiKey) {
    await upsertEnvFile(
      join(hermesHome, ".env"),
      resolvedConfig.keyEnv,
      resolvedConfig.apiKey,
    );
  }
  await writeHermesProviderStatusPlugin(hermesHome);
  return configChanged;
}

async function writeHermesProviderStatusPlugin(
  hermesHome: string,
): Promise<void> {
  const pluginDir = join(
    hermesHome,
    "plugins",
    OYSTERWORKFLOW_HERMES_PROVIDER_STATUS_PLUGIN,
  );
  await mkdir(pluginDir, { recursive: true });
  await writeFile(
    join(pluginDir, "plugin.yaml"),
    renderHermesProviderStatusPluginYaml(),
    "utf8",
  );
  await writeFile(
    join(pluginDir, "__init__.py"),
    renderHermesProviderStatusPluginPython(),
    "utf8",
  );
}

function resolveHermesProfileDir(
  workerAgentReference: string,
  configSource?: HermesConfigSource,
): string {
  const profileName = profileFromAgentReference(workerAgentReference);
  if (!profileName) {
    throw new Error(
      `Invalid AI worker profile reference: ${workerAgentReference}`,
    );
  }
  return join(
    resolveHermesProfilesRoot(configSource?.profilesRoot),
    profileName,
  );
}

function hermesGatewayChannelEnv(
  input: ProductWorkerChannelInput,
): Record<string, string> {
  const rawCredentials = input.credentials ?? {};
  const values: Record<string, string> = {};
  const allowedCredentialKeys = new Set(
    allowedProductWorkerChannelCredentialKeys(input.platform),
  );
  for (const [key, value] of Object.entries(rawCredentials)) {
    if (!allowedCredentialKeys.has(key)) {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      values[key] = trimmed;
    }
  }
  const allowedUsers = (input.allowedUsers ?? [])
    .map((value) => value.trim())
    .filter(Boolean)
    .join(",");
  const homeChannel = input.homeChannel?.trim() ?? "";
  if (input.platform === "telegram") {
    if (homeChannel) {
      values.TELEGRAM_HOME_CHANNEL = homeChannel;
    }
    if (allowedUsers) {
      values.TELEGRAM_ALLOWED_USERS = allowedUsers;
    }
    values.TELEGRAM_ALLOW_ALL_USERS =
      input.accessMode === "allow_all" ? "true" : "false";
  }
  if (input.platform === "slack") {
    if (homeChannel) {
      values.SLACK_HOME_CHANNEL = homeChannel;
    }
    if (allowedUsers) {
      values.SLACK_ALLOWED_USERS = allowedUsers;
    }
    values.SLACK_ALLOW_ALL_USERS =
      input.accessMode === "allow_all" ? "true" : "false";
  }
  if (input.platform === "weixin") {
    if (homeChannel) {
      values.WEIXIN_HOME_CHANNEL = homeChannel;
    }
    values.WEIXIN_ALLOWED_USERS = allowedUsers;
    values.WEIXIN_DM_POLICY = allowedUsers
      ? "allowlist"
      : input.accessMode === "allow_all"
        ? "open"
        : "pairing";
    values.WEIXIN_GROUP_POLICY = "disabled";
  }
  if (input.platform === "whatsapp") {
    values.WHATSAPP_MODE = input.mode ?? "self-chat";
    if (allowedUsers) {
      values.WHATSAPP_ALLOWED_USERS = allowedUsers;
    }
  }
  if (input.platform === "wecom") {
    if (homeChannel) {
      values.WECOM_HOME_CHANNEL = homeChannel;
    }
    if (allowedUsers) {
      values.WECOM_ALLOWED_USERS = allowedUsers;
    }
  }
  return values;
}

async function readHermesGatewayCredentials(
  profileDir: string,
): Promise<Record<string, string>> {
  const envContent = await readOptionalFile(join(profileDir, ".env"));
  return envContent ? dotenv.parse(envContent) : {};
}

async function readHermesGatewayRuntimeStatus(
  profileDir: string,
): Promise<HermesGatewayRuntimeStatus | null> {
  const content = await readOptionalFile(
    join(profileDir, "gateway_state.json"),
  );
  if (!content) {
    return null;
  }
  try {
    const parsed = JSON.parse(content) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as HermesGatewayRuntimeStatus)
      : null;
  } catch {
    return null;
  }
}

function readRuntimeStatusString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

async function resolveHermesLlmConfig(
  configSource?: HermesConfigSource,
): Promise<ResolvedHermesLlmConfig> {
  const stored = await readStoredLlmConfig(configSource?.llmConfigPath);
  const model = readRequiredString(stored.model, "model");
  const baseUrl = normalizeOpenAiCompatibleBaseUrl(
    readRequiredString(stored.baseUrl, "baseUrl"),
  );
  const providerLabel = readOptionalString(stored.provider) ?? "custom";
  const apiMode =
    readOptionalString(stored.wireApi) === "responses"
      ? "codex_responses"
      : "chat_completions";
  const auth = await resolveHermesAuth(stored, configSource?.codexEnvPath);

  return {
    sourceLabel: configSource?.label ?? "OysterWorkflow LLM config",
    configPath: auth.configPath,
    providerLabel,
    model,
    baseUrl,
    apiMode,
    reasoningEffort: readOptionalString(stored.reasoningEffort),
    keyEnv: auth.keyEnv,
    apiKey: auth.apiKey,
  };
}

async function readStoredLlmConfig(
  preferredPath?: string | null,
): Promise<StoredLlmConfig & { __configPath: string }> {
  const candidates = [
    preferredPath,
    preferredPath === getDefaultLlmConfigPath()
      ? null
      : getDefaultLlmConfigPath(),
  ].filter(
    (path): path is string => typeof path === "string" && path.length > 0,
  );

  for (const configPath of candidates) {
    try {
      const parsed = JSON.parse(await readFile(configPath, "utf8")) as unknown;
      if (typeof parsed !== "object" || parsed === null) {
        throw new Error("config root is not an object");
      }
      return {
        ...(parsed as StoredLlmConfig),
        __configPath: configPath,
      };
    } catch (error) {
      const errno = error as NodeJS.ErrnoException;
      if (errno.code === "ENOENT") {
        continue;
      }
      throw new Error(
        `Unable to read OysterWorkflow LLM config at ${configPath}: ${toErrorMessage(
          error,
        )}`,
      );
    }
  }

  throw new Error("No OysterWorkflow LLM config file was found for Hermes.");
}

async function resolveHermesAuth(
  stored: StoredLlmConfig & { __configPath: string },
  codexEnvPath?: string | null,
): Promise<{
  configPath: string;
  keyEnv: string | null;
  apiKey: string | null;
}> {
  const apiKeyEnv = readOptionalString(stored.apiKeyEnv);
  const apiKey = readOptionalString(stored.apiKey);
  const placeholderEnv = apiKey?.match(
    /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/u,
  )?.[1];
  const envName = apiKeyEnv ?? placeholderEnv ?? null;
  if (envName) {
    const codexEnv = await readCodexEnvValues(codexEnvPath);
    return {
      configPath: stored.__configPath,
      keyEnv: envName,
      apiKey: process.env[envName]?.trim() || codexEnv[envName]?.trim() || null,
    };
  }
  if (apiKey) {
    return {
      configPath: stored.__configPath,
      keyEnv: OYSTERWORKFLOW_HERMES_KEY_ENV_NAME,
      apiKey,
    };
  }
  return {
    configPath: stored.__configPath,
    keyEnv: null,
    apiKey: null,
  };
}

/**
 * EN: Reads the configured Codex env file without mutating process.env.
 * 中文: 读取配置的 Codex env 文件, 但不修改当前进程环境变量。
 * @param codexEnvPath env file path provided by Runtime config.
 * @returns parsed env key/value map.
 */
async function readCodexEnvValues(
  codexEnvPath?: string | null,
): Promise<Record<string, string>> {
  if (!codexEnvPath) {
    return {};
  }
  const content = await readOptionalFile(codexEnvPath);
  if (!content) {
    return {};
  }
  return dotenv.parse(content);
}

function buildHermesEnv(
  resolvedConfig: ResolvedHermesLlmConfig,
  runtimeHome?: string | null,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...(runtimeHome ? { HERMES_HOME: runtimeHome } : {}),
    ...(resolvedConfig.keyEnv && resolvedConfig.apiKey
      ? { [resolvedConfig.keyEnv]: resolvedConfig.apiKey }
      : {}),
  };
}

function buildHermesProfileEnv(
  configSource?: HermesConfigSource,
): NodeJS.ProcessEnv {
  const commandPath = configSource?.commandPath?.trim() ?? "";
  const packagedBinMarker = join("Contents", "Resources", "bin");
  const packagedBinDirectory = commandPath.includes(packagedBinMarker)
    ? dirname(commandPath)
    : null;
  const currentPath = process.env.PATH ?? "";
  return {
    ...process.env,
    ...(packagedBinDirectory
      ? {
          PATH: [packagedBinDirectory, currentPath]
            .filter(Boolean)
            .join(delimiter),
        }
      : {}),
    ...(configSource?.runtimeHome
      ? { HERMES_HOME: configSource.runtimeHome }
      : {}),
  };
}

function renderHermesConfigYaml(
  config: ResolvedHermesLlmConfig,
  mcpServers: HermesMcpServerConfig[] = [],
): string {
  const keyEnvLine = config.keyEnv
    ? `  key_env: ${yamlString(config.keyEnv)}\n`
    : "";
  const reasoningLine = config.reasoningEffort
    ? `  reasoning_effort: ${yamlString(config.reasoningEffort)}\n`
    : "";

  const mcpServersYaml = renderHermesMcpServersYaml(mcpServers);

  return `model:
  default: ${yamlString(config.model)}
  provider: ${yamlString(OYSTERWORKFLOW_HERMES_PROVIDER_REFERENCE)}
  base_url: ${yamlString(config.baseUrl)}
  api_mode: ${yamlString(config.apiMode)}
providers: {}
fallback_providers: []
plugins:
  enabled:
  - ${OYSTERWORKFLOW_HERMES_PROVIDER_STATUS_PLUGIN}
custom_providers:
- name: ${yamlString(OYSTERWORKFLOW_HERMES_PROVIDER_NAME)}
  base_url: ${yamlString(config.baseUrl)}
${keyEnvLine}  api_mode: ${yamlString(config.apiMode)}
  model: ${yamlString(config.model)}
auxiliary:
  vision:
    provider: ${yamlString(OYSTERWORKFLOW_HERMES_PROVIDER_NAME)}
    model: ${yamlString(config.model)}
    api_mode: ${yamlString(config.apiMode)}
    timeout: 120
agent:
  max_turns: 90
${reasoningLine}terminal:
  backend: local
  cwd: .
  timeout: 180
streaming:
  enabled: false
${mcpServersYaml}_config_version: 22
`;
}

function renderHermesMcpServersYaml(servers: HermesMcpServerConfig[]): string {
  if (servers.length === 0) {
    return "";
  }
  const entries = servers
    .map((server) => {
      const headers = Object.entries(server.headers)
        .map(
          ([name, value]) => `      ${yamlString(name)}: ${yamlString(value)}`,
        )
        .join("\n");
      return `  ${yamlString(server.name)}:
    url: ${yamlString(server.url)}
    enabled: true
    timeout: ${server.timeoutSeconds ?? 120}
    headers:
${headers || "      {}"}`;
    })
    .join("\n");
  return `mcp_servers:\n${entries}\n`;
}

function renderHermesProviderStatusPluginYaml(): string {
  return `name: ${OYSTERWORKFLOW_HERMES_PROVIDER_STATUS_PLUGIN}
version: 0.2.0
description: "OysterWorkflow provider status observer."
hooks:
  - post_api_request
  - api_request_error
`;
}

function renderHermesProviderStatusPluginPython(): string {
  return `import json
import os
import sys
from datetime import datetime, timezone

MARKER = os.environ.get("OYSTERWORKFLOW_PROVIDER_STATUS", "${OYSTERWORKFLOW_PROVIDER_STATUS_MARKER}")

REASON_META = {
    "auth": ("llm_auth", "needs_user_action", "LLM provider rejected credentials."),
    "billing": ("llm_billing", "needs_user_action", "LLM provider billing or quota needs attention."),
    "rate_limit": ("llm_rate_limit", "retryable", "LLM provider rate limit was reached."),
    "timeout": ("llm_timeout", "retryable", "LLM provider timed out while answering the worker."),
    "overloaded": ("llm_overloaded", "retryable", "LLM provider is overloaded."),
    "network": ("llm_network", "retryable", "LLM provider could not be reached over the network."),
}


def register(ctx):
    ctx.register_hook("post_api_request", on_post_api_request)
    ctx.register_hook("api_request_error", on_api_request_error)


def on_post_api_request(**kwargs):
    _emit(
        {
            "status": "connected",
            "kind": None,
            "recoverability": "ok",
            "provider": _text(kwargs.get("provider")),
            "model": _text(kwargs.get("model") or kwargs.get("response_model")),
            "message": "LLM provider responded successfully.",
            "retryable": False,
            "retryCount": _number(kwargs.get("retry_count")),
            "maxRetries": _number(kwargs.get("max_retries")),
            "statusCode": _number(kwargs.get("status_code")),
        }
    )


def on_api_request_error(**kwargs):
    reason = _text(kwargs.get("reason")) or "unknown"
    kind, recoverability, message = _classify_reason(
        reason, _number(kwargs.get("status_code"))
    )
    _emit(
        {
            "status": "degraded",
            "kind": kind,
            "recoverability": recoverability,
            "provider": _text(kwargs.get("provider")),
            "model": _text(kwargs.get("model")),
            "message": message,
            "retryable": _bool(kwargs.get("retryable")),
            "retryCount": _number(kwargs.get("retry_count")),
            "maxRetries": _number(kwargs.get("max_retries")),
            "statusCode": _number(kwargs.get("status_code")),
        }
    )


def _classify_reason(reason, status_code):
    if reason in REASON_META:
        return REASON_META[reason]
    if status_code in (401, 403):
        return REASON_META["auth"]
    if status_code == 429:
        return REASON_META["rate_limit"]
    if status_code and 500 <= status_code <= 599:
        return REASON_META["overloaded"]
    return (
        "llm_provider_error",
        "unknown",
        "LLM provider reported a problem while answering the worker.",
    )


def _emit(payload):
    payload["checkedAt"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    sys.stderr.write(f"{MARKER} {json.dumps(payload, ensure_ascii=False, separators=(',', ':'))}\\n")
    sys.stderr.flush()


def _text(value):
    return value.strip() if isinstance(value, str) and value.strip() else None


def _number(value):
    return value if isinstance(value, (int, float)) else None


def _bool(value):
    return value if isinstance(value, bool) else None
`;
}

async function upsertEnvFile(
  envPath: string,
  key: string,
  value: string,
): Promise<void> {
  const existing = await readOptionalFile(envPath);
  const nextLine = `${key}=${JSON.stringify(value)}`;
  const lines = (existing ?? "")
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .filter((line) => !line.startsWith(`${key}=`));
  lines.push(nextLine);
  await writeTextAtomic(envPath, `${lines.join("\n")}\n`, {
    mode: 0o600,
    backup: false,
  });
}

async function upsertEnvValues(
  envPath: string,
  values: Record<string, string>,
): Promise<void> {
  const existing = await readOptionalFile(envPath);
  const nextValues = Object.entries(values).filter(
    ([, value]) => value.trim().length > 0,
  );
  if (nextValues.length === 0) {
    return;
  }
  const keys = new Set(nextValues.map(([key]) => key));
  const lines = (existing ?? "")
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .filter((line) => {
      const key = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=/u)?.[1];
      return !key || !keys.has(key);
    });
  for (const [key, value] of nextValues) {
    lines.push(`${key}=${JSON.stringify(value)}`);
  }
  await writeTextAtomic(envPath, `${lines.join("\n")}\n`, {
    mode: 0o600,
    backup: false,
  });
}

async function removeEnvValues(envPath: string, keys: string[]): Promise<void> {
  const existing = await readOptionalFile(envPath);
  if (existing === null) {
    return;
  }
  const removedKeys = new Set(keys);
  const lines = existing
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .filter((line) => {
      const key = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=/u)?.[1];
      return !key || !removedKeys.has(key);
    });
  await writeTextAtomic(
    envPath,
    lines.length > 0 ? `${lines.join("\n")}\n` : "",
    { mode: 0o600, backup: false },
  );
}

function readRequiredString(value: unknown, label: string): string {
  const normalized = readOptionalString(value);
  if (!normalized) {
    throw new Error(`OysterWorkflow LLM config is missing ${label}.`);
  }
  return normalized;
}

function readOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function requiredProfileName(workerAgentReference: string): string {
  const profileName = profileFromAgentReference(workerAgentReference);
  if (!profileName) {
    throw new Error(
      `Invalid AI worker profile reference: ${workerAgentReference}`,
    );
  }
  return profileName;
}

function dedupeNonEmpty(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function parseLastJsonObject(output: string): Record<string, unknown> | null {
  const lines = output
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const value = JSON.parse(lines[index]!) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
    } catch {
      // Continue past harmless CLI banners until the structured result line.
    }
  }
  return null;
}

function normalizeChannelSetupStatus(
  value: unknown,
): ProductChannelSetupStatus {
  if (
    value === "starting" ||
    value === "installing" ||
    value === "awaiting_scan" ||
    value === "authorizing" ||
    value === "connected" ||
    value === "failed" ||
    value === "cancelled"
  ) {
    return value;
  }
  return "starting";
}

function channelSetupExpiry(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value * 1000).toISOString();
  }
  return readOptionalString(value);
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

function normalizeOpenAiCompatibleBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/u, "");
  try {
    const url = new URL(trimmed);
    if (!url.pathname || url.pathname === "/") {
      url.pathname = "/v1";
      return url.toString().replace(/\/$/u, "");
    }
    return trimmed;
  } catch {
    return trimmed;
  }
}

async function readHermesProfile(
  hermesCommand: string,
  profileName: string,
  configSource?: HermesConfigSource,
): Promise<{ ok: boolean; output: string }> {
  try {
    const commandInvocation = resolveHermesCommandInvocation(hermesCommand, [
      "-p",
      profileName,
      "profile",
      "show",
      profileName,
    ]);
    const { stdout, stderr } = await execFileAsync(
      commandInvocation.command,
      commandInvocation.args,
      {
        env: buildHermesProfileEnv(configSource),
        timeout: 20_000,
        maxBuffer: 1024 * 1024,
      },
    );
    return { ok: true, output: `${stdout}\n${stderr}` };
  } catch (error) {
    return { ok: false, output: commandErrorOutput(error) };
  }
}

function matchStatusValue(output: string, label: string): string | null {
  const expression = new RegExp(`${label}:\\s+([^\\n]+)`, "iu");
  const match = output.match(expression);
  return match?.[1]?.trim() ?? null;
}

function parseEnabledHermesToolsets(output: string): string[] {
  const enabled = new Set<string>();
  for (const line of output.split(/\r?\n/u)) {
    const match =
      line.match(/[✓✔]\s*enabled\s+([A-Za-z0-9_-]+)/u) ??
      line.match(/^\s*enabled\s+([A-Za-z0-9_-]+)/iu);
    if (match?.[1]) {
      enabled.add(match[1]);
    }
  }
  return [...enabled].sort();
}

async function readOptionalFile(path: string): Promise<string | null> {
  try {
    await access(path);
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

function profileNameForWorker(workerId: string, workerName: string): string {
  const seed = slugify(`${workerId}-${workerName}`) || "worker";
  return `ow-${seed}`.slice(0, 63).replace(/-$/u, "");
}

function profileFromAgentReference(
  workerAgentReference?: string | null,
): string | null {
  if (!workerAgentReference?.startsWith("hermes-profile:")) {
    return null;
  }
  const profileName = workerAgentReference.slice("hermes-profile:".length);
  return /^[a-z0-9][a-z0-9_-]{0,63}$/u.test(profileName) ? profileName : null;
}

function matchProfilePath(output: string): string | null {
  return output.match(/Path:\s+([^\n]+)/iu)?.[1]?.trim() ?? null;
}

function dedupe(items: string[]): string[] {
  return [...new Set(items.filter((item) => item.trim().length > 0))];
}

function parseStructuredAgentSkill(content: string): OpenClawSkill | null {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!isStructuredAgentSkillLike(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function isStructuredAgentSkillLike(value: unknown): value is OpenClawSkill {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<OpenClawSkill>;
  return (
    candidate.schemaVersion === "openclaw-skill-v1" &&
    typeof candidate.skillName === "string" &&
    typeof candidate.description === "string" &&
    Array.isArray(candidate.steps)
  );
}

function renderHermesSkillFromStructuredAgentSkill(input: {
  skill: OpenClawSkill;
  workflowTitle: string;
  description: string;
  apps: string[];
  workflowId: string;
  workerAgentReference: string;
}): string {
  const skill = input.skill;
  const title =
    markdownLine(skill.skillName || input.workflowTitle) || "Untitled Workflow";
  return [
    ...renderAgentSkillFrontmatter({
      name: title,
      description:
        skill.shortDescription ||
        skill.description ||
        input.description ||
        skill.goal,
    }),
    `# ${title}`,
    "",
    "## Description",
    "",
    markdownParagraph(skill.description || input.description),
    "",
    "## Goal",
    "",
    markdownParagraph(skill.goal || input.description),
    "",
    "## OysterWorkflow",
    "",
    `- Workflow ID: ${input.workflowId}`,
    `- Source Skill ID: ${skill.skillId}`,
    `- Worker Agent: ${input.workerAgentReference}`,
    "- Approval Policy: allow_all",
    "",
    ...renderOysterBrowserUsageGuide(),
    "",
    "## User-facing response policy",
    "",
    ...workerUserFacingResponsePolicyLines().slice(1),
    "",
    "## When To Use",
    "",
    renderStringList(
      skill.whenToUse,
      "Use when OysterWorkflow selects this installed workflow for the worker.",
    ),
    "",
    "## When Not To Use",
    "",
    renderStringList(
      skill.whenNotToUse,
      "Do not use when the current task falls outside the workflow goal or required accounts are unavailable.",
    ),
    "",
    "## Inputs",
    "",
    renderFieldList(skill.inputs, "No explicit inputs recorded."),
    "",
    "## Outputs",
    "",
    renderFieldList(skill.outputs, "No explicit outputs recorded."),
    "",
    "## Prerequisites",
    "",
    renderStringList(
      skill.prerequisites,
      "The assigned device, app accounts, and OysterWorkflow runtime are available.",
    ),
    "",
    "## Steps",
    "",
    renderStepList(skill.steps),
    "",
    "## Success Criteria",
    "",
    renderStringList(
      skill.successCriteria,
      "The workflow objective is complete and the result is visible in the target app or OysterWorkflow run history.",
    ),
    "",
    ...renderOptionalStringListSection("Failure Modes", skill.failureModes),
    ...renderOptionalStringListSection("Fallback", skill.fallback),
    "## Assets",
    "",
    renderAssetList(skill.assets),
    "",
  ].join("\n");
}

function renderAgentSkillFrontmatter(input: {
  name: string;
  description: string;
}): string[] {
  const name = slugify(input.name) || "oysterworkflow-skill";
  const description =
    markdownLine(input.description).slice(0, 280) ||
    "Use this workflow skill with an AI agent.";
  return [
    "---",
    `name: ${JSON.stringify(name)}`,
    `description: ${JSON.stringify(description)}`,
    "---",
    "",
  ];
}

function renderStepList(steps: OpenClawSkillStep[]): string {
  if (steps.length === 0) {
    return "- No steps were recorded. Ask the user before acting.";
  }
  return steps
    .map((step, index) => {
      const number = Number.isFinite(step.step) ? step.step : index + 1;
      const hints = renderIndentedStringList(step.hints);
      return [
        `${number}. **${markdownLine(step.instruction)}**`,
        `   - Intent: ${markdownLine(step.intent || "Follow the captured workflow intent.")}`,
        `   - App: ${markdownLine(step.operationApp || "Desktop app")}`,
        hints ? `   - Hints:\n${hints}` : null,
      ]
        .filter((line): line is string => typeof line === "string")
        .join("\n");
    })
    .join("\n\n");
}

function renderStringList(items: readonly string[], fallback: string): string {
  const normalized = items
    .map((item) => markdownLine(item))
    .filter((item) => item.length > 0);
  if (normalized.length === 0) {
    return `- ${fallback}`;
  }
  return normalized.map((item) => `- ${item}`).join("\n");
}

/**
 * CN: 仅渲染有证据内容的可选字符串列表章节。
 * EN: Renders an optional string-list section only when content exists.
 * @param heading markdown section heading.
 * @param items section values.
 * @returns markdown lines or an empty list.
 */
function renderOptionalStringListSection(
  heading: string,
  items: readonly string[],
): string[] {
  const normalized = items
    .map((item) => markdownLine(item))
    .filter((item) => item.length > 0);
  if (normalized.length === 0) {
    return [];
  }
  return [
    `## ${heading}`,
    "",
    normalized.map((item) => `- ${item}`).join("\n"),
    "",
  ];
}

function renderIndentedStringList(items: readonly string[]): string {
  return items
    .map((item) => markdownLine(item))
    .filter((item) => item.length > 0)
    .map((item) => `     - ${item}`)
    .join("\n");
}

function renderFieldList(
  fields: readonly (OpenClawSkillField | string)[],
  fallback: string,
): string {
  if (fields.length === 0) {
    return `- ${fallback}`;
  }
  return fields
    .map((field) => {
      if (typeof field === "string") {
        return `- ${markdownLine(field)}`;
      }
      const required = field.required ? " Required." : "";
      return `- ${markdownLine(field.name)}: ${markdownLine(field.description)}${required}`;
    })
    .join("\n");
}

function renderAssetList(assets: readonly OpenClawSkillAsset[]): string {
  if (assets.length === 0) {
    return "- No captured assets are required for this skill.";
  }
  return assets
    .map((asset) => {
      const value = Array.isArray(asset.value)
        ? asset.value.join(", ")
        : typeof asset.value === "string"
          ? asset.value
          : Object.entries(asset.value)
              .map(([key, value]) => `${key}: ${value}`)
              .join(", ");
      const notes = asset.notes ? ` Notes: ${markdownLine(asset.notes)}` : "";
      return `- ${markdownLine(asset.name)}: ${markdownLine(value)}${notes}`;
    })
    .join("\n");
}

function renderOysterBrowserUsageGuide(): string[] {
  return [
    "## Connected App Capabilities",
    "",
    "When a workflow step can be completed through an MCP/API/composite provider, use that direct app capability before browser automation, `computer_use`, or AppleScript.",
    "",
    "- Prefer Composio hosted MCP, native MCP tools, or direct app APIs for supported apps such as email, calendar, chat, CRM, docs, sheets, storage, and issue trackers.",
    "- Use UI automation when the direct capability is unavailable, cannot express the needed action, requires login/MFA/account selection, or visual confirmation is necessary.",
    "",
    "## BrowserAct Browser",
    "",
    "When any workflow step requires a website, browser, Chrome, or web app and cannot be completed through a direct app capability, start with the OysterWorkflow BrowserAct wrapper exposed at `$OYSTER_BROWSER_CLI`.",
    "",
    "- Browser automation priority after direct app capabilities: `$OYSTER_BROWSER_CLI` first, then Hermes built-in browser automation, then `computer_use`, then AppleScript/`osascript`/System Events only as the last fallback.",
    "- Native desktop app priority after direct app capabilities: `computer_use` first, then AppleScript/`osascript`/System Events only as the last fallback.",
    "- Browser provider: BrowserAct chrome-direct, using the user's current local Chrome login state.",
    "- Permission model: allow_all. You may click, type, select, upload, submit, navigate, inspect network traffic, run page JavaScript, and take screenshots when the workflow calls for it.",
    "- Required boundary: avoid temporary browser sessions for login-dependent browser work unless `$OYSTER_BROWSER_CLI` and the current local Chrome state cannot be used and the task can still be completed safely. Do not call raw `browser-act`, Playwright, or raw Chrome DevTools for browser work. Use `$OYSTER_BROWSER_CLI` before built-in browser or visual/browser fallbacks.",
    "- Recovery behavior: `open` may let BrowserAct restart local Chrome when chrome-direct is stale, while preserving the user's normal Chrome profile.",
    "- Computer Use rule: before every `computer_use` action, verify the foreground app/window is the intended target. If the user changed the desktop unexpectedly, restore focus once or report `waiting_for_user` with the target app/window needed.",
    "- Failure rule: if `$OYSTER_BROWSER_CLI` fails because Chrome cannot be attached or no active browser session exists, try Hermes built-in browser automation before `computer_use` on the visible target browser. Use AppleScript only as the last fallback. If login, MFA, or permission is blocked, report `waiting_for_user` with the wrapper diagnostic.",
    "- Evidence rule: use only evidence from the current run and current app/browser/tool state. Do not treat previous run summaries, old session history, cached draft claims, or cached CRM claims as proof of completion.",
    "- Skill rule: do not rewrite, self-improve, or create skills during workflow execution unless the user explicitly asks for skill editing.",
    "- Noise rule: avoid repeated full-screen `computer_use` captures. Prefer targeted browser/tool/app evidence; if `computer_use` output is too large, switch methods or report the specific foreground app/window needed.",
    "- Session rule: use a stable JSON `session` for the run, such as `workflow-<short-name>`. If you omit `session`, the wrapper derives a run-scoped session from `OYSTER_WORKFLOW_RUN_ID`. Reuse the same session until the browser work is complete, then call `close`.",
    "- Normal loop: `open` or `navigate`, then `state`, then interact with indexes from `state`, then `wait`, then verify with `state`, `get`, `eval`, or `screenshot`.",
    "",
    "Examples:",
    "",
    '```bash\n"$OYSTER_BROWSER_CLI" open --json \'{"session":"yc-review","url":"https://www.ycombinator.com/co-founder-matching"}\'\n"$OYSTER_BROWSER_CLI" state --json \'{"session":"yc-review"}\'\n"$OYSTER_BROWSER_CLI" click --json \'{"session":"yc-review","index":7}\'\n"$OYSTER_BROWSER_CLI" input --json \'{"session":"yc-review","index":3,"text":"message"}\'\n"$OYSTER_BROWSER_CLI" wait --json \'{"session":"yc-review","mode":"stable"}\'\n"$OYSTER_BROWSER_CLI" screenshot --json \'{"session":"yc-review","path":".runs/yc-review.png","full":true}\'\n"$OYSTER_BROWSER_CLI" close --json \'{"session":"yc-review"}\'\n```',
  ];
}

function renderHermesSkill(input: {
  workflowTitle: string;
  description: string;
  apps: string[];
  workflowId: string;
  workerAgentReference: string;
}): string {
  const title = markdownLine(input.workflowTitle) || "Untitled Workflow";
  return [
    ...renderAgentSkillFrontmatter({
      name: title,
      description: input.description,
    }),
    `# ${title}`,
    "",
    "## Description",
    "",
    markdownParagraph(input.description),
    "",
    "## OysterWorkflow",
    "",
    `- Workflow ID: ${input.workflowId}`,
    `- Worker Agent: ${input.workerAgentReference}`,
    "- Approval Policy: allow_all",
    "",
    ...renderOysterBrowserUsageGuide(),
    "",
    "## User-facing response policy",
    "",
    ...workerUserFacingResponsePolicyLines().slice(1),
    "",
    "## Instructions",
    "",
    "Use this skill when OysterWorkflow asks the assigned Hermes Agent to execute the installed workflow above. Follow the workflow intent, preserve the user's operating style, and report real progress back through the normal AI worker response.",
    "",
    "Do not invent completed work. If the workflow reaches a risky, irreversible, or unclear boundary, describe the boundary in the normal response so OysterWorkflow can show it in run history.",
    "",
  ].join("\n");
}

function markdownParagraph(value: string): string {
  return markdownLine(value) || "No description recorded.";
}

function markdownLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 72);
}

function matchSessionId(output: string): string | null {
  return (
    output.match(/Session:\s*([0-9_a-f-]+)/iu)?.[1]?.trim() ??
    output.match(/session_id:\s*([0-9_a-f-]+)/iu)?.[1]?.trim() ??
    output
      .match(/(?:^|\n)\s*(?:↻\s*)?Resumed session\s+([0-9_a-f-]+)/iu)?.[1]
      ?.trim() ??
    null
  );
}

interface ParsedHermesSessionStatus {
  sessionStatus: ProductAgentSessionStatus | null;
  sessionStatusMessage: string | null;
  userAction: string | null;
}

const VALID_HERMES_SESSION_STATUSES = new Set<ProductAgentSessionStatus>([
  "running",
  "waiting_for_user",
  "blocked",
  "succeeded",
  "failed",
]);

function hermesSessionStatusFromOutput(
  output: string,
): ParsedHermesSessionStatus {
  for (const line of output.split(/\r?\n/u).reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(OYSTERWORKFLOW_SESSION_STATUS_MARKER)) {
      continue;
    }
    const jsonText = trimmed
      .slice(OYSTERWORKFLOW_SESSION_STATUS_MARKER.length)
      .replace(/^[:\s]+/u, "")
      .trim();
    if (!jsonText) {
      continue;
    }
    try {
      const parsed = JSON.parse(jsonText) as {
        status?: unknown;
        message?: unknown;
        user_action?: unknown;
        userAction?: unknown;
      };
      const status =
        typeof parsed.status === "string" &&
        VALID_HERMES_SESSION_STATUSES.has(
          parsed.status as ProductAgentSessionStatus,
        )
          ? (parsed.status as ProductAgentSessionStatus)
          : null;
      return {
        sessionStatus: status,
        sessionStatusMessage:
          typeof parsed.message === "string" && parsed.message.trim()
            ? parsed.message.trim()
            : null,
        userAction:
          typeof parsed.user_action === "string" && parsed.user_action.trim()
            ? parsed.user_action.trim()
            : typeof parsed.userAction === "string" && parsed.userAction.trim()
              ? parsed.userAction.trim()
              : null,
      };
    } catch {
      return emptyHermesSessionStatus();
    }
  }
  return emptyHermesSessionStatus();
}

function emptyHermesSessionStatus(): ParsedHermesSessionStatus {
  return {
    sessionStatus: null,
    sessionStatusMessage: null,
    userAction: null,
  };
}

function conciseHermesError(output: string): string | null {
  const lines = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^Command failed:/iu.test(line))
    .filter((line) => !/^session_id:/iu.test(line));
  const important = lines.find((line) =>
    /HTTP\s+\d+|Unknown provider|No Codex credentials|Connection error|not licensed|invalid API key|request was blocked|authentication failed/iu.test(
      line,
    ),
  );
  return important ?? null;
}

function fallbackHermesErrorMessage(): string {
  return "Hermes exited before returning a model response. Check Hermes provider credentials and run hermes doctor.";
}

function commandErrorOutput(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const maybe = error as {
      stdout?: unknown;
      stderr?: unknown;
      message?: unknown;
    };
    return [maybe.stdout, maybe.stderr, maybe.message]
      .filter((part): part is string => typeof part === "string")
      .join("\n");
  }
  return String(error);
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function appendUtf8Tail(
  current: string,
  text: string,
  maxBytes: number,
): string {
  const next = `${current}${text}`;
  if (Buffer.byteLength(next, "utf8") <= maxBytes) {
    return next;
  }
  return Buffer.from(next, "utf8")
    .subarray(-maxBytes)
    .toString("utf8")
    .replace(/^\uFFFD/u, "");
}
