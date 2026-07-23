import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { extractOpenClawSkillLlm } from "../src/skill/extract-openclaw-llm.js";
import type { Episode, NormalizedEvent } from "../src/types/contracts.js";

const requests = vi.hoisted(() => [] as Array<unknown>);

vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal<typeof import("undici")>();
  const callADraft = {
    name: "Test Skill",
    goal: "CompleteWorkflow",
    description: "CompleteWorkflow",
  };
  const callBTerminalDraft = {
    steps: [
      {
        instruction: "",
        intent: "EnterWorkflow",
        operationApp: "Google Chrome",
      },
      {
        instruction: "Enter and ",
        intent: "CompleteEnter",
        operationApp: "Google Chrome",
      },
    ],
    coveredThroughEventId: "e5",
    coveredThroughTsMs: Date.parse("2026-03-04T00:00:03.400Z"),
    description: "Draft used for trace validation",
    whenToUse: ["Need trace Record when"],
    whenNotToUse: [],
    inputs: [],
    outputs: [],
    prerequisites: [],
    successCriteria: ["SeeConfirm"],
    failureModes: [],
    fallback: [],
    examples: [],
    tags: [],
    assets: [],
  };
  const call3CandidateDraft = {
    name: "Test Skill",
    goal: "CompleteWorkflow",
    entryNodeId: "enter-workflow",
    nodes: [
      {
        id: "enter-workflow",
        type: "action",
        title: "Enter workflow",
        objective: "EnterWorkflow",
        act: ["Open the workflow"],
        operationApp: "Google Chrome",
        hints: [],
      },
      {
        id: "workflow-complete",
        type: "terminal",
        title: "Workflow complete",
        outcome: "completed",
        summary: "SeeConfirm",
        hints: [],
      },
    ],
    transitions: [
      {
        id: "enter-to-complete",
        from: "enter-workflow",
        to: "workflow-complete",
        type: "default",
      },
    ],
  };

  return {
    ...actual,
    fetch: vi.fn(async (_url: string, init?: { body?: string }) => {
      const bodyText = typeof init?.body === "string" ? init.body : "";
      const bodyJson = bodyText ? JSON.parse(bodyText) : null;
      const requestIndex = requests.length + 1;
      requests.push(bodyJson);
      const payload = {
        output_text: JSON.stringify(
          requestIndex === 1
            ? callADraft
            : requestIndex === 2
              ? callBTerminalDraft
              : requestIndex === 4
                ? call3CandidateDraft
                : requestIndex === 5
                  ? {
                      decision: "new_family",
                      matchedWorkflowId: null,
                    }
                  : {},
        ),
        usage:
          requestIndex === 1
            ? {
                input_tokens: 111,
                output_tokens: 17,
                total_tokens: 128,
                input_tokens_details: { cached_tokens: 3 },
                output_tokens_details: { reasoning_tokens: 5 },
              }
            : requestIndex === 2
              ? {
                  input_tokens: 222,
                  output_tokens: 29,
                  total_tokens: 251,
                  input_tokens_details: { cached_tokens: 7 },
                  output_tokens_details: { reasoning_tokens: 11 },
                }
              : {
                  input_tokens: 144,
                  output_tokens: 19,
                  total_tokens: 163,
                  input_tokens_details: { cached_tokens: 5 },
                  output_tokens_details: { reasoning_tokens: 9 },
                },
      };
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
  x?: number | null;
  y?: number | null;
  keyCode?: number | null;
  modifiers?: number | null;
  browserUrl?: string | null;
  frameId?: number | null;
}): NormalizedEvent {
  return {
    id: input.id,
    source: input.eventType === "ocr" ? "search-ocr" : "ui-events",
    tsIso: new Date(input.tsMs).toISOString(),
    tsMs: input.tsMs,
    appName: input.appName ? input.appName : "Google Chrome",
    windowName:
      input.windowName === undefined ? "Trace Window" : input.windowName,
    eventType: input.eventType,
    textContent: input.textContent ? input.textContent : null,
    x: input.x === undefined ? null : input.x,
    y: input.y === undefined ? null : input.y,
    keyCode: input.keyCode === undefined ? null : input.keyCode,
    modifiers: input.modifiers === undefined ? null : input.modifiers,
    browserUrl: input.browserUrl === undefined ? null : input.browserUrl,
    frameId: input.frameId === undefined ? null : input.frameId,
    rawRef: {
      file: "/tmp/events.ndjson",
      line: 1,
    },
  };
}

function collectUnresolvedPlaceholders(text: string): string[] {
  return Array.from(text.matchAll(/{{\s*([^}]+)\s*}}/g))
    .map((match) => match[1].trim())
    .filter((token) => token !== "...");
}

function getTraceText(trace: Record<string, unknown>): {
  systemText: string;
  userText: string;
} {
  const request = trace.request as Record<string, unknown>;
  const body = request?.body as Record<string, unknown>;
  const input = Array.isArray(body?.input) ? body?.input : [];
  const collectRoleText = (role: string): string =>
    input
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
      )
      .join("\n");
  return {
    systemText: collectRoleText("system"),
    userText: collectRoleText("user"),
  };
}

describe("llm trace recording", () => {
  beforeEach(() => {
    requests.splice(0, requests.length);
  });

  it("records prompt meta and rendered prompts", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-llm-trace-"),
    );
    const runDir = path.join(root, "runs", "run-llm-trace");
    await mkdir(runDir, { recursive: true });

    const base = Date.parse("2026-03-04T00:00:00.000Z");
    const longOcr =
      "ClaimStatus 12345  when 48  when please keep this OCR text so key information is not missed "
        .repeat(4)
        .trim();
    const symbolHeavyOcr =
      "02-15 3245 ## ** 137.35E / 9/18/58:14 +++ @@ 0001 8888";
    const episode: Episode = {
      id: "run-llm-trace-ep-0001",
      runId: "run-llm-trace",
      startTs: new Date(base).toISOString(),
      endTs: new Date(base + 4_000).toISOString(),
      durationMs: 4_000,
      eventsCount: 5,
      events: [
        buildEvent({ id: "e1", tsMs: base, eventType: "click" }),
        buildEvent({
          id: "e2",
          tsMs: base + 2_000,
          eventType: "text",
          windowName:
            "Trace Window For A Very Long Flow Name That Should Stay Fully Visible",
          textContent:
            "trace input with a deliberately long sentence that should remain intact in Call B",
          x: 1280,
          y: 720,
          keyCode: 13,
          modifiers: 2,
          browserUrl:
            "https://example.com/really/long/path/that/should/not/be/truncated/by/call-b?query=trace-check",
          frameId: 42,
        }),
        buildEvent({
          id: "e3",
          tsMs: base + 3_000,
          eventType: "text",
          textContent: "npm run dev -- extract-skill",
        }),
        buildEvent({
          id: "e4",
          tsMs: base + 3_200,
          eventType: "ocr",
          textContent: longOcr,
        }),
        buildEvent({
          id: "e5",
          tsMs: base + 3_400,
          eventType: "ocr",
          textContent: symbolHeavyOcr,
        }),
      ],
    };

    await writeFile(
      path.join(runDir, "manifest.json"),
      JSON.stringify({ runId: "run-llm-trace" }) + "\n",
      "utf8",
    );
    await writeFile(
      path.join(runDir, "episodes.json"),
      JSON.stringify([episode], null, 2) + "\n",
      "utf8",
    );

    await extractOpenClawSkillLlm({
      runDir,
      apiKey: "test-key",
      baseUrl: "https://api.example.com/v1",
      components: {
        generalization: { enabled: false },
        plannerOptimization: { enabled: true },
      },
      generationGuidance:
        "Do not include internal claim numbers.\nUse placeholders for private references.",
      workflowFamilyCards: [
        {
          workflowId: "workflow.trace-validation",
          name: "Trace validation",
          goal: "CompleteWorkflow",
          whenToUse: ["Need trace Record when"],
          outline: ["Enter workflow", "Complete entry"],
          terminalOutcomes: ["completed"],
          apps: ["Google Chrome"],
        },
      ],
      now: new Date("2026-03-04T00:10:00.000Z"),
    });

    const traceDir = path.join(runDir, "llm-trace");
    const entries = await readdir(traceDir);
    const traceFiles = entries.filter((entry) => entry.endsWith(".json"));
    expect(traceFiles.length).toBeGreaterThanOrEqual(3);

    const traces = await Promise.all(
      traceFiles.map(async (file) => {
        const raw = await readFile(path.join(traceDir, file), "utf8");
        return JSON.parse(raw) as Record<string, unknown>;
      }),
    );
    const traceLabels = traces.map((trace) => String(trace.label ?? ""));
    const summary = JSON.parse(
      await readFile(path.join(runDir, "openclaw-llm", "summary.json"), "utf8"),
    ) as {
      generationGuidance?: string;
      warnings?: string[];
      llm?: {
        callCount: number;
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
        totalReactionTimeMs: number;
      };
    };
    expect(
      summary.warnings?.filter((warning) =>
        /Candidate workflow|Workflow family/i.test(warning),
      ),
    ).toEqual([]);
    const skill = JSON.parse(
      await readFile(path.join(runDir, "openclaw-llm", "skill.json"), "utf8"),
    ) as {
      steps?: Array<Record<string, unknown>>;
    };

    for (const trace of traces) {
      const promptMeta = trace.promptMeta as Record<string, unknown>;
      expect(promptMeta?.promptSet).toBe("specific-v34");
      expect(promptMeta?.promptSchemaVersion).toBe(
        "oysterworkflow-promptset-v1",
      );
      expect(String(promptMeta?.promptFilePath)).toContain(
        path.join("config", "promptsets", "specific-v34.json"),
      );
      const { systemText, userText } = getTraceText(trace);
      expect(collectUnresolvedPlaceholders(systemText)).toEqual([]);
      expect(collectUnresolvedPlaceholders(userText)).toEqual([]);
    }

    const workflowDiscoveryTrace =
      traces.find(
        (trace) => String(trace.label ?? "") === "workflow-discovery",
      ) ?? null;
    expect(workflowDiscoveryTrace).not.toBeNull();
    const callAUserText = getTraceText(
      workflowDiscoveryTrace as Record<string, unknown>,
    ).userText;
    const normalizedCallAUserText = callAUserText.replace(/\s+/g, " ");
    expect(callAUserText).toContain("promptSet=specific-v34");
    expect(callAUserText).toContain("User generation guidance");
    expect(callAUserText).toContain("Do not include internal claim numbers.");
    expect(callAUserText).toContain("Use placeholders for private references.");
    expect(callAUserText).toContain("Raw activity log");
    expect(callAUserText).toContain('"eventType": "click"');
    expect(callAUserText).toContain(
      '"textContent": "trace input with a deliberately long sentence that should remain intact in Call B"',
    );
    expect(normalizedCallAUserText).toContain(longOcr.replace(/\s+/g, " "));
    expect(callAUserText).toContain(symbolHeavyOcr);
    expect(callAUserText).not.toContain('"textContent": null');
    expect(callAUserText).not.toContain('"browserUrl": null');
    expect(callAUserText).not.toContain('"stats"');
    expect(callAUserText).not.toContain('"taskCandidate"');
    expect(callAUserText).not.toContain('"semanticActions"');
    expect(callAUserText).toContain("npm run dev -- extract-skill");
    expect(workflowDiscoveryTrace?.usage).toEqual({
      inputTokens: 111,
      outputTokens: 17,
      totalTokens: 128,
      cachedInputTokens: 3,
      reasoningOutputTokens: 5,
    });
    expect(
      (workflowDiscoveryTrace?.timing as Record<string, unknown>)
        ?.totalReactionTimeMs,
    ).toEqual(expect.any(Number));

    const callBTerminalTrace =
      traces.find(
        (trace) => String(trace.label ?? "") === "skill-extraction-terminal-01",
      ) ?? null;
    expect(callBTerminalTrace).not.toBeNull();
    const workflowDiscoveryBody = ((
      workflowDiscoveryTrace?.request as Record<string, unknown>
    )?.body as Record<string, unknown>) ?? { input: [] };
    const callBTerminalBody = ((
      callBTerminalTrace?.request as Record<string, unknown>
    )?.body as Record<string, unknown>) ?? { input: [] };
    const workflowDiscoveryInput = Array.isArray(workflowDiscoveryBody.input)
      ? workflowDiscoveryBody.input
      : [];
    const callBTerminalInput = Array.isArray(callBTerminalBody.input)
      ? callBTerminalBody.input
      : [];
    expect(
      workflowDiscoveryInput.map(
        (item) => (item as Record<string, unknown>).role,
      ),
    ).toEqual(["system", "user", "system", "user"]);
    expect(
      callBTerminalInput.map((item) => (item as Record<string, unknown>).role),
    ).toEqual(["system", "user", "system", "user"]);
    expect(workflowDiscoveryBody.prompt_cache_key).toMatch(
      /^oysterworkflow-evidence-[a-f0-9]{32}$/,
    );
    expect(callBTerminalBody.prompt_cache_key).toBe(
      workflowDiscoveryBody.prompt_cache_key,
    );
    expect((callBTerminalInput[1] as Record<string, unknown>)?.content).toEqual(
      (workflowDiscoveryInput[1] as Record<string, unknown>)?.content,
    );
    expect(
      (workflowDiscoveryTrace?.request as Record<string, unknown>)?.promptCache,
    ).toEqual({
      requested: true,
      cacheKey: workflowDiscoveryBody.prompt_cache_key,
      cachedInputTokens: 3,
      hit: true,
    });
    expect(
      (callBTerminalTrace?.request as Record<string, unknown>)?.promptCache,
    ).toEqual({
      requested: true,
      cacheKey: workflowDiscoveryBody.prompt_cache_key,
      cachedInputTokens: 7,
      hit: true,
    });
    const callBUserText = getTraceText(
      callBTerminalTrace as Record<string, unknown>,
    ).userText;
    expect(callBUserText).toContain("Selected workflow ");
    expect(callBUserText).toContain("User generation guidance");
    expect(callBUserText).toContain("Do not include internal claim numbers.");
    expect(callBUserText).toContain('"workflowId": "workflow-1"');
    expect(callBUserText).toContain('"skillName": "Test Skill"');
    expect(callBUserText).toContain('"goal": "CompleteWorkflow"');
    expect(callBUserText).toContain(
      "Accumulated steps/assets/references so far",
    );
    expect(callBUserText).toContain("Raw event array");
    expect(callBUserText).toContain('"source": "ui-events"');
    expect(callBUserText).toContain('"tsMs": 1772582402000');
    expect(callBUserText).toContain(
      '"windowName": "Trace Window For A Very Long Flow Name That Should Stay Fully Visible"',
    );
    expect(callBUserText).toContain(
      '"textContent": "trace input with a deliberately long sentence that should remain intact in Call B"',
    );
    expect(callBUserText).toContain(
      '"browserUrl": "https://example.com/really/long/path/that/should/not/be/truncated/by/call-b?query=trace-check"',
    );
    expect(callBUserText).toContain('"x": 1280');
    expect(callBUserText).toContain('"y": 720');
    expect(callBUserText).toContain('"keyCode": 13');
    expect(callBUserText).toContain('"modifiers": 2');
    expect(callBUserText).toContain('"frameId": 42');
    expect(callBUserText).not.toContain('"rawRef"');
    expect(callBUserText).not.toContain('"/tmp/events.ndjson"');
    expect(callBUserText).not.toContain('"browserUrl": null');
    expect(callBUserText).not.toContain('"x": null');
    expect(callBUserText).not.toContain('"runId": "run-llm-trace"');
    expect(callBUserText).not.toContain('"taskCandidate"');
    expect(callBUserText).not.toContain('"semanticActions"');
    expect(callBUserText).not.toContain('"allowedEventIds"');
    expect(callBUserText).not.toContain('"evidenceEventIds"');
    expect(callBUserText).toContain("Current mode: skill-extraction-terminal");
    expect(callBUserText).toContain(
      "The last event ID in the current terminal chunk is: e5",
    );
    expect(callBTerminalTrace?.usage).toEqual({
      inputTokens: 222,
      outputTokens: 29,
      totalTokens: 251,
      cachedInputTokens: 7,
      reasoningOutputTokens: 11,
    });
    expect(
      (callBTerminalTrace?.timing as Record<string, unknown>)
        ?.totalReactionTimeMs,
    ).toEqual(expect.any(Number));
    expect(
      (callBTerminalTrace?.meta as Record<string, unknown>)?.chunkIndex,
    ).toBe(1);
    expect(
      (callBTerminalTrace?.meta as Record<string, unknown>)
        ?.estimatedInputTokens,
    ).toEqual(expect.any(Number));
    const plannerOptimizationTrace =
      traces.find(
        (trace) => String(trace.label ?? "") === "planner-optimization",
      ) ?? null;
    expect(plannerOptimizationTrace).not.toBeNull();
    const plannerOptimizationUserText = getTraceText(
      plannerOptimizationTrace as Record<string, unknown>,
    ).userText;
    expect(plannerOptimizationUserText).toContain("Current skill JSON");
    expect(plannerOptimizationUserText).toContain(
      "Use placeholders for private references.",
    );
    expect(plannerOptimizationUserText).toContain('"skillName": "Test Skill"');
    expect(plannerOptimizationUserText).toContain('"assets": [');
    expect(plannerOptimizationUserText).not.toContain("trace evidence summary");
    expect(plannerOptimizationUserText).not.toContain('"stepsCount":');
    expect(plannerOptimizationUserText).not.toContain('"stepApps": [');
    expect(plannerOptimizationTrace?.usage).toEqual({
      inputTokens: 144,
      outputTokens: 19,
      totalTokens: 163,
      cachedInputTokens: 5,
      reasoningOutputTokens: 9,
    });
    const candidateWorkflowTrace = traces.find(
      (trace) => String(trace.label ?? "") === "workflow-candidate-generation",
    );
    expect(candidateWorkflowTrace).not.toBeNull();
    const candidateUserText = getTraceText(
      candidateWorkflowTrace as Record<string, unknown>,
    ).userText;
    expect(candidateUserText).toContain("Skill JSON:");
    expect(candidateUserText).toContain('"skillId":');
    expect(candidateUserText).not.toContain("Raw activity log");
    expect(candidateUserText).not.toContain("Selected workflow");
    const familyMatchTrace = traces.find(
      (trace) => String(trace.label ?? "") === "workflow-family-matching",
    );
    expect(traceLabels).toContain("workflow-family-matching");
    const familyMatchUserText = getTraceText(
      familyMatchTrace as Record<string, unknown>,
    ).userText;
    expect(familyMatchUserText).toContain("Candidate workflow:");
    expect(familyMatchUserText).toContain("Workflow family cards:");
    expect(familyMatchUserText).toContain(
      '"workflowId": "workflow.trace-validation"',
    );
    expect(familyMatchUserText).not.toContain("Raw activity log");
    expect(summary.llm).toEqual({
      callCount: 5,
      inputTokens: 765,
      outputTokens: 103,
      totalTokens: 868,
      totalReactionTimeMs: expect.any(Number),
    });
    expect(summary.generationGuidance).toBe(
      "Do not include internal claim numbers.\nUse placeholders for private references.",
    );
    expect(skill.steps?.every((step) => !("evidenceEventIds" in step))).toBe(
      true,
    );
  });
});
