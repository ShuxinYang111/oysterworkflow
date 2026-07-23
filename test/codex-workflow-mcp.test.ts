import { describe, expect, it, vi } from "vitest";
import {
  OYSTERWORKFLOW_MCP_TOOLS,
  handleOysterWorkflowMcpMessage,
} from "../src/codex-workflow/mcp.js";
import type { CodexWorkflowService } from "../src/codex-workflow/service.js";

describe("OysterWorkflow Codex MCP", () => {
  it("negotiates MCP and publishes the complete workflow tool surface", async () => {
    const service = buildService();
    const initialized = await handleOysterWorkflowMcpMessage(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      },
      service,
    );
    const listed = await handleOysterWorkflowMcpMessage(
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      service,
    );

    expect(initialized).toMatchObject({
      id: 1,
      result: {
        protocolVersion: "2025-06-18",
        serverInfo: { name: "oysterworkflow", version: "0.3.0" },
        capabilities: { tools: { listChanged: false } },
      },
    });
    expect(listed).toMatchObject({
      id: 2,
      result: { tools: OYSTERWORKFLOW_MCP_TOOLS },
    });
    expect(OYSTERWORKFLOW_MCP_TOOLS.map((tool) => tool.name)).toEqual([
      "search",
      "fetch",
      "prepare_workflow_run",
      "get_workflow_run",
      "advance_workflow_run",
      "cancel_workflow_run",
    ]);
  });

  it("routes tool calls to the shared workflow service", async () => {
    const service = buildService();
    const response = await handleOysterWorkflowMcpMessage(
      {
        jsonrpc: "2.0",
        id: "search-1",
        method: "tools/call",
        params: {
          name: "search",
          arguments: { query: "sales", limit: 5 },
        },
      },
      service,
    );

    expect(service.searchWorkflows).toHaveBeenCalledWith({
      query: "sales",
      limit: 5,
    });
    expect(response).toMatchObject({
      id: "search-1",
      result: {
        isError: false,
        structuredContent: { query: "sales", total: 0, results: [] },
      },
    });
  });

  it("returns MCP tool errors without terminating the server", async () => {
    const service = buildService();
    vi.mocked(service.getRun).mockRejectedValueOnce(
      new Error(
        "Unknown OysterWorkflow MCP run / 未找到 OysterWorkflow MCP 运行",
      ),
    );
    const response = await handleOysterWorkflowMcpMessage(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "get_workflow_run",
          arguments: { runId: "missing" },
        },
      },
      service,
    );

    expect(response).toMatchObject({
      id: 3,
      result: {
        isError: true,
        structuredContent: {
          error: {
            message:
              "Unknown OysterWorkflow MCP run / 未找到 OysterWorkflow MCP 运行",
          },
        },
      },
    });
  });
});

function buildService(): CodexWorkflowService {
  return {
    searchWorkflows: vi.fn(async (input = {}) => ({
      query: input.query ?? "",
      matchMode: input.query ? "query" : "all",
      total: 0,
      results: [],
    })),
    fetchWorkflow: vi.fn(),
    getWorkflowReadiness: vi.fn(),
    prepareRun: vi.fn(),
    getRun: vi.fn(),
    advanceRun: vi.fn(),
    cancelRun: vi.fn(),
  } as CodexWorkflowService;
}
