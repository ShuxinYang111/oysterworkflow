import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LabService } from "../src/lab-api/service.js";
import type { CodexWorkflowService } from "../src/codex-workflow/service.js";
import {
  resolveRuntimeConfig,
  RUNTIME_API_SECRET_HEADER,
} from "../src/runtime/config.js";
import { createRuntimeHttpApp } from "../src/runtime/server.js";

describe("OysterWorkflow MCP HTTP endpoint", () => {
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

  it("serves stateless MCP JSON-RPC over the local Runtime port", async () => {
    const codexWorkflowService = {
      searchWorkflows: vi.fn(async () => ({
        query: "sales",
        matchMode: "query",
        total: 0,
        results: [],
      })),
    } as unknown as CodexWorkflowService;
    const app = createRuntimeHttpApp({
      service: {} as LabService,
      codexWorkflowService,
      config: resolveRuntimeConfig({
        mode: "desktop",
        apiPort: 0,
        apiSecret: "codex-runtime-test-secret",
      }),
    });
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((resolveListen) =>
      server.once("listening", resolveListen),
    );
    const address = server.address() as AddressInfo;
    const endpoint = `http://127.0.0.1:${address.port}/api/mcp`;

    const unauthenticatedResponse = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "unauthenticated",
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      }),
    });
    expect(unauthenticatedResponse.status).toBe(401);

    const initializeResponse = await fetch(endpoint, {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        [RUNTIME_API_SECRET_HEADER]: "codex-runtime-test-secret",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      }),
    });
    expect(initializeResponse.status).toBe(200);
    await expect(initializeResponse.json()).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-06-18",
        serverInfo: { name: "oysterworkflow" },
      },
    });

    const toolResponse = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [RUNTIME_API_SECRET_HEADER]: "codex-runtime-test-secret",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "search", arguments: { query: "sales" } },
      }),
    });
    expect(toolResponse.status).toBe(200);
    await expect(toolResponse.json()).resolves.toMatchObject({
      id: 2,
      result: {
        isError: false,
        structuredContent: { query: "sales", total: 0, results: [] },
      },
    });

    const getResponse = await fetch(endpoint, {
      headers: {
        [RUNTIME_API_SECRET_HEADER]: "codex-runtime-test-secret",
      },
    });
    expect(getResponse.status).toBe(405);
    expect(getResponse.headers.get("allow")).toBe("POST");

    const compatibilityResponse = await fetch(
      `http://127.0.0.1:${address.port}/api/codex/mcp`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [RUNTIME_API_SECRET_HEADER]: "codex-runtime-test-secret",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "compatibility",
          method: "ping",
          params: {},
        }),
      },
    );
    expect(compatibilityResponse.status).toBe(200);
    await expect(compatibilityResponse.json()).resolves.toMatchObject({
      id: "compatibility",
      result: {},
    });
  });
});
