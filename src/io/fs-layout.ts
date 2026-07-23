import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
// EN: Canonical per-run output file layout for ingest.
export interface RunLayout {
  runId: string;
  runDir: string;
  rawDir: string;
  normalizedDir: string;
  manifestPath: string;
  rawUiEventsPath: string;
  rawOcrPath: string;
  rawAudioPath: string;
  normalizedEventsPath: string;
  episodesPath: string;
  summaryPath: string;
}

/**
 * EN: Creates per-run directories and returns canonical file paths.
 * @param outDir output root directory.
 * @param runId optional run id (auto-generated when absent).
 * @returns full run path layout.
 */
export async function initRunLayout(
  outDir: string,
  runId?: string,
): Promise<RunLayout> {
  const resolvedOut = resolve(outDir);
  const finalRunId = runId ?? generateRunId();
  const runDir = join(resolvedOut, "runs", finalRunId);
  const rawDir = join(runDir, "raw");
  const normalizedDir = join(runDir, "normalized");

  await mkdir(rawDir, { recursive: true });
  await mkdir(normalizedDir, { recursive: true });

  return {
    runId: finalRunId,
    runDir,
    rawDir,
    normalizedDir,
    manifestPath: join(runDir, "manifest.json"),
    rawUiEventsPath: join(rawDir, "ui_events.ndjson"),
    rawOcrPath: join(rawDir, "ocr.ndjson"),
    rawAudioPath: join(rawDir, "audio.ndjson"),
    normalizedEventsPath: join(normalizedDir, "events.ndjson"),
    episodesPath: join(runDir, "episodes.json"),
    summaryPath: join(runDir, "summary.json"),
  };
}

/**
 * EN: Generates run id (UTC timestamp + random suffix) to avoid collisions.
 * @param date optional date basis.
 * @returns run id string.
 */
export function generateRunId(date = new Date()): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  const ss = String(date.getUTCSeconds()).padStart(2, "0");
  const random = Math.random().toString(36).slice(2, 8);
  return `${y}${m}${d}T${hh}${mm}${ss}Z-${random}`;
}
