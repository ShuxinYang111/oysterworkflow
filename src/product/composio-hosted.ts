import {
  OYSTER_COMPOSIO_BROKER_URL,
  OYSTER_SUPABASE_PUBLISHABLE_KEY,
} from "../cloud/config.js";
import type { RuntimeCloudSession } from "../cloud/runtime-session.js";
import {
  createComposioCapabilityProviderSnapshot,
  type ComposioMcpServerConfig,
  type ComposioProviderAdapter,
} from "./composio.js";
import type {
  ProductComposioAuthorizeResponse,
  ProductComposioConnectionResponse,
  ProductComposioDisconnectResponse,
  ProductComposioOverviewResponse,
  ProductComposioProviderStatus,
} from "./contracts.js";

const HOSTED_COMPOSIO_TIMEOUT_MS = 30_000;

interface HostedComposioProviderAdapterInput {
  cloudSession: RuntimeCloudSession;
  brokerUrl?: string;
  fetchFn?: typeof fetch;
}

interface HostedComposioStatusResponse {
  provider: ProductComposioProviderStatus;
}

interface HostedComposioMcpResponse {
  server: ComposioMcpServerConfig;
}

/**
 * EN: Connects the local Runtime to the authenticated OysterWorkflow Composio broker.
 * 中文: 将本地 Runtime 连接到经过身份验证的 OysterWorkflow Composio broker。
 * @param input memory-only cloud session plus optional test seams.
 * @returns provider adapter that never reads or stores the Composio project key locally.
 */
export function createHostedComposioProviderAdapter(
  input: HostedComposioProviderAdapterInput,
): ComposioProviderAdapter {
  const brokerUrl = input.brokerUrl ?? OYSTER_COMPOSIO_BROKER_URL;
  const fetchFn = input.fetchFn ?? fetch;
  let lastError: string | null = null;

  async function request<T>(body: Record<string, unknown>): Promise<T> {
    const accessToken = input.cloudSession.getAccessToken();
    if (!accessToken) {
      throw new Error("Sign in to connect applications.");
    }
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      HOSTED_COMPOSIO_TIMEOUT_MS,
    );
    try {
      const response = await fetchFn(brokerUrl, {
        method: "POST",
        headers: {
          apikey: OYSTER_SUPABASE_PUBLISHABLE_KEY,
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const raw = await response.text();
      const parsed = raw ? (JSON.parse(raw) as unknown) : null;
      if (!response.ok) {
        throw new Error(
          readBrokerError(parsed) ??
            `Application connection service failed (HTTP ${response.status}).`,
        );
      }
      lastError = null;
      return parsed as T;
    } catch (error) {
      const message =
        error instanceof Error && error.name === "AbortError"
          ? "Application connection service timed out."
          : errorMessage(error);
      lastError = message;
      throw new Error(message);
    } finally {
      clearTimeout(timeout);
    }
  }

  function localStatus(): ProductComposioProviderStatus {
    const signedIn = Boolean(input.cloudSession.getAccessToken());
    return {
      id: "composio",
      configured: signedIn,
      apiKeySource: signedIn ? "hosted" : "none",
      sessionReady: false,
      sessionId: null,
      lastError,
      features: {
        unrestrictedToolkits: true,
        dynamicDiscovery: true,
        fullToolCatalog: true,
        remoteSandbox: true,
        mcp: true,
      },
    };
  }

  return {
    snapshot: async () => {
      const signedIn = Boolean(input.cloudSession.getAccessToken());
      return createComposioCapabilityProviderSnapshot({
        configured: signedIn,
        status: "not_checked",
        lastCheckedAt: null,
        lastError,
        lastSuccessAt: null,
      });
    },
    check: async () => {
      const checkedAt = new Date().toISOString();
      if (!input.cloudSession.getAccessToken()) {
        return createComposioCapabilityProviderSnapshot({
          configured: false,
          status: "unavailable",
          lastCheckedAt: checkedAt,
          lastError: "Sign in to connect applications.",
          lastSuccessAt: null,
        });
      }
      try {
        await request<HostedComposioStatusResponse>({ action: "status" });
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
          lastError: errorMessage(error),
          lastSuccessAt: null,
        });
      }
    },
    status: async () => {
      if (!input.cloudSession.getAccessToken()) {
        return localStatus();
      }
      return (await request<HostedComposioStatusResponse>({ action: "status" }))
        .provider;
    },
    configure: async () => {
      throw new Error(
        "Application connection credentials are managed by OysterWorkflow.",
      );
    },
    overview: async ({ cursor, search, filter, limit }) =>
      request<ProductComposioOverviewResponse>({
        action: "overview",
        ...(cursor ? { cursor } : {}),
        ...(search?.trim() ? { search: search.trim() } : {}),
        ...(filter ? { filter } : {}),
        ...(limit ? { limit } : {}),
      }),
    authorize: async ({ toolkitSlug, alias, callbackUrl }) =>
      request<ProductComposioAuthorizeResponse>({
        action: "authorize",
        toolkitSlug,
        ...(alias?.trim() ? { alias: alias.trim() } : {}),
        ...(callbackUrl?.trim() ? { callbackUrl: callbackUrl.trim() } : {}),
      }),
    getConnection: async ({ connectionId }) =>
      (
        await request<ProductComposioConnectionResponse>({
          action: "connection",
          connectionId,
        })
      ).connection,
    disconnect: async ({ connectionId }) => {
      await request<ProductComposioDisconnectResponse>({
        action: "disconnect",
        connectionId,
      });
    },
    getMcpServer: async (_userId, options) => {
      if (!input.cloudSession.getAccessToken() && options?.allowMissing) {
        return null;
      }
      try {
        return (await request<HostedComposioMcpResponse>({ action: "mcp" }))
          .server;
      } catch (error) {
        if (options?.allowMissing) {
          return null;
        }
        throw error;
      }
    },
  };
}

function readBrokerError(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const error = (value as { error?: unknown }).error;
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    return typeof message === "string" && message.trim()
      ? message.trim()
      : null;
  }
  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message.trim()
    : "Application connection service failed.";
}
