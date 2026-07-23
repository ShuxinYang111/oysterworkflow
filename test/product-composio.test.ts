import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createComposioProviderAdapter,
  productComposioUserId,
  type ComposioSdkLike,
} from "../src/product/composio.js";
import { resolveRuntimeConfig } from "../src/runtime/config.js";

let tempRoot = "";

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "oyster-composio-"));
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe("Composio provider adapter", () => {
  it("returns an unconfigured overview without creating a remote session", async () => {
    const clientFactory = vi.fn();
    const adapter = createComposioProviderAdapter({
      runtimeConfig: runtimeConfig(),
      environment: {},
      clientFactory,
    });

    const overview = await adapter.overview({ userId: "oysterworkflow:test" });

    expect(overview).toEqual({
      provider: expect.objectContaining({
        configured: false,
        apiKeySource: "none",
        features: {
          unrestrictedToolkits: true,
          dynamicDiscovery: true,
          fullToolCatalog: true,
          remoteSandbox: true,
          mcp: true,
        },
      }),
      items: [],
      nextCursor: null,
      totalPages: 0,
    });
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it("creates an unrestricted MCP session and persists the local key securely", async () => {
    const create = vi.fn();
    const toolkits = vi.fn().mockResolvedValue({
      items: [
        {
          slug: "github",
          name: "GitHub",
          logo: "https://cdn.example/github.png",
          isNoAuth: false,
          connection: { isActive: true },
        },
        {
          slug: "weather",
          name: "Weather",
          isNoAuth: true,
        },
      ],
      cursor: "next-page",
      totalPages: 4,
    });
    const session = fakeSession({ toolkits });
    create.mockResolvedValue(session);
    const connectedAccounts = [
      fakeAccount({ id: "conn-github", toolkitSlug: "github" }),
    ];
    const client = fakeClient({ create, connectedAccounts });
    const clientFactory = vi.fn(() => client);
    const adapter = createComposioProviderAdapter({
      runtimeConfig: runtimeConfig(),
      environment: {},
      clientFactory,
    });

    const configured = await adapter.configure("ak_local_test_123456789");
    const overview = await adapter.overview({
      userId: "oysterworkflow:workspace:account",
      search: "git",
      filter: "all",
    });

    expect(configured).toMatchObject({
      configured: true,
      apiKeySource: "local_file",
    });
    expect(clientFactory).toHaveBeenCalledWith("ak_local_test_123456789");
    expect(create).toHaveBeenCalledTimes(1);
    const createConfig = create.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(createConfig).toEqual({
      mcp: true,
      manageConnections: true,
      sandbox: { enable: true },
      multiAccount: {
        enable: true,
        maxAccountsPerToolkit: 10,
        requireExplicitSelection: false,
      },
    });
    expect(createConfig).not.toHaveProperty("toolkits");
    expect(createConfig).not.toHaveProperty("tools");
    expect(createConfig).not.toHaveProperty("tags");
    expect(createConfig).not.toHaveProperty("sessionPreset");
    expect(toolkits).toHaveBeenCalledWith(
      expect.objectContaining({ search: "git", limit: 48 }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(overview.items).toEqual([
      expect.objectContaining({
        slug: "github",
        connected: true,
        connections: [expect.objectContaining({ id: "conn-github" })],
      }),
    ]);
    expect(overview.items).not.toContainEqual(
      expect.objectContaining({ slug: "weather" }),
    );
    expect(overview.nextCursor).toBe("next-page");

    const configPath = join(tempRoot, "config", "composio.config.json");
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
      version: 1,
      apiKey: "ak_local_test_123456789",
      sessions: {
        "oysterworkflow:workspace:account": {
          sessionId: "session-full",
        },
      },
    });
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
  });

  it("reuses a persisted session and exposes its hosted MCP endpoint", async () => {
    const firstSession = fakeSession();
    const firstClient = fakeClient({
      create: vi.fn().mockResolvedValue(firstSession),
    });
    const firstAdapter = createComposioProviderAdapter({
      runtimeConfig: runtimeConfig(),
      environment: { COMPOSIO_API_KEY: "ak_environment_test_123456" },
      clientFactory: () => firstClient,
    });
    await firstAdapter.getMcpServer("oysterworkflow:stable");

    const use = vi.fn().mockResolvedValue(firstSession);
    const secondClient = fakeClient({ use });
    const secondAdapter = createComposioProviderAdapter({
      runtimeConfig: runtimeConfig(),
      environment: { COMPOSIO_API_KEY: "ak_environment_test_123456" },
      clientFactory: () => secondClient,
    });
    const mcp = await secondAdapter.getMcpServer("oysterworkflow:stable");

    expect(use).toHaveBeenCalledWith(
      "session-full",
      { mcp: true },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(mcp).toEqual({
      name: "composio",
      url: "https://mcp.example/session-full",
      headers: { "x-api-key": "ak_test" },
      timeoutSeconds: 120,
    });
  });

  it("keeps a superseded session request from overwriting or evicting the latest credential session", async () => {
    let resolveOldSession!: (session: ReturnType<typeof fakeSession>) => void;
    const oldCreate = vi.fn(
      () =>
        new Promise<ReturnType<typeof fakeSession>>((resolveSession) => {
          resolveOldSession = resolveSession;
        }),
    );
    const newSession = {
      ...fakeSession(),
      sessionId: "session-new",
    };
    const newCreate = vi.fn().mockResolvedValue(newSession);
    const adapter = createComposioProviderAdapter({
      runtimeConfig: runtimeConfig(),
      environment: {},
      clientFactory: (apiKey) =>
        apiKey === "ak_old_test_123456789"
          ? fakeClient({ create: oldCreate })
          : fakeClient({ create: newCreate }),
    });
    const userId = "oysterworkflow:rotated";

    await adapter.configure("ak_old_test_123456789");
    const supersededOverview = adapter.overview({ userId });
    await vi.waitFor(() => expect(oldCreate).toHaveBeenCalledTimes(1));

    await adapter.configure("ak_new_test_123456789");
    const latestOverview = adapter.overview({ userId });
    await vi.waitFor(() => expect(newCreate).toHaveBeenCalledTimes(1));
    resolveOldSession({ ...fakeSession(), sessionId: "session-old" });

    await expect(supersededOverview).rejects.toThrow(
      /configuration changed|credentials changed/i,
    );
    await expect(latestOverview).resolves.toMatchObject({
      provider: { configured: true },
    });
    await expect(adapter.overview({ userId })).resolves.toMatchObject({
      provider: { configured: true },
    });
    expect(newCreate).toHaveBeenCalledTimes(1);

    const configPath = join(tempRoot, "config", "composio.config.json");
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
      apiKey: "ak_new_test_123456789",
      sessions: {
        [userId]: {
          sessionId: "session-new",
        },
      },
    });
  });

  it("authorizes, reads, and disconnects a connection owned by the product user", async () => {
    const account = fakeAccount({
      id: "conn-new",
      toolkitSlug: "gmail",
      status: "INITIATED",
    });
    const authorize = vi.fn().mockResolvedValue({
      id: "conn-new",
      status: "INITIATED",
      redirectUrl: "https://connect.composio.dev/conn-new",
    });
    const remove = vi.fn().mockResolvedValue({});
    const client = fakeClient({
      create: vi.fn().mockResolvedValue(fakeSession({ authorize })),
      connectedAccounts: [account],
      getConnection: vi.fn().mockResolvedValue(account),
      deleteConnection: remove,
    });
    const adapter = createComposioProviderAdapter({
      runtimeConfig: runtimeConfig(),
      environment: { COMPOSIO_API_KEY: "ak_test_123456789" },
      clientFactory: () => client,
    });

    await expect(
      adapter.authorize({
        userId: "oysterworkflow:test",
        toolkitSlug: "gmail",
        callbackUrl:
          "http://127.0.0.1:3034/api/product/integrations/composio/callback",
      }),
    ).resolves.toEqual({
      connectionId: "conn-new",
      status: "INITIATED",
      redirectUrl: "https://connect.composio.dev/conn-new",
    });
    expect(authorize).toHaveBeenCalledWith(
      "gmail",
      {
        callbackUrl:
          "http://127.0.0.1:3034/api/product/integrations/composio/callback",
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await expect(
      adapter.getConnection({
        userId: "oysterworkflow:test",
        connectionId: "conn-new",
      }),
    ).resolves.toMatchObject({ id: "conn-new", toolkitSlug: "gmail" });
    await adapter.disconnect({
      userId: "oysterworkflow:test",
      connectionId: "conn-new",
    });
    expect(remove).toHaveBeenCalledWith(
      "conn-new",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("builds the same stable user id for UI and worker integration", () => {
    expect(
      productComposioUserId({
        workspaceId: "workspace 1",
        accountId: "account@example.com",
      }),
    ).toBe("oysterworkflow:workspace-1:account-example-com");
  });
});

function runtimeConfig() {
  return resolveRuntimeConfig({
    mode: "test",
    runsRoot: join(tempRoot, "runs"),
    skillManagerConfigPath: join(
      tempRoot,
      "config",
      "skill-manager.config.json",
    ),
    projectRootDir: tempRoot,
  });
}

function fakeSession(
  input: {
    toolkits?: ReturnType<typeof vi.fn>;
    authorize?: ReturnType<typeof vi.fn>;
  } = {},
) {
  return {
    sessionId: "session-full",
    mcp: {
      type: "http" as const,
      url: "https://mcp.example/session-full",
      headers: { "x-api-key": "ak_test" },
    },
    sandbox: { enable: true },
    toolkits:
      input.toolkits ?? vi.fn().mockResolvedValue({ items: [], totalPages: 1 }),
    authorize:
      input.authorize ??
      vi.fn().mockResolvedValue({
        id: "conn-test",
        status: "INITIATED",
        redirectUrl: "https://connect.composio.dev/conn-test",
      }),
  };
}

function fakeClient(
  input: {
    create?: ReturnType<typeof vi.fn>;
    use?: ReturnType<typeof vi.fn>;
    connectedAccounts?: Array<ReturnType<typeof fakeAccount>>;
    getConnection?: ReturnType<typeof vi.fn>;
    deleteConnection?: ReturnType<typeof vi.fn>;
  } = {},
): ComposioSdkLike {
  const accounts = input.connectedAccounts ?? [];
  return {
    sessions: {
      create: input.create ?? vi.fn().mockResolvedValue(fakeSession()),
      use: input.use ?? vi.fn().mockRejectedValue(new Error("session missing")),
    },
    connectedAccounts: {
      list: vi.fn().mockResolvedValue({ items: accounts, nextCursor: null }),
      get:
        input.getConnection ??
        vi
          .fn()
          .mockResolvedValue(accounts[0] ?? fakeAccount({ id: "conn-test" })),
      delete: input.deleteConnection ?? vi.fn().mockResolvedValue({}),
    },
    toolkits: {
      get: vi.fn().mockResolvedValue([]),
    },
  };
}

function fakeAccount(input: {
  id: string;
  toolkitSlug?: string;
  status?: string;
}) {
  return {
    id: input.id,
    alias: null,
    status: input.status ?? "ACTIVE",
    statusReason: null,
    toolkit: { slug: input.toolkitSlug ?? "github" },
    isDisabled: false,
    createdAt: "2026-07-09T00:00:00.000Z",
    updatedAt: "2026-07-09T00:00:00.000Z",
  };
}
