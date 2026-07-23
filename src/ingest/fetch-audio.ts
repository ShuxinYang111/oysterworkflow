import { createNdjsonWriter } from "../io/ndjson.js";
import { ScreenpipeClient } from "../screenpipe/client.js";
import type { RawEventWithRef } from "../types/contracts.js";
import {
  normalizeNonNegativeNumber,
  normalizePositiveInt,
} from "./value-utils.js";

const PAGE_LIMIT = 500;
const MAX_PAGES = 10_000;

export interface FetchAudioInput {
  client: ScreenpipeClient;
  from: string;
  to: string;
  apps: string[] | "*";
  rawFilePath: string;
  warnings?: string[];
}

export interface FetchAudioResult {
  records: RawEventWithRef[];
  pages: number;
  count: number;
}

/**
 * EN: Fetches audio transcription rows from `/search?content_type=audio`.
 * @param input fetch options (time range, app filter context, output path).
 * @returns raw record list with pagination counters.
 */
export async function fetchAudio(
  input: FetchAudioInput,
): Promise<FetchAudioResult> {
  const writer = await createNdjsonWriter(input.rawFilePath);
  const records: RawEventWithRef[] = [];
  const warnings = input.warnings ?? [];

  if (input.apps !== "*") {
    warnings.push(
      `Audio ingest is not app-scoped in Screenpipe; fetched all audio rows for ${input.from}..${input.to} despite apps=${input.apps.join(",")}`,
    );
  }

  let offset = 0;
  let pages = 0;
  let mismatchWarningSent = false;

  while (pages < MAX_PAGES) {
    const response = await input.client.search({
      content_type: "audio",
      start_time: input.from,
      end_time: input.to,
      limit: PAGE_LIMIT,
      offset,
    });

    pages += 1;
    const pageLength = response.data.length;
    const effectiveLimit =
      normalizePositiveInt(response.pagination.limit) ?? PAGE_LIMIT;
    const reportedTotal = normalizeNonNegativeNumber(response.pagination.total);

    if (
      !mismatchWarningSent &&
      reportedTotal !== null &&
      pageLength > 0 &&
      offset >= reportedTotal
    ) {
      warnings.push(
        `audio pagination anomaly: offset=${offset}, total=${reportedTotal}, data=${pageLength}; continue by short-page strategy`,
      );
      mismatchWarningSent = true;
    }

    for (const item of response.data) {
      if (String(item.type).toLowerCase() !== "audio") {
        continue;
      }

      const payload = (item as Record<string, unknown>) ?? {};
      const line = await writer.write(payload);
      records.push({
        source: "search-audio",
        rawRef: {
          file: input.rawFilePath,
          line,
        },
        payload,
      });
    }

    if (pageLength === 0) {
      break;
    }

    if (pageLength < effectiveLimit) {
      break;
    }

    offset += effectiveLimit;
  }

  if (pages >= MAX_PAGES) {
    warnings.push(
      `audio pagination reached safety cap (maxPages=${MAX_PAGES})`,
    );
  }

  await writer.close();

  return {
    records,
    pages,
    count: records.length,
  };
}
