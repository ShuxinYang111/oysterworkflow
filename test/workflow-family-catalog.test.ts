import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LabSession } from "../src/lab-api/contracts.js";
import {
  buildRuntimeWorkflowFamilyCatalog,
  collectSessionWorkflowFamilyArtifactSources,
  resolveWorkflowFamilyGraphPath,
} from "../src/lab-api/workflow-family-catalog.js";
import { persistWorkflowGraphDraft } from "../src/skill/workflow-graph.js";
import type { OysterWorkflowGraphDraftV2 } from "../src/types/contracts.js";

describe("runtime workflow family catalog", () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryRoots.splice(0).map((root) =>
        rm(root, {
          recursive: true,
          force: true,
        }),
      ),
    );
  });

  it("loads valid canonical graphs beside product skill artifacts", async () => {
    const root = await createTemporaryRoot();
    const familyDirectory = join(root, "family");
    const saved = await persistWorkflowGraphDraft({
      draft: buildGraphDraft("workflow.research", "Research sources"),
      outDir: familyDirectory,
      now: new Date("2026-07-21T20:00:00.000Z"),
    });
    const skillPath = join(familyDirectory, "skill.json");
    await writeFile(skillPath, "{}\n", "utf8");

    const catalog = await buildRuntimeWorkflowFamilyCatalog([
      {
        artifactPath: skillPath,
        updatedAt: "2026-07-21T20:01:00.000Z",
      },
      {
        artifactPath: skillPath,
        updatedAt: "2026-07-21T20:00:00.000Z",
        whenToUse: ["Research a startup topic."],
      },
    ]);

    expect(resolveWorkflowFamilyGraphPath(skillPath)).toBe(saved.graphPath);
    expect(catalog.families).toEqual([
      expect.objectContaining({
        workflowId: "workflow.research",
        whenToUse: ["Research a startup topic."],
      }),
    ]);
    expect(catalog.graphs["workflow.research"]?.revision.number).toBe(1);
    expect(catalog.graphPaths["workflow.research"]).toBe(saved.graphPath);
    expect(catalog.warnings).toEqual([]);
  });

  it("keeps the newest valid source per family and diagnoses invalid graphs", async () => {
    const root = await createTemporaryRoot();
    const olderDirectory = join(root, "older");
    const newerDirectory = join(root, "newer");
    const invalidDirectory = join(root, "invalid");
    const older = await persistWorkflowGraphDraft({
      draft: buildGraphDraft("workflow.shared", "Older goal"),
      outDir: olderDirectory,
      now: new Date("2026-07-20T20:00:00.000Z"),
    });
    const newer = await persistWorkflowGraphDraft({
      draft: buildGraphDraft("workflow.shared", "Newer goal"),
      outDir: newerDirectory,
      now: new Date("2026-07-21T20:00:00.000Z"),
    });
    await mkdir(invalidDirectory, { recursive: true });
    await writeFile(
      join(invalidDirectory, "workflow.json"),
      "{not-json}\n",
      "utf8",
    );

    const catalog = await buildRuntimeWorkflowFamilyCatalog([
      {
        artifactPath: older.graphPath,
        updatedAt: "2026-07-20T20:00:00.000Z",
        whenToUse: ["Use the older saved family trigger."],
      },
      {
        artifactPath: join(root, "missing", "skill.json"),
        updatedAt: "2026-07-22T20:00:00.000Z",
      },
      {
        artifactPath: invalidDirectory,
        updatedAt: "2026-07-22T19:00:00.000Z",
      },
      {
        artifactPath: newer.graphPath,
        updatedAt: "2026-07-21T20:00:00.000Z",
        whenToUse: ["Use the newest saved family trigger."],
      },
    ]);

    expect(catalog.families).toHaveLength(1);
    expect(catalog.families[0]?.goal).toBe("Newer goal");
    expect(catalog.families[0]?.whenToUse).toEqual([
      "Use the newest saved family trigger.",
      "Use the older saved family trigger.",
    ]);
    expect(catalog.graphPaths["workflow.shared"]).toBe(newer.graphPath);
    expect(catalog.warnings).toEqual([
      expect.stringContaining("Skipped invalid workflow family graph"),
    ]);
  });

  it("collects graph paths and trigger hints from persisted Lab sessions", () => {
    const session = {
      updatedAt: "2026-07-21T20:00:00.000Z",
      skillExtraction: {
        artifacts: [
          {
            skill: { whenToUse: ["Use the saved family."] },
            summary: {
              generatedAt: "2026-07-21T19:00:00.000Z",
              output: { workflowGraphPath: "/tmp/family/workflow.json" },
            },
          },
        ],
        skill: null,
        summary: null,
      },
    } as unknown as LabSession;

    expect(collectSessionWorkflowFamilyArtifactSources([session])).toEqual([
      {
        artifactPath: "/tmp/family/workflow.json",
        updatedAt: "2026-07-21T19:00:00.000Z",
        whenToUse: ["Use the saved family."],
      },
    ]);
  });

  async function createTemporaryRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "workflow-family-catalog-"));
    temporaryRoots.push(root);
    return root;
  }
});

function buildGraphDraft(
  workflowId: string,
  goal: string,
): OysterWorkflowGraphDraftV2 {
  return {
    schemaVersion: "oyster-workflow-graph-v2",
    workflowId,
    name: workflowId.replaceAll(".", "-"),
    goal,
    entryNodeId: "research",
    nodes: [
      {
        id: "research",
        type: "action",
        title: "Research",
        objective: goal,
        act: ["Review relevant sources."],
        operationApp: "Chrome",
        hints: [],
        sourceRefs: [],
      },
      {
        id: "completed",
        type: "terminal",
        title: "Completed",
        outcome: "completed",
        summary: "Research is complete.",
        hints: [],
        sourceRefs: [],
      },
    ],
    transitions: [
      {
        id: "research-to-completed",
        from: "research",
        to: "completed",
        type: "default",
        sourceRefs: [],
      },
    ],
    source: {
      skillId: workflowId,
      skillSchemaVersion: "openclaw-skill-v1",
      skillGeneratedAt: "2026-07-21T20:00:00.000Z",
      promptSet: "specific-v32",
      runId: "run-family-catalog",
      runDir: "/tmp/run-family-catalog",
      episodeId: "episode-family-catalog",
    },
  };
}
