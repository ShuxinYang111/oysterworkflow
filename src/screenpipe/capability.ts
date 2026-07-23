import { ScreenpipeClient, ScreenpipeHttpError } from "./client.js";
import type { ScreenpipeCapabilityMatrix } from "../types/contracts.js";

// CN/EN: Temporarily keep accessibility out of ingest. New Screenpipe builds
// can return full accessibility trees for Gmail-like pages, which overwhelms
// downstream skill-extraction prompts while duplicating OCR evidence.
const ACCESSIBILITY_INGEST_ENABLED = false;

/**
 * EN: Probes available Screenpipe endpoints and `content_type` capabilities.
 * @param client Screenpipe client.
 * @param warnings warning accumulator.
 * @returns capability matrix with chosen UI source.
 */
export async function detectCapabilities(
  client: ScreenpipeClient,
  warnings: string[] = [],
): Promise<ScreenpipeCapabilityMatrix> {
  let healthAvailable = false;
  try {
    await client.health();
    healthAvailable = true;
  } catch (error) {
    warnings.push(`health check failed: ${toErrorMessage(error)}`);
  }

  // CN/EN: Fixed probe order keeps behavior deterministic and easier to debug.
  // CN/EN: New Screenpipe builds removed `/ui-events` and `content_type=ui`.
  const uiEventsEndpoint = false;
  const searchAudioContentType = await probeSearchContentType(
    client,
    "audio",
    warnings,
  );
  const searchInputContentType = await probeSearchContentType(
    client,
    "input",
    warnings,
  );
  const searchAccessibilityContentType = ACCESSIBILITY_INGEST_ENABLED
    ? await probeSearchContentType(client, "accessibility", warnings)
    : false;
  const searchUiContentType = false;
  const searchAllContentType = await probeSearchContentType(
    client,
    "all",
    warnings,
  );

  return {
    healthAvailable,
    uiEventsEndpoint,
    searchAudioContentType,
    searchInputContentType,
    searchAccessibilityContentType,
    searchUiContentType,
    searchAllContentType,
    chosenUiEventSource: chooseUiEventSource({
      uiEventsEndpoint,
      searchInputContentType,
      searchAccessibilityContentType,
      searchUiContentType,
      searchAllContentType,
    }),
  };
}

/**
 * EN: Returns preferred UI event source using strict priority.
 * @param args boolean flags from probes.
 * @returns chosen source id.
 */
export function chooseUiEventSource(args: {
  uiEventsEndpoint: boolean;
  searchInputContentType: boolean;
  searchAccessibilityContentType: boolean;
  searchUiContentType: boolean;
  searchAllContentType: boolean;
}): ScreenpipeCapabilityMatrix["chosenUiEventSource"] {
  const hasSearchSpecific =
    args.searchInputContentType || args.searchAccessibilityContentType;
  if (hasSearchSpecific) {
    const enabledSpecificCount = [
      args.searchInputContentType,
      args.searchAccessibilityContentType,
    ].filter(Boolean).length;
    if (args.searchAllContentType || enabledSpecificCount > 1) {
      return "search-combined";
    }
    return args.searchInputContentType
      ? "search-input"
      : "search-accessibility";
  }

  if (args.searchAllContentType) {
    return "search-all";
  }

  return "none";
}

/**
 * EN: Probes availability of a specific `/search` `content_type`.
 * @param client Screenpipe client.
 * @param contentType probed type (input/accessibility/all).
 * @param warnings warning accumulator.
 * @returns true if available, else false.
 */
async function probeSearchContentType(
  client: ScreenpipeClient,
  contentType: "audio" | "input" | "accessibility" | "all",
  warnings: string[],
): Promise<boolean> {
  try {
    await client.search({ content_type: contentType, limit: 1, offset: 0 });
    return true;
  } catch (error) {
    // CN/EN: 4xx here often means this content type is unsupported in current build.
    if (
      error instanceof ScreenpipeHttpError &&
      error.status >= 400 &&
      error.status < 500
    ) {
      warnings.push(
        `/search probe content_type=${contentType} unavailable (${error.status})`,
      );
      return false;
    }
    warnings.push(
      `/search probe content_type=${contentType} failed: ${toErrorMessage(error)}`,
    );
    return false;
  }
}

/**
 * EN: Converts unknown errors to displayable string.
 * @param error unknown error value.
 * @returns error message string.
 */
function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
