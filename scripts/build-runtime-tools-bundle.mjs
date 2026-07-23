#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { downloadFileWithSha256 } from "./lib/download.mjs";

const execFileAsync = promisify(execFile);
const projectRootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const outDir = path.resolve(
  process.env.OYSTERWORKFLOW_RUNTIME_TOOLS_BUNDLE_OUT_DIR?.trim() ??
    path.join(projectRootDir, "out", "bundled", "runtime-tools"),
);
const cacheDir = path.resolve(
  process.env.OYSTERWORKFLOW_RUNTIME_TOOLS_CACHE_DIR?.trim() ??
    path.join(projectRootDir, "out", "cache", "uv"),
);
const uvVersion = "0.11.7";
const uvTarget = resolveUvTarget();
const uvArchiveName = uvTarget?.archiveName ?? "unsupported";
const uvArchiveSha256 = uvTarget?.archiveSha256 ?? null;
const uvArchiveUrl = `https://github.com/astral-sh/uv/releases/download/${uvVersion}/${uvArchiveName}`;
const downloadTimeoutMs = resolveDownloadTimeoutMs();
const explicitUvBinaryPath =
  process.env.OYSTERWORKFLOW_UV_BINARY_PATH?.trim() ?? null;
const explicitUvExtension = explicitUvBinaryPath
  ? path.extname(explicitUvBinaryPath).toLowerCase()
  : "";
const uvOutputName =
  process.platform === "win32" &&
  (explicitUvExtension === ".cmd" || explicitUvExtension === ".bat")
    ? `oysterworkflow-uv${explicitUvExtension}`
    : (uvTarget?.outputName ?? "oysterworkflow-uv");
const uvOutputPath = path.join(outDir, uvOutputName);
const manifestPath = path.join(outDir, "runtime-tools-bundle.json");

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

if (uvTarget) {
  const sourcePath = await resolveUvSourcePath();
  await copyFile(sourcePath, uvOutputPath);
  if (process.platform !== "win32") {
    await chmod(uvOutputPath, 0o755);
  }
  await verifyUvBinary(uvOutputPath);
}

await writeFile(
  manifestPath,
  `${JSON.stringify(
    {
      schemaVersion: 1,
      platform: process.platform,
      arch: process.arch,
      uv: {
        version: uvVersion,
        executableName: uvTarget ? uvOutputName : null,
        archiveUrl: uvTarget ? uvArchiveUrl : null,
        archiveSha256: uvArchiveSha256,
      },
    },
    null,
    2,
  )}\n`,
  "utf8",
);

process.stdout.write(
  [
    `Runtime tools manifest prepared at ${manifestPath}`,
    ...(uvTarget
      ? [`Bundled uv prepared at ${uvOutputPath}`]
      : [
          `Bundled uv is not available for ${process.platform}-${process.arch}.`,
        ]),
  ].join("\n") + "\n",
);

function resolveUvTarget() {
  if (process.platform === "darwin" && process.arch === "arm64") {
    return {
      archiveName: "uv-aarch64-apple-darwin.tar.gz",
      archiveSha256:
        "66e37d91f839e12481d7b932a1eccbfe732560f42c1cfb89faddfa2454534ba8",
      binaryName: "uv",
      outputName: "oysterworkflow-uv",
    };
  }
  if (process.platform === "win32" && process.arch === "x64") {
    return {
      archiveName: "uv-x86_64-pc-windows-msvc.zip",
      archiveSha256:
        "fe0c7815acf4fc45f8a5eff58ed3cf7ae2e15c3cf1dceadbd10c816ec1690cc1",
      binaryName: "uv.exe",
      outputName: "oysterworkflow-uv.exe",
    };
  }
  return null;
}

async function resolveUvSourcePath() {
  if (explicitUvBinaryPath) {
    await access(explicitUvBinaryPath);
    return path.resolve(explicitUvBinaryPath);
  }

  await mkdir(cacheDir, { recursive: true });
  const archivePath = path.join(cacheDir, uvArchiveName);
  if (!uvTarget || !uvArchiveSha256) {
    throw new Error(
      `No bundled uv target is configured for ${process.platform}-${process.arch}.`,
    );
  }
  if (!(await fileMatchesSha256(archivePath, uvArchiveSha256))) {
    await downloadFileWithSha256({
      destinationPath: archivePath,
      expectedSha256: uvArchiveSha256,
      requireChecksum: true,
      timeoutMs: downloadTimeoutMs,
      url: uvArchiveUrl,
    });
  }

  const extractDir = path.join(cacheDir, `extract-${uvVersion}`);
  await rm(extractDir, { recursive: true, force: true });
  await mkdir(extractDir, { recursive: true });
  const tarCommand = process.platform === "win32" ? "tar.exe" : "/usr/bin/tar";
  const extractArgs =
    process.platform === "win32"
      ? ["-xf", archivePath, "-C", extractDir]
      : ["-xzf", archivePath, "-C", extractDir];
  await execFileAsync(tarCommand, extractArgs);
  const uvPath = await findNamedFile(extractDir, uvTarget.binaryName);
  if (!uvPath) {
    throw new Error(
      `uv executable was not found after extracting ${archivePath}`,
    );
  }
  return uvPath;
}

async function findNamedFile(directory, targetName) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isFile() && entry.name === targetName) {
      return entryPath;
    }
    if (entry.isDirectory()) {
      const nested = await findNamedFile(entryPath, targetName);
      if (nested) {
        return nested;
      }
    }
  }
  return null;
}

async function fileMatchesSha256(filePath, expected) {
  try {
    return (
      createHash("sha256")
        .update(await readFile(filePath))
        .digest("hex") === expected
    );
  } catch {
    return false;
  }
}

async function verifyUvBinary(binaryPath) {
  const isWindowsScript =
    process.platform === "win32" && /\.(?:cmd|bat)$/iu.test(binaryPath);
  const command = isWindowsScript
    ? process.env.ComSpec || "cmd.exe"
    : binaryPath;
  const args = isWindowsScript
    ? ["/d", "/s", "/c", binaryPath, "--version"]
    : ["--version"];
  const { stdout } = await execFileAsync(command, args);
  if (!stdout.includes(`uv ${uvVersion}`)) {
    throw new Error(
      `Bundled uv version mismatch: expected ${uvVersion}, received ${stdout.trim()}`,
    );
  }
}

function resolveDownloadTimeoutMs() {
  const rawValue = process.env.OYSTERWORKFLOW_DOWNLOAD_TIMEOUT_MS?.trim();
  if (!rawValue) {
    return undefined;
  }
  const timeoutMs = Number(rawValue);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      `OYSTERWORKFLOW_DOWNLOAD_TIMEOUT_MS must be a positive integer, received ${rawValue}`,
    );
  }
  return timeoutMs;
}
