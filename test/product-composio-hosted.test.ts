import { describe, expect, it, vi } from "vitest";
import { createRuntimeCloudSession } from "../src/cloud/runtime-session.js";
import { createHostedComposioProviderAdapter } from "../src/product/composio-hosted.js";

describe("hosted Composio provider adapter", () => {
  it("requires sign-in without reading a local provider key", async () => {
    const cloudSession = createRuntimeCloudSession();
    const fetchFn = vi.fn();
    const adapter = createHostedComposioProviderAdapter({
      cloudSession,
      brokerUrl: "https://broker.example/composio",
      fetchFn,
    });

    await expect(
      adapter.overview({ userId: "ignored-local-user" }),
    ).rejects.toThrow("Sign in to connect applications.");
    await expect(
      adapter.getMcpServer("ignored-local-user", { allowMissing: true }),
    ).resolves.toBeNull();
    await expect(adapter.snapshot()).resolves.toMatchObject({
      id: "composio",
      installed: false,
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("authenticates with Supabase and never sends a caller-controlled user id", async () => {
    const cloudSession = createRuntimeCloudSession();
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          provider: providerStatus(),
          items: [],
          nextCursor: null,
          totalPages: 0,
        }),
        { status: 200 },
      ),
    );
    const adapter = createHostedComposioProviderAdapter({
      cloudSession,
      brokerUrl: "https://broker.example/composio",
      fetchFn,
    });

    await cloudSession.runWithAccessToken("supabase-user-token", () =>
      adapter.overview({
        userId: "attacker-controlled-user",
        search: "gmail",
        filter: "not_connected",
        limit: 24,
      }),
    );

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get("authorization")).toBe(
      "Bearer supabase-user-token",
    );
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toEqual({
      action: "overview",
      search: "gmail",
      filter: "not_connected",
      limit: 24,
    });
    expect(body).not.toHaveProperty("userId");
    expect(body).not.toHaveProperty("apiKey");
  });

  it("returns only the user-scoped MCP session supplied by the broker", async () => {
    const cloudSession = createRuntimeCloudSession();
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          server: {
            name: "composio",
            url: "https://mcp.example/user-session",
            headers: { "x-session-token": "scoped-token" },
            timeoutSeconds: 120,
          },
        }),
        { status: 200 },
      ),
    );
    const adapter = createHostedComposioProviderAdapter({
      cloudSession,
      brokerUrl: "https://broker.example/composio",
      fetchFn,
    });

    await expect(
      cloudSession.runWithAccessToken("supabase-user-token", () =>
        adapter.getMcpServer("ignored-user"),
      ),
    ).resolves.toEqual({
      name: "composio",
      url: "https://mcp.example/user-session",
      headers: { "x-session-token": "scoped-token" },
      timeoutSeconds: 120,
    });
    const body = JSON.parse(
      String((fetchFn.mock.calls[0]?.[1] as RequestInit).body),
    );
    expect(body).toEqual({ action: "mcp" });
  });

  it("keeps the Supabase token inside its Runtime request scope", () => {
    const cloudSession = createRuntimeCloudSession();
    expect(cloudSession.getAccessToken()).toBeNull();
    expect(
      cloudSession.runWithAccessToken(" supabase-user-token ", () =>
        cloudSession.getAccessToken(),
      ),
    ).toBe("supabase-user-token");
    expect(cloudSession.getAccessToken()).toBeNull();
  });
});

function providerStatus() {
  return {
    id: "composio",
    configured: true,
    apiKeySource: "hosted",
    sessionReady: true,
    sessionId: "session-user",
    lastError: null,
    features: {
      unrestrictedToolkits: true,
      dynamicDiscovery: true,
      fullToolCatalog: true,
      remoteSandbox: true,
      mcp: true,
    },
  };
}
