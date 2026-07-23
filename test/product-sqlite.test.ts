import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { seedProductState } from "../src/product/seed-state.js";
import { openProductDatabase } from "../src/product/sqlite.js";

const temporaryRoots: string[] = [];

describe("product SQLite adapter", () => {
  afterEach(async () => {
    await Promise.all(
      temporaryRoots
        .splice(0)
        .map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("applies versioned migrations and creates history indexes", async () => {
    const databasePath = await temporaryDatabasePath();
    const database = openProductDatabase(databasePath);
    database.writeState(seedProductState("empty"));
    database.close();

    const inspector = new DatabaseSync(databasePath);
    expect(
      (
        inspector.prepare("PRAGMA user_version").get() as {
          user_version: number;
        }
      ).user_version,
    ).toBe(2);
    expect(
      (
        inspector
          .prepare("SELECT COUNT(*) AS count FROM product_migrations")
          .get() as { count: number }
      ).count,
    ).toBe(2);
    const indexes = inspector
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    expect(indexes.map((row) => row.name)).toContain("idx_runs_started_at");
    expect(indexes.map((row) => row.name)).toContain(
      "idx_run_events_run_created",
    );
    inspector.close();
  });

  it("does not rewrite unchanged entity rows during an account-only update", async () => {
    const databasePath = await temporaryDatabasePath();
    const initialDatabase = openProductDatabase(databasePath);
    initialDatabase.writeState(seedProductState("demo"));
    initialDatabase.close();

    const rowIdEditor = new DatabaseSync(databasePath);
    rowIdEditor
      .prepare("UPDATE workers SET rowid = 9000 WHERE id = 'sales'")
      .run();
    rowIdEditor.close();

    const database = openProductDatabase(databasePath);
    const state = database.readState();
    expect(state).not.toBeNull();
    database.writeState({
      ...state!,
      account: { ...state!.account, name: "Updated account" },
      updatedAt: "2026-07-17T00:02:00.000Z",
    });
    database.close();

    const inspector = new DatabaseSync(databasePath);
    expect(
      (
        inspector
          .prepare("SELECT rowid FROM workers WHERE id = 'sales'")
          .get() as { rowid: number }
      ).rowid,
    ).toBe(9000);
    inspector.close();
  });

  it("upgrades an existing version-one database and rejects future schemas", async () => {
    const databasePath = await temporaryDatabasePath();
    const initial = openProductDatabase(databasePath);
    initial.writeState(seedProductState("empty"));
    initial.close();

    const legacyEditor = new DatabaseSync(databasePath);
    legacyEditor.exec("PRAGMA user_version = 1");
    legacyEditor.exec("DELETE FROM product_migrations WHERE id = 2");
    legacyEditor
      .prepare(
        "UPDATE product_meta SET value = '1' WHERE key = 'schema_version'",
      )
      .run();
    legacyEditor.close();

    openProductDatabase(databasePath).close();
    const futureEditor = new DatabaseSync(databasePath);
    futureEditor.exec("PRAGMA user_version = 99");
    futureEditor.close();
    expect(() => openProductDatabase(databasePath)).toThrow(
      "newer than supported version 2",
    );
  });

  it("checkpoints and closes idempotently", async () => {
    const databasePath = await temporaryDatabasePath();
    const database = openProductDatabase(databasePath);
    database.writeState(seedProductState("empty"));
    database.close();
    expect(() => database.close()).not.toThrow();
    expect(() => database.readState()).toThrow(
      "Product database is already closed.",
    );
  });
});

async function temporaryDatabasePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "oyster-product-sqlite-"));
  temporaryRoots.push(root);
  return join(root, "product-state.sqlite");
}
