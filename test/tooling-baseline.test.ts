import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("engineering baseline", () => {
  it("pins the Node sqlite baseline and provides executable quality scripts", async () => {
    const [packageText, lockText, uiPackageText, nvmVersion, workflow] =
      await Promise.all([
        readFile(resolve("package.json"), "utf8"),
        readFile(resolve("package-lock.json"), "utf8"),
        readFile(resolve("ui/package.json"), "utf8"),
        readFile(resolve(".nvmrc"), "utf8"),
        readFile(resolve(".github/workflows/ci.yml"), "utf8"),
      ]);
    const packageJson = JSON.parse(packageText) as {
      engines: { node: string };
      scripts: Record<string, string>;
    };
    const lockJson = JSON.parse(lockText) as {
      packages: Record<string, { engines?: { node?: string } }>;
    };
    const uiPackageJson = JSON.parse(uiPackageText) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.engines.node).toBe(">=22.13.0");
    expect(lockJson.packages[""]?.engines?.node).toBe(">=22.13.0");
    expect(nvmVersion.trim()).toBe("22.13.1");
    expect(packageJson.scripts).toMatchObject({
      "format:check": "prettier . --check",
      lint: expect.stringContaining("eslint"),
      typecheck: expect.stringContaining("tsc"),
    });
    expect(uiPackageJson.scripts["test:ci"]).toContain(
      "--exclude 'test/demo-runtime-flow.test.tsx'",
    );
    expect(workflow).toContain("npm run typecheck");
    expect(workflow).toContain("npm run lint");
    expect(workflow).toContain("npm run format:check");
    expect(workflow).toContain("npm --prefix ui run test:ci");
  });

  it("rejects a BrowserAct uv lock artifact without a pinned hash", async () => {
    const root = await mkdtemp(join(tmpdir(), "oyster-browseract-lock-"));
    tempRoots.push(root);
    const configDir = join(root, "runtime-config");
    const outDir = join(root, "bundle");
    await mkdir(configDir, { recursive: true });
    const [projectText, sourceLockText] = await Promise.all([
      readFile(resolve("config/browseract-runtime/pyproject.toml"), "utf8"),
      readFile(resolve("config/browseract-runtime/uv.lock"), "utf8"),
    ]);
    const unlockedText = sourceLockText.replace(
      /, hash = "sha256:[a-f0-9]{64}"/u,
      "",
    );
    expect(unlockedText).not.toBe(sourceLockText);
    await Promise.all([
      writeFile(join(configDir, "pyproject.toml"), projectText, "utf8"),
      writeFile(join(configDir, "uv.lock"), unlockedText, "utf8"),
    ]);

    await expect(
      execFileAsync(
        process.execPath,
        [resolve("scripts/build-browseract-bundle.mjs")],
        {
          env: {
            ...process.env,
            OYSTERWORKFLOW_BROWSERACT_BUNDLE_OUT_DIR: outDir,
            OYSTERWORKFLOW_BROWSERACT_RUNTIME_CONFIG_DIR: configDir,
          },
        },
      ),
    ).rejects.toThrow("artifact without a SHA-256 hash");
  });

  it("keeps desktop sidecar downloads bounded and checksum-gated", async () => {
    const [
      browserActBuilder,
      hermesBuilder,
      runtimeToolsBuilder,
      screenpipeBuilder,
    ] = await Promise.all([
      readFile(resolve("scripts/build-browseract-bundle.mjs"), "utf8"),
      readFile(resolve("scripts/build-hermes-bundle.mjs"), "utf8"),
      readFile(resolve("scripts/build-runtime-tools-bundle.mjs"), "utf8"),
      readFile(resolve("scripts/build-screenpipe-bundle.mjs"), "utf8"),
    ]);

    expect(browserActBuilder).toContain("uv sync --frozen");
    expect(browserActBuilder).not.toContain("uv tool install");
    expect(browserActBuilder).toContain("artifact without a SHA-256 hash");
    expect(hermesBuilder).toContain("verify_network_installer");
    expect(hermesBuilder).toContain("--connect-timeout");
    expect(hermesBuilder).toContain("installScriptSha256");
    expect(runtimeToolsBuilder).toContain("downloadFileWithSha256");
    expect(runtimeToolsBuilder).toContain("requireChecksum: true");
    expect(screenpipeBuilder).toContain("OYSTERWORKFLOW_DOWNLOAD_TIMEOUT_MS");
    expect(screenpipeBuilder).toContain(
      "OYSTERWORKFLOW_ONNXRUNTIME_ARCHIVE_SHA256",
    );
    expect(screenpipeBuilder).toContain(
      "OYSTERWORKFLOW_SCREENPIPE_ARCHIVE_SHA256",
    );
  });
});
