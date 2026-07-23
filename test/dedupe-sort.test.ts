import { describe, expect, it } from "vitest";
import { dedupeAndSort } from "../src/ingest/dedupe-sort.js";
import type { NormalizedEvent } from "../src/types/contracts.js";

function buildEvent(input: {
  id: string;
  tsMs: number;
  eventType: NormalizedEvent["eventType"];
  appName?: string | null;
  windowName?: string | null;
  x?: number | null;
  y?: number | null;
}): NormalizedEvent {
  return {
    id: input.id,
    source: input.eventType === "ocr" ? "search-ocr" : "search-input",
    tsIso: new Date(input.tsMs).toISOString(),
    tsMs: input.tsMs,
    appName: input.appName ?? "OysterWorkflow",
    windowName: input.windowName ?? "Extraction Lab",
    eventType: input.eventType,
    textContent: null,
    x: input.x ?? null,
    y: input.y ?? null,
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

describe("dedupeAndSort", () => {
  it("collapses consecutive same-coordinate scroll runs into one event", () => {
    const base = Date.parse("2026-04-07T21:42:55.000Z");
    const result = dedupeAndSort([
      buildEvent({
        id: "scroll-1",
        tsMs: base,
        eventType: "scroll",
        x: 902,
        y: 362,
      }),
      buildEvent({
        id: "scroll-2",
        tsMs: base + 40,
        eventType: "scroll",
        x: 902,
        y: 362,
      }),
      buildEvent({
        id: "scroll-3",
        tsMs: base + 120,
        eventType: "scroll",
        x: 902,
        y: 362,
      }),
      buildEvent({
        id: "click-1",
        tsMs: base + 250,
        eventType: "click",
        x: 902,
        y: 362,
      }),
    ]);

    expect(result.events.map((event) => event.id)).toEqual([
      "scroll-3",
      "click-1",
    ]);
    expect(result.droppedDuplicates).toBe(2);
  });

  it("keeps separate scroll runs when coordinates or timing change", () => {
    const base = Date.parse("2026-04-07T21:43:05.000Z");
    const result = dedupeAndSort([
      buildEvent({
        id: "scroll-a1",
        tsMs: base,
        eventType: "scroll",
        x: 100,
        y: 200,
      }),
      buildEvent({
        id: "scroll-a2",
        tsMs: base + 80,
        eventType: "scroll",
        x: 100,
        y: 200,
      }),
      buildEvent({
        id: "scroll-b1",
        tsMs: base + 160,
        eventType: "scroll",
        x: 101,
        y: 200,
      }),
      buildEvent({
        id: "scroll-c1",
        tsMs: base + 2_500,
        eventType: "scroll",
        x: 101,
        y: 200,
      }),
    ]);

    expect(result.events.map((event) => event.id)).toEqual([
      "scroll-a2",
      "scroll-b1",
      "scroll-c1",
    ]);
    expect(result.droppedDuplicates).toBe(1);
  });
});
