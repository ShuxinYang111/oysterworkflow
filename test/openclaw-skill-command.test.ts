import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createSpawnCommandRunner,
  parseOpenClawSkillInstallCliArgs,
  parseOpenClawSkillUninstallCliArgs,
  resolveOpenClawExecutablePath,
  runOpenClawSkillExport,
  runOpenClawSkillInstall,
  runOpenClawSkillUninstall,
} from "../src/cli/commands/openclaw-skill.js";
import {
  materializeWorkflowGraphArtifacts,
  persistWorkflowGraphDraft,
} from "../src/skill/workflow-graph.js";
import type { OpenClawSkill } from "../src/types/contracts.js";

function buildSkill(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    schemaVersion: "openclaw-skill-v1",
    promptSet: "specific-v3",
    skillId: "skill-001",
    skillName: "Flight Check",
    generatedAt: "2026-03-22T00:00:00.000Z",
    source: {
      runId: "run-001",
      runDir: "/tmp/run-001",
      episodeId: "ep-001",
      startTs: "2026-03-22T00:00:00.000Z",
      endTs: "2026-03-22T00:10:00.000Z",
    },
    shortDescription:
      "Quickly inspect one flight status from the verified path.",
    description: "Check flight status.",
    goal: "Check the latest flight status without booking anything.",
    whenToUse: ["When you need to inspect one flight status."],
    whenNotToUse: ["Do not use for ticket purchases."],
    inputs: ["Flight number"],
    outputs: ["Visible flight status"],
    prerequisites: ["Open a browser session."],
    steps: [
      {
        step: 1,
        instruction: "Open the airline status page.",
        intent: "Navigate to the right workflow.",
        operationApp: "Google Chrome",
        hints: ["Status page"],
      },
      {
        step: 2,
        instruction: "Enter the flight number and inspect the result.",
        intent: "Retrieve the current flight status.",
        operationApp: "Google Chrome",
        hints: ["Flight number"],
      },
    ],
    successCriteria: ["The current flight status is visible on screen."],
    failureModes: ["The site is unavailable."],
    fallback: ["Retry after refreshing the page."],
    examples: ["Check UA100 before heading to the airport."],
    tags: ["travel"],
    assets: {
      credentials: [],
      texts: ["UA100"],
      urls: ["https://example.com/status"],
    },
    evidence: {
      totalEvents: 2,
      anchorEvents: 2,
      ocrEvents: 0,
      appsSeen: ["Google Chrome"],
      windowsSeen: ["Flight Status"],
    },
    ...overrides,
  };
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function createSourceFiles(input: {
  root: string;
  skill?: Record<string, unknown>;
  summary?: Record<string, unknown> | null;
}): Promise<{
  skillPath: string;
  summaryPath: string;
}> {
  const sourceDir = path.join(input.root, "source");
  await mkdir(sourceDir, { recursive: true });

  const skillPath = path.join(sourceDir, "skill.json");
  const summaryPath = path.join(sourceDir, "summary.json");

  await writeJson(skillPath, input.skill ?? buildSkill());
  if (input.summary !== null) {
    await writeJson(summaryPath, input.summary ?? { runId: "run-001" });
  }

  return { skillPath, summaryPath };
}

describe("openclaw-skill command", () => {
  it("parses install defaults without deriving companion artifacts", () => {
    const parsed = parseOpenClawSkillInstallCliArgs({
      skillPath: "/tmp/run/openclaw-llm/skill.json",
      summaryPath: "/tmp/run/openclaw-llm/summary.json",
      run: true,
    });

    expect(parsed.skillPath).toBe(
      path.resolve("/tmp/run/openclaw-llm/skill.json"),
    );
    expect(parsed.installRoot).toBe(
      path.join(os.homedir(), ".agents", "skills"),
    );
  });

  it("prefers an explicit OpenClaw executable override before fallback paths", async () => {
    const checkedPaths: string[] = [];
    const resolved = await resolveOpenClawExecutablePath({
      env: {
        OYSTERWORKFLOW_OPENCLAW_PATH: "~/custom-bin/openclaw",
      },
      isExecutablePath: async (filePath) => {
        checkedPaths.push(filePath);
        return filePath === path.join(os.homedir(), "custom-bin", "openclaw");
      },
    });

    expect(resolved).toBe(path.join(os.homedir(), "custom-bin", "openclaw"));
    expect(checkedPaths[0]).toBe(
      path.join(os.homedir(), "custom-bin", "openclaw"),
    );
  });

  it("falls back to common Homebrew locations when no env override is executable", async () => {
    const checkedPaths: string[] = [];
    const resolved = await resolveOpenClawExecutablePath({
      env: {
        OYSTERWORKFLOW_OPENCLAW_PATH: "/tmp/missing-openclaw",
      },
      isExecutablePath: async (filePath) => {
        checkedPaths.push(filePath);
        return filePath === "/opt/homebrew/bin/openclaw";
      },
    });

    expect(resolved).toBe("/opt/homebrew/bin/openclaw");
    expect(checkedPaths).toEqual([
      path.resolve("/tmp/missing-openclaw"),
      "/opt/homebrew/bin/openclaw",
    ]);
  });

  it("still accepts the legacy OpenClaw executable env var", async () => {
    const checkedPaths: string[] = [];
    const resolved = await resolveOpenClawExecutablePath({
      env: {
        TRACE2OPENCLAW_OPENCLAW_PATH: "~/legacy-bin/openclaw",
      },
      isExecutablePath: async (filePath) => {
        checkedPaths.push(filePath);
        return filePath === path.join(os.homedir(), "legacy-bin", "openclaw");
      },
    });

    expect(resolved).toBe(path.join(os.homedir(), "legacy-bin", "openclaw"));
    expect(checkedPaths[0]).toBe(
      path.join(os.homedir(), "legacy-bin", "openclaw"),
    );
  });

  it("force-settles a timed-out OpenClaw command process tree", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-openclaw-runner-"),
    );
    const commandPath = path.join(root, "hung-openclaw");
    await writeFile(
      commandPath,
      `#!/bin/sh
trap '' TERM
while true; do sleep 1; done
`,
      "utf8",
    );
    await chmod(commandPath, 0o755);
    const runner = createSpawnCommandRunner({
      timeoutMs: 25,
      terminationGraceMs: 50,
      forceSettleMs: 50,
    });
    const startedAt = Date.now();

    await expect(runner.run(commandPath, [])).rejects.toThrow(
      /timed out after 25ms/i,
    );
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("installs a skill without companion summary", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-openclaw-"),
    );
    const installRoot = path.join(root, "install-root");
    const { skillPath } = await createSourceFiles({
      root,
      summary: null,
    });
    const options = parseOpenClawSkillInstallCliArgs({
      skillPath,
      installRoot,
    });

    const result = await runOpenClawSkillInstall({
      ...options,
      now: new Date("2026-03-22T01:00:00.000Z"),
    });

    expect(result.installName).toBe("generated-flight-check");
    await expect(
      access(path.join(result.installDir, "references")),
    ).rejects.toThrow();
    const skillMd = await readFile(result.skillMdPath, "utf8");
    expect(skillMd).toMatch(/^---\nname: "generated-flight-check"\n/u);
    expect(skillMd).toContain('name: "generated-flight-check"');
    expect(skillMd).toContain("## Goal");
    expect(skillMd).toContain("## Steps");
    expect(skillMd).not.toContain("references/generated-skill.json");
    await expect(
      access(path.join(result.installDir, "test-prompt.md")),
    ).rejects.toThrow();
  });

  it("exports a skill without discovery checks or test prompts", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-openclaw-"),
    );
    const installRoot = path.join(root, "install-root");
    const { skillPath, summaryPath } = await createSourceFiles({
      root,
    });
    const options = parseOpenClawSkillInstallCliArgs({
      skillPath,
      summaryPath,
      installRoot,
    });

    const result = await runOpenClawSkillExport({
      ...options,
      now: new Date("2026-03-22T01:00:00.000Z"),
    });

    expect(result.installName).toBe("generated-flight-check");
    expect(result.sourceSkillPath).toBe(skillPath);
    expect(summaryPath.endsWith("summary.json")).toBe(true);
    await expect(
      access(path.join(result.installDir, "references")),
    ).rejects.toThrow();
    const skillMd = await readFile(result.skillMdPath, "utf8");
    expect(skillMd).toContain('name: "generated-flight-check"');
    await expect(
      access(path.join(result.installDir, "test-prompt.md")),
    ).rejects.toThrow();
    await expect(
      access(path.join(result.installDir, ".oysterworkflow-export.json")),
    ).rejects.toThrow();
  });

  it("omits empty exception sections from exported skill markdown", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-openclaw-empty-exceptions-"),
    );
    const installRoot = path.join(root, "install-root");
    const { skillPath } = await createSourceFiles({
      root,
      skill: buildSkill({ failureModes: [], fallback: [] }),
      summary: null,
    });
    const result = await runOpenClawSkillExport({
      ...parseOpenClawSkillInstallCliArgs({ skillPath, installRoot }),
      now: new Date("2026-07-12T01:00:00.000Z"),
    });

    const skillMd = await readFile(result.skillMdPath, "utf8");
    expect(skillMd).not.toContain("## Failure Modes");
    expect(skillMd).not.toContain("## Fallback");
    expect(skillMd).not.toContain("No explicit failure modes");
    expect(skillMd).not.toContain("No explicit fallback guidance");
  });

  it("exports a canonical branching graph with its Agent-readable projection and revision history", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-openclaw-graph-"),
    );
    const installRoot = path.join(root, "install-root");
    const skill = buildSkill() as unknown as OpenClawSkill;
    const { skillPath } = await createSourceFiles({
      root,
      skill: skill as unknown as Record<string, unknown>,
      summary: null,
    });
    const sourceDir = path.dirname(skillPath);
    const initial = await materializeWorkflowGraphArtifacts({
      skill,
      outDir: sourceDir,
    });
    const { revision: _revision, ...draft } = initial.graph;
    void _revision;
    const firstNode = draft.nodes[0];
    draft.nodes[0] = {
      id: firstNode.id,
      type: "decision",
      title: "Assess whether the flight lookup should continue",
      decision: "Is the request valid and safe to inspect?",
      hints: firstNode.hints,
      sourceRefs: firstNode.sourceRefs,
    };
    draft.nodes.push({
      id: "terminal-rejected",
      type: "terminal",
      title: "Reject unsupported request",
      outcome: "rejected",
      summary: "The request is outside the safe flight-status scope.",
      hints: [],
      sourceRefs: firstNode.sourceRefs,
    });
    draft.transitions = [
      {
        id: "route-valid-request",
        from: "step-001",
        to: "step-002",
        type: "conditional",
        when: "The request is a valid flight-status lookup",
        sourceRefs: firstNode.sourceRefs,
      },
      {
        id: "route-reject-request",
        from: "step-001",
        to: "terminal-rejected",
        type: "conditional",
        when: "The request is invalid or outside inspection-only scope",
        sourceRefs: firstNode.sourceRefs,
      },
      {
        id: "route-completed",
        from: "step-002",
        to: "terminal-completed",
        type: "default",
        sourceRefs: [],
      },
    ];
    const persisted = await persistWorkflowGraphDraft({
      draft,
      outDir: sourceDir,
    });

    const result = await runOpenClawSkillExport({
      skillPath,
      installRoot,
    });
    const installedSkill = await readFile(result.skillMdPath, "utf8");
    const installedWorkflow = await readFile(
      path.join(result.installDir, "WORKFLOW.md"),
      "utf8",
    );
    const revisions = await readdir(
      path.join(result.installDir, ".workflow-revisions"),
    );

    expect(result.workflowGraph?.revisionId).toContain(":rev-2:");
    expect(installedSkill).toContain("## Canonical Execution Graph");
    expect(installedSkill).not.toContain("## Steps");
    expect(installedSkill).toContain("read [WORKFLOW.md](./WORKFLOW.md)");
    expect(installedWorkflow).toContain(
      "The request is a valid flight-status lookup",
    );
    expect(installedWorkflow).toContain("#terminal-rejected");
    expect(revisions).toHaveLength(2);
    expect(
      await readFile(path.join(result.installDir, "workflow.json"), "utf8"),
    ).toBe(await readFile(persisted.graphPath, "utf8"));
    await Promise.all([
      access(path.join(result.installDir, "workflow.json")),
      access(result.workflowGraph?.markdownPath ?? ""),
    ]);
  });

  it("installs a skill that already uses structured fields and inline assets", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-openclaw-"),
    );
    const installRoot = path.join(root, "install-root");
    const longDescription =
      "Prefer this verified learner-generated flow when checking one flight status. " +
      "It preserves the user's original navigation path, keeps the status lookup " +
      "focused on inspection only, and includes the reference materials needed " +
      "to avoid guessing during execution.";
    const { skillPath } = await createSourceFiles({
      root,
      skill: buildSkill({
        skillName: "Structured Flight Check",
        shortDescription:
          "Use this verified flow to inspect one flight status without booking.",
        description: longDescription,
        inputs: [
          {
            name: "Flight number",
            description: "Airline flight number to inspect.",
            required: true,
          },
        ],
        outputs: [
          {
            name: "Flight status",
            description: "Visible live status shown on screen.",
            required: true,
          },
        ],
        assets: [
          {
            type: "url",
            name: "Status page",
            value: "https://example.com/status",
          },
          {
            name: "Reference flights",
            value: ["UA100", "UA101"],
          },
        ],
      }),
      summary: null,
    });
    const options = parseOpenClawSkillInstallCliArgs({
      skillPath,
      installRoot,
    });

    const result = await runOpenClawSkillInstall({
      ...options,
    });

    const skillMd = await readFile(result.skillMdPath, "utf8");
    expect(result.installName).toBe("generated-structured-flight-check");
    expect(skillMd).toContain(
      'description: "Use this verified flow to inspect one flight status without booking."',
    );
    expect(skillMd).toContain("## Description");
    expect(skillMd).toContain(longDescription);
    expect(skillMd).toContain(
      "- Flight number (required): Airline flight number to inspect.",
    );
    expect(skillMd).toContain(
      "- Flight status (required): Visible live status shown on screen.",
    );
    expect(skillMd).toContain("## Assets");
    expect(skillMd).toContain("- Status page: https://example.com/status");
    expect(skillMd).toContain("- Reference flights: UA100; UA101");
  });

  it("falls back to a truncated full description when shortDescription is missing", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-openclaw-"),
    );
    const installRoot = path.join(root, "install-root");
    const longDescription =
      "Prefer this verified learner-generated flow when checking one flight status so the agent follows the same trusted path the user already validated in production and does not have to improvise the airline site navigation from scratch. " +
      "Keep this longer body in the markdown description section for humans who need the full context.";
    const { skillPath } = await createSourceFiles({
      root,
      skill: buildSkill({
        shortDescription: undefined,
        description: longDescription,
      }),
      summary: null,
    });
    const options = parseOpenClawSkillInstallCliArgs({
      skillPath,
      installRoot,
    });

    const result = await runOpenClawSkillInstall({
      ...options,
    });

    const skillMd = await readFile(result.skillMdPath, "utf8");
    expect(skillMd).toContain(
      `description: "${longDescription.slice(0, 280)}"`,
    );
    expect(skillMd).toContain(longDescription);
  });

  it("appends a suffix on install name conflict without copying sibling summary", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-openclaw-"),
    );
    const installRoot = path.join(root, "install-root");
    await mkdir(path.join(installRoot, "generated-flight-check"), {
      recursive: true,
    });
    const { skillPath } = await createSourceFiles({
      root,
    });
    const options = parseOpenClawSkillInstallCliArgs({
      skillPath,
      installRoot,
    });

    const result = await runOpenClawSkillInstall({
      ...options,
    });

    expect(result.installName).toBe("generated-flight-check-V1");
    await expect(
      access(path.join(result.installDir, "references", "summary.json")),
    ).rejects.toThrow();
  });

  it("increments an existing version suffix when the requested install name already exists", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-openclaw-"),
    );
    const installRoot = path.join(root, "install-root");
    await mkdir(path.join(installRoot, "generated-flight-check-V2"), {
      recursive: true,
    });
    const { skillPath } = await createSourceFiles({
      root,
    });
    const options = parseOpenClawSkillInstallCliArgs({
      skillPath,
      installRoot,
      installName: "generated-flight-check-V2",
    });

    const result = await runOpenClawSkillInstall({
      ...options,
    });

    expect(result.installName).toBe("generated-flight-check-V3");
  });

  it("fails when skill steps are not sequential", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-openclaw-"),
    );
    const installRoot = path.join(root, "install-root");
    const { skillPath } = await createSourceFiles({
      root,
      skill: buildSkill({
        steps: [
          {
            step: 1,
            instruction: "Open the site.",
            intent: "Navigate.",
            operationApp: "Google Chrome",
            hints: [],
          },
          {
            step: 3,
            instruction: "Inspect the result.",
            intent: "Read the status.",
            operationApp: "Google Chrome",
            hints: [],
          },
        ],
      }),
      summary: null,
    });
    const options = parseOpenClawSkillInstallCliArgs({
      skillPath,
      installRoot,
    });

    await expect(
      runOpenClawSkillInstall({
        ...options,
      }),
    ).rejects.toThrow("Invalid skill step sequence");
  });

  it("does not run discovery or smoke commands when the legacy run flag is set", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-openclaw-"),
    );
    const installRoot = path.join(root, "install-root");
    const { skillPath } = await createSourceFiles({
      root,
      summary: null,
    });
    const options = parseOpenClawSkillInstallCliArgs({
      skillPath,
      installRoot,
      run: true,
    });
    const runner = {
      async run(command: string, args: string[]) {
        throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
      },
    };

    const result = await runOpenClawSkillInstall({
      ...options,
      commandRunner: runner,
    });

    expect(result.installName).toBe("generated-flight-check");
    await expect(
      access(path.join(result.installDir, "test-prompt.md")),
    ).rejects.toThrow();
  });

  it("normalizes versioned install names for uninstall lookup", () => {
    const parsed = parseOpenClawSkillUninstallCliArgs({
      name: "generated-flight-check-v2",
    });

    expect(parsed.installName).toBe("generated-flight-check-V2");
  });

  it("uninstalls a generated directory by install name", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-openclaw-"),
    );
    const installRoot = path.join(root, "install-root");
    const { skillPath } = await createSourceFiles({
      root,
      summary: null,
    });
    const installResult = await runOpenClawSkillInstall({
      ...parseOpenClawSkillInstallCliArgs({
        skillPath,
        installRoot,
      }),
    });

    const uninstallResult = await runOpenClawSkillUninstall(
      parseOpenClawSkillUninstallCliArgs({
        name: installResult.installName,
        installRoot,
      }),
    );
    expect(uninstallResult.removed).toBe(true);
    await expect(access(installResult.installDir)).rejects.toThrow();
  });
});
