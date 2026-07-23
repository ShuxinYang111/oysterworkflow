import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const queuedResponses = vi.hoisted(() => [] as Array<Record<string, unknown>>);

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
    fetch: vi.fn(async () => {
      const payload = queuedResponses.shift() ?? {
        output_text: JSON.stringify({}),
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15,
        },
      };
      return new actual.Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  };
});

import { extractOpenClawSkillLlm } from "../src/skill/extract-openclaw-llm.js";
import type { Episode, NormalizedEvent } from "../src/types/contracts.js";

function buildEvent(input: {
  id: string;
  tsMs: number;
  eventType?: NormalizedEvent["eventType"];
  textContent?: string | null;
  windowName?: string | null;
  appName?: string | null;
  browserUrl?: string | null;
}): NormalizedEvent {
  return {
    id: input.id,
    source: input.eventType === "ocr" ? "search-ocr" : "ui-events",
    tsIso: new Date(input.tsMs).toISOString(),
    tsMs: input.tsMs,
    appName: input.appName ?? "Google Chrome",
    windowName: input.windowName ?? "Chunking Test Window",
    eventType: input.eventType ?? "text",
    textContent: input.textContent ?? null,
    x: null,
    y: null,
    keyCode: null,
    modifiers: null,
    browserUrl: input.browserUrl ?? null,
    frameId: null,
    rawRef: {
      file: "/tmp/events.ndjson",
      line: 1,
    },
  };
}

async function writeRunFixture(
  runDir: string,
  episode: Episode,
): Promise<void> {
  await mkdir(runDir, { recursive: true });
  await writeFile(
    path.join(runDir, "manifest.json"),
    `${JSON.stringify({ runId: episode.runId })}\n`,
    "utf8",
  );
  await writeFile(
    path.join(runDir, "episodes.json"),
    `${JSON.stringify([episode], null, 2)}\n`,
    "utf8",
  );
}

async function loadTraceRecords(
  runDir: string,
): Promise<Record<string, unknown>[]> {
  const traceDir = path.join(runDir, "llm-trace");
  const files = (await readdir(traceDir))
    .filter((entry) => entry.endsWith(".json"))
    .sort();
  return Promise.all(
    files.map(
      async (file) =>
        JSON.parse(await readFile(path.join(traceDir, file), "utf8")) as Record<
          string,
          unknown
        >,
    ),
  );
}

function getTraceUserText(trace: Record<string, unknown>): string {
  const request = trace.request as Record<string, unknown>;
  const body = request.body as Record<string, unknown>;
  const input = Array.isArray(body.input) ? body.input : [];
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

describe("extractOpenClawSkillLlm chunked call B", () => {
  beforeEach(() => {
    queuedResponses.splice(0, queuedResponses.length);
  });

  it("splits long call B input into multiple step chunks and keeps each chunk under the token budget", async () => {
    queuedResponses.push(
      {
        output_text: JSON.stringify({
          skillName: "long traceTest Skill",
          goal: "Completelong traceWorkflow.",
        }),
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          total_tokens: 120,
        },
      },
      {
        output_text: JSON.stringify({
          steps: [
            {
              instruction: "Completefirst halfWorkflow.",
              intent: "long trace.",
              operationApp: "Google Chrome",
            },
          ],
          coveredThroughEventId: "c16",
        }),
        usage: {
          input_tokens: 200,
          output_tokens: 30,
          total_tokens: 230,
        },
      },
      {
        output_text: JSON.stringify({
          steps: [
            {
              instruction: "Completesecond halfWorkflow.",
              intent: "long trace after .",
              operationApp: "Google Chrome",
            },
          ],
          coveredThroughEventId: "c20",
        }),
        usage: {
          input_tokens: 180,
          output_tokens: 28,
          total_tokens: 208,
        },
      },
      {
        output_text: JSON.stringify({
          steps: [
            {
              instruction: "Completesecond halfWorkflow.",
              intent: "long trace after .",
              operationApp: "Google Chrome",
            },
          ],
          coveredThroughEventId: "c20",
          description: "Used to verifylong tracechunked continuation.",
          whenToUse: ["Needverify call B chunking."],
          whenNotToUse: [],
          inputs: [],
          outputs: [],
          prerequisites: [],
          successCriteria: ["The workflow is fully split and outputs steps."],
          failureModes: [],
          fallback: [],
          examples: [],
          tags: [],
          assets: [],
        }),
        usage: {
          input_tokens: 160,
          output_tokens: 24,
          total_tokens: 184,
        },
      },
    );

    const root = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-skill-llm-chunking-"),
    );
    const runDir = path.join(root, "runs", "run-llm-chunking");
    const base = Date.parse("2026-03-24T20:00:00.000Z");
    const longText = "chunk-budget-check-".repeat(1_100);
    const episode: Episode = {
      id: "run-llm-chunking-ep-0001",
      runId: "run-llm-chunking",
      startTs: new Date(base).toISOString(),
      endTs: new Date(base + 19_000).toISOString(),
      durationMs: 19_000,
      eventsCount: 20,
      events: Array.from({ length: 20 }, (_, index) =>
        buildEvent({
          id: `c${index + 1}`,
          tsMs: base + index * 1_000,
          textContent: `${index + 1}:${longText}`,
          windowName: `Chunking Window ${index + 1}`,
        }),
      ),
    };
    await writeRunFixture(runDir, episode);

    const result = await extractOpenClawSkillLlm({
      runDir,
      apiKey: "test-key",
      baseUrl: "https://api.example.com/v1",
      components: {
        generalization: { enabled: false },
        plannerOptimization: { enabled: false },
      },
      now: new Date("2026-03-24T20:10:00.000Z"),
    });

    expect(result.skill.steps.length).toBeGreaterThanOrEqual(2);
    const traces = await loadTraceRecords(runDir);
    const stepOne =
      traces.find(
        (trace) => String(trace.label) === "skill-extraction-step-01",
      ) ?? null;
    const terminalTrace =
      traces.find((trace) =>
        String(trace.label).startsWith("skill-extraction-terminal-"),
      ) ?? null;
    expect(stepOne).not.toBeNull();
    expect(terminalTrace).not.toBeNull();
    expect(
      (stepOne?.meta as Record<string, unknown>)?.estimatedInputTokens,
    ).toBeLessThanOrEqual(97_000);
    expect(
      (terminalTrace?.meta as Record<string, unknown>)?.estimatedInputTokens,
    ).toBeLessThanOrEqual(97_000);
    for (const trace of traces.filter((item) =>
      String(item.label).startsWith("skill-extraction-"),
    )) {
      expect(
        (trace.meta as Record<string, unknown>)?.estimatedInputTokens,
      ).toBeLessThanOrEqual(97_000);
    }

    const terminalUserText = getTraceUserText(
      terminalTrace as Record<string, unknown>,
    );
    expect(terminalUserText).toContain('"id": "c11"');
    expect(terminalUserText).toContain('"id": "c17"');
    expect(terminalUserText).toContain(
      "Current mode: skill-extraction-terminal",
    );
    expect(terminalUserText).toContain(
      "steps, assets, references, coveredThroughEventId, coveredThroughTsMs, shortDescription, description, whenToUse, whenNotToUse, inputs, outputs, prerequisites, successCriteria, failureModes, fallback, examples, tags",
    );
    expect(terminalUserText).toContain(
      "The last event ID in the current terminal chunk is: c20",
    );
  });

  it("falls back to the chunk end when coveredThroughEventId is invalid", async () => {
    queuedResponses.push(
      {
        output_text: JSON.stringify({
          skillName: "Cursor Fallback Skill",
          goal: "Verify cursor fallback.",
        }),
        usage: {
          input_tokens: 101,
          output_tokens: 19,
          total_tokens: 120,
        },
      },
      {
        output_text: JSON.stringify({
          steps: [
            {
              instruction: "Read page information.",
              intent: "Verify the cursor fallback logic.",
              operationApp: "Google Chrome",
            },
          ],
          coveredThroughEventId: "missing-event",
        }),
        usage: {
          input_tokens: 120,
          output_tokens: 22,
          total_tokens: 142,
        },
      },
      {
        output_text: JSON.stringify({
          steps: [
            {
              instruction: "Complete the tail-end workflow.",
              intent: "second halfWorkflow.",
              operationApp: "Google Chrome",
            },
          ],
          coveredThroughEventId: "f20",
          description:
            "Used to verifythe fallback logic for an invalid cursor.",
          whenToUse: ["Needverifying cursor fallback."],
          whenNotToUse: [],
          inputs: [],
          outputs: [],
          prerequisites: [],
          successCriteria: [
            "Even if the cursor is invalid, processing can still advance to the end of the chunk.",
          ],
          failureModes: [],
          fallback: [],
          examples: [],
          tags: [],
          assets: [],
        }),
        usage: {
          input_tokens: 80,
          output_tokens: 18,
          total_tokens: 98,
        },
      },
    );

    const root = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-skill-llm-cursor-fallback-"),
    );
    const runDir = path.join(root, "runs", "run-llm-cursor-fallback");
    const base = Date.parse("2026-03-24T21:00:00.000Z");
    const longText = "cursor-fallback-".repeat(1_100);
    const episode: Episode = {
      id: "run-llm-cursor-fallback-ep-0001",
      runId: "run-llm-cursor-fallback",
      startTs: new Date(base).toISOString(),
      endTs: new Date(base + 19_000).toISOString(),
      durationMs: 19_000,
      eventsCount: 20,
      events: Array.from({ length: 20 }, (_, index) =>
        buildEvent({
          id: index === 19 ? "f20" : `f${index + 1}`,
          tsMs: base + index * 1_000,
          textContent: `${index + 1}:${longText}`,
          windowName: "Cursor Fallback Window",
        }),
      ),
    };
    await writeRunFixture(runDir, episode);

    const result = await extractOpenClawSkillLlm({
      runDir,
      apiKey: "test-key",
      baseUrl: "https://api.example.com/v1",
      components: {
        generalization: { enabled: false },
        plannerOptimization: { enabled: false },
      },
      now: new Date("2026-03-24T21:10:00.000Z"),
    });

    expect(
      result.summary.warnings.some((warning) =>
        warning.includes("invalid coveredThroughEventId"),
      ),
    ).toBe(true);
    const traces = await loadTraceRecords(runDir);
    const stepTrace =
      traces.find(
        (trace) => String(trace.label) === "skill-extraction-step-01",
      ) ?? null;
    expect(stepTrace).not.toBeNull();
    expect(
      (stepTrace?.meta as Record<string, unknown>)?.returnedCursorEventId,
    ).toBe("missing-event");
    expect(
      (stepTrace?.meta as Record<string, unknown>)?.usedFallbackCursor,
    ).toBe(true);
  });

  it("allows a chunk to advance without emitting new steps", async () => {
    queuedResponses.push(
      {
        output_text: JSON.stringify({
          skillName: "Empty Step Chunk Skill",
          goal: "Verify that an empty-step chunk does not interrupt the workflow.",
        }),
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          total_tokens: 120,
        },
      },
      {
        output_text: JSON.stringify({
          steps: [
            {
              instruction: "Complete the main operation.",
              intent: "first halfkeyStep.",
              operationApp: "Google Chrome",
            },
          ],
          coveredThroughEventId: "z16",
        }),
        usage: {
          input_tokens: 200,
          output_tokens: 30,
          total_tokens: 230,
        },
      },
      {
        output_text: JSON.stringify({
          steps: [],
          coveredThroughEventId: "z20",
          description: "Used to verifyfault tolerance for an empty-step chunk.",
          whenToUse: ["Needverifying an empty-step chunk."],
          whenNotToUse: [],
          inputs: [],
          outputs: [],
          prerequisites: [],
          successCriteria: [
            "An empty-step chunk can still advance and complete the final skill.",
          ],
          failureModes: [],
          fallback: [],
          examples: [],
          tags: [],
          assets: [],
        }),
        usage: {
          input_tokens: 180,
          output_tokens: 20,
          total_tokens: 200,
        },
      },
    );

    const root = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-skill-llm-empty-step-chunk-"),
    );
    const runDir = path.join(root, "runs", "run-llm-empty-step-chunk");
    const base = Date.parse("2026-03-24T22:00:00.000Z");
    const longText = "empty-step-chunk-".repeat(1_100);
    const episode: Episode = {
      id: "run-llm-empty-step-chunk-ep-0001",
      runId: "run-llm-empty-step-chunk",
      startTs: new Date(base).toISOString(),
      endTs: new Date(base + 19_000).toISOString(),
      durationMs: 19_000,
      eventsCount: 20,
      events: Array.from({ length: 20 }, (_, index) =>
        buildEvent({
          id: `z${index + 1}`,
          tsMs: base + index * 1_000,
          textContent: `${index + 1}:${longText}`,
          windowName: `Empty Step Chunk Window ${index + 1}`,
        }),
      ),
    };
    await writeRunFixture(runDir, episode);

    const result = await extractOpenClawSkillLlm({
      runDir,
      apiKey: "test-key",
      baseUrl: "https://api.example.com/v1",
      components: {
        generalization: { enabled: false },
        plannerOptimization: { enabled: false },
      },
      now: new Date("2026-03-24T22:10:00.000Z"),
    });

    expect(result.skill.steps).toHaveLength(1);
    expect(
      result.summary.warnings.some((warning) =>
        warning.includes("returned no new steps"),
      ),
    ).toBe(true);
    const traces = await loadTraceRecords(runDir);
    const stepTwo =
      traces.find(
        (trace) => String(trace.label) === "skill-extraction-terminal-02",
      ) ?? null;
    expect(stepTwo).not.toBeNull();
    expect(
      (stepTwo?.meta as Record<string, unknown>)?.returnedCursorEventId,
    ).toBe("z20");
    expect((stepTwo?.meta as Record<string, unknown>)?.usedFallbackCursor).toBe(
      false,
    );
  });

  it("compresses near-duplicate OCR in call B prompt while preserving new representatives", async () => {
    queuedResponses.push(
      {
        output_text: JSON.stringify({
          skillName: "OCR Compression Skill",
          goal: "Verify OCR prompt compression.",
        }),
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          total_tokens: 120,
        },
      },
      {
        output_text: JSON.stringify({
          steps: [
            {
              instruction: "Review OCR-backed page changes.",
              intent: "Verify near duplicate OCR handling.",
              operationApp: "Google Chrome",
            },
          ],
          coveredThroughEventId: "n5",
          description: "Used to verify OCR prompt compression.",
          whenToUse: ["Need to verify OCR near duplicate compression."],
          whenNotToUse: [],
          inputs: [],
          outputs: [],
          prerequisites: [],
          successCriteria: ["Near duplicate OCR is compact in the prompt."],
          failureModes: [],
          fallback: [],
          examples: [],
          tags: [],
          assets: [],
        }),
        usage: {
          input_tokens: 200,
          output_tokens: 30,
          total_tokens: 230,
        },
      },
    );

    const root = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-skill-llm-ocr-compress-"),
    );
    const runDir = path.join(root, "runs", "run-llm-ocr-compress");
    const base = Date.parse("2026-03-24T23:00:00.000Z");
    const representativeText = [
      "Course Index",
      "Week 1",
      "Learning Activities and Materials",
      "Chapter 1 PDF",
      "Watch Intro Video",
      "Discussion Forum",
      "Reading Checklist",
    ].join("\n");
    const nearDuplicateWithDelta = [
      "Course Index",
      "Week 1",
      "Learning Activities and Materials",
      "Chapter 1 PDF",
      "Watch Intro Video",
      "Download Chapter 1",
      "Reading Checklist",
    ].join("\n");
    const unrelatedText = [
      "Finder",
      "Applications",
      "Documents",
      "Downloads",
      "Desktop",
      "Recent Files",
    ].join("\n");
    const episode: Episode = {
      id: "run-llm-ocr-compress-ep-0001",
      runId: "run-llm-ocr-compress",
      startTs: new Date(base).toISOString(),
      endTs: new Date(base + 4_000).toISOString(),
      durationMs: 4_000,
      eventsCount: 5,
      events: [
        buildEvent({
          id: "n1",
          tsMs: base,
          eventType: "ocr",
          textContent: representativeText,
          windowName: "Moodle Week",
          browserUrl: "https://moodle.example.edu/course/week-1",
        }),
        buildEvent({
          id: "n2",
          tsMs: base + 1_000,
          eventType: "ocr",
          textContent: nearDuplicateWithDelta,
          windowName: "Moodle Week",
          browserUrl: "https://moodle.example.edu/course/week-1?view=download",
        }),
        buildEvent({
          id: "n3",
          tsMs: base + 2_000,
          eventType: "ocr",
          textContent: representativeText,
          windowName: "Moodle Week",
          browserUrl: "https://moodle.example.edu/course/week-1",
        }),
        buildEvent({
          id: "n4",
          tsMs: base + 3_000,
          eventType: "ocr",
          textContent: unrelatedText,
          windowName: "Finder",
          appName: "Finder",
        }),
        buildEvent({
          id: "n5",
          tsMs: base + 4_000,
          eventType: "text",
          textContent: "finish",
        }),
      ],
    };
    await writeRunFixture(runDir, episode);

    await extractOpenClawSkillLlm({
      runDir,
      apiKey: "test-key",
      baseUrl: "https://api.example.com/v1",
      components: {
        generalization: { enabled: false },
        plannerOptimization: { enabled: false },
      },
      now: new Date("2026-03-24T23:10:00.000Z"),
    });

    const traces = await loadTraceRecords(runDir);
    const terminalTrace =
      traces.find(
        (trace) => String(trace.label) === "skill-extraction-terminal-01",
      ) ?? null;
    expect(terminalTrace).not.toBeNull();
    const userText = getTraceUserText(terminalTrace as Record<string, unknown>);

    expect(userText).toContain('"id": "n1"');
    expect(userText).toContain("Discussion Forum");
    expect(userText).toContain('"id": "n2"');
    expect(userText).toContain("Near-duplicate OCR compressed");
    expect(userText).toContain("representativeEventId=n1");
    expect(userText).toContain("Download Chapter 1");
    expect(userText).not.toContain(
      '"textContent": "Course Index\\nWeek 1\\nLearning Activities and Materials\\nChapter 1 PDF\\nWatch Intro Video\\nDownload Chapter 1\\nReading Checklist"',
    );
    expect(userText).toContain('"id": "n3"');
    expect(userText).toContain("No meaningful new OCR lines.");
    expect(userText).toContain('"ocrCompression"');
    expect(userText).toContain('"retainedDeltaLines": 0');
    expect(userText).toContain('"id": "n4"');
    expect(userText).toContain("Recent Files");
    expect(userText).not.toContain("representativeEventId=n4");
  });

  it("limits OCR representative comparisons to the recent candidate cap", async () => {
    queuedResponses.push(
      {
        output_text: JSON.stringify({
          skillName: "OCR Candidate Cap Skill",
          goal: "Verify OCR representative candidate cap.",
        }),
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          total_tokens: 120,
        },
      },
      {
        output_text: JSON.stringify({
          steps: [
            {
              instruction: "Review capped OCR representative candidates.",
              intent: "Verify old representatives are not compared forever.",
              operationApp: "Google Chrome",
            },
          ],
          coveredThroughEventId: "p23",
          description: "Used to verify OCR candidate cap.",
          whenToUse: ["Need to verify OCR candidate cap."],
          whenNotToUse: [],
          inputs: [],
          outputs: [],
          prerequisites: [],
          successCriteria: ["Only recent OCR representatives are compared."],
          failureModes: [],
          fallback: [],
          examples: [],
          tags: [],
          assets: [],
        }),
        usage: {
          input_tokens: 200,
          output_tokens: 30,
          total_tokens: 230,
        },
      },
    );

    const root = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-skill-llm-ocr-cap-"),
    );
    const runDir = path.join(root, "runs", "run-llm-ocr-cap");
    const base = Date.parse("2026-03-25T00:00:00.000Z");
    const buildPageText = (page: number): string =>
      Array.from(
        { length: 6 },
        (_, index) => `unique-page-${page}-line-${index + 1}`,
      ).join("\n");
    const pageOneText = buildPageText(1);
    const episode: Episode = {
      id: "run-llm-ocr-cap-ep-0001",
      runId: "run-llm-ocr-cap",
      startTs: new Date(base).toISOString(),
      endTs: new Date(base + 22_000).toISOString(),
      durationMs: 22_000,
      eventsCount: 23,
      events: [
        ...Array.from({ length: 22 }, (_, index) =>
          buildEvent({
            id: `p${index + 1}`,
            tsMs: base + index * 1_000,
            eventType: "ocr",
            textContent: buildPageText(index + 1),
            windowName: "Candidate Cap Window",
          }),
        ),
        buildEvent({
          id: "p23",
          tsMs: base + 22_000,
          eventType: "ocr",
          textContent: pageOneText,
          windowName: "Candidate Cap Window",
        }),
      ],
    };
    await writeRunFixture(runDir, episode);

    await extractOpenClawSkillLlm({
      runDir,
      apiKey: "test-key",
      baseUrl: "https://api.example.com/v1",
      components: {
        generalization: { enabled: false },
        plannerOptimization: { enabled: false },
      },
      now: new Date("2026-03-25T00:10:00.000Z"),
    });

    const traces = await loadTraceRecords(runDir);
    const terminalTrace =
      traces.find(
        (trace) => String(trace.label) === "skill-extraction-terminal-01",
      ) ?? null;
    expect(terminalTrace).not.toBeNull();
    const userText = getTraceUserText(terminalTrace as Record<string, unknown>);

    expect(userText).toContain('"id": "p1"');
    expect(userText).toContain('"id": "p23"');
    expect(userText).toContain("unique-page-1-line-6");
    expect(userText).not.toContain("representativeEventId=p1");
    expect(userText).not.toContain("Near-duplicate OCR compressed");
  });
});
