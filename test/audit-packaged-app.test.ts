import * as asar from "@electron/asar";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const projectRoot = join(import.meta.dirname, "..");

describe("packaged app audit", () => {
  it("passes when packaged Screenpipe and Hermes helpers are present", async () => {
    const appAsarPath = await createPackagedAppFixture({
      includeHermesHelper: true,
    });

    const result = await execFileAsync(
      process.execPath,
      ["scripts/audit-packaged-app.mjs", appAsarPath],
      { cwd: projectRoot },
    );

    expect(result.stdout).toContain("[audit-packaged-app] OK");
  });

  it("fails when the packaged Hermes helper is missing", async () => {
    const appAsarPath = await createPackagedAppFixture({
      includeHermesHelper: false,
    });

    await expect(
      execFileAsync(
        process.execPath,
        ["scripts/audit-packaged-app.mjs", appAsarPath],
        { cwd: projectRoot },
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("bin/oysterworkflow-hermes is missing"),
    });
  });

  it("fails when Hermes manifest declares a bundled source seed but the seed setup script is missing", async () => {
    const appAsarPath = await createPackagedAppFixture({
      includeHermesHelper: true,
      hermesBundle: {
        executableName: "hermes",
        bundledSource: {
          directoryName: "hermes-agent-source",
          setupScript: "setup-hermes.sh",
        },
      },
    });

    await expect(
      execFileAsync(
        process.execPath,
        ["scripts/audit-packaged-app.mjs", appAsarPath],
        { cwd: projectRoot },
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "bin/hermes-agent-source/setup-hermes.sh is missing",
      ),
    });
  });

  it("fails when Hermes manifest declares bundled uv but the uv binary is missing", async () => {
    const appAsarPath = await createPackagedAppFixture({
      includeHermesHelper: true,
      includeHermesSourceSetup: true,
      includeUv: false,
      hermesBundle: {
        executableName: "hermes",
        bundledSource: {
          directoryName: "hermes-agent-source",
          setupScript: "setup-hermes.sh",
        },
        bundledUv: {
          relativePath: "oysterworkflow-uv",
        },
      },
    });

    await expect(
      execFileAsync(
        process.execPath,
        ["scripts/audit-packaged-app.mjs", appAsarPath],
        { cwd: projectRoot },
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("bin/oysterworkflow-uv is missing"),
    });
  });

  it("fails when packaged WhatsApp bridge dependencies are missing", async () => {
    const appAsarPath = await createPackagedAppFixture({
      includeHermesHelper: true,
      includeWhatsAppBridge: false,
    });

    await expect(
      execFileAsync(
        process.execPath,
        ["scripts/audit-packaged-app.mjs", appAsarPath],
        { cwd: projectRoot },
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "hermes-agent-source/scripts/whatsapp-bridge/node_modules/.package-lock.json is missing",
      ),
    });
  });
});

async function createPackagedAppFixture(input: {
  includeHermesHelper: boolean;
  hermesBundle?: Record<string, unknown>;
  includeHermesSourceSetup?: boolean;
  includeUv?: boolean;
  includeWhatsAppBridge?: boolean;
}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "oyster-packaged-audit-"));
  const resourcesDir = join(
    root,
    "OysterWorkflow.app",
    "Contents",
    "Resources",
  );
  const appSourceDir = join(root, "app-source");
  const binDir = join(resourcesDir, "bin");
  const appAsarPath = join(resourcesDir, "app.asar");

  await mkdir(appSourceDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await writeFile(join(appSourceDir, "index.js"), "console.log('ok');\n");
  await asar.createPackage(appSourceDir, appAsarPath);

  await writeExecutable(join(binDir, "oysterworkflow-screenpipe"));
  await writeFile(
    join(binDir, "screenpipe-bundle.json"),
    `${JSON.stringify({ executableName: "screenpipe" })}\n`,
  );
  if (input.includeHermesHelper) {
    await writeExecutable(join(binDir, "oysterworkflow-hermes"));
  }
  await writeExecutable(join(binDir, "node"));
  if (input.includeHermesSourceSetup) {
    await writeExecutable(
      join(binDir, "hermes-agent-source", "setup-hermes.sh"),
    );
  }
  await writeFile(
    join(binDir, "hermes-bundle.json"),
    `${JSON.stringify(
      input.hermesBundle ?? {
        executableName: "hermes",
        bundledNode: {
          relativePath: "node",
          strategy: "electron-run-as-node",
        },
        bundledWhatsAppBridge: {
          relativePath: "hermes-agent-source/scripts/whatsapp-bridge",
          dependencyStrategy: "bundled-production-node-modules",
        },
      },
    )}\n`,
  );
  if (input.includeWhatsAppBridge !== false) {
    const bridgeDir = join(
      binDir,
      "hermes-agent-source",
      "scripts",
      "whatsapp-bridge",
    );
    await mkdir(join(bridgeDir, "node_modules"), { recursive: true });
    await writeFile(join(bridgeDir, "bridge.js"), "// fixture\n");
    await writeFile(join(bridgeDir, "package.json"), "{}\n");
    await writeFile(
      join(bridgeDir, "node_modules", ".package-lock.json"),
      "{}\n",
    );
  }
  await writeExecutable(join(binDir, "oysterworkflow-browseract"));
  await writeFile(
    join(binDir, "browseract-bundle.json"),
    `${JSON.stringify({
      executableName: "browser-act",
      cliPackage: "browser-act-cli",
      pinnedVersion: "1.0.6",
      skillsBundled: false,
    })}\n`,
  );
  if (input.includeUv !== false) {
    await writeExecutable(join(binDir, "oysterworkflow-uv"));
  }
  await writeFile(
    join(binDir, "runtime-tools-bundle.json"),
    `${JSON.stringify({ schemaVersion: 1 })}\n`,
  );

  return appAsarPath;
}

async function writeExecutable(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, "#!/bin/sh\nexit 0\n");
  await chmod(filePath, 0o755);
}
