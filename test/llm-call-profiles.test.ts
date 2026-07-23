import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  discoverOpenClawWorkflows,
  extractOpenClawSkillLlm,
  requestOpenAiCompatibleJson,
} from "../src/skill/extract-openclaw-llm.js";
import { runDiscoverWorkflows } from "../src/cli/commands/discover-workflows.js";
import type { Episode, NormalizedEvent } from "../src/types/contracts.js";

const queuedResponses = vi.hoisted(
  () => [] as Array<Record<string, unknown> | Response>,
);
const mockedUndiciFetch = vi.hoisted(() => vi.fn());

vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal<typeof import("undici")>();

  return {
    ...actual,
    fetch: mockedUndiciFetch.mockImplementation(async () => {
      const payload = queuedResponses.shift() ?? {
        output_text: JSON.stringify({}),
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15,
        },
      };
      if (payload instanceof actual.Response || payload instanceof Response) {
        return payload;
      }
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
  textContent?: string | null;
  windowName?: string | null;
}): NormalizedEvent {
  return {
    id: input.id,
    source: input.eventType === "ocr" ? "search-ocr" : "ui-events",
    tsIso: new Date(input.tsMs).toISOString(),
    tsMs: input.tsMs,
    appName: "Google Chrome",
    windowName: input.windowName ?? "Call Profile Window",
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

function getReasoningEffort(trace: Record<string, unknown>): string | null {
  const request = trace.request as Record<string, unknown>;
  const body = request.body as Record<string, unknown>;
  const reasoning = body.reasoning as Record<string, unknown> | undefined;
  return typeof reasoning?.effort === "string" ? reasoning.effort : null;
}

function getResponseReadTimeoutMs(
  trace: Record<string, unknown>,
): number | null {
  const request = trace.request as Record<string, unknown>;
  return typeof request.responseReadTimeoutMs === "number"
    ? request.responseReadTimeoutMs
    : null;
}

function getResponseTimeoutMode(trace: Record<string, unknown>): string | null {
  const request = trace.request as Record<string, unknown>;
  return typeof request.responseTimeoutMode === "string"
    ? request.responseTimeoutMode
    : null;
}

function buildResponsesStreamResponse(
  chunks: readonly string[],
  delayMs: number,
): Response {
  const encoder = new TextEncoder();
  const events = [
    ...chunks.map((delta) => ({
      type: "response.output_text.delta",
      delta,
    })),
    {
      type: "response.completed",
      response: {
        usage: {
          input_tokens: 25,
          output_tokens: 10,
          total_tokens: 35,
        },
      },
    },
  ];
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const stop = (): void => {
    closed = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let index = 0;

      const pushNext = () => {
        if (closed) {
          return;
        }
        if (index >= events.length) {
          stop();
          try {
            controller.close();
          } catch {
            // Ignore mock-stream races after the reader has already cancelled.
          }
          return;
        }
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(events[index])}\n\n`),
          );
        } catch {
          stop();
          return;
        }
        index += 1;
        timer = setTimeout(pushNext, delayMs);
      };
      pushNext();
    },
    cancel() {
      // The production reader cancels once it has enough SSE data.
      // The mock needs to stop scheduling more chunks at that point.
      stop();
      return undefined;
    },
  });

  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function getTraceRoleTexts(
  trace: Record<string, unknown>,
  role: string,
): string[] {
  const request = trace.request as Record<string, unknown>;
  const body = request?.body as Record<string, unknown>;
  const input = Array.isArray(body?.input) ? body.input : [];
  return input
    .filter(
      (item): item is Record<string, unknown> =>
        typeof item === "object" &&
        item !== null &&
        (item as Record<string, unknown>).role === role,
    )
    .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
    .map((content) =>
      typeof content === "object" && content !== null
        ? String((content as Record<string, unknown>).text ?? "")
        : "",
    );
}

function getTraceText(trace: Record<string, unknown>): {
  systemText: string;
  userText: string;
} {
  return {
    systemText: getTraceRoleTexts(trace, "system").join("\n"),
    userText: getTraceRoleTexts(trace, "user").join("\n"),
  };
}

function getRequestHeadersFromMockCall(
  call: unknown[] | undefined,
): Record<string, string> {
  const init = (call?.[1] ?? null) as { headers?: HeadersInit } | null;
  return Object.fromEntries(new Headers(init?.headers ?? {}).entries());
}

function getRequestBodyFromMockCall(
  call: unknown[] | undefined,
): Record<string, unknown> {
  const init = (call?.[1] ?? null) as { body?: BodyInit | null } | null;
  if (typeof init?.body !== "string") {
    return {};
  }
  return JSON.parse(init.body) as Record<string, unknown>;
}

describe("llm call profiles", () => {
  beforeEach(() => {
    queuedResponses.splice(0, queuedResponses.length);
    mockedUndiciFetch.mockClear();
    queuedResponses.push(
      {
        output_text: JSON.stringify({
          workflows: [
            {
              workflowId: "workflow-1",
              name: "Test Workflow",
              description: "Used to verify per-call LLM config.",
              goal: "Completeconfig-driven skill .",
              priority: 1,
              confidence: 98,
              startEventId: "e1",
              endEventId: "e4",
              whyThisWorkflow:
                "Covers the full workflow-discovery through generalization chain.",
            },
          ],
        }),
        usage: {
          input_tokens: 120,
          output_tokens: 24,
          total_tokens: 144,
        },
      },
      {
        output_text: JSON.stringify({
          steps: [
            {
              instruction: "OpenGoalPage.",
              intent: "Enterconfig validationWorkflow.",
              operationApp: "Google Chrome",
            },
            {
              instruction: "Page in Status.",
              intent: "Completethis runVerify.",
              operationApp: "Google Chrome",
            },
          ],
          coveredThroughEventId: "e4",
          description: "Used to verify per-call profile whether.",
          whenToUse: [
            "NeedConfirm call  reasoning  and  timeout whether when.",
          ],
          whenNotToUse: [],
          inputs: [],
          outputs: [],
          prerequisites: [],
          successCriteria: [" and OutputGoalStatus."],
          failureModes: [],
          fallback: ["PageComplete, after Retry."],
          examples: [],
          tags: [],
          assets: [],
        }),
        usage: {
          input_tokens: 220,
          output_tokens: 30,
          total_tokens: 250,
        },
      },
      {
        output_text: JSON.stringify({
          scenarios: [
            {
              scenarioId: "scenario-one",
              nextUseHypothesis: "siteanotherRecordStatus.",
            },
          ],
        }),
        usage: {
          input_tokens: 140,
          output_tokens: 26,
          total_tokens: 166,
        },
      },
      {
        output_text: JSON.stringify({
          skillName: "siteRecordStatus",
          goal: "site in oneRecordCurrentStatus.",
          whenToUse: ["Needsitethis StatusVerify when."],
          prerequisites: ["Goalsitepermissions."],
          successCriteria: ["SeeGoalRecordCurrentStatus."],
          fallback: [
            "Recorddoes not exist,ConfirmEnteridentifier after Retry.",
          ],
        }),
        usage: {
          input_tokens: 150,
          output_tokens: 25,
          total_tokens: 175,
        },
      },
      {
        output_text: JSON.stringify({}),
        usage: {
          input_tokens: 90,
          output_tokens: 12,
          total_tokens: 102,
        },
      },
    );
  });

  it("omits Authorization for an explicitly keyless compatible endpoint", async () => {
    queuedResponses.push({
      output_text: JSON.stringify({ ok: true }),
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
      },
    });

    await requestOpenAiCompatibleJson({
      wireApi: "responses",
      baseUrl: "https://api.example.com/v1",
      apiKey: "",
      model: "keyless-model",
      systemPrompt: "Return JSON.",
      userPrompt: "Test keyless access.",
      requestLabel: "keyless-access",
    });

    const headers = getRequestHeadersFromMockCall(
      mockedUndiciFetch.mock.calls[0],
    );
    expect(headers.authorization).toBeUndefined();
    expect(headers["content-type"]).toBe("application/json");
  });

  it("does not retry deterministic 4xx provider errors", async () => {
    queuedResponses.splice(0, queuedResponses.length);
    queuedResponses.push(
      new Response(JSON.stringify({ error: { message: "invalid model" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      requestOpenAiCompatibleJson({
        wireApi: "chat-completions",
        baseUrl: "https://api.example.com/v1",
        apiKey: "test-key",
        model: "missing-model",
        systemPrompt: "Return JSON.",
        userPrompt: "Test deterministic rejection.",
        requestLabel: "no-retry-on-400",
      }),
    ).rejects.toThrow("API error 400");
    expect(mockedUndiciFetch).toHaveBeenCalledTimes(1);
  });

  it("compresses near-duplicate OCR in workflow-discovery prompt events", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-discovery-ocr-compression-"),
    );
    const runDir = path.join(root, "runs", "run-discovery-ocr-compression");
    await mkdir(runDir, { recursive: true });

    const base = Date.parse("2026-03-29T03:00:00.000Z");
    const representativeOcr = [
      "Claim Detail",
      "Claim Number ABC123",
      "Status Submitted",
      "Customer Jordan Lee",
      "Amount 1200",
      "Footer Claim Portal",
    ].join("\n");
    const nearDuplicateOcr = [
      "Claim Detail",
      "Claim Number ABC123",
      "Status Submitted",
      "Customer Jordan Lee",
      "Amount 1200",
      "Footer Claim Portal",
      "Last updated Today",
    ].join("\n");
    const episode: Episode = {
      id: "run-discovery-ocr-compression-ep-0001",
      runId: "run-discovery-ocr-compression",
      startTs: new Date(base).toISOString(),
      endTs: new Date(base + 6_000).toISOString(),
      durationMs: 6_000,
      eventsCount: 4,
      events: [
        buildEvent({ id: "click-1", tsMs: base, eventType: "click" }),
        buildEvent({
          id: "ocr-1",
          tsMs: base + 2_000,
          eventType: "ocr",
          textContent: representativeOcr,
        }),
        buildEvent({
          id: "ocr-2",
          tsMs: base + 4_000,
          eventType: "ocr",
          textContent: nearDuplicateOcr,
        }),
        buildEvent({
          id: "text-1",
          tsMs: base + 6_000,
          eventType: "text",
          textContent: "write claim note",
        }),
      ],
    };

    await writeFile(
      path.join(runDir, "manifest.json"),
      `${JSON.stringify({ runId: "run-discovery-ocr-compression" })}\n`,
      "utf8",
    );
    await writeFile(
      path.join(runDir, "episodes.json"),
      `${JSON.stringify([episode], null, 2)}\n`,
      "utf8",
    );

    queuedResponses.splice(0, queuedResponses.length);
    queuedResponses.push({
      output_text: JSON.stringify({
        workflows: [
          {
            workflowId: "workflow-claim",
            name: "Claim note workflow",
            description: "Review the claim page and write a note.",
            goal: "Capture the latest claim status in a note.",
            priority: 1,
            confidence: 97,
            startEventId: "click-1",
            endEventId: "text-1",
          },
        ],
      }),
      usage: {
        input_tokens: 80,
        output_tokens: 20,
        total_tokens: 100,
      },
    });

    await discoverOpenClawWorkflows({
      runDir,
      apiKey: "test-key",
      baseUrl: "https://api.example.com/v1",
      now: new Date("2026-03-29T03:05:00.000Z"),
    });

    const workflowDiscoveryTrace =
      (await loadTraceRecords(runDir)).find(
        (trace) => String(trace.label ?? "") === "workflow-discovery",
      ) ?? null;
    expect(workflowDiscoveryTrace).not.toBeNull();
    const userText = getTraceRoleTexts(
      workflowDiscoveryTrace as Record<string, unknown>,
      "user",
    ).find((text) => text.startsWith("Recorded workflow evidence;"));
    if (!userText) {
      throw new Error("workflow-discovery trace is missing shared evidence");
    }
    const jsonStart = userText.lastIndexOf("\n[");
    expect(jsonStart).toBeGreaterThanOrEqual(0);
    const promptEvents = JSON.parse(userText.slice(jsonStart + 1)) as Array<{
      id?: string;
      textContent?: string;
      ocrCompression?: Record<string, unknown>;
    }>;
    const firstOcr = promptEvents.find((event) => event.id === "ocr-1");
    const secondOcr = promptEvents.find((event) => event.id === "ocr-2");

    expect(firstOcr?.textContent).toContain("Claim Detail");
    expect(firstOcr?.ocrCompression).toBeUndefined();
    expect(secondOcr?.textContent).toContain("Near-duplicate OCR compressed");
    expect(secondOcr?.textContent).toContain("Last updated Today");
    expect(secondOcr?.textContent).not.toContain("Claim Detail");
    expect(secondOcr?.ocrCompression).toMatchObject({
      mode: "nearDuplicateDelta",
      representativeEventId: "ocr-1",
      retainedDeltaLines: 1,
    });
  });

  it("applies configured reasoning effort and response-read timeout per call", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-llm-call-profiles-"),
    );
    const runDir = path.join(root, "runs", "run-llm-call-profiles");
    await mkdir(runDir, { recursive: true });

    const base = Date.parse("2026-03-29T04:00:00.000Z");
    const episode: Episode = {
      id: "run-llm-call-profiles-ep-0001",
      runId: "run-llm-call-profiles",
      startTs: new Date(base).toISOString(),
      endTs: new Date(base + 6_000).toISOString(),
      durationMs: 6_000,
      eventsCount: 4,
      events: [
        buildEvent({ id: "e1", tsMs: base, eventType: "window_focus" }),
        buildEvent({
          id: "e2",
          tsMs: base + 2_000,
          eventType: "text",
          textContent: "claim status verification",
        }),
        buildEvent({
          id: "e3",
          tsMs: base + 4_000,
          eventType: "ocr",
          textContent: "Current status: In review",
        }),
        buildEvent({ id: "e4", tsMs: base + 6_000, eventType: "click" }),
      ],
    };

    await writeFile(
      path.join(runDir, "manifest.json"),
      `${JSON.stringify({ runId: "run-llm-call-profiles" })}\n`,
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
      reasoningEffort: "xhigh",
      callProfiles: {
        "workflow-discovery": {
          reasoningEffort: "low",
          responseReadTimeoutMs: 91000,
        },
        "skill-extraction-step": {
          reasoningEffort: "medium",
          responseReadTimeoutMs: 92000,
        },
        "skill-extraction-terminal": {
          reasoningEffort: "high",
          responseReadTimeoutMs: 93000,
        },
        "planner-optimization": {
          reasoningEffort: "low",
          responseReadTimeoutMs: 94000,
        },
        "scenario-prediction": {
          reasoningEffort: "medium",
          responseReadTimeoutMs: 123456,
        },
        "scenario-generalization": {
          reasoningEffort: "high",
          responseReadTimeoutMs: 234567,
        },
      },
      now: new Date("2026-03-29T04:10:00.000Z"),
    });

    expect(result.summary.generalization?.scenarioCount).toBe(1);

    const traces = await loadTraceRecords(runDir);
    const workflowDiscoveryTrace =
      traces.find(
        (trace) => String(trace.label ?? "") === "workflow-discovery",
      ) ?? null;
    const callBTerminalTrace =
      traces.find(
        (trace) => String(trace.label ?? "") === "skill-extraction-terminal-01",
      ) ?? null;
    const plannerOptimizationTrace =
      traces.find(
        (trace) => String(trace.label ?? "") === "planner-optimization",
      ) ?? null;
    const scenarioPredictionTrace =
      traces.find(
        (trace) => String(trace.label ?? "") === "scenario-prediction",
      ) ?? null;
    const scenarioGeneralizationTrace =
      traces.find(
        (trace) =>
          String(trace.label ?? "") === "scenario-generalization-scenario-one",
      ) ?? null;

    expect(workflowDiscoveryTrace).not.toBeNull();
    expect(callBTerminalTrace).not.toBeNull();
    expect(plannerOptimizationTrace).not.toBeNull();
    expect(scenarioPredictionTrace).not.toBeNull();
    expect(scenarioGeneralizationTrace).not.toBeNull();

    expect(
      getReasoningEffort(workflowDiscoveryTrace as Record<string, unknown>),
    ).toBe("low");
    expect(
      getResponseReadTimeoutMs(
        workflowDiscoveryTrace as Record<string, unknown>,
      ),
    ).toBe(91000);

    expect(
      getReasoningEffort(callBTerminalTrace as Record<string, unknown>),
    ).toBe("high");
    expect(
      getResponseReadTimeoutMs(callBTerminalTrace as Record<string, unknown>),
    ).toBe(93000);

    expect(
      getReasoningEffort(plannerOptimizationTrace as Record<string, unknown>),
    ).toBe("low");
    expect(
      getResponseReadTimeoutMs(
        plannerOptimizationTrace as Record<string, unknown>,
      ),
    ).toBe(94000);

    expect(
      getReasoningEffort(scenarioPredictionTrace as Record<string, unknown>),
    ).toBe("medium");
    expect(
      getResponseReadTimeoutMs(
        scenarioPredictionTrace as Record<string, unknown>,
      ),
    ).toBe(123456);
    expect(
      getTraceText(scenarioPredictionTrace as Record<string, unknown>).userText,
    ).toContain("Current specific skill JSON");
    expect(
      getTraceText(scenarioPredictionTrace as Record<string, unknown>).userText,
    ).not.toContain("Selected workflow summary");
    expect(
      getTraceText(scenarioPredictionTrace as Record<string, unknown>).userText,
    ).not.toContain("Extraction summary");

    expect(
      getReasoningEffort(
        scenarioGeneralizationTrace as Record<string, unknown>,
      ),
    ).toBe("high");
    expect(
      getResponseReadTimeoutMs(
        scenarioGeneralizationTrace as Record<string, unknown>,
      ),
    ).toBe(234567);
    expect(
      getTraceText(scenarioGeneralizationTrace as Record<string, unknown>)
        .userText,
    ).toContain("Scenario card:");
    expect(
      getTraceText(scenarioGeneralizationTrace as Record<string, unknown>)
        .userText,
    ).toContain("Current specific skill JSON");
    expect(
      getTraceText(scenarioGeneralizationTrace as Record<string, unknown>)
        .userText,
    ).not.toContain("Selected workflow summary");
    expect(
      getTraceText(scenarioGeneralizationTrace as Record<string, unknown>)
        .userText,
    ).not.toContain("Extraction summary");
  });

  it("injects the OpenAI JS client profile headers when configured", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-llm-client-profile-"),
    );
    const runDir = path.join(root, "runs", "run-llm-client-profile");
    await mkdir(runDir, { recursive: true });

    const base = Date.parse("2026-03-29T05:00:00.000Z");
    const episode: Episode = {
      id: "run-llm-client-profile-ep-0001",
      runId: "run-llm-client-profile",
      startTs: new Date(base).toISOString(),
      endTs: new Date(base + 4_000).toISOString(),
      durationMs: 4_000,
      eventsCount: 3,
      events: [
        buildEvent({ id: "e1", tsMs: base, eventType: "window_focus" }),
        buildEvent({
          id: "e2",
          tsMs: base + 2_000,
          eventType: "text",
          textContent: "verify client profile headers",
        }),
        buildEvent({
          id: "e3",
          tsMs: base + 4_000,
          eventType: "ocr",
          textContent: "Current status: ready",
        }),
      ],
    };

    await writeFile(
      path.join(runDir, "manifest.json"),
      `${JSON.stringify({ runId: "run-llm-client-profile" })}\n`,
      "utf8",
    );
    await writeFile(
      path.join(runDir, "episodes.json"),
      `${JSON.stringify([episode], null, 2)}\n`,
      "utf8",
    );

    await extractOpenClawSkillLlm({
      runDir,
      apiKey: "test-key",
      baseUrl: "https://api.example.com/v1",
      wireApi: "responses",
      clientProfile: "openai-js",
      extraHeaders: {
        "X-Test-Client": "test-probe",
      },
      now: new Date("2026-03-29T05:10:00.000Z"),
    });

    const firstCallHeaders = getRequestHeadersFromMockCall(
      mockedUndiciFetch.mock.calls[0],
    );
    expect(firstCallHeaders.accept).toBe("application/json");
    expect(firstCallHeaders.authorization).toBe("Bearer test-key");
    expect(firstCallHeaders["content-type"]).toBe("application/json");
    expect(firstCallHeaders["user-agent"]).toBe("OpenAI/JS 6.26.0");
    expect(firstCallHeaders["x-stainless-lang"]).toBe("js");
    expect(firstCallHeaders["x-stainless-package-version"]).toBe("6.26.0");
    expect(firstCallHeaders["x-stainless-runtime"]).toBe("node");
    expect(firstCallHeaders["x-stainless-retry-count"]).toBe("0");
    expect(firstCallHeaders["x-test-client"]).toBe("test-probe");
  });

  it("injects the Codex Desktop client profile headers when configured", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-llm-codex-profile-"),
    );
    const runDir = path.join(root, "runs", "run-llm-codex-profile");
    await mkdir(runDir, { recursive: true });

    const base = Date.parse("2026-03-29T05:30:00.000Z");
    const episode: Episode = {
      id: "run-llm-codex-profile-ep-0001",
      runId: "run-llm-codex-profile",
      startTs: new Date(base).toISOString(),
      endTs: new Date(base + 4_000).toISOString(),
      durationMs: 4_000,
      eventsCount: 3,
      events: [
        buildEvent({ id: "e1", tsMs: base, eventType: "window_focus" }),
        buildEvent({
          id: "e2",
          tsMs: base + 2_000,
          eventType: "text",
          textContent: "verify codex desktop profile headers",
        }),
        buildEvent({
          id: "e3",
          tsMs: base + 4_000,
          eventType: "ocr",
          textContent: "Current status: ready",
        }),
      ],
    };

    await writeFile(
      path.join(runDir, "manifest.json"),
      `${JSON.stringify({ runId: "run-llm-codex-profile" })}\n`,
      "utf8",
    );
    await writeFile(
      path.join(runDir, "episodes.json"),
      `${JSON.stringify([episode], null, 2)}\n`,
      "utf8",
    );

    await extractOpenClawSkillLlm({
      runDir,
      apiKey: "test-key",
      baseUrl: "https://api.example.com/v1",
      wireApi: "responses",
      clientProfile: "codex-desktop",
      extraHeaders: {
        "X-Test-Client": "test-probe",
      },
      now: new Date("2026-03-29T05:40:00.000Z"),
    });

    const firstCallHeaders = getRequestHeadersFromMockCall(
      mockedUndiciFetch.mock.calls[0],
    );
    expect(firstCallHeaders.accept).toBe("text/event-stream");
    expect(firstCallHeaders.authorization).toBe("Bearer test-key");
    expect(firstCallHeaders["content-type"]).toBe("application/json");
    expect(firstCallHeaders["user-agent"]).toContain("Codex Desktop/0.117.0");
    expect(firstCallHeaders.originator).toBe("Codex Desktop");
    expect(firstCallHeaders["x-client-request-id"]).toBeTruthy();
    expect(firstCallHeaders.session_id).toBe(
      firstCallHeaders["x-client-request-id"],
    );
    expect(firstCallHeaders["x-stainless-lang"]).toBeUndefined();
    expect(firstCallHeaders["x-stainless-package-version"]).toBeUndefined();
    expect(firstCallHeaders["x-test-client"]).toBe("test-probe");

    const turnMetadata = JSON.parse(
      firstCallHeaders["x-codex-turn-metadata"] ?? "{}",
    ) as Record<string, unknown>;
    expect(turnMetadata.session_id).toBe(firstCallHeaders.session_id);
    expect(typeof turnMetadata.turn_id).toBe("string");
    expect(turnMetadata.sandbox).toBe("none");
  });

  it("sends reasoning_effort in chat completions requests", async () => {
    queuedResponses.splice(0, queuedResponses.length);
    queuedResponses.push({
      choices: [
        {
          message: {
            content: JSON.stringify({
              workflows: [
                {
                  workflowId: "workflow-chat-1",
                  name: "Test Workflow",
                  description:
                    "Verify that chat completions forwards reasoning_effort.",
                  goal: "Confirm that the request body includes reasoning_effort.",
                  priority: 1,
                  confidence: 95,
                  startEventId: "e1",
                  endEventId: "e2",
                  whyThisWorkflow:
                    "Covers workflow discovery over chat completions.",
                },
              ],
            }),
          },
        },
      ],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
      },
    });

    const root = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-chat-reasoning-"),
    );
    const runDir = path.join(root, "runs", "run-chat-reasoning");
    await mkdir(runDir, { recursive: true });

    const base = Date.parse("2026-03-29T06:00:00.000Z");
    const episode: Episode = {
      id: "run-chat-reasoning-ep-0001",
      runId: "run-chat-reasoning",
      startTs: new Date(base).toISOString(),
      endTs: new Date(base + 2_000).toISOString(),
      durationMs: 2_000,
      eventsCount: 2,
      events: [
        buildEvent({ id: "e1", tsMs: base, eventType: "window_focus" }),
        buildEvent({
          id: "e2",
          tsMs: base + 2_000,
          eventType: "ocr",
          textContent: "Current status: submitted",
        }),
      ],
    };

    await writeFile(
      path.join(runDir, "manifest.json"),
      `${JSON.stringify({ runId: "run-chat-reasoning" })}\n`,
      "utf8",
    );
    await writeFile(
      path.join(runDir, "episodes.json"),
      `${JSON.stringify([episode], null, 2)}\n`,
      "utf8",
    );

    await discoverOpenClawWorkflows({
      runDir,
      apiKey: "test-key",
      baseUrl: "https://api.example.com/v1",
      wireApi: "chat-completions",
      reasoningEffort: "high",
      now: new Date("2026-03-29T06:05:00.000Z"),
    });

    const firstCallBody = getRequestBodyFromMockCall(
      mockedUndiciFetch.mock.calls[0],
    );
    expect(firstCallBody.reasoning_effort).toBe("high");
    expect(firstCallBody.reasoning).toBeUndefined();
  });

  it("supports idle response timeouts for streamed responses without regressing fixed timeouts", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-stream-timeout-mode-"),
    );
    const runDir = path.join(root, "runs", "run-stream-timeout-mode");
    await mkdir(runDir, { recursive: true });

    const base = Date.parse("2026-03-29T07:00:00.000Z");
    const episode: Episode = {
      id: "run-stream-timeout-mode-ep-0001",
      runId: "run-stream-timeout-mode",
      startTs: new Date(base).toISOString(),
      endTs: new Date(base + 2_000).toISOString(),
      durationMs: 2_000,
      eventsCount: 2,
      events: [
        buildEvent({ id: "e1", tsMs: base, eventType: "window_focus" }),
        buildEvent({
          id: "e2",
          tsMs: base + 2_000,
          eventType: "ocr",
          textContent: "Current status: submitted",
        }),
      ],
    };

    await writeFile(
      path.join(runDir, "manifest.json"),
      `${JSON.stringify({ runId: "run-stream-timeout-mode" })}\n`,
      "utf8",
    );
    await writeFile(
      path.join(runDir, "episodes.json"),
      `${JSON.stringify([episode], null, 2)}\n`,
      "utf8",
    );

    const streamedWorkflowText = JSON.stringify({
      workflows: [
        {
          workflowId: "workflow-stream-1",
          name: "Streamed Workflow",
          description: "Verifies idle timeout mode for streamed output.",
          goal: "Wait for streamed output without timing out mid-response.",
          priority: 1,
          confidence: 94,
          startEventId: "e1",
          endEventId: "e2",
          whyThisWorkflow: "The response is streamed across multiple chunks.",
        },
      ],
    });
    const streamedChunks = [
      streamedWorkflowText.slice(0, 50),
      streamedWorkflowText.slice(50, 110),
      streamedWorkflowText.slice(110),
    ];

    queuedResponses.splice(0, queuedResponses.length);
    queuedResponses.push(
      buildResponsesStreamResponse(streamedChunks, 1_000),
      buildResponsesStreamResponse(streamedChunks, 20),
    );

    await expect(
      discoverOpenClawWorkflows({
        runDir,
        apiKey: "test-key",
        baseUrl: "https://api.example.com/v1",
        wireApi: "responses",
        responseReadTimeoutMs: 30,
        responseTimeoutMode: "fixed",
        now: new Date("2026-03-29T07:05:00.000Z"),
      }),
    ).rejects.toThrow(/timed out/i);

    const result = await discoverOpenClawWorkflows({
      runDir,
      apiKey: "test-key",
      baseUrl: "https://api.example.com/v1",
      wireApi: "responses",
      responseReadTimeoutMs: 100,
      responseTimeoutMode: "idle",
      now: new Date("2026-03-29T07:06:00.000Z"),
    });

    expect(result.workflowCandidates).toHaveLength(1);
    expect(result.workflowCandidates[0]?.name).toBe("Streamed Workflow");

    const traces = await loadTraceRecords(runDir);
    const latestTrace = traces.at(-1) ?? null;
    expect(latestTrace).not.toBeNull();
    expect(
      getResponseReadTimeoutMs(latestTrace as Record<string, unknown>),
    ).toBe(100);
    expect(getResponseTimeoutMode(latestTrace as Record<string, unknown>)).toBe(
      "idle",
    );
  });

  it("propagates global timeout config through the workflow discovery command adapter", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-discovery-command-timeout-"),
    );
    const runDir = path.join(root, "runs", "run-discovery-command-timeout");
    const configPath = path.join(root, "llm.json");
    await mkdir(runDir, { recursive: true });

    const base = Date.parse("2026-03-29T08:00:00.000Z");
    const episode: Episode = {
      id: "run-discovery-command-timeout-ep-0001",
      runId: "run-discovery-command-timeout",
      startTs: new Date(base).toISOString(),
      endTs: new Date(base + 2_000).toISOString(),
      durationMs: 2_000,
      eventsCount: 2,
      events: [
        buildEvent({ id: "e1", tsMs: base, eventType: "window_focus" }),
        buildEvent({
          id: "e2",
          tsMs: base + 2_000,
          eventType: "ocr",
          textContent: "Current status: submitted",
        }),
      ],
    };

    await writeFile(
      path.join(runDir, "manifest.json"),
      `${JSON.stringify({ runId: "run-discovery-command-timeout" })}\n`,
      "utf8",
    );
    await writeFile(
      path.join(runDir, "episodes.json"),
      `${JSON.stringify([episode], null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          mode: "openai-compatible",
          baseUrl: "https://api.example.com/v1",
          wireApi: "responses",
          model: "gpt-test",
          responseReadTimeoutMs: 180000,
          responseTimeoutMode: "idle",
          apiKey: "test-key",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const result = await runDiscoverWorkflows({
      runDir,
      outPath: path.join(runDir, "workflow-discovery.json"),
      configPath,
      now: new Date("2026-03-29T08:05:00.000Z"),
    });

    expect(result.workflowCandidates).toHaveLength(1);
    const traces = await loadTraceRecords(runDir);
    const latestTrace = traces.at(-1) ?? null;
    expect(latestTrace).not.toBeNull();
    expect(
      getResponseReadTimeoutMs(latestTrace as Record<string, unknown>),
    ).toBe(180000);
    expect(getResponseTimeoutMode(latestTrace as Record<string, unknown>)).toBe(
      "idle",
    );
  });
});
