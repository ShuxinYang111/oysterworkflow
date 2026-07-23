#!/usr/bin/env node
import { createHash } from "node:crypto";
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
const configuredOutDir =
  process.env.OYSTERWORKFLOW_BROWSERACT_BUNDLE_OUT_DIR?.trim();
const outDir = configuredOutDir
  ? path.resolve(configuredOutDir)
  : path.resolve(projectRootDir, "out", "bundled", "browseract");
const pinnedPackage = "browser-act-cli";
const pinnedVersion = "1.0.6";
const pinnedSkillVersion = "2.0.2";
const runtimeConfigDir = path.resolve(
  process.env.OYSTERWORKFLOW_BROWSERACT_RUNTIME_CONFIG_DIR?.trim() ??
    path.join(projectRootDir, "config", "browseract-runtime"),
);
const runtimeProjectPath = path.join(runtimeConfigDir, "pyproject.toml");
const runtimeLockPath = path.join(runtimeConfigDir, "uv.lock");
await validateRuntimeLock();
const runtimeRevision = await hashRuntimeConfig();
const runtimeConfigOutDir = path.join(outDir, "runtime-config");
const posixLauncherPath = path.resolve(outDir, "browser-act");
const windowsLauncherPath = path.resolve(outDir, "browser-act.cmd");
const manifestPath = path.resolve(outDir, "browseract-bundle.json");

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
await mkdir(runtimeConfigOutDir, { recursive: true });
await copyFile(
  runtimeProjectPath,
  path.join(runtimeConfigOutDir, "pyproject.toml"),
);
await copyFile(runtimeLockPath, path.join(runtimeConfigOutDir, "uv.lock"));
await writeFile(posixLauncherPath, renderPosixLauncher(), "utf8");
await chmod(posixLauncherPath, 0o755);
await writeFile(windowsLauncherPath, renderWindowsLauncher(), "utf8");
await chmod(windowsLauncherPath, 0o755);
await writeFile(
  manifestPath,
  `${JSON.stringify(
    {
      strategy: "provider-owned-locked-uv-runtime",
      providerId: "chrome",
      implementationId: "browseract.chrome-direct",
      executableName:
        process.platform === "win32" ? "browser-act.cmd" : "browser-act",
      cliPackage: pinnedPackage,
      pinnedVersion,
      skillHandshakeVersion: pinnedSkillVersion,
      runtimeRevision,
      dependencyLock: {
        algorithm: "sha256",
        frozen: true,
        revision: runtimeRevision,
      },
      bundledUvExecutableName: "oysterworkflow-uv",
      lockFiles: ["pyproject.toml", "uv.lock"],
      skillsBundled: false,
      installDir: "$OYSTERWORKFLOW_BROWSERACT_HOME",
      notes:
        "The launcher uses the signed OysterWorkflow uv sidecar and a frozen lockfile to install BrowserAct into an OysterWorkflow-managed provider directory. BrowserAct website skills are intentionally not bundled.",
    },
    null,
    2,
  )}\n`,
  "utf8",
);

process.stdout.write(
  [
    `Bundled Chrome helper launcher prepared at ${posixLauncherPath}`,
    `Bundled Chrome helper Windows launcher prepared at ${windowsLauncherPath}`,
    `Bundled Chrome helper manifest prepared at ${manifestPath}`,
  ].join("\n") + "\n",
);

function renderPosixLauncher() {
  return `#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
HOME_ROOT="\${OYSTERWORKFLOW_BROWSERACT_HOME:-\${HOME}/Library/Application Support/oysterworkflow/browseract}"
PROJECT_SOURCE_DIR="\${OYSTERWORKFLOW_BROWSERACT_PROJECT_SOURCE_DIR:-$SCRIPT_DIR/../config/browseract-runtime}"
if [ ! -f "\${PROJECT_SOURCE_DIR}/uv.lock" ] && [ -f "$SCRIPT_DIR/runtime-config/uv.lock" ]; then
  PROJECT_SOURCE_DIR="$SCRIPT_DIR/runtime-config"
fi
LEGACY_VENV_DIR="\${HOME_ROOT}/venv"
LEGACY_TOOL_BIN="\${LEGACY_VENV_DIR}/bin/browser-act"
LEGACY_REVISION_FILE="\${HOME_ROOT}/runtime-revision"
INSTALLATIONS_DIR="\${HOME_ROOT}/installations"
DEFAULT_UV="$SCRIPT_DIR/oysterworkflow-uv"
if [ ! -x "\${DEFAULT_UV}" ] && [ -x "$SCRIPT_DIR/../hermes/oysterworkflow-uv" ]; then
  DEFAULT_UV="$SCRIPT_DIR/../hermes/oysterworkflow-uv"
fi
UV_BIN="\${OYSTERWORKFLOW_UV_COMMAND:-$DEFAULT_UV}"
BUNDLE_REVISION="${runtimeRevision}"
REVISION_ID="$(printf '%s' "$BUNDLE_REVISION" | tr -c 'A-Za-z0-9._-' '_')"
STAGING_DIR="\${INSTALLATIONS_DIR}/\${REVISION_ID}"
STAGING_PROJECT_DIR="\${STAGING_DIR}/project"
STAGING_VENV_DIR="\${STAGING_DIR}/venv"
STAGING_TOOL_BIN="\${STAGING_VENV_DIR}/bin/browser-act"
STAGING_REVISION_FILE="\${STAGING_DIR}/runtime-revision"
ACTIVE_LINK="\${HOME_ROOT}/runtime"
ACTIVE_LINK_TEMP="\${HOME_ROOT}/runtime.next"
ACTIVE_BACKUP="\${HOME_ROOT}/runtime.previous"
INSTALL_LOCK="\${HOME_ROOT}/install.lock"
LOCK_OWNER_FILE="\${INSTALL_LOCK}/owner"
INSTALL_LOG="\${HOME_ROOT}/install.log"
SKILL_VERSION="${pinnedSkillVersion}"
INSTALL_WAIT_SECONDS="\${OYSTERWORKFLOW_BROWSERACT_INSTALL_WAIT_SECONDS:-600}"
INSTALL_STALE_SECONDS="\${OYSTERWORKFLOW_BROWSERACT_INSTALL_STALE_SECONDS:-1800}"
UV_HTTP_TIMEOUT_SECONDS="\${OYSTERWORKFLOW_BROWSERACT_HTTP_TIMEOUT_SECONDS:-30}"
UV_HTTP_RETRIES="\${OYSTERWORKFLOW_BROWSERACT_HTTP_RETRIES:-3}"
LOCK_HELD=0
STAGING_ACTIVE=0
ACTIVATION_IN_PROGRESS=0

if [ -n "\${OYSTERWORKFLOW_BROWSERACT_COMMAND:-}" ] && [ -x "\${OYSTERWORKFLOW_BROWSERACT_COMMAND}" ]; then
  if [ "\${1:-}" = "--oyster-managed-status" ] || [ "\${1:-}" = "--oyster-managed-install" ]; then
    exec "\${OYSTERWORKFLOW_BROWSERACT_COMMAND}" --version
  fi
  exec "\${OYSTERWORKFLOW_BROWSERACT_COMMAND}" "$@"
fi

validate_timeout_setting() {
  setting_name="$1"
  setting_value="$2"
  case "$setting_value" in
    ''|*[!0-9]*)
      echo "Invalid BrowserAct installer timeout $setting_name=$setting_value; expected non-negative seconds. / BrowserAct 安装器超时配置无效，必须是非负整数秒。" >&2
      exit 64
      ;;
  esac
}

is_ready_dir() {
  candidate_dir="$1"
  [ -x "$candidate_dir/venv/bin/browser-act" ] && [ "$(cat "$candidate_dir/runtime-revision" 2>/dev/null || true)" = "$BUNDLE_REVISION" ]
}

is_legacy_ready() {
  [ -x "$LEGACY_TOOL_BIN" ] && [ "$(cat "$LEGACY_REVISION_FILE" 2>/dev/null || true)" = "$BUNDLE_REVISION" ]
}

is_ready() {
  is_ready_dir "$ACTIVE_LINK" || is_legacy_ready
}

resolve_tool_bin() {
  if is_ready_dir "$ACTIVE_LINK"; then
    printf '%s\n' "$ACTIVE_LINK/venv/bin/browser-act"
    return 0
  fi
  if is_legacy_ready; then
    printf '%s\n' "$LEGACY_TOOL_BIN"
    return 0
  fi
  return 1
}

if [ "\${1:-}" = "--oyster-managed-status" ]; then
  if is_ready; then
    TOOL_BIN="$(resolve_tool_bin)"
    exec "$TOOL_BIN" --version
  fi
  echo "BrowserAct managed runtime is not installed." >&2
  exit 3
fi

lock_modified_at() {
  if modified_at="$(stat -f %m "$INSTALL_LOCK" 2>/dev/null)"; then
    case "$modified_at" in
      ''|*[!0-9]*) ;;
      *)
        printf '%s\n' "$modified_at"
        return 0
        ;;
    esac
  fi
  if modified_at="$(stat -c %Y "$INSTALL_LOCK" 2>/dev/null)"; then
    case "$modified_at" in
      ''|*[!0-9]*) ;;
      *)
        printf '%s\n' "$modified_at"
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
  echo "Recovering a stale BrowserAct installation lock: $stale_reason / 正在恢复遗留的 BrowserAct 安装锁: $stale_reason" >&2
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
      echo "Timed out after $INSTALL_WAIT_SECONDS seconds waiting for another BrowserAct installation. / 等待其它 BrowserAct 安装进程超过 $INSTALL_WAIT_SECONDS 秒。" >&2
      return 1
    fi
    sleep 1
  done
  LOCK_HELD=1
  if ! printf '%s\n%s\n' "$$" "$(date +%s)" > "$LOCK_OWNER_FILE"; then
    echo "Unable to record ownership of the BrowserAct installation lock. / 无法记录 BrowserAct 安装锁的所有者。" >&2
    return 1
  fi
  return 0
}

cleanup_install_state() {
  cleanup_status=$?
  set +e
  if [ "$ACTIVATION_IN_PROGRESS" -eq 1 ] && [ ! -e "$ACTIVE_LINK" ] && [ ! -L "$ACTIVE_LINK" ]; then
    if [ -L "$ACTIVE_LINK_TEMP" ]; then
      mv "$ACTIVE_LINK_TEMP" "$ACTIVE_LINK"
    elif [ -e "$ACTIVE_BACKUP" ] || [ -L "$ACTIVE_BACKUP" ]; then
      mv "$ACTIVE_BACKUP" "$ACTIVE_LINK"
    fi
  fi
  rm -rf "$ACTIVE_LINK_TEMP"
  if [ "$LOCK_HELD" -eq 1 ]; then
    if [ -L "$ACTIVE_LINK" ] && [ "$(readlink "$ACTIVE_LINK" 2>/dev/null || true)" = "$STAGING_DIR" ]; then
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
  if [ ! -e "$ACTIVE_LINK" ] && [ ! -L "$ACTIVE_LINK" ]; then
    if [ -L "$ACTIVE_LINK_TEMP" ]; then
      echo "Recovering a completed BrowserAct staging activation. / 正在恢复已完成的 BrowserAct 暂存安装。" >&2
      mv "$ACTIVE_LINK_TEMP" "$ACTIVE_LINK"
    elif [ -e "$ACTIVE_BACKUP" ] || [ -L "$ACTIVE_BACKUP" ]; then
      echo "Restoring the previous BrowserAct installation after an interrupted activation. / BrowserAct 激活中断，正在恢复上一版安装。" >&2
      mv "$ACTIVE_BACKUP" "$ACTIVE_LINK"
    fi
  fi
}

activate_staging() {
  if ! is_ready_dir "$STAGING_DIR"; then
    echo "BrowserAct staging installation is incomplete and cannot be activated. / BrowserAct 暂存安装不完整，无法激活。" >&2
    return 1
  fi
  rm -rf "$ACTIVE_LINK_TEMP" "$ACTIVE_BACKUP"
  ln -s "$STAGING_DIR" "$ACTIVE_LINK_TEMP"
  ACTIVATION_IN_PROGRESS=1
  if [ -e "$ACTIVE_LINK" ] || [ -L "$ACTIVE_LINK" ]; then
    mv "$ACTIVE_LINK" "$ACTIVE_BACKUP"
  fi
  if ! mv "$ACTIVE_LINK_TEMP" "$ACTIVE_LINK"; then
    if [ -e "$ACTIVE_BACKUP" ] || [ -L "$ACTIVE_BACKUP" ]; then
      mv "$ACTIVE_BACKUP" "$ACTIVE_LINK"
    fi
    ACTIVATION_IN_PROGRESS=0
    echo "Unable to activate the completed BrowserAct staging installation. / 无法激活已完成的 BrowserAct 暂存安装。" >&2
    return 1
  fi
  ACTIVATION_IN_PROGRESS=0
  STAGING_ACTIVE=1
  rm -rf "$ACTIVE_BACKUP"
  return 0
}

install_staging() {
  rm -rf "$STAGING_DIR"
  mkdir -p "$STAGING_PROJECT_DIR" "$HOME_ROOT/cache" "$HOME_ROOT/python"
  cp "$PROJECT_SOURCE_DIR/pyproject.toml" "$STAGING_PROJECT_DIR/pyproject.toml"
  cp "$PROJECT_SOURCE_DIR/uv.lock" "$STAGING_PROJECT_DIR/uv.lock"
  echo "OysterWorkflow is preparing BrowserAct ${pinnedVersion} in a protected staging directory... / OysterWorkflow 正在安全暂存目录中准备 BrowserAct ${pinnedVersion}..." >&2
  if ! UV_PROJECT_ENVIRONMENT="$STAGING_VENV_DIR" UV_CACHE_DIR="$HOME_ROOT/cache" UV_PYTHON_INSTALL_DIR="$HOME_ROOT/python" UV_HTTP_TIMEOUT="$UV_HTTP_TIMEOUT_SECONDS" UV_HTTP_RETRIES="$UV_HTTP_RETRIES" "$UV_BIN" sync --frozen --no-dev --no-install-project --project "$STAGING_PROJECT_DIR" --python 3.12 >>"$INSTALL_LOG" 2>&1; then
    echo "BrowserAct setup failed; the previous ready installation was left unchanged. / BrowserAct 安装失败，上一版可用安装保持不变。" >&2
    return 1
  fi
  if [ ! -x "$STAGING_TOOL_BIN" ]; then
    echo "BrowserAct installation completed without an executable. See $INSTALL_LOG / BrowserAct 安装完成但没有可执行文件，请查看 $INSTALL_LOG" >&2
    return 1
  fi
  completion_temp="$STAGING_REVISION_FILE.tmp.$$"
  printf '%s\n' "$BUNDLE_REVISION" > "$completion_temp"
  mv "$completion_temp" "$STAGING_REVISION_FILE"
  return 0
}

install_runtime() {
  if is_ready; then
    return 0
  fi
  validate_timeout_setting "OYSTERWORKFLOW_BROWSERACT_INSTALL_WAIT_SECONDS" "$INSTALL_WAIT_SECONDS"
  validate_timeout_setting "OYSTERWORKFLOW_BROWSERACT_INSTALL_STALE_SECONDS" "$INSTALL_STALE_SECONDS"
  validate_timeout_setting "OYSTERWORKFLOW_BROWSERACT_HTTP_TIMEOUT_SECONDS" "$UV_HTTP_TIMEOUT_SECONDS"
  validate_timeout_setting "OYSTERWORKFLOW_BROWSERACT_HTTP_RETRIES" "$UV_HTTP_RETRIES"
  mkdir -p "$HOME_ROOT" "$INSTALLATIONS_DIR"
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
  if [ ! -x "$UV_BIN" ]; then
    echo "Bundled uv sidecar is missing or not executable: $UV_BIN / 内置 uv 不存在或不可执行：$UV_BIN" >&2
    return 127
  fi
  if [ ! -f "$PROJECT_SOURCE_DIR/pyproject.toml" ] || [ ! -f "$PROJECT_SOURCE_DIR/uv.lock" ]; then
    echo "BrowserAct locked runtime configuration is missing: $PROJECT_SOURCE_DIR / BrowserAct 锁定运行配置缺失：$PROJECT_SOURCE_DIR" >&2
    return 127
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
TOOL_BIN="$(resolve_tool_bin)"
"$TOOL_BIN" get-skills core --skill-version "$SKILL_VERSION" >/dev/null
if [ "\${1:-}" = "--oyster-managed-install" ]; then
  exec "$TOOL_BIN" --version
fi
exec "$TOOL_BIN" "$@"
`;
}

function renderWindowsLauncher() {
  return `@echo off
setlocal
if "%OYSTERWORKFLOW_BROWSERACT_HOME%"=="" set OYSTERWORKFLOW_BROWSERACT_HOME=%APPDATA%\\oysterworkflow\\browseract
set SCRIPT_DIR=%~dp0
if "%OYSTERWORKFLOW_BROWSERACT_PROJECT_SOURCE_DIR%"=="" set OYSTERWORKFLOW_BROWSERACT_PROJECT_SOURCE_DIR=%SCRIPT_DIR%..\\config\\browseract-runtime
if not exist "%OYSTERWORKFLOW_BROWSERACT_PROJECT_SOURCE_DIR%\\uv.lock" if exist "%SCRIPT_DIR%runtime-config\\uv.lock" set OYSTERWORKFLOW_BROWSERACT_PROJECT_SOURCE_DIR=%SCRIPT_DIR%runtime-config
set VENV_DIR=%OYSTERWORKFLOW_BROWSERACT_HOME%\\venv
set TOOL_BIN=%VENV_DIR%\\Scripts\\browser-act.exe

if not "%OYSTERWORKFLOW_BROWSERACT_COMMAND%"=="" if exist "%OYSTERWORKFLOW_BROWSERACT_COMMAND%" (
  "%OYSTERWORKFLOW_BROWSERACT_COMMAND%" %*
  exit /b %ERRORLEVEL%
)

if not exist "%OYSTERWORKFLOW_BROWSERACT_PROJECT_SOURCE_DIR%\\pyproject.toml" (
  echo BrowserAct locked runtime configuration is missing: %OYSTERWORKFLOW_BROWSERACT_PROJECT_SOURCE_DIR% 1>&2
  exit /b 127
)
if not exist "%OYSTERWORKFLOW_BROWSERACT_PROJECT_SOURCE_DIR%\\uv.lock" (
  echo BrowserAct frozen dependency lock is missing: %OYSTERWORKFLOW_BROWSERACT_PROJECT_SOURCE_DIR%\\uv.lock 1>&2
  exit /b 127
)
if not exist "%TOOL_BIN%" (
  where uv >nul 2>nul
  if errorlevel 1 (
    echo BrowserAct requires uv to install its frozen runtime on Windows. 1>&2
    exit /b 127
  )
  set UV_PROJECT_ENVIRONMENT=%VENV_DIR%
  if "%OYSTERWORKFLOW_BROWSERACT_HTTP_TIMEOUT_SECONDS%"=="" set UV_HTTP_TIMEOUT=30
  if not "%OYSTERWORKFLOW_BROWSERACT_HTTP_TIMEOUT_SECONDS%"=="" set UV_HTTP_TIMEOUT=%OYSTERWORKFLOW_BROWSERACT_HTTP_TIMEOUT_SECONDS%
  if "%OYSTERWORKFLOW_BROWSERACT_HTTP_RETRIES%"=="" set UV_HTTP_RETRIES=3
  if not "%OYSTERWORKFLOW_BROWSERACT_HTTP_RETRIES%"=="" set UV_HTTP_RETRIES=%OYSTERWORKFLOW_BROWSERACT_HTTP_RETRIES%
  uv sync --frozen --no-dev --no-install-project --project "%OYSTERWORKFLOW_BROWSERACT_PROJECT_SOURCE_DIR%" --python 3.12
  if errorlevel 1 exit /b %ERRORLEVEL%
)
"%TOOL_BIN%" %*
exit /b %ERRORLEVEL%
`;
}

async function validateRuntimeLock() {
  const [projectText, lockText] = await Promise.all([
    readFile(runtimeProjectPath, "utf8"),
    readFile(runtimeLockPath, "utf8"),
  ]);
  if (!projectText.includes(`${pinnedPackage}==${pinnedVersion}`)) {
    throw new Error(
      `BrowserAct pyproject must pin ${pinnedPackage}==${pinnedVersion}: ${runtimeProjectPath}`,
    );
  }
  const packagePattern = new RegExp(
    `name = "${pinnedPackage}"\\nversion = "${pinnedVersion.replaceAll(".", "\\.")}"`,
    "u",
  );
  if (!packagePattern.test(lockText)) {
    throw new Error(
      `BrowserAct uv.lock does not contain ${pinnedPackage} ${pinnedVersion}: ${runtimeLockPath}`,
    );
  }
  const unlockedArtifact = lockText
    .split("\n")
    .find(
      (line) =>
        /url = "https:\/\//u.test(line) &&
        !/hash = "sha256:[a-f0-9]{64}"/u.test(line),
    );
  if (unlockedArtifact) {
    throw new Error(
      `BrowserAct uv.lock contains an artifact without a SHA-256 hash: ${unlockedArtifact.trim()}`,
    );
  }
}

async function hashRuntimeConfig() {
  const hash = createHash("sha256");
  hash.update(`browser-act-skill:${pinnedSkillVersion}\n`);
  hash.update(await readFile(runtimeProjectPath));
  hash.update(await readFile(runtimeLockPath));
  return `sha256:${hash.digest("hex")}`;
}
