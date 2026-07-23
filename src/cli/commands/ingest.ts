import { writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import pino from "pino";
import { z } from "zod";
import { dedupeAndSort } from "../../ingest/dedupe-sort.js";
import { fetchAudio } from "../../ingest/fetch-audio.js";
import { filterRawEvents } from "../../ingest/filter-raw-events.js";
import { fetchOcr } from "../../ingest/fetch-ocr.js";
import { fetchUiEvents } from "../../ingest/fetch-ui-events.js";
import { normalizeEvents } from "../../ingest/normalize.js";
import {
  DEFAULT_SEGMENTER_CONFIG,
  segmentEpisodes,
} from "../../ingest/segmenter-v1.js";
import { initRunLayout } from "../../io/fs-layout.js";
import { createNdjsonWriter } from "../../io/ndjson.js";
import { detectCapabilities } from "../../screenpipe/capability.js";
import { ScreenpipeClient } from "../../screenpipe/client.js";
import type {
  IngestSummary,
  RunManifest,
  ScreenpipeCapabilityMatrix,
} from "../../types/contracts.js";
// EN: Validation schema for `oysterworkflow ingest`.
const ingestCommandArgsSchema = z.object({
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
  apps: z.string().min(1),
  out: z.string().min(1),
  baseUrl: z.string().url(),
});

export interface RunIngestOptions {
  from: string;
  to: string;
  apps: string[] | "*";
  out: string;
  baseUrl: string;
  screenpipeApiToken?: string | null;
  now?: Date;
  clientFactory?: (
    baseUrl: string,
    options?: { apiToken?: string | null },
  ) => ScreenpipeClient;
}

export interface RunIngestResult {
  manifest: RunManifest;
  summary: IngestSummary;
}

/**
 * EN: Runs the end-to-end ingest pipeline.
 * @param options ingest options (time window, app filter, output dir, baseUrl).
 * @returns run manifest and summary.
 */
export async function runIngest(
  options: RunIngestOptions,
): Promise<RunIngestResult> {
  // CN/EN: Send logs to stderr so stdout remains machine-readable JSON.
  const logger = pino({ name: "oysterworkflow.ingest" }, pino.destination(2));
  const now = options.now ?? new Date();
  const startedAt = now.toISOString();
  const outPath = resolve(options.out);

  if (!isAbsolute(outPath)) {
    throw new Error(`--out must be an absolute path, received: ${options.out}`);
  }

  const layout = await initRunLayout(outPath);
  const warnings: string[] = [];

  // CN/EN: Write manifest early so failed runs still leave traceable artifacts.
  const manifest: RunManifest = {
    runId: layout.runId,
    createdAt: startedAt,
    status: "running",
    args: {
      from: options.from,
      to: options.to,
      apps: options.apps,
      out: outPath,
      baseUrl: options.baseUrl,
    },
    paths: {
      runDir: layout.runDir,
      rawUiEvents: layout.rawUiEventsPath,
      rawOcr: layout.rawOcrPath,
      rawAudio: layout.rawAudioPath,
      normalizedEvents: layout.normalizedEventsPath,
      episodes: layout.episodesPath,
      summary: layout.summaryPath,
    },
    capabilities: null,
    segmenter: DEFAULT_SEGMENTER_CONFIG,
    warnings,
    error: null,
  };

  await writeJson(layout.manifestPath, manifest);

  const makeClient =
    options.clientFactory ??
    ((baseUrl: string, clientOptions?: { apiToken?: string | null }) =>
      new ScreenpipeClient(baseUrl, clientOptions));
  const client = makeClient(options.baseUrl, {
    apiToken: options.screenpipeApiToken ?? process.env.SCREENPIPE_API_KEY,
  });

  try {
    // CN/EN: Hard readiness gate before expensive fetch calls.
    await client.health();
    const capabilities = await detectCapabilities(client, warnings);
    capabilities.healthAvailable = true;
    manifest.capabilities = capabilities;

    // CN/EN: Fetch OCR and UI streams in parallel to reduce wall-clock time.
    const audioFetch = manifest.capabilities.searchAudioContentType
      ? fetchAudio({
          client,
          from: options.from,
          to: options.to,
          apps: options.apps,
          rawFilePath: layout.rawAudioPath,
          warnings,
        })
      : (async () => {
          const writer = await createNdjsonWriter(layout.rawAudioPath);
          await writer.close();
          return {
            records: [],
            pages: 0,
            count: 0,
          };
        })();

    if (!manifest.capabilities.searchAudioContentType) {
      warnings.push(
        "Audio ingest skipped: /search content_type=audio unavailable",
      );
    }

    const uiFetch =
      capabilities.chosenUiEventSource === "none"
        ? createEmptyUiEventsResult({
            rawFilePath: layout.rawUiEventsPath,
            warnings,
          })
        : fetchUiEvents({
            client,
            from: options.from,
            to: options.to,
            apps: options.apps,
            capabilities,
            warnings,
            rawFilePath: layout.rawUiEventsPath,
          });

    const [ocrResult, uiResult, audioResult] = await Promise.all([
      fetchOcr({
        client,
        from: options.from,
        to: options.to,
        apps: options.apps,
        rawFilePath: layout.rawOcrPath,
        warnings,
      }),
      uiFetch,
      audioFetch,
    ]);

    // CN/EN: Normalize heterogeneous raw payloads into unified event model.
    const combinedRecords = [
      ...uiResult.records,
      ...ocrResult.records,
      ...audioResult.records,
    ];
    const filtered = filterRawEvents(combinedRecords);
    if (filtered.dropped > 0) {
      warnings.push(
        `Filtered raw events by app/window context: dropped=${filtered.dropped}, kept=${filtered.kept}`,
      );
    }

    const normalized = normalizeEvents(filtered.filteredRecords, warnings);

    // CN/EN: Persist normalized events for audit and downstream stages.
    const normalizedWriter = await createNdjsonWriter(
      layout.normalizedEventsPath,
    );
    for (const event of normalized) {
      await normalizedWriter.write(event);
    }
    await normalizedWriter.close();

    // CN/EN: Deduplicate and segment timeline into episodes.
    const dedupeResult = dedupeAndSort(normalized);
    const episodes = segmentEpisodes(
      layout.runId,
      dedupeResult.events,
      DEFAULT_SEGMENTER_CONFIG,
    );

    await writeJson(layout.episodesPath, episodes);

    const completedAt = new Date().toISOString();
    const summary = buildSummary({
      runId: layout.runId,
      startedAt,
      completedAt,
      requestedStartTs: options.from,
      requestedEndTs: options.to,
      observedStartTs: dedupeResult.events[0]?.tsIso ?? null,
      observedEndTs:
        dedupeResult.events[dedupeResult.events.length - 1]?.tsIso ?? null,
      ocrPages: ocrResult.pages,
      audioPages: audioResult.pages,
      uiPages: uiResult.pages,
      rawOcrCount: ocrResult.count,
      rawAudioCount: audioResult.count,
      rawUiEventsCount: uiResult.count,
      normalizedCount: normalized.length,
      dedupedCount: dedupeResult.events.length,
      droppedDuplicates: dedupeResult.droppedDuplicates,
      episodes,
      warnings,
    });

    // CN/EN: Finalize success artifacts.
    manifest.status = "success";
    manifest.warnings = warnings;

    await writeJson(layout.summaryPath, summary);
    await writeJson(layout.manifestPath, manifest);

    logger.info({ runId: layout.runId, summary }, "ingest completed");

    return { manifest, summary };
  } catch (error) {
    // CN/EN: On failure, still write manifest with reason for post-mortem.
    manifest.status = "failed";
    manifest.error = {
      message: toErrorMessage(error),
      stack: error instanceof Error ? error.stack : undefined,
    };
    manifest.warnings = warnings;

    await writeJson(layout.manifestPath, manifest);

    throw error;
  }
}

/**
 * EN: Parses and validates ingest CLI args.
 * @param input raw CLI input values.
 * @returns typed ingest options (without test injection fields).
 */
export function parseIngestCliArgs(input: {
  from: string;
  to: string;
  apps: string;
  out: string;
  baseUrl: string;
}): Omit<RunIngestOptions, "now" | "clientFactory"> {
  const parsed = ingestCommandArgsSchema.parse(input);
  const apps = parseApps(parsed.apps);

  return {
    from: parsed.from,
    to: parsed.to,
    apps,
    out: parsed.out,
    baseUrl: parsed.baseUrl,
  };
}

/**
 * EN: Parses `--apps` argument (`*` or comma-separated names).
 * @param apps raw CLI value.
 * @returns `*` or de-duplicated app list.
 */
export function parseApps(apps: string): string[] | "*" {
  const trimmed = apps.trim();
  if (trimmed === "*") {
    return "*";
  }

  const list = trimmed
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  if (list.length === 0) {
    throw new Error("--apps must be '*' or a non-empty CSV list");
  }

  return [...new Set(list)];
}

/**
 * EN: Aggregates ingest metrics into `summary.json` shape.
 * @param input stage metrics input.
 * @returns ingest summary object.
 */
function buildSummary(input: {
  runId: string;
  startedAt: string;
  completedAt: string;
  requestedStartTs: string;
  requestedEndTs: string;
  observedStartTs: string | null;
  observedEndTs: string | null;
  ocrPages: number;
  audioPages: number;
  uiPages: number;
  rawOcrCount: number;
  rawAudioCount: number;
  rawUiEventsCount: number;
  normalizedCount: number;
  dedupedCount: number;
  droppedDuplicates: number;
  episodes: Array<{ durationMs: number }>;
  warnings: string[];
}): IngestSummary {
  const durations = input.episodes
    .map((episode) => episode.durationMs)
    .sort((a, b) => a - b);
  const totalDuration = durations.reduce((sum, value) => sum + value, 0);

  const medianDurationMs =
    durations.length === 0
      ? 0
      : durations.length % 2 === 1
        ? durations[(durations.length - 1) / 2]
        : (durations[durations.length / 2 - 1] +
            durations[durations.length / 2]) /
          2;

  return {
    runId: input.runId,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    durationMs: calculateDurationMs(input.startedAt, input.completedAt),
    timeWindow: {
      requested: {
        startTs: input.requestedStartTs,
        endTs: input.requestedEndTs,
        durationMs: calculateDurationMs(
          input.requestedStartTs,
          input.requestedEndTs,
        ),
      },
      observed: {
        startTs: input.observedStartTs,
        endTs: input.observedEndTs,
        durationMs: calculateOptionalDurationMs(
          input.observedStartTs,
          input.observedEndTs,
        ),
      },
    },
    fetch: {
      ocrPages: input.ocrPages,
      audioPages: input.audioPages,
      uiPages: input.uiPages,
      rawOcrCount: input.rawOcrCount,
      rawAudioCount: input.rawAudioCount,
      rawUiEventsCount: input.rawUiEventsCount,
    },
    transform: {
      normalizedCount: input.normalizedCount,
      dedupedCount: input.dedupedCount,
      droppedDuplicates: input.droppedDuplicates,
    },
    episodes: {
      count: input.episodes.length,
      avgDurationMs:
        input.episodes.length === 0
          ? 0
          : Math.round(totalDuration / input.episodes.length),
      medianDurationMs,
    },
    warnings: [...input.warnings],
  };
}

/**
 * EN: Calculates the millisecond delta between two ISO timestamps.
 * @param startTs start timestamp.
 * @param endTs end timestamp.
 * @returns delta in milliseconds.
 */
function calculateDurationMs(startTs: string, endTs: string): number {
  return Date.parse(endTs) - Date.parse(startTs);
}

/**
 * EN: Safely calculates optional window duration, returning 0 when either side is missing.
 * @param startTs optional start timestamp.
 * @param endTs optional end timestamp.
 * @returns delta in milliseconds or 0.
 */
function calculateOptionalDurationMs(
  startTs: string | null,
  endTs: string | null,
): number {
  if (startTs === null || endTs === null) {
    return 0;
  }
  return calculateDurationMs(startTs, endTs);
}

/**
 * EN: Writes JSON file with trailing newline for shell readability.
 * @param path output path.
 * @param value value to serialize.
 * @returns resolves when write completes.
 */
async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function createEmptyUiEventsResult(input: {
  rawFilePath: string;
  warnings: string[];
}): Promise<{
  records: [];
  pages: number;
  count: number;
  sourceUsed: "none";
}> {
  const writer = await createNdjsonWriter(input.rawFilePath);
  await writer.close();
  input.warnings.push(
    "UI event ingest skipped: no Screenpipe UI event source is available.",
  );
  return {
    records: [],
    pages: 0,
    count: 0,
    sourceUsed: "none",
  };
}

/**
 * EN: Converts unknown error to string message.
 * @param error unknown error value.
 * @returns error message.
 */
function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export type { ScreenpipeCapabilityMatrix };
