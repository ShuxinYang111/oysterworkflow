import { rm } from "node:fs/promises";
import { writeJsonAtomic } from "../src/io/atomic-json.js";

export const OYSTERWORKFLOW_MCP_CONNECTION_SCHEMA_VERSION = 1 as const;

export interface OysterWorkflowMcpConnectionDescriptor {
  schemaVersion: typeof OYSTERWORKFLOW_MCP_CONNECTION_SCHEMA_VERSION;
  pid: number;
  apiBaseUrl: string;
  token: string;
  appVersion: string;
  startedAt: string;
}

/**
 * EN: Publishes the private connection descriptor consumed by local MCP clients.
 * 中文: 发布供本机 MCP 客户端读取的私有连接描述文件。
 * @param input current desktop runtime connection and ownership information.
 * @returns the validated descriptor written atomically to disk.
 */
export async function publishOysterWorkflowMcpConnection(input: {
  filePath: string;
  apiBaseUrl: string;
  token: string;
  pid: number;
  appVersion: string;
  now?: Date;
}): Promise<OysterWorkflowMcpConnectionDescriptor> {
  const descriptor = createOysterWorkflowMcpConnectionDescriptor(input);
  await writeJsonAtomic(input.filePath, descriptor, {
    backup: false,
    mode: 0o600,
  });
  return descriptor;
}

/**
 * EN: Removes a published descriptor so new MCP calls cannot target a stopped runtime.
 * 中文: 删除已发布的描述文件，避免 MCP 继续连接已停止的 Runtime。
 * @param filePath descriptor path under Electron userData.
 * @returns when the descriptor has been removed or was already absent.
 */
export async function removeOysterWorkflowMcpConnection(
  filePath: string,
): Promise<void> {
  await rm(filePath, { force: true });
}

/**
 * EN: Builds and validates the on-disk MCP connection contract before publishing a secret.
 * 中文: 在临时密钥写盘前构建并校验 MCP 连接文件契约。
 * @param input current runtime connection information.
 * @returns validated connection descriptor.
 */
export function createOysterWorkflowMcpConnectionDescriptor(input: {
  apiBaseUrl: string;
  token: string;
  pid: number;
  appVersion: string;
  now?: Date;
}): OysterWorkflowMcpConnectionDescriptor {
  const url = new URL(input.apiBaseUrl);
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
      "OysterWorkflow MCP requires an http://127.0.0.1:<port> Runtime URL. / OysterWorkflow MCP 只能连接本机 127.0.0.1 Runtime。",
    );
  }
  if (!Number.isSafeInteger(input.pid) || input.pid <= 0) {
    throw new Error("OysterWorkflow MCP owner PID must be a positive integer.");
  }
  if (input.token.length < 16) {
    throw new Error(
      "OysterWorkflow MCP token must contain at least 16 characters.",
    );
  }
  if (!input.appVersion.trim()) {
    throw new Error("OysterWorkflow MCP appVersion must not be empty.");
  }

  return {
    schemaVersion: OYSTERWORKFLOW_MCP_CONNECTION_SCHEMA_VERSION,
    pid: input.pid,
    apiBaseUrl: url.origin,
    token: input.token,
    appVersion: input.appVersion,
    startedAt: (input.now ?? new Date()).toISOString(),
  };
}
