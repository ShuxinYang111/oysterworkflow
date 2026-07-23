import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const SERVER_NAME = "oysterworkflow";
const SERVER_VERSION = "0.3.0";
const PROTOCOL_VERSION = "2025-06-18";
const CONNECTION_SCHEMA_VERSION = 1;
const RUNTIME_SECRET_HEADER = "x-oysterworkflow-runtime-secret";
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const toolsPath = join(dirname(fileURLToPath(import.meta.url)), "tools.json");
const tools = validateTools(JSON.parse(await readFile(toolsPath, "utf8")));

const instructions =
  "Use search and fetch to select an OysterWorkflow workflow, prepare a revision-pinned run, execute exactly one current node with the tools available in this MCP host, then advance with evidence. OysterWorkflow provides workflow state; this agent remains responsible for external actions and its own tools and permissions. / 使用 search 和 fetch 选择工作流，创建固定 revision 的运行；每次使用当前 MCP Host 的工具执行一个节点，并携带证据推进。OysterWorkflow 提供工作流状态；外部动作以及工具和权限由当前 Agent 自行负责。";

class BridgeConnectionError extends Error {
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "BridgeConnectionError";
    this.code = code;
  }
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of input) {
  if (!line.trim()) continue;
  const response = await handleLine(line);
  if (response !== null) {
    process.stdout.write(`${JSON.stringify(response)}\n`);
  }
}

async function handleLine(line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return failure(
      null,
      -32700,
      "Invalid JSON received by OysterWorkflow MCP bridge.",
    );
  }

  if (!isJsonRpcRequest(request)) {
    return failure(null, -32600, "Invalid JSON-RPC request.");
  }

  const id = request.id ?? null;
  const isNotification = request.id === undefined;
  switch (request.method) {
    case "initialize":
      return isNotification
        ? null
        : success(id, {
            protocolVersion:
              typeof request.params?.protocolVersion === "string"
                ? request.params.protocolVersion
                : PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
            instructions,
          });
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;
    case "ping":
      return isNotification ? null : success(id, {});
    case "tools/list":
      return isNotification ? null : success(id, { tools });
    case "tools/call":
      if (isNotification) return null;
      try {
        return await forwardToolCall(request);
      } catch (error) {
        const unavailable = toConnectionError(error);
        logError(unavailable.message);
        return success(id, {
          content: [{ type: "text", text: unavailable.message }],
          structuredContent: {
            error: { code: unavailable.code, message: unavailable.message },
          },
          isError: true,
        });
      }
    default:
      return isNotification
        ? null
        : failure(id, -32601, `Method not found: ${request.method}`);
  }
}

async function forwardToolCall(request) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = await loadConnectionDescriptor();
      return await postJsonRpc(descriptor, request);
    } catch (error) {
      lastError = error;
      if (attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 75));
      }
    }
  }
  throw lastError;
}

async function postJsonRpc(descriptor, request) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const requestBody = JSON.stringify(request);
    let response;
    for (const route of ["/api/mcp", "/api/codex/mcp"]) {
      response = await fetch(`${descriptor.apiBaseUrl}${route}`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          [RUNTIME_SECRET_HEADER]: descriptor.token,
        },
        body: requestBody,
        signal: controller.signal,
      });
      if (response.status !== 404 || route === "/api/codex/mcp") break;
    }
    if (!response) {
      throw new Error("OysterWorkflow Runtime did not return a response.");
    }
    if (response.status === 401) {
      throw new BridgeConnectionError(
        "STALE_CONNECTION",
        "OysterWorkflow restarted or its connection expired. Wait for the app to finish starting, then retry. / OysterWorkflow 已重启或连接已过期，请等待应用启动完成后重试。",
      );
    }
    if (!response.ok) {
      throw new BridgeConnectionError(
        "RUNTIME_REQUEST_FAILED",
        `OysterWorkflow Runtime returned HTTP ${response.status}. Restart OysterWorkflow and retry. / OysterWorkflow Runtime 返回 HTTP ${response.status}，请重启应用后重试。`,
      );
    }
    const body = await response.text();
    if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) {
      throw new BridgeConnectionError(
        "RUNTIME_RESPONSE_TOO_LARGE",
        "OysterWorkflow Runtime returned an oversized MCP response. / OysterWorkflow Runtime 返回的 MCP 响应过大。",
      );
    }
    const parsed = JSON.parse(body);
    if (!parsed || parsed.jsonrpc !== "2.0") {
      throw new Error("Runtime returned an invalid JSON-RPC response.");
    }
    return parsed;
  } catch (error) {
    if (error instanceof BridgeConnectionError) throw error;
    throw new BridgeConnectionError(
      "OYSTERWORKFLOW_UNREACHABLE",
      "Cannot reach OysterWorkflow. Open or restart the OysterWorkflow desktop app, wait until it is ready, then retry. / 无法连接 OysterWorkflow，请打开或重启桌面应用，等待启动完成后重试。",
      error,
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function loadConnectionDescriptor() {
  const candidates = resolveConnectionCandidates();
  let sawCandidate = false;
  let lastError;

  for (const filePath of candidates) {
    try {
      const fileStat = await stat(filePath);
      sawCandidate = true;
      assertPrivateOwnerFile(filePath, fileStat);
      const descriptor = validateDescriptor(
        JSON.parse(await readFile(filePath, "utf8")),
      );
      assertOwnerProcessAlive(descriptor.pid);
      return descriptor;
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      lastError = error;
      if (process.env.OYSTERWORKFLOW_RUNTIME_CONNECTION_FILE) break;
    }
  }

  if (sawCandidate && lastError) {
    if (lastError instanceof BridgeConnectionError) throw lastError;
    throw new BridgeConnectionError(
      "INVALID_CONNECTION_FILE",
      "OysterWorkflow connection information is invalid. Restart OysterWorkflow and retry. / OysterWorkflow 连接信息无效，请重启应用后重试。",
      lastError,
    );
  }
  throw new BridgeConnectionError(
    "OYSTERWORKFLOW_NOT_RUNNING",
    "OysterWorkflow is not running. Open the OysterWorkflow desktop app, wait until it is ready, then retry. / OysterWorkflow 尚未运行，请打开桌面应用并等待启动完成后重试。",
  );
}

function resolveConnectionCandidates() {
  const override = process.env.OYSTERWORKFLOW_RUNTIME_CONNECTION_FILE;
  if (override) return [override];

  const home = homedir();
  if (process.platform === "darwin") {
    const applicationSupport = join(home, "Library", "Application Support");
    return [
      join(
        applicationSupport,
        "oysterworkflow",
        "mcp",
        "runtime-connection.json",
      ),
      join(
        applicationSupport,
        "OysterWorkflow",
        "mcp",
        "runtime-connection.json",
      ),
      join(
        applicationSupport,
        "oysterworkflow",
        "codex",
        "runtime-connection.json",
      ),
      join(
        applicationSupport,
        "OysterWorkflow",
        "codex",
        "runtime-connection.json",
      ),
    ];
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
    return [
      join(appData, "oysterworkflow", "mcp", "runtime-connection.json"),
      join(appData, "OysterWorkflow", "mcp", "runtime-connection.json"),
      join(appData, "oysterworkflow", "codex", "runtime-connection.json"),
      join(appData, "OysterWorkflow", "codex", "runtime-connection.json"),
    ];
  }
  const configRoot = process.env.XDG_CONFIG_HOME ?? join(home, ".config");
  return [
    join(configRoot, "oysterworkflow", "mcp", "runtime-connection.json"),
    join(configRoot, "OysterWorkflow", "mcp", "runtime-connection.json"),
    join(configRoot, "oysterworkflow", "codex", "runtime-connection.json"),
    join(configRoot, "OysterWorkflow", "codex", "runtime-connection.json"),
  ];
}

function assertPrivateOwnerFile(filePath, fileStat) {
  if (!fileStat.isFile()) {
    throw new BridgeConnectionError(
      "INVALID_CONNECTION_FILE",
      `OysterWorkflow connection path is not a file: ${filePath}`,
    );
  }
  if (process.platform === "win32") return;
  if ((fileStat.mode & 0o077) !== 0) {
    throw new BridgeConnectionError(
      "INSECURE_CONNECTION_FILE",
      "OysterWorkflow connection file permissions are unsafe. Restart OysterWorkflow to repair them. / OysterWorkflow 连接文件权限不安全，请重启应用修复。",
    );
  }
  if (
    typeof process.getuid === "function" &&
    fileStat.uid !== process.getuid()
  ) {
    throw new BridgeConnectionError(
      "INSECURE_CONNECTION_FILE",
      "OysterWorkflow connection file belongs to another user. / OysterWorkflow 连接文件属于其他用户。",
    );
  }
}

function validateDescriptor(value) {
  if (
    !value ||
    value.schemaVersion !== CONNECTION_SCHEMA_VERSION ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    typeof value.apiBaseUrl !== "string" ||
    typeof value.token !== "string" ||
    value.token.length < 16 ||
    typeof value.appVersion !== "string" ||
    !value.appVersion ||
    typeof value.startedAt !== "string" ||
    Number.isNaN(Date.parse(value.startedAt))
  ) {
    throw new Error("Connection descriptor does not match schema version 1.");
  }
  const url = new URL(value.apiBaseUrl);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Connection descriptor does not point to loopback Runtime.",
    );
  }
  return { ...value, apiBaseUrl: url.origin };
}

function assertOwnerProcessAlive(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error?.code === "EPERM") return;
    throw new BridgeConnectionError(
      "STALE_CONNECTION",
      "OysterWorkflow connection information is stale. Open or restart OysterWorkflow and retry. / OysterWorkflow 连接信息已失效，请打开或重启应用后重试。",
      error,
    );
  }
}

function validateTools(value) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((tool) => !tool || typeof tool.name !== "string")
  ) {
    throw new Error("OysterWorkflow MCP tool catalog is invalid.");
  }
  return value;
}

function isJsonRpcRequest(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    value.jsonrpc === "2.0" &&
    typeof value.method === "string"
  );
}

function success(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function failure(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function toConnectionError(error) {
  return error instanceof BridgeConnectionError
    ? error
    : new BridgeConnectionError(
        "OYSTERWORKFLOW_UNREACHABLE",
        "Cannot reach OysterWorkflow. Open or restart the desktop app, then retry. / 无法连接 OysterWorkflow，请打开或重启桌面应用后重试。",
        error,
      );
}

function logError(message) {
  process.stderr.write(`[oysterworkflow-mcp] ${message}\n`);
}
