import { execFile } from "node:child_process";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
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

describe("runtime tools bundle builder", () => {
  it("records the pinned uv archive checksum without using the network", async () => {
    const root = await mkdtemp(join(tmpdir(), "oyster-runtime-tools-"));
    tempRoots.push(root);
    const outDir = join(root, "bundle");
    const fakeUv = join(root, process.platform === "win32" ? "uv.cmd" : "uv");
    await writeFile(
      fakeUv,
      process.platform === "win32"
        ? "@echo off\r\necho uv 0.11.7\r\n"
        : "#!/bin/sh\necho 'uv 0.11.7'\n",
      "utf8",
    );
    await chmod(fakeUv, 0o755);

    await execFileAsync(
      process.execPath,
      [resolve("scripts/build-runtime-tools-bundle.mjs")],
      {
        env: {
          ...process.env,
          OYSTERWORKFLOW_RUNTIME_TOOLS_BUNDLE_OUT_DIR: outDir,
          OYSTERWORKFLOW_RUNTIME_TOOLS_CACHE_DIR: join(root, "cache"),
          OYSTERWORKFLOW_UV_BINARY_PATH: fakeUv,
        },
      },
    );

    const manifest = JSON.parse(
      await readFile(join(outDir, "runtime-tools-bundle.json"), "utf8"),
    ) as { uv: { archiveSha256: string | null; version: string } };
    expect(manifest.uv).toMatchObject({
      archiveSha256:
        process.platform === "darwin" && process.arch === "arm64"
          ? "66e37d91f839e12481d7b932a1eccbfe732560f42c1cfb89faddfa2454534ba8"
          : process.platform === "win32" && process.arch === "x64"
            ? "fe0c7815acf4fc45f8a5eff58ed3cf7ae2e15c3cf1dceadbd10c816ec1690cc1"
            : null,
      version: "0.11.7",
    });
    if (
      (process.platform === "darwin" && process.arch === "arm64") ||
      (process.platform === "win32" && process.arch === "x64")
    ) {
      await expect(
        stat(
          join(
            outDir,
            process.platform === "win32"
              ? "oysterworkflow-uv.cmd"
              : "oysterworkflow-uv",
          ),
        ),
      ).resolves.toMatchObject({
        mode: expect.any(Number),
      });
    }
  });

  it("rejects an invalid shared download timeout before building", async () => {
    const root = await mkdtemp(join(tmpdir(), "oyster-runtime-timeout-"));
    tempRoots.push(root);

    await expect(
      execFileAsync(
        process.execPath,
        [resolve("scripts/build-runtime-tools-bundle.mjs")],
        {
          env: {
            ...process.env,
            OYSTERWORKFLOW_DOWNLOAD_TIMEOUT_MS: "0",
            OYSTERWORKFLOW_RUNTIME_TOOLS_BUNDLE_OUT_DIR: join(root, "bundle"),
          },
        },
      ),
    ).rejects.toThrow("must be a positive integer");
  });
});
