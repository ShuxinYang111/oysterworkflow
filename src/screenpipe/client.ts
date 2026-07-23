import { fetch } from "undici";
import type {
  FrameOcrResponse,
  HealthResponse,
  SearchResponse,
  UiEventsResponse,
} from "../types/contracts.js";
// EN: Per-request timeout to prevent a stalled local daemon from blocking ingest.
const REQUEST_TIMEOUT_MS = 20_000;
// EN: Retry delays (ms) for transient failures.
const RETRY_DELAYS_MS = [500, 1000, 2000];

export interface ScreenpipeClientOptions {
  apiToken?: string | null;
}

export interface ScreenpipeDeleteTimeRangeInput {
  start: string;
  end: string;
}

export interface ScreenpipeDeleteTimeRangeResponse {
  frames_deleted: number;
  ocr_deleted: number;
  audio_transcriptions_deleted: number;
  audio_chunks_deleted: number;
  video_chunks_deleted: number;
  accessibility_deleted: number;
  ui_events_deleted: number;
  video_files_deleted: number;
  audio_files_deleted: number;
}

/**
 * EN: Error for non-2xx Screenpipe responses; keeps status/body for fallback decisions.
 */
export class ScreenpipeHttpError extends Error {
  status: number;
  body: string;

  constructor(status: number, body: string, path: string) {
    super(`HTTP ${status} for ${path}: ${body}`);
    this.status = status;
    this.body = body;
  }
}

/**
 * EN: Lightweight Screenpipe REST client with shared timeout/retry behavior.
 */
export class ScreenpipeClient {
  readonly baseUrl: string;
  readonly apiToken: string | null;

  /**
   * EN: Creates a client with normalized base URL (trailing slash removed).
   * @param baseUrl Screenpipe base URL (for example `http://localhost:3030`)
   */
  constructor(baseUrl: string, options: ScreenpipeClientOptions = {}) {
    // Remove the trailing slash to avoid accidental `//path` joins.
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiToken = normalizeApiToken(options.apiToken);
  }

  /**
   * EN: Calls `/health` as readiness probe.
   * @returns health response payload.
   */
  async health(): Promise<HealthResponse> {
    return this.requestHealth("/health");
  }

  /**
   * EN: Calls `/search`; use `content_type` to query OCR/Input/Accessibility/All data.
   * @param params query parameter object.
   * @returns typed `/search` response.
   */
  async search(params: Record<string, unknown> = {}): Promise<SearchResponse> {
    return this.requestJson<SearchResponse>("/search", params);
  }

  /**
   * EN: Calls `/ui-events` to fetch UI events (legacy endpoint, may be unavailable in new builds).
   * @param params query parameter object.
   * @returns typed `/ui-events` response.
   */
  async uiEvents(
    params: Record<string, unknown> = {},
  ): Promise<UiEventsResponse> {
    return this.requestJson<UiEventsResponse>("/ui-events", params);
  }

  /**
   * EN: Calls `/ui-events/stats` for diagnostics (legacy endpoint).
   * @param params query parameter object.
   * @returns list of stats records.
   */
  async uiEventStats(
    params: Record<string, unknown> = {},
  ): Promise<Array<Record<string, unknown>>> {
    return this.requestJson<Array<Record<string, unknown>>>(
      "/ui-events/stats",
      params,
    );
  }

  /**
   * EN: Calls `/frames/{id}/ocr` for frame-level OCR detail (including `text_positions`).
   * @param frameId frame identifier.
   * @returns frame OCR payload.
   */
  async frameOcr(frameId: number): Promise<FrameOcrResponse> {
    return this.requestJson<FrameOcrResponse>(`/frames/${frameId}/ocr`);
  }

  /**
   * EN: Permanently deletes captured Screenpipe data inside one recording window.
   * 中文: 永久删除指定录制时间范围内的 Screenpipe 原始数据。
   * @param input inclusive recording-window timestamps accepted by Screenpipe.
   * @returns deletion counts reported by Screenpipe.
   */
  async deleteTimeRange(
    input: ScreenpipeDeleteTimeRangeInput,
  ): Promise<ScreenpipeDeleteTimeRangeResponse> {
    return this.requestJson<ScreenpipeDeleteTimeRangeResponse>(
      "/data/delete-range",
      undefined,
      {
        method: "POST",
        body: input,
      },
    );
  }

  /**
   * EN: Shared JSON request implementation with timeout, retry, and HTTP error handling.
   * @param path API path (for example `/search`).
   * @param query query parameters.
   * @returns parsed JSON payload.
   */
  private async requestJson<T>(
    path: string,
    query?: Record<string, unknown>,
    mutation?: {
      method: "POST";
      body: unknown;
    },
  ): Promise<T> {
    const qs = buildQueryString(query ?? {});
    const url = `${this.baseUrl}${path}${qs ? `?${qs}` : ""}`;

    let lastErr: unknown;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      try {
        const response = await fetch(url, {
          method: mutation?.method ?? "GET",
          body: mutation ? JSON.stringify(mutation.body) : undefined,
          signal: controller.signal,
          headers: this.buildHeaders(Boolean(mutation)),
        });

        if (!response.ok) {
          const body = await response.text().catch(() => "");
          const httpError = new ScreenpipeHttpError(
            response.status,
            body,
            path,
          );
          // CN/EN: Retry only 5xx. Most 4xx indicate unsupported capability or bad query.
          if (response.status >= 500 && attempt < RETRY_DELAYS_MS.length) {
            await sleep(RETRY_DELAYS_MS[attempt]);
            continue;
          }
          throw httpError;
        }

        return (await response.json()) as T;
      } catch (error) {
        lastErr = error;
        // CN/EN: Do not retry logical HTTP errors (already classified above).
        if (
          attempt >= RETRY_DELAYS_MS.length ||
          error instanceof ScreenpipeHttpError
        ) {
          throw error;
        }
        await sleep(RETRY_DELAYS_MS[attempt]);
      } finally {
        clearTimeout(timeout);
      }
    }

    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  /**
   * EN: Dedicated `/health` implementation that still returns structured JSON
   * for degraded 5xx payloads, so callers can inspect startup state.
   * @param path health endpoint path.
   * @returns parsed health payload.
   */
  private async requestHealth(path: string): Promise<HealthResponse> {
    const url = `${this.baseUrl}${path}`;
    let lastErr: unknown;

    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      try {
        const response = await fetch(url, {
          method: "GET",
          signal: controller.signal,
          headers: this.buildHeaders(),
        });
        const body = await response.text().catch(() => "");
        const parsed = tryParseJson(body);

        if (response.ok) {
          return (parsed ?? {}) as HealthResponse;
        }
        if (parsed && typeof parsed === "object") {
          return parsed as HealthResponse;
        }

        const httpError = new ScreenpipeHttpError(response.status, body, path);
        if (response.status >= 500 && attempt < RETRY_DELAYS_MS.length) {
          await sleep(RETRY_DELAYS_MS[attempt]);
          continue;
        }
        throw httpError;
      } catch (error) {
        lastErr = error;
        if (
          attempt >= RETRY_DELAYS_MS.length ||
          error instanceof ScreenpipeHttpError
        ) {
          throw error;
        }
        await sleep(RETRY_DELAYS_MS[attempt]);
      } finally {
        clearTimeout(timeout);
      }
    }

    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  private buildHeaders(hasJsonBody = false): Record<string, string> {
    return {
      Accept: "application/json",
      ...(hasJsonBody ? { "Content-Type": "application/json" } : {}),
      ...(this.apiToken ? { Authorization: `Bearer ${this.apiToken}` } : {}),
    };
  }
}

/**
 * EN: Async sleep helper used by retry backoff.
 * @param ms delay in milliseconds.
 * @returns resolves after delay.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * EN: Converts query object to URL query string; omits empty values and encodes arrays as CSV.
 * @param query query object.
 * @returns encoded query string (without `?`).
 */
function buildQueryString(query: Record<string, unknown>): string {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }

    if (Array.isArray(value)) {
      if (value.length === 0) {
        continue;
      }
      params.set(key, value.join(","));
      continue;
    }

    params.set(key, String(value));
  }

  return params.toString();
}

function tryParseJson(value: string): unknown | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

function normalizeApiToken(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
