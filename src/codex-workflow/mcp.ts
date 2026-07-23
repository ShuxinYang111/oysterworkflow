import { z } from "zod";
import type { CodexWorkflowService } from "./service.js";

const MCP_SERVER_NAME = "oysterworkflow";
const MCP_SERVER_VERSION = "0.3.0";
const DEFAULT_MCP_PROTOCOL_VERSION = "2025-06-18";

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

const searchInputSchema = z.object({
  query: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
const workflowIdInputSchema = z.object({
  workflowId: z.string().min(1),
});
const prepareRunInputSchema = z.object({
  workflowId: z.string().min(1),
  expectedRevisionId: z.string().min(1).optional(),
  inputs: z.record(z.string(), z.unknown()).optional(),
});
const runIdInputSchema = z.object({
  runId: z.string().min(1),
});
const advanceRunInputSchema = z.object({
  runId: z.string().min(1),
  currentNodeId: z.string().min(1),
  transitionId: z.string().min(1).optional(),
  summary: z.string().min(1),
  evidence: z
    .array(
      z.object({
        kind: z.enum(["observation", "url", "artifact", "receipt"]),
        value: z.string().min(1),
        label: z.string().min(1).optional(),
      }),
    )
    .max(100)
    .optional(),
});

export const OYSTERWORKFLOW_MCP_TOOLS = [
  {
    name: "search",
    title: "Search OysterWorkflow workflows / 搜索工作流",
    description:
      "Search workflows recorded, generated, or managed by OysterWorkflow. Results include whether an executable canonical graph exists. When natural-language terms have no literal match, matchMode=fallback returns candidates to compare by meaning. / 搜索 OysterWorkflow 录制、生成或管理的工作流，并返回是否存在可执行规范图。自然语言无字面匹配时，matchMode=fallback 会返回候选供语义比较。",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Title, description, app, or id.",
        },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: "fetch",
    title: "Fetch OysterWorkflow workflow / 读取工作流",
    description:
      "Fetch workflow metadata and its revisioned canonical graph. Read the graph before preparing a run. / 读取工作流元数据和带 revision 的规范执行图；准备运行前应先读取。",
    inputSchema: {
      type: "object",
      properties: { workflowId: { type: "string" } },
      required: ["workflowId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: "prepare_workflow_run",
    title: "Prepare agent-hosted workflow run / 准备 Agent 托管运行",
    description:
      "Pin the current workflow revision and create durable run state. This does not execute external actions. Execute only the returned current node with the current agent's tools, then advance. / 固定当前 revision 并创建持久运行状态；本工具不执行外部动作。之后仅使用当前 Agent 的工具执行返回节点，再推进状态。",
    inputSchema: {
      type: "object",
      properties: {
        workflowId: { type: "string" },
        expectedRevisionId: { type: "string" },
        inputs: { type: "object", additionalProperties: true },
      },
      required: ["workflowId"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  {
    name: "get_workflow_run",
    title: "Get workflow run state / 读取运行状态",
    description:
      "Read the pinned revision, current node, available transitions, and next action for an agent-hosted run. / 读取 Agent 托管运行的固定 revision、当前节点、可选 transition 与下一动作。",
    inputSchema: {
      type: "object",
      properties: { runId: { type: "string" } },
      required: ["runId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: "advance_workflow_run",
    title: "Advance workflow run / 推进工作流运行",
    description:
      "After the current agent completes or observes the current node, record evidence and traverse one validated transition. currentNodeId is an optimistic concurrency guard. / 当前 Agent 完成或观察节点后，记录证据并沿一条已校验 transition 推进；currentNodeId 用于并发保护。",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string" },
        currentNodeId: { type: "string" },
        transitionId: { type: "string" },
        summary: { type: "string" },
        evidence: {
          type: "array",
          maxItems: 100,
          items: {
            type: "object",
            properties: {
              kind: {
                type: "string",
                enum: ["observation", "url", "artifact", "receipt"],
              },
              value: { type: "string" },
              label: { type: "string" },
            },
            required: ["kind", "value"],
            additionalProperties: false,
          },
        },
      },
      required: ["runId", "currentNodeId", "summary"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  {
    name: "cancel_workflow_run",
    title: "Cancel workflow run / 取消工作流运行",
    description:
      "Cancel local run state and stop further workflow actions. This cannot undo external actions already taken by the current agent. / 取消本地运行并停止后续动作；无法撤销当前 Agent 已完成的外部操作。",
    inputSchema: {
      type: "object",
      properties: { runId: { type: "string" } },
      required: ["runId"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    },
  },
] as const;

/**
 * CN: 处理任意 MCP Host 发来的单条 JSON-RPC 消息；HTTP transport 保持无会话状态。
 * EN: Handles one MCP host JSON-RPC message using a stateless HTTP transport.
 * @param value untrusted JSON request body.
 * @param service OysterWorkflow discovery and run service.
 * @returns JSON-RPC response, or null for notifications.
 */
export async function handleOysterWorkflowMcpMessage(
  value: unknown,
  service: CodexWorkflowService,
): Promise<JsonRpcResponse | null> {
  const request = parseRequest(value);
  if (!request) {
    return failure(null, -32600, "Invalid JSON-RPC request.");
  }
  const id = request.id ?? null;
  const isNotification = request.id === undefined;

  try {
    switch (request.method) {
      case "initialize": {
        const params = z
          .object({ protocolVersion: z.string().min(1).optional() })
          .passthrough()
          .parse(request.params ?? {});
        return success(id, {
          protocolVersion:
            params.protocolVersion ?? DEFAULT_MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: {
            name: MCP_SERVER_NAME,
            version: MCP_SERVER_VERSION,
          },
          instructions:
            "Use search and fetch to select an OysterWorkflow workflow, prepare a revision-pinned run, execute exactly one current node with the tools available in this MCP host, then advance with evidence. OysterWorkflow provides workflow state; this agent remains responsible for external actions and its own tools and permissions. / 使用 search 和 fetch 选择工作流，创建固定 revision 的运行；每次使用当前 MCP Host 的工具执行一个节点，并携带证据推进。OysterWorkflow 提供工作流状态；外部动作以及工具和权限由当前 Agent 自行负责。",
        });
      }
      case "notifications/initialized":
      case "notifications/cancelled":
        return null;
      case "ping":
        return isNotification ? null : success(id, {});
      case "tools/list":
        return isNotification
          ? null
          : success(id, { tools: OYSTERWORKFLOW_MCP_TOOLS });
      case "tools/call": {
        if (isNotification) return null;
        const params = z
          .object({
            name: z.string().min(1),
            arguments: z.unknown().optional(),
          })
          .parse(request.params ?? {});
        return success(
          id,
          await callTool(params.name, params.arguments ?? {}, service),
        );
      }
      default:
        return isNotification
          ? null
          : failure(id, -32601, `Method not found: ${request.method}`);
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      return failure(id, -32602, "Invalid method parameters.", {
        issues: error.issues,
      });
    }
    return failure(
      id,
      -32603,
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function callTool(
  name: string,
  rawArguments: unknown,
  service: CodexWorkflowService,
): Promise<Record<string, unknown>> {
  try {
    let result: object;
    switch (name) {
      case "search": {
        const input = searchInputSchema.parse(rawArguments);
        result = await service.searchWorkflows(input);
        break;
      }
      case "fetch": {
        const input = workflowIdInputSchema.parse(rawArguments);
        result = await service.fetchWorkflow(input.workflowId);
        break;
      }
      case "prepare_workflow_run": {
        const input = prepareRunInputSchema.parse(rawArguments);
        result = await service.prepareRun(input);
        break;
      }
      case "get_workflow_run": {
        const input = runIdInputSchema.parse(rawArguments);
        result = await service.getRun(input.runId);
        break;
      }
      case "advance_workflow_run": {
        const input = advanceRunInputSchema.parse(rawArguments);
        const { runId, ...advanceInput } = input;
        result = await service.advanceRun(runId, advanceInput);
        break;
      }
      case "cancel_workflow_run": {
        const input = runIdInputSchema.parse(rawArguments);
        result = await service.cancelRun(input.runId);
        break;
      }
      default:
        return toolError(`Unknown OysterWorkflow tool: ${name}`);
    }
    return toolSuccess(result);
  } catch (error) {
    return toolError(error instanceof Error ? error.message : String(error));
  }
}

function toolSuccess(result: object): Record<string, unknown> {
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    structuredContent: result,
    isError: false,
  };
}

function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: "text", text: message }],
    structuredContent: { error: { message } },
    isError: true,
  };
}

function parseRequest(value: unknown): JsonRpcRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.jsonrpc !== "2.0" || typeof candidate.method !== "string") {
    return null;
  }
  if (
    candidate.id !== undefined &&
    candidate.id !== null &&
    typeof candidate.id !== "string" &&
    typeof candidate.id !== "number"
  ) {
    return null;
  }
  return candidate as unknown as JsonRpcRequest;
}

function success(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function failure(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}
