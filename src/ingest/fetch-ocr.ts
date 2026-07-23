import { createNdjsonWriter } from "../io/ndjson.js";
import { ScreenpipeClient } from "../screenpipe/client.js";
import type { FrameOcrResponse, RawEventWithRef } from "../types/contracts.js";
import {
  hasObject,
  isNonEmptyString,
  isRecord,
  normalizeNonNegativeNumber,
  normalizePositiveInt,
  pickNullableNumber,
  toErrorMessage,
} from "./value-utils.js";
// EN: Page size for OCR fetch loop.
const PAGE_LIMIT = 500;
// EN: Safety cap of pages per app to prevent infinite loops on broken pagination.
const MAX_PAGES_PER_APP = 10_000;

export interface FetchOcrInput {
  client: ScreenpipeClient;
  from: string;
  to: string;
  apps: string[] | "*";
  rawFilePath: string;
  warnings?: string[];
}

export interface FetchOcrResult {
  records: RawEventWithRef[];
  pages: number;
  count: number;
}

/**
 * EN: Fetches OCR rows from `/search?content_type=ocr`, writes raw NDJSON, and returns references for normalize.
 * @param input fetch options (time range, app filter, output path).
 * @returns raw record list with pagination counters.
 */
export async function fetchOcr(input: FetchOcrInput): Promise<FetchOcrResult> {
  const writer = await createNdjsonWriter(input.rawFilePath);
  const records: RawEventWithRef[] = [];
  const warnings = input.warnings ?? [];
  const frameOcrCache = new Map<number, Promise<FrameOcrResponse | null>>();
  // CN/EN: `*` means no app filter; otherwise query each selected app independently.
  const appFilters = input.apps === "*" ? [null] : input.apps;

  let pages = 0;
  for (const appName of appFilters) {
    let offset = 0;
    let pagesForApp = 0;
    let mismatchWarningSent = false;

    // CN/EN: Continue until short page/empty page; avoid relying on unstable `pagination.total`.
    while (pagesForApp < MAX_PAGES_PER_APP) {
      const response = await input.client.search({
        content_type: "ocr",
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

      // CN/EN: Some builds report inconsistent totals; keep pulling until short-page termination.
      if (
        !mismatchWarningSent &&
        reportedTotal !== null &&
        pageLength > 0 &&
        offset >= reportedTotal
      ) {
        warnings.push(
          `ocr pagination anomaly (app=${appName ?? "*"}): offset=${offset}, total=${reportedTotal}, data=${pageLength}; continue by short-page strategy`,
        );
        mismatchWarningSent = true;
      }

      for (const item of response.data) {
        // CN/EN: Defensive guard — keep only OCR rows.
        if (String(item.type).toLowerCase() !== "ocr") {
          continue;
        }

        const payload = (item as Record<string, unknown>) ?? {};
        const enrichedPayload = await enrichOcrPayload(
          payload,
          async (frameId) => {
            const cached = frameOcrCache.get(frameId);
            if (cached) {
              return cached;
            }

            const pending = input.client
              .frameOcr(frameId)
              .then((value) => value)
              .catch((error) => {
                warnings.push(
                  `frame OCR enrich failed (frame_id=${frameId}): ${toErrorMessage(error)}`,
                );
                return null;
              });

            frameOcrCache.set(frameId, pending);
            return pending;
          },
        );

        // CN/EN: Persist exact raw payload and keep file-line provenance.
        const line = await writer.write(enrichedPayload);
        records.push({
          source: "search-ocr",
          rawRef: {
            file: input.rawFilePath,
            line,
          },
          payload: enrichedPayload,
        });
      }

      if (pageLength === 0) {
        break;
      }

      // CN/EN: Final page is shorter than page size.
      if (pageLength < effectiveLimit) {
        break;
      }

      offset += effectiveLimit;
    }

    if (pagesForApp >= MAX_PAGES_PER_APP) {
      warnings.push(
        `ocr pagination reached safety cap (app=${appName ?? "*"}, maxPages=${MAX_PAGES_PER_APP})`,
      );
    }
  }

  await writer.close();

  return {
    records,
    pages,
    count: records.length,
  };
}

/**
 * EN: Enriches OCR payload with frame-level context (`frame_ocr` and `text_positions`).
 * @param payload raw OCR row.
 * @param getFrameOcr cached frame OCR resolver.
 * @returns enriched OCR payload.
 */
async function enrichOcrPayload(
  payload: Record<string, unknown>,
  getFrameOcr: (frameId: number) => Promise<FrameOcrResponse | null>,
): Promise<Record<string, unknown>> {
  const content = hasObject(payload, "content")
    ? ({ ...(payload.content as Record<string, unknown>) } as Record<
        string,
        unknown
      >)
    : null;
  const target: Record<string, unknown> = content ?? { ...payload };
  const frameId = pickFrameId(target);
  if (frameId === null) {
    return payload;
  }

  const frameOcr = await getFrameOcr(frameId);
  if (!frameOcr) {
    return payload;
  }

  const nextTarget: Record<string, unknown> = {
    ...target,
    frame_ocr: frameOcr,
  };
  const textPositions = frameOcr.text_positions;
  if (
    Array.isArray(textPositions) &&
    !Array.isArray(nextTarget.text_positions)
  ) {
    nextTarget.text_positions = textPositions;
  }

  if (!isNonEmptyString(nextTarget.text)) {
    const rebuiltText = reconstructTextFromPositions(nextTarget.text_positions);
    if (rebuiltText) {
      nextTarget.text = rebuiltText;
    }
  }

  if (content) {
    return { ...payload, content: nextTarget };
  }

  return nextTarget;
}

/**
 * EN: Extracts `frame_id` from OCR payload.
 * @param payload OCR payload object.
 * @returns valid frame id or null.
 */
function pickFrameId(payload: Record<string, unknown>): number | null {
  const candidate = payload.frame_id ?? payload.frameId;
  if (typeof candidate === "number" && Number.isFinite(candidate)) {
    return Math.trunc(candidate);
  }
  if (typeof candidate === "string") {
    const parsed = Number(candidate);
    if (Number.isFinite(parsed)) {
      return Math.trunc(parsed);
    }
  }
  return null;
}

/**
 * EN: Rebuilds OCR text from `text_positions` (sorted by y/x, joined by newlines).
 * @param value raw `text_positions` value.
 * @returns reconstructed text or null.
 */
function reconstructTextFromPositions(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const chunks: Array<{
    text: string;
    y: number | null;
    x: number | null;
    index: number;
  }> = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (!isRecord(item)) {
      continue;
    }

    const text = typeof item.text === "string" ? item.text.trim() : "";
    if (!text) {
      continue;
    }

    chunks.push({
      text,
      y: pickNullableNumber(item, ["y", "top", "min_y", "line_y"]),
      x: pickNullableNumber(item, ["x", "left", "min_x", "line_x"]),
      index,
    });
  }

  if (chunks.length === 0) {
    return null;
  }

  chunks.sort((a, b) => {
    if (a.y !== null && b.y !== null && a.y !== b.y) {
      return a.y - b.y;
    }
    if (a.x !== null && b.x !== null && a.x !== b.x) {
      return a.x - b.x;
    }
    return a.index - b.index;
  });

  return chunks.map((item) => item.text).join("\n");
}
