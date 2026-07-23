import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Composio } from "@composio/core";
import type { RuntimeConfig } from "../runtime/config.js";
import type {
  ProductCapabilityProvider,
  ProductComposioApiKeySource,
  ProductComposioAuthorizeResponse,
  ProductComposioConnection,
  ProductComposioFeatureStatus,
  ProductComposioOverviewResponse,
  ProductComposioProviderStatus,
  ProductComposioToolkitFilter,
} from "./contracts.js";

const COMPOSIO_API_KEY_ENV_NAME = "COMPOSIO_API_KEY";
const COMPOSIO_SDK_VERSION = "0.13.1";
const COMPOSIO_REQUEST_TIMEOUT_MS = 30_000;
const COMPOSIO_TOOLKIT_PAGE_SIZE = 48;
const COMPOSIO_CONNECTED_ACCOUNT_PAGE_SIZE = 100;
const COMPOSIO_MAX_ACCOUNT_PAGES = 100;

const COMPOSIO_FEATURES: ProductComposioFeatureStatus = {
  unrestrictedToolkits: true,
  dynamicDiscovery: true,
  fullToolCatalog: true,
  remoteSandbox: true,
  mcp: true,
};

interface StoredComposioConfig {
  version: 1;
  apiKey?: string;
  sessions?: Record<
    string,
    {
      sessionId: string;
      apiKeyFingerprint: string;
    }
  >;
}

interface ComposioSessionToolkit {
  slug: string;
  name: string;
  logo?: string;
  isNoAuth: boolean;
  connection?: {
    isActive: boolean;
    connectedAccount?: {
      id: string;
      status: string;
    };
  };
}

interface ComposioSessionLike {
  sessionId: string;
  mcp: {
    type: "http" | "sse";
    url: string;
    headers: Record<string, string>;
  };
  sandbox?: {
    enable: boolean;
  };
  toolkits: (
    input?: {
      cursor?: string;
      limit?: number;
      search?: string;
      isConnected?: boolean;
    },
    requestOptions?: { signal?: AbortSignal },
  ) => Promise<{
    items: ComposioSessionToolkit[];
    cursor?: string;
    totalPages: number;
  }>;
  authorize: (
    toolkit: string,
    options?: { alias?: string; callbackUrl?: string },
    requestOptions?: { signal?: AbortSignal },
  ) => Promise<{
    id: string;
    status?: string;
    redirectUrl: string | null;
  }>;
}

interface ComposioConnectedAccountLike {
  id: string;
  alias?: string | null;
  status: string;
  statusReason: string | null;
  toolkit: { slug: string };
  isDisabled: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface ComposioSdkLike {
  sessions: {
    create: (
      userId: string,
      config: {
        mcp: true;
        manageConnections: true;
        sandbox: { enable: true };
        multiAccount: {
          enable: true;
          maxAccountsPerToolkit: 10;
          requireExplicitSelection: false;
        };
      },
      requestOptions?: { signal?: AbortSignal },
    ) => Promise<ComposioSessionLike>;
    use: (
      sessionId: string,
      options: { mcp: true },
      requestOptions?: { signal?: AbortSignal },
    ) => Promise<ComposioSessionLike>;
  };
  connectedAccounts: {
    list: (
      input: {
        userIds: string[];
        cursor?: string;
        limit: number;
        accountType: "ALL";
      },
      requestOptions?: { signal?: AbortSignal },
    ) => Promise<{
      items: ComposioConnectedAccountLike[];
      nextCursor?: string | null;
    }>;
    get: (
      connectionId: string,
      requestOptions?: { signal?: AbortSignal },
    ) => Promise<ComposioConnectedAccountLike>;
    delete: (
      connectionId: string,
      requestOptions?: { signal?: AbortSignal },
    ) => Promise<unknown>;
  };
  toolkits: {
    get: (
      input: { limit: number; sortBy: "usage" },
      requestOptions?: { signal?: AbortSignal },
    ) => Promise<unknown[]>;
  };
}

export interface ComposioMcpServerConfig {
  name: "composio";
  url: string;
  headers: Record<string, string>;
  timeoutSeconds: number;
}

export interface ComposioProviderAdapter {
  snapshot: () => Promise<ProductCapabilityProvider>;
  check: () => Promise<ProductCapabilityProvider>;
  status: (userId?: string) => Promise<ProductComposioProviderStatus>;
  configure: (apiKey: string | null) => Promise<ProductComposioProviderStatus>;
  overview: (input: {
    userId: string;
    cursor?: string;
    search?: string;
    filter?: ProductComposioToolkitFilter;
    limit?: number;
  }) => Promise<ProductComposioOverviewResponse>;
  authorize: (input: {
    userId: string;
    toolkitSlug: string;
    alias?: string | null;
    callbackUrl?: string;
  }) => Promise<ProductComposioAuthorizeResponse>;
  getConnection: (input: {
    userId: string;
    connectionId: string;
  }) => Promise<ProductComposioConnection>;
  disconnect: (input: {
    userId: string;
    connectionId: string;
  }) => Promise<void>;
  getMcpServer: (
    userId: string,
    options?: { allowMissing?: boolean },
  ) => Promise<ComposioMcpServerConfig | null>;
}

interface CreateComposioProviderAdapterInput {
  runtimeConfig: RuntimeConfig;
  environment?: NodeJS.ProcessEnv;
  clientFactory?: (apiKey: string) => ComposioSdkLike;
  configPath?: string;
}

/**
 * EN: Creates the cloud integration provider used by both Runtime APIs and Hermes MCP injection.
 * 中文: 创建 Runtime API 与 Hermes MCP 注入共同使用的云端集成 provider。
 * @param input runtime paths, environment, and optional SDK test seam.
 * @returns Composio provider adapter with unrestricted session defaults.
 */
export function createComposioProviderAdapter(
  input: CreateComposioProviderAdapterInput,
): ComposioProviderAdapter {
  const environment = input.environment ?? process.env;
  const configPath = resolve(
    input.configPath ??
      resolve(
        dirname(input.runtimeConfig.skillManagerConfigPath),
        "composio.config.json",
      ),
  );
  const clientFactory =
    input.clientFactory ??
    ((apiKey: string) =>
      new Composio({
        apiKey,
        allowTracking: false,
        host: "oysterworkflow",
      }) as unknown as ComposioSdkLike);
  let cachedClient: { fingerprint: string; client: ComposioSdkLike } | null =
    null;
  const sessionPromises = new Map<
    string,
    {
      fingerprint: string;
      promise: Promise<ComposioSessionLike>;
    }
  >();
  const lastErrors = new Map<string, string>();
  let configUpdateQueue: Promise<void> = Promise.resolve();
  let credentialGeneration = 0;

  async function readStoredConfig(): Promise<StoredComposioConfig> {
    await configUpdateQueue;
    try {
      const raw = await readFile(configPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<StoredComposioConfig>;
      return {
        version: 1,
        ...(typeof parsed.apiKey === "string" && parsed.apiKey.trim()
          ? { apiKey: parsed.apiKey.trim() }
          : {}),
        sessions:
          parsed.sessions && typeof parsed.sessions === "object"
            ? parsed.sessions
            : {},
      };
    } catch (error) {
      if (isMissingFileError(error)) {
        return { version: 1, sessions: {} };
      }
      throw new Error(
        `Unable to read Composio configuration: ${errorMessage(error)}`,
      );
    }
  }

  async function writeStoredConfig(
    config: StoredComposioConfig,
  ): Promise<void> {
    const write = async () => {
      await mkdir(dirname(configPath), { recursive: true });
      const temporaryPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, configPath);
      await chmod(configPath, 0o600);
    };
    const result = configUpdateQueue.then(write, write);
    configUpdateQueue = result.then(
      () => undefined,
      () => undefined,
    );
    await result;
  }

  async function resolveCredential(): Promise<{
    apiKey: string | null;
    source: ProductComposioApiKeySource;
    stored: StoredComposioConfig;
  }> {
    const stored = await readStoredConfig();
    if (stored.apiKey) {
      return { apiKey: stored.apiKey, source: "local_file", stored };
    }
    const environmentKey = environment[COMPOSIO_API_KEY_ENV_NAME]?.trim();
    return environmentKey
      ? { apiKey: environmentKey, source: "environment", stored }
      : { apiKey: null, source: "none", stored };
  }

  function getClient(apiKey: string): {
    client: ComposioSdkLike;
    fingerprint: string;
  } {
    const fingerprint = apiKeyFingerprint(apiKey);
    if (cachedClient?.fingerprint === fingerprint) {
      return cachedClient;
    }
    cachedClient = { fingerprint, client: clientFactory(apiKey) };
    return cachedClient;
  }

  async function getSession(userId: string): Promise<ComposioSessionLike> {
    const normalizedUserId = normalizeUserId(userId);
    const requestGeneration = credentialGeneration;
    const credential = await resolveCredential();
    assertCurrentCredentialGeneration(requestGeneration);
    if (!credential.apiKey) {
      throw new Error(
        "Composio is not configured. Add a Composio API key first.",
      );
    }
    const apiKey = credential.apiKey;
    const fingerprint = apiKeyFingerprint(apiKey);
    const pending = sessionPromises.get(normalizedUserId);
    if (pending?.fingerprint === fingerprint) {
      return pending.promise;
    }

    const sessionPromise = (async () => {
      assertCurrentCredentialGeneration(requestGeneration);
      const { client } = getClient(apiKey);
      const storedSession = credential.stored.sessions?.[normalizedUserId];
      if (
        storedSession?.sessionId &&
        storedSession.apiKeyFingerprint === fingerprint
      ) {
        try {
          const existing = await client.sessions.use(
            storedSession.sessionId,
            { mcp: true },
            requestOptions(),
          );
          await assertCurrentCredential(requestGeneration, fingerprint);
          lastErrors.delete(normalizedUserId);
          return existing;
        } catch {
          // EN: Expired or deleted sessions are recreated with the same unrestricted contract.
        }
      }

      const created = await client.sessions.create(
        normalizedUserId,
        {
          mcp: true,
          manageConnections: true,
          sandbox: { enable: true },
          multiAccount: {
            enable: true,
            maxAccountsPerToolkit: 10,
            requireExplicitSelection: false,
          },
        },
        requestOptions(),
      );
      const latestCredential = await assertCurrentCredential(
        requestGeneration,
        fingerprint,
      );
      await writeStoredConfig({
        ...latestCredential.stored,
        version: 1,
        sessions: {
          ...(latestCredential.stored.sessions ?? {}),
          [normalizedUserId]: {
            sessionId: created.sessionId,
            apiKeyFingerprint: fingerprint,
          },
        },
      });
      lastErrors.delete(normalizedUserId);
      return created;
    })().catch((error) => {
      const message = safeProviderError(error);
      if (sessionPromises.get(normalizedUserId)?.promise === sessionPromise) {
        lastErrors.set(normalizedUserId, message);
        sessionPromises.delete(normalizedUserId);
      }
      throw new Error(message);
    });
    sessionPromises.set(normalizedUserId, {
      fingerprint,
      promise: sessionPromise,
    });
    return sessionPromise;
  }

  function assertCurrentCredentialGeneration(generation: number): void {
    if (generation !== credentialGeneration) {
      throw new Error(
        "Composio configuration changed while creating the session. Retry the request. / 创建会话期间 Composio 配置已更改，请重试。",
      );
    }
  }

  async function assertCurrentCredential(
    generation: number,
    fingerprint: string,
  ): Promise<Awaited<ReturnType<typeof resolveCredential>>> {
    assertCurrentCredentialGeneration(generation);
    const latestCredential = await resolveCredential();
    assertCurrentCredentialGeneration(generation);
    if (
      !latestCredential.apiKey ||
      apiKeyFingerprint(latestCredential.apiKey) !== fingerprint
    ) {
      throw new Error(
        "Composio credentials changed while creating the session. Retry the request. / 创建会话期间 Composio 凭据已更改，请重试。",
      );
    }
    return latestCredential;
  }

  async function providerStatus(
    userId?: string,
  ): Promise<ProductComposioProviderStatus> {
    const credential = await resolveCredential();
    const normalizedUserId = userId ? normalizeUserId(userId) : null;
    const storedSession = normalizedUserId
      ? credential.stored.sessions?.[normalizedUserId]
      : undefined;
    return {
      id: "composio",
      configured: Boolean(credential.apiKey),
      apiKeySource: credential.source,
      sessionReady: Boolean(
        normalizedUserId &&
        credential.apiKey &&
        sessionPromises.get(normalizedUserId)?.fingerprint ===
          apiKeyFingerprint(credential.apiKey),
      ),
      sessionId: storedSession?.sessionId ?? null,
      lastError: normalizedUserId
        ? (lastErrors.get(normalizedUserId) ?? null)
        : null,
      features: COMPOSIO_FEATURES,
    };
  }

  async function listConnectedAccounts(
    client: ComposioSdkLike,
    userId: string,
  ): Promise<ProductComposioConnection[]> {
    const accounts: ProductComposioConnection[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < COMPOSIO_MAX_ACCOUNT_PAGES; page += 1) {
      const response = await client.connectedAccounts.list(
        {
          userIds: [userId],
          limit: COMPOSIO_CONNECTED_ACCOUNT_PAGE_SIZE,
          accountType: "ALL",
          ...(cursor ? { cursor } : {}),
        },
        requestOptions(),
      );
      accounts.push(...response.items.map(toProductConnection));
      cursor = response.nextCursor ?? undefined;
      if (!cursor) {
        break;
      }
    }
    return accounts;
  }

  return {
    snapshot: async () => {
      const status = await providerStatus();
      return createComposioCapabilityProviderSnapshot({
        configured: status.configured,
        status: "not_checked",
        lastCheckedAt: null,
        lastError: null,
        lastSuccessAt: null,
      });
    },
    check: async () => {
      const checkedAt = new Date().toISOString();
      const credential = await resolveCredential();
      if (!credential.apiKey) {
        return createComposioCapabilityProviderSnapshot({
          configured: false,
          status: "unavailable",
          lastCheckedAt: checkedAt,
          lastError: "Add a Composio API key to enable cloud integrations.",
          lastSuccessAt: null,
        });
      }
      try {
        const { client } = getClient(credential.apiKey);
        await client.toolkits.get(
          { limit: 1, sortBy: "usage" },
          requestOptions(),
        );
        return createComposioCapabilityProviderSnapshot({
          configured: true,
          status: "ready",
          lastCheckedAt: checkedAt,
          lastError: null,
          lastSuccessAt: checkedAt,
        });
      } catch (error) {
        return createComposioCapabilityProviderSnapshot({
          configured: true,
          status: "unavailable",
          lastCheckedAt: checkedAt,
          lastError: safeProviderError(error),
          lastSuccessAt: null,
        });
      }
    },
    status: providerStatus,
    configure: async (apiKey) => {
      const normalized = apiKey?.trim() || null;
      if (normalized && normalized.length < 8) {
        throw new Error("Composio API key is too short.");
      }
      credentialGeneration += 1;
      cachedClient = null;
      sessionPromises.clear();
      lastErrors.clear();
      await writeStoredConfig({
        version: 1,
        ...(normalized ? { apiKey: normalized } : {}),
        sessions: {},
      });
      return providerStatus();
    },
    overview: async ({
      userId,
      cursor,
      search,
      filter = "all",
      limit = COMPOSIO_TOOLKIT_PAGE_SIZE,
    }) => {
      const normalizedUserId = normalizeUserId(userId);
      const initialStatus = await providerStatus(normalizedUserId);
      if (!initialStatus.configured) {
        return {
          provider: initialStatus,
          items: [],
          nextCursor: null,
          totalPages: 0,
        };
      }
      const session = await getSession(normalizedUserId);
      const credential = await resolveCredential();
      const apiKey = credential.apiKey;
      if (!apiKey) {
        throw new Error("Composio is not configured.");
      }
      const client = getClient(apiKey).client;
      const [toolkits, connections] = await Promise.all([
        session.toolkits(
          {
            limit: Math.min(Math.max(Math.trunc(limit), 1), 100),
            ...(cursor ? { cursor } : {}),
            ...(search?.trim() ? { search: search.trim() } : {}),
            ...(filter === "connected"
              ? { isConnected: true }
              : filter === "not_connected"
                ? { isConnected: false }
                : {}),
          },
          requestOptions(),
        ),
        listConnectedAccounts(client, normalizedUserId),
      ]);
      const connectionsByToolkit = groupConnectionsByToolkit(connections);
      const items = toolkits.items
        .filter((toolkit) => !toolkit.isNoAuth)
        .map((toolkit) => {
          const toolkitConnections =
            connectionsByToolkit.get(toolkit.slug) ?? [];
          return {
            slug: toolkit.slug,
            name: toolkit.name,
            logo: toolkit.logo ?? null,
            noAuth: toolkit.isNoAuth,
            connected:
              toolkitConnections.some(isActiveConnection) ||
              Boolean(toolkit.connection?.isActive),
            connections: toolkitConnections,
          };
        })
        .sort(
          (left, right) =>
            Number(right.connected) - Number(left.connected) ||
            left.name.localeCompare(right.name),
        );
      return {
        provider: {
          ...(await providerStatus(normalizedUserId)),
          sessionReady: true,
          sessionId: session.sessionId,
          lastError: null,
        },
        items,
        nextCursor: toolkits.cursor ?? null,
        totalPages: toolkits.totalPages,
      };
    },
    authorize: async ({ userId, toolkitSlug, alias, callbackUrl }) => {
      const session = await getSession(userId);
      const authorizeOptions = {
        ...(alias?.trim() ? { alias: alias.trim() } : {}),
        ...(callbackUrl?.trim() ? { callbackUrl: callbackUrl.trim() } : {}),
      };
      const request = await session.authorize(
        normalizeToolkitSlug(toolkitSlug),
        Object.keys(authorizeOptions).length > 0 ? authorizeOptions : undefined,
        requestOptions(),
      );
      if (!request.redirectUrl) {
        throw new Error(
          "Composio did not return an authorization URL for this toolkit.",
        );
      }
      return {
        connectionId: request.id,
        redirectUrl: request.redirectUrl,
        status: request.status ?? "INITIATED",
      };
    },
    getConnection: async ({ userId, connectionId }) => {
      const credential = await resolveCredential();
      if (!credential.apiKey) {
        throw new Error("Composio is not configured.");
      }
      const client = getClient(credential.apiKey).client;
      const connection = toProductConnection(
        await client.connectedAccounts.get(connectionId, requestOptions()),
      );
      await assertConnectionOwnedByUser(
        client,
        normalizeUserId(userId),
        connection,
      );
      return connection;
    },
    disconnect: async ({ userId, connectionId }) => {
      const credential = await resolveCredential();
      if (!credential.apiKey) {
        throw new Error("Composio is not configured.");
      }
      const client = getClient(credential.apiKey).client;
      const connection = toProductConnection(
        await client.connectedAccounts.get(connectionId, requestOptions()),
      );
      await assertConnectionOwnedByUser(
        client,
        normalizeUserId(userId),
        connection,
      );
      await client.connectedAccounts.delete(connectionId, requestOptions());
    },
    getMcpServer: async (userId, options) => {
      const credential = await resolveCredential();
      if (!credential.apiKey && options?.allowMissing) {
        return null;
      }
      try {
        const session = await getSession(userId);
        return {
          name: "composio",
          url: session.mcp.url,
          headers: { ...session.mcp.headers },
          timeoutSeconds: 120,
        };
      } catch (error) {
        if (options?.allowMissing) {
          return null;
        }
        throw error;
      }
    },
  };

  async function assertConnectionOwnedByUser(
    client: ComposioSdkLike,
    userId: string,
    connection: ProductComposioConnection,
  ): Promise<void> {
    const owned = (await listConnectedAccounts(client, userId)).some(
      (item) => item.id === connection.id,
    );
    if (!owned) {
      throw new Error(`Unknown Composio connection: ${connection.id}`);
    }
  }
}

/**
 * EN: Builds the stable Composio user namespace shared by the UI and AI workers.
 * 中文: 构建 UI 与 AI Worker 共用的稳定 Composio 用户命名空间。
 * @param input workspace and account identifiers from product state.
 * @returns provider-safe external user id.
 */
export function productComposioUserId(input: {
  workspaceId: string;
  accountId: string;
  cloudUserId?: string | null;
}): string {
  const identity =
    input.cloudUserId?.trim() ||
    `${input.workspaceId.trim()}:${input.accountId.trim()}`;
  return normalizeUserId(`oysterworkflow:${identity}`);
}

export function createComposioCapabilityProviderSnapshot(input: {
  configured: boolean;
  status: ProductCapabilityProvider["status"];
  lastCheckedAt: string | null;
  lastError: string | null;
  lastSuccessAt: string | null;
}): ProductCapabilityProvider {
  return {
    id: "composio",
    kind: "integrations",
    label: "Composio",
    description:
      "Connect cloud applications through a full, dynamically discovered MCP catalog.",
    status: input.status,
    enabled: true,
    required: false,
    installed: input.configured,
    version: COMPOSIO_SDK_VERSION,
    pinnedVersion: COMPOSIO_SDK_VERSION,
    commandPath: null,
    lastCheckedAt: input.lastCheckedAt,
    lastError: input.lastError,
    lastSuccessAt: input.lastSuccessAt,
    detail: input.configured
      ? "Dynamic discovery, the full toolkit catalog, and the remote sandbox are enabled."
      : "Sign in to connect cloud applications.",
  };
}

function groupConnectionsByToolkit(
  connections: ProductComposioConnection[],
): Map<string, ProductComposioConnection[]> {
  const grouped = new Map<string, ProductComposioConnection[]>();
  for (const connection of connections) {
    const existing = grouped.get(connection.toolkitSlug) ?? [];
    existing.push(connection);
    grouped.set(connection.toolkitSlug, existing);
  }
  return grouped;
}

function toProductConnection(
  connection: ComposioConnectedAccountLike,
): ProductComposioConnection {
  return {
    id: connection.id,
    toolkitSlug: connection.toolkit.slug,
    status: connection.status,
    alias: connection.alias ?? null,
    statusReason: connection.statusReason,
    isDisabled: connection.isDisabled,
    createdAt: connection.createdAt ?? null,
    updatedAt: connection.updatedAt ?? null,
  };
}

function isActiveConnection(connection: ProductComposioConnection): boolean {
  return connection.status === "ACTIVE" && !connection.isDisabled;
}

function normalizeUserId(value: string): string {
  const normalized = value.trim().replace(/[^a-zA-Z0-9:_-]+/gu, "-");
  if (!normalized) {
    throw new Error("Composio user id is required.");
  }
  return normalized.slice(0, 256);
}

function normalizeToolkitSlug(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]*$/u.test(normalized)) {
    throw new Error("Invalid Composio toolkit slug.");
  }
  return normalized;
}

function requestOptions(): { signal: AbortSignal } {
  return { signal: AbortSignal.timeout(COMPOSIO_REQUEST_TIMEOUT_MS) };
}

function apiKeyFingerprint(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
}

function safeProviderError(error: unknown): string {
  const message = errorMessage(error)
    .replace(/(?:sk|ak)_[a-zA-Z0-9_-]{8,}/gu, "[REDACTED]")
    .trim();
  return message || "Composio request failed.";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
