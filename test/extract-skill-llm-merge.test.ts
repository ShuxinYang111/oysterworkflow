import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { extractOpenClawSkillLlm } from "../src/skill/extract-openclaw-llm.js";
import type { Episode, NormalizedEvent } from "../src/types/contracts.js";

type QueuedResponse =
  | Record<string, unknown>
  | ((body: Record<string, unknown> | null) => Record<string, unknown>);

const queuedResponses = vi.hoisted(() => [] as QueuedResponse[]);

vi.mock("js-tiktoken", () => ({
  getEncoding() {
    return {
      encode(text: string) {
        return new Array(Math.max(1, Math.ceil(text.length / 3))).fill(0);
      },
    };
  },
}));

vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal<typeof import("undici")>();

  return {
    ...actual,
    fetch: vi.fn(async (_url: string, init?: { body?: string }) => {
      const bodyText = typeof init?.body === "string" ? init.body : "";
      const bodyJson = bodyText
        ? (JSON.parse(bodyText) as Record<string, unknown>)
        : null;
      const queued = queuedResponses.shift();
      const payload =
        typeof queued === "function"
          ? queued(bodyJson)
          : (queued ?? {
              output_text: JSON.stringify({}),
              usage: {
                input_tokens: 10,
                output_tokens: 5,
                total_tokens: 15,
              },
            });
      return new actual.Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  };
});

function buildEvent(input: {
  id: string;
  tsMs: number;
  eventType: NormalizedEvent["eventType"];
  appName?: string | null;
  windowName?: string | null;
  textContent?: string | null;
}): NormalizedEvent {
  return {
    id: input.id,
    source: input.eventType === "ocr" ? "search-ocr" : "ui-events",
    tsIso: new Date(input.tsMs).toISOString(),
    tsMs: input.tsMs,
    appName: input.appName ?? "Google Chrome",
    windowName: input.windowName ?? "Flight Status",
    eventType: input.eventType,
    textContent: input.textContent ?? null,
    x: null,
    y: null,
    keyCode: null,
    modifiers: null,
    browserUrl: null,
    frameId: null,
    rawRef: {
      file: "/tmp/events.ndjson",
      line: 1,
    },
  };
}

function extractRequestUserPrompt(
  body: Record<string, unknown> | null,
): string {
  const input = Array.isArray(body?.input) ? body.input : [];
  return input
    .filter(
      (item): item is Record<string, unknown> =>
        typeof item === "object" &&
        item !== null &&
        (item as Record<string, unknown>).role === "user",
    )
    .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
    .map((content) =>
      typeof content === "object" && content !== null
        ? String((content as Record<string, unknown>).text ?? "")
        : "",
    )
    .join("\n");
}

function extractLastEventIdFromPrompt(userPrompt: string): string | null {
  const matches = Array.from(userPrompt.matchAll(/"id": "(a\d+)"/g));
  const lastMatch = matches.at(-1);
  return lastMatch?.[1] ?? null;
}

describe("extractOpenClawSkillLlm mergeDraftParts", () => {
  beforeEach(() => {
    queuedResponses.splice(0, queuedResponses.length);
  });

  it("preserves call B structured fields and assets in the final skill", async () => {
    queuedResponses.push(
      {
        output_text: JSON.stringify({
          name: "Verify Flight Status",
          goal: "Confirm the current flight status.",
          description: "Verify the current flight status.",
        }),
        usage: {
          input_tokens: 101,
          output_tokens: 21,
          total_tokens: 122,
        },
      },
      {
        output_text: JSON.stringify({
          steps: [
            {
              instruction: "Enter the flight number and submit the query.",
              intent: "Start the status query.",
              operationApp: "Google Chrome",
              hints: ["status query page"],
            },
          ],
          coveredThroughEventId: "m3",
          coveredThroughTsMs: Date.parse("2026-03-24T19:00:00.000Z") + 4_000,
          description:
            "Used to reuse a previously validated flight-status verification path.",
          whenToUse: [
            "when you need to verify the current status of a single flight",
          ],
          whenNotToUse: ["Do not use this for buying airline tickets"],
          inputs: [
            {
              name: "Flight number",
              description: "The flight number to query.",
              required: true,
            },
          ],
          outputs: [
            {
              name: "Flight status",
              description: "The current status shown on the page.",
            },
          ],
          prerequisites: ["The airline status query page is already open"],
          successCriteria: ["The page shows the current flight status"],
          failureModes: ["The page returned no results"],
          fallback: ["Refresh the page and query again"],
          examples: ["Verify UA100 CurrentStatus"],
          tags: ["flight-status"],
          assets: [
            {
              name: "Status page",
              value: "https://example.com/status",
            },
            {
              name: "Reference flights",
              value: ["UA100", "UA101"],
            },
            {
              name: "Demo login",
              value: {
                username: "demo",
                password: "secret",
              },
              notes: "For testing only",
            },
          ],
        }),
        usage: {
          input_tokens: 202,
          output_tokens: 32,
          total_tokens: 234,
        },
      },
    );

    const root = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-skill-llm-merge-"),
    );
    const runDir = path.join(root, "runs", "run-llm-merge");
    await mkdir(runDir, { recursive: true });

    const base = Date.parse("2026-03-24T19:00:00.000Z");
    const episode: Episode = {
      id: "run-llm-merge-ep-0001",
      runId: "run-llm-merge",
      startTs: new Date(base).toISOString(),
      endTs: new Date(base + 4_000).toISOString(),
      durationMs: 4_000,
      eventsCount: 3,
      events: [
        buildEvent({
          id: "m1",
          tsMs: base,
          eventType: "window_focus",
          windowName: "Flight Status",
        }),
        buildEvent({
          id: "m2",
          tsMs: base + 2_000,
          eventType: "text",
          textContent: "UA100",
        }),
        buildEvent({
          id: "m3",
          tsMs: base + 4_000,
          eventType: "ocr",
          textContent: "Flight status page",
        }),
      ],
    };

    await writeFile(
      path.join(runDir, "manifest.json"),
      `${JSON.stringify({ runId: "run-llm-merge" })}\n`,
      "utf8",
    );
    await writeFile(
      path.join(runDir, "episodes.json"),
      `${JSON.stringify([episode], null, 2)}\n`,
      "utf8",
    );

    const result = await extractOpenClawSkillLlm({
      runDir,
      apiKey: "test-key",
      baseUrl: "https://api.example.com/v1",
      components: {
        generalization: { enabled: false },
        plannerOptimization: { enabled: false },
      },
      now: new Date("2026-03-24T19:05:00.000Z"),
    });

    expect(result.skill.skillName).toBe("Verify Flight Status");
    expect(result.skill.goal.toLowerCase()).toContain("flight status");
    expect(result.skill.description).toContain(
      "Used to reuse a previously validated flight-status verification path.",
    );
    expect(result.skill.whenNotToUse).toContain(
      "Do not use this for buying airline tickets",
    );
    expect(result.skill.inputs).toEqual([
      {
        name: "Flight number",
        description: "The flight number to query.",
        required: true,
      },
    ]);
    expect(result.skill.outputs).toEqual([
      {
        name: "Flight status",
        description: "The current status shown on the page.",
      },
    ]);
    expect(result.skill.failureModes).toEqual(["The page returned no results"]);
    expect(result.skill.examples).toEqual(["Verify UA100 CurrentStatus"]);
    expect(result.skill.tags).toContain("flight-status");
    expect(result.skill.assets).toEqual([
      {
        name: "Status page",
        value: "https://example.com/status",
      },
      {
        name: "Reference flights",
        value: ["UA100", "UA101"],
      },
      {
        name: "Demo login",
        value: {
          username: "demo",
          password: "secret",
        },
        notes: "For testing only",
      },
    ]);
  });

  it("merges terminal assets with assets accumulated from earlier chunks", async () => {
    const dynamicChunkResponse = (
      body: Record<string, unknown> | null,
    ): Record<string, unknown> => {
      const userPrompt = extractRequestUserPrompt(body);
      const isTerminal = userPrompt.includes(
        "Current mode: skill-extraction-terminal",
      );
      return {
        output_text: JSON.stringify(
          isTerminal
            ? {
                steps: [],
                coveredThroughEventId: "a20",
                description:
                  "Used to complete the claim-material verification description.",
                whenToUse: [
                  "when you need to confirm whether any materials are missing",
                ],
                whenNotToUse: [],
                inputs: [],
                outputs: [],
                prerequisites: [],
                successCriteria: ["The page shows the material status."],
                failureModes: [],
                fallback: [],
                examples: [],
                tags: [],
                assets: [
                  {
                    type: "text",
                    name: "Required document",
                    value: "Invoice copy",
                  },
                ],
              }
            : {
                steps: [
                  {
                    instruction: "Open the claim page.",
                    intent: "Enter the materials verification entry point.",
                    operationApp: "Google Chrome",
                  },
                ],
                coveredThroughEventId:
                  extractLastEventIdFromPrompt(userPrompt) ?? "a16",
                assets: [
                  {
                    type: "url",
                    name: "Claim page",
                    value: "https://example.com/claim",
                  },
                ],
              },
        ),
        usage: {
          input_tokens: 180,
          output_tokens: 28,
          total_tokens: 208,
        },
      };
    };
    queuedResponses.push(
      {
        output_text: JSON.stringify({
          skillName: "Verify Claim Materials",
          goal: "Confirm the claim materials required.",
        }),
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          total_tokens: 120,
        },
      },
      ...Array.from({ length: 8 }, () => dynamicChunkResponse),
    );

    const root = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-skill-llm-merge-assets-"),
    );
    const runDir = path.join(root, "runs", "run-llm-merge-assets");
    await mkdir(runDir, { recursive: true });

    const base = Date.parse("2026-03-24T20:00:00.000Z");
    const longText = "merge-terminal-assets-".repeat(1_100);
    const episode: Episode = {
      id: "run-llm-merge-assets-ep-0001",
      runId: "run-llm-merge-assets",
      startTs: new Date(base).toISOString(),
      endTs: new Date(base + 19_000).toISOString(),
      durationMs: 19_000,
      eventsCount: 20,
      events: Array.from({ length: 20 }, (_, index) =>
        buildEvent({
          id: `a${index + 1}`,
          tsMs: base + index * 1_000,
          eventType: index === 0 ? "window_focus" : "text",
          windowName: "Claim Status",
          textContent: `${index + 1}:${longText}`,
        }),
      ),
    };

    await writeFile(
      path.join(runDir, "manifest.json"),
      `${JSON.stringify({ runId: "run-llm-merge-assets" })}\n`,
      "utf8",
    );
    await writeFile(
      path.join(runDir, "episodes.json"),
      `${JSON.stringify([episode], null, 2)}\n`,
      "utf8",
    );

    const result = await extractOpenClawSkillLlm({
      runDir,
      apiKey: "test-key",
      baseUrl: "https://api.example.com/v1",
      components: {
        generalization: { enabled: false },
        plannerOptimization: { enabled: false },
      },
      now: new Date("2026-03-24T20:05:00.000Z"),
    });

    expect(result.skill.assets).toEqual([
      {
        name: "Claim page",
        value: "https://example.com/claim",
      },
      {
        name: "Required document",
        value: "Invoice copy",
      },
    ]);
  });

  it("ignores legacy terminal field aliases during chunk merge", async () => {
    queuedResponses.push(
      {
        output_text: JSON.stringify({
          name: "Verify Flight Status",
          goal: "Confirm the current flight status.",
          description: "Verify the current flight status.",
        }),
        usage: {
          input_tokens: 90,
          output_tokens: 18,
          total_tokens: 108,
        },
      },
      {
        output_text: JSON.stringify({
          steps: [
            {
              instruction: "Enter the flight number and submit the query.",
              intent: "Start the status query.",
              operationApp: "Google Chrome",
            },
          ],
          coveredThroughEventId: "m3",
          summary: "Legacy description should be ignored.",
          usage: ["Legacy when-to-use should be ignored."],
          deliverables: [
            {
              name: "Legacy output",
              description: "Should not be parsed.",
            },
          ],
          preconditions: ["Legacy prerequisite should be ignored."],
          success: ["Legacy success criteria should be ignored."],
          recovery: ["Legacy fallback should be ignored."],
          labels: ["legacy-tag"],
          materials: [
            {
              type: "url",
              name: "Legacy asset",
              value: "https://example.com/legacy",
            },
          ],
        }),
        usage: {
          input_tokens: 180,
          output_tokens: 26,
          total_tokens: 206,
        },
      },
    );

    const root = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-skill-llm-merge-legacy-terminal-"),
    );
    const runDir = path.join(root, "runs", "run-llm-merge-legacy-terminal");
    await mkdir(runDir, { recursive: true });

    const base = Date.parse("2026-03-24T19:10:00.000Z");
    const episode: Episode = {
      id: "run-llm-merge-legacy-terminal-ep-0001",
      runId: "run-llm-merge-legacy-terminal",
      startTs: new Date(base).toISOString(),
      endTs: new Date(base + 4_000).toISOString(),
      durationMs: 4_000,
      eventsCount: 3,
      events: [
        buildEvent({
          id: "m1",
          tsMs: base,
          eventType: "window_focus",
          windowName: "Flight Status",
        }),
        buildEvent({
          id: "m2",
          tsMs: base + 2_000,
          eventType: "text",
          textContent: "UA100",
        }),
        buildEvent({
          id: "m3",
          tsMs: base + 4_000,
          eventType: "ocr",
          textContent: "Flight status page",
        }),
      ],
    };

    await writeFile(
      path.join(runDir, "manifest.json"),
      `${JSON.stringify({ runId: "run-llm-merge-legacy-terminal" })}\n`,
      "utf8",
    );
    await writeFile(
      path.join(runDir, "episodes.json"),
      `${JSON.stringify([episode], null, 2)}\n`,
      "utf8",
    );

    const result = await extractOpenClawSkillLlm({
      runDir,
      apiKey: "test-key",
      baseUrl: "https://api.example.com/v1",
      components: {
        generalization: { enabled: false },
        plannerOptimization: { enabled: false },
      },
      now: new Date("2026-03-24T19:15:00.000Z"),
    });

    expect(result.skill.description).toBe("Confirm the target flight status.");
    expect(result.skill.whenToUse).not.toContain(
      "Legacy when-to-use should be ignored.",
    );
    expect(result.skill.outputs).toEqual([]);
    expect(result.skill.prerequisites).not.toContain(
      "Legacy prerequisite should be ignored.",
    );
    expect(result.skill.successCriteria).not.toContain(
      "Legacy success criteria should be ignored.",
    );
    expect(result.skill.fallback).not.toContain(
      "Legacy fallback should be ignored.",
    );
    expect(result.skill.tags).toEqual([]);
    expect(result.skill.assets).toEqual([]);
  });
});
