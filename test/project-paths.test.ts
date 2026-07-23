import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getDefaultLlmConfigPath,
  getLocalLlmConfigPath,
  getDefaultPromptsetDir,
  getPreferredLlmConfigPath,
  getDefaultUserSkillConfigPath,
  getProjectRootDir,
} from "../src/io/project-paths.js";
import { getLabLlmConfigPath } from "../src/lab-api/llm-config.js";

describe("project path resolution", () => {
  const originalCwd = process.cwd();
  let tempRoot = "";

  afterEach(async () => {
    process.chdir(originalCwd);
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
      tempRoot = "";
    }
  });

  it("keeps default config paths anchored to the repository root", async () => {
    const expectedProjectRoot = getProjectRootDir();
    const expectedBundledLlmConfigPath = getDefaultLlmConfigPath();
    const expectedLocalLlmConfigPath = getLocalLlmConfigPath();
    const expectedPreferredLlmConfigPath = existsSync(
      expectedLocalLlmConfigPath,
    )
      ? expectedLocalLlmConfigPath
      : expectedBundledLlmConfigPath;
    const expectedUserSkillConfigPath = getDefaultUserSkillConfigPath();
    const expectedPromptsetDir = getDefaultPromptsetDir();

    tempRoot = await mkdtemp(path.join(os.tmpdir(), "oysterworkflow-paths-"));
    process.chdir(tempRoot);

    expect(getProjectRootDir()).toBe(expectedProjectRoot);
    expect(getDefaultLlmConfigPath()).toBe(expectedBundledLlmConfigPath);
    expect(getLocalLlmConfigPath()).toBe(expectedLocalLlmConfigPath);
    expect(getPreferredLlmConfigPath()).toBe(expectedPreferredLlmConfigPath);
    expect(getLabLlmConfigPath()).toBe(expectedLocalLlmConfigPath);
    expect(getDefaultUserSkillConfigPath()).toBe(expectedUserSkillConfigPath);
    expect(getDefaultPromptsetDir()).toBe(expectedPromptsetDir);
    expect(
      expectedBundledLlmConfigPath.endsWith(
        path.join("config", "llm.config.json"),
      ),
    ).toBe(true);
    expect(
      expectedLocalLlmConfigPath.endsWith(
        path.join("config", "llm.local.json"),
      ),
    ).toBe(true);
    expect(
      expectedUserSkillConfigPath.endsWith(
        path.join("config", "user-skill.config.json"),
      ),
    ).toBe(true);
    expect(
      expectedPromptsetDir.endsWith(path.join("config", "promptsets")),
    ).toBe(true);
  });

  it("keeps the derived config paths internally consistent", () => {
    const projectRoot = getProjectRootDir();

    expect(getDefaultLlmConfigPath()).toBe(
      path.join(projectRoot, "config", "llm.config.json"),
    );
    expect(getLocalLlmConfigPath()).toBe(
      path.join(projectRoot, "config", "llm.local.json"),
    );
    expect(getDefaultUserSkillConfigPath()).toBe(
      path.join(projectRoot, "config", "user-skill.config.json"),
    );
    expect(getDefaultPromptsetDir()).toBe(
      path.join(projectRoot, "config", "promptsets"),
    );
  });
});
