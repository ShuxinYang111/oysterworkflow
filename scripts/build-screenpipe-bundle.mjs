#!/usr/bin/env node
import {
  access,
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  downloadFileWithSha256,
  fetchJsonWithTimeout,
} from "./lib/download.mjs";

const require = createRequire(import.meta.url);
const projectRootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const vendorDir = path.resolve(projectRootDir, "vendor", "screenpipe");
const outDir = path.resolve(projectRootDir, "out", "bundled", "screenpipe");
const isWindows = process.platform === "win32";
const screenpipeExecutableName = isWindows ? "screenpipe.exe" : "screenpipe";
const ffmpegExecutableName = isWindows ? "ffmpeg.exe" : "ffmpeg";
const ffprobeExecutableName = isWindows ? "ffprobe.exe" : "ffprobe";
const defaultWindowsOnnxRuntimeVersion = "1.22.0";
const defaultWindowsScreenpipeReleaseOwner = "ShuxinYang111";
const defaultWindowsScreenpipeReleaseRepo = "screenpipe";
const defaultWindowsScreenpipeReleaseTag = "cli-v0.3.304";
const downloadTimeoutMs = resolveDownloadTimeoutMs();
const cliArgs = new Set(process.argv.slice(2));
const shouldProbeWindowsScreenpipeRelease = cliArgs.has(
  "--probe-windows-release",
);
const explicitScreenpipeBinaryPath =
  process.env.OYSTERWORKFLOW_SCREENPIPE_BINARY_PATH?.trim() ?? "";
const cargoTargetDir = path.resolve(
  process.env.OYSTERWORKFLOW_SCREENPIPE_CARGO_TARGET_DIR?.trim() ??
    path.join(os.homedir(), ".cache", "oysterworkflow", "screenpipe-target"),
);
const sourceBinaryPath = path.resolve(
  cargoTargetDir,
  "release",
  screenpipeExecutableName,
);
const legacySourceBinaryPath = path.resolve(
  vendorDir,
  "target",
  "release",
  screenpipeExecutableName,
);
const targetBinaryPath = path.resolve(outDir, screenpipeExecutableName);
const targetFfmpegPath = path.resolve(outDir, ffmpegExecutableName);
const targetFfprobePath = path.resolve(outDir, ffprobeExecutableName);
const targetManifestPath = path.resolve(outDir, "screenpipe-bundle.json");
const targetThirdPartyNoticesPath = path.resolve(
  outDir,
  "THIRD-PARTY-NOTICES.md",
);
const screenpipeLicensePath = path.resolve(vendorDir, "LICENSE.md");
const targetScreenpipeLicensePath = path.resolve(
  outDir,
  "SCREENPIPE-LICENSE.md",
);
const vendorGitMetadataPath = path.resolve(vendorDir, ".git");
const screenpipeUpstreamRepository = "https://github.com/screenpipe/screenpipe";
const screenpipeForkRepository = "https://github.com/ShuxinYang111/screenpipe";
const screenpipePinnedCommit = "8da85bca603fd6fdc39eb265dc5192888c33bc72";
const ffmpegSourceRepository = "https://git.ffmpeg.org/ffmpeg.git";
const ffmpegLegalUrl = "https://www.ffmpeg.org/legal.html";
const ffmpegSourceDownloadUrl = "https://ffmpeg.org/download.html";
const ffmpegReleaseSourceArchiveUrl =
  "https://ffmpeg.org/releases/ffmpeg-8.0.tar.xz";
const ffmpegReleaseSourceArchiveSha256 =
  "643809c67ca0dfe7ea5f302f51da7a44430621d2daca2c8424e525bda2a75a0c";
const ffmpegBuildSourcePageUrl = "https://www.osxexperts.net/";
const macFfmpegDownloads = {
  arm64: {
    ffmpeg: {
      url: "https://www.osxexperts.net/ffmpeg80arm.zip",
      sha256:
        "77d2c853f431318d55ec02676d9b2f185ebfdddb9f7677a251fbe453affe025a",
    },
    ffprobe: {
      url: "https://www.osxexperts.net/ffprobe80arm.zip",
      sha256:
        "babf170e86bd6b0b2fefee5fa56f57721b0acb98ad2794b095d8030b02857dfe",
    },
  },
  x64: {
    ffmpeg: {
      url: "https://evermeet.cx/ffmpeg/getrelease/zip",
      sha256: null,
    },
    ffprobe: {
      url: "https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip",
      sha256: null,
    },
  },
};
const appleSystemLibraryPrefixes = ["/System/Library/", "/usr/lib/"];
const screenpipeSidecarFileNames = ["mlx.metallib"];
const macScreenpipeSidecarDownloads = new Map([
  [
    "mlx.metallib",
    {
      url: "https://github.com/screenpipe/screenpipe/releases/download/mlx-metallib-v0.2.0/mlx.metallib",
      sha256:
        "d077110dbe4cf5e2f6572abb7a3e9cfaa87dbfc6d0a1cd647e674735e39ff673",
    },
  ],
]);
const minSidecarBytesByName = new Map([["mlx.metallib", 1_000_000]]);

function resolveWindowsScreenpipeReleaseConfig() {
  return {
    owner:
      process.env.OYSTERWORKFLOW_SCREENPIPE_RELEASE_OWNER?.trim() ??
      defaultWindowsScreenpipeReleaseOwner,
    repo:
      process.env.OYSTERWORKFLOW_SCREENPIPE_RELEASE_REPO?.trim() ??
      defaultWindowsScreenpipeReleaseRepo,
    tag:
      process.env.OYSTERWORKFLOW_SCREENPIPE_RELEASE_TAG?.trim() ??
      defaultWindowsScreenpipeReleaseTag,
  };
}

function resolveGitHubToken() {
  return (
    process.env.OYSTERWORKFLOW_GITHUB_TOKEN?.trim() ??
    process.env.GITHUB_TOKEN?.trim() ??
    process.env.GH_TOKEN?.trim() ??
    ""
  );
}

function buildGitHubApiHeaders() {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "oysterworkflow-build",
  };
  const token = resolveGitHubToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

function buildDownloadHeaders(url) {
  const headers = {
    "User-Agent": "oysterworkflow-build",
  };
  const token = resolveGitHubToken();
  if (token && isGitHubUrl(url)) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (isGitHubApiUrl(url)) {
    headers.Accept = "application/octet-stream";
  }
  return headers;
}

function isGitHubUrl(url) {
  return /^https:\/\/(?:api\.)?github\.com\//i.test(url);
}

function isGitHubApiUrl(url) {
  return /^https:\/\/api\.github\.com\//i.test(url);
}

if (shouldProbeWindowsScreenpipeRelease) {
  const releaseProbe = await probeWindowsScreenpipeRelease();
  process.stdout.write(`${JSON.stringify(releaseProbe, null, 2)}\n`);
  process.exit(0);
}

if (explicitScreenpipeBinaryPath) {
  // The caller supplied the fork binary directly, so the submodule is not needed.
} else if (process.env.OYSTERWORKFLOW_REFRESH_SUBMODULE === "1") {
  await updateScreenpipeSubmodule();
} else {
  try {
    await access(vendorGitMetadataPath);
  } catch {
    await updateScreenpipeSubmodule();
  }
}

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const preparedFromArchive = await prepareScreenpipeBinary();
const bundledFfmpegTools = await resolveBundledFfmpegTools();
await copyExecutable(bundledFfmpegTools.ffmpegPath, targetFfmpegPath);
await copyExecutable(bundledFfmpegTools.ffprobePath, targetFfprobePath);
await copyScreenpipeSidecars(preparedFromArchive);

if (isWindows && preparedFromArchive) {
  await copyDllsFromDirectory(preparedFromArchive, outDir);
}
if (isWindows) {
  await copyWindowsOnnxRuntimeDlls(outDir);
}
const ffmpegCompliance = await collectFfmpegCompliance({
  ffmpegPath: targetFfmpegPath,
  ffmpegSourcePath: bundledFfmpegTools.ffmpegPath,
  ffmpegSourceUrl: bundledFfmpegTools.ffmpegSourceUrl,
  ffmpegDownloadSha256: bundledFfmpegTools.ffmpegDownloadSha256,
  ffprobePath: targetFfprobePath,
  ffprobeSourcePath: bundledFfmpegTools.ffprobePath,
  ffprobeSourceUrl: bundledFfmpegTools.ffprobeSourceUrl,
  ffprobeDownloadSha256: bundledFfmpegTools.ffprobeDownloadSha256,
});
await writeScreenpipeBundleManifest(ffmpegCompliance);
await writeThirdPartyNotices(ffmpegCompliance);
await copyFile(screenpipeLicensePath, targetScreenpipeLicensePath);

process.stdout.write(
  [
    `Bundled screenpipe binary prepared at ${targetBinaryPath}`,
    `Bundled ffmpeg prepared at ${targetFfmpegPath}`,
    `Bundled ffprobe prepared at ${targetFfprobePath}`,
    `Bundled screenpipe manifest prepared at ${targetManifestPath}`,
    `Bundled third-party notices prepared at ${targetThirdPartyNoticesPath}`,
    `Bundled Screenpipe license prepared at ${targetScreenpipeLicensePath}`,
  ].join("\n") + "\n",
);

async function prepareScreenpipeBinary() {
  if (explicitScreenpipeBinaryPath) {
    await copyExecutable(
      path.resolve(explicitScreenpipeBinaryPath),
      targetBinaryPath,
    );
    return path.dirname(path.resolve(explicitScreenpipeBinaryPath));
  }

  if (isWindows) {
    return downloadWindowsScreenpipeRelease();
  }

  await assertPinnedScreenpipeCheckout();
  const cargoCommand = await resolveCargoCommand();
  if (cargoCommand) {
    await runCommand(
      cargoCommand,
      ["build", "--release", "--bin", "screenpipe"],
      {
        cwd: vendorDir,
        env: {
          ...process.env,
          CARGO_TARGET_DIR: cargoTargetDir,
        },
      },
    );
    await copyExecutable(sourceBinaryPath, targetBinaryPath);
    await assertBundledScreenpipeVersion(targetBinaryPath);
    return path.dirname(sourceBinaryPath);
  }

  if (await exists(sourceBinaryPath)) {
    await copyExecutable(sourceBinaryPath, targetBinaryPath);
    await assertBundledScreenpipeVersion(targetBinaryPath);
    return path.dirname(sourceBinaryPath);
  }

  if (await exists(legacySourceBinaryPath)) {
    await copyExecutable(legacySourceBinaryPath, targetBinaryPath);
    await assertBundledScreenpipeVersion(targetBinaryPath);
    return path.dirname(legacySourceBinaryPath);
  }

  throw new Error(
    isWindows
      ? "Could not prepare Windows screenpipe. Publish a release in your fork, or set OYSTERWORKFLOW_SCREENPIPE_BINARY_PATH / OYSTERWORKFLOW_SCREENPIPE_ARCHIVE_URL and rebuild."
      : "Could not prepare screenpipe. Install Rust/Cargo, prebuild vendor/screenpipe, or set OYSTERWORKFLOW_SCREENPIPE_BINARY_PATH.",
  );
}

async function assertPinnedScreenpipeCheckout() {
  const commit = await collectCommandOutput("git", ["rev-parse", "HEAD"], {
    cwd: vendorDir,
  });
  if (commit.trim() !== screenpipePinnedCommit) {
    throw new Error(
      `Screenpipe submodule is not at the pinned fork commit. Expected ${screenpipePinnedCommit}, received ${commit.trim() || "unknown"}.`,
    );
  }
}

async function assertBundledScreenpipeVersion(binaryPath) {
  const cargoVersion = await readScreenpipeCargoVersion();
  const binaryVersion = await collectCommandOutput(binaryPath, ["--version"], {
    cwd: outDir,
  });
  if (!binaryVersion.includes(cargoVersion)) {
    throw new Error(
      `Screenpipe binary version does not match the fork source. Expected ${cargoVersion}, received ${binaryVersion.trim() || "unknown"}.`,
    );
  }
}

async function readScreenpipeCargoVersion() {
  const cargoToml = await readFile(path.join(vendorDir, "Cargo.toml"), "utf8");
  const version = /^version\s*=\s*"([^"]+)"/mu.exec(cargoToml)?.[1];
  if (!version) {
    throw new Error(
      `Unable to read Screenpipe version from ${vendorDir}/Cargo.toml`,
    );
  }
  return version;
}

async function updateScreenpipeSubmodule() {
  await runCommand(
    "git",
    ["submodule", "update", "--init", "--recursive", "vendor/screenpipe"],
    {
      cwd: projectRootDir,
    },
  );
}

async function resolveCargoCommand() {
  if (process.env.CARGO?.trim()) {
    return process.env.CARGO.trim();
  }

  const homeCargoPath = path.resolve(
    os.homedir(),
    ".cargo",
    "bin",
    isWindows ? "cargo.exe" : "cargo",
  );
  if (await exists(homeCargoPath)) {
    return homeCargoPath;
  }

  if (await canSpawn(isWindows ? "cargo.exe" : "cargo", ["--version"])) {
    return isWindows ? "cargo.exe" : "cargo";
  }

  return null;
}

async function resolveBundledFfmpegTools() {
  if (process.platform === "darwin") {
    return resolveMacBundledFfmpegTools();
  }

  const ffmpegPath = await resolveExistingToolPath(
    [
      process.env.OYSTERWORKFLOW_FFMPEG_PATH,
      process.env.FFMPEG_PATH,
      resolveOptionalPackageBinary("ffmpeg-static"),
      ...(isWindows
        ? [
            path.resolve(
              os.homedir(),
              "screenpipe",
              "bin",
              ffmpegExecutableName,
            ),
            await resolveCommandOnPath(ffmpegExecutableName),
          ]
        : [
            path.resolve(os.homedir(), ".local", "bin", ffmpegExecutableName),
            "/opt/homebrew/bin/ffmpeg",
            "/usr/local/bin/ffmpeg",
            "/usr/bin/ffmpeg",
          ]),
    ],
    "ffmpeg",
  );
  const siblingFfprobePath = path.resolve(
    path.dirname(ffmpegPath),
    ffprobeExecutableName,
  );
  const ffprobePath = await resolveExistingToolPath(
    [
      process.env.OYSTERWORKFLOW_FFPROBE_PATH,
      process.env.FFPROBE_PATH,
      siblingFfprobePath,
      resolveOptionalPackageBinary("ffprobe-static"),
      ...(isWindows
        ? [
            path.resolve(
              os.homedir(),
              "screenpipe",
              "bin",
              ffprobeExecutableName,
            ),
            await resolveCommandOnPath(ffprobeExecutableName),
          ]
        : [
            path.resolve(os.homedir(), ".local", "bin", ffprobeExecutableName),
            "/opt/homebrew/bin/ffprobe",
            "/usr/local/bin/ffprobe",
            "/usr/bin/ffprobe",
          ]),
    ],
    "ffprobe",
  );

  return {
    ffmpegPath,
    ffprobePath,
    ffmpegSourceUrl: "local package or system tool",
    ffprobeSourceUrl: "local package or system tool",
  };
}

async function resolveMacBundledFfmpegTools() {
  const explicitFfmpegPath =
    process.env.OYSTERWORKFLOW_FFMPEG_PATH?.trim() ??
    process.env.FFMPEG_PATH?.trim();
  const explicitFfprobePath =
    process.env.OYSTERWORKFLOW_FFPROBE_PATH?.trim() ??
    process.env.FFPROBE_PATH?.trim();
  if (explicitFfmpegPath || explicitFfprobePath) {
    if (!explicitFfmpegPath || !explicitFfprobePath) {
      throw new Error(
        "Set both OYSTERWORKFLOW_FFMPEG_PATH and OYSTERWORKFLOW_FFPROBE_PATH when overriding bundled FFmpeg tools.",
      );
    }
    const tools = {
      ffmpegPath: path.resolve(explicitFfmpegPath),
      ffprobePath: path.resolve(explicitFfprobePath),
      ffmpegSourceUrl: "explicit override",
      ffprobeSourceUrl: "explicit override",
    };
    await assertMacFfmpegToolIsRedistributable(tools.ffmpegPath, "ffmpeg");
    await assertMacFfmpegToolIsRedistributable(tools.ffprobePath, "ffprobe");
    return tools;
  }

  const archKey = process.arch === "arm64" ? "arm64" : "x64";
  const downloadSet = macFfmpegDownloads[archKey];
  if (!downloadSet) {
    throw new Error(
      `Unsupported macOS architecture for bundled FFmpeg: ${process.arch}`,
    );
  }

  const ffmpegPath = await downloadMacFfmpegTool("ffmpeg", downloadSet.ffmpeg);
  const ffprobePath = await downloadMacFfmpegTool(
    "ffprobe",
    downloadSet.ffprobe,
  );
  await assertMacFfmpegToolIsRedistributable(ffmpegPath, "ffmpeg");
  await assertMacFfmpegToolIsRedistributable(ffprobePath, "ffprobe");

  return {
    ffmpegPath,
    ffprobePath,
    ffmpegSourceUrl: downloadSet.ffmpeg.url,
    ffprobeSourceUrl: downloadSet.ffprobe.url,
    ffmpegDownloadSha256: downloadSet.ffmpeg.sha256,
    ffprobeDownloadSha256: downloadSet.ffprobe.sha256,
  };
}

async function downloadMacFfmpegTool(toolName, downloadSpec) {
  const cacheDir = path.resolve(
    projectRootDir,
    "out",
    "cache",
    "ffmpeg",
    process.arch,
    toolName,
  );
  const archivePath = path.resolve(cacheDir, `${toolName}.zip`);
  const extractDir = path.resolve(cacheDir, "extract");
  const cachedToolPath = await findFile(extractDir, toolName).catch(() => null);
  if (cachedToolPath) {
    await verifyExpectedSha256(cachedToolPath, downloadSpec.sha256, toolName);
    return cachedToolPath;
  }

  await mkdir(cacheDir, { recursive: true });
  if (!(await exists(archivePath))) {
    process.stdout.write(
      `Downloading macOS ${toolName} sidecar from ${downloadSpec.url}\n`,
    );
    await downloadFile(downloadSpec.url, archivePath);
  }

  await rm(extractDir, { recursive: true, force: true });
  await mkdir(extractDir, { recursive: true });
  await expandZip(archivePath, extractDir);

  const toolPath = await findFile(extractDir, toolName);
  if (!toolPath) {
    throw new Error(
      `Downloaded ${toolName} archive did not contain ${toolName}: ${downloadSpec.url}`,
    );
  }
  await chmod(toolPath, 0o755);
  await verifyExpectedSha256(toolPath, downloadSpec.sha256, toolName);
  return toolPath;
}

async function verifyExpectedSha256(filePath, expectedSha256, label) {
  if (!expectedSha256) {
    return;
  }
  const actualSha256 = await sha256File(filePath);
  if (actualSha256 !== expectedSha256) {
    throw new Error(
      `${label} checksum mismatch. expected=${expectedSha256} actual=${actualSha256} path=${filePath}`,
    );
  }
}

async function assertMacFfmpegToolIsRedistributable(toolPath, label) {
  const linkedLibraries = await collectCommandOutput(
    "/usr/bin/otool",
    ["-L", toolPath],
    {
      cwd: projectRootDir,
    },
  );
  const disallowedLibraries = linkedLibraries
    .split(/\r?\n/)
    .map((line) => line.trim().match(/^(.+?)\s+\(/)?.[1] ?? "")
    .filter((line) => line.startsWith("/"))
    .filter(
      (libraryPath) =>
        !appleSystemLibraryPrefixes.some((prefix) =>
          libraryPath.startsWith(prefix),
        ),
    );
  if (disallowedLibraries.length === 0) {
    return;
  }

  throw new Error(
    [
      `Refusing to bundle ${label} because it links non-system dynamic libraries.`,
      "Packaged macOS sidecars are signed with hardened runtime, so Homebrew/MacPorts/Nix dynamic libraries will fail library validation.",
      "Use a self-contained FFmpeg build instead.",
      `path: ${toolPath}`,
      `libraries: ${disallowedLibraries.join(", ")}`,
    ].join(" "),
  );
}

async function resolveExistingToolPath(candidates, label, options = {}) {
  for (const candidate of candidates) {
    if (!candidate?.trim()) {
      continue;
    }
    const resolved = path.resolve(candidate);
    if (await exists(resolved)) {
      if (options.validate && !(await options.validate(resolved, label))) {
        continue;
      }
      return resolved;
    }
  }

  if (options.optional) {
    return null;
  }

  throw new Error(
    `Could not find ${label} for desktop bundling. Set OYSTERWORKFLOW_${label.toUpperCase()}_PATH or install ${label} locally before packaging.`,
  );
}

function resolveOptionalPackageBinary(packageName) {
  try {
    const value = require(packageName);
    if (typeof value === "string") {
      return value;
    }
    if (typeof value?.path === "string") {
      return value.path;
    }
  } catch {
    return null;
  }
  return null;
}

async function downloadWindowsScreenpipeRelease() {
  const releaseConfig = resolveWindowsScreenpipeReleaseConfig();
  const explicitArchiveUrl =
    process.env.OYSTERWORKFLOW_SCREENPIPE_ARCHIVE_URL?.trim();
  const archiveSpec = explicitArchiveUrl
    ? {
        url: explicitArchiveUrl,
        sha256:
          process.env.OYSTERWORKFLOW_SCREENPIPE_ARCHIVE_SHA256?.trim() ?? null,
      }
    : await resolveWindowsScreenpipeArchiveSpec(releaseConfig);
  if (!archiveSpec.sha256) {
    throw new Error(
      "A pinned Windows Screenpipe archive checksum is required. Set OYSTERWORKFLOW_SCREENPIPE_ARCHIVE_SHA256 to the release asset SHA-256.",
    );
  }
  const downloadDir = path.resolve(
    os.tmpdir(),
    `oysterworkflow-screenpipe-${Date.now()}`,
  );
  const archivePath = path.resolve(downloadDir, "screenpipe.zip");
  const extractDir = path.resolve(downloadDir, "extract");
  await mkdir(extractDir, { recursive: true });

  process.stdout.write(
    `Downloading Windows screenpipe release from ${archiveSpec.url}\n`,
  );
  await downloadFile(archiveSpec.url, archivePath, {
    expectedSha256: archiveSpec.sha256,
    requireChecksum: true,
  });
  await expandZip(archivePath, extractDir);

  const extractedBinary = await findFile(extractDir, screenpipeExecutableName);
  if (!extractedBinary) {
    throw new Error(
      `Downloaded Windows screenpipe archive did not contain ${screenpipeExecutableName}.`,
    );
  }

  await copyExecutable(extractedBinary, targetBinaryPath);
  const extractedFfmpeg = await findFile(extractDir, ffmpegExecutableName);
  const extractedFfprobe = await findFile(extractDir, ffprobeExecutableName);
  if (extractedFfmpeg) {
    await copyExecutable(extractedFfmpeg, targetFfmpegPath);
  }
  if (extractedFfprobe) {
    await copyExecutable(extractedFfprobe, targetFfprobePath);
  }

  return extractDir;
}

async function resolveWindowsScreenpipeArchiveSpec(releaseConfig) {
  const taggedAsset = await resolveWindowsArchiveFromReleaseTag(
    releaseConfig.owner,
    releaseConfig.repo,
    releaseConfig.tag,
  );
  if (taggedAsset) {
    return taggedAsset;
  }

  throw new Error(
    `Could not find a Windows screenpipe release asset for ${releaseConfig.owner}/${releaseConfig.repo}@${releaseConfig.tag}. Publish that release or set OYSTERWORKFLOW_SCREENPIPE_BINARY_PATH / OYSTERWORKFLOW_SCREENPIPE_ARCHIVE_URL.`,
  );
}

async function resolveWindowsArchiveFromReleaseTag(owner, repo, tagName) {
  const release = await fetchJsonWithTimeout(
    `https://api.github.com/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(
      tagName,
    )}`,
    {
      headers: buildGitHubApiHeaders(),
      timeoutMs: downloadTimeoutMs,
    },
  );
  const asset = release.assets?.find(
    (item) =>
      typeof item?.name === "string" &&
      item.name.endsWith("-x86_64-pc-windows-msvc.zip"),
  );
  const url = asset?.url ?? asset?.browser_download_url ?? null;
  if (!url) {
    return null;
  }
  return {
    url,
    sha256:
      typeof asset.digest === "string" && asset.digest.startsWith("sha256:")
        ? asset.digest
        : null,
  };
}

async function probeWindowsScreenpipeRelease() {
  const releaseConfig = resolveWindowsScreenpipeReleaseConfig();
  const archiveSpec = await resolveWindowsScreenpipeArchiveSpec(releaseConfig);
  return {
    owner: releaseConfig.owner,
    repo: releaseConfig.repo,
    tag: releaseConfig.tag,
    archiveSha256: archiveSpec.sha256,
    archiveUrl: archiveSpec.url,
    usesGitHubToken: Boolean(resolveGitHubToken()),
  };
}

async function downloadFile(url, destinationPath, options = {}) {
  await downloadFileWithSha256({
    destinationPath,
    expectedSha256: options.expectedSha256,
    headers: buildDownloadHeaders(url),
    requireChecksum: options.requireChecksum,
    timeoutMs: downloadTimeoutMs,
    url,
  });
}

async function expandZip(archivePath, destinationDir) {
  if (isWindows) {
    await runCommand(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `Expand-Archive -LiteralPath '${escapePowerShellSingleQuotedString(
          archivePath,
        )}' -DestinationPath '${escapePowerShellSingleQuotedString(
          destinationDir,
        )}' -Force`,
      ],
      {
        cwd: projectRootDir,
      },
    );
    return;
  }

  await runCommand("unzip", ["-q", archivePath, "-d", destinationDir], {
    cwd: projectRootDir,
  });
}

async function copyDllsFromDirectory(sourceDir, destinationDir) {
  const dlls = await findFilesByExtension(sourceDir, ".dll");
  for (const dllPath of dlls) {
    await copyFile(
      dllPath,
      path.resolve(destinationDir, path.basename(dllPath)),
    );
  }
}

async function copyWindowsOnnxRuntimeDlls(destinationDir) {
  const sourceDir = await resolveWindowsOnnxRuntimeDllDirectory();
  const dlls = (await findFilesByExtension(sourceDir, ".dll")).filter(
    (dllPath) => path.basename(dllPath).toLowerCase().startsWith("onnxruntime"),
  );
  if (
    !dlls.some(
      (dllPath) => path.basename(dllPath).toLowerCase() === "onnxruntime.dll",
    )
  ) {
    throw new Error(
      `ONNX Runtime DLL directory did not contain onnxruntime.dll: ${sourceDir}`,
    );
  }

  for (const dllPath of dlls) {
    await copyFile(
      dllPath,
      path.resolve(destinationDir, path.basename(dllPath)),
    );
  }
}

async function resolveWindowsOnnxRuntimeDllDirectory() {
  const explicitDllDir = process.env.OYSTERWORKFLOW_ONNXRUNTIME_DLL_DIR;
  if (explicitDllDir?.trim()) {
    const resolved = path.resolve(explicitDllDir);
    if (!(await exists(path.resolve(resolved, "onnxruntime.dll")))) {
      throw new Error(
        `OYSTERWORKFLOW_ONNXRUNTIME_DLL_DIR does not contain onnxruntime.dll: ${resolved}`,
      );
    }
    return resolved;
  }

  const version =
    process.env.OYSTERWORKFLOW_ONNXRUNTIME_VERSION?.trim() ??
    defaultWindowsOnnxRuntimeVersion;
  const archiveUrl =
    process.env.OYSTERWORKFLOW_ONNXRUNTIME_ARCHIVE_URL?.trim() ??
    `https://github.com/microsoft/onnxruntime/releases/download/v${version}/onnxruntime-win-x64-gpu-${version}.zip`;
  const archiveSha256 =
    process.env.OYSTERWORKFLOW_ONNXRUNTIME_ARCHIVE_SHA256?.trim() ?? null;
  if (!archiveSha256) {
    throw new Error(
      "A pinned ONNX Runtime archive checksum is required. Set OYSTERWORKFLOW_ONNXRUNTIME_ARCHIVE_SHA256 to the archive SHA-256.",
    );
  }
  const cacheDir = path.resolve(
    projectRootDir,
    "out",
    "cache",
    "onnxruntime",
    version,
  );
  const archivePath = path.resolve(
    cacheDir,
    path.basename(new URL(archiveUrl).pathname),
  );
  const extractDir = path.resolve(cacheDir, "extract");
  const cachedDllPath = await findFile(extractDir, "onnxruntime.dll").catch(
    () => null,
  );
  if (cachedDllPath) {
    return path.dirname(cachedDllPath);
  }

  await mkdir(cacheDir, { recursive: true });
  let archiveIsVerified = false;
  if (await exists(archivePath)) {
    try {
      await verifyExpectedSha256(
        archivePath,
        archiveSha256,
        "ONNX Runtime archive",
      );
      archiveIsVerified = true;
    } catch {
      await rm(archivePath, { force: true });
    }
  }
  if (!archiveIsVerified) {
    process.stdout.write(
      `Downloading ONNX Runtime ${version} from ${archiveUrl}\n`,
    );
    await downloadFile(archiveUrl, archivePath, {
      expectedSha256: archiveSha256,
      requireChecksum: true,
    });
  }

  await rm(extractDir, { recursive: true, force: true });
  await mkdir(extractDir, { recursive: true });
  await expandZip(archivePath, extractDir);

  const dllPath = await findFile(extractDir, "onnxruntime.dll");
  if (!dllPath) {
    throw new Error(
      `Downloaded ONNX Runtime archive did not contain onnxruntime.dll: ${archiveUrl}`,
    );
  }
  return path.dirname(dllPath);
}

async function copyScreenpipeSidecars(binarySourceDir) {
  if (isWindows) {
    return;
  }

  const sourceDirs = await resolveScreenpipeSidecarSourceDirs(binarySourceDir);
  for (const fileName of screenpipeSidecarFileNames) {
    const targetPath = path.resolve(outDir, fileName);
    const sourcePath = await findValidSidecarPath(sourceDirs, fileName);
    if (sourcePath) {
      await copyFile(sourcePath, targetPath);
      process.stdout.write(`Bundled screenpipe sidecar ${fileName}\n`);
      continue;
    }

    const downloadSpec =
      process.platform === "darwin"
        ? macScreenpipeSidecarDownloads.get(fileName)
        : null;
    if (!downloadSpec) {
      continue;
    }

    process.stdout.write(
      `Downloading screenpipe sidecar ${fileName} from ${downloadSpec.url}\n`,
    );
    await downloadFile(downloadSpec.url, targetPath, {
      expectedSha256: downloadSpec.sha256,
      requireChecksum: true,
    });
    if (!(await isValidSidecarPath(targetPath, fileName))) {
      await rm(targetPath, { force: true });
      throw new Error(
        `Downloaded screenpipe sidecar ${fileName} was missing or too small.`,
      );
    }
  }
}

async function resolveScreenpipeSidecarSourceDirs(binarySourceDir) {
  const explicitSidecarDir = process.env.OYSTERWORKFLOW_SCREENPIPE_SIDECAR_DIR;
  const packageBinDir = resolveOptionalPackageBinDirectory(
    process.arch === "arm64"
      ? "@screenpipe/cli-darwin-arm64"
      : "@screenpipe/cli-darwin-x64",
  );
  const candidates = [
    explicitSidecarDir,
    binarySourceDir,
    path.dirname(sourceBinaryPath),
    path.resolve(vendorDir, "apps", "screenpipe-app-tauri", "src-tauri"),
    packageBinDir,
  ];
  const sourceDirs = [];
  const seen = new Set();

  for (const candidate of candidates) {
    if (!candidate?.trim()) {
      continue;
    }
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    if (await exists(resolved)) {
      sourceDirs.push(resolved);
    }
  }

  return sourceDirs;
}

function resolveOptionalPackageBinDirectory(packageName) {
  try {
    const packageJsonPath = require.resolve(`${packageName}/package.json`);
    return path.resolve(path.dirname(packageJsonPath), "bin");
  } catch {
    return null;
  }
}

async function findValidSidecarPath(sourceDirs, fileName) {
  for (const sourceDir of sourceDirs) {
    const candidatePath = path.resolve(sourceDir, fileName);
    if (await isValidSidecarPath(candidatePath, fileName)) {
      return candidatePath;
    }
  }
  return null;
}

async function isValidSidecarPath(candidatePath, fileName) {
  try {
    const metadata = await stat(candidatePath);
    if (!metadata.isFile()) {
      return false;
    }
    const minBytes = minSidecarBytesByName.get(fileName) ?? 1;
    return metadata.size >= minBytes;
  } catch {
    return false;
  }
}

async function collectFfmpegCompliance(input) {
  const ffmpegVersionOutput = await collectCommandOutput(
    input.ffmpegPath,
    ["-version"],
    {
      cwd: outDir,
    },
  );
  const ffprobeVersionOutput = await collectCommandOutput(
    input.ffprobePath,
    ["-version"],
    {
      cwd: outDir,
    },
  );
  const ffmpegConfiguration = extractFfmpegConfiguration(ffmpegVersionOutput);
  const ffprobeConfiguration = extractFfmpegConfiguration(ffprobeVersionOutput);
  const ffmpegLicenseProfile = resolveFfmpegLicenseProfile(
    `${ffmpegVersionOutput}\n${ffprobeVersionOutput}`,
  );

  if (ffmpegLicenseProfile === "nonfree") {
    throw new Error(
      [
        "Refusing to bundle FFmpeg because its version output includes --enable-nonfree.",
        "Use a redistributable FFmpeg build and rerun npm run build:screenpipe.",
        `ffmpeg source: ${input.ffmpegSourcePath}`,
        `ffprobe source: ${input.ffprobeSourcePath}`,
      ].join(" "),
    );
  }

  return {
    ffmpegPath: input.ffmpegPath,
    ffmpegSourcePath: input.ffmpegSourcePath,
    ffprobePath: input.ffprobePath,
    ffprobeSourcePath: input.ffprobeSourcePath,
    ffmpegVersion: extractFirstLine(ffmpegVersionOutput),
    ffprobeVersion: extractFirstLine(ffprobeVersionOutput),
    ffmpegVersionOutput,
    ffprobeVersionOutput,
    ffmpegConfiguration,
    ffprobeConfiguration,
    ffmpegLicenseProfile,
    ffmpegSha256: await sha256File(input.ffmpegPath),
    ffprobeSha256: await sha256File(input.ffprobePath),
    ffmpegSource: {
      repository: ffmpegSourceRepository,
      legal: ffmpegLegalUrl,
      sourceDownload: ffmpegSourceDownloadUrl,
      releaseSourceArchive: ffmpegReleaseSourceArchiveUrl,
      releaseSourceArchiveSha256: ffmpegReleaseSourceArchiveSha256,
      buildSourcePage: ffmpegBuildSourcePageUrl,
      bundledFrom: input.ffmpegSourcePath,
      bundledFfprobeFrom: input.ffprobeSourcePath,
      bundledDownloadUrl: input.ffmpegSourceUrl ?? null,
      bundledFfprobeDownloadUrl: input.ffprobeSourceUrl ?? null,
      bundledDownloadSha256: input.ffmpegDownloadSha256 ?? null,
      bundledFfprobeDownloadSha256: input.ffprobeDownloadSha256 ?? null,
    },
  };
}

function extractFirstLine(value) {
  return (
    value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? null
  );
}

function extractFfmpegConfiguration(versionOutput) {
  const line = versionOutput
    .split(/\r?\n/)
    .find((item) => item.startsWith("configuration:"));
  return line ? line.slice("configuration:".length).trim() : null;
}

function resolveFfmpegLicenseProfile(versionOutput) {
  if (versionOutput.includes("--enable-nonfree")) {
    return "nonfree";
  }
  if (versionOutput.includes("--enable-gpl")) {
    return "gpl";
  }
  return "lgpl";
}

async function writeScreenpipeBundleManifest(ffmpegCompliance) {
  const rootHelp = await collectCommandOutput(targetBinaryPath, ["--help"], {
    cwd: outDir,
  }).catch(() => "");
  const recordSubcommand = /\brecord\s+Start recording\b/i.test(rootHelp);
  const recordHelp = await collectCommandOutput(
    targetBinaryPath,
    recordSubcommand ? ["record", "--help"] : ["--help"],
    {
      cwd: outDir,
    },
  ).catch(() => "");
  const version = await collectCommandOutput(targetBinaryPath, ["--version"], {
    cwd: outDir,
  }).catch(() => "");
  const helpText = `${rootHelp}\n${recordHelp}`;
  const screenpipeCommit = explicitScreenpipeBinaryPath
    ? null
    : screenpipePinnedCommit;
  const screenpipeCargoVersion = explicitScreenpipeBinaryPath
    ? null
    : await readScreenpipeCargoVersion();
  const screenpipeBinarySha256 = createHash("sha256")
    .update(await readFile(targetBinaryPath))
    .digest("hex");
  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    screenpipeVersion: version.trim() || null,
    screenpipeSource: {
      forkRepository: screenpipeForkRepository,
      upstreamRepository: screenpipeUpstreamRepository,
      commit: screenpipeCommit,
      cargoVersion: screenpipeCargoVersion,
      binarySha256: screenpipeBinarySha256,
    },
    recordSubcommand,
    supportsAdaptiveFps: helpText.includes("--adaptive-fps"),
    supportsUiEvents: helpText.includes("--enable-ui-events"),
    supportsTranscriptionMode: helpText.includes("--transcription-mode"),
    supportsDisableSystemAudio: helpText.includes("--disable-system-audio"),
    ffmpegVersion: ffmpegCompliance.ffmpegVersion,
    ffprobeVersion: ffmpegCompliance.ffprobeVersion,
    ffmpegLicenseProfile: ffmpegCompliance.ffmpegLicenseProfile,
    ffmpegSource: ffmpegCompliance.ffmpegSource,
    ffmpegSha256: ffmpegCompliance.ffmpegSha256,
    ffprobeSha256: ffmpegCompliance.ffprobeSha256,
    ffmpegConfiguration: ffmpegCompliance.ffmpegConfiguration,
    ffprobeConfiguration: ffmpegCompliance.ffprobeConfiguration,
  };

  await writeFile(
    targetManifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}

async function writeThirdPartyNotices(ffmpegCompliance) {
  const notice = buildThirdPartyNotices(ffmpegCompliance);
  await writeFile(targetThirdPartyNoticesPath, notice, "utf8");
}

function buildThirdPartyNotices(ffmpegCompliance) {
  const generatedAt = new Date().toISOString();
  const ffmpegProfileText =
    ffmpegCompliance.ffmpegLicenseProfile === "gpl"
      ? "GPL-enabled build (version output contains --enable-gpl)"
      : "LGPL-compatible build (version output did not contain --enable-gpl or --enable-nonfree)";

  return `# Third-Party Notices

Generated at: ${generatedAt}

This file covers third-party components bundled with OysterWorkflow desktop
release artifacts. OysterWorkflow's PolyForm Noncommercial license applies to
OysterWorkflow code and does not replace or narrow these third-party license
terms.

## Screenpipe

- Component: Screenpipe recorder sidecar
- Role: External command-line recorder launched by OysterWorkflow
- Upstream repository: ${screenpipeUpstreamRepository}
- OysterWorkflow fork: ${screenpipeForkRepository}
- Pinned commit used by this build line: ${screenpipePinnedCommit}
- License: MIT for the main Screenpipe repository code, except Screenpipe's
  upstream \`ee/\` directory, which is separately licensed by Screenpipe and is
  not distributed as an OysterWorkflow Enterprise feature.
- Packaged license file: \`SCREENPIPE-LICENSE.md\`

Required MIT notice:

\`\`\`text
MIT License

Copyright (c) 2024-2026 louis030195

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
\`\`\`

## FFmpeg and ffprobe

- Components: FFmpeg and ffprobe command-line sidecars
- Role: External command-line tools used by Screenpipe for media encoding,
  decoding, probing, and frame extraction
- Project: https://ffmpeg.org/
- Source repository: ${ffmpegSourceRepository}
- Source download page: ${ffmpegSourceDownloadUrl}
- FFmpeg 8.0 release source archive: ${ffmpegReleaseSourceArchiveUrl}
- FFmpeg 8.0 release source archive SHA-256: ${ffmpegReleaseSourceArchiveSha256}
- Build-provider source/build notes page: ${ffmpegBuildSourcePageUrl}
- Legal information: ${ffmpegLegalUrl}
- License profile for this bundled build: ${ffmpegProfileText}
- Bundled ffmpeg source path: ${ffmpegCompliance.ffmpegSource.bundledFrom}
- Bundled ffprobe source path: ${ffmpegCompliance.ffmpegSource.bundledFfprobeFrom}
- Bundled ffmpeg download URL: ${ffmpegCompliance.ffmpegSource.bundledDownloadUrl}
- Bundled ffprobe download URL: ${ffmpegCompliance.ffmpegSource.bundledFfprobeDownloadUrl}
- Bundled ffmpeg download SHA-256: ${ffmpegCompliance.ffmpegSource.bundledDownloadSha256}
- Bundled ffprobe download SHA-256: ${ffmpegCompliance.ffmpegSource.bundledFfprobeDownloadSha256}
- Bundled ffmpeg SHA-256: ${ffmpegCompliance.ffmpegSha256}
- Bundled ffprobe SHA-256: ${ffmpegCompliance.ffprobeSha256}

FFmpeg is not MIT-licensed. FFmpeg and ffprobe are distributed under the
license terms that correspond to the actual build configuration. If the version
output includes \`--enable-gpl\`, treat the bundled FFmpeg/ffprobe sidecars as
GPL-enabled FFmpeg components. OysterWorkflow must not impose additional
restrictions on those sidecars beyond the applicable FFmpeg license terms.

This build refuses to bundle FFmpeg when \`--enable-nonfree\` appears in the
FFmpeg or ffprobe version output.

### Bundled version output

\`\`\`text
${ffmpegCompliance.ffmpegVersionOutput.trim()}
\`\`\`

\`\`\`text
${ffmpegCompliance.ffprobeVersionOutput.trim()}
\`\`\`
`;
}

async function findFile(rootDir, fileName) {
  for await (const entryPath of walkFiles(rootDir)) {
    if (path.basename(entryPath).toLowerCase() === fileName.toLowerCase()) {
      return entryPath;
    }
  }
  return null;
}

async function findFilesByExtension(rootDir, extension) {
  const matches = [];
  for await (const entryPath of walkFiles(rootDir)) {
    if (path.extname(entryPath).toLowerCase() === extension) {
      matches.push(entryPath);
    }
  }
  return matches;
}

async function* walkFiles(rootDir) {
  const entries = await readdir(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.resolve(rootDir, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(entryPath);
      continue;
    }
    if (entry.isFile()) {
      yield entryPath;
    }
  }
}

async function copyExecutable(from, to) {
  await mkdir(path.dirname(to), { recursive: true });
  if (path.resolve(from) !== path.resolve(to)) {
    await copyFile(from, to);
  }
  if (!isWindows) {
    await chmod(to, 0o755);
  }
}

async function sha256File(filePath) {
  const { readFile } = await import("node:fs/promises");
  return createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");
}

async function exists(candidatePath) {
  try {
    await access(candidatePath);
    return true;
  } catch {
    return false;
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

async function resolveCommandOnPath(command) {
  const lookupCommand = isWindows ? "where.exe" : "which";
  try {
    const result = await collectCommandOutput(lookupCommand, [command], {
      cwd: projectRootDir,
    });
    return result
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
  } catch {
    return null;
  }
}

async function canSpawn(command, args) {
  try {
    await collectCommandOutput(command, args, {
      cwd: projectRootDir,
    });
    return true;
  } catch {
    return false;
  }
}

function collectCommandOutput(command, args, input) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: input.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise(stdout);
        return;
      }
      rejectPromise(
        new Error(
          `${command} ${args.join(" ")} failed with code=${code ?? "null"} signal=${signal ?? "null"} ${stderr}`.trim(),
        ),
      );
    });
  });
}

function runCommand(command, args, input) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: input.cwd,
      env: input.env ?? process.env,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", (error) => {
      rejectPromise(new Error(`Failed to spawn ${command}: ${error.message}.`));
    });
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(
        new Error(
          `${command} ${args.join(" ")} failed with code=${code ?? "null"} signal=${signal ?? "null"}`,
        ),
      );
    });
  });
}

function escapePowerShellSingleQuotedString(value) {
  return value.replaceAll("'", "''");
}
