import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readlink,
  rm,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const projectRoot = join(import.meta.dirname, "..");

describe("Hermes bundle builder", () => {
  it("creates a relocatable managed Hermes launcher for desktop packaging", async () => {
    const testBundle = await createBundleTestRoot();

    try {
      const sourceSeedDir = await createHermesSourceSeed(testBundle.tempRoot);
      await mkdir(join(sourceSeedDir, ".venv", "bin"), { recursive: true });
      await writeFile(
        join(sourceSeedDir, ".venv", "bin", "python"),
        "temporary local environment",
        "utf8",
      );
      await runBundleBuilder(testBundle.bundledHermesDir, {
        OYSTERWORKFLOW_HERMES_SOURCE_PATH: sourceSeedDir,
      });

      const [
        launcher,
        windowsLauncher,
        nodeLauncher,
        manifest,
        launcherStat,
        nodeLauncherStat,
      ] = await Promise.all([
        readFile(testBundle.launcherPath, "utf8"),
        readFile(testBundle.windowsLauncherPath, "utf8"),
        readFile(testBundle.nodeLauncherPath, "utf8"),
        readFile(testBundle.manifestPath, "utf8"),
        stat(testBundle.launcherPath),
        stat(testBundle.nodeLauncherPath),
      ]);

      if (process.platform !== "win32") {
        expect(launcherStat.mode & 0o111).toBeGreaterThan(0);
        expect(nodeLauncherStat.mode & 0o111).toBeGreaterThan(0);
      }
      expect(nodeLauncher).toContain("ELECTRON_RUN_AS_NODE=1");
      expect(nodeLauncher).toContain("MacOS/OysterWorkflow");
      expect(launcher).toContain("HERMES_HOME");
      expect(launcher).toContain("INSTALLER_HOME");
      expect(launcher).toContain("scripts/install.sh");
      expect(launcher).not.toContain(homedir());
      expect(windowsLauncher).toContain("scripts\\install.ps1");
      expect(windowsLauncher).toContain("venv\\Scripts\\hermes.exe");
      expect(windowsLauncher).toContain("Install-ManagedHermes");
      expect(windowsLauncher).not.toContain("requires WSL2");
      const parsedManifest = JSON.parse(manifest) as {
        bundledSource: { digest: string };
        installScriptSha256: string;
        bundledWhatsAppBridge: {
          dependencyStrategy: string;
          relativePath: string;
        };
      };
      expect(parsedManifest).toMatchObject({
        executableName: process.platform === "win32" ? "hermes.ps1" : "hermes",
        strategy: "managed-install-launcher",
        bundledNode:
          process.platform === "darwin"
            ? {
                relativePath: "node",
                strategy: "electron-run-as-node",
              }
            : null,
        bundledWhatsAppBridge: {
          relativePath: "hermes-agent-source/scripts/whatsapp-bridge",
          dependencyStrategy: "bundled-production-node-modules",
        },
        bundledSource: {
          sourceKind: "override",
          version: "9.9.9",
        },
      });
      expect(parsedManifest.bundledSource.digest).toMatch(
        /^sha256:[a-f0-9]{64}$/u,
      );
      expect(parsedManifest.installScriptSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(launcher).toContain(parsedManifest.bundledSource.digest);
      await expect(
        stat(join(testBundle.bundledHermesDir, "hermes-agent-source", ".venv")),
      ).rejects.toThrow();
      await expect(
        stat(
          join(
            testBundle.bundledHermesDir,
            "hermes-agent-source",
            "scripts",
            "whatsapp-bridge",
            "node_modules",
            ".package-lock.json",
          ),
        ),
      ).resolves.toMatchObject({ size: expect.any(Number) });
    } finally {
      await rm(testBundle.tempRoot, { recursive: true, force: true });
    }
  });

  it("materializes a top-level source symlink while filtering local runtime artifacts", async () => {
    const tempRoot = await mkdtemp(
      join(tmpdir(), "oyster-hermes-symlink-seed-"),
    );
    const sourceSeedDir = await createHermesSourceSeed(tempRoot);
    const sourceSeedLink = join(tempRoot, "managed-hermes");
    const sourcePackageDir = join(sourceSeedDir, "hermes_agent");
    const testBundle = await createBundleTestRoot();
    await mkdir(join(sourceSeedDir, "venv", "bin"), { recursive: true });
    await mkdir(join(sourcePackageDir, "__pycache__"), { recursive: true });
    await writeFile(
      join(sourceSeedDir, "venv", "bin", "python"),
      "managed runtime artifact\n",
      "utf8",
    );
    await writeFile(
      join(sourcePackageDir, "worker.py"),
      "WORKER_NAME = 'fixture'\n",
      "utf8",
    );
    await writeFile(
      join(sourcePackageDir, "__pycache__", "worker.pyc"),
      "compiled runtime artifact\n",
      "utf8",
    );
    await symlink("setup-hermes.sh", join(sourceSeedDir, "setup-current.sh"));
    await symlink(sourceSeedDir, sourceSeedLink, "dir");

    try {
      await runBundleBuilder(testBundle.bundledHermesDir, {
        OYSTERWORKFLOW_HERMES_SOURCE_PATH: sourceSeedLink,
      });

      const bundledSourceDir = join(
        testBundle.bundledHermesDir,
        "hermes-agent-source",
      );
      const [bundledSourceStat, internalLinkStat] = await Promise.all([
        lstat(bundledSourceDir),
        lstat(join(bundledSourceDir, "setup-current.sh")),
      ]);
      expect(bundledSourceStat.isDirectory()).toBe(true);
      expect(bundledSourceStat.isSymbolicLink()).toBe(false);
      expect(internalLinkStat.isSymbolicLink()).toBe(true);
      await expect(
        readlink(join(bundledSourceDir, "setup-current.sh")),
      ).resolves.toBe("setup-hermes.sh");
      await expect(
        readFile(join(bundledSourceDir, "hermes_agent", "worker.py"), "utf8"),
      ).resolves.toBe("WORKER_NAME = 'fixture'\n");
      await expect(stat(join(bundledSourceDir, "venv"))).rejects.toThrow();
      await expect(
        stat(join(bundledSourceDir, "hermes_agent", "__pycache__")),
      ).rejects.toThrow();
    } finally {
      await rm(testBundle.tempRoot, { recursive: true, force: true });
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("records git metadata for the bundled Hermes source seed", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "oyster-hermes-git-seed-"));
    const sourceSeedDir = await createHermesSourceSeed(tempRoot);

    try {
      await execFileAsync("git", ["init"], { cwd: sourceSeedDir });
      await execFileAsync("git", ["config", "user.email", "test@example.com"], {
        cwd: sourceSeedDir,
      });
      await execFileAsync("git", ["config", "user.name", "Hermes Test"], {
        cwd: sourceSeedDir,
      });
      await execFileAsync("git", ["add", "."], { cwd: sourceSeedDir });
      await execFileAsync("git", ["commit", "-m", "seed hermes"], {
        cwd: sourceSeedDir,
      });
      const { stdout: head } = await execFileAsync(
        "git",
        ["rev-parse", "HEAD"],
        {
          cwd: sourceSeedDir,
        },
      );
      const testBundle = await createBundleTestRoot();

      try {
        await runBundleBuilder(testBundle.bundledHermesDir, {
          OYSTERWORKFLOW_HERMES_SOURCE_PATH: sourceSeedDir,
        });

        const manifest = JSON.parse(
          await readFile(testBundle.manifestPath, "utf8"),
        ) as {
          bundledSource: Record<string, unknown>;
        };
        expect(manifest.bundledSource).toMatchObject({
          version: "9.9.9",
          commit: head.trim(),
          dirty: false,
        });
      } finally {
        await rm(testBundle.tempRoot, { recursive: true, force: true });
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("boots from a bundled Hermes source seed before using the network installer", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "oyster-hermes-seed-"));
    const sourceSeedDir = join(tempRoot, "seed");
    const runtimeHome = join(tempRoot, "runtime-home");
    await mkdir(sourceSeedDir, { recursive: true });
    await writeFile(
      join(sourceSeedDir, "setup-hermes.sh"),
      `#!/bin/sh
set -eu
read -r optional_answer
read -r wizard_answer
printf "%s\\n%s\\n" "$optional_answer" "$wizard_answer" > "$HERMES_HOME/setup-answers"
mkdir -p venv/bin
cat > venv/bin/hermes <<'RUNNER'
#!/bin/sh
echo "seed runner:$*"
RUNNER
chmod +x venv/bin/hermes
`,
      "utf8",
    );
    await chmod(join(sourceSeedDir, "setup-hermes.sh"), 0o755);

    try {
      const testBundle = await createBundleTestRoot();
      try {
        await runBundleBuilder(testBundle.bundledHermesDir, {
          OYSTERWORKFLOW_HERMES_SOURCE_PATH: sourceSeedDir,
        });

        const { stdout } = await execFileAsync(
          testBundle.launcherPath,
          ["status"],
          {
            env: {
              ...process.env,
              HERMES_HOME: runtimeHome,
              OYSTERWORKFLOW_HERMES_INSTALL_URL:
                "file:///missing-network-installer",
              PATH: "/usr/bin:/bin",
            },
          },
        );

        expect(stdout).toContain("seed runner:status");
        await expect(
          readFile(join(runtimeHome, "setup-answers"), "utf8"),
        ).resolves.toBe("n\nn\n");
        await expect(
          readFile(
            join(runtimeHome, "hermes-agent", "setup-hermes.sh"),
            "utf8",
          ),
        ).resolves.toContain("seed runner");
        const manifest = JSON.parse(
          await readFile(testBundle.manifestPath, "utf8"),
        ) as {
          bundledSource: { digest: string };
        };
        expect(manifest.bundledSource).toMatchObject({
          directoryName: "hermes-agent-source",
        });
        await expect(
          readFile(
            join(
              runtimeHome,
              "hermes-agent",
              ".oysterworkflow-bundle-revision",
            ),
            "utf8",
          ),
        ).resolves.toBe(`${manifest.bundledSource.digest}\n`);
      } finally {
        await rm(testBundle.tempRoot, { recursive: true, force: true });
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("upgrades an existing managed runtime when the bundled source changes", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "oyster-hermes-upgrade-"));
    const sourceSeedDir = join(tempRoot, "seed");
    const runtimeHome = join(tempRoot, "runtime-home");
    const testBundle = await createBundleTestRoot();
    await mkdir(sourceSeedDir, { recursive: true });
    await writeFile(join(sourceSeedDir, "version.txt"), "v1\n", "utf8");
    await writeFile(
      join(sourceSeedDir, "setup-hermes.sh"),
      `#!/bin/sh
set -eu
count="$(cat "$HERMES_HOME/install-count" 2>/dev/null || echo 0)"
echo $((count + 1)) > "$HERMES_HOME/install-count"
mkdir -p venv/bin
cat > venv/bin/hermes <<'RUNNER'
#!/bin/sh
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
printf '%s:%s\n' "$(cat "$ROOT/version.txt")" "$*"
RUNNER
chmod +x venv/bin/hermes
`,
      "utf8",
    );
    await chmod(join(sourceSeedDir, "setup-hermes.sh"), 0o755);

    try {
      await runBundleBuilder(testBundle.bundledHermesDir, {
        OYSTERWORKFLOW_HERMES_SOURCE_PATH: sourceSeedDir,
      });
      const first = await execFileAsync(testBundle.launcherPath, ["status"], {
        env: {
          ...process.env,
          HERMES_HOME: runtimeHome,
          PATH: "/usr/bin:/bin",
        },
      });
      expect(first.stdout).toContain("v1:status");

      await writeFile(join(sourceSeedDir, "version.txt"), "v2\n", "utf8");
      await runBundleBuilder(testBundle.bundledHermesDir, {
        OYSTERWORKFLOW_HERMES_SOURCE_PATH: sourceSeedDir,
      });
      const second = await execFileAsync(testBundle.launcherPath, ["status"], {
        env: {
          ...process.env,
          HERMES_HOME: runtimeHome,
          PATH: "/usr/bin:/bin",
        },
      });

      expect(second.stdout).toContain("v2:status");
      await expect(
        readFile(join(runtimeHome, "install-count"), "utf8"),
      ).resolves.toBe("2\n");
    } finally {
      await rm(testBundle.tempRoot, { recursive: true, force: true });
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("serializes concurrent first-run installs for the same runtime home", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "oyster-hermes-concurrent-"));
    const sourceSeedDir = join(tempRoot, "seed");
    const runtimeHome = join(tempRoot, "runtime-home");
    const testBundle = await createBundleTestRoot();
    await mkdir(sourceSeedDir, { recursive: true });
    await writeFile(
      join(sourceSeedDir, "setup-hermes.sh"),
      `#!/bin/sh
set -eu
count="$(cat "$HERMES_HOME/install-count" 2>/dev/null || echo 0)"
echo $((count + 1)) > "$HERMES_HOME/install-count"
sleep 1
mkdir -p venv/bin
cat > venv/bin/hermes <<'RUNNER'
#!/bin/sh
echo "concurrent runner:$*"
RUNNER
chmod +x venv/bin/hermes
`,
      "utf8",
    );
    await chmod(join(sourceSeedDir, "setup-hermes.sh"), 0o755);

    try {
      await runBundleBuilder(testBundle.bundledHermesDir, {
        OYSTERWORKFLOW_HERMES_SOURCE_PATH: sourceSeedDir,
      });
      const env = {
        ...process.env,
        HERMES_HOME: runtimeHome,
        OYSTERWORKFLOW_HERMES_INSTALL_WAIT_SECONDS: "10",
        OYSTERWORKFLOW_HERMES_INSTALL_STALE_SECONDS: "60",
        PATH: "/usr/bin:/bin",
      };

      const [first, second] = await Promise.all([
        execFileAsync(testBundle.launcherPath, ["first"], { env }),
        execFileAsync(testBundle.launcherPath, ["second"], { env }),
      ]);

      expect(first.stdout).toContain("concurrent runner:first");
      expect(second.stdout).toContain("concurrent runner:second");
      await expect(
        readFile(join(runtimeHome, "install-count"), "utf8"),
      ).resolves.toBe("1\n");
      await expect(
        stat(join(runtimeHome, ".oysterworkflow-hermes-install.lock")),
      ).rejects.toThrow();
    } finally {
      await rm(testBundle.tempRoot, { recursive: true, force: true });
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps the previous ready runtime when a staged upgrade fails", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "oyster-hermes-rollback-"));
    const sourceSeedDir = join(tempRoot, "seed");
    const runtimeHome = join(tempRoot, "runtime-home");
    const testBundle = await createBundleTestRoot();
    await mkdir(sourceSeedDir, { recursive: true });
    await writeFile(join(sourceSeedDir, "version.txt"), "v1\n", "utf8");
    await writeFile(
      join(sourceSeedDir, "setup-hermes.sh"),
      `#!/bin/sh
set -eu
mkdir -p venv/bin
cat > venv/bin/hermes <<'RUNNER'
#!/bin/sh
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
printf '%s:%s\n' "$(cat "$ROOT/version.txt")" "$*"
RUNNER
chmod +x venv/bin/hermes
`,
      "utf8",
    );
    await chmod(join(sourceSeedDir, "setup-hermes.sh"), 0o755);

    try {
      await runBundleBuilder(testBundle.bundledHermesDir, {
        OYSTERWORKFLOW_HERMES_SOURCE_PATH: sourceSeedDir,
      });
      const env = {
        ...process.env,
        HERMES_HOME: runtimeHome,
        PATH: "/usr/bin:/bin",
      };
      const first = await execFileAsync(testBundle.launcherPath, ["ready"], {
        env,
      });
      expect(first.stdout).toContain("v1:ready");
      const readyMarker = await readFile(
        join(runtimeHome, "hermes-agent", ".oysterworkflow-bundle-revision"),
        "utf8",
      );

      await writeFile(join(sourceSeedDir, "version.txt"), "v2\n", "utf8");
      await writeFile(
        join(sourceSeedDir, "setup-hermes.sh"),
        `#!/bin/sh
set -eu
mkdir -p venv/bin
printf '#!/bin/sh\necho partial\n' > venv/bin/hermes
chmod +x venv/bin/hermes
exit 42
`,
        "utf8",
      );
      await chmod(join(sourceSeedDir, "setup-hermes.sh"), 0o755);
      await runBundleBuilder(testBundle.bundledHermesDir, {
        OYSTERWORKFLOW_HERMES_SOURCE_PATH: sourceSeedDir,
      });
      const failedManifest = JSON.parse(
        await readFile(testBundle.manifestPath, "utf8"),
      ) as { bundledSource: { digest: string } };
      const failedRevisionDir = failedManifest.bundledSource.digest.replace(
        /[^A-Za-z0-9._-]/gu,
        "_",
      );

      await expect(
        execFileAsync(testBundle.launcherPath, ["upgrade"], { env }),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining(
          "the previous ready installation was left unchanged",
        ),
      });
      await expect(
        readFile(
          join(runtimeHome, "hermes-agent", ".oysterworkflow-bundle-revision"),
          "utf8",
        ),
      ).resolves.toBe(readyMarker);
      const previousRunner = await execFileAsync(
        join(runtimeHome, "hermes-agent", "venv", "bin", "hermes"),
        ["after-failure"],
        { env },
      );
      expect(previousRunner.stdout).toContain("v1:after-failure");
      await expect(
        stat(
          join(
            runtimeHome,
            ".oysterworkflow-hermes-installs",
            failedRevisionDir,
          ),
        ),
      ).rejects.toThrow();
      await expect(
        stat(join(runtimeHome, ".oysterworkflow-hermes-install.lock")),
      ).rejects.toThrow();
    } finally {
      await rm(testBundle.tempRoot, { recursive: true, force: true });
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("recovers a stale install lock before installing", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "oyster-hermes-stale-lock-"));
    const sourceSeedDir = join(tempRoot, "seed");
    const runtimeHome = join(tempRoot, "runtime-home");
    const installLock = join(
      runtimeHome,
      ".oysterworkflow-hermes-install.lock",
    );
    const testBundle = await createBundleTestRoot();
    await mkdir(sourceSeedDir, { recursive: true });
    await writeFile(
      join(sourceSeedDir, "setup-hermes.sh"),
      `#!/bin/sh
set -eu
mkdir -p venv/bin
cat > venv/bin/hermes <<'RUNNER'
#!/bin/sh
echo "stale-lock-runner:$*"
RUNNER
chmod +x venv/bin/hermes
`,
      "utf8",
    );
    await chmod(join(sourceSeedDir, "setup-hermes.sh"), 0o755);

    try {
      await runBundleBuilder(testBundle.bundledHermesDir, {
        OYSTERWORKFLOW_HERMES_SOURCE_PATH: sourceSeedDir,
      });
      await mkdir(installLock, { recursive: true });
      await writeFile(
        join(installLock, "owner"),
        `99999999\n${Math.floor(Date.now() / 1000)}\n`,
        "utf8",
      );

      const result = await execFileAsync(testBundle.launcherPath, ["status"], {
        env: {
          ...process.env,
          HERMES_HOME: runtimeHome,
          OYSTERWORKFLOW_HERMES_INSTALL_WAIT_SECONDS: "5",
          OYSTERWORKFLOW_HERMES_INSTALL_STALE_SECONDS: "60",
          PATH: "/usr/bin:/bin",
        },
      });
      expect(result.stdout).toContain("stale-lock-runner:status");
      expect(result.stderr).toContain(
        "Recovering stale Hermes installation lock",
      );
      expect(result.stderr).toContain("正在恢复遗留的 Hermes 安装锁");
      await expect(stat(installLock)).rejects.toThrow();
    } finally {
      await rm(testBundle.tempRoot, { recursive: true, force: true });
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("bounds waiting for a live install lock", async () => {
    const tempRoot = await mkdtemp(
      join(tmpdir(), "oyster-hermes-lock-timeout-"),
    );
    const sourceSeedDir = join(tempRoot, "seed");
    const runtimeHome = join(tempRoot, "runtime-home");
    const installLock = join(
      runtimeHome,
      ".oysterworkflow-hermes-install.lock",
    );
    const testBundle = await createBundleTestRoot();
    await mkdir(sourceSeedDir, { recursive: true });
    await writeFile(
      join(sourceSeedDir, "setup-hermes.sh"),
      "#!/bin/sh\nexit 0\n",
      "utf8",
    );
    await chmod(join(sourceSeedDir, "setup-hermes.sh"), 0o755);

    try {
      await runBundleBuilder(testBundle.bundledHermesDir, {
        OYSTERWORKFLOW_HERMES_SOURCE_PATH: sourceSeedDir,
      });
      await mkdir(installLock, { recursive: true });
      await writeFile(
        join(installLock, "owner"),
        `${process.pid}\n${Math.floor(Date.now() / 1000)}\n`,
        "utf8",
      );
      const waitStarted = Date.now();

      await expect(
        execFileAsync(testBundle.launcherPath, ["status"], {
          env: {
            ...process.env,
            HERMES_HOME: runtimeHome,
            OYSTERWORKFLOW_HERMES_INSTALL_WAIT_SECONDS: "1",
            OYSTERWORKFLOW_HERMES_INSTALL_STALE_SECONDS: "60",
            PATH: "/usr/bin:/bin",
          },
        }),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining(
          "Timed out after 1 seconds waiting for another Hermes installation",
        ),
      });
      expect(Date.now() - waitStarted).toBeLessThan(5_000);
      await expect(stat(join(runtimeHome, "hermes-agent"))).rejects.toThrow();
    } finally {
      await rm(testBundle.tempRoot, { recursive: true, force: true });
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("seeds managed uv from the app bundle before running bundled Hermes setup", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "oyster-hermes-uv-seed-"));
    const sourceSeedDir = join(tempRoot, "seed");
    const runtimeHome = join(tempRoot, "runtime-home");
    const uvBinaryPath = join(tempRoot, "fake-uv");
    await mkdir(sourceSeedDir, { recursive: true });
    await writeFile(
      uvBinaryPath,
      `#!/bin/sh
echo "bundled uv $*"
`,
      "utf8",
    );
    await chmod(uvBinaryPath, 0o755);
    await writeFile(
      join(sourceSeedDir, "setup-hermes.sh"),
      `#!/bin/sh
set -eu
mkdir -p venv/bin
command -v uv > "$HERMES_HOME/uv-used"
uv --version > "$HERMES_HOME/uv-version"
cat > venv/bin/hermes <<'RUNNER'
#!/bin/sh
echo "seed runner:$*"
RUNNER
chmod +x venv/bin/hermes
`,
      "utf8",
    );
    await chmod(join(sourceSeedDir, "setup-hermes.sh"), 0o755);

    try {
      const testBundle = await createBundleTestRoot();
      try {
        await runBundleBuilder(testBundle.bundledHermesDir, {
          OYSTERWORKFLOW_HERMES_SOURCE_PATH: sourceSeedDir,
          OYSTERWORKFLOW_UV_BINARY_PATH: uvBinaryPath,
        });

        const { stdout } = await execFileAsync(
          testBundle.launcherPath,
          ["status"],
          {
            env: {
              ...process.env,
              HERMES_HOME: runtimeHome,
              OYSTERWORKFLOW_HERMES_INSTALL_URL:
                "file:///missing-network-installer",
              PATH: "/usr/bin:/bin",
            },
          },
        );

        expect(stdout).toContain("seed runner:status");
        await expect(
          readFile(join(runtimeHome, "uv-used"), "utf8"),
        ).resolves.toBe(`${join(runtimeHome, "bin", "uv")}\n`);
        await expect(
          readFile(join(runtimeHome, "uv-version"), "utf8"),
        ).resolves.toContain("bundled uv --version");
        const manifest = JSON.parse(
          await readFile(testBundle.manifestPath, "utf8"),
        ) as {
          bundledUv: unknown;
        };
        expect(manifest.bundledUv).toMatchObject({
          relativePath: "oysterworkflow-uv",
        });
      } finally {
        await rm(testBundle.tempRoot, { recursive: true, force: true });
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

async function createBundleTestRoot(prefix = "oyster-hermes-bundle-") {
  const tempRoot = await mkdtemp(join(tmpdir(), prefix));
  const bundledHermesDir = join(tempRoot, "bundled-hermes");
  return {
    tempRoot,
    bundledHermesDir,
    launcherPath: join(bundledHermesDir, "hermes"),
    windowsLauncherPath: join(bundledHermesDir, "hermes.ps1"),
    nodeLauncherPath: join(bundledHermesDir, "node"),
    manifestPath: join(bundledHermesDir, "hermes-bundle.json"),
  };
}

async function createHermesSourceSeed(tempRoot: string): Promise<string> {
  const sourceSeedDir = join(tempRoot, "seed");
  const whatsappBridgeDir = join(sourceSeedDir, "scripts", "whatsapp-bridge");
  await mkdir(sourceSeedDir, { recursive: true });
  await mkdir(whatsappBridgeDir, { recursive: true });
  await writeFile(
    join(sourceSeedDir, "pyproject.toml"),
    '[project]\nversion = "9.9.9"\n',
    "utf8",
  );
  await writeFile(
    join(sourceSeedDir, "setup-hermes.sh"),
    `#!/bin/sh
set -eu
mkdir -p venv/bin
cat > venv/bin/hermes <<'RUNNER'
#!/bin/sh
echo "seed runner:$*"
RUNNER
chmod +x venv/bin/hermes
`,
    "utf8",
  );
  await chmod(join(sourceSeedDir, "setup-hermes.sh"), 0o755);
  await writeFile(
    join(sourceSeedDir, "scripts", "install.sh"),
    "#!/bin/sh\nset -eu\necho fixture installer\n",
    "utf8",
  );
  await writeFile(
    join(whatsappBridgeDir, "bridge.js"),
    "console.log('fixture bridge');\n",
    "utf8",
  );
  await writeFile(
    join(whatsappBridgeDir, "package.json"),
    `${JSON.stringify({ name: "fixture-whatsapp-bridge", version: "1.0.0" })}\n`,
    "utf8",
  );
  await writeFile(
    join(whatsappBridgeDir, "package-lock.json"),
    `${JSON.stringify({
      name: "fixture-whatsapp-bridge",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": { name: "fixture-whatsapp-bridge", version: "1.0.0" },
      },
    })}\n`,
    "utf8",
  );
  return sourceSeedDir;
}

async function runBundleBuilder(
  outDir: string,
  env: NodeJS.ProcessEnv = {},
): Promise<void> {
  await execFileAsync(process.execPath, ["scripts/build-hermes-bundle.mjs"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      OYSTERWORKFLOW_HERMES_BUNDLE_OUT_DIR: outDir,
      ...env,
    },
  });
}
