import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
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

describe.skipIf(process.platform === "win32")(
  "BrowserAct bundle builder",
  () => {
    it("installs from the bundled uv sidecar under a clean PATH", async () => {
      const tempRoot = await mkdtemp(
        join(tmpdir(), "oyster-browseract-bundle-"),
      );
      tempRoots.push(tempRoot);
      const outDir = join(tempRoot, "bundle");
      const runtimeHome = join(tempRoot, "runtime home");
      const callsPath = join(tempRoot, "uv-calls.txt");
      const builderPath = resolve("scripts/build-browseract-bundle.mjs");
      await execFileAsync(process.execPath, [builderPath], {
        env: {
          ...process.env,
          OYSTERWORKFLOW_BROWSERACT_BUNDLE_OUT_DIR: outDir,
        },
      });
      const manifest = JSON.parse(
        await readFile(join(outDir, "browseract-bundle.json"), "utf8"),
      ) as { pinnedVersion: string };
      const bundledProject = await readFile(
        join(outDir, "runtime-config", "pyproject.toml"),
        "utf8",
      );
      const bundledLock = await readFile(
        join(outDir, "runtime-config", "uv.lock"),
        "utf8",
      );
      expect(bundledProject).toContain(
        `browser-act-cli==${manifest.pinnedVersion}`,
      );
      expect(bundledLock).toMatch(
        new RegExp(
          `name = "browser-act-cli"\\r?\\nversion = "${manifest.pinnedVersion.replaceAll(".", "\\.")}"`,
          "u",
        ),
      );

      const uvPath = join(outDir, "oysterworkflow-uv");
      await writeFile(
        uvPath,
        `#!/bin/sh
set -eu
echo "$*" >> "${callsPath}"
mkdir -p "$UV_PROJECT_ENVIRONMENT/bin"
cat > "$UV_PROJECT_ENVIRONMENT/bin/browser-act" <<'RUNNER'
#!/bin/sh
if [ "\${1:-}" = "--version" ]; then
  echo "browser-act-cli ${manifest.pinnedVersion}"
else
  echo "browser-act:$*"
fi
RUNNER
chmod +x "$UV_PROJECT_ENVIRONMENT/bin/browser-act"
`,
        "utf8",
      );
      await chmod(uvPath, 0o755);
      const launcherPath = join(outDir, "browser-act");
      const cleanEnv = {
        HOME: join(tempRoot, "home"),
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        OYSTERWORKFLOW_BROWSERACT_HOME: runtimeHome,
      };

      await expect(
        execFileAsync(launcherPath, ["--oyster-managed-status"], {
          env: cleanEnv,
        }),
      ).rejects.toMatchObject({ code: 3 });
      await expect(
        execFileAsync(launcherPath, ["--oyster-managed-install"], {
          env: cleanEnv,
        }),
      ).resolves.toMatchObject({
        stdout: expect.stringContaining(manifest.pinnedVersion),
      });
      await expect(
        execFileAsync(launcherPath, ["browser", "list"], { env: cleanEnv }),
      ).resolves.toMatchObject({
        stdout: expect.stringContaining("browser-act:browser list"),
      });
      await expect(readFile(callsPath, "utf8")).resolves.toContain(
        "sync --frozen --no-dev --no-install-project",
      );
    });

    it("serializes concurrent installs for the same managed runtime", async () => {
      const fixture = await createBrowserActBundleFixture("concurrent");
      const runtimeHome = join(fixture.tempRoot, "runtime");
      const callsPath = join(fixture.tempRoot, "uv-calls.txt");
      await writeSuccessfulUv(
        fixture.outDir,
        callsPath,
        fixture.pinnedVersion,
        1,
      );
      const env = browserActTestEnv(fixture.tempRoot, runtimeHome, {
        OYSTERWORKFLOW_BROWSERACT_INSTALL_WAIT_SECONDS: "10",
        OYSTERWORKFLOW_BROWSERACT_INSTALL_STALE_SECONDS: "60",
      });

      const [first, second] = await Promise.all([
        execFileAsync(fixture.launcherPath, ["first"], { env }),
        execFileAsync(fixture.launcherPath, ["second"], { env }),
      ]);

      expect(first.stdout).toContain("browser-act:first");
      expect(second.stdout).toContain("browser-act:second");
      expect(
        (await readFile(callsPath, "utf8")).trim().split("\n"),
      ).toHaveLength(1);
      await expect(stat(join(runtimeHome, "install.lock"))).rejects.toThrow();
      await expect(
        readFile(join(runtimeHome, "runtime", "runtime-revision"), "utf8"),
      ).resolves.toContain("sha256:");
    });

    it("keeps the previous ready runtime when a staged upgrade fails", async () => {
      const fixture = await createBrowserActBundleFixture("rollback");
      const runtimeHome = join(fixture.tempRoot, "runtime");
      const legacyTool = join(runtimeHome, "venv", "bin", "browser-act");
      await mkdir(join(runtimeHome, "venv", "bin"), { recursive: true });
      await writeFile(
        legacyTool,
        "#!/bin/sh\necho previous-browser-act:$*\n",
        "utf8",
      );
      await chmod(legacyTool, 0o755);
      await writeFile(join(runtimeHome, "runtime-revision"), "sha256:old\n");
      const uvPath = join(fixture.outDir, "oysterworkflow-uv");
      await writeFile(
        uvPath,
        `#!/bin/sh
set -eu
mkdir -p "$UV_PROJECT_ENVIRONMENT/bin"
printf '#!/bin/sh\necho partial-browser-act\n' > "$UV_PROJECT_ENVIRONMENT/bin/browser-act"
chmod +x "$UV_PROJECT_ENVIRONMENT/bin/browser-act"
exit 42
`,
        "utf8",
      );
      await chmod(uvPath, 0o755);
      const env = browserActTestEnv(fixture.tempRoot, runtimeHome);

      await expect(
        execFileAsync(fixture.launcherPath, ["upgrade"], { env }),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining(
          "the previous ready installation was left unchanged",
        ),
      });
      await expect(
        execFileAsync(legacyTool, ["after-failure"], { env }),
      ).resolves.toMatchObject({
        stdout: expect.stringContaining("previous-browser-act:after-failure"),
      });
      await expect(stat(join(runtimeHome, "install.lock"))).rejects.toThrow();
    });

    it("recovers a stale BrowserAct install lock", async () => {
      const fixture = await createBrowserActBundleFixture("stale-lock");
      const runtimeHome = join(fixture.tempRoot, "runtime");
      const callsPath = join(fixture.tempRoot, "uv-calls.txt");
      await writeSuccessfulUv(fixture.outDir, callsPath, fixture.pinnedVersion);
      const lockPath = join(runtimeHome, "install.lock");
      await mkdir(lockPath, { recursive: true });
      await writeFile(
        join(lockPath, "owner"),
        `99999999\n${Math.floor(Date.now() / 1_000)}\n`,
      );

      const result = await execFileAsync(fixture.launcherPath, ["ready"], {
        env: browserActTestEnv(fixture.tempRoot, runtimeHome, {
          OYSTERWORKFLOW_BROWSERACT_INSTALL_WAIT_SECONDS: "5",
          OYSTERWORKFLOW_BROWSERACT_INSTALL_STALE_SECONDS: "60",
        }),
      });

      expect(result.stdout).toContain("browser-act:ready");
      expect(result.stderr).toContain(
        "Recovering a stale BrowserAct installation lock",
      );
      expect(result.stderr).toContain("BrowserAct 安装锁");
      await expect(stat(lockPath)).rejects.toThrow();
    });

    it("bounds waiting for a live BrowserAct install lock", async () => {
      const fixture = await createBrowserActBundleFixture("lock-timeout");
      const runtimeHome = join(fixture.tempRoot, "runtime");
      const lockPath = join(runtimeHome, "install.lock");
      await mkdir(lockPath, { recursive: true });
      await writeFile(
        join(lockPath, "owner"),
        `${process.pid}\n${Math.floor(Date.now() / 1_000)}\n`,
      );
      const startedAt = Date.now();

      await expect(
        execFileAsync(fixture.launcherPath, ["blocked"], {
          env: browserActTestEnv(fixture.tempRoot, runtimeHome, {
            OYSTERWORKFLOW_BROWSERACT_INSTALL_WAIT_SECONDS: "1",
            OYSTERWORKFLOW_BROWSERACT_INSTALL_STALE_SECONDS: "60",
          }),
        }),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining(
          "Timed out after 1 seconds waiting for another BrowserAct installation",
        ),
      });
      expect(Date.now() - startedAt).toBeLessThan(5_000);
    });
  },
);

describe.runIf(process.platform === "win32")(
  "BrowserAct Windows bundle builder",
  () => {
    it("generates a PowerShell launcher that requires the bundled uv sidecar", async () => {
      const tempRoot = await mkdtemp(
        join(tmpdir(), "oyster-browseract-windows-"),
      );
      tempRoots.push(tempRoot);
      const outDir = join(tempRoot, "bundle");
      await execFileAsync(
        process.execPath,
        [resolve("scripts/build-browseract-bundle.mjs")],
        {
          env: {
            ...process.env,
            OYSTERWORKFLOW_BROWSERACT_BUNDLE_OUT_DIR: outDir,
          },
        },
      );

      const manifest = JSON.parse(
        await readFile(join(outDir, "browseract-bundle.json"), "utf8"),
      ) as { executableName: string };
      const launcherPath = join(outDir, "browser-act.ps1");
      const launcher = await readFile(launcherPath, "utf8");
      expect(manifest.executableName).toBe("browser-act.ps1");
      expect(launcher).toContain("oysterworkflow-uv.exe");
      expect(launcher).toContain("--oyster-managed-status");
      await expect(
        execFileAsync(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            launcherPath,
            "--oyster-managed-status",
          ],
          {
            env: {
              ...process.env,
              OYSTERWORKFLOW_BROWSERACT_HOME: join(tempRoot, "runtime"),
            },
          },
        ),
      ).rejects.toMatchObject({
        code: 3,
        stderr: expect.stringContaining(
          "BrowserAct managed runtime is not installed",
        ),
      });
    });
  },
);

async function createBrowserActBundleFixture(label: string) {
  const tempRoot = await mkdtemp(join(tmpdir(), `oyster-browseract-${label}-`));
  tempRoots.push(tempRoot);
  const outDir = join(tempRoot, "bundle");
  await execFileAsync(
    process.execPath,
    [resolve("scripts/build-browseract-bundle.mjs")],
    {
      env: {
        ...process.env,
        OYSTERWORKFLOW_BROWSERACT_BUNDLE_OUT_DIR: outDir,
      },
    },
  );
  const manifest = JSON.parse(
    await readFile(join(outDir, "browseract-bundle.json"), "utf8"),
  ) as { pinnedVersion: string };
  return {
    tempRoot,
    outDir,
    launcherPath: join(outDir, "browser-act"),
    pinnedVersion: manifest.pinnedVersion,
  };
}

async function writeSuccessfulUv(
  outDir: string,
  callsPath: string,
  pinnedVersion: string,
  sleepSeconds = 0,
): Promise<void> {
  const uvPath = join(outDir, "oysterworkflow-uv");
  await writeFile(
    uvPath,
    `#!/bin/sh
set -eu
echo "$*" >> "${callsPath}"
${sleepSeconds > 0 ? `sleep ${sleepSeconds}` : ""}
mkdir -p "$UV_PROJECT_ENVIRONMENT/bin"
cat > "$UV_PROJECT_ENVIRONMENT/bin/browser-act" <<'RUNNER'
#!/bin/sh
if [ "\${1:-}" = "--version" ]; then
  echo "browser-act-cli ${pinnedVersion}"
else
  echo "browser-act:$*"
fi
RUNNER
chmod +x "$UV_PROJECT_ENVIRONMENT/bin/browser-act"
`,
    "utf8",
  );
  await chmod(uvPath, 0o755);
}

function browserActTestEnv(
  tempRoot: string,
  runtimeHome: string,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    HOME: join(tempRoot, "home"),
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    OYSTERWORKFLOW_BROWSERACT_HOME: runtimeHome,
    ...extra,
  };
}
