import type { Response as UndiciResponse } from "undici";
// EN: Minimal Responses API payload subset used for output-text parsing.
interface OpenAiResponsesPayload {
  output_text?: string;
  usage?: Record<string, unknown>;
  output?: Array<{
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
}
// EN: Minimal chat/completions payload subset used for output-text parsing.
interface OpenAiChatCompletionsPayload {
  usage?: Record<string, unknown>;
  choices?: Array<{
    message?: {
      content?:
        | string
        | Array<{
            type?: string;
            text?: string;
          }>;
    };
  }>;
}

export interface LlmUsageSnapshot {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cachedInputTokens: number | null;
  reasoningOutputTokens: number | null;
}

export interface LlmTextExtractionResult {
  outputText: string;
  usage: LlmUsageSnapshot | null;
}

/**
 * EN: Extracts output text from Responses HTTP responses, supporting both JSON and SSE.
 * @param response Responses API HTTP response.
 * @returns extracted model output text.
 */
export interface ResponsesStreamTrace {
  /** First byte timestamp (ms epoch). */
  firstByteAtMs: number | null;
  /** First SSE data event timestamp (ms epoch). */
  firstEventAtMs: number | null;
  /** Last event timestamp (ms epoch). */
  lastEventAtMs: number | null;
  /** Whether `response.completed` was seen. */
  sawCompleted: boolean;
  /** Whether an SSE error or failed response event was seen. */
  sawError: boolean;
  /** Usage extracted from the final event. */
  usage: LlmUsageSnapshot | null;
}

export interface ResponsesStreamHooks {
  /** Byte/chunk activity callback. */
  onActivity?: () => void;
  /** Delta text callback. */
  onDelta?: (delta: string) => void;
  /** Final text callback. */
  onFinalText?: (text: string) => void;
  /** Raw SSE event callback. */
  onEvent?: (event: unknown) => void;
}

export async function extractOutputTextFromResponsesHttp(
  response: UndiciResponse,
  trace?: ResponsesStreamTrace,
  hooks?: ResponsesStreamHooks,
): Promise<LlmTextExtractionResult> {
  const contentType = (
    response.headers.get("content-type") ?? ""
  ).toLowerCase();
  if (contentType.includes("text/event-stream")) {
    return extractOutputTextFromResponsesSseStream(response, trace, hooks);
  }

  const json = (await response.json()) as OpenAiResponsesPayload;
  const outputText = extractOutputTextFromResponses(json);
  if (hooks?.onFinalText && outputText) {
    hooks.onFinalText(outputText);
  }
  return {
    outputText,
    usage: normalizeUsageSnapshot(json.usage),
  };
}

/**
 * EN: Extracts output text from a chat/completions payload.
 * @param payload chat/completions payload.
 * @returns model output text.
 */
export function extractOutputTextFromChat(payload: unknown): string {
  const typedPayload = payload as OpenAiChatCompletionsPayload;
  const firstMessage = typedPayload.choices?.[0]?.message?.content;
  if (typeof firstMessage === "string" && firstMessage.trim().length > 0) {
    return firstMessage;
  }

  if (Array.isArray(firstMessage)) {
    for (const chunk of firstMessage) {
      if (typeof chunk.text === "string" && chunk.text.trim().length > 0) {
        return chunk.text;
      }
    }
  }

  return "";
}

export function extractChatCompletionResult(
  payload: unknown,
): LlmTextExtractionResult {
  const typedPayload = payload as OpenAiChatCompletionsPayload;
  return {
    outputText: extractOutputTextFromChat(payload),
    usage: normalizeUsageSnapshot(typedPayload.usage),
  };
}

/**
 * EN: Parses JSON text loosely, supporting markdown fences and mixed wrapper text.
 * @param text raw model output text.
 * @returns parsed JSON value.
 */
export function parseLooseJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fallback below
  }

  const fencedMatch =
    trimmed.match(/```json\s*([\s\S]*?)```/i) ??
    trimmed.match(/```\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    return JSON.parse(fencedMatch[1].trim());
  }

  const firstValue = tryParseFirstJsonValue(trimmed);
  if (firstValue !== null) {
    return firstValue;
  }

  throw new Error("LLM output is not valid JSON.");
}

async function extractOutputTextFromResponsesSseStream(
  response: UndiciResponse,
  trace?: ResponsesStreamTrace,
  hooks?: ResponsesStreamHooks,
): Promise<LlmTextExtractionResult> {
  const body = response.body;
  if (!body) {
    return {
      outputText: "",
      usage: null,
    };
  }

  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let deltaBuffer = "";
  let finalCandidate = "";

  const activeTrace: ResponsesStreamTrace = trace ?? {
    firstByteAtMs: null,
    firstEventAtMs: null,
    lastEventAtMs: null,
    sawCompleted: false,
    sawError: false,
    usage: null,
  };

  const processChunk = (chunk: string): void => {
    const lines = chunk.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) {
        continue;
      }
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") {
        continue;
      }
      let event: unknown;
      try {
        event = JSON.parse(payload);
      } catch {
        continue;
      }

      if (activeTrace.firstEventAtMs === null) {
        activeTrace.firstEventAtMs = Date.now();
      }
      activeTrace.lastEventAtMs = Date.now();

      hooks?.onEvent?.(event);

      const errorMessage = extractResponseErrorMessage(event);
      if (errorMessage) {
        activeTrace.sawError = true;
        throw new Error("Responses stream error: " + errorMessage);
      }

      const delta = extractResponseDeltaText(event);
      if (delta) {
        deltaBuffer += delta;
        hooks?.onDelta?.(delta);
      }

      const eventText = extractOutputTextFromResponseEvent(event);
      if (eventText) {
        finalCandidate = eventText;
        hooks?.onFinalText?.(eventText);
      }

      if (isResponseCompletedEvent(event)) {
        activeTrace.sawCompleted = true;
        activeTrace.usage = normalizeUsageSnapshot(
          (event as { response?: { usage?: Record<string, unknown> } }).response
            ?.usage,
        );
      }
    }
  };

  let stopReading = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    hooks?.onActivity?.();

    if (activeTrace.firstByteAtMs === null) {
      activeTrace.firstByteAtMs = Date.now();
    }

    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const chunk = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      processChunk(chunk);
      if (activeTrace.sawCompleted) {
        stopReading = true;
        break;
      }
      boundary = buffer.indexOf("\n\n");
    }

    if (stopReading) {
      try {
        await reader.cancel();
      } catch {
        // best-effort cleanup
      }
      break;
    }
  }

  buffer += decoder.decode();
  if (buffer.trim().length > 0) {
    processChunk(buffer);
  }

  if (
    finalCandidate.length > 0 &&
    finalCandidate.length >= deltaBuffer.length
  ) {
    return {
      outputText: finalCandidate,
      usage: activeTrace.usage,
    };
  }
  return {
    outputText: deltaBuffer || finalCandidate,
    usage: activeTrace.usage,
  };
}

function normalizeUsageSnapshot(value: unknown): LlmUsageSnapshot | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const usage = value as Record<string, unknown>;
  const detailsInput =
    typeof usage.input_tokens_details === "object" &&
    usage.input_tokens_details !== null
      ? (usage.input_tokens_details as Record<string, unknown>)
      : null;
  const detailsOutput =
    typeof usage.output_tokens_details === "object" &&
    usage.output_tokens_details !== null
      ? (usage.output_tokens_details as Record<string, unknown>)
      : null;
  const inputTokens = normalizeTokenCount(
    usage.input_tokens ?? usage.prompt_tokens,
  );
  const outputTokens = normalizeTokenCount(
    usage.output_tokens ?? usage.completion_tokens,
  );
  const totalTokens =
    normalizeTokenCount(usage.total_tokens) ??
    (inputTokens !== null && outputTokens !== null
      ? inputTokens + outputTokens
      : null);
  const cachedInputTokens = normalizeTokenCount(detailsInput?.cached_tokens);
  const reasoningOutputTokens = normalizeTokenCount(
    detailsOutput?.reasoning_tokens,
  );

  if (
    inputTokens === null &&
    outputTokens === null &&
    totalTokens === null &&
    cachedInputTokens === null &&
    reasoningOutputTokens === null
  ) {
    return null;
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cachedInputTokens,
    reasoningOutputTokens,
  };
}

function normalizeTokenCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.round(value);
}

function isResponseCompletedEvent(event: unknown): boolean {
  if (!event || typeof event !== "object") {
    return false;
  }
  return (event as Record<string, unknown>).type === "response.completed";
}

/**
 * EN: Extracts delta text from one Responses stream event.
 * @param event one SSE event JSON.
 * @returns delta text.
 */
function extractResponseDeltaText(event: unknown): string {
  if (!event || typeof event !== "object") {
    return "";
  }

  const record = event as Record<string, unknown>;
  if (
    record.type === "response.output_text.delta" &&
    typeof record.delta === "string"
  ) {
    return record.delta;
  }
  return "";
}

/**
 * EN: Extracts a final-text candidate from one Responses event.
 * @param event one SSE event JSON.
 * @returns text candidate.
 */
function extractOutputTextFromResponseEvent(event: unknown): string {
  if (!event || typeof event !== "object") {
    return "";
  }

  const record = event as Record<string, unknown>;
  if (
    record.type === "response.output_text.done" &&
    typeof record.text === "string"
  ) {
    return record.text;
  }
  if (
    typeof record.output_text === "string" &&
    record.output_text.trim().length > 0
  ) {
    return record.output_text;
  }

  const nestedResponse = record.response;
  if (nestedResponse && typeof nestedResponse === "object") {
    const nestedText = extractOutputTextFromResponseEvent(nestedResponse);
    if (nestedText) {
      return nestedText;
    }
  }

  const output = record.output;
  if (Array.isArray(output)) {
    for (const item of output) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const content = (item as Record<string, unknown>).content;
      if (!Array.isArray(content)) {
        continue;
      }
      for (const block of content) {
        if (!block || typeof block !== "object") {
          continue;
        }
        const blockRecord = block as Record<string, unknown>;
        if (
          blockRecord.type === "output_text" &&
          typeof blockRecord.text === "string"
        ) {
          return blockRecord.text;
        }
      }
    }
  }

  return "";
}

/**
 * EN: Extracts an error message from one Responses stream event.
 * @param event one SSE event JSON.
 * @returns error message when the event represents an error.
 */
function extractResponseErrorMessage(event: unknown): string | null {
  if (!event || typeof event !== "object") {
    return null;
  }

  const record = event as Record<string, unknown>;
  if (record.type === "error" || record.type === "response.error") {
    const message = extractErrorMessage(record.error);
    if (message) {
      return message;
    }
  }

  if (record.type === "response.failed") {
    const response = record.response;
    if (response && typeof response === "object") {
      return extractErrorMessage((response as Record<string, unknown>).error);
    }
  }

  return null;
}

function extractErrorMessage(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const message = (value as Record<string, unknown>).message;
  return typeof message === "string" && message.trim().length > 0
    ? message
    : null;
}

/**
 * EN: Extracts output text from a Responses payload.
 * @param payload Responses payload.
 * @returns model output text.
 */
function extractOutputTextFromResponses(
  payload: OpenAiResponsesPayload,
): string {
  if (
    typeof payload.output_text === "string" &&
    payload.output_text.trim().length > 0
  ) {
    return payload.output_text;
  }

  for (const item of payload.output ?? []) {
    for (const content of item.content ?? []) {
      if (
        content.type === "output_text" &&
        typeof content.text === "string" &&
        content.text.trim().length > 0
      ) {
        return content.text;
      }
    }
  }

  return "";
}

/**
 * EN: Tries to parse the first complete JSON value from mixed text.
 * @param text mixed text.
 * @returns parsed JSON value or null.
 */
function tryParseFirstJsonValue(text: string): unknown | null {
  for (let start = 0; start < text.length; start += 1) {
    const starter = text[start];
    if (starter !== "{" && starter !== "[") {
      continue;
    }

    const stack: string[] = [starter];
    let inString = false;
    let escaped = false;

    for (let index = start + 1; index < text.length; index += 1) {
      const char = text[index];

      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === "\\") {
          escaped = true;
          continue;
        }
        if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
        continue;
      }

      if (char === "{" || char === "[") {
        stack.push(char);
        continue;
      }

      if (char === "}" || char === "]") {
        const expectedOpen = char === "}" ? "{" : "[";
        if (stack[stack.length - 1] !== expectedOpen) {
          break;
        }
        stack.pop();
        if (stack.length > 0) {
          continue;
        }

        const candidate = text.slice(start, index + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          break;
        }
      }
    }
  }

  return null;
}
