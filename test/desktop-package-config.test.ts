import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = join(import.meta.dirname, "..");

describe("desktop packaging config", () => {
  it("builds and packages the managed Hermes launcher beside Screenpipe", async () => {
    const packageJson = JSON.parse(
      await readFile(join(projectRoot, "package.json"), "utf8"),
    ) as {
      scripts: Record<string, string>;
      build: {
        mac: { extraFiles: Array<{ from: string; to: string }> };
        win: { extraFiles: Array<{ from: string; to: string }> };
      };
    };

    expect(packageJson.scripts["build:hermes"]).toBe(
      "node scripts/build-hermes-bundle.mjs",
    );
    expect(packageJson.scripts["build:browseract"]).toBe(
      "node scripts/build-browseract-bundle.mjs",
    );
    expect(packageJson.scripts["build:runtime-tools"]).toBe(
      "node scripts/build-runtime-tools-bundle.mjs",
    );
    expect(packageJson.scripts["build:desktop"]).toContain(
      "npm run build:hermes",
    );
    expect(packageJson.scripts["build:desktop"]).toContain(
      "npm run build:browseract",
    );
    expect(packageJson.scripts["build:desktop"]).toContain(
      "npm run build:runtime-tools",
    );
    expect(packageJson.build.mac.extraFiles).toEqual(
      expect.arrayContaining([
        {
          from: "out/bundled/hermes/hermes",
          to: "Resources/bin/oysterworkflow-hermes",
        },
        {
          from: "out/bundled/hermes/hermes-bundle.json",
          to: "Resources/bin/hermes-bundle.json",
        },
        {
          from: "out/bundled/hermes/hermes-agent-source",
          to: "Resources/bin/hermes-agent-source",
        },
        {
          from: "out/bundled/browseract/browser-act",
          to: "Resources/bin/oysterworkflow-browseract",
        },
        {
          from: "out/bundled/browseract/browseract-bundle.json",
          to: "Resources/bin/browseract-bundle.json",
        },
        {
          from: "out/bundled/hermes/oysterworkflow-uv",
          to: "Resources/bin/oysterworkflow-uv",
        },
        {
          from: "out/bundled/hermes/node",
          to: "Resources/bin/node",
        },
        {
          from: "out/bundled/runtime-tools/runtime-tools-bundle.json",
          to: "Resources/bin/runtime-tools-bundle.json",
        },
      ]),
    );
    expect(packageJson.build.win.extraFiles).toEqual(
      expect.arrayContaining([
        {
          from: "out/bundled/hermes/hermes.ps1",
          to: "resources/bin/oysterworkflow-hermes.ps1",
        },
        {
          from: "out/bundled/hermes/hermes-bundle.json",
          to: "resources/bin/hermes-bundle.json",
        },
        {
          from: "out/bundled/hermes/hermes-agent-source",
          to: "resources/bin/hermes-agent-source",
        },
        {
          from: "out/bundled/browseract/browser-act.ps1",
          to: "resources/bin/oysterworkflow-browseract.ps1",
        },
        {
          from: "out/bundled/browseract/browseract-bundle.json",
          to: "resources/bin/browseract-bundle.json",
        },
        {
          from: "out/bundled/runtime-tools/oysterworkflow-uv.exe",
          to: "resources/bin/oysterworkflow-uv.exe",
        },
        {
          from: "out/bundled/runtime-tools/runtime-tools-bundle.json",
          to: "resources/bin/runtime-tools-bundle.json",
        },
      ]),
    );
  });

  it("publishes signed desktop artifacts required by the in-app updater", async () => {
    const packageJson = JSON.parse(
      await readFile(join(projectRoot, "package.json"), "utf8"),
    ) as {
      dependencies: Record<string, string>;
      scripts: Record<string, string>;
      build: {
        publish: Array<Record<string, string>>;
        mac: { target: string[]; electronUpdaterCompatibility: string };
        win: { target: string[] };
      };
    };

    expect(packageJson.dependencies["electron-updater"]).toMatch(/^\^6\./u);
    expect(packageJson.scripts["dist:mac"]).toBe(
      "npm run build:desktop && electron-builder --mac",
    );
    expect(packageJson.scripts["release:win"]).toBe(
      "npm run build:desktop && electron-builder --win nsis --publish always",
    );
    expect(packageJson.build.publish).toContainEqual({
      provider: "github",
      owner: "ShuxinYang111",
      repo: "oysterworkflow",
    });
    expect(packageJson.build.mac.target).toEqual(["dmg", "zip"]);
    expect(packageJson.build.mac.electronUpdaterCompatibility).toBe(">=2.16");
    expect(packageJson.build.win.target).toEqual(["nsis"]);
  });

  it("keeps the packaged desktop app single-instance to protect local runtime state", async () => {
    const desktopMain = await readFile(
      join(projectRoot, "desktop", "main.ts"),
      "utf8",
    );

    expect(desktopMain).toContain("app.requestSingleInstanceLock()");
    expect(desktopMain).toContain('app.on("second-instance"');
    expect(desktopMain).toContain('createOrShowMainWindow("second-instance")');
  });

  it("keeps the Runtime launch secret in Electron main and validates every privileged IPC sender", async () => {
    const desktopMain = await readFile(
      join(projectRoot, "desktop", "main.ts"),
      "utf8",
    );
    const preload = await readFile(
      join(projectRoot, "desktop", "preload.cts"),
      "utf8",
    );
    const handlerCount =
      desktopMain.match(/ipcMain\.(?:handle|on)\(/gu)?.length ?? 0;
    const senderCheckCount =
      desktopMain.match(/assertTrustedIpcSender\(event, mainWindow\)/gu)
        ?.length ?? 0;

    expect(desktopMain).toContain('randomBytes(32).toString("base64url")');
    expect(desktopMain).toContain("RUNTIME_API_SECRET_ENV_NAME");
    expect(senderCheckCount).toBe(handlerCount);
    expect(desktopMain).toContain('webContents.on("will-navigate"');
    expect(desktopMain).toContain("setWindowOpenHandler");
    expect(preload).not.toContain("runtimeApiSecret");
    expect(preload).not.toContain("oysterworkflow-runtime-secret");
  });

  it("does not restore Keychain-backed auth until the desktop window is ready", async () => {
    const desktopMain = await readFile(
      join(projectRoot, "desktop", "main.ts"),
      "utf8",
    );
    const runtimeWindowIndex = desktopMain.indexOf(
      'await createOrShowMainWindow("runtime-ready")',
    );
    const backgroundAuthIndex = desktopMain.indexOf(
      "void initializeDesktopAuth();",
    );
    const authConstructorIndex = desktopMain.indexOf(
      "authService = new SupabaseDesktopAuthService",
    );

    expect(runtimeWindowIndex).toBeGreaterThan(-1);
    expect(backgroundAuthIndex).toBeGreaterThan(-1);
    expect(backgroundAuthIndex).toBeGreaterThan(runtimeWindowIndex);
    expect(authConstructorIndex).toBeGreaterThan(runtimeWindowIndex);
    expect(desktopMain).not.toContain("await authService.initialize();");
  });

  it("opens the OAuth callback gate even when the first auth restore attempt fails", async () => {
    const desktopMain = await readFile(
      join(projectRoot, "desktop", "main.ts"),
      "utf8",
    );
    const initializeStart = desktopMain.indexOf(
      "async function initializeDesktopAuth()",
    );
    const nextFunction = desktopMain.indexOf(
      "async function requestBundledRecorderPermission",
      initializeStart,
    );
    const initializeBody = desktopMain.slice(initializeStart, nextFunction);

    expect(initializeBody).toContain("finally {");
    expect(initializeBody).toContain("await authCallbackQueue.markReady();");
  });

  it("serializes window navigation across activate and restart events", async () => {
    const desktopMain = await readFile(
      join(projectRoot, "desktop", "main.ts"),
      "utf8",
    );

    expect(desktopMain).toContain("mainWindowOperationQueue.then(() =>");
    expect(desktopMain).toContain("performCreateOrShowMainWindow(reason)");
    expect(desktopMain).toContain(
      "deferred activate until desktop window context is ready",
    );
  });

  it("does not transform the macOS process type when focusing the main window", async () => {
    const desktopMain = await readFile(
      join(projectRoot, "desktop", "main.ts"),
      "utf8",
    );

    expect(desktopMain).not.toContain("setVisibleOnAllWorkspaces");
  });

  it("signs every packaged macOS Mach-O sidecar before sealing the app bundle", async () => {
    const afterSign = await readFile(
      join(projectRoot, "scripts", "after-sign-macos.mjs"),
      "utf8",
    );

    expect(afterSign).toContain("findMachOSidecars");
    expect(afterSign).toContain('details.includes("Mach-O")');
    expect(afterSign).toContain("oysterworkflow-screenpipe");
    expect(afterSign).toContain("for (const sidecarPath of machOSidecars)");
  });

  it("does not reuse previously bundled ffmpeg tools as fresh Screenpipe bundle input", async () => {
    const screenpipeBundleBuilder = await readFile(
      join(projectRoot, "scripts", "build-screenpipe-bundle.mjs"),
      "utf8",
    );

    expect(screenpipeBundleBuilder).not.toContain(
      "path.resolve(outDir, ffmpegExecutableName),",
    );
    expect(screenpipeBundleBuilder).not.toContain(
      "path.resolve(outDir, ffprobeExecutableName),",
    );
    expect(screenpipeBundleBuilder).not.toContain(
      "path.resolve(distAppBinDir, ffmpegExecutableName),",
    );
    expect(screenpipeBundleBuilder).not.toContain(
      "path.resolve(distAppBinDir, ffprobeExecutableName),",
    );
  });

  it("prefers redistributable ffmpeg packages before Homebrew dynamic tools", async () => {
    const screenpipeBundleBuilder = await readFile(
      join(projectRoot, "scripts", "build-screenpipe-bundle.mjs"),
      "utf8",
    );

    const ffmpegStaticIndex = screenpipeBundleBuilder.indexOf(
      'resolveOptionalPackageBinary("ffmpeg-static")',
    );
    const ffmpegHomebrewIndex = screenpipeBundleBuilder.indexOf(
      '"/opt/homebrew/bin/ffmpeg"',
    );
    const ffprobeStaticIndex = screenpipeBundleBuilder.indexOf(
      'resolveOptionalPackageBinary("ffprobe-static")',
    );
    const ffprobeHomebrewIndex = screenpipeBundleBuilder.indexOf(
      '"/opt/homebrew/bin/ffprobe"',
    );

    expect(ffmpegStaticIndex).toBeGreaterThan(-1);
    expect(ffmpegHomebrewIndex).toBeGreaterThan(-1);
    expect(ffmpegStaticIndex).toBeLessThan(ffmpegHomebrewIndex);
    expect(ffprobeStaticIndex).toBeGreaterThan(-1);
    expect(ffprobeHomebrewIndex).toBeGreaterThan(-1);
    expect(ffprobeStaticIndex).toBeLessThan(ffprobeHomebrewIndex);
  });
});
