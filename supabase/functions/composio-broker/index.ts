import { Composio } from "npm:@composio/core@0.13.1";
import {
  createClient,
  type SupabaseClient,
  type User,
} from "npm:@supabase/supabase-js@2.110.2";

const REQUEST_TIMEOUT_MS = 30_000;
const CONNECTED_ACCOUNT_PAGE_SIZE = 100;
const MAX_CONNECTED_ACCOUNT_PAGES = 100;
const TOOLKIT_PAGE_SIZE = 48;

const FEATURES = {
  unrestrictedToolkits: true,
  dynamicDiscovery: true,
  fullToolCatalog: true,
  remoteSandbox: true,
  mcp: true,
} as const;

type Action =
  "status" | "overview" | "authorize" | "connection" | "disconnect" | "mcp";

interface BrokerInput {
  action?: Action;
  cursor?: string;
  search?: string;
  filter?: "all" | "connected" | "not_connected";
  limit?: number;
  toolkitSlug?: string;
  alias?: string;
  callbackUrl?: string;
  connectionId?: string;
}

interface ProductConnection {
  id: string;
  toolkitSlug: string;
  status: string;
  alias: string | null;
  statusReason: string | null;
  isDisabled: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

interface ConnectedAccountLike {
  id: string;
  alias?: string | null;
  status: string;
  statusReason: string | null;
  toolkit: { slug: string };
  isDisabled: boolean;
  createdAt?: string;
  updatedAt?: string;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(),
    });
  }
  if (request.method !== "POST") {
    return json({ error: "Method not allowed." }, 405);
  }

  try {
    const context = await authenticate(request);
    const input = await readInput(request);
    const apiKey = requireSecret("COMPOSIO_API_KEY");
    const composio = new Composio({
      apiKey,
      allowTracking: false,
      host: "oysterworkflow-edge",
    });
    const externalUserId = `oysterworkflow:${context.user.id}`;

    switch (input.action) {
      case "status": {
        await composio.toolkits.get(
          { limit: 1, sortBy: "usage" },
          requestOptions(),
        );
        return json({
          provider: providerStatus({ sessionReady: false, sessionId: null }),
        });
      }
      case "overview": {
        const session = await resolveSession({
          composio,
          supabase: context.supabase,
          user: context.user,
          externalUserId,
        });
        const connections = await listConnectedAccounts(
          composio,
          externalUserId,
        );
        const toolkits = await session.toolkits(
          {
            limit: normalizeLimit(input.limit),
            ...(input.cursor ? { cursor: input.cursor } : {}),
            ...(input.search ? { search: input.search } : {}),
            ...(input.filter === "connected"
              ? { isConnected: true }
              : input.filter === "not_connected"
                ? { isConnected: false }
                : {}),
          },
          requestOptions(),
        );
        const grouped = groupConnections(connections);
        const items = toolkits.items
          .filter((toolkit) => !toolkit.isNoAuth)
          .map((toolkit) => {
            const toolkitConnections = grouped.get(toolkit.slug) ?? [];
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
        return json({
          provider: providerStatus({
            sessionReady: true,
            sessionId: session.sessionId,
          }),
          items,
          nextCursor: toolkits.cursor ?? null,
          totalPages: toolkits.totalPages,
        });
      }
      case "authorize": {
        const toolkitSlug = normalizeToolkitSlug(input.toolkitSlug);
        const callbackUrl = normalizeCallbackUrl(input.callbackUrl);
        const session = await resolveSession({
          composio,
          supabase: context.supabase,
          user: context.user,
          externalUserId,
        });
        const authorization = await session.authorize(
          toolkitSlug,
          {
            ...(input.alias ? { alias: input.alias } : {}),
            ...(callbackUrl ? { callbackUrl } : {}),
          },
          requestOptions(),
        );
        if (!authorization.redirectUrl) {
          throw new BrokerError(
            "The application connection service did not return an authorization URL.",
            502,
          );
        }
        return json({
          connectionId: authorization.id,
          redirectUrl: authorization.redirectUrl,
          status: authorization.status ?? "INITIATED",
        });
      }
      case "connection": {
        const connectionId = normalizeConnectionId(input.connectionId);
        const connection = toProductConnection(
          await composio.connectedAccounts.get(connectionId, requestOptions()),
        );
        await assertOwnedConnection(composio, externalUserId, connection.id);
        return json({ connection });
      }
      case "disconnect": {
        const connectionId = normalizeConnectionId(input.connectionId);
        await assertOwnedConnection(composio, externalUserId, connectionId);
        await composio.connectedAccounts.delete(connectionId, requestOptions());
        return json({ disconnected: true, connectionId });
      }
      case "mcp": {
        const session = await resolveSession({
          composio,
          supabase: context.supabase,
          user: context.user,
          externalUserId,
        });
        return json({
          server: {
            name: "composio",
            url: session.mcp.url,
            headers: { ...session.mcp.headers },
            timeoutSeconds: 120,
          },
        });
      }
      default:
        throw new BrokerError("Unknown broker action.", 400);
    }
  } catch (error) {
    const status = error instanceof BrokerError ? error.status : 502;
    return json({ error: safeErrorMessage(error) }, status);
  }
});

async function authenticate(request: Request): Promise<{
  user: User;
  supabase: SupabaseClient;
}> {
  const authorization = request.headers.get("authorization")?.trim();
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!token) {
    throw new BrokerError("Sign in to connect applications.", 401);
  }
  const supabaseUrl = requireSecret("SUPABASE_URL");
  const publishableKey =
    request.headers.get("apikey")?.trim() ||
    Deno.env.get("SUPABASE_ANON_KEY")?.trim();
  if (!publishableKey) {
    throw new BrokerError("Supabase publishable key is unavailable.", 500);
  }
  const supabase = createClient(supabaseUrl, publishableKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) {
    throw new BrokerError("Your sign-in session is no longer valid.", 401);
  }
  return { user: data.user, supabase };
}

async function resolveSession(input: {
  composio: Composio;
  supabase: SupabaseClient;
  user: User;
  externalUserId: string;
}) {
  const { data, error } = await input.supabase
    .from("composio_user_sessions")
    .select("session_id")
    .eq("owner_id", input.user.id)
    .maybeSingle();
  if (error) {
    throw new BrokerError(
      "Unable to read the application connection session.",
      502,
    );
  }
  if (data?.session_id) {
    try {
      return await input.composio.sessions.use(
        data.session_id,
        { mcp: true },
        requestOptions(),
      );
    } catch {
      // Expired or deleted sessions are recreated for the same authenticated user.
    }
  }

  const session = await input.composio.sessions.create(
    input.externalUserId,
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
  const { error: writeError } = await input.supabase
    .from("composio_user_sessions")
    .upsert(
      { owner_id: input.user.id, session_id: session.sessionId },
      { onConflict: "owner_id" },
    );
  if (writeError) {
    throw new BrokerError(
      "Unable to save the application connection session.",
      502,
    );
  }
  return session;
}

async function listConnectedAccounts(
  composio: Composio,
  externalUserId: string,
): Promise<ProductConnection[]> {
  const connections: ProductConnection[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_CONNECTED_ACCOUNT_PAGES; page += 1) {
    const response = await composio.connectedAccounts.list(
      {
        userIds: [externalUserId],
        accountType: "ALL",
        limit: CONNECTED_ACCOUNT_PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      },
      requestOptions(),
    );
    connections.push(
      ...response.items.map((connection) =>
        toProductConnection(connection as ConnectedAccountLike),
      ),
    );
    cursor = response.nextCursor ?? undefined;
    if (!cursor) {
      break;
    }
  }
  return connections;
}

async function assertOwnedConnection(
  composio: Composio,
  externalUserId: string,
  connectionId: string,
): Promise<void> {
  const owned = (await listConnectedAccounts(composio, externalUserId)).some(
    (connection) => connection.id === connectionId,
  );
  if (!owned) {
    throw new BrokerError("Application connection not found.", 404);
  }
}

function providerStatus(input: {
  sessionReady: boolean;
  sessionId: string | null;
}) {
  return {
    id: "composio",
    configured: true,
    apiKeySource: "hosted",
    sessionReady: input.sessionReady,
    sessionId: input.sessionId,
    lastError: null,
    features: FEATURES,
  };
}

function groupConnections(
  connections: ProductConnection[],
): Map<string, ProductConnection[]> {
  const grouped = new Map<string, ProductConnection[]>();
  for (const connection of connections) {
    const current = grouped.get(connection.toolkitSlug) ?? [];
    current.push(connection);
    grouped.set(connection.toolkitSlug, current);
  }
  return grouped;
}

function toProductConnection(
  connection: ConnectedAccountLike,
): ProductConnection {
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

function isActiveConnection(connection: ProductConnection): boolean {
  return connection.status === "ACTIVE" && !connection.isDisabled;
}

async function readInput(request: Request): Promise<BrokerInput> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new BrokerError("Request body must be valid JSON.", 400);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BrokerError("Request body must be a JSON object.", 400);
  }
  return value as BrokerInput;
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) {
    return TOOLKIT_PAGE_SIZE;
  }
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new BrokerError("Invalid application catalog limit.", 400);
  }
  return value;
}

function normalizeToolkitSlug(value: string | undefined): string {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(normalized)) {
    throw new BrokerError("Invalid application identifier.", 400);
  }
  return normalized;
}

function normalizeConnectionId(value: string | undefined): string {
  const normalized = value?.trim() ?? "";
  if (!/^[a-zA-Z0-9_-]{1,256}$/.test(normalized)) {
    throw new BrokerError("Invalid application connection identifier.", 400);
  }
  return normalized;
}

function normalizeCallbackUrl(value: string | undefined): string | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new BrokerError("Invalid authorization callback URL.", 400);
  }
  const loopback =
    parsed.protocol === "http:" &&
    parsed.hostname === "127.0.0.1" &&
    /^\/api\/product\/integrations\/composio\/callback$/.test(parsed.pathname);
  if (!loopback) {
    throw new BrokerError(
      "Authorization callback must use local Runtime.",
      400,
    );
  }
  return parsed.toString();
}

function requestOptions(): { signal: AbortSignal } {
  return { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) };
}

function requireSecret(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) {
    throw new BrokerError(
      "Application connection service is not configured.",
      503,
    );
  }
  return value;
}

function safeErrorMessage(error: unknown): string {
  const message =
    error instanceof Error ? error.message : "Application connection failed.";
  return message.replace(/(?:sk|ak)_[a-zA-Z0-9_-]{8,}/g, "[REDACTED]").trim();
}

function corsHeaders(): HeadersInit {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, apikey, content-type",
    "access-control-allow-methods": "POST, OPTIONS",
  };
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      ...corsHeaders(),
      "cache-control": "no-store",
    },
  });
}

class BrokerError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "BrokerError";
  }
}
