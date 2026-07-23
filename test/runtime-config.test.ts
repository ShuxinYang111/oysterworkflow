import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  RUNTIME_API_PORT_ENV_NAME,
  RUNTIME_API_SECRET_ENV_NAME,
  parseRuntimeCliArgs,
  resolveRuntimeApiPort,
  resolveRuntimeConfig,
  toRuntimeBridgeInfo,
} from "../src/runtime/config.js";

describe("runtime config resolution", () => {
  it("keeps dev mode rooted in the current workspace", () => {
    const cwd = path.resolve("/tmp/oysterworkflow-dev");
    const config = resolveRuntimeConfig({
      mode: "dev",
      cwd,
      projectRootDir: "/repo/oysterworkflow",
    });

    expect(config.runsRoot).toBe(path.join(cwd, ".runs"));
    expect(
      config.llmConfigPath.endsWith(path.join("config", "llm.local.json")),
    ).toBe(true);
    expect(config.skillManagerConfigPath).toBe(
      path.join(cwd, ".runs", "config", "skill-manager.config.json"),
    );
    expect(config.screenpipeBaseUrl).toBe("http://127.0.0.1:3030");
    expect(config.productSeedMode).toBe("empty");
  });

  it("moves desktop mode data into macOS application support", () => {
    const config = resolveRuntimeConfig({
      mode: "desktop",
      platform: "darwin",
      cwd: "/repo/oysterworkflow",
      projectRootDir: "/repo/oysterworkflow",
    });
    const expectedAppSupportDir = path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "oysterworkflow",
    );

    expect(config.runsRoot).toBe(path.join(expectedAppSupportDir, "runs"));
    expect(config.llmConfigPath).toBe(
      path.join(expectedAppSupportDir, "config", "llm.config.json"),
    );
    expect(config.skillManagerConfigPath).toBe(
      path.join(expectedAppSupportDir, "config", "skill-manager.config.json"),
    );
    expect(config.hermesRuntimeRoot).toBe(
      path.join(os.homedir(), "Library", "oysterworkflow", "hermes"),
    );
    expect(config.hermesRuntimeRoot).not.toContain("Application Support");
    expect(config.hermesRuntimeRoot).not.toContain(" ");
    expect(config.hermesProfilesRoot).toBe(
      path.join(
        os.homedir(),
        "Library",
        "oysterworkflow",
        "hermes",
        "profiles",
      ),
    );
    expect(config.hermesSkillsRoot).toBe(
      path.join(os.homedir(), "Library", "oysterworkflow", "hermes", "skills"),
    );
    expect(config.browserActCommandPath).toBe(
      path.join(
        "/repo/oysterworkflow",
        "out",
        "bundled",
        "browseract",
        "browser-act",
      ),
    );
    expect(config.apiSecret).toBeNull();
  });

  it("loads a desktop launch secret without exposing it through the renderer bridge", () => {
    const previousSecret = process.env[RUNTIME_API_SECRET_ENV_NAME];
    process.env[RUNTIME_API_SECRET_ENV_NAME] =
      "desktop-secret-from-private-process-env";
    try {
      const config = resolveRuntimeConfig({
        mode: "desktop",
        apiPort: 43210,
        projectRootDir: "/repo/oysterworkflow",
      });
      expect(config.apiSecret).toBe("desktop-secret-from-private-process-env");
      expect(toRuntimeBridgeInfo(config)).toEqual({
        apiBaseUrl: "http://127.0.0.1:43210",
        platform: process.platform,
        mode: "desktop",
      });
      expect(toRuntimeBridgeInfo(config)).not.toHaveProperty("apiSecret");
    } finally {
      if (previousSecret === undefined) {
        delete process.env[RUNTIME_API_SECRET_ENV_NAME];
      } else {
        process.env[RUNTIME_API_SECRET_ENV_NAME] = previousSecret;
      }
    }
  });

  it("parses an explicit Runtime secret and rejects weak values", () => {
    expect(
      parseRuntimeCliArgs([
        "--mode",
        "desktop",
        "--api-secret",
        "desktop-secret-with-enough-length",
      ]),
    ).toMatchObject({
      mode: "desktop",
      apiSecret: "desktop-secret-with-enough-length",
    });
    expect(() => parseRuntimeCliArgs(["--api-secret", "short"])).toThrow();
  });

  it("moves desktop mode data into Windows app data", () => {
    const config = resolveRuntimeConfig({
      mode: "desktop",
      platform: "win32",
      cwd: "C:\\repo\\oysterworkflow",
      projectRootDir: "C:\\repo\\oysterworkflow",
    });
    const expectedAppDataDir = path.resolve(
      process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"),
      "oysterworkflow",
    );

    expect(config.runsRoot).toBe(path.join(expectedAppDataDir, "runs"));
    expect(config.llmConfigPath).toBe(
      path.join(expectedAppDataDir, "config", "llm.config.json"),
    );
    expect(config.skillManagerConfigPath).toBe(
      path.join(expectedAppDataDir, "config", "skill-manager.config.json"),
    );
    expect(config.screenpipeBinaryPath.endsWith("screenpipe.exe")).toBe(true);
    expect(config.browserActCommandPath?.endsWith("browser-act.cmd")).toBe(
      true,
    );
  });

  it("uses a dedicated temp root for test mode", () => {
    const config = resolveRuntimeConfig({
      mode: "test",
      cwd: "/repo/oysterworkflow",
      projectRootDir: "/repo/oysterworkflow",
    });

    expect(config.runsRoot).toBe(
      path.join(os.tmpdir(), "oysterworkflow-test", "runs"),
    );
    expect(config.skillManagerConfigPath).toBe(
      path.join(
        os.tmpdir(),
        "oysterworkflow-test",
        "config",
        "skill-manager.config.json",
      ),
    );
    expect(config.productSeedMode).toBe("empty");
  });

  it("uses demo fixtures only when explicitly requested", () => {
    const config = resolveRuntimeConfig({
      mode: "test",
      productSeedMode: "demo",
      cwd: "/repo/oysterworkflow",
      projectRootDir: "/repo/oysterworkflow",
    });

    expect(config.productSeedMode).toBe("demo");
  });

  it("reads the shared dev runtime api port from the environment when no explicit port is passed", () => {
    const previousApiPort = process.env[RUNTIME_API_PORT_ENV_NAME];
    process.env[RUNTIME_API_PORT_ENV_NAME] = "43123";

    try {
      expect(
        resolveRuntimeApiPort({
          env: {
            [RUNTIME_API_PORT_ENV_NAME]: "43123",
          },
        }),
      ).toBe(43123);

      const config = resolveRuntimeConfig({
        mode: "dev",
        cwd: "/tmp/oysterworkflow-dev",
        projectRootDir: "/repo/oysterworkflow",
      });

      expect(config.apiPort).toBe(43123);
    } finally {
      if (previousApiPort === undefined) {
        delete process.env[RUNTIME_API_PORT_ENV_NAME];
      } else {
        process.env[RUNTIME_API_PORT_ENV_NAME] = previousApiPort;
      }
    }
  });

  it("prefers an explicit runtime api port over the shared dev environment value", () => {
    expect(
      resolveRuntimeApiPort({
        apiPort: 0,
        env: {
          [RUNTIME_API_PORT_ENV_NAME]: "43123",
        },
      }),
    ).toBe(0);
  });

  it("ignores legacy runtime api env vars and only uses the OysterWorkflow name", () => {
    expect(
      resolveRuntimeApiPort({
        env: {
          TRACE2OPENCLAW_API_PORT: "43124",
        },
      }),
    ).toBe(3034);
  });
});
