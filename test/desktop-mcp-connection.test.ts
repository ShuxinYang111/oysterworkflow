import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createOysterWorkflowMcpConnectionDescriptor,
  publishOysterWorkflowMcpConnection,
  removeOysterWorkflowMcpConnection,
} from "../desktop/mcp-connection.js";

describe("OysterWorkflow MCP desktop connection descriptor", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("publishes an atomic owner-only descriptor and removes it on shutdown", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oyster-mcp-"));
    temporaryDirectories.push(directory);
    const filePath = join(directory, "mcp", "runtime-connection.json");

    const descriptor = await publishOysterWorkflowMcpConnection({
      filePath,
      apiBaseUrl: "http://127.0.0.1:61667",
      token: "temporary-runtime-secret",
      pid: 4242,
      appVersion: "0.2.1",
      now: new Date("2026-07-20T12:00:00.000Z"),
    });

    expect(descriptor).toEqual({
      schemaVersion: 1,
      pid: 4242,
      apiBaseUrl: "http://127.0.0.1:61667",
      token: "temporary-runtime-secret",
      appVersion: "0.2.1",
      startedAt: "2026-07-20T12:00:00.000Z",
    });
    await expect(readFile(filePath, "utf8")).resolves.toContain(
      '"apiBaseUrl": "http://127.0.0.1:61667"',
    );
    if (process.platform !== "win32") {
      expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    }

    await removeOysterWorkflowMcpConnection(filePath);
    await expect(stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects non-loopback endpoints before publishing the runtime token", () => {
    expect(() =>
      createOysterWorkflowMcpConnectionDescriptor({
        apiBaseUrl: "https://example.com:443",
        token: "temporary-runtime-secret",
        pid: 4242,
        appVersion: "0.2.1",
      }),
    ).toThrow(/127\.0\.0\.1/u);
  });
});
