import type { RawEventWithRef } from "../types/contracts.js";
// EN: Merged noise keywords for ingest-side filtering.
const NOISE_CONTEXT_KEYWORDS = [
  "terminal",
  "iterm",
  "wezterm",
  "screenpipe",
  // EN: Keep the legacy desktop name during the rename rollout so self-capture filtering still works for older installs.
  "trace2openclaw",
  "oysterworkflow",
  "codex",
  "live caption",
  "logs",
  "console",
  "shell",
] as const;

export interface FilterRawEventsResult {
  filteredRecords: RawEventWithRef[];
  dropped: number;
  kept: number;
}

/**
 * EN: Filters raw records by app/window context before normalization.
 * @param rawRecords raw event list with source and rawRef.
 * @returns filtered records with drop/keep counts.
 */
export function filterRawEvents(
  rawRecords: RawEventWithRef[],
): FilterRawEventsResult {
  const filtered: RawEventWithRef[] = [];
  let dropped = 0;

  for (const record of rawRecords) {
    if (isSearchInputClick(record)) {
      dropped += 1;
      continue;
    }

    const { appName, windowName } = extractContext(record);
    if (matchesNoiseContext(appName, windowName)) {
      dropped += 1;
      continue;
    }

    filtered.push(record);
  }

  return {
    filteredRecords: filtered,
    dropped,
    kept: filtered.length,
  };
}

/**
 * EN: Drops low-signal click rows from Screenpipe `/search` input records while keeping typed text input.
 * @param record raw event record.
 * @returns true when the record is a search-input click.
 */
function isSearchInputClick(record: RawEventWithRef): boolean {
  if (record.source !== "search-input") {
    return false;
  }

  const envelope = record.payload as Record<string, unknown>;
  const content = hasObject(envelope, "content")
    ? (envelope.content as Record<string, unknown>)
    : envelope;
  const eventType = pickNullableString(content, ["event_type", "eventType"]);

  return normalizeCandidate(eventType) === "click";
}

/**
 * EN: Reads app/window fields (prefer content, fallback to top-level).
 * @param record raw event record.
 * @returns app/window names.
 */
function extractContext(record: RawEventWithRef): {
  appName: string | null;
  windowName: string | null;
} {
  const envelope = record.payload as Record<string, unknown>;
  const content = hasObject(envelope, "content")
    ? (envelope.content as Record<string, unknown>)
    : null;

  const appName =
    pickNullableString(content, ["app_name", "appName"]) ??
    pickNullableString(envelope, ["app_name", "appName"]);
  const windowName =
    pickNullableString(content, [
      "window_name",
      "windowName",
      "window_title",
      "windowTitle",
    ]) ??
    pickNullableString(envelope, [
      "window_name",
      "windowName",
      "window_title",
      "windowTitle",
    ]);

  return { appName, windowName };
}

/**
 * EN: Checks whether app/window context hits noise keywords.
 * @param appName app name.
 * @param windowName window name.
 * @returns true when record should be dropped.
 */
function matchesNoiseContext(
  appName: string | null,
  windowName: string | null,
): boolean {
  const appValue = normalizeCandidate(appName);
  const windowValue = normalizeCandidate(windowName);

  if (!appValue && !windowValue) {
    return false;
  }

  const haystacks = [appValue, windowValue].filter(Boolean) as string[];
  for (const keyword of NOISE_CONTEXT_KEYWORDS) {
    for (const haystack of haystacks) {
      if (haystack.includes(keyword)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * EN: Checks whether a key points to a non-null object value.
 * @param obj input object.
 * @param key field name.
 * @returns true when key is a non-null object.
 */
function hasObject(obj: Record<string, unknown>, key: string): boolean {
  return typeof obj[key] === "object" && obj[key] !== null;
}

/**
 * EN: Returns the first non-empty string among candidate keys.
 * @param obj input object.
 * @param keys candidate keys.
 * @returns matched string or null.
 */
function pickNullableString(
  obj: Record<string, unknown> | null,
  keys: string[],
): string | null {
  if (!obj) {
    return null;
  }

  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    }
  }

  return null;
}

/**
 * EN: Normalizes string for keyword matching.
 * @param value candidate string.
 * @returns lowercased string or null.
 */
function normalizeCandidate(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.toLowerCase();
}
