#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const projectRootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const hermesBundleConfig = await readHermesBundleConfig();
const configuredOutDir =
  process.env.OYSTERWORKFLOW_HERMES_BUNDLE_OUT_DIR?.trim();
const outDir = configuredOutDir
  ? path.resolve(configuredOutDir)
  : path.resolve(projectRootDir, "out", "bundled", "hermes");
const sourceSeedDirectoryName = "hermes-agent-source";
const sourceSeedOutDir = path.resolve(outDir, sourceSeedDirectoryName);
const posixLauncherPath = path.resolve(outDir, "hermes");
const packagedNodeLauncherPath = path.resolve(outDir, "node");
const windowsLauncherPath = path.resolve(outDir, "hermes.ps1");
const manifestPath = path.resolve(outDir, "hermes-bundle.json");
const explicitSourceSeedPath =
  process.env.OYSTERWORKFLOW_HERMES_SOURCE_PATH?.trim();
const sourceSeedPath = explicitSourceSeedPath
  ? path.resolve(explicitSourceSeedPath)
  : await resolveDefaultHermesSourceSeedPath(hermesBundleConfig);
const sharedUvBinaryPath = path.resolve(
  projectRootDir,
  "out",
  "bundled",
  "runtime-tools",
  "oysterworkflow-uv",
);
const uvBinaryPath = await resolveBundledUvSourcePath();
const sourceSeedMetadata = sourceSeedPath
  ? await collectHermesSourceSeedMetadata(sourceSeedPath)
  : null;
const explicitInstallScriptUrl =
  process.env.OYSTERWORKFLOW_HERMES_INSTALL_SCRIPT_URL?.trim();
const explicitInstallScriptSha256 = normalizeOptionalSha256(
  process.env.OYSTERWORKFLOW_HERMES_INSTALL_SCRIPT_SHA256,
);
if (explicitInstallScriptUrl && !explicitInstallScriptSha256) {
  throw new Error(
    "OYSTERWORKFLOW_HERMES_INSTALL_SCRIPT_URL requires OYSTERWORKFLOW_HERMES_INSTALL_SCRIPT_SHA256 so the downloaded installer can be verified.",
  );
}
const bundledInstallScriptSha256 = sourceSeedPath
  ? await hashOptionalFile(path.join(sourceSeedPath, "scripts", "install.sh"))
  : null;
if (
  sourceSeedMetadata?.dirty === true &&
  process.env.OYSTERWORKFLOW_ALLOW_DIRTY_HERMES_BUNDLE !== "1"
) {
  throw new Error(
    `Refusing to package a dirty Hermes source tree: ${sourceSeedPath}. Commit the fork changes or set OYSTERWORKFLOW_ALLOW_DIRTY_HERMES_BUNDLE=1 for a local experiment.`,
  );
}
let sourceSeedDigest = null;
let bundledWhatsAppBridge = null;
const installScriptUrl =
  explicitInstallScriptUrl ??
  buildGitHubRawFileUrl(
    hermesBundleConfig.forkRepository,
    sourceSeedMetadata?.commit ?? "main",
    "scripts/install.sh",
  );
const installScriptSha256 =
  explicitInstallScriptSha256 ?? bundledInstallScriptSha256;

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
if (sourceSeedPath) {
  await copyHermesSourceSeed(sourceSeedPath, sourceSeedOutDir);
  bundledWhatsAppBridge =
    await installBundledWhatsAppBridgeDependencies(sourceSeedOutDir);
  if (uvBinaryPath) {
    await copyBundledUv(uvBinaryPath, outDir);
  }
  sourceSeedDigest = await hashDirectory(sourceSeedOutDir);
} else {
  await mkdir(sourceSeedOutDir, { recursive: true });
  await writeFile(
    path.join(sourceSeedOutDir, ".placeholder"),
    "Hermes source seed is optional. Set OYSTERWORKFLOW_HERMES_SOURCE_PATH to include it in desktop packages.\n",
    "utf8",
  );
}
await writeFile(posixLauncherPath, renderPosixLauncher(), "utf8");
await chmod(posixLauncherPath, 0o755);
await writeFile(packagedNodeLauncherPath, renderPackagedNodeLauncher(), "utf8");
await chmod(packagedNodeLauncherPath, 0o755);
await writeFile(windowsLauncherPath, renderWindowsLauncher(), "utf8");
await chmod(windowsLauncherPath, 0o755);
await writeFile(
  manifestPath,
  `${JSON.stringify(
    {
      strategy: "managed-install-launcher",
      executableName: process.platform === "win32" ? "hermes.ps1" : "hermes",
      installScriptUrl,
      installScriptSha256,
      installDir: "$HERMES_HOME/hermes-agent",
      runtimeHome: "$HERMES_HOME",
      bundledSource: sourceSeedPath
        ? {
            directoryName: sourceSeedDirectoryName,
            setupScript: "setup-hermes.sh",
            sourceKind: explicitSourceSeedPath ? "override" : "submodule",
            submodulePath: hermesBundleConfig.submodulePath,
            forkRepository: hermesBundleConfig.forkRepository,
            upstreamRepository: hermesBundleConfig.upstreamRepository,
            version: sourceSeedMetadata?.version ?? null,
            commit: sourceSeedMetadata?.commit ?? null,
            commitDate: sourceSeedMetadata?.commitDate ?? null,
            dirty: sourceSeedMetadata?.dirty ?? null,
            digest: sourceSeedDigest,
          }
        : null,
      bundledUv:
        sourceSeedPath && uvBinaryPath
          ? {
              relativePath: "oysterworkflow-uv",
            }
          : null,
      bundledNode:
        process.platform === "darwin"
          ? {
              relativePath: "node",
              strategy: "electron-run-as-node",
            }
          : null,
      bundledWhatsAppBridge,
      notes:
        "The launcher installs Hermes Agent into OysterWorkflow's managed HERMES_HOME on first use. Windows uses Hermes' native PowerShell installer; macOS packages include an Electron-backed Node launcher and production WhatsApp bridge dependencies.",
    },
    null,
    2,
  )}\n`,
  "utf8",
);

process.stdout.write(
  [
    `Bundled Hermes launcher prepared at ${posixLauncherPath}`,
    `Bundled Node launcher prepared at ${packagedNodeLauncherPath}`,
    `Bundled native Windows Hermes launcher prepared at ${windowsLauncherPath}`,
    `Bundled Hermes manifest prepared at ${manifestPath}`,
    ...(sourceSeedPath
      ? [`Bundled Hermes source seed prepared at ${sourceSeedOutDir}`]
      : []),
  ].join("\n") + "\n",
);

async function copyHermesSourceSeed(sourcePath, targetPath) {
  // CN/EN: Materialize a top-level managed-install symlink before copying so
  // the filter can inspect descendants such as venv and __pycache__. Keep
  // internal symlinks intact; only the source root itself is dereferenced.
  const resolvedSourcePath = await realpath(sourcePath);
  await access(path.join(resolvedSourcePath, "setup-hermes.sh"));
  await cp(resolvedSourcePath, targetPath, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
    filter: (source) => shouldCopyHermesSeedPath(resolvedSourcePath, source),
  });
}

async function readHermesBundleConfig() {
  const configPath = path.resolve(
    projectRootDir,
    "config",
    "hermes-bundle.config.json",
  );
  const parsed = JSON.parse(await readFile(configPath, "utf8"));
  const config = {
    submodulePath: readRequiredString(parsed, "submodulePath", configPath),
    forkRepository: readRequiredString(parsed, "forkRepository", configPath),
    upstreamRepository: readRequiredString(
      parsed,
      "upstreamRepository",
      configPath,
    ),
  };

  return config;
}

function readRequiredString(input, key, configPath) {
  const value = input?.[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `Missing required Hermes bundle config field ${key}: ${configPath}`,
    );
  }
  return value.trim();
}

async function resolveDefaultHermesSourceSeedPath(config) {
  const sourcePath = path.resolve(projectRootDir, config.submodulePath);
  const gitMetadataPath = path.resolve(sourcePath, ".git");
  if (process.env.OYSTERWORKFLOW_REFRESH_SUBMODULE === "1") {
    await updateHermesSubmodule(config);
  } else {
    try {
      await access(gitMetadataPath);
    } catch {
      await updateHermesSubmodule(config);
    }
  }

  await access(path.join(sourcePath, "setup-hermes.sh"));
  return sourcePath;
}

async function updateHermesSubmodule(config) {
  await execFileAsync(
    "git",
    ["submodule", "update", "--init", "--recursive", config.submodulePath],
    {
      cwd: projectRootDir,
      killSignal: "SIGTERM",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 120_000,
    },
  );
}

async function collectHermesSourceSeedMetadata(sourcePath) {
  const [version, commit, commitDate, status] = await Promise.all([
    readHermesVersion(sourcePath),
    readGitOutput(sourcePath, ["rev-parse", "HEAD"]),
    readGitOutput(sourcePath, ["show", "-s", "--format=%cI", "HEAD"]),
    readGitOutput(sourcePath, ["status", "--short"]),
  ]);
  const dirty = status === null ? null : status.length > 0;

  return {
    version,
    commit,
    commitDate,
    dirty,
  };
}

async function readHermesVersion(sourcePath) {
  try {
    const pyproject = await readFile(
      path.join(sourcePath, "pyproject.toml"),
      "utf8",
    );
    return /^version\s*=\s*"([^"]+)"/mu.exec(pyproject)?.[1] ?? null;
  } catch {
    return null;
  }
}

async function readGitOutput(cwd, args) {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

function buildGitHubRawFileUrl(repositoryUrl, ref, filePath) {
  const url = new URL(repositoryUrl);
  if (url.hostname !== "github.com") {
    throw new Error(
      `Hermes forkRepository must be a GitHub URL to build the fallback installer URL: ${repositoryUrl}`,
    );
  }
  const [owner, rawRepo] = url.pathname
    .replace(/^\/+/u, "")
    .replace(/\.git$/u, "")
    .split("/");
  if (!owner || !rawRepo) {
    throw new Error(
      `Hermes forkRepository must include owner and repo: ${repositoryUrl}`,
    );
  }
  return `https://raw.githubusercontent.com/${owner}/${rawRepo}/${ref}/${filePath}`;
}

async function copyBundledUv(sourcePath, seedTargetPath) {
  await access(sourcePath);
  const targetPath = path.join(seedTargetPath, "oysterworkflow-uv");
  await mkdir(path.dirname(targetPath), { recursive: true });
  await cp(sourcePath, targetPath);
  await chmod(targetPath, 0o755);
}

async function installBundledWhatsAppBridgeDependencies(sourceRoot) {
  const bridgeDirectory = path.join(sourceRoot, "scripts", "whatsapp-bridge");
  const packagePath = path.join(bridgeDirectory, "package.json");
  const lockPath = path.join(bridgeDirectory, "package-lock.json");
  try {
    await Promise.all([access(packagePath), access(lockPath)]);
  } catch {
    return null;
  }

  await normalizeBundledWhatsAppBridgeGitDependencies({
    packagePath,
    lockPath,
  });
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  await execFileAsync(
    npmCommand,
    ["ci", "--omit=dev", "--no-fund", "--no-audit", "--progress=false"],
    {
      cwd: bridgeDirectory,
      env: { ...process.env, CI: "1" },
      maxBuffer: 16 * 1024 * 1024,
      shell: process.platform === "win32",
    },
  );
  const nodeModulesDirectory = path.join(bridgeDirectory, "node_modules");
  const installedLockPath = path.join(
    nodeModulesDirectory,
    ".package-lock.json",
  );
  await mkdir(nodeModulesDirectory, { recursive: true });
  try {
    await access(installedLockPath);
  } catch {
    await cp(lockPath, installedLockPath);
  }
  return {
    relativePath: path.posix.join(
      sourceSeedDirectoryName,
      "scripts",
      "whatsapp-bridge",
    ),
    dependencyStrategy: "bundled-production-node-modules",
  };
}

/**
 * CN: 将锁定到 commit 的 GitHub Git 依赖改写为等价 tarball，避免 npm 在嵌套 git prepare 时争用同一缓存目录。
 * EN: Rewrites commit-pinned GitHub Git dependencies as equivalent tarballs so nested npm git preparation cannot race on one cache directory.
 * @param {{ packagePath: string; lockPath: string }} input copied bridge manifests.
 * @returns {Promise<void>} after changed manifests are persisted.
 */
async function normalizeBundledWhatsAppBridgeGitDependencies(input) {
  const packageJson = JSON.parse(await readFile(input.packagePath, "utf8"));
  const lockJson = JSON.parse(await readFile(input.lockPath, "utf8"));
  const lockPackages = lockJson?.packages;
  if (!lockPackages || typeof lockPackages !== "object") {
    return;
  }

  let lockChanged = false;
  for (const packageEntry of Object.values(lockPackages)) {
    if (!packageEntry || typeof packageEntry !== "object") {
      continue;
    }
    const tarballUrl = githubCommitTarballUrl(packageEntry.resolved);
    if (tarballUrl && packageEntry.resolved !== tarballUrl) {
      packageEntry.resolved = tarballUrl;
      delete packageEntry.integrity;
      lockChanged = true;
    }
  }

  const rewriteDependencyMap = (dependencies) => {
    if (!dependencies || typeof dependencies !== "object") {
      return false;
    }
    let changed = false;
    for (const dependencyName of Object.keys(dependencies)) {
      const lockedDependency = lockPackages[`node_modules/${dependencyName}`];
      const tarballUrl = githubCommitTarballUrl(lockedDependency?.resolved);
      if (tarballUrl && dependencies[dependencyName] !== tarballUrl) {
        dependencies[dependencyName] = tarballUrl;
        changed = true;
      }
    }
    return changed;
  };

  const packageChanged = rewriteDependencyMap(packageJson.dependencies);
  for (const packageEntry of Object.values(lockPackages)) {
    if (rewriteDependencyMap(packageEntry?.dependencies)) {
      lockChanged = true;
    }
  }

  if (packageChanged) {
    await writeFile(
      input.packagePath,
      `${JSON.stringify(packageJson, null, 2)}\n`,
      "utf8",
    );
  }
  if (lockChanged) {
    await writeFile(
      input.lockPath,
      `${JSON.stringify(lockJson, null, 2)}\n`,
      "utf8",
    );
  }
}

/**
 * CN: 将带 40 位 commit 的 GitHub git URL 转换为不可变 codeload tarball URL。
 * EN: Converts a GitHub git URL pinned to a 40-character commit into an immutable codeload tarball URL.
 * @param {unknown} value possible resolved dependency URL.
 * @returns {string | null} immutable HTTPS tarball URL when supported.
 */
function githubCommitTarballUrl(value) {
  if (typeof value !== "string") {
    return null;
  }
  const existingTarball = value.match(
    /^https:\/\/codeload\.github\.com\/([^/]+)\/([^/]+)\/tar\.gz\/([a-f0-9]{40})$/iu,
  );
  if (existingTarball) {
    return value;
  }
  const match = value.match(
    /^git\+(?:ssh:\/\/git@|https:\/\/)github\.com\/([^/]+)\/([^#]+?)(?:\.git)?#([a-f0-9]{40})$/iu,
  );
  if (!match) {
    return null;
  }
  const [, owner, repository, commit] = match;
  return `https://codeload.github.com/${owner}/${repository}/tar.gz/${commit}`;
}

async function resolveBundledUvSourcePath() {
  const explicitPath = process.env.OYSTERWORKFLOW_UV_BINARY_PATH?.trim();
  if (explicitPath) {
    await access(explicitPath);
    return path.resolve(explicitPath);
  }
  try {
    await access(sharedUvBinaryPath);
    return sharedUvBinaryPath;
  } catch {
    return null;
  }
}

async function hashDirectory(rootPath) {
  const hash = createHash("sha256");

  async function visit(directoryPath) {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolutePath = path.join(directoryPath, entry.name);
      const relativePath = path.relative(rootPath, absolutePath);
      hash.update(
        `${entry.isDirectory() ? "d" : entry.isSymbolicLink() ? "l" : "f"}:${relativePath}\0`,
      );
      if (entry.isDirectory()) {
        await visit(absolutePath);
      } else if (entry.isSymbolicLink()) {
        hash.update(await readlink(absolutePath));
      } else {
        const stats = await lstat(absolutePath);
        hash.update(`${stats.mode & 0o777}\0`);
        hash.update(await readFile(absolutePath));
      }
    }
  }

  await visit(rootPath);
  return `sha256:${hash.digest("hex")}`;
}

function shouldCopyHermesSeedPath(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  if (!relative) {
    return true;
  }
  const segments = relative.split(path.sep);
  return !segments.some((segment) =>
    [
      ".git",
      ".env",
      ".mypy_cache",
      ".pytest_cache",
      ".ruff_cache",
      "__pycache__",
      "node_modules",
      ".venv",
      "venv",
    ].includes(segment),
  );
}

function renderPosixLauncher() {
  const bundleRevision =
    sourceSeedDigest ?? sourceSeedMetadata?.commit ?? "network-install";
  return `#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
INSTALL_URL="\${OYSTERWORKFLOW_HERMES_INSTALL_URL:-${installScriptUrl}}"
INSTALL_SCRIPT_SHA256="\${OYSTERWORKFLOW_HERMES_INSTALL_SCRIPT_SHA256:-${installScriptSha256 ?? ""}}"
RUNTIME_HOME="\${HERMES_HOME:-$HOME/.hermes/oysterworkflow}"
INSTALL_DIR="\${OYSTERWORKFLOW_HERMES_INSTALL_DIR:-$RUNTIME_HOME/hermes-agent}"
INSTALLER_HOME="\${OYSTERWORKFLOW_HERMES_INSTALLER_HOME:-$RUNTIME_HOME/installer-home}"
BUNDLED_SOURCE_DIR="\${OYSTERWORKFLOW_HERMES_BUNDLED_SOURCE_DIR:-$SCRIPT_DIR/${sourceSeedDirectoryName}}"
BUNDLED_UV="\${OYSTERWORKFLOW_HERMES_BUNDLED_UV:-$SCRIPT_DIR/oysterworkflow-uv}"
RUNNER="$INSTALL_DIR/venv/bin/hermes"
BUNDLE_REVISION="${bundleRevision}"
COMPLETION_FILE_NAME=".oysterworkflow-bundle-revision"
INSTALLATIONS_DIR="$RUNTIME_HOME/.oysterworkflow-hermes-installs"
REVISION_ID="$(printf '%s' "$BUNDLE_REVISION" | tr -c 'A-Za-z0-9._-' '_')"
STAGING_DIR="$INSTALLATIONS_DIR/$REVISION_ID"
STAGING_RUNNER="$STAGING_DIR/venv/bin/hermes"
STAGING_COMPLETION_FILE="$STAGING_DIR/$COMPLETION_FILE_NAME"
INSTALL_LOCK="$RUNTIME_HOME/.oysterworkflow-hermes-install.lock"
LOCK_OWNER_FILE="$INSTALL_LOCK/owner"
LEGACY_BACKUP="$INSTALL_DIR.oysterworkflow-previous"
LINK_TEMP="$INSTALL_DIR.oysterworkflow-next"
NETWORK_INSTALL_SCRIPT="$RUNTIME_HOME/.oysterworkflow-hermes-install-script.$$"
INSTALL_WAIT_SECONDS="\${OYSTERWORKFLOW_HERMES_INSTALL_WAIT_SECONDS:-300}"
INSTALL_STALE_SECONDS="\${OYSTERWORKFLOW_HERMES_INSTALL_STALE_SECONDS:-1800}"
DOWNLOAD_CONNECT_TIMEOUT_SECONDS="\${OYSTERWORKFLOW_HERMES_DOWNLOAD_CONNECT_TIMEOUT_SECONDS:-15}"
DOWNLOAD_MAX_TIME_SECONDS="\${OYSTERWORKFLOW_HERMES_DOWNLOAD_MAX_TIME_SECONDS:-90}"
LOCK_HELD=0
STAGING_ACTIVE=0
ACTIVATION_IN_PROGRESS=0
PREVIOUS_LINK_TARGET=""

validate_timeout_setting() {
  setting_name="$1"
  setting_value="$2"
  case "$setting_value" in
    ''|*[!0-9]*)
      echo "Invalid Hermes installer timeout $setting_name=$setting_value; expected non-negative seconds. / Hermes 安装器超时配置无效，必须是非负整数秒。" >&2
      exit 64
      ;;
  esac
}

verify_network_installer() {
  case "$INSTALL_SCRIPT_SHA256" in
    *[!0-9a-fA-F]*|'')
      echo "Hermes network installer is missing a valid SHA-256 checksum. / Hermes 网络安装脚本缺少有效的 SHA-256 校验值。" >&2
      return 1
      ;;
    *) ;;
  esac
  if [ "\${#INSTALL_SCRIPT_SHA256}" -ne 64 ]; then
    echo "Hermes network installer SHA-256 must contain 64 hexadecimal characters. / Hermes 网络安装脚本 SHA-256 必须是 64 位十六进制字符。" >&2
    return 1
  fi
  if command -v shasum >/dev/null 2>&1; then
    actual_sha256="$(shasum -a 256 "$NETWORK_INSTALL_SCRIPT" | awk '{print $1}')"
  elif command -v sha256sum >/dev/null 2>&1; then
    actual_sha256="$(sha256sum "$NETWORK_INSTALL_SCRIPT" | awk '{print $1}')"
  else
    echo "A SHA-256 utility is required to verify the Hermes installer. / 校验 Hermes 安装脚本需要 SHA-256 工具。" >&2
    return 1
  fi
  if [ "$actual_sha256" != "$INSTALL_SCRIPT_SHA256" ]; then
    echo "Hermes installer checksum mismatch; refusing to execute it. expected=$INSTALL_SCRIPT_SHA256 actual=$actual_sha256 / Hermes 安装脚本校验失败，已拒绝执行。" >&2
    return 1
  fi
}

is_ready_dir() {
  candidate_dir="$1"
  [ -x "$candidate_dir/venv/bin/hermes" ] && [ "$(cat "$candidate_dir/$COMPLETION_FILE_NAME" 2>/dev/null || true)" = "$BUNDLE_REVISION" ]
}

is_ready() {
  is_ready_dir "$INSTALL_DIR"
}

lock_modified_at() {
  if modified_at="$(stat -f %m "$INSTALL_LOCK" 2>/dev/null)"; then
    case "$modified_at" in
      ''|*[!0-9]*) ;;
      *)
        printf '%s\\n' "$modified_at"
        return 0
        ;;
    esac
  fi
  if modified_at="$(stat -c %Y "$INSTALL_LOCK" 2>/dev/null)"; then
    case "$modified_at" in
      ''|*[!0-9]*) ;;
      *)
        printf '%s\\n' "$modified_at"
        return 0
        ;;
    esac
  fi
  return 1
}

recover_stale_lock() {
  [ -d "$INSTALL_LOCK" ] || return 0
  recovery_claim="$INSTALL_LOCK/.recovery"
  if ! mkdir "$recovery_claim" 2>/dev/null; then
    return 1
  fi
  owner_pid="$(sed -n '1p' "$LOCK_OWNER_FILE" 2>/dev/null || true)"
  owner_started="$(sed -n '2p' "$LOCK_OWNER_FILE" 2>/dev/null || true)"
  stale_reason=""
  case "$owner_pid" in
    ''|*[!0-9]*)
      ;;
    *)
      if [ "$owner_pid" -gt 1 ] && kill -0 "$owner_pid" 2>/dev/null; then
        rmdir "$recovery_claim" 2>/dev/null || true
        return 1
      fi
      stale_reason="process $owner_pid / 进程 $owner_pid"
      ;;
  esac

  if [ -z "$stale_reason" ]; then
    case "$owner_started" in
      ''|*[!0-9]*) owner_started="$(lock_modified_at || date +%s)" ;;
    esac
    now_epoch="$(date +%s)"
    lock_age=$((now_epoch - owner_started))
    if [ "$lock_age" -ge "$INSTALL_STALE_SECONDS" ]; then
      stale_reason="missing live owner / 没有存活安装进程"
    fi
  fi
  if [ -z "$stale_reason" ]; then
    rmdir "$recovery_claim" 2>/dev/null || true
    return 1
  fi

  stale_lock="$INSTALL_LOCK.stale.$$"
  rm -rf "$stale_lock"
  if ! mv "$INSTALL_LOCK" "$stale_lock" 2>/dev/null; then
    rmdir "$recovery_claim" 2>/dev/null || true
    return 1
  fi
  rm -rf "$stale_lock"
  echo "Recovering stale Hermes installation lock: $stale_reason / 正在恢复遗留的 Hermes 安装锁: $stale_reason" >&2
  return 0
}

acquire_install_lock() {
  wait_started="$(date +%s)"
  while ! mkdir "$INSTALL_LOCK" 2>/dev/null; do
    if is_ready; then
      return 2
    fi
    if recover_stale_lock; then
      continue
    fi
    now_epoch="$(date +%s)"
    waited_seconds=$((now_epoch - wait_started))
    if [ "$waited_seconds" -ge "$INSTALL_WAIT_SECONDS" ]; then
      echo "Timed out after $INSTALL_WAIT_SECONDS seconds waiting for another Hermes installation. / 等待其它 Hermes 安装进程超过 $INSTALL_WAIT_SECONDS 秒。" >&2
      return 1
    fi
    sleep 1
  done
  LOCK_HELD=1
  if ! printf '%s\\n%s\\n' "$$" "$(date +%s)" > "$LOCK_OWNER_FILE"; then
    echo "Unable to record ownership of the Hermes installation lock. / 无法记录 Hermes 安装锁的所有者。" >&2
    return 1
  fi
  return 0
}

cleanup_install_state() {
  cleanup_status=$?
  set +e
  if [ "$ACTIVATION_IN_PROGRESS" -eq 1 ] && [ ! -e "$INSTALL_DIR" ] && [ ! -L "$INSTALL_DIR" ]; then
    if [ -e "$LEGACY_BACKUP" ] || [ -L "$LEGACY_BACKUP" ]; then
      mv "$LEGACY_BACKUP" "$INSTALL_DIR"
    elif [ -n "$PREVIOUS_LINK_TARGET" ]; then
      ln -s "$PREVIOUS_LINK_TARGET" "$INSTALL_DIR"
    fi
  fi
  rm -rf "$LINK_TEMP" "$NETWORK_INSTALL_SCRIPT"
  if [ "$LOCK_HELD" -eq 1 ]; then
    if [ -L "$INSTALL_DIR" ] && [ "$(readlink "$INSTALL_DIR" 2>/dev/null || true)" = "$STAGING_DIR" ]; then
      STAGING_ACTIVE=1
    fi
    if [ "$STAGING_ACTIVE" -eq 0 ]; then
      rm -rf "$STAGING_DIR"
    fi
    if [ "$(sed -n '1p' "$LOCK_OWNER_FILE" 2>/dev/null || true)" = "$$" ]; then
      rm -rf "$INSTALL_LOCK"
    fi
    LOCK_HELD=0
  fi
  set -e
  return "$cleanup_status"
}

recover_interrupted_activation() {
  if [ ! -e "$INSTALL_DIR" ] && [ ! -L "$INSTALL_DIR" ]; then
    if [ -L "$LINK_TEMP" ]; then
      echo "Recovering a completed Hermes staging activation. / 正在恢复已完成的 Hermes 暂存安装。" >&2
      mv "$LINK_TEMP" "$INSTALL_DIR"
    elif [ -e "$LEGACY_BACKUP" ] || [ -L "$LEGACY_BACKUP" ]; then
      echo "Restoring the previous Hermes installation after an interrupted activation. / 激活中断，正在恢复上一版 Hermes。" >&2
      mv "$LEGACY_BACKUP" "$INSTALL_DIR"
    fi
  fi
}

activate_staging() {
  if ! is_ready_dir "$STAGING_DIR"; then
    echo "Hermes staging installation is incomplete and cannot be activated. / Hermes 暂存安装不完整，无法激活。" >&2
    return 1
  fi
  mkdir -p "$(dirname -- "$INSTALL_DIR")"
  rm -rf "$LINK_TEMP"
  ln -s "$STAGING_DIR" "$LINK_TEMP"
  PREVIOUS_LINK_TARGET=""
  ACTIVATION_IN_PROGRESS=1
  if [ -L "$INSTALL_DIR" ]; then
    PREVIOUS_LINK_TARGET="$(readlink "$INSTALL_DIR" 2>/dev/null || true)"
    rm -f "$INSTALL_DIR"
  elif [ -e "$INSTALL_DIR" ]; then
    rm -rf "$LEGACY_BACKUP"
    mv "$INSTALL_DIR" "$LEGACY_BACKUP"
  fi
  if ! mv "$LINK_TEMP" "$INSTALL_DIR"; then
    if [ -e "$LEGACY_BACKUP" ] || [ -L "$LEGACY_BACKUP" ]; then
      mv "$LEGACY_BACKUP" "$INSTALL_DIR"
    elif [ -n "$PREVIOUS_LINK_TARGET" ]; then
      ln -s "$PREVIOUS_LINK_TARGET" "$INSTALL_DIR"
    fi
    ACTIVATION_IN_PROGRESS=0
    echo "Unable to activate the completed Hermes staging installation. / 无法激活已完成的 Hermes 暂存安装。" >&2
    return 1
  fi
  ACTIVATION_IN_PROGRESS=0
  STAGING_ACTIVE=1
  rm -rf "$LEGACY_BACKUP"
  return 0
}

install_staging() {
  rm -rf "$STAGING_DIR"
  mkdir -p "$STAGING_DIR"
  echo "OysterWorkflow is installing managed Hermes Agent into a protected staging directory... / OysterWorkflow 正在安全暂存目录中安装 Hermes Agent..." >&2
  if [ -d "$BUNDLED_SOURCE_DIR" ] && [ -x "$BUNDLED_SOURCE_DIR/setup-hermes.sh" ]; then
    # Copy through the system tar instead of ditto. Large app-resource trees
    # can make ditto intermittently report source files as missing while the
    # bundle is being read from a signed or quarantined application image.
    if ! (cd "$BUNDLED_SOURCE_DIR" && /usr/bin/tar cf - .) | (cd "$STAGING_DIR" && /usr/bin/tar xf -); then
      echo "Unable to copy the bundled Hermes source into staging. / 无法将内置 Hermes 源文件复制到暂存目录。" >&2
      return 1
    fi
    # setup-hermes.sh can ask more than one optional setup question on a
    # clean machine. Feed several "no" answers so app startup never blocks.
    if ! printf 'n\\nn\\nn\\n' | (cd "$STAGING_DIR" && HOME="$INSTALLER_HOME" HERMES_HOME="$RUNTIME_HOME" PATH="$RUNTIME_HOME/bin:$INSTALLER_HOME/.local/bin:$PATH" ./setup-hermes.sh); then
      echo "Hermes setup failed; the previous ready installation was left unchanged. / Hermes 安装失败，上一版可用安装保持不变。" >&2
      return 1
    fi
  elif command -v curl >/dev/null 2>&1; then
    if [ -z "$INSTALL_SCRIPT_SHA256" ]; then
      echo "Hermes network fallback is disabled because no pinned installer checksum was bundled. / 因未内置固定校验值，Hermes 网络回退安装已禁用。" >&2
      return 1
    fi
    if ! curl --proto '=https' --tlsv1.2 -fL --retry 2 --retry-all-errors --connect-timeout "$DOWNLOAD_CONNECT_TIMEOUT_SECONDS" --max-time "$DOWNLOAD_MAX_TIME_SECONDS" "$INSTALL_URL" -o "$NETWORK_INSTALL_SCRIPT"; then
      echo "Unable to download the Hermes installer. / 无法下载 Hermes 安装脚本。" >&2
      return 1
    fi
    if ! verify_network_installer; then
      return 1
    fi
    if ! HOME="$INSTALLER_HOME" HERMES_HOME="$RUNTIME_HOME" PATH="$RUNTIME_HOME/bin:$INSTALLER_HOME/.local/bin:$PATH" bash "$NETWORK_INSTALL_SCRIPT" --skip-setup --dir "$STAGING_DIR" --hermes-home "$RUNTIME_HOME"; then
      echo "Hermes network installation failed; no partial runtime was activated. / Hermes 网络安装失败，未激活任何不完整运行环境。" >&2
      return 1
    fi
  else
    echo "A bundled Hermes source seed or curl is required to install the managed Hermes runtime. / 安装 Hermes 需要内置源文件或 curl。" >&2
    return 127
  fi
  if [ ! -x "$STAGING_RUNNER" ]; then
    echo "Hermes setup completed without an executable runner. / Hermes 安装完成后未找到可执行程序。" >&2
    return 1
  fi
  completion_temp="$STAGING_COMPLETION_FILE.tmp.$$"
  printf '%s\\n' "$BUNDLE_REVISION" > "$completion_temp"
  mv "$completion_temp" "$STAGING_COMPLETION_FILE"
  return 0
}

install_runtime() {
  if is_ready; then
    return 0
  fi
  validate_timeout_setting "OYSTERWORKFLOW_HERMES_INSTALL_WAIT_SECONDS" "$INSTALL_WAIT_SECONDS"
  validate_timeout_setting "OYSTERWORKFLOW_HERMES_INSTALL_STALE_SECONDS" "$INSTALL_STALE_SECONDS"
  validate_timeout_setting "OYSTERWORKFLOW_HERMES_DOWNLOAD_CONNECT_TIMEOUT_SECONDS" "$DOWNLOAD_CONNECT_TIMEOUT_SECONDS"
  validate_timeout_setting "OYSTERWORKFLOW_HERMES_DOWNLOAD_MAX_TIME_SECONDS" "$DOWNLOAD_MAX_TIME_SECONDS"
  mkdir -p "$RUNTIME_HOME" "$INSTALLER_HOME" "$INSTALLATIONS_DIR"
  trap 'cleanup_install_state' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  lock_status=0
  acquire_install_lock || lock_status=$?
  if [ "$lock_status" -eq 2 ]; then
    cleanup_install_state
    trap - EXIT INT TERM
    return 0
  fi
  if [ "$lock_status" -ne 0 ]; then
    return "$lock_status"
  fi

  recover_interrupted_activation
  if is_ready; then
    cleanup_install_state
    trap - EXIT INT TERM
    return 0
  fi
  if [ -x "$BUNDLED_UV" ]; then
    mkdir -p "$RUNTIME_HOME/bin" "$INSTALLER_HOME/.local/bin"
    cp "$BUNDLED_UV" "$RUNTIME_HOME/bin/uv"
    cp "$BUNDLED_UV" "$INSTALLER_HOME/.local/bin/uv"
    chmod +x "$RUNTIME_HOME/bin/uv" "$INSTALLER_HOME/.local/bin/uv"
  fi
  if ! is_ready_dir "$STAGING_DIR"; then
    install_staging
  fi
  activate_staging
  cleanup_install_state
  trap - EXIT INT TERM
  return 0
}

install_runtime

exec "$RUNNER" "$@"
`;
}

function renderPackagedNodeLauncher() {
  return `#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
CONTENTS_DIR="$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)"
ELECTRON_BINARY="$CONTENTS_DIR/MacOS/OysterWorkflow"

if [ ! -x "$ELECTRON_BINARY" ]; then
  echo "OysterWorkflow's bundled Node runtime is unavailable." >&2
  exit 127
fi

ELECTRON_RUN_AS_NODE=1 exec "$ELECTRON_BINARY" "$@"
`;
}

function renderWindowsLauncher() {
  const bundleRevision =
    sourceSeedDigest ?? sourceSeedMetadata?.commit ?? "network-install";
  const pinnedCommit = sourceSeedMetadata?.commit ?? "";
  return String.raw`$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$HermesArguments = @($args)
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RuntimeHome = if ($env:HERMES_HOME) {
  $env:HERMES_HOME
} else {
  Join-Path $env:APPDATA "oysterworkflow\hermes"
}
$InstallDir = Join-Path $RuntimeHome "hermes-agent"
$Runner = Join-Path $InstallDir "venv\Scripts\hermes.exe"
$OfficialMarker = Join-Path $InstallDir ".hermes-bootstrap-complete"
$BundleMarker = Join-Path $InstallDir ".oysterworkflow-bundle-revision"
$BundledSourceDir = Join-Path $ScriptDir "${sourceSeedDirectoryName}"
$BundledInstaller = Join-Path $BundledSourceDir "scripts\install.ps1"
$BundledUv = Join-Path $ScriptDir "oysterworkflow-uv.exe"
$ManagedBinDir = Join-Path $RuntimeHome "bin"
$ManagedUv = Join-Path $ManagedBinDir "uv.exe"
$InstallLock = Join-Path $RuntimeHome ".oysterworkflow-hermes-install.lock"
$LockOwnerFile = Join-Path $InstallLock "owner"
$BundleRevision = "${bundleRevision}"
$PinnedCommit = "${pinnedCommit}"
$InstallWaitSeconds = if ($env:OYSTERWORKFLOW_HERMES_INSTALL_WAIT_SECONDS) {
  [int]$env:OYSTERWORKFLOW_HERMES_INSTALL_WAIT_SECONDS
} else {
  300
}
$InstallStaleSeconds = if ($env:OYSTERWORKFLOW_HERMES_INSTALL_STALE_SECONDS) {
  [int]$env:OYSTERWORKFLOW_HERMES_INSTALL_STALE_SECONDS
} else {
  1800
}
$LockHeld = $false

function Test-ManagedHermesReady {
  return (Test-Path -LiteralPath $Runner -PathType Leaf) -and
    (Test-Path -LiteralPath $OfficialMarker -PathType Leaf)
}

function Test-LockOwnerAlive {
  param([int]$OwnerProcessId)
  if ($OwnerProcessId -le 0) {
    return $false
  }
  return $null -ne (Get-Process -Id $OwnerProcessId -ErrorAction SilentlyContinue)
}

function Remove-StaleInstallLock {
  if (-not (Test-Path -LiteralPath $InstallLock -PathType Container)) {
    return $true
  }
  $owner = @(Get-Content -LiteralPath $LockOwnerFile -ErrorAction SilentlyContinue)
  $ownerProcessId = 0
  $ownerStartedAt = 0L
  if ($owner.Count -ge 1) {
    [void][int]::TryParse($owner[0], [ref]$ownerProcessId)
  }
  if ($owner.Count -ge 2) {
    [void][long]::TryParse($owner[1], [ref]$ownerStartedAt)
  }
  $ageSeconds = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() - $ownerStartedAt
  if ((Test-LockOwnerAlive $ownerProcessId) -and $ageSeconds -lt $InstallStaleSeconds) {
    return $false
  }
  $staleLock = "$InstallLock.stale.$PID.$([Guid]::NewGuid().ToString('N'))"
  try {
    Move-Item -LiteralPath $InstallLock -Destination $staleLock -ErrorAction Stop
    Remove-Item -LiteralPath $staleLock -Recurse -Force -ErrorAction SilentlyContinue
    [Console]::Error.WriteLine("Recovering stale Hermes installation lock.")
    return $true
  } catch {
    return $false
  }
}

function Acquire-InstallLock {
  $waitStartedAt = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  while ($true) {
    try {
      New-Item -ItemType Directory -Path $InstallLock -ErrorAction Stop | Out-Null
      @($PID, [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()) |
        Set-Content -LiteralPath $LockOwnerFile -Encoding ascii
      $script:LockHeld = $true
      return
    } catch {
      if (Test-ManagedHermesReady) {
        return
      }
      if (Remove-StaleInstallLock) {
        continue
      }
      $waitedSeconds =
        [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() - $waitStartedAt
      if ($waitedSeconds -ge $InstallWaitSeconds) {
        throw "Timed out after $InstallWaitSeconds seconds waiting for another Hermes installation."
      }
      Start-Sleep -Seconds 1
    }
  }
}

function Release-InstallLock {
  if (-not $script:LockHeld) {
    return
  }
  $owner = @(Get-Content -LiteralPath $LockOwnerFile -ErrorAction SilentlyContinue)
  if ($owner.Count -ge 1 -and $owner[0] -eq [string]$PID) {
    Remove-Item -LiteralPath $InstallLock -Recurse -Force -ErrorAction SilentlyContinue
  }
  $script:LockHeld = $false
}

function Invoke-InstallerStage {
  param([string]$Stage)
  $stageArguments = @(
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    $BundledInstaller,
    "-Stage",
    $Stage,
    "-NonInteractive",
    "-SkipSetup",
    "-Json",
    "-HermesHome",
    $RuntimeHome,
    "-InstallDir",
    $InstallDir
  )
  if ($PinnedCommit) {
    $stageArguments += @("-Commit", $PinnedCommit)
  }
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  & powershell.exe @stageArguments 2>&1 |
    ForEach-Object { [Console]::Error.WriteLine([string]$_) }
  $stageExitCode = $LASTEXITCODE
  $ErrorActionPreference = $previousPreference
  if ($stageExitCode -ne 0) {
    throw "Hermes installer stage '$Stage' failed with exit code $stageExitCode."
  }
}

function Install-ManagedHermes {
  if (-not (Test-Path -LiteralPath $BundledInstaller -PathType Leaf)) {
    throw "The bundled native Windows Hermes installer is missing: $BundledInstaller"
  }
  New-Item -ItemType Directory -Path $RuntimeHome -Force | Out-Null
  New-Item -ItemType Directory -Path $ManagedBinDir -Force | Out-Null
  if (Test-Path -LiteralPath $BundledUv -PathType Leaf) {
    Copy-Item -LiteralPath $BundledUv -Destination $ManagedUv -Force
  }
  $env:HERMES_HOME = $RuntimeHome
  $env:Path = "$ManagedBinDir;$env:Path"

  if (Test-Path -LiteralPath $InstallDir) {
    Remove-Item -LiteralPath $InstallDir -Recurse -Force
  }
  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
  Get-ChildItem -LiteralPath $BundledSourceDir -Force |
    Copy-Item -Destination $InstallDir -Recurse -Force

  [Console]::Error.WriteLine("OysterWorkflow is installing native Hermes Agent for Windows...")
  foreach ($stage in @(
    "uv",
    "python",
    "git",
    "node",
    "system-packages",
    "venv",
    "dependencies",
    "config-templates",
    "platform-sdks",
    "bootstrap-marker"
  )) {
    Invoke-InstallerStage $stage
  }
  [System.IO.File]::WriteAllText(
    $BundleMarker,
    $BundleRevision + [Environment]::NewLine,
    [System.Text.UTF8Encoding]::new($false)
  )
  if (-not (Test-ManagedHermesReady)) {
    throw "Hermes installation completed without a usable Windows runner: $Runner"
  }
}

if (-not (Test-ManagedHermesReady)) {
  New-Item -ItemType Directory -Path $RuntimeHome -Force | Out-Null
  Acquire-InstallLock
  try {
    if (-not (Test-ManagedHermesReady)) {
      Install-ManagedHermes
    }
  } finally {
    Release-InstallLock
  }
}

$env:HERMES_HOME = $RuntimeHome
& $Runner @HermesArguments
exit $LASTEXITCODE
`;
}

async function hashOptionalFile(filePath) {
  try {
    return createHash("sha256")
      .update(await readFile(filePath))
      .digest("hex");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function normalizeOptionalSha256(value) {
  if (value === undefined || value.trim() === "") {
    return null;
  }
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^sha256:/u, "");
  if (!/^[a-f0-9]{64}$/u.test(normalized)) {
    throw new Error(
      `OYSTERWORKFLOW_HERMES_INSTALL_SCRIPT_SHA256 must be a 64-character hexadecimal SHA-256, received ${value}`,
    );
  }
  return normalized;
}
