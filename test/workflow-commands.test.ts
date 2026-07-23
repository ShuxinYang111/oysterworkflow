import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseDiscoverWorkflowsCliArgs,
  runDiscoverWorkflows,
} from "../src/cli/commands/discover-workflows.js";
import { runExtractSkill } from "../src/cli/commands/extract-skill.js";
import type { OpenClawLlmClient } from "../src/skill/extract-openclaw-llm.js";
import type { Episode, NormalizedEvent } from "../src/types/contracts.js";

function buildEvent(input: {
  id: string;
  tsMs: number;
  eventType: NormalizedEvent["eventType"];
  appName?: string | null;
  windowName?: string | null;
  textContent?: string | null;
  frameId?: number | null;
}): NormalizedEvent {
  return {
    id: input.id,
    source: input.eventType === "ocr" ? "search-ocr" : "ui-events",
    tsIso: new Date(input.tsMs).toISOString(),
    tsMs: input.tsMs,
    appName: input.appName ?? "Google Chrome",
    windowName: input.windowName ?? "Workflow Test",
    eventType: input.eventType,
    textContent: input.textContent ?? null,
    x: null,
    y: null,
    keyCode: null,
    modifiers: null,
    browserUrl: null,
    frameId: input.frameId ?? null,
    rawRef: {
      file: "/tmp/events.ndjson",
      line: 1,
    },
  };
}

async function createRunDir(): Promise<{
  root: string;
  runDir: string;
  episode: Episode;
}> {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "oysterworkflow-workflow-command-"),
  );
  const runDir = path.join(root, "runs", "run-workflow-001");
  await mkdir(runDir, { recursive: true });

  const base = Date.parse("2026-03-27T04:00:00.000Z");
  const episode: Episode = {
    id: "run-workflow-001-ep-0001",
    runId: "run-workflow-001",
    startTs: new Date(base).toISOString(),
    endTs: new Date(base + 9_000).toISOString(),
    durationMs: 9_000,
    eventsCount: 4,
    events: [
      buildEvent({
        id: "e1",
        tsMs: base,
        eventType: "click",
        textContent: "open claim list",
      }),
      buildEvent({
        id: "e2",
        tsMs: base + 2_000,
        eventType: "ocr",
        textContent: "claim detail",
      }),
      buildEvent({
        id: "e3",
        tsMs: base + 5_000,
        eventType: "click",
        textContent: "open notes",
      }),
      buildEvent({
        id: "e4",
        tsMs: base + 9_000,
        eventType: "text",
        textContent: "write summary",
      }),
    ],
  };

  await writeFile(
    path.join(runDir, "manifest.json"),
    JSON.stringify({ runId: "run-workflow-001" }) + "\n",
    "utf8",
  );
  await writeFile(
    path.join(runDir, "episodes.json"),
    JSON.stringify([episode], null, 2) + "\n",
    "utf8",
  );

  return { root, runDir, episode };
}

describe("workflow commands", () => {
  it("parses discover-workflows CLI args", () => {
    const parsed = parseDiscoverWorkflowsCliArgs({
      runDir: "/tmp/run",
      out: "/tmp/workflow-discovery.json",
      episodeId: "ep-1",
      guidance: "Avoid temporary URLs.",
      config: "/tmp/llm.json",
    });

    expect(parsed.runDir).toBe("/tmp/run");
    expect(parsed.outPath).toBe("/tmp/workflow-discovery.json");
    expect(parsed.episodeId).toBe("ep-1");
    expect(parsed.generationGuidance).toBe("Avoid temporary URLs.");
    expect(parsed.configPath).toBe("/tmp/llm.json");
  });

  it("runs discovery and wrapper extraction with an explicit workflow selection", async () => {
    const { runDir } = await createRunDir();
    let selectedWorkflowId: string | null = null;
    let selectedEventIds: string[] = [];
    const seenGuidance: Array<string | undefined> = [];

    const llmClient: OpenClawLlmClient = {
      async discoverWorkflows(input) {
        seenGuidance.push(input.generationGuidance);
        return {
          workflows: [
            {
              workflowId: "workflow-claim",
              name: "Claim status check",
              description: "Check the target claim detail.",
              goal: "Confirm the target claim status.",
              priority: 1,
              startEventId: "e1",
              endEventId: "e2",
            },
            {
              workflowId: "workflow-notes",
              name: "Write notes",
              description: "Write follow-up notes after reviewing the claim.",
              goal: "Capture a short notes summary.",
              priority: 2,
              startEventId: "e3",
              endEventId: "e4",
            },
          ],
        };
      },
      async generateSkillDraft(input) {
        seenGuidance.push(input.generationGuidance);
        selectedWorkflowId = input.selectedWorkflow?.workflowId ?? null;
        selectedEventIds = input.events.map((event) => event.id);
        return {
          skillName: input.selectedWorkflow?.name ?? "Fallback workflow",
          goal:
            input.selectedWorkflow?.goal ?? "Complete the selected workflow.",
          whenToUse: ["Need to reuse the selected workflow."],
          prerequisites: ["Required context is available."],
          steps: [
            {
              instruction: "Execute the selected workflow.",
              intent: "Finish the chosen task.",
              operationApp: "Google Chrome",
            },
          ],
          successCriteria: ["The selected workflow reaches its target result."],
          fallback: ["Retry once if the page does not respond."],
        };
      },
    };

    const discoveryPath = path.join(runDir, "workflow-discovery.json");
    const result = await runExtractSkill({
      runDir,
      discoveryOutPath: discoveryPath,
      llmClient,
      generationGuidance: "Keep claim numbers as placeholders.",
      workflowSelector: {
        async selectWorkflow(input) {
          return input.workflowCandidates[1];
        },
      },
      now: new Date("2026-03-27T04:10:00.000Z"),
    });

    expect(result.discoveryPath).toBe(discoveryPath);
    expect(result.workflowCandidates).toHaveLength(2);
    expect(result.selectedWorkflow.workflowId).toBe("workflow-notes");
    expect(result.extractResult.summary.selectedWorkflowId).toBe(
      "workflow-notes",
    );
    expect(selectedWorkflowId).toBe("workflow-notes");
    expect(selectedEventIds).toEqual(["e3", "e4"]);
    expect(seenGuidance).toEqual([
      "Keep claim numbers as placeholders.",
      "Keep claim numbers as placeholders.",
    ]);

    const discoveryArtifact = JSON.parse(
      await readFile(discoveryPath, "utf8"),
    ) as {
      workflowCandidates?: Array<{ workflowId?: string }>;
    };
    expect(
      discoveryArtifact.workflowCandidates?.map((item) => item.workflowId),
    ).toEqual(["workflow-claim", "workflow-notes"]);
  });

  it("runs discovery directly and persists workflow candidates", async () => {
    const { runDir } = await createRunDir();
    const outPath = path.join(runDir, "workflow-discovery.json");
    const llmClient: OpenClawLlmClient = {
      async discoverWorkflows() {
        return {
          workflows: [
            {
              workflowId: "workflow-1",
              name: "Claim status check",
              description: "Inspect the claim result page.",
              goal: "Confirm the claim outcome.",
              priority: 1,
              startEventId: "e1",
              endEventId: "e2",
            },
          ],
        };
      },
      async generateSkillDraft() {
        return {};
      },
    };

    const result = await runDiscoverWorkflows({
      runDir,
      outPath,
      llmClient,
    });

    expect(result.workflowCandidates).toHaveLength(1);
    expect(result.workflowCandidates[0].workflowId).toBe("workflow-1");
    const saved = JSON.parse(await readFile(outPath, "utf8")) as {
      workflowCandidates?: Array<{ workflowId?: string }>;
    };
    expect(saved.workflowCandidates?.[0]?.workflowId).toBe("workflow-1");
  });

  it("normalizes workflow discovery bounds returned as frame ids", async () => {
    const { runDir } = await createRunDir();
    const runPath = path.join(runDir, "episodes.json");
    const base = Date.parse("2026-03-27T04:30:00.000Z");
    const episode: Episode = {
      id: "run-workflow-001-ep-0001",
      runId: "run-workflow-001",
      startTs: new Date(base).toISOString(),
      endTs: new Date(base + 9_000).toISOString(),
      durationMs: 9_000,
      eventsCount: 4,
      events: [
        buildEvent({
          id: "f1",
          tsMs: base,
          eventType: "click",
          textContent: "open claim list",
          frameId: 101,
        }),
        buildEvent({
          id: "f2",
          tsMs: base + 2_000,
          eventType: "ocr",
          textContent: "claim detail",
          frameId: 102,
        }),
        buildEvent({
          id: "f3",
          tsMs: base + 5_000,
          eventType: "click",
          textContent: "open notes",
          frameId: 201,
        }),
        buildEvent({
          id: "f4",
          tsMs: base + 9_000,
          eventType: "text",
          textContent: "write summary",
          frameId: 202,
        }),
      ],
    };
    await writeFile(runPath, JSON.stringify([episode], null, 2) + "\n", "utf8");

    const outPath = path.join(runDir, "workflow-discovery.json");
    const llmClient: OpenClawLlmClient = {
      async discoverWorkflows() {
        return {
          workflows: [
            {
              workflowId: "workflow-notes",
              name: "Write notes",
              description: "Write follow-up notes after reviewing the claim.",
              goal: "Capture a short notes summary.",
              priority: 1,
              startEventId: 201,
              endEventId: 202,
            },
          ],
        };
      },
      async generateSkillDraft() {
        return {};
      },
    };

    const result = await runDiscoverWorkflows({
      runDir,
      outPath,
      llmClient,
    });

    expect(result.workflowCandidates).toHaveLength(1);
    expect(result.workflowCandidates[0]).toMatchObject({
      workflowId: "workflow-notes",
      startEventId: "f3",
      endEventId: "f4",
      eventCount: 2,
    });
    expect(result.artifact.warnings).toEqual([]);
  });
});
