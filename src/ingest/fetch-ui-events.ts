import { createNdjsonWriter } from "../io/ndjson.js";
import { ScreenpipeClient } from "../screenpipe/client.js";
import type {
  NormalizedSource,
  RawEventWithRef,
  ScreenpipeCapabilityMatrix,
} from "../types/contracts.js";
import {
  asRecord,
  normalizeNonNegativeNumber,
  normalizePositiveInt,
  pickNullableNumber,
  pickNullableString,
} from "./value-utils.js";
// EN: Shared page size for UI event fetch paths.
const PAGE_LIMIT = 500;
// EN: Safety cap of pages per app to prevent infinite loops on broken pagination.
const MAX_PAGES_PER_APP = 10_000;
// EN: UI-related `/search` content types.
type SearchUiContentType = "input" | "accessibility" | "all";
// CN/EN: Accessibility rows are currently disabled for ingest because some
// apps expose very large duplicated accessibility trees.
const ACCESSIBILITY_INGEST_ENABLED = false;

export interface FetchUiEventsInput {
  client: ScreenpipeClient;
  from: string;
  to: string;
  apps: string[] | "*";
  capabilities: ScreenpipeCapabilityMatrix;
  warnings: string[];
  rawFilePath: string;
}

export interface FetchUiEventsResult {
  records: RawEventWithRef[];
  pages: number;
  count: number;
  sourceUsed: ScreenpipeCapabilityMatrix["chosenUiEventSource"];
}

/**
 * EN: Fetches UI-like events from `/search` (input + accessibility + all).
 * @param input fetch options (time window, capabilities, output path, warnings).
 * @returns raw records, pagination counters, and effective source.
 */
export async function fetchUiEvents(
  input: FetchUiEventsInput,
): Promise<FetchUiEventsResult> {
  const writer = await createNdjsonWriter(input.rawFilePath);
  const records: RawEventWithRef[] = [];
  const appFilters = input.apps === "*" ? [null] : input.apps;
  const seenSearchKeys = new Set<string>();

  const source = input.capabilities.chosenUiEventSource;
  if (source === "none") {
    await writer.close();
    throw new Error(
      "No usable /search content_type found for UI event ingestion",
    );
  }

  let pages = 0;
  if (source === "ui-events") {
    // CN/EN: Legacy path — native `/ui-events` endpoint.
    for (const appName of appFilters) {
      let offset = 0;
      let pagesForApp = 0;
      let mismatchWarningSent = false;

      while (pagesForApp < MAX_PAGES_PER_APP) {
        const response = await input.client.uiEvents({
          start_time: input.from,
          end_time: input.to,
          app_name: appName ?? undefined,
          limit: PAGE_LIMIT,
          offset,
        });

        pages += 1;
        pagesForApp += 1;
        const pageLength = response.data.length;
        const effectiveLimit =
          normalizePositiveInt(response.pagination.limit) ?? PAGE_LIMIT;
        const reportedTotal = normalizeNonNegativeNumber(
          response.pagination.total,
        );

        // CN/EN: Some Screenpipe builds report unstable `total`; do not stop based on `total` alone.
        if (
          !mismatchWarningSent &&
          reportedTotal !== null &&
          pageLength > 0 &&
          offset >= reportedTotal
        ) {
          input.warnings.push(
            `ui-events pagination anomaly (app=${appName ?? "*"}): offset=${offset}, total=${reportedTotal}, data=${pageLength}; continue by short-page strategy`,
          );
          mismatchWarningSent = true;
        }

        for (const event of response.data) {
          await appendRawRecord({
            writer,
            records,
            source: "ui-events",
            payload: event,
            rawFilePath: input.rawFilePath,
          });
        }

        if (pageLength === 0) {
          break;
        }

        // CN/EN: End when final page is shorter than page size.
        if (pageLength < effectiveLimit) {
          break;
        }

        offset += effectiveLimit;
      }

      if (pagesForApp >= MAX_PAGES_PER_APP) {
        input.warnings.push(
          `ui-events pagination reached safety cap (app=${appName ?? "*"}, maxPages=${MAX_PAGES_PER_APP})`,
        );
      }
    }
  } else {
    // CN/EN: Modern path — aggregate multiple `/search` UI channels when available.
    const contentTypes = buildSearchFetchPlan(input.capabilities, source);
    if (contentTypes.length === 0) {
      await writer.close();
      throw new Error(
        "No usable /search content_type found for UI event ingestion",
      );
    }

    for (const contentType of contentTypes) {
      for (const appName of appFilters) {
        let offset = 0;
        let pagesForApp = 0;
        let mismatchWarningSent = false;

        while (pagesForApp < MAX_PAGES_PER_APP) {
          const response = await input.client.search({
            content_type: contentType,
            start_time: input.from,
            end_time: input.to,
            app_name: appName ?? undefined,
            limit: PAGE_LIMIT,
            offset,
          });

          pages += 1;
          pagesForApp += 1;
          const pageLength = response.data.length;
          const effectiveLimit =
            normalizePositiveInt(response.pagination.limit) ?? PAGE_LIMIT;
          const reportedTotal = normalizeNonNegativeNumber(
            response.pagination.total,
          );

          // CN/EN: Handle inconsistent totals without truncating data.
          if (
            !mismatchWarningSent &&
            reportedTotal !== null &&
            pageLength > 0 &&
            offset >= reportedTotal
          ) {
            input.warnings.push(
              `search(${contentType}) pagination anomaly (app=${appName ?? "*"}): offset=${offset}, total=${reportedTotal}, data=${pageLength}; continue by short-page strategy`,
            );
            mismatchWarningSent = true;
          }

          for (const item of response.data) {
            const mapped = mapSearchRow(
              item as Record<string, unknown>,
              contentType,
            );
            if (!mapped) {
              continue;
            }

            const dedupeKey = buildSearchDedupeKey(mapped.payload);
            if (seenSearchKeys.has(dedupeKey)) {
              continue;
            }
            seenSearchKeys.add(dedupeKey);

            await appendRawRecord({
              writer,
              records,
              source: mapped.source,
              payload: mapped.payload,
              rawFilePath: input.rawFilePath,
            });
          }

          if (pageLength === 0) {
            break;
          }

          // CN/EN: End when final page is shorter than page size.
          if (pageLength < effectiveLimit) {
            break;
          }

          offset += effectiveLimit;
        }

        if (pagesForApp >= MAX_PAGES_PER_APP) {
          input.warnings.push(
            `search(${contentType}) pagination reached safety cap (app=${appName ?? "*"}, maxPages=${MAX_PAGES_PER_APP})`,
          );
        }
      }
    }

    input.warnings.push(
      `Using UI event source via /search (${contentTypes.join("+")})`,
    );
  }

  await writer.close();

  return {
    records,
    pages,
    count: records.length,
    sourceUsed: source,
  };
}

/**
 * EN: Builds `/search` UI fetch plan (multi-source aggregation + legacy compatibility).
 * @param capabilities capability matrix.
 * @param chosenSource chosen source.
 * @returns ordered content_type list.
 */
function buildSearchFetchPlan(
  capabilities: ScreenpipeCapabilityMatrix,
  chosenSource: ScreenpipeCapabilityMatrix["chosenUiEventSource"],
): SearchUiContentType[] {
  if (chosenSource === "search-input") {
    return ["input"];
  }
  if (chosenSource === "search-accessibility") {
    return ACCESSIBILITY_INGEST_ENABLED ? ["accessibility"] : [];
  }
  if (chosenSource === "search-all") {
    return ["all"];
  }
  if (chosenSource !== "search-combined") {
    return [];
  }

  const plan: SearchUiContentType[] = [];
  if (capabilities.searchInputContentType) {
    plan.push("input");
  }
  if (
    ACCESSIBILITY_INGEST_ENABLED &&
    capabilities.searchAccessibilityContentType
  ) {
    plan.push("accessibility");
  }
  if (capabilities.searchAllContentType) {
    plan.push("all");
  }

  return plan;
}

/**
 * EN: Maps one `/search` row + `content_type` into unified raw source.
 * @param row one raw `/search` row.
 * @param contentType current content_type.
 * @returns mapped row or null.
 */
function mapSearchRow(
  row: Record<string, unknown>,
  contentType: SearchUiContentType,
): { source: NormalizedSource; payload: Record<string, unknown> } | null {
  const rawType =
    typeof row.type === "string" ? row.type.trim().toLowerCase() : "";
  if (contentType === "all") {
    const mapped = mapSearchTypeToSource(rawType);
    return mapped ? { source: mapped, payload: row } : null;
  }

  if (contentType === "input") {
    if (rawType && rawType !== "input") {
      return null;
    }
    return { source: "search-input", payload: row };
  }

  if (contentType === "accessibility") {
    // CN/EN: In some Screenpipe builds, accessibility channel rows are tagged as `UI`.
    if (rawType === "input") {
      return null;
    }
    return { source: "search-accessibility", payload: row };
  }

  return null;
}

/**
 * EN: Maps `/search` row type into normalized source enum.
 * @param rawType lowercase row type.
 * @returns normalized source.
 */
function mapSearchTypeToSource(rawType: string): NormalizedSource | null {
  if (rawType === "input") {
    return "search-input";
  }
  if (rawType === "ui") {
    return "search-ui";
  }
  if (rawType === "accessibility") {
    return "search-accessibility";
  }
  return null;
}

/**
 * EN: Computes cross-source dedupe key to avoid duplicate writes across input/ui/all.
 * @param payload `/search` row payload.
 * @returns dedupe key.
 */
function buildSearchDedupeKey(payload: Record<string, unknown>): string {
  const content = asRecord(payload.content) ?? payload;
  const key = {
    ts: pickNullableString(content, ["timestamp"]),
    app: pickNullableString(content, ["app_name", "appName"]),
    window: pickNullableString(content, [
      "window_name",
      "windowName",
      "window_title",
      "windowTitle",
    ]),
    eventType: pickNullableString(content, ["event_type", "eventType"]),
    text: pickNullableString(content, ["text_content", "textContent", "text"]),
    x: pickNullableNumber(content, ["x"]),
    y: pickNullableNumber(content, ["y"]),
    keyCode: pickNullableNumber(content, ["key_code", "keyCode"]),
    modifiers: pickNullableNumber(content, ["modifiers"]),
    frameId: pickNullableNumber(content, ["frame_id", "frameId"]),
    browserUrl: pickNullableString(content, ["browser_url", "browserUrl"]),
  };
  return JSON.stringify(key);
}

/**
 * EN: Appends one raw row and keeps file-line provenance in `rawRef`.
 * @param input write context.
 * @returns no return.
 */
async function appendRawRecord(input: {
  writer: Awaited<ReturnType<typeof createNdjsonWriter>>;
  records: RawEventWithRef[];
  source: NormalizedSource;
  payload: Record<string, unknown>;
  rawFilePath: string;
}): Promise<void> {
  const line = await input.writer.write(input.payload);
  input.records.push({
    source: input.source,
    rawRef: {
      file: input.rawFilePath,
      line,
    },
    payload: input.payload,
  });
}
