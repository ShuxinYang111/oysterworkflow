import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("OysterWorkflow packaged MCP bundle", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("ships one stable launcher and the host-neutral tool catalog", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "oyster-mcp-bundle-"));
    temporaryDirectories.push(outDir);

    await execFileAsync(
      process.execPath,
      [join(process.cwd(), "scripts", "build-mcp-bundle.mjs")],
      {
        env: {
          ...process.env,
          OYSTERWORKFLOW_MCP_BUNDLE_OUT_DIR: outDir,
        },
      },
    );

    const manifest = JSON.parse(
      await readFile(join(outDir, "mcp-bundle.json"), "utf8"),
    );
    expect(manifest).toMatchObject({
      serverName: "oysterworkflow",
      transport: "stdio",
      toolNames: [
        "search",
        "fetch",
        "prepare_workflow_run",
        "get_workflow_run",
        "advance_workflow_run",
        "cancel_workflow_run",
      ],
    });
    expect(await readFile(join(outDir, "server.mjs"), "utf8")).toContain(
      '"/api/mcp"',
    );
    expect(
      await readFile(join(outDir, "oysterworkflow-mcp"), "utf8"),
    ).toContain("ELECTRON_RUN_AS_NODE=1");
    if (process.platform !== "win32") {
      expect(
        (await stat(join(outDir, "oysterworkflow-mcp"))).mode & 0o111,
      ).toBe(0o111);
    }
  });
});
