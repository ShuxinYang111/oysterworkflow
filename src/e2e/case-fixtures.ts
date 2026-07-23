import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface E2eCaseCatalog {
  schemaVersion: string;
  cases: E2eCaseDefinition[];
}

export interface E2eCaseDefinition {
  id: string;
  title: string;
  description: string;
  sourceRunId: string;
  from: string;
  to: string;
  apps: string;
  sourceDir: string;
  expectedRawUiEvents: number;
  expectedRawOcr: number;
  minQualityScore: number;
  expectedWindowKeywords: string[];
  minAutonomousIdealScore: number;
  uiTotalOverridesByOffset?: Record<string, number>;
}

interface MockScreenpipeSourceData {
  uiEvents: Array<Record<string, unknown>>;
  ocrRows: Array<Record<string, unknown>>;
}

export interface MockScreenpipeServer {
  baseUrl: string;
  close: () => Promise<void>;
}

/**
 * EN: Loads and validates the e2e case catalog.
 * @param filePath catalog file path.
 * @returns parsed case catalog.
 */
export async function loadCaseCatalog(
  filePath: string,
): Promise<E2eCaseCatalog> {
  const raw = await readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as E2eCaseCatalog;
  if (!Array.isArray(parsed.cases) || parsed.cases.length === 0) {
    throw new Error(`Invalid e2e case catalog at ${filePath}`);
  }
  return parsed;
}

/**
 * EN: Starts a mock Screenpipe server from fixtures for ingest-required endpoints.
 * @param input case definition and fixtures root.
 * @returns mock server base URL and close handle.
 */
export async function startMockScreenpipe(input: {
  testCase: E2eCaseDefinition;
  fixturesRoot: string;
}): Promise<MockScreenpipeServer> {
  const source = await loadCaseSource(input.testCase, input.fixturesRoot);
  const frameOcrById = buildFrameOcrMap(source.ocrRows);

  const server = createServer((req, res) => {
    handleMockRequest(req, res, {
      source,
      frameOcrById,
      uiTotalOverridesByOffset: input.testCase.uiTotalOverridesByOffset ?? {},
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error(
      `Unable to bind mock Screenpipe server for case ${input.testCase.id}`,
    );
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

/**
 * EN: Resolves the case fixture root from `sourceDir`.
 * @param sourceDir `sourceDir` field from case config.
 * @returns relative case root directory.
 */
export function resolveCaseFixtureDir(sourceDir: string): string {
  return sourceDir.endsWith("/source")
    ? sourceDir.slice(0, -"/source".length)
    : sourceDir;
}

/**
 * EN: Loads raw UI/OCR fixtures for one case.
 * @param testCase case definition.
 * @param fixturesRoot fixtures root.
 * @returns raw UI/OCR records.
 */
async function loadCaseSource(
  testCase: E2eCaseDefinition,
  fixturesRoot: string,
): Promise<MockScreenpipeSourceData> {
  const sourceRoot = join(fixturesRoot, testCase.sourceDir);
  const [uiEvents, ocrRows] = await Promise.all([
    readNdjson(join(sourceRoot, "ui_events.ndjson")),
    readNdjson(join(sourceRoot, "ocr.ndjson")),
  ]);

  return { uiEvents, ocrRows };
}

/**
 * EN: Handles one mock Screenpipe request.
 * @param req HTTP request.
 * @param res HTTP response.
 * @param input request handling context.
 * @returns no return value.
 */
function handleMockRequest(
  req: IncomingMessage,
  res: ServerResponse,
  input: {
    source: MockScreenpipeSourceData;
    frameOcrById: Map<number, Record<string, unknown>>;
    uiTotalOverridesByOffset: Record<string, number>;
  },
): void {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const pathname = url.pathname;

  if (pathname === "/health") {
    writeJsonResponse(res, 200, { status: "healthy" });
    return;
  }

  if (pathname === "/ui-events") {
    const limit = parsePositiveInt(url.searchParams.get("limit")) ?? 500;
    const offset = parseNonNegativeInt(url.searchParams.get("offset")) ?? 0;
    const filtered = filterUiEvents(input.source.uiEvents, {
      startTime: url.searchParams.get("start_time"),
      endTime: url.searchParams.get("end_time"),
      appName: url.searchParams.get("app_name"),
    });
    const pageData = filtered.slice(offset, offset + limit);
    const total =
      input.uiTotalOverridesByOffset[String(offset)] ?? filtered.length;

    writeJsonResponse(res, 200, {
      data: pageData,
      pagination: { limit, offset, total },
    });
    return;
  }

  if (pathname === "/search") {
    const contentType = url.searchParams.get("content_type") ?? "all";
    const limit = parsePositiveInt(url.searchParams.get("limit")) ?? 500;
    const offset = parseNonNegativeInt(url.searchParams.get("offset")) ?? 0;

    if (contentType === "ocr") {
      const filtered = filterOcrRows(input.source.ocrRows, {
        startTime: url.searchParams.get("start_time"),
        endTime: url.searchParams.get("end_time"),
        appName: url.searchParams.get("app_name"),
      });
      const pageData = filtered.slice(offset, offset + limit);
      writeJsonResponse(res, 200, {
        data: pageData,
        pagination: { limit, offset, total: filtered.length },
      });
      return;
    }

    if (
      contentType === "input" ||
      contentType === "accessibility" ||
      contentType === "all"
    ) {
      const filtered = filterUiEvents(input.source.uiEvents, {
        startTime: url.searchParams.get("start_time"),
        endTime: url.searchParams.get("end_time"),
        appName: url.searchParams.get("app_name"),
      });
      const rowType =
        contentType === "input"
          ? "input"
          : contentType === "accessibility"
            ? "accessibility"
            : "ui";
      const pageData = filtered.slice(offset, offset + limit).map((row) => ({
        type: rowType,
        content: row,
      }));
      const total =
        input.uiTotalOverridesByOffset[String(offset)] || filtered.length;

      writeJsonResponse(res, 200, {
        data: pageData,
        pagination: { limit, offset, total },
      });
      return;
    }

    writeJsonResponse(res, 200, {
      data: [],
      pagination: { limit, offset, total: 0 },
    });
    return;
  }

  const frameMatch = pathname.match(/^\/frames\/(\d+)\/ocr$/);
  if (frameMatch) {
    const frameId = Number(frameMatch[1]);
    const framePayload = input.frameOcrById.get(frameId);
    if (framePayload) {
      writeJsonResponse(res, 200, framePayload);
      return;
    }
    writeJsonResponse(res, 404, { error: `frame ${frameId} not found` });
    return;
  }

  writeJsonResponse(res, 404, { error: `unsupported mock path: ${pathname}` });
}

/**
 * EN: Builds a frame_id -> OCR record map supporting both `frame_ocr` and simplified text shapes.
 * @param rows raw OCR rows.
 * @returns OCR map keyed by frame_id.
 */
function buildFrameOcrMap(
  rows: Array<Record<string, unknown>>,
): Map<number, Record<string, unknown>> {
  const result = new Map<number, Record<string, unknown>>();

  for (const row of rows) {
    const content = asRecord(row.content);
    if (!content) {
      continue;
    }

    const frameId = parseFrameId(content.frame_id);
    if (frameId === null) {
      continue;
    }

    const frameOcr = asRecord(content.frame_ocr);
    if (frameOcr) {
      result.set(frameId, frameOcr);
      continue;
    }

    const text = typeof content.text === "string" ? content.text : "";
    result.set(frameId, {
      frame_id: frameId,
      text,
      text_positions: text.length > 0 ? [{ text, x: 0, y: 0 }] : [],
    });
  }

  return result;
}

/**
 * EN: Filters UI events by time window and app name.
 * @param rows raw UI records.
 * @param filter filtering options.
 * @returns filtered UI records.
 */
function filterUiEvents(
  rows: Array<Record<string, unknown>>,
  filter: {
    startTime: string | null;
    endTime: string | null;
    appName: string | null;
  },
): Array<Record<string, unknown>> {
  const startMs = parseTimeMs(filter.startTime);
  const endMs = parseTimeMs(filter.endTime);

  return rows.filter((row) => {
    const appName = typeof row.app_name === "string" ? row.app_name : null;
    if (filter.appName && appName !== filter.appName) {
      return false;
    }

    const tsMs = parseTimeMs(
      typeof row.timestamp === "string" ? row.timestamp : null,
    );
    if (tsMs === null) {
      return false;
    }
    if (startMs !== null && tsMs < startMs) {
      return false;
    }
    if (endMs !== null && tsMs > endMs) {
      return false;
    }
    return true;
  });
}

/**
 * EN: Filters OCR records by time window and app name.
 * @param rows raw OCR records.
 * @param filter filtering options.
 * @returns filtered OCR records.
 */
function filterOcrRows(
  rows: Array<Record<string, unknown>>,
  filter: {
    startTime: string | null;
    endTime: string | null;
    appName: string | null;
  },
): Array<Record<string, unknown>> {
  const startMs = parseTimeMs(filter.startTime);
  const endMs = parseTimeMs(filter.endTime);

  return rows.filter((row) => {
    const content = asRecord(row.content);
    if (!content) {
      return false;
    }

    const appName =
      typeof content.app_name === "string" ? content.app_name : null;
    if (filter.appName && appName !== filter.appName) {
      return false;
    }

    const tsMs = parseTimeMs(
      typeof content.timestamp === "string" ? content.timestamp : null,
    );
    if (tsMs === null) {
      return false;
    }
    if (startMs !== null && tsMs < startMs) {
      return false;
    }
    if (endMs !== null && tsMs > endMs) {
      return false;
    }
    return true;
  });
}

/**
 * EN: Reads NDJSON and parses each non-empty line into a JSON object.
 * @param filePath NDJSON file path.
 * @returns parsed object list.
 */
async function readNdjson(
  filePath: string,
): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/**
 * EN: Writes one JSON HTTP response.
 * @param res HTTP response object.
 * @param status HTTP status code.
 * @param body response body.
 * @returns no return value.
 */
function writeJsonResponse(
  res: ServerResponse,
  status: number,
  body: unknown,
): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

/**
 * EN: Parses one query value into a positive integer.
 * @param value raw query value.
 * @returns positive integer or null.
 */
function parsePositiveInt(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.trunc(parsed);
}

/**
 * EN: Parses one query value into a non-negative integer.
 * @param value raw query value.
 * @returns non-negative integer or null.
 */
function parseNonNegativeInt(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return Math.trunc(parsed);
}

/**
 * EN: Parses an optional ISO timestamp into epoch milliseconds.
 * @param value ISO timestamp text.
 * @returns epoch milliseconds or null.
 */
function parseTimeMs(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const tsMs = Date.parse(value);
  return Number.isNaN(tsMs) ? null : tsMs;
}

/**
 * EN: Safely parses `frame_id` into a numeric value.
 * @param value raw frame_id value.
 * @returns numeric frame_id or null.
 */
function parseFrameId(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.trunc(parsed);
    }
  }
  return null;
}

/**
 * EN: Safely narrows an unknown value into a plain object.
 * @param value arbitrary input value.
 * @returns object or null.
 */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  return value as Record<string, unknown>;
}
