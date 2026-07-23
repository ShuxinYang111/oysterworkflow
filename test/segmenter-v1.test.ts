import { describe, expect, it } from "vitest";
import {
  DEFAULT_SEGMENTER_CONFIG,
  segmentEpisodes,
} from "../src/ingest/segmenter-v1.js";
import type { NormalizedEvent } from "../src/types/contracts.js";
function buildEvent(
  tsMs: number,
  eventType: NormalizedEvent["eventType"],
): NormalizedEvent {
  return {
    id: `e-${tsMs}-${eventType}`,
    source: eventType === "ocr" ? "search-ocr" : "ui-events",
    tsIso: new Date(tsMs).toISOString(),
    tsMs,
    appName: "TestApp",
    windowName: "Main",
    eventType,
    textContent: null,
    x: null,
    y: null,
    keyCode: null,
    modifiers: null,
    browserUrl: null,
    frameId: null,
    rawRef: {
      file: "/tmp/x.ndjson",
      line: 1,
    },
  };
}

describe("segmentEpisodes", () => {
  it("splits by idle gap", () => {
    const base = Date.parse("2026-02-27T10:00:00.000Z");
    const events = [
      buildEvent(base, "click"),
      buildEvent(base + 1_000, "text"),
      buildEvent(base + 1_900_000, "click"),
      buildEvent(base + 1_901_000, "scroll"),
    ];

    const episodes = segmentEpisodes("run-a", events, {
      ...DEFAULT_SEGMENTER_CONFIG,
      maxEpisodeMs: 86_400_000,
    });
    expect(episodes).toHaveLength(2);
    expect(episodes[0].eventsCount).toBe(2);
    expect(episodes[1].eventsCount).toBe(2);
  });
  it("splits by app/window switch when gap exceeds threshold", () => {
    const base = Date.parse("2026-02-27T10:00:00.000Z");
    const events = [
      buildEvent(base, "click"),
      buildEvent(base + 1_810_000, "app_switch"),
      buildEvent(base + 1_811_000, "click"),
    ];

    const episodes = segmentEpisodes("run-b", events, {
      ...DEFAULT_SEGMENTER_CONFIG,
      idleGapMs: 7_200_000,
      maxEpisodeMs: 86_400_000,
    });
    expect(episodes).toHaveLength(2);
    expect(episodes[0].events.map((e) => e.eventType)).toEqual(["click"]);
    expect(episodes[1].events.map((e) => e.eventType)).toEqual([
      "app_switch",
      "click",
    ]);
  });
  it("splits by max duration", () => {
    const base = Date.parse("2026-02-27T10:00:00.000Z");
    const events = [
      buildEvent(base, "click"),
      buildEvent(base + 43_200_000, "text"),
      buildEvent(base + 90_000_000, "scroll"),
      buildEvent(base + 90_001_000, "text"),
    ];

    const episodes = segmentEpisodes("run-c", events, {
      ...DEFAULT_SEGMENTER_CONFIG,
      idleGapMs: 172_800_000,
      appSwitchSplitGapMs: 172_800_000,
    });
    expect(episodes).toHaveLength(2);
    expect(episodes[0].eventsCount).toBe(2);
    expect(episodes[1].eventsCount).toBe(2);
  });
});
