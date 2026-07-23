import { describe, expect, it } from "vitest";
import { filterRawEvents } from "../src/ingest/filter-raw-events.js";
import type { RawEventWithRef } from "../src/types/contracts.js";

describe("filterRawEvents", () => {
  it("drops records when app/window hits noise keywords", () => {
    const input: RawEventWithRef[] = [
      {
        source: "search-input",
        rawRef: { file: "/tmp/ui.ndjson", line: 1 },
        payload: {
          type: "Input",
          content: {
            app_name: "WezTerm",
            window_title: "shell",
          },
        },
      },
    ];

    const result = filterRawEvents(input);

    expect(result.filteredRecords).toHaveLength(0);
    expect(result.dropped).toBe(1);
    expect(result.kept).toBe(0);
  });

  it("keeps records when app/window fields are missing", () => {
    const input: RawEventWithRef[] = [
      {
        source: "search-ocr",
        rawRef: { file: "/tmp/ocr.ndjson", line: 5 },
        payload: {
          type: "OCR",
          content: {
            timestamp: "2026-03-10T10:00:00.000Z",
            text: "hello",
          },
        },
      },
    ];

    const result = filterRawEvents(input);

    expect(result.filteredRecords).toHaveLength(1);
    expect(result.dropped).toBe(0);
    expect(result.kept).toBe(1);
  });

  it("keeps records for normal context", () => {
    const input: RawEventWithRef[] = [
      {
        source: "ui-events",
        rawRef: { file: "/tmp/ui.ndjson", line: 2 },
        payload: {
          app_name: "Chrome",
          window_title: "Docs",
        },
      },
    ];

    const result = filterRawEvents(input);

    expect(result.filteredRecords).toHaveLength(1);
    expect(result.dropped).toBe(0);
    expect(result.kept).toBe(1);
  });

  it("drops search-input click rows even when app/window fields are missing", () => {
    const input: RawEventWithRef[] = [
      {
        source: "search-input",
        rawRef: { file: "/tmp/ui.ndjson", line: 3 },
        payload: {
          type: "Input",
          content: {
            event_type: "click",
            timestamp: "2026-03-10T10:00:00.000Z",
            x: 711,
            y: 368,
          },
        },
      },
    ];

    const result = filterRawEvents(input);

    expect(result.filteredRecords).toHaveLength(0);
    expect(result.dropped).toBe(1);
    expect(result.kept).toBe(0);
  });

  it("keeps search-input text rows so typed evidence remains available", () => {
    const input: RawEventWithRef[] = [
      {
        source: "search-input",
        rawRef: { file: "/tmp/ui.ndjson", line: 4 },
        payload: {
          type: "Input",
          content: {
            event_type: "text",
            timestamp: "2026-03-10T10:00:01.000Z",
            text_content: "gmail",
          },
        },
      },
    ];

    const result = filterRawEvents(input);

    expect(result.filteredRecords).toHaveLength(1);
    expect(result.dropped).toBe(0);
    expect(result.kept).toBe(1);
  });

  it("drops OysterWorkflow records from the built-in lab window", () => {
    const input: RawEventWithRef[] = [
      {
        source: "search-input",
        rawRef: { file: "/tmp/ui.ndjson", line: 9 },
        payload: {
          type: "Input",
          content: {
            app_name: "OysterWorkflow",
            window_title: "Extraction Lab",
          },
        },
      },
    ];

    const result = filterRawEvents(input);

    expect(result.filteredRecords).toHaveLength(0);
    expect(result.dropped).toBe(1);
    expect(result.kept).toBe(0);
  });
});
