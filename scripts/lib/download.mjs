import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 60_000;

/**
 * Downloads a response body with a hard deadline and useful diagnostics.
 *
 * @param {string | URL} url Remote URL.
 * @param {{ headers?: HeadersInit, timeoutMs?: number, fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<{ bytes: Uint8Array, headers: Headers, status: number }>}
 */
export async function fetchBytesWithTimeout(url, options = {}) {
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort("download-timeout"),
    timeoutMs,
  );
  timeout.unref?.();
  const displayUrl = sanitizeDownloadUrl(url);

  try {
    const response = await (options.fetchImpl ?? fetch)(url, {
      headers: options.headers,
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(
        `Download failed with HTTP ${response.status} ${response.statusText}: ${displayUrl}`,
      );
    }
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      headers: response.headers,
      status: response.status,
    };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(
        `Download timed out after ${timeoutMs}ms: ${displayUrl}`,
        { cause: error },
      );
    }
    if (error instanceof Error && error.message.startsWith("Download failed")) {
      throw error;
    }
    throw new Error(
      `Download request failed for ${displayUrl}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Downloads JSON under the same bounded request policy as binary artifacts.
 *
 * @param {string | URL} url Remote URL.
 * @param {{ headers?: HeadersInit, timeoutMs?: number, fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<unknown>}
 */
export async function fetchJsonWithTimeout(url, options = {}) {
  const { bytes } = await fetchBytesWithTimeout(url, options);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw new Error(
      `Downloaded response was not valid JSON: ${sanitizeDownloadUrl(url)}`,
      {
        cause: error,
      },
    );
  }
}

/**
 * Downloads to a temporary sibling, verifies SHA-256 when supplied, then
 * atomically replaces the destination.
 *
 * @param {{ url: string | URL, destinationPath: string, expectedSha256?: string | null, requireChecksum?: boolean, headers?: HeadersInit, timeoutMs?: number, fetchImpl?: typeof fetch }} input
 * @returns {Promise<{ sha256: string, size: number }>}
 */
export async function downloadFileWithSha256(input) {
  const expectedSha256 = normalizeSha256(input.expectedSha256);
  if (input.requireChecksum === true && !expectedSha256) {
    throw new Error(
      `A pinned SHA-256 checksum is required for ${sanitizeDownloadUrl(input.url)}`,
    );
  }

  const { bytes } = await fetchBytesWithTimeout(input.url, input);
  const actualSha256 = sha256Hex(bytes);
  if (expectedSha256 && actualSha256 !== expectedSha256) {
    throw new Error(
      `Downloaded artifact failed SHA-256 verification: expected=${expectedSha256} actual=${actualSha256} url=${sanitizeDownloadUrl(input.url)}`,
    );
  }

  await mkdir(path.dirname(input.destinationPath), { recursive: true });
  const temporaryPath = `${input.destinationPath}.download-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporaryPath, bytes, { flag: "wx" });
    await rename(temporaryPath, input.destinationPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  return { sha256: actualSha256, size: bytes.byteLength };
}

/**
 * @param {Uint8Array} bytes Bytes to hash.
 * @returns {string} Lowercase hexadecimal SHA-256.
 */
export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Removes credentials, query parameters, and fragments before diagnostics.
 *
 * @param {string | URL} input URL to sanitize.
 * @returns {string} Safe URL representation.
 */
export function sanitizeDownloadUrl(input) {
  try {
    const url = new URL(input);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "<invalid-url>";
  }
}

function normalizeTimeoutMs(value) {
  const timeoutMs = value ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      `Download timeout must be a positive integer, received ${timeoutMs}`,
    );
  }
  return timeoutMs;
}

function normalizeSha256(value) {
  if (value === undefined || value === null || value.trim() === "") {
    return null;
  }
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^sha256:/u, "");
  if (!/^[a-f0-9]{64}$/u.test(normalized)) {
    throw new Error(`Invalid SHA-256 checksum: ${value}`);
  }
  return normalized;
}
