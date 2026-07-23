import { access, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runIngest } from "../src/cli/commands/ingest.js";
import { detectCapabilities } from "../src/screenpipe/capability.js";
import { ScreenpipeHttpError } from "../src/screenpipe/client.js";
import type {
  HealthResponse,
  SearchResponse,
  UiEventsResponse,
} from "../src/types/contracts.js";
class MockScreenpipeClient {
  readonly uiEventsEnabled: boolean;

  constructor(uiEventsEnabled: boolean) {
    this.uiEventsEnabled = uiEventsEnabled;
  }

  async health(): Promise<HealthResponse> {
    return { status: "healthy" };
  }

  async uiEvents(params: Record<string, unknown>): Promise<UiEventsResponse> {
    if (!this.uiEventsEnabled) {
      throw new ScreenpipeHttpError(404, "not found", "/ui-events");
    }

    const offset = Number(params.offset ?? 0);
    if (offset > 0) {
      return {
        data: [],
        pagination: { limit: 500, offset, total: 2 },
      };
    }

    return {
      data: [
        {
          id: 1,
          timestamp: "2026-02-27T10:00:00.000Z",
          event_type: "click",
          app_name: "Chrome",
          window_title: "Inbox",
          x: 10,
          y: 20,
        },
        {
          id: 2,
          timestamp: "2026-02-27T10:00:01.000Z",
          event_type: "text",
          app_name: "Chrome",
          window_title: "Inbox",
          text_content: "hello",
        },
      ],
      pagination: { limit: 500, offset, total: 2 },
    };
  }

  async uiEventStats(): Promise<Array<Record<string, unknown>>> {
    return [];
  }

  async frameOcr(frameId: number): Promise<Record<string, unknown>> {
    return {
      frame_id: frameId,
      text_positions: [{ text: "meeting notes", x: 1, y: 1 }],
    };
  }

  async search(params: Record<string, unknown>): Promise<SearchResponse> {
    const contentType = String(params.content_type ?? "all");
    const offset = Number(params.offset ?? 0);

    if (contentType === "ocr") {
      if (offset > 0) {
        return {
          data: [],
          pagination: { limit: 500, offset, total: 1 },
        };
      }

      return {
        data: [
          {
            type: "OCR",
            content: {
              frame_id: 11,
              timestamp: "2026-02-27T10:00:02.000Z",
              app_name: "Chrome",
              window_name: "Inbox",
              text: "meeting notes",
            },
          },
        ],
        pagination: { limit: 500, offset, total: 1 },
      };
    }

    if (contentType === "audio") {
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
              chunk_id: 77,
              timestamp: "2026-02-27T10:00:02.500Z",
              transcription: "customer asked for claim status",
              device_name: "MacBook Pro Microphone",
              speaker: {
                id: 12,
                name: "Speaker 12",
              },
            },
          },
        ],
        pagination: { limit: 500, offset, total: 1 },
      };
    }

    if (contentType === "input") {
      return {
        data: [
          {
            type: "Input",
            content: {
              id: 9,
              timestamp: "2026-02-27T10:00:00.000Z",
              event_type: "click",
              app_name: "Chrome",
              window_title: "Inbox",
              x: 50,
              y: 60,
            },
          },
        ],
        pagination: { limit: 500, offset, total: 1 },
      };
    }

    if (contentType === "ui") {
      return {
        data: [
          {
            type: "UI",
            content: {
              id: 31,
              timestamp: "2026-02-27T10:00:03.000Z",
              app_name: "Chrome",
              window_name: "Inbox",
              text: "UI text",
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
            type: "Accessibility",
            content: {
              id: 45,
              timestamp: "2026-02-27T10:00:04.000Z",
              app_name: "Chrome",
              window_name: "Inbox",
              text: "focus moved",
            },
          },
        ],
        pagination: { limit: 500, offset, total: 1 },
      };
    }

    return {
      data: [],
      pagination: { limit: 500, offset, total: 0 },
    };
  }
}
class EmptyScreenpipeClient extends MockScreenpipeClient {
  constructor() {
    super(true);
  }

  async uiEvents(params: Record<string, unknown>): Promise<UiEventsResponse> {
    return {
      data: [],
      pagination: {
        limit: Number(params.limit ?? 500),
        offset: Number(params.offset ?? 0),
        total: 0,
      },
    };
  }

  async search(params: Record<string, unknown>): Promise<SearchResponse> {
    return {
      data: [],
      pagination: {
        limit: Number(params.limit ?? 500),
        offset: Number(params.offset ?? 0),
        total: 0,
      },
    };
  }
}

describe("detectCapabilities", () => {
  it("falls back to /search when /ui-events is unavailable", async () => {
    const warnings: string[] = [];
    const client = new MockScreenpipeClient(false);

    const matrix = await detectCapabilities(client as never, warnings);

    expect(matrix.uiEventsEndpoint).toBe(false);
    expect(matrix.searchAudioContentType).toBe(true);
    expect(matrix.searchInputContentType).toBe(true);
    expect(matrix.searchAccessibilityContentType).toBe(false);
    expect(matrix.chosenUiEventSource).toBe("search-combined");
  });
  it("supports a minimal end-to-end ingest and writes required artifacts", async () => {
    const outRoot = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-test-"),
    );

    const result = await runIngest({
      from: "2026-02-27T10:00:00.000Z",
      to: "2026-02-27T11:00:00.000Z",
      apps: "*",
      out: outRoot,
      baseUrl: "http://localhost:3030",
      clientFactory: () => new MockScreenpipeClient(true) as never,
    });

    expect(result.manifest.status).toBe("success");

    const requiredFiles = [
      result.manifest.paths.rawUiEvents,
      result.manifest.paths.rawOcr,
      result.manifest.paths.rawAudio,
      result.manifest.paths.normalizedEvents,
      result.manifest.paths.episodes,
      result.manifest.paths.summary,
      path.join(result.manifest.paths.runDir, "manifest.json"),
    ];

    await Promise.all(requiredFiles.map((file) => access(file)));

    const episodesRaw = await readFile(result.manifest.paths.episodes, "utf8");
    const episodes = JSON.parse(episodesRaw) as Array<{ eventsCount: number }>;
    expect(episodes.length).toBeGreaterThan(0);
    expect(episodes[0].eventsCount).toBeGreaterThan(0);
    expect(result.summary.timeWindow.requested).toEqual({
      startTs: "2026-02-27T10:00:00.000Z",
      endTs: "2026-02-27T11:00:00.000Z",
      durationMs: 3_600_000,
    });
    expect(result.summary.timeWindow.observed).toEqual({
      startTs: "2026-02-27T10:00:02.000Z",
      endTs: "2026-02-27T10:00:02.500Z",
      durationMs: 500,
    });
    expect(result.summary.fetch.rawAudioCount).toBe(1);
  });
  it("records an empty observed time window when no events are ingested", async () => {
    const outRoot = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-empty-window-"),
    );

    const result = await runIngest({
      from: "2026-02-27T12:00:00.000Z",
      to: "2026-02-27T12:30:00.000Z",
      apps: "*",
      out: outRoot,
      baseUrl: "http://localhost:3030",
      clientFactory: () => new EmptyScreenpipeClient() as never,
    });

    expect(result.summary.timeWindow.requested).toEqual({
      startTs: "2026-02-27T12:00:00.000Z",
      endTs: "2026-02-27T12:30:00.000Z",
      durationMs: 1_800_000,
    });
    expect(result.summary.timeWindow.observed).toEqual({
      startTs: null,
      endTs: null,
      durationMs: 0,
    });
    expect(result.summary.fetch.rawUiEventsCount).toBe(0);
    expect(result.summary.fetch.rawOcrCount).toBe(0);
    expect(result.summary.fetch.rawAudioCount).toBe(0);
  });
});
