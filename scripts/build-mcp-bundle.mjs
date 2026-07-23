#!/usr/bin/env node
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const sourceDir = path.join(
  projectRootDir,
  "integrations",
  "codex-plugin",
  "oysterworkflow",
  "mcp",
);
const outDir = path.resolve(
  process.env.OYSTERWORKFLOW_MCP_BUNDLE_OUT_DIR?.trim() ??
    path.join(projectRootDir, "out", "bundled", "mcp"),
);

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

for (const fileName of ["server.mjs", "tools.json"]) {
  await copyFile(path.join(sourceDir, fileName), path.join(outDir, fileName));
}

const posixLauncherPath = path.join(outDir, "oysterworkflow-mcp");
await writeFile(
  posixLauncherPath,
  `#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CONTENTS_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
export ELECTRON_RUN_AS_NODE=1
exec "$CONTENTS_DIR/MacOS/OysterWorkflow" "$SCRIPT_DIR/server.mjs"
`,
  "utf8",
);
await chmod(posixLauncherPath, 0o755);

const windowsLauncherPath = path.join(outDir, "oysterworkflow-mcp.cmd");
await writeFile(
  windowsLauncherPath,
  `@echo off
setlocal
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0..\\..\\OysterWorkflow.exe" "%~dp0server.mjs"
`,
  "utf8",
);

const tools = JSON.parse(
  await readFile(path.join(outDir, "tools.json"), "utf8"),
);
await writeFile(
  path.join(outDir, "mcp-bundle.json"),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      serverName: "oysterworkflow",
      transport: "stdio",
      toolNames: tools.map((tool) => tool.name),
      launchers: {
        darwin: "oysterworkflow-mcp",
        win32: "oysterworkflow-mcp.cmd",
      },
    },
    null,
    2,
  )}\n`,
  "utf8",
);

process.stdout.write(`OysterWorkflow MCP bundle prepared at ${outDir}\n`);
