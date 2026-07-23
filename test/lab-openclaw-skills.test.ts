import { access, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawCommandRunner } from "../src/cli/commands/openclaw-skill.js";
import {
  listLabOpenClawPersonalSkills,
  uninstallLabOpenClawPersonalSkill,
} from "../src/lab-api/openclaw-skills.js";

describe("lab openclaw skills", () => {
  let tempRoot = "";

  afterEach(async () => {
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("lists personal skills and classifies generated managed/unmanaged/manual entries", async () => {
    tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-openclaw-lab-"),
    );
    const installRoot = path.join(tempRoot, "skills");

    await createPersonalSkill({
      installRoot,
      name: "generated-claim-check",
      description: "Generated managed skill",
      withMarker: true,
    });
    await createPersonalSkill({
      installRoot,
      name: "generated-scratchpad",
      description: "Generated unmanaged skill",
    });
    await createPersonalSkill({
      installRoot,
      name: "imessage",
      description: "Manual personal skill",
    });
    await mkdir(path.join(installRoot, "not-a-skill"), { recursive: true });

    const skills = await listLabOpenClawPersonalSkills({
      installRoot,
      commandRunner: createMockRunner({
        "generated-claim-check": {
          name: "generated-claim-check",
          description: "Generated managed skill",
          baseDir: path.join(installRoot, "generated-claim-check"),
          filePath: path.join(installRoot, "generated-claim-check", "SKILL.md"),
          eligible: true,
          disabled: false,
        },
        "generated-scratchpad": {
          name: "generated-scratchpad",
          description: "Generated unmanaged skill",
          baseDir: path.join(installRoot, "generated-scratchpad"),
          filePath: path.join(installRoot, "generated-scratchpad", "SKILL.md"),
          eligible: false,
          disabled: false,
          missing: {
            bins: ["foo"],
            anyBins: [],
            env: [],
            config: [],
            os: [],
          },
        },
        imessage: {
          name: "imessage",
          description: "Manual personal skill",
          baseDir: path.join(installRoot, "imessage"),
          filePath: path.join(installRoot, "imessage", "SKILL.md"),
          eligible: true,
          disabled: false,
        },
      }),
    });

    expect(skills).toHaveLength(3);
    expect(skills.map((skill) => skill.name)).toEqual([
      "generated-claim-check",
      "generated-scratchpad",
      "imessage",
    ]);
    expect(skills[0]?.sourceType).toBe("generated-managed");
    expect(skills[0]?.marker?.installName).toBe("generated-claim-check");
    expect(skills[1]?.sourceType).toBe("generated-unmanaged");
    expect(skills[1]?.missing.bins).toEqual(["foo"]);
    expect(skills[2]?.sourceType).toBe("manual-personal");
  });

  it("requires confirmName for manual personal skill uninstall", async () => {
    tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-openclaw-lab-"),
    );
    const installRoot = path.join(tempRoot, "skills");
    const installDir = await createPersonalSkill({
      installRoot,
      name: "imessage",
      description: "Manual personal skill",
    });

    await expect(
      uninstallLabOpenClawPersonalSkill({
        installName: "imessage",
        installRoot,
        commandRunner: createMockRunner({
          imessage: {
            name: "imessage",
            description: "Manual personal skill",
            baseDir: installDir,
            filePath: path.join(installDir, "SKILL.md"),
            eligible: true,
            disabled: false,
          },
        }),
      }),
    ).rejects.toThrow(/requires confirmName/);

    const result = await uninstallLabOpenClawPersonalSkill({
      installName: "imessage",
      confirmName: "imessage",
      installRoot,
      commandRunner: createMockRunner({
        imessage: {
          name: "imessage",
          description: "Manual personal skill",
          baseDir: installDir,
          filePath: path.join(installDir, "SKILL.md"),
          eligible: true,
          disabled: false,
        },
      }),
    });

    expect(result.sourceType).toBe("manual-personal");
    await expect(access(installDir)).rejects.toThrow();
  });

  it("allows uninstalling generated skills without confirmName", async () => {
    tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-openclaw-lab-"),
    );
    const installRoot = path.join(tempRoot, "skills");
    const managedDir = await createPersonalSkill({
      installRoot,
      name: "generated-claim-check",
      description: "Generated managed skill",
      withMarker: true,
    });
    const unmanagedDir = await createPersonalSkill({
      installRoot,
      name: "generated-scratchpad",
      description: "Generated unmanaged skill",
    });

    const managedResult = await uninstallLabOpenClawPersonalSkill({
      installName: "generated-claim-check",
      installRoot,
      commandRunner: createMockRunner({
        "generated-claim-check": {
          name: "generated-claim-check",
          description: "Generated managed skill",
          baseDir: managedDir,
          filePath: path.join(managedDir, "SKILL.md"),
          eligible: true,
          disabled: false,
        },
      }),
    });
    const unmanagedResult = await uninstallLabOpenClawPersonalSkill({
      installName: "generated-scratchpad",
      installRoot,
      commandRunner: createMockRunner({
        "generated-scratchpad": {
          name: "generated-scratchpad",
          description: "Generated unmanaged skill",
          baseDir: unmanagedDir,
          filePath: path.join(unmanagedDir, "SKILL.md"),
          eligible: true,
          disabled: false,
        },
      }),
    });

    expect(managedResult.sourceType).toBe("generated-managed");
    expect(unmanagedResult.sourceType).toBe("generated-unmanaged");
    await expect(access(managedDir)).rejects.toThrow();
    await expect(access(unmanagedDir)).rejects.toThrow();
  });

  it("rejects path escape and ignores directories without SKILL.md", async () => {
    tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-openclaw-lab-"),
    );
    const installRoot = path.join(tempRoot, "skills");
    const plainDir = path.join(installRoot, "plain-dir");
    await mkdir(plainDir, { recursive: true });

    const listed = await listLabOpenClawPersonalSkills({
      installRoot,
      commandRunner: createMockRunner({}),
    });
    expect(listed).toEqual([]);

    await expect(
      uninstallLabOpenClawPersonalSkill({
        installName: "../escape",
        installRoot,
        commandRunner: createMockRunner({}),
      }),
    ).rejects.toThrow(/Invalid installName/);

    const plainStats = await lstat(plainDir);
    expect(plainStats.isDirectory()).toBe(true);
  });
});

async function createPersonalSkill(input: {
  installRoot: string;
  name: string;
  description: string;
  withMarker?: boolean;
}): Promise<string> {
  const installDir = path.join(input.installRoot, input.name);
  await mkdir(installDir, { recursive: true });
  await writeFile(
    path.join(installDir, "SKILL.md"),
    `---\nname: "${input.name}"\ndescription: "${input.description}"\n---\n\n# ${input.name}\n`,
    "utf8",
  );

  if (input.withMarker) {
    await writeFile(
      path.join(installDir, ".oysterworkflow-export.json"),
      `${JSON.stringify(
        {
          schemaVersion: "oysterworkflow-openclaw-export-v1",
          installName: input.name,
          installDir,
          generatedAt: "2026-04-02T00:00:00.000Z",
          sourceSkillPath: `/tmp/${input.name}/skill.json`,
          sourceSummaryPath: `/tmp/${input.name}/summary.json`,
          originalSkillName: input.name,
          skillId: `${input.name}-id`,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }

  return installDir;
}

function createMockRunner(
  infoByName: Record<string, Record<string, unknown>>,
): OpenClawCommandRunner {
  return {
    async run(command, args) {
      expect(command).toBe("openclaw");
      expect(args[0]).toBe("skills");
      expect(args[1]).toBe("info");

      const skillName = String(args[2] ?? "");
      const payload = infoByName[skillName];
      if (!payload) {
        return {
          stdout: JSON.stringify({ error: "not found" }),
          stderr: "",
          exitCode: 0,
        };
      }

      return {
        stdout: JSON.stringify({
          missing: {
            bins: [],
            anyBins: [],
            env: [],
            config: [],
            os: [],
          },
          ...payload,
        }),
        stderr: "",
        exitCode: 0,
      };
    },
  };
}
