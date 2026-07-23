import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  downloadFileWithSha256,
  fetchBytesWithTimeout,
  sanitizeDownloadUrl,
} from "../scripts/lib/download.mjs";

const tempRoots = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("bounded artifact downloads", () => {
  it("atomically writes content after matching its pinned checksum", async () => {
    const root = await mkdtemp(join(tmpdir(), "oyster-download-helper-"));
    tempRoots.push(root);
    const destinationPath = join(root, "artifact.bin");
    const body = new TextEncoder().encode("trusted artifact");
    const expectedSha256 = createHash("sha256").update(body).digest("hex");

    await expect(
      downloadFileWithSha256({
        destinationPath,
        expectedSha256: `sha256:${expectedSha256}`,
        fetchImpl: vi.fn(async () => new Response(body)),
        requireChecksum: true,
        url: "https://example.com/artifact?token=secret",
      }),
    ).resolves.toEqual({ sha256: expectedSha256, size: body.byteLength });
    await expect(readFile(destinationPath)).resolves.toEqual(Buffer.from(body));
  });

  it("rejects a checksum mismatch without replacing the destination", async () => {
    const root = await mkdtemp(join(tmpdir(), "oyster-download-mismatch-"));
    tempRoots.push(root);
    const destinationPath = join(root, "artifact.bin");

    await expect(
      downloadFileWithSha256({
        destinationPath,
        expectedSha256: "0".repeat(64),
        fetchImpl: vi.fn(async () => new Response("tampered")),
        requireChecksum: true,
        url: "https://example.com/artifact",
      }),
    ).rejects.toThrow("failed SHA-256 verification");
    await expect(readFile(destinationPath)).rejects.toThrow();
  });

  it("aborts a stalled request at the configured deadline", async () => {
    vi.useFakeTimers();
    const request = fetchBytesWithTimeout("https://example.com/stalled", {
      fetchImpl: vi.fn(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () =>
              reject(init.signal.reason),
            );
          }),
      ),
      timeoutMs: 25,
    });
    const rejection = expect(request).rejects.toThrow("timed out after 25ms");
    await vi.advanceTimersByTimeAsync(25);
    await rejection;
  });

  it("redacts signed query data from diagnostics", () => {
    expect(
      sanitizeDownloadUrl(
        "https://user:pass@example.com/file?token=secret#key",
      ),
    ).toBe("https://example.com/file");
  });
});
