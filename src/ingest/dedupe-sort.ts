import type { NormalizedEvent } from "../types/contracts.js";

const SCROLL_RUN_MAX_GAP_MS = 1_000;

export interface DedupeResult {
  events: NormalizedEvent[];
  droppedDuplicates: number;
}

/**
 * EN: Produces stable ordering, removes exact duplicates, and collapses repeated scroll bursts.
 * @param events normalized event list.
 * @returns compacted events and number of dropped rows.
 */
export function dedupeAndSort(events: NormalizedEvent[]): DedupeResult {
  const sourcePriority = (event: NormalizedEvent): number => {
    // CN/EN: At identical timestamp, place UI before OCR.
    return event.eventType === "ocr" ? 1 : 0;
  };

  const sorted = [...events].sort((a, b) => {
    if (a.tsMs !== b.tsMs) {
      return a.tsMs - b.tsMs;
    }
    return sourcePriority(a) - sourcePriority(b);
  });

  const seen = new Set<string>();
  const uniqueEvents: NormalizedEvent[] = [];

  for (const event of sorted) {
    const key = dedupeKey(event);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    uniqueEvents.push(event);
  }

  const compacted: NormalizedEvent[] = [];
  let collapsedScrollEvents = 0;

  for (const event of uniqueEvents) {
    const previous = compacted[compacted.length - 1] ?? null;
    if (previous && shouldCollapseScrollRun(previous, event)) {
      compacted[compacted.length - 1] = event;
      collapsedScrollEvents += 1;
      continue;
    }

    compacted.push(event);
  }

  return {
    events: compacted,
    droppedDuplicates:
      sorted.length - uniqueEvents.length + collapsedScrollEvents,
  };
}

/**
 * EN: Builds modality-specific dedupe key.
 * @param event one normalized event.
 * @returns dedupe key string.
 */
function dedupeKey(event: NormalizedEvent): string {
  if (event.eventType === "ocr") {
    return [
      "ocr",
      event.tsMs,
      event.appName ?? "",
      event.windowName ?? "",
      event.textContent ?? "",
    ].join("|");
  }

  if (event.eventType === "audio") {
    return [
      "audio",
      event.tsMs,
      event.deviceName ?? "",
      event.speakerName ?? "",
      event.textContent ?? "",
    ].join("|");
  }

  return [
    "ui",
    event.eventType,
    event.tsMs,
    event.appName ?? "",
    event.windowName ?? "",
    event.x ?? "",
    event.y ?? "",
    event.textContent ?? "",
  ].join("|");
}

/**
 * EN: Detects one continuous scroll burst on the same target so ingest can keep only the latest sample.
 * @param previous previously kept event.
 * @param current next candidate event.
 * @returns true when the current event belongs to the same scroll run.
 */
function shouldCollapseScrollRun(
  previous: NormalizedEvent,
  current: NormalizedEvent,
): boolean {
  if (previous.eventType !== "scroll" || current.eventType !== "scroll") {
    return false;
  }

  if (current.tsMs - previous.tsMs > SCROLL_RUN_MAX_GAP_MS) {
    return false;
  }

  return (
    previous.appName === current.appName &&
    previous.windowName === current.windowName &&
    previous.browserUrl === current.browserUrl &&
    previous.x === current.x &&
    previous.y === current.y
  );
}
