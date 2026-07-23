import { describe, expect, it } from "vitest";
import { normalizeEvents } from "../src/ingest/normalize.js";
import type { RawEventWithRef } from "../src/types/contracts.js";

describe("normalizeEvents", () => {
  it("maps mixed source payloads to a unified model", () => {
    const input: RawEventWithRef[] = [
      {
        source: "ui-events",
        rawRef: { file: "/tmp/ui.ndjson", line: 1 },
        payload: {
          id: 101,
          timestamp: "2026-02-27T10:00:00.000Z",
          event_type: "click",
          app_name: "Chrome",
          window_title: "Inbox",
          x: 100,
          y: 200,
        },
      },
      {
        source: "search-ocr",
        rawRef: { file: "/tmp/ocr.ndjson", line: 1 },
        payload: {
          type: "OCR",
          content: {
            frame_id: 555,
            timestamp: "2026-02-27T10:00:01.000Z",
            app_name: "Chrome",
            window_name: "Inbox",
            text: "meeting notes",
          },
        },
      },
      {
        source: "search-input",
        rawRef: { file: "/tmp/ui.ndjson", line: 2 },
        payload: {
          type: "Input",
          content: {
            id: 202,
            timestamp: "2026-02-27T10:00:02.000Z",
            event_type: "text",
            text_content: "hello",
            app_name: "Slack",
            window_title: "DM",
          },
        },
      },
      {
        source: "search-audio",
        rawRef: { file: "/tmp/audio.ndjson", line: 1 },
        payload: {
          type: "Audio",
          content: {
            chunk_id: 301,
            timestamp: "2026-02-27T10:00:02.500Z",
            transcription: "please check the claim status",
            file_path:
              "/tmp/MacBook Pro Microphone (input)_2026-02-27_10-00-00.mp4",
            start_time: 0.5,
            end_time: 3.25,
            device_name: "MacBook Pro Microphone",
            speaker: {
              id: 19,
              name: "Speaker 19",
            },
          },
        },
      },
      {
        source: "search-accessibility",
        rawRef: { file: "/tmp/ui.ndjson", line: 4 },
        payload: {
          type: "Accessibility",
          content: {
            timestamp: "2026-02-27T10:00:03.000Z",
            app_name: "Chrome",
            window_name: "Inbox",
            text: "selection changed",
          },
        },
      },
    ];

    const warnings: string[] = [];
    const output = normalizeEvents(input, warnings);

    expect(warnings).toEqual([]);
    expect(output).toHaveLength(5);

    expect(output[0]).toMatchObject({
      source: "ui-events",
      eventType: "click",
      appName: "Chrome",
      windowName: "Inbox",
      x: 100,
      y: 200,
    });

    expect(output[1]).toMatchObject({
      source: "search-ocr",
      eventType: "ocr",
      textContent: "meeting notes",
      frameId: 555,
    });

    expect(output[2]).toMatchObject({
      source: "search-input",
      eventType: "text",
      textContent: "hello",
      appName: "Slack",
    });

    expect(output[3]).toMatchObject({
      source: "search-audio",
      eventType: "audio",
      textContent: "please check the claim status",
      deviceName: "MacBook Pro Microphone",
      speakerName: "Speaker 19",
      spanStartTsIso: "2026-02-27T10:00:00.500Z",
      spanStartTsMs: Date.parse("2026-02-27T10:00:00.500Z"),
      spanEndTsIso: "2026-02-27T10:00:03.250Z",
      spanEndTsMs: Date.parse("2026-02-27T10:00:03.250Z"),
    });

    expect(output[4]).toMatchObject({
      source: "search-accessibility",
      eventType: "text",
      textContent: "selection changed",
      appName: "Chrome",
      windowName: "Inbox",
    });
  });
  it("records warnings for invalid rows and skips them", () => {
    const input: RawEventWithRef[] = [
      {
        source: "ui-events",
        rawRef: { file: "/tmp/ui.ndjson", line: 1 },
        payload: {
          id: 1,
          event_type: "click",
        },
      },
      {
        source: "ui-events",
        rawRef: { file: "/tmp/ui.ndjson", line: 2 },
        payload: {
          id: 2,
          timestamp: "not-a-date",
          event_type: "click",
        },
      },
    ];

    const warnings: string[] = [];
    const output = normalizeEvents(input, warnings);

    expect(output).toHaveLength(0);
    expect(warnings).toHaveLength(2);
  });
  it("rebuilds OCR text from text_positions when text field is empty", () => {
    const input: RawEventWithRef[] = [
      {
        source: "search-ocr",
        rawRef: { file: "/tmp/ocr.ndjson", line: 8 },
        payload: {
          type: "OCR",
          content: {
            frame_id: 99,
            timestamp: "2026-02-27T10:03:00.000Z",
            text: "",
            text_positions: [
              { text: "line-b", y: 20, x: 5 },
              { text: "line-a", y: 10, x: 3 },
            ],
          },
        },
      },
    ];

    const warnings: string[] = [];
    const output = normalizeEvents(input, warnings);

    expect(warnings).toEqual([]);
    expect(output).toHaveLength(1);
    expect(output[0].textContent).toBe("line-a\nline-b");
  });
});
