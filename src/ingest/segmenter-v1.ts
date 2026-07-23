import type {
  Episode,
  NormalizedEvent,
  SegmenterConfig,
} from "../types/contracts.js";
// EN: Default v1 segmentation heuristics for current small-plan ingest.
export const DEFAULT_SEGMENTER_CONFIG: SegmenterConfig = {
  idleGapMs: 1_800_000,
  appSwitchSplitGapMs: 1_800_000,
  maxEpisodeMs: 86_400_000,
  version: "segmenter_v1",
};

/**
 * EN: Splits time-ordered events into episodes.
 * @param runId run id used in generated episode ids.
 * @param events time-ordered normalized events.
 * @param config segmentation config.
 * @returns segmented episode list.
 */
export function segmentEpisodes(
  runId: string,
  events: NormalizedEvent[],
  config: SegmenterConfig = DEFAULT_SEGMENTER_CONFIG,
): Episode[] {
  if (events.length === 0) {
    return [];
  }

  const chunks: NormalizedEvent[][] = [];
  let currentChunk: NormalizedEvent[] = [events[0]];

  for (let i = 1; i < events.length; i += 1) {
    const prev = events[i - 1];
    const next = events[i];
    const gap = next.tsMs - prev.tsMs;

    // CN/EN: Long inactivity usually indicates previous task finished.
    const shouldSplitByIdle = gap > config.idleGapMs;
    // CN/EN: Explicit app/window switch may start a new episode.
    const shouldSplitByAppSwitch =
      (next.eventType === "app_switch" || next.eventType === "window_focus") &&
      gap > config.appSwitchSplitGapMs;
    const startTsMs = currentChunk[0].tsMs;
    // CN/EN: Hard guardrail to avoid overlong episodes.
    const shouldSplitByDuration = next.tsMs - startTsMs > config.maxEpisodeMs;

    if (shouldSplitByIdle || shouldSplitByAppSwitch || shouldSplitByDuration) {
      chunks.push(currentChunk);
      currentChunk = [next];
      continue;
    }

    currentChunk.push(next);
  }

  chunks.push(currentChunk);

  return chunks.map((chunk, idx) => {
    const startTs = chunk[0].tsIso;
    const endTs = chunk[chunk.length - 1].tsIso;

    return {
      id: `${runId}-ep-${String(idx + 1).padStart(4, "0")}`,
      runId,
      startTs,
      endTs,
      durationMs: Math.max(0, chunk[chunk.length - 1].tsMs - chunk[0].tsMs),
      eventsCount: chunk.length,
      events: chunk,
    };
  });
}
