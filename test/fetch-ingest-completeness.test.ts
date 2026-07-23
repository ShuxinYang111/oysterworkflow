import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fetchAudio } from "../src/ingest/fetch-audio.js";
import { fetchOcr } from "../src/ingest/fetch-ocr.js";
import { fetchUiEvents } from "../src/ingest/fetch-ui-events.js";
import type { ScreenpipeClient } from "../src/screenpipe/client.js";
import type {
  FrameOcrResponse,
  ScreenpipeCapabilityMatrix,
  SearchResponse,
  UiEventsResponse,
} from "../src/types/contracts.js";
function buildUiRows(
  count: number,
  startId: number,
): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, index) => {
    const id = startId + index;
    return {
      id,
      timestamp: "2026-03-05T01:00:00.000Z",
      event_type: "click",
      app_name: "Chrome",
      window_title: "Inbox",
      x: id,
      y: id + 1,
    };
  });
}
function buildOcrRows(
  frameIds: number[],
): Array<{ type: string; content: Record<string, unknown> }> {
  return frameIds.map((frameId) => ({
    type: "OCR",
    content: {
      frame_id: frameId,
      timestamp: `2026-03-05T01:00:0${frameId}.000Z`,
      app_name: "Chrome",
      window_name: "Doc",
      text: "",
    },
  }));
}

class UiPaginationAnomalyClient {
  async uiEvents(params: Record<string, unknown>): Promise<UiEventsResponse> {
    const offset = Number(params.offset ?? 0);
    if (offset === 0) {
      return {
        data: buildUiRows(500, 1),
        pagination: { limit: 500, offset, total: 500 },
      };
    }
    if (offset === 500) {
      return {
        data: buildUiRows(59, 501),
        pagination: { limit: 500, offset, total: 59 },
      };
    }
    return {
      data: [],
      pagination: { limit: 500, offset, total: 59 },
    };
  }

  async search(): Promise<SearchResponse> {
    throw new Error("search should not be called in ui-events primary test");
  }
}

class SearchCombinedClient {
  async uiEvents(): Promise<UiEventsResponse> {
    throw new Error("ui-events should not be called in search-combined test");
  }

  async search(params: Record<string, unknown>): Promise<SearchResponse> {
    const contentType = String(params.content_type ?? "all");
    const offset = Number(params.offset ?? 0);
    if (offset > 0) {
      return {
        data: [],
        pagination: { limit: 500, offset, total: 2 },
      };
    }

    if (contentType === "input") {
      return {
        data: [
          {
            type: "Input",
            content: {
              id: 11,
              timestamp: "2026-03-05T01:01:00.000Z",
              event_type: "text",
              app_name: "Chrome",
              window_title: "Docs",
              text_content: "draft note",
            },
          },
        ],
        pagination: { limit: 500, offset, total: 1 },
      };
    }

    if (contentType === "accessibility") {
      return {
        data: [
          {
            type: "UI",
            content: {
              timestamp: "2026-03-05T01:01:01.000Z",
              app_name: "Chrome",
              window_name: "Docs",
              text: "selection changed",
            },
          },
        ],
        pagination: { limit: 500, offset, total: 1 },
      };
    }

    if (contentType === "all") {
      // CN/EN: Duplicate of input row + one irrelevant OCR row to validate local filtering.
      return {
        data: [
          {
            type: "Input",
            content: {
              id: 11,
              timestamp: "2026-03-05T01:01:00.000Z",
              event_type: "text",
              app_name: "Chrome",
              window_title: "Docs",
              text_content: "draft note",
            },
          },
          {
            type: "OCR",
            content: {
              timestamp: "2026-03-05T01:01:02.000Z",
              app_name: "Chrome",
              window_name: "Docs",
              text: "should be ignored",
            },
          },
        ],
        pagination: { limit: 500, offset, total: 2 },
      };
    }

    return {
      data: [],
      pagination: { limit: 500, offset, total: 0 },
    };
  }
}

class OcrEnrichmentClient {
  frameCalls: number[] = [];

  async search(params: Record<string, unknown>): Promise<SearchResponse> {
    const offset = Number(params.offset ?? 0);
    if (offset === 0) {
      return {
        data: buildOcrRows([1, 2]),
        pagination: { limit: 2, offset, total: 2 },
      };
    }
    if (offset === 2) {
      return {
        data: buildOcrRows([3]),
        pagination: { limit: 2, offset, total: 1 },
      };
    }
    return {
      data: [],
      pagination: { limit: 2, offset, total: 1 },
    };
  }

  async frameOcr(frameId: number): Promise<FrameOcrResponse> {
    this.frameCalls.push(frameId);
    return {
      frame_id: frameId,
      text_positions: [
        { text: `frame-${frameId}-line-2`, y: 20, x: 5 },
        { text: `frame-${frameId}-line-1`, y: 10, x: 1 },
      ],
    };
  }
}

describe("ingest fetch completeness", () => {
  it("continues ui-events pagination by short-page strategy when totals are inconsistent", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-ui-fetch-"),
    );
    const rawFilePath = path.join(root, "raw-ui-events.ndjson");
    const warnings: string[] = [];

    const capabilities: ScreenpipeCapabilityMatrix = {
      healthAvailable: true,
      uiEventsEndpoint: true,
      searchAudioContentType: true,
      searchInputContentType: true,
      searchAccessibilityContentType: true,
      searchUiContentType: true,
      searchAllContentType: true,
      chosenUiEventSource: "ui-events",
    };

    const result = await fetchUiEvents({
      client: new UiPaginationAnomalyClient() as unknown as ScreenpipeClient,
      from: "2026-03-05T01:00:00.000Z",
      to: "2026-03-05T01:10:00.000Z",
      apps: "*",
      capabilities,
      warnings,
      rawFilePath,
    });

    expect(result.count).toBe(559);
    expect(result.pages).toBe(2);
    expect(warnings.some((item) => item.includes("pagination anomaly"))).toBe(
      true,
    );

    const lines = await readNdjson(rawFilePath);
    expect(lines).toHaveLength(559);
  });
  // EN: search-combined should skip accessibility and dedupe duplicate `all` rows.
  it("merges search input/all and skips accessibility rows", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-search-combined-"),
    );
    const rawFilePath = path.join(root, "raw-ui-events.ndjson");
    const warnings: string[] = [];

    const capabilities: ScreenpipeCapabilityMatrix = {
      healthAvailable: true,
      uiEventsEndpoint: false,
      searchAudioContentType: true,
      searchInputContentType: true,
      searchAccessibilityContentType: true,
      searchUiContentType: false,
      searchAllContentType: true,
      chosenUiEventSource: "search-combined",
    };

    const result = await fetchUiEvents({
      client: new SearchCombinedClient() as unknown as ScreenpipeClient,
      from: "2026-03-05T01:00:00.000Z",
      to: "2026-03-05T01:10:00.000Z",
      apps: "*",
      capabilities,
      warnings,
      rawFilePath,
    });

    expect(result.sourceUsed).toBe("search-combined");
    expect(result.count).toBe(1);
    expect(result.pages).toBe(2);
    expect(warnings.some((item) => item.includes("input+all"))).toBe(true);
    expect(warnings.some((item) => item.includes("accessibility"))).toBe(false);

    const lines = await readNdjson(rawFilePath);
    expect(lines).toHaveLength(1);
    expect(lines.some((row) => String(row.type) === "UI")).toBe(false);
    expect(lines.some((row) => String(row.type) === "Input")).toBe(true);
  });
  it("fetches audio transcriptions and warns when app filters cannot be applied", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-audio-fetch-"),
    );
    const rawFilePath = path.join(root, "raw-audio.ndjson");
    const warnings: string[] = [];

    const client = {
      async search(params: Record<string, unknown>): Promise<SearchResponse> {
        const offset = Number(params.offset ?? 0);
        if (offset > 0) {
          return {
            data: [],
            pagination: { limit: 500, offset, total: 1 },
          };
        }

        return {
          data: [
            {
              type: "Audio",
              content: {
                chunk_id: 91,
                timestamp: "2026-03-05T01:02:00.000Z",
                transcription: "hello from the mic",
                device_name: "MacBook Pro Microphone",
                speaker: { id: 7, name: "Speaker 7" },
              },
            },
            {
              type: "OCR",
              content: {
                timestamp: "2026-03-05T01:02:01.000Z",
                text: "ignore me",
              },
            },
          ],
          pagination: { limit: 500, offset, total: 2 },
        };
      },
    };

    const result = await fetchAudio({
      client: client as unknown as ScreenpipeClient,
      from: "2026-03-05T01:00:00.000Z",
      to: "2026-03-05T01:10:00.000Z",
      apps: ["Chrome"],
      rawFilePath,
      warnings,
    });

    expect(result.count).toBe(1);
    expect(result.pages).toBe(1);
    expect(warnings.some((item) => item.includes("not app-scoped"))).toBe(true);

    const lines = await readNdjson(rawFilePath);
    expect(lines).toHaveLength(1);
    expect(
      (
        lines[0]?.content as
          | {
              transcription?: string;
            }
          | undefined
      )?.transcription,
    ).toBe("hello from the mic");
  });
  it("keeps multiple audio rows from the same chunk and offset", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-audio-fetch-"),
    );
    const rawFilePath = path.join(root, "raw-audio.ndjson");

    const client = {
      async search(): Promise<SearchResponse> {
        return {
          data: [
            {
              type: "Audio",
              content: {
                chunk_id: 91,
                offset_index: 0,
                timestamp: "2026-03-05T01:02:00.000Z",
                transcription: "these codes.",
              },
            },
            {
              type: "Audio",
              content: {
                chunk_id: 91,
                offset_index: 0,
                timestamp: "2026-03-05T01:02:00.000Z",
                transcription: " Put",
              },
            },
          ],
          pagination: { limit: 500, offset: 0, total: 2 },
        };
      },
    };

    const result = await fetchAudio({
      client: client as unknown as ScreenpipeClient,
      from: "2026-03-05T01:00:00.000Z",
      to: "2026-03-05T01:10:00.000Z",
      apps: "*",
      rawFilePath,
    });

    expect(result.count).toBe(2);

    const lines = await readNdjson(rawFilePath);
    expect(
      lines.map(
        (row) =>
          (
            row.content as
              | {
                  transcription?: string;
                }
              | undefined
          )?.transcription,
      ),
    ).toEqual(["these codes.", " Put"]);
  });
  it("enriches OCR rows with frame OCR and avoids truncation on inconsistent totals", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-ocr-fetch-"),
    );
    const rawFilePath = path.join(root, "raw-ocr.ndjson");
    const warnings: string[] = [];
    const client = new OcrEnrichmentClient();

    const result = await fetchOcr({
      client: client as unknown as ScreenpipeClient,
      from: "2026-03-05T01:00:00.000Z",
      to: "2026-03-05T01:10:00.000Z",
      apps: "*",
      rawFilePath,
      warnings,
    });

    expect(result.count).toBe(3);
    expect(result.pages).toBe(2);
    expect(client.frameCalls).toEqual([1, 2, 3]);
    expect(warnings.some((item) => item.includes("pagination anomaly"))).toBe(
      true,
    );

    const firstPayload = result.records[0].payload as {
      content?: { text?: string; text_positions?: Array<{ text?: string }> };
    };
    expect(firstPayload.content?.text_positions?.[0]?.text).toBe(
      "frame-1-line-2",
    );
    expect(firstPayload.content?.text).toBe("frame-1-line-1\nframe-1-line-2");

    const lines = await readNdjson(rawFilePath);
    expect(lines).toHaveLength(3);
  });
});

/**
 * EN: Reads NDJSON file and parses each non-empty line as JSON.
 * @param filePath NDJSON file path.
 * @returns parsed object array.
 */
async function readNdjson(
  filePath: string,
): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(filePath, "utf8");
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}
