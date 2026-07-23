import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listInstalledSkills,
  listSkillManagerPathCandidates,
  readSkillManagerConfig,
  uninstallInstalledSkill,
  writeSkillManagerConfig,
} from "../src/lab-api/skill-manager.js";

describe("skill manager", () => {
  let tempRoot = "";

  afterEach(async () => {
    vi.restoreAllMocks();
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("returns an empty config when the file does not exist and persists normalized directories", async () => {
    tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-skill-manager-"),
    );
    const configPath = path.join(
      tempRoot,
      "config",
      "skill-manager.config.json",
    );
    const skillRoot = path.join(tempRoot, "skills", "personal");

    await expect(readSkillManagerConfig(configPath)).resolves.toEqual({
      skillPath: null,
      updatedAt: null,
    });

    const saved = await writeSkillManagerConfig(
      {
        skillPath: skillRoot,
        now: new Date("2026-04-16T18:00:00.000Z"),
      },
      configPath,
    );

    expect(saved.skillPath).toBe(skillRoot);
    expect(saved.updatedAt).toBe("2026-04-16T18:00:00.000Z");
    await expect(access(skillRoot)).resolves.toBeUndefined();
    await expect(readSkillManagerConfig(configPath)).resolves.toEqual(saved);
  });

  it("rejects relative save paths and reports installed agent homes before skills directories exist", async () => {
    tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-skill-manager-"),
    );
    const fakeHome = path.join(tempRoot, "home");
    await mkdir(path.join(fakeHome, ".openclaw"), { recursive: true });
    await writeFile(
      path.join(fakeHome, ".openclaw", "openclaw.json"),
      "{}\n",
      "utf8",
    );
    await mkdir(path.join(fakeHome, ".agents", "skills"), { recursive: true });
    await mkdir(path.join(fakeHome, ".workbuddy"), { recursive: true });
    await mkdir(path.join(fakeHome, ".codebuddy"), { recursive: true });
    await mkdir(path.join(fakeHome, ".qwen"), { recursive: true });
    await mkdir(path.join(fakeHome, ".qoder"), { recursive: true });
    await mkdir(path.join(fakeHome, ".qoderwork"), { recursive: true });
    await mkdir(path.join(fakeHome, ".lingma"), { recursive: true });
    await mkdir(path.join(fakeHome, ".comate"), { recursive: true });
    await mkdir(path.join(fakeHome, ".codeartsdoer"), { recursive: true });
    await mkdir(path.join(fakeHome, ".iflow"), { recursive: true });
    await mkdir(path.join(fakeHome, ".trae", "skills"), { recursive: true });
    await mkdir(path.join(fakeHome, ".trae-cn", "skills"), { recursive: true });
    await mkdir(path.join(fakeHome, ".codex", "skills"), { recursive: true });
    await mkdir(path.join(fakeHome, ".hermes", "skills"), { recursive: true });
    vi.spyOn(os, "homedir").mockReturnValue(fakeHome);

    await expect(
      writeSkillManagerConfig(
        {
          skillPath: "./relative",
        },
        path.join(tempRoot, "config.json"),
      ),
    ).rejects.toThrow(/absolute path or start with ~\//);

    await expect(listSkillManagerPathCandidates()).resolves.toEqual([
      {
        id: "openclaw-default",
        label: "OpenClaw (.openclaw/skills)",
        agentFamily: "openclaw",
        path: path.join(fakeHome, ".openclaw", "skills"),
        exists: false,
      },
      {
        id: "openclaw-personal",
        label: "OpenClaw (.agents/skills)",
        agentFamily: "openclaw",
        path: path.join(fakeHome, ".agents", "skills"),
        exists: true,
      },
      {
        id: "workbuddy-default",
        label: "WorkBuddy (.workbuddy/skills)",
        agentFamily: "workbuddy",
        path: path.join(fakeHome, ".workbuddy", "skills"),
        exists: false,
      },
      {
        id: "codebuddy-default",
        label: "CodeBuddy (.codebuddy/skills)",
        agentFamily: "codebuddy",
        path: path.join(fakeHome, ".codebuddy", "skills"),
        exists: false,
      },
      {
        id: "qwen-default",
        label: "Qwen Code (.qwen/skills)",
        agentFamily: "qwen",
        path: path.join(fakeHome, ".qwen", "skills"),
        exists: false,
      },
      {
        id: "qoder-default",
        label: "Qoder CLI (.qoder/skills)",
        agentFamily: "qoder",
        path: path.join(fakeHome, ".qoder", "skills"),
        exists: false,
      },
      {
        id: "qoderwork-default",
        label: "QoderWork (.qoderwork/skills)",
        agentFamily: "qoderwork",
        path: path.join(fakeHome, ".qoderwork", "skills"),
        exists: false,
      },
      {
        id: "lingma-default",
        label: "Lingma (.lingma/skills)",
        agentFamily: "lingma",
        path: path.join(fakeHome, ".lingma", "skills"),
        exists: false,
      },
      {
        id: "comate-default",
        label: "Baidu Comate (.comate/skills)",
        agentFamily: "comate",
        path: path.join(fakeHome, ".comate", "skills"),
        exists: false,
      },
      {
        id: "codeartsdoer-default",
        label: "CodeArts Doer (.codeartsdoer/skills)",
        agentFamily: "codeartsdoer",
        path: path.join(fakeHome, ".codeartsdoer", "skills"),
        exists: false,
      },
      {
        id: "iflow-default",
        label: "iFlow (.iflow/skills)",
        agentFamily: "iflow",
        path: path.join(fakeHome, ".iflow", "skills"),
        exists: false,
      },
      {
        id: "trae-default",
        label: "Trae (.trae/skills)",
        agentFamily: "trae",
        path: path.join(fakeHome, ".trae", "skills"),
        exists: true,
      },
      {
        id: "trae-cn-default",
        label: "Trae CN (.trae-cn/skills)",
        agentFamily: "trae",
        path: path.join(fakeHome, ".trae-cn", "skills"),
        exists: true,
      },
      {
        id: "codex-default",
        label: "Codex (.codex/skills)",
        agentFamily: "codex",
        path: path.join(fakeHome, ".codex", "skills"),
        exists: true,
      },
      {
        id: "hermes-default",
        label: "Hermes Agent (.hermes/skills)",
        agentFamily: "hermes",
        path: path.join(fakeHome, ".hermes", "skills"),
        exists: true,
      },
    ]);
  });

  it("lists installed skills from direct child directories and uninstalls managed/manual entries safely", async () => {
    tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-skill-manager-"),
    );
    const skillRoot = path.join(tempRoot, "skills");

    await createInstalledSkill({
      skillRoot,
      installName: "generated-claim-check",
      description: "Generated managed skill",
      withMarker: true,
    });
    const manualDir = await createInstalledSkill({
      skillRoot,
      installName: "claim-helper",
      description: "Manual helper skill",
    });
    await mkdir(path.join(skillRoot, "empty-dir"), { recursive: true });

    const skills = await listInstalledSkills({
      skillPath: skillRoot,
    });

    expect(skills.map((skill) => skill.name)).toEqual([
      "generated-claim-check",
      "claim-helper",
    ]);
    expect(skills[0]?.sourceType).toBe("generated-managed");
    expect(skills[1]?.sourceType).toBe("manual-personal");

    const removedManaged = await uninstallInstalledSkill({
      installRoot: skillRoot,
      installName: "generated-claim-check",
    });
    expect(removedManaged.sourceType).toBe("generated-managed");

    await expect(
      uninstallInstalledSkill({
        installRoot: skillRoot,
        installName: "claim-helper",
      }),
    ).rejects.toThrow(/requires confirmName/);

    const removedManual = await uninstallInstalledSkill({
      installRoot: skillRoot,
      installName: "claim-helper",
      confirmName: "claim-helper",
    });
    expect(removedManual.sourceType).toBe("manual-personal");
    await expect(access(manualDir)).rejects.toThrow();
  });
});

async function createInstalledSkill(input: {
  skillRoot: string;
  installName: string;
  description: string;
  withMarker?: boolean;
}): Promise<string> {
  const installDir = path.join(input.skillRoot, input.installName);
  await mkdir(installDir, { recursive: true });
  await writeFile(
    path.join(installDir, "SKILL.md"),
    `---\nname: "${input.installName}"\ndescription: "${input.description}"\n---\n\n# ${input.installName}\n`,
    "utf8",
  );

  if (input.withMarker) {
    await writeFile(
      path.join(installDir, ".oysterworkflow-export.json"),
      `${JSON.stringify(
        {
          schemaVersion: "oysterworkflow-openclaw-export-v1",
          installName: input.installName,
          installDir,
          generatedAt: "2026-04-16T18:00:00.000Z",
          sourceSkillPath: `/tmp/${input.installName}/skill.json`,
          sourceSummaryPath: `/tmp/${input.installName}/summary.json`,
          originalSkillName: input.installName,
          skillId: `${input.installName}-id`,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }

  return installDir;
}
