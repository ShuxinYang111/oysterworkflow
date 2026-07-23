import { Response } from "undici";
import { describe, expect, it } from "vitest";
import {
  extractOutputTextFromChat,
  extractOutputTextFromResponsesHttp,
  parseLooseJson,
} from "../src/skill/extract-openclaw-llm-output.js";

describe("extract-openclaw-llm-output", () => {
  it("parses fenced JSON text", () => {
    const parsed = parseLooseJson('```json\n{"goal":"demo"}\n```') as {
      goal: string;
    };
    expect(parsed.goal).toBe("demo");
  });

  it("parses first JSON value from mixed text", () => {
    const parsed = parseLooseJson(
      'answer: {"goal":"demo","steps":[]} thanks',
    ) as {
      goal: string;
      steps: unknown[];
    };
    expect(parsed.goal).toBe("demo");
    expect(parsed.steps).toEqual([]);
  });

  it("extracts text from chat payload string and chunks", () => {
    expect(
      extractOutputTextFromChat({
        choices: [{ message: { content: "direct text" } }],
      }),
    ).toBe("direct text");

    expect(
      extractOutputTextFromChat({
        choices: [
          {
            message: {
              content: [
                { type: "output_text", text: "chunk text" },
                { type: "output_text", text: "ignored" },
              ],
            },
          },
        ],
      }),
    ).toBe("chunk text");
  });

  it("extracts text from responses JSON payload", async () => {
    const response = new Response(
      JSON.stringify({
        output_text: '{"goal":"demo"}',
        usage: {
          input_tokens: 10,
          output_tokens: 4,
          total_tokens: 14,
        },
      }),
      {
        headers: { "content-type": "application/json" },
      },
    );

    await expect(extractOutputTextFromResponsesHttp(response)).resolves.toEqual(
      {
        outputText: '{"goal":"demo"}',
        usage: {
          inputTokens: 10,
          outputTokens: 4,
          totalTokens: 14,
          cachedInputTokens: null,
          reasoningOutputTokens: null,
        },
      },
    );
  });

  it("extracts text from responses SSE payload", async () => {
    const sseBody = [
      'data: {"type":"response.output_text.delta","delta":"{\\"goal\\":"}',
      'data: {"type":"response.output_text.delta","delta":"\\"demo\\"}"}',
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":21,"output_tokens":8,"total_tokens":29}}}',
      "data: [DONE]",
      "",
    ].join("\n");
    const response = new Response(sseBody, {
      headers: { "content-type": "text/event-stream" },
    });

    await expect(extractOutputTextFromResponsesHttp(response)).resolves.toEqual(
      {
        outputText: '{"goal":"demo"}',
        usage: {
          inputTokens: 21,
          outputTokens: 8,
          totalTokens: 29,
          cachedInputTokens: null,
          reasoningOutputTokens: null,
        },
      },
    );
  });

  it("surfaces plain SSE error events instead of reporting missing output text", async () => {
    const sseBody = [
      'data: {"type":"error","error":{"message":"upstream server error request_id=req-1"}}',
      "data: [DONE]",
      "",
    ].join("\n");
    const response = new Response(sseBody, {
      headers: { "content-type": "text/event-stream" },
    });

    await expect(extractOutputTextFromResponsesHttp(response)).rejects.toThrow(
      "Responses stream error: upstream server error request_id=req-1",
    );
  });

  it("surfaces failed Responses events instead of reporting missing output text", async () => {
    const sseBody = [
      'data: {"type":"response.failed","response":{"error":{"message":"response failed request_id=req-2"}}}',
      "data: [DONE]",
      "",
    ].join("\n");
    const response = new Response(sseBody, {
      headers: { "content-type": "text/event-stream" },
    });

    await expect(extractOutputTextFromResponsesHttp(response)).rejects.toThrow(
      "Responses stream error: response failed request_id=req-2",
    );
  });
});
