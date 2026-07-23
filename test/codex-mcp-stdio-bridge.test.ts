import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OYSTERWORKFLOW_MCP_TOOLS } from "../src/codex-workflow/mcp.js";
import type { CodexWorkflowService } from "../src/codex-workflow/service.js";
import type { LabService } from "../src/lab-api/service.js";
import { resolveRuntimeConfig } from "../src/runtime/config.js";
import { createRuntimeHttpApp } from "../src/runtime/server.js";

const bridgePath = join(
  import.meta.dirname,
  "..",
  "integrations",
  "codex-plugin",
  "oysterworkflow",
  "mcp",
  "server.mjs",
);

interface BridgeHarness {
  child: ChildProcessWithoutNullStreams;
  lines: Interface;
}

describe("OysterWorkflow STDIO MCP bridge", () => {
  const bridges: BridgeHarness[] = [];
  const servers: Server[] = [];
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      bridges.splice(0).map(async ({ child, lines }) => {
        lines.close();
        if (child.exitCode === null) {
          const exited = once(child, "exit");
          child.stdin.end();
          await exited;
        }
      }),
    );
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
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("loads before the desktop app and returns an actionable tool error", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oyster-bridge-offline-"));
    temporaryDirectories.push(directory);
    const bridge = startBridge(join(directory, "missing.json"));
    bridges.push(bridge);

    const initialized = await sendRequest(bridge, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    expect(initialized).toMatchObject({
      id: 1,
      result: {
        serverInfo: { name: "oysterworkflow", version: "0.3.0" },
      },
    });

    const listed = await sendRequest(bridge, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    expect(listed.result.tools).toEqual(OYSTERWORKFLOW_MCP_TOOLS);

    const called = await sendRequest(bridge, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "search", arguments: { query: "sales" } },
    });
    expect(called).toMatchObject({
      id: 3,
      result: {
        isError: true,
        structuredContent: {
          error: { code: "OYSTERWORKFLOW_NOT_RUNNING" },
        },
      },
    });
    expect(called.result.content[0].text).toContain("打开桌面应用");
  });

  it("discovers a dynamic port and forwards the per-launch secret", async () => {
    const codexWorkflowService = {
      searchWorkflows: vi.fn(async () => ({
        query: "sales",
        matchMode: "query",
        total: 1,
        results: [{ workflowId: "sales", title: "Sales" }],
      })),
    } as unknown as CodexWorkflowService;
    const app = createRuntimeHttpApp({
      service: {} as LabService,
      codexWorkflowService,
      config: resolveRuntimeConfig({
        mode: "desktop",
        apiPort: 0,
        apiSecret: "per-launch-secret-value",
      }),
    });
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await once(server, "listening");
    const address = server.address() as AddressInfo;

    const directory = await mkdtemp(join(tmpdir(), "oyster-bridge-online-"));
    temporaryDirectories.push(directory);
    const connectionPath = join(directory, "runtime-connection.json");
    await writeFile(
      connectionPath,
      `${JSON.stringify({
        schemaVersion: 1,
        pid: process.pid,
        apiBaseUrl: `http://127.0.0.1:${address.port}`,
        token: "per-launch-secret-value",
        appVersion: "0.2.1",
        startedAt: new Date().toISOString(),
      })}\n`,
      { mode: 0o600 },
    );
    if (process.platform !== "win32") await chmod(connectionPath, 0o600);

    const bridge = startBridge(connectionPath);
    bridges.push(bridge);
    const called = await sendRequest(bridge, {
      jsonrpc: "2.0",
      id: "search-1",
      method: "tools/call",
      params: { name: "search", arguments: { query: "sales" } },
    });

    expect(codexWorkflowService.searchWorkflows).toHaveBeenCalledWith({
      query: "sales",
      limit: undefined,
    });
    expect(called).toMatchObject({
      id: "search-1",
      result: {
        isError: false,
        structuredContent: { total: 1 },
      },
    });
  });
});

function startBridge(connectionPath: string): BridgeHarness {
  const child = spawn(process.execPath, [bridgePath], {
    env: {
      ...process.env,
      OYSTERWORKFLOW_RUNTIME_CONNECTION_FILE: connectionPath,
    },
    stdio: "pipe",
  });
  return {
    child,
    lines: createInterface({ input: child.stdout, crlfDelay: Infinity }),
  };
}

async function sendRequest(
  bridge: BridgeHarness,
  request: Record<string, unknown>,
): Promise<any> {
  const nextLine = once(bridge.lines, "line");
  bridge.child.stdin.write(`${JSON.stringify(request)}\n`);
  const [line] = (await nextLine) as [string];
  return JSON.parse(line);
}
