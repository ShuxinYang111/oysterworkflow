import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readJsonWithBackup,
  writeJsonAtomic,
  writeTextAtomic,
} from "../src/io/atomic-json.js";

const temporaryRoots: string[] = [];

describe("atomic JSON persistence", () => {
  afterEach(async () => {
    await Promise.all(
      temporaryRoots
        .splice(0)
        .map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("writes the validated value with private permissions", async () => {
    const filePath = await temporaryJsonPath();
    await writeJsonAtomic<{ version?: number }>(
      filePath,
      {},
      {
        validate: (value) => ({
          ...(asRecord(value) ?? {}),
          version: 1,
        }),
      },
    );

    await expect(readJson(filePath)).resolves.toEqual({ version: 1 });
    if (process.platform !== "win32") {
      expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    }
  });

  it("atomically replaces private text configuration", async () => {
    const filePath = await temporaryJsonPath();
    await writeTextAtomic(filePath, "provider: first\n", {
      mode: 0o600,
      backup: false,
    });
    await writeTextAtomic(filePath, "provider: second\n", {
      mode: 0o600,
      backup: false,
    });

    await expect(readFile(filePath, "utf8")).resolves.toBe(
      "provider: second\n",
    );
    if (process.platform !== "win32") {
      expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    }
  });

  it("retains the last valid backup when the primary becomes corrupt", async () => {
    const filePath = await temporaryJsonPath();
    await writeJsonAtomic(
      filePath,
      { version: 1 },
      { validate: requireVersion },
    );
    await writeJsonAtomic(
      filePath,
      { version: 2 },
      { validate: requireVersion },
    );
    await writeFile(filePath, "{corrupt", "utf8");

    await writeJsonAtomic(
      filePath,
      { version: 3 },
      { validate: requireVersion },
    );

    await expect(readJson(filePath)).resolves.toEqual({ version: 3 });
    await expect(readJson(`${filePath}.bak`)).resolves.toEqual({ version: 1 });
  });

  it("falls back to a validated backup and rejects two corrupt copies", async () => {
    const filePath = await temporaryJsonPath();
    await writeJsonAtomic(
      filePath,
      { version: 1 },
      { validate: requireVersion },
    );
    await writeJsonAtomic(
      filePath,
      { version: 2 },
      { validate: requireVersion },
    );
    await writeFile(filePath, "[]", "utf8");

    await expect(
      readJsonWithBackup(filePath, { validate: requireVersion }),
    ).resolves.toEqual({ version: 1 });

    await writeFile(`${filePath}.bak`, "null", "utf8");
    await expect(
      readJsonWithBackup(filePath, { validate: requireVersion }),
    ).rejects.toThrow("Unable to load valid JSON");
  });
});

async function temporaryJsonPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "oyster-atomic-json-"));
  temporaryRoots.push(root);
  return join(root, "config.json");
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8")) as unknown;
}

function requireVersion(value: unknown): { version: number } {
  const record = asRecord(value);
  if (!record || typeof record.version !== "number") {
    throw new Error("version is required");
  }
  return { version: record.version };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
