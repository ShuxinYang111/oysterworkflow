import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createRequire } from "node:module";
import {
  pollForDeviceToken,
  requestDeviceCode,
} from "clawhub/dist/deviceAuth.js";
import { readGlobalConfig, writeGlobalConfig } from "clawhub/dist/config.js";
import { hashSkillFiles, listTextFiles } from "clawhub/dist/skills.js";
import { runOpenClawSkillExport } from "../cli/commands/openclaw-skill.js";
import { signalProcessGroup } from "../process/child-process.js";
import type {
  ProductClawHubAuthState,
  ProductClawHubLoginStartResponse,
  ProductClawHubLoginStatusResponse,
  ProductClawHubPublishResponse,
} from "./contracts.js";

const CLAWHUB_SITE_URL = "https://clawhub.ai";
const CLAWHUB_REGISTRY_URL = "https://clawhub.ai";
const CLAWHUB_HTTP_TIMEOUT_MS = 30_000;
const CLAWHUB_COMMAND_TIMEOUT_MS = 120_000;
const CLAWHUB_OUTPUT_LIMIT = 1_000_000;
const CLAWHUB_TERMINATION_GRACE_MS = 750;
const CLAWHUB_FORCE_SETTLE_MS = 250;

interface ClawHubConfig {
  registry: string;
  token?: string;
}

interface ClawHubDeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface ClawHubDeviceToken {
  access_token: string;
}

interface ClawHubCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface ClawHubPublishVersionResolution {
  status: "unchanged" | "publish";
  version: string;
}

interface ClawHubLoginRecord extends ProductClawHubLoginStartResponse {
  status: ProductClawHubLoginStatusResponse["status"];
  error: string | null;
}

export interface ProductClawHubService {
  getAuthState(): Promise<ProductClawHubAuthState>;
  beginLogin(): Promise<ProductClawHubLoginStartResponse>;
  getLoginStatus(loginId: string): Promise<ProductClawHubLoginStatusResponse>;
  publishWorkflow(input: {
    workflowId: string;
    title: string;
    skillPath: string;
  }): Promise<ProductClawHubPublishResponse>;
}

export interface ProductClawHubServiceDependencies {
  now: () => Date;
  requestDeviceCodeFn: (input: {
    apiUrl: string;
    siteUrl: string;
    label: string;
  }) => Promise<ClawHubDeviceCode>;
  pollForDeviceTokenFn: (
    input: { apiUrl: string; siteUrl: string },
    deviceCode: string,
    options: { interval: number; expiresIn: number },
  ) => Promise<ClawHubDeviceToken>;
  readConfigFn: () => Promise<ClawHubConfig | null>;
  writeConfigFn: (config: ClawHubConfig) => Promise<void>;
  fetchFn: typeof fetch;
  runCommandFn: (args: string[]) => Promise<ClawHubCommandResult>;
  resolvePublishVersionFn: (input: {
    directory: string;
    slug: string;
    ownerHandle: string;
    token: string;
    registry: string;
  }) => Promise<ClawHubPublishVersionResolution>;
  exportSkillFn: typeof runOpenClawSkillExport;
}

/**
 * EN: Creates the ClawHub publishing service used by the local Runtime.
 * 中文: 创建本地 Runtime 使用的 ClawHub 发布服务。
 * @param overrides injectable dependencies for deterministic tests.
 * @returns service for auth and public workflow publishing.
 */
export function createProductClawHubService(
  overrides: Partial<ProductClawHubServiceDependencies> = {},
): ProductClawHubService {
  const dependencies = resolveDependencies(overrides);
  const logins = new Map<string, ClawHubLoginRecord>();

  async function getAuthState(): Promise<ProductClawHubAuthState> {
    const config = await dependencies.readConfigFn();
    const token = config?.token?.trim();
    if (!token) {
      return signedOutState();
    }

    const registry = config?.registry?.trim() || CLAWHUB_REGISTRY_URL;
    return withClawHubRequestDeadline(async (signal) => {
      const response = await dependencies.fetchFn(
        new URL("/api/v1/whoami", registry),
        {
          method: "GET",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
          },
          signal,
        },
      );
      if (response.status === 401 || response.status === 403) {
        return signedOutState();
      }
      if (!response.ok) {
        throw new Error(
          `ClawHub account check failed with HTTP ${response.status}.`,
        );
      }

      const body = (await response.json()) as {
        user?: { handle?: unknown } | null;
      };
      const handle = normalizeHandle(body.user?.handle);
      if (!handle) {
        throw new Error("ClawHub did not return a publisher handle.");
      }
      return {
        status: "signed_in" as const,
        handle,
        siteUrl: CLAWHUB_SITE_URL,
      };
    });
  }

  async function beginLogin(): Promise<ProductClawHubLoginStartResponse> {
    const existing = Array.from(logins.values()).find(
      (login) => login.status === "pending",
    );
    if (existing) {
      return loginStartResponse(existing);
    }

    const code = await dependencies.requestDeviceCodeFn({
      apiUrl: CLAWHUB_REGISTRY_URL,
      siteUrl: CLAWHUB_SITE_URL,
      label: "OysterWorkflow",
    });
    const startedAt = dependencies.now();
    const login: ClawHubLoginRecord = {
      loginId: randomUUID(),
      verificationUrl: code.verification_uri,
      userCode: code.user_code,
      expiresAt: new Date(
        startedAt.getTime() + code.expires_in * 1_000,
      ).toISOString(),
      status: "pending",
      error: null,
    };
    logins.set(login.loginId, login);

    void dependencies
      .pollForDeviceTokenFn(
        {
          apiUrl: CLAWHUB_REGISTRY_URL,
          siteUrl: CLAWHUB_SITE_URL,
        },
        code.device_code,
        {
          interval: code.interval,
          expiresIn: code.expires_in,
        },
      )
      .then(async (token) => {
        await dependencies.writeConfigFn({
          registry: CLAWHUB_REGISTRY_URL,
          token: token.access_token,
        });
        login.status = "authorized";
      })
      .catch((error) => {
        login.status = "failed";
        login.error = publicErrorMessage(error);
      });

    return loginStartResponse(login);
  }

  async function getLoginStatus(
    loginId: string,
  ): Promise<ProductClawHubLoginStatusResponse> {
    const login = logins.get(loginId);
    if (!login) {
      throw new Error("ClawHub authorization session was not found.");
    }
    return {
      loginId,
      status: login.status,
      auth:
        login.status === "authorized" ? await getAuthState() : signedOutState(),
      error: login.error,
    };
  }

  async function publishWorkflow(input: {
    workflowId: string;
    title: string;
    skillPath: string;
  }): Promise<ProductClawHubPublishResponse> {
    const auth = await getAuthState();
    if (auth.status !== "signed_in" || !auth.handle) {
      throw new Error("Connect ClawHub before publishing this workflow.");
    }

    const slug = buildClawHubSlug(input.title, input.workflowId);
    const publishSource = await preparePublishSource({
      skillPath: input.skillPath,
      slug,
      dependencies,
    });
    try {
      const config = await dependencies.readConfigFn();
      const token = config?.token?.trim();
      if (!token) {
        throw new Error("Connect ClawHub before publishing this workflow.");
      }
      const versionResolution = await dependencies.resolvePublishVersionFn({
        directory: publishSource.directory,
        slug,
        ownerHandle: auth.handle,
        token,
        registry: config?.registry?.trim() || CLAWHUB_REGISTRY_URL,
      });
      if (versionResolution.status === "unchanged") {
        return buildPublishResponse({
          status: "unchanged",
          ownerHandle: auth.handle,
          slug,
          version: versionResolution.version,
        });
      }

      const command = await dependencies.runCommandFn([
        "skill",
        "publish",
        publishSource.directory,
        "--slug",
        slug,
        "--name",
        input.title,
        "--version",
        versionResolution.version,
        "--changelog",
        "Published from OysterWorkflow",
      ]);
      if (command.exitCode !== 0) {
        throw new Error(
          publicCommandError(command) || "ClawHub publishing failed.",
        );
      }
      const result = parsePublishResult(
        `${command.stdout}\n${command.stderr}`,
        slug,
        versionResolution.version,
      );
      return buildPublishResponse({
        status: "published",
        ownerHandle: auth.handle,
        slug: result.slug,
        version: result.version,
      });
    } finally {
      await publishSource.cleanup();
    }
  }

  return {
    getAuthState,
    beginLogin,
    getLoginStatus,
    publishWorkflow,
  };
}

/**
 * EN: Builds a stable, readable ClawHub slug for one local workflow.
 * 中文: 为本地工作流生成稳定且易读的 ClawHub slug。
 * @param title workflow display title.
 * @param workflowId stable local workflow identity.
 * @returns ClawHub-compatible slug with a collision-resistant suffix.
 */
export function buildClawHubSlug(title: string, workflowId: string): string {
  const readable = title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48)
    .replace(/-+$/gu, "");
  const suffix = createHash("sha256")
    .update(workflowId)
    .digest("hex")
    .slice(0, 8);
  return `${readable || "workflow"}-${suffix}`;
}

function resolveDependencies(
  overrides: Partial<ProductClawHubServiceDependencies>,
): ProductClawHubServiceDependencies {
  return {
    now: overrides.now ?? (() => new Date()),
    requestDeviceCodeFn:
      overrides.requestDeviceCodeFn ??
      (async (input) => {
        const code = await requestDeviceCode(input);
        return { ...code };
      }),
    pollForDeviceTokenFn:
      overrides.pollForDeviceTokenFn ??
      (async (input, deviceCode, options) => {
        const token = await pollForDeviceToken(input, deviceCode, options);
        return { access_token: token.access_token };
      }),
    readConfigFn:
      overrides.readConfigFn ??
      (async () => {
        const config = await readGlobalConfig();
        return config
          ? { registry: config.registry, token: config.token }
          : null;
      }),
    writeConfigFn: overrides.writeConfigFn ?? writeGlobalConfig,
    fetchFn: overrides.fetchFn ?? fetch,
    runCommandFn: overrides.runCommandFn ?? runClawHubCommand,
    resolvePublishVersionFn:
      overrides.resolvePublishVersionFn ??
      ((input) =>
        resolveClawHubPublishVersion(input, overrides.fetchFn ?? fetch)),
    exportSkillFn: overrides.exportSkillFn ?? runOpenClawSkillExport,
  };
}

async function preparePublishSource(input: {
  skillPath: string;
  slug: string;
  dependencies: ProductClawHubServiceDependencies;
}): Promise<{ directory: string; cleanup: () => Promise<void> }> {
  const sourceStat = await stat(input.skillPath).catch(() => null);
  if (!sourceStat) {
    throw new Error(`Workflow skill file was not found: ${input.skillPath}`);
  }
  if (sourceStat.isDirectory()) {
    await assertSkillMarkdown(input.skillPath);
    return { directory: input.skillPath, cleanup: async () => undefined };
  }
  if (!sourceStat.isFile()) {
    throw new Error(
      "The selected workflow does not contain a publishable skill.",
    );
  }

  if (basename(input.skillPath).toLowerCase() === "skill.md") {
    return {
      directory: dirname(input.skillPath),
      cleanup: async () => undefined,
    };
  }
  if (!input.skillPath.toLowerCase().endsWith(".json")) {
    throw new Error(
      "The selected workflow does not contain a publishable skill.",
    );
  }

  const tempRoot = await mkdtemp(
    join(tmpdir(), "oysterworkflow-clawhub-publish-"),
  );
  try {
    const exported = await input.dependencies.exportSkillFn({
      skillPath: input.skillPath,
      installName: input.slug,
      installRoot: tempRoot,
    });
    return {
      directory: exported.installDir,
      cleanup: async () => {
        await rm(tempRoot, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

async function assertSkillMarkdown(directory: string): Promise<void> {
  const candidates = [join(directory, "SKILL.md"), join(directory, "skill.md")];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return;
    } catch {
      // Continue checking supported manifest casing.
    }
  }
  throw new Error("The selected workflow does not contain a SKILL.md file.");
}

function runClawHubCommand(args: string[]): Promise<ClawHubCommandResult> {
  const require = createRequire(import.meta.url);
  const cliPath = require.resolve("clawhub/bin/clawdhub.js");
  return new Promise((resolvePromise, rejectPromise) => {
    const useProcessGroup = process.platform !== "win32";
    const child = spawn(process.execPath, [cliPath, ...args], {
      detached: useProcessGroup,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        FORCE_COLOR: "0",
        NO_COLOR: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let forceKillTimer: NodeJS.Timeout | null = null;
    let forceSettleTimer: NodeJS.Timeout | null = null;
    const clearLifecycle = () => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (forceSettleTimer) clearTimeout(forceSettleTimer);
    };
    const settle = (code: number | null, error?: Error) => {
      if (settled) return;
      settled = true;
      clearLifecycle();
      if (error || timedOut) {
        rejectPromise(error ?? new Error("ClawHub publishing timed out."));
        return;
      }
      resolvePromise({
        exitCode: code ?? 1,
        stdout,
        stderr,
      });
    };
    const timeout = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      signalProcessGroup(child, "SIGTERM", useProcessGroup);
      forceKillTimer = setTimeout(() => {
        if (settled) return;
        signalProcessGroup(child, "SIGKILL", useProcessGroup);
        forceSettleTimer = setTimeout(() => {
          if (settled) return;
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
          settle(null);
        }, CLAWHUB_FORCE_SETTLE_MS);
        forceSettleTimer.unref?.();
      }, CLAWHUB_TERMINATION_GRACE_MS);
      forceKillTimer.unref?.();
    }, CLAWHUB_COMMAND_TIMEOUT_MS);
    timeout.unref?.();

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.once("error", (error) => {
      settle(null, error);
    });
    child.once("close", (code) => {
      settle(code);
    });
  });
}

function appendBounded(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length <= CLAWHUB_OUTPUT_LIMIT
    ? next
    : next.slice(next.length - CLAWHUB_OUTPUT_LIMIT);
}

function parsePublishResult(
  output: string,
  expectedSlug: string,
  expectedVersion: string,
): {
  status: "unchanged" | "published" | "would-publish";
  slug: string;
  version: string;
} {
  try {
    const parsed = parseLastJsonObject(output) as {
      ok?: unknown;
      status?: unknown;
      slug?: unknown;
      version?: unknown;
    };
    if (
      parsed.ok === true &&
      (parsed.status === "unchanged" ||
        parsed.status === "published" ||
        parsed.status === "would-publish") &&
      typeof parsed.slug === "string" &&
      typeof parsed.version === "string"
    ) {
      return {
        status: parsed.status,
        slug: parsed.slug,
        version: parsed.version,
      };
    }
  } catch {
    // ClawHub 0.20 emits human-readable output instead of JSON.
  }

  const cleanOutput = publicErrorMessage(output);
  const published = cleanOutput.match(
    /Published\s+([^\s@]+)@([0-9]+\.[0-9]+\.[0-9]+)/iu,
  );
  if (
    !published ||
    published[1] !== expectedSlug ||
    published[2] !== expectedVersion
  ) {
    throw new Error("ClawHub returned an invalid publish result.");
  }
  return {
    status: "published",
    slug: published[1],
    version: published[2],
  };
}

async function resolveClawHubPublishVersion(
  input: {
    directory: string;
    slug: string;
    ownerHandle: string;
    token: string;
    registry: string;
  },
  fetchFn: typeof fetch,
): Promise<ClawHubPublishVersionResolution> {
  const files = (await listTextFiles(input.directory)).filter(
    (file) => file.relPath.trim().toLowerCase() !== "skill-card.md",
  );
  const fingerprint = hashSkillFiles(files).fingerprint;
  const url = new URL("/api/v1/resolve", input.registry);
  url.searchParams.set("slug", input.slug);
  url.searchParams.set("ownerHandle", input.ownerHandle);
  url.searchParams.set("hash", fingerprint);
  return withClawHubRequestDeadline(async (signal) => {
    const response = await fetchFn(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${input.token}`,
      },
      signal,
    });
    if (response.status === 404) {
      return { status: "publish" as const, version: "1.0.0" };
    }
    if (!response.ok) {
      throw new Error(
        `ClawHub version check failed with HTTP ${response.status}.`,
      );
    }

    const body = (await response.json()) as {
      match?: { version?: unknown } | null;
      latestVersion?: { version?: unknown } | null;
    };
    if (typeof body.match?.version === "string") {
      return { status: "unchanged" as const, version: body.match.version };
    }
    if (!body.latestVersion) {
      return { status: "publish" as const, version: "1.0.0" };
    }
    if (typeof body.latestVersion.version !== "string") {
      throw new Error("ClawHub returned an invalid latest version.");
    }
    return {
      status: "publish" as const,
      version: incrementPatchVersion(body.latestVersion.version),
    };
  });
}

async function withClawHubRequestDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("ClawHub request timed out.")),
    CLAWHUB_HTTP_TIMEOUT_MS,
  );
  timer.unref?.();
  try {
    return await operation(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(
        "ClawHub did not respond before the request deadline. / ClawHub 请求超时。",
        { cause: error },
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function incrementPatchVersion(version: string): string {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/u);
  if (!match) {
    throw new Error(`ClawHub returned an invalid latest version: ${version}`);
  }
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

function buildPublishResponse(input: {
  status: "unchanged" | "published";
  ownerHandle: string;
  slug: string;
  version: string;
}): ProductClawHubPublishResponse {
  return {
    ...input,
    listingUrl: `${CLAWHUB_SITE_URL}/${encodeURIComponent(input.ownerHandle)}/skills/${encodeURIComponent(input.slug)}`,
    installCommand: `openclaw skills install @${input.ownerHandle}/${input.slug}`,
  };
}

function parseLastJsonObject(value: string): unknown {
  const trimmed = value.trim();
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    for (let index = trimmed.lastIndexOf("{"); index >= 0; index -= 1) {
      if (trimmed[index] !== "{") {
        continue;
      }
      try {
        return JSON.parse(trimmed.slice(index)) as unknown;
      } catch {
        // Continue scanning for the final complete JSON object.
      }
    }
  }
  throw new Error("ClawHub did not return a JSON publish result.");
}

function publicCommandError(result: ClawHubCommandResult): string {
  return publicErrorMessage(result.stderr || result.stdout);
}

function publicErrorMessage(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return stripAnsiEscapeSequences(value)
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 1_200);
}

function stripAnsiEscapeSequences(value: string): string {
  const escapeCharacter = String.fromCharCode(27);
  return value.replace(new RegExp(`${escapeCharacter}\\[[0-9;]*m`, "gu"), "");
}

function normalizeHandle(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const handle = value.trim().replace(/^@+/u, "");
  return handle || null;
}

function signedOutState(): ProductClawHubAuthState {
  return {
    status: "signed_out",
    handle: null,
    siteUrl: CLAWHUB_SITE_URL,
  };
}

function loginStartResponse(
  login: ClawHubLoginRecord,
): ProductClawHubLoginStartResponse {
  return {
    loginId: login.loginId,
    verificationUrl: login.verificationUrl,
    userCode: login.userCode,
    expiresAt: login.expiresAt,
  };
}
