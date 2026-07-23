import crypto from "node:crypto";
import { basename } from "node:path";
import type {
  EventType,
  NormalizedEvent,
  RawEventWithRef,
  UiEventType,
} from "../types/contracts.js";
import { UI_EVENT_TYPES } from "../types/contracts.js";
import {
  hasObject,
  pickNullableNumber,
  pickNullableString,
} from "./value-utils.js";
// EN: Fast lookup set for supported UI event types.
const UI_EVENT_TYPE_SET = new Set<UiEventType>(UI_EVENT_TYPES);

/**
 * EN: Maps heterogeneous raw events into the unified `NormalizedEvent` schema.
 * @param rawEvents raw events to normalize.
 * @param warnings warning accumulator (mutated).
 * @returns normalized events.
 */
export function normalizeEvents(
  rawEvents: RawEventWithRef[],
  warnings: string[] = [],
): NormalizedEvent[] {
  const normalized: NormalizedEvent[] = [];

  for (const event of rawEvents) {
    const mapped = normalizeOne(event, warnings);
    if (mapped) {
      normalized.push(mapped);
    }
  }

  return normalized;
}

/**
 * EN: Normalizes one raw event row.
 * @param raw one raw event with source and rawRef.
 * @param warnings warning accumulator.
 * @returns normalized event or null when invalid.
 */
function normalizeOne(
  raw: RawEventWithRef,
  warnings: string[],
): NormalizedEvent | null {
  const envelope = raw.payload;
  // CN/EN: Search rows are often nested under `content`; fallback to envelope for legacy shapes.
  const content = hasObject(envelope, "content")
    ? (envelope.content as Record<string, unknown>)
    : envelope;
  const timestamp =
    pickNullableString(content, ["timestamp"]) ??
    pickNullableString(envelope, ["timestamp"]);

  if (!timestamp) {
    warnings.push(
      `Skipped event missing timestamp at ${raw.rawRef.file}:${raw.rawRef.line}`,
    );
    return null;
  }

  const tsMs = Date.parse(timestamp);
  if (Number.isNaN(tsMs)) {
    warnings.push(
      `Skipped event with invalid timestamp '${timestamp}' at ${raw.rawRef.file}:${raw.rawRef.line}`,
    );
    return null;
  }

  const tsIso = new Date(tsMs).toISOString();
  const appName = pickNullableString(content, ["app_name", "appName"]);
  const windowName = pickNullableString(content, [
    "window_name",
    "windowName",
    "window_title",
    "windowTitle",
  ]);

  // CN/EN: Keep deterministic id across reruns using source+nativeId+timestamp+raw location.
  const nativeId = pickNullableNumber(content, ["id", "frame_id", "frameId"]);
  const idSeed = `${raw.source}|${nativeId ?? "na"}|${tsIso}|${raw.rawRef.file}:${raw.rawRef.line}`;
  const id = crypto.createHash("sha1").update(idSeed).digest("hex");

  const eventType = mapEventType(raw.source, content);

  const textContent = mapTextContent(raw.source, content);
  const audioSpan = mapAudioSpan(raw.source, content);

  return {
    id,
    source: raw.source,
    tsIso,
    tsMs,
    ...(audioSpan ?? {}),
    appName,
    windowName,
    eventType,
    textContent,
    x: pickNullableNumber(content, ["x"]),
    y: pickNullableNumber(content, ["y"]),
    keyCode: pickNullableNumber(content, ["key_code", "keyCode"]),
    modifiers: pickNullableNumber(content, ["modifiers"]),
    browserUrl: pickNullableString(content, ["browser_url", "browserUrl"]),
    frameId: pickNullableNumber(content, ["frame_id", "frameId"]),
    deviceName: pickNullableString(content, ["device_name", "deviceName"]),
    speakerName: pickSpeakerName(content),
    rawRef: raw.rawRef,
  };
}

/**
 * EN: Maps source-specific payload to unified `eventType`.
 * @param source normalized source id.
 * @param content source content object.
 * @returns unified event type.
 */
function mapEventType(
  source: RawEventWithRef["source"],
  content: Record<string, unknown>,
): EventType {
  if (source === "search-ocr") {
    return "ocr";
  }

  if (source === "search-audio") {
    return "audio";
  }

  if (source === "search-ui" || source === "search-accessibility") {
    return "text";
  }

  const rawType = pickNullableString(content, ["event_type", "eventType"]);
  if (!rawType) {
    return "text";
  }

  return UI_EVENT_TYPE_SET.has(rawType as UiEventType)
    ? (rawType as UiEventType)
    : "text";
}

/**
 * EN: Reads text field using source-specific key mapping.
 * @param source normalized source id.
 * @param content source content object.
 * @returns text content or null.
 */
function mapTextContent(
  source: RawEventWithRef["source"],
  content: Record<string, unknown>,
): string | null {
  if (source === "search-ocr") {
    const directText = pickNullableString(content, ["text"]);
    if (directText && directText.trim().length > 0) {
      return directText;
    }

    const fromPositions = rebuildTextFromTextPositions(content.text_positions);
    if (fromPositions) {
      return fromPositions;
    }

    if (hasObject(content, "frame_ocr")) {
      const frameOcr = content.frame_ocr as Record<string, unknown>;
      const frameText = pickNullableString(frameOcr, ["text"]);
      if (frameText && frameText.trim().length > 0) {
        return frameText;
      }
      return rebuildTextFromTextPositions(frameOcr.text_positions);
    }

    return null;
  }

  if (source === "search-audio") {
    return pickNullableString(content, [
      "transcription",
      "text",
      "text_content",
      "textContent",
    ]);
  }

  if (source === "search-ui" || source === "search-accessibility") {
    return pickNullableString(content, ["text", "text_content", "textContent"]);
  }

  return pickNullableString(content, ["text_content", "textContent"]);
}

/**
 * EN: Derives absolute audio span timestamps from Screenpipe chunk metadata when available.
 * @param source normalized source id.
 * @param content source content object.
 * @returns audio span fields or null when metadata is incomplete.
 */
function mapAudioSpan(
  source: RawEventWithRef["source"],
  content: Record<string, unknown>,
): Pick<
  NormalizedEvent,
  "spanStartTsIso" | "spanStartTsMs" | "spanEndTsIso" | "spanEndTsMs"
> | null {
  if (source !== "search-audio") {
    return null;
  }

  const filePath = pickNullableString(content, ["file_path", "filePath"]);
  const chunkFileStartTsMs = parseAudioChunkFileStartTsMs(filePath);
  const startOffsetSeconds = pickNullableNumber(content, [
    "start_time",
    "startTime",
  ]);
  const endOffsetSeconds = pickNullableNumber(content, ["end_time", "endTime"]);

  if (
    chunkFileStartTsMs === null ||
    startOffsetSeconds === null ||
    endOffsetSeconds === null
  ) {
    return null;
  }

  const rawStartTsMs =
    chunkFileStartTsMs + Math.round(startOffsetSeconds * 1000);
  const rawEndTsMs = chunkFileStartTsMs + Math.round(endOffsetSeconds * 1000);
  const spanStartTsMs = Math.min(rawStartTsMs, rawEndTsMs);
  const spanEndTsMs = Math.max(rawStartTsMs, rawEndTsMs);

  return {
    spanStartTsIso: new Date(spanStartTsMs).toISOString(),
    spanStartTsMs,
    spanEndTsIso: new Date(spanEndTsMs).toISOString(),
    spanEndTsMs,
  };
}

/**
 * EN: Parses Screenpipe audio chunk filenames such as `Mic_2026-04-15_01-21-10.mp4`.
 * @param filePath raw audio file path.
 * @returns UTC epoch milliseconds for the chunk start, or null when unavailable.
 */
function parseAudioChunkFileStartTsMs(filePath: string | null): number | null {
  if (!filePath) {
    return null;
  }

  const match = basename(filePath).match(
    /_(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})(?=\.[^.]+$)/,
  );
  if (!match) {
    return null;
  }

  const [, year, month, day, hour, minute, second] = match;
  return Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
}

/**
 * EN: Reconstructs OCR text from `text_positions` (sorted by y/x and joined with newlines).
 * @param value possible `text_positions` array value.
 * @returns reconstructed text or null.
 */
function rebuildTextFromTextPositions(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const lines: Array<{
    text: string;
    y: number | null;
    x: number | null;
    index: number;
  }> = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (typeof item !== "object" || item === null) {
      continue;
    }

    const asRecord = item as Record<string, unknown>;
    const text = pickNullableString(asRecord, ["text"]);
    if (!text || text.trim().length === 0) {
      continue;
    }

    lines.push({
      text,
      y: pickNullableNumber(asRecord, ["y", "top", "min_y", "line_y"]),
      x: pickNullableNumber(asRecord, ["x", "left", "min_x", "line_x"]),
      index,
    });
  }

  if (lines.length === 0) {
    return null;
  }

  lines.sort((a, b) => {
    if (a.y !== null && b.y !== null && a.y !== b.y) {
      return a.y - b.y;
    }
    if (a.x !== null && b.x !== null && a.x !== b.x) {
      return a.x - b.x;
    }
    return a.index - b.index;
  });

  return lines.map((item) => item.text).join("\n");
}

/**
 * EN: Extracts speaker display name from nested speaker object when present.
 * @param content normalized content envelope.
 * @returns speaker name or null.
 */
function pickSpeakerName(content: Record<string, unknown>): string | null {
  if (!hasObject(content, "speaker")) {
    return null;
  }

  const speaker = content.speaker as Record<string, unknown>;
  return pickNullableString(speaker, ["name"]);
}
