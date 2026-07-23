import { describe, expect, it } from "vitest";
import { sliceEventsForWorkflow } from "../src/skill/workflow-event-slice.js";
import type {
  NormalizedEvent,
  WorkflowCandidate,
} from "../src/types/contracts.js";

function createEvent(input: {
  id: string;
  tsIso: string;
  eventType: NormalizedEvent["eventType"];
  textContent?: string | null;
  spanStartTsIso?: string;
  spanEndTsIso?: string;
}): NormalizedEvent {
  return {
    id: input.id,
    source: input.eventType === "audio" ? "search-audio" : "search-ocr",
    tsIso: input.tsIso,
    tsMs: Date.parse(input.tsIso),
    ...(input.spanStartTsIso
      ? {
          spanStartTsIso: input.spanStartTsIso,
          spanStartTsMs: Date.parse(input.spanStartTsIso),
        }
      : {}),
    ...(input.spanEndTsIso
      ? {
          spanEndTsIso: input.spanEndTsIso,
          spanEndTsMs: Date.parse(input.spanEndTsIso),
        }
      : {}),
    appName: "Google Chrome",
    windowName: "Workflow window",
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

describe("sliceEventsForWorkflow", () => {
  it("includes audio chunks whose spans overlap the workflow window", () => {
    const events: NormalizedEvent[] = [
      createEvent({
        id: "ocr-start",
        tsIso: "2026-04-15T01:21:01.760Z",
        eventType: "ocr",
      }),
      createEvent({
        id: "ocr-end",
        tsIso: "2026-04-15T01:21:19.421Z",
        eventType: "ocr",
      }),
      createEvent({
        id: "audio-overlap",
        tsIso: "2026-04-15T01:21:21.492Z",
        eventType: "audio",
        textContent: "help me finish what is required",
        spanStartTsIso: "2026-04-15T01:21:10.045Z",
        spanEndTsIso: "2026-04-15T01:21:41.128Z",
      }),
      createEvent({
        id: "ocr-later",
        tsIso: "2026-04-15T01:21:45.000Z",
        eventType: "ocr",
      }),
    ];
    const workflow: WorkflowCandidate = {
      workflowId: "workflow-1",
      name: "Review current week requirements",
      description: "Review the current week's assignment details.",
      goal: "Understand the assignment requirements.",
      priority: 1,
      startEventId: "ocr-start",
      endEventId: "ocr-end",
      startTs: events[0].tsIso,
      endTs: events[1].tsIso,
      eventCount: 2,
    };

    const sliced = sliceEventsForWorkflow(events, workflow);

    expect(sliced.map((event) => event.id)).toEqual([
      "ocr-start",
      "ocr-end",
      "audio-overlap",
    ]);
  });

  it("does not include audio chunks that do not overlap the workflow window", () => {
    const events: NormalizedEvent[] = [
      createEvent({
        id: "ocr-start",
        tsIso: "2026-04-15T01:21:01.760Z",
        eventType: "ocr",
      }),
      createEvent({
        id: "ocr-end",
        tsIso: "2026-04-15T01:21:19.421Z",
        eventType: "ocr",
      }),
      createEvent({
        id: "audio-after",
        tsIso: "2026-04-15T01:21:30.000Z",
        eventType: "audio",
        textContent: "this belongs to the next task",
        spanStartTsIso: "2026-04-15T01:21:30.000Z",
        spanEndTsIso: "2026-04-15T01:21:50.000Z",
      }),
    ];
    const workflow: WorkflowCandidate = {
      workflowId: "workflow-1",
      name: "Review current week requirements",
      description: "Review the current week's assignment details.",
      goal: "Understand the assignment requirements.",
      priority: 1,
      startEventId: "ocr-start",
      endEventId: "ocr-end",
      startTs: events[0].tsIso,
      endTs: events[1].tsIso,
      eventCount: 2,
    };

    const sliced = sliceEventsForWorkflow(events, workflow);

    expect(sliced.map((event) => event.id)).toEqual(["ocr-start", "ocr-end"]);
  });
});
