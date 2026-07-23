import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createInstallationId } from "./identity.js";
import { retainProductStateHistory } from "./history-retention.js";
import type {
  ProductAccount,
  ProductApprovalPolicy,
  ProductArtifact,
  ProductCaptureSession,
  ProductChannelBinding,
  ProductChannelConnection,
  ProductChannelSetup,
  ProductCapabilityProvider,
  ProductCloudDelete,
  ProductCloudUpsert,
  ProductCommand,
  ProductDevice,
  ProductHermesStatus,
  ProductInstalledWorkflow,
  ProductPermissionSnapshot,
  ProductRun,
  ProductRunEvent,
  ProductState,
  ProductWorker,
  ProductWorkflow,
  ProductWorkflowTombstone,
  ProductWorkspace,
} from "./contracts.js";
import {
  defaultHermesProviderHealth,
  normalizeHermesProviderHealth,
} from "./hermes-provider-status.js";

const CURRENT_SCHEMA_VERSION = 2;
const DEFAULT_HERMES_PROVIDER_HEALTH_JSON = JSON.stringify(
  defaultHermesProviderHealth(),
);

export interface ProductDatabase {
  readState: () => ProductState | null;
  writeState: (state: ProductState) => void;
  hasDataMigration: (migrationId: string) => boolean;
  markDataMigration: (migrationId: string) => void;
  databasePath: string;
  installationId: string;
  close: () => void;
}

interface SqlRow {
  [key: string]: unknown;
}

/**
 * EN: Opens the local SQLite product database and runs migrations.
 * 中文: 打开本地 SQLite 产品数据库并执行迁移。
 * @param databasePath absolute SQLite database path.
 * @returns database adapter used by the product store.
 */
export function openProductDatabase(databasePath: string): ProductDatabase {
  mkdirSync(dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("BEGIN IMMEDIATE");
  try {
    migrate(db);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    db.close();
    throw error;
  }
  const installationId = ensureInstallationId(db);
  let cachedState: ProductState | null | undefined;
  let closed = false;

  return {
    databasePath,
    installationId,
    readState: () => {
      assertDatabaseOpen(closed);
      cachedState ??= readState(db);
      return cachedState;
    },
    writeState: (state) => {
      assertDatabaseOpen(closed);
      cachedState ??= readState(db);
      const retainedState = retainProductStateHistory(state);
      writeState(db, cachedState, retainedState);
      cachedState = retainedState;
    },
    hasDataMigration: (migrationId) => {
      assertDatabaseOpen(closed);
      return readMeta(db, dataMigrationMetaKey(migrationId)) === "complete";
    },
    markDataMigration: (migrationId) => {
      assertDatabaseOpen(closed);
      upsertMeta(db, dataMigrationMetaKey(migrationId), "complete");
    },
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      try {
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } finally {
        db.close();
      }
    },
  };
}

function assertDatabaseOpen(closed: boolean): void {
  if (closed) {
    throw new Error("Product database is already closed.");
  }
}

function migrate(db: DatabaseSync): void {
  const userVersion = (
    db.prepare("PRAGMA user_version").get() as { user_version: number }
  ).user_version;
  if (userVersion > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Product database schema ${String(userVersion)} is newer than supported version ${String(CURRENT_SCHEMA_VERSION)}.`,
    );
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS product_migrations (
      id INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS product_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      signed_in_label TEXT NOT NULL,
      cloud_provider TEXT,
      cloud_user_id TEXT,
      cloud_sync_revision INTEGER NOT NULL DEFAULT -1,
      setup_completed INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      mode TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      owner TEXT NOT NULL,
      assigned_worker_id TEXT,
      heartbeat TEXT NOT NULL,
      location TEXT NOT NULL,
      runtime_version TEXT NOT NULL,
      queue_json TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS permission_snapshots (
      id TEXT PRIMARY KEY,
      checked_at TEXT NOT NULL,
      all_granted INTEGER NOT NULL,
      can_start_recording INTEGER NOT NULL,
      source TEXT NOT NULL,
      summary TEXT NOT NULL,
      items_json TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS workers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      initials TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL,
      tone TEXT NOT NULL,
      avatar_key TEXT NOT NULL,
      device_id TEXT,
      selected_installed_workflow_id TEXT,
      heartbeat TEXT NOT NULL,
      activities_json TEXT NOT NULL,
      config_json TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS channel_connections (
      id TEXT PRIMARY KEY,
      worker_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      label TEXT NOT NULL,
      setup_method TEXT NOT NULL,
      status TEXT NOT NULL,
      account_label TEXT,
      hermes_profile TEXT NOT NULL,
      configured_fields_json TEXT NOT NULL,
      missing_fields_json TEXT NOT NULL,
      last_checked_at TEXT,
      last_connected_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS channel_setups (
      id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL,
      worker_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      status TEXT NOT NULL,
      qr_payload TEXT,
      qr_expires_at TEXT,
      account_label TEXT,
      process_id INTEGER,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS channel_bindings (
      id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL,
      worker_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      thread_id TEXT,
      conversation_label TEXT,
      hermes_profile TEXT NOT NULL,
      hermes_session_id TEXT NOT NULL,
      status TEXT NOT NULL,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (connection_id, conversation_id, thread_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_text TEXT,
      confidence INTEGER,
      apps_json TEXT NOT NULL,
      stats_json TEXT NOT NULL,
      detected_at TEXT NOT NULL,
      artifact_path TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS capture_sessions (
      id TEXT PRIMARY KEY,
      lab_session_id TEXT NOT NULL,
      session_path TEXT NOT NULL,
      artifact_root TEXT NOT NULL,
      status TEXT NOT NULL,
      title TEXT NOT NULL,
      latest_run_id TEXT,
      latest_run_dir TEXT,
      ingest_summary_path TEXT,
      workflow_discovery_path TEXT,
      selected_workflow_id TEXT,
      skill_path TEXT,
      stats_json TEXT NOT NULL,
      artifact_missing INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS product_artifacts (
      id TEXT PRIMARY KEY,
      capture_session_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      path TEXT NOT NULL,
      status TEXT NOT NULL,
      size_bytes INTEGER,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS installed_workflows (
      id TEXT PRIMARY KEY,
      worker_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      workflow_title TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL,
      apps_json TEXT NOT NULL,
      installed_at TEXT NOT NULL,
      deploy_target_device_id TEXT,
      approval_policy TEXT NOT NULL,
      hermes_skill_reference TEXT NOT NULL,
      hermes_install_reference TEXT NOT NULL,
      hermes_skill_name TEXT NOT NULL,
      hermes_skill_path TEXT NOT NULL,
      source_skill_path TEXT,
      source_workflow_revision_id TEXT,
      baseline_runs INTEGER NOT NULL,
      baseline_successes INTEGER NOT NULL,
      baseline_last_run TEXT NOT NULL,
      update_available INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      worker_id TEXT NOT NULL,
      installed_workflow_id TEXT NOT NULL,
      workflow_title TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'workflow',
      status TEXT NOT NULL,
      command TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      hermes_session_id TEXT,
      error_message TEXT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS run_events (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      worker_id TEXT NOT NULL,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS commands (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      worker_id TEXT NOT NULL,
      command TEXT NOT NULL,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      error_message TEXT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS approval_policies (
      id TEXT PRIMARY KEY,
      scope_type TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      description TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS workflow_tombstones (
      workflow_id TEXT PRIMARY KEY,
      workflow_title TEXT NOT NULL,
      deleted_at TEXT NOT NULL,
      deleted_by_account_id TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS pending_cloud_deletes (
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      deleted_at TEXT NOT NULL,
      PRIMARY KEY (entity_type, entity_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS pending_cloud_upserts (
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (entity_type, entity_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS hermes_status (
      id TEXT PRIMARY KEY,
      command TEXT NOT NULL,
      available INTEGER NOT NULL,
      model TEXT,
      provider TEXT,
      provider_health_json TEXT NOT NULL DEFAULT '${DEFAULT_HERMES_PROVIDER_HEALTH_JSON}',
      enabled_toolsets_json TEXT NOT NULL DEFAULT '[]',
      missing_computer_use_toolsets_json TEXT NOT NULL DEFAULT '[]',
      computer_use_ready INTEGER NOT NULL DEFAULT 0,
      computer_use_summary TEXT,
      config_source TEXT,
      config_path TEXT,
      runtime_home TEXT,
      last_checked_at TEXT,
      last_probe_session_id TEXT,
      last_error TEXT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS capability_providers (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      label TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      required INTEGER NOT NULL,
      installed INTEGER NOT NULL,
      version TEXT,
      pinned_version TEXT,
      command_path TEXT,
      last_checked_at TEXT,
      last_error TEXT,
      last_success_at TEXT,
      detail TEXT
    ) STRICT;
  `);

  const storedSchemaVersion = Number(readMeta(db, "schema_version") ?? "0");
  if (storedSchemaVersion > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Product database schema ${String(storedSchemaVersion)} is newer than supported version ${String(CURRENT_SCHEMA_VERSION)}.`,
    );
  }

  db.exec("DROP TABLE IF EXISTS external_actions");
  ensureColumn(db, "workers", "selected_installed_workflow_id", "TEXT");
  ensureColumn(
    db,
    "accounts",
    "cloud_sync_revision",
    "INTEGER NOT NULL DEFAULT -1",
  );
  ensureColumn(db, "workflows", "source_text", "TEXT");
  ensureColumn(db, "installed_workflows", "source_skill_path", "TEXT");
  ensureColumn(
    db,
    "installed_workflows",
    "source_workflow_revision_id",
    "TEXT",
  );
  ensureColumn(db, "runs", "kind", "TEXT NOT NULL DEFAULT 'workflow'");
  ensureColumn(db, "hermes_status", "config_source", "TEXT");
  ensureColumn(db, "hermes_status", "config_path", "TEXT");
  ensureColumn(db, "hermes_status", "runtime_home", "TEXT");
  ensureColumn(
    db,
    "hermes_status",
    "provider_health_json",
    `TEXT NOT NULL DEFAULT '${DEFAULT_HERMES_PROVIDER_HEALTH_JSON}'`,
  );
  ensureColumn(
    db,
    "hermes_status",
    "enabled_toolsets_json",
    "TEXT NOT NULL DEFAULT '[]'",
  );
  ensureColumn(
    db,
    "hermes_status",
    "missing_computer_use_toolsets_json",
    "TEXT NOT NULL DEFAULT '[]'",
  );
  ensureColumn(
    db,
    "hermes_status",
    "computer_use_ready",
    "INTEGER NOT NULL DEFAULT 0",
  );
  ensureColumn(db, "hermes_status", "computer_use_summary", "TEXT");

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_runs_started_at
      ON runs(started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_run_events_run_created
      ON run_events(run_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_commands_run_created
      ON commands(run_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_capture_sessions_updated
      ON capture_sessions(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_pending_cloud_upserts_updated
      ON pending_cloud_upserts(updated_at);
    CREATE INDEX IF NOT EXISTS idx_pending_cloud_deletes_deleted
      ON pending_cloud_deletes(deleted_at);
  `);

  const migratedAt = new Date().toISOString();
  const insertMigration = db.prepare(
    "INSERT INTO product_migrations (id, applied_at) VALUES (?, ?) ON CONFLICT(id) DO NOTHING",
  );
  for (let version = 1; version <= CURRENT_SCHEMA_VERSION; version += 1) {
    insertMigration.run(version, migratedAt);
  }
  db.exec(`PRAGMA user_version = ${String(CURRENT_SCHEMA_VERSION)}`);
  upsertMeta(db, "schema_version", String(CURRENT_SCHEMA_VERSION));
  if (!readMeta(db, "schema_migrated_at")) {
    upsertMeta(db, "schema_migrated_at", migratedAt);
  }
}

function ensureColumn(
  db: DatabaseSync,
  tableName: string,
  columnName: string,
  definition: string,
): void {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
    name: string;
  }>;
  if (columns.some((column) => column.name === columnName)) {
    return;
  }
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
}

function readState(db: DatabaseSync): ProductState | null {
  const account = db
    .prepare("SELECT * FROM accounts ORDER BY updated_at DESC LIMIT 1")
    .get() as SqlRow | undefined;
  const workspace = db.prepare("SELECT * FROM workspaces LIMIT 1").get() as
    SqlRow | undefined;
  const hermes = db
    .prepare("SELECT * FROM hermes_status WHERE id = 'default'")
    .get() as SqlRow | undefined;
  const permissionSnapshot = db
    .prepare("SELECT * FROM permission_snapshots WHERE id = 'recorder'")
    .get() as SqlRow | undefined;

  if (!account || !workspace || !hermes) {
    return null;
  }

  return {
    schemaVersion: 1,
    account: accountFromRow(account),
    workspace: workspaceFromRow(workspace),
    devices: (
      db.prepare("SELECT * FROM devices ORDER BY rowid").all() as SqlRow[]
    ).map(deviceFromRow),
    permissionSnapshot: permissionSnapshot
      ? permissionSnapshotFromRow(permissionSnapshot)
      : null,
    workers: (
      db.prepare("SELECT * FROM workers ORDER BY rowid").all() as SqlRow[]
    ).map(workerFromRow),
    channelConnections: (
      db
        .prepare("SELECT * FROM channel_connections ORDER BY created_at")
        .all() as SqlRow[]
    ).map(channelConnectionFromRow),
    channelSetups: (
      db
        .prepare("SELECT * FROM channel_setups ORDER BY created_at DESC")
        .all() as SqlRow[]
    ).map(channelSetupFromRow),
    channelBindings: (
      db
        .prepare("SELECT * FROM channel_bindings ORDER BY created_at")
        .all() as SqlRow[]
    ).map(channelBindingFromRow),
    workflows: (
      db
        .prepare("SELECT * FROM workflows ORDER BY created_at DESC")
        .all() as SqlRow[]
    ).map(workflowFromRow),
    captureSessions: (
      db
        .prepare("SELECT * FROM capture_sessions ORDER BY updated_at DESC")
        .all() as SqlRow[]
    ).map(captureSessionFromRow),
    artifacts: (
      db
        .prepare("SELECT * FROM product_artifacts ORDER BY updated_at DESC")
        .all() as SqlRow[]
    ).map(artifactFromRow),
    installedWorkflows: (
      db
        .prepare("SELECT * FROM installed_workflows ORDER BY installed_at DESC")
        .all() as SqlRow[]
    ).map(installedWorkflowFromRow),
    runs: (
      db
        .prepare("SELECT * FROM runs ORDER BY started_at DESC")
        .all() as SqlRow[]
    ).map(runFromRow),
    runEvents: (
      db
        .prepare("SELECT * FROM run_events ORDER BY created_at DESC")
        .all() as SqlRow[]
    ).map(runEventFromRow),
    commands: (
      db
        .prepare("SELECT * FROM commands ORDER BY created_at DESC")
        .all() as SqlRow[]
    ).map(commandFromRow),
    approvalPolicies: (
      db
        .prepare("SELECT * FROM approval_policies ORDER BY updated_at DESC")
        .all() as SqlRow[]
    ).map(approvalPolicyFromRow),
    workflowTombstones: (
      db
        .prepare("SELECT * FROM workflow_tombstones ORDER BY deleted_at DESC")
        .all() as SqlRow[]
    ).map(workflowTombstoneFromRow),
    pendingCloudUpserts: (
      db
        .prepare("SELECT * FROM pending_cloud_upserts ORDER BY updated_at")
        .all() as SqlRow[]
    ).map(cloudUpsertFromRow),
    pendingCloudDeletes: (
      db
        .prepare("SELECT * FROM pending_cloud_deletes ORDER BY deleted_at")
        .all() as SqlRow[]
    ).map(cloudDeleteFromRow),
    hermes: hermesFromRow(hermes),
    capabilityProviders: (
      db
        .prepare("SELECT * FROM capability_providers ORDER BY rowid")
        .all() as SqlRow[]
    ).map(capabilityProviderFromRow),
    updatedAt: String(
      (
        db
          .prepare("SELECT value FROM product_meta WHERE key = 'updated_at'")
          .get() as SqlRow | undefined
      )?.value ?? new Date().toISOString(),
    ),
  };
}

function writeState(
  db: DatabaseSync,
  previous: ProductState | null,
  state: ProductState,
): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    writeMeta(db, state);
    syncRows(previous ? [previous.account] : [], [state.account], {
      key: (account) => account.id,
      remove: (account) =>
        db.prepare("DELETE FROM accounts WHERE id = ?").run(account.id),
      write: (account) => writeAccount(db, account),
    });
    syncRows(previous ? [previous.workspace] : [], [state.workspace], {
      key: (workspace) => workspace.id,
      remove: (workspace) =>
        db.prepare("DELETE FROM workspaces WHERE id = ?").run(workspace.id),
      write: (workspace) => writeWorkspace(db, workspace),
    });
    syncRows(
      previous?.devices ?? [],
      state.devices,
      entitySync(db, "devices", writeDevice),
    );
    syncRows(
      previous?.permissionSnapshot ? [previous.permissionSnapshot] : [],
      state.permissionSnapshot ? [state.permissionSnapshot] : [],
      {
        key: () => "recorder",
        remove: () =>
          db
            .prepare("DELETE FROM permission_snapshots WHERE id = 'recorder'")
            .run(),
        write: (snapshot) => writePermissionSnapshot(db, snapshot),
      },
    );
    syncRows(
      previous?.workers ?? [],
      state.workers,
      entitySync(db, "workers", writeWorker),
    );
    syncRows(
      previous?.channelConnections ?? [],
      state.channelConnections,
      entitySync(db, "channel_connections", writeChannelConnection),
    );
    syncRows(
      previous?.channelSetups ?? [],
      state.channelSetups,
      entitySync(db, "channel_setups", writeChannelSetup),
    );
    syncRows(
      previous?.channelBindings ?? [],
      state.channelBindings,
      entitySync(db, "channel_bindings", writeChannelBinding),
    );
    syncRows(
      previous?.workflows ?? [],
      state.workflows,
      entitySync(db, "workflows", writeWorkflow),
    );
    syncRows(
      previous?.captureSessions ?? [],
      state.captureSessions,
      entitySync(db, "capture_sessions", writeCaptureSession),
    );
    syncRows(
      previous?.artifacts ?? [],
      state.artifacts,
      entitySync(db, "product_artifacts", writeArtifact),
    );
    syncRows(
      previous?.installedWorkflows ?? [],
      state.installedWorkflows,
      entitySync(db, "installed_workflows", writeInstalledWorkflow),
    );
    syncRows(
      previous?.runs ?? [],
      state.runs,
      entitySync(db, "runs", writeRun),
    );
    syncRows(
      previous?.runEvents ?? [],
      state.runEvents,
      entitySync(db, "run_events", writeRunEvent),
    );
    syncRows(
      previous?.commands ?? [],
      state.commands,
      entitySync(db, "commands", writeCommand),
    );
    syncRows(
      previous?.approvalPolicies ?? [],
      state.approvalPolicies,
      entitySync(db, "approval_policies", writeApprovalPolicy),
    );
    syncRows(previous?.workflowTombstones ?? [], state.workflowTombstones, {
      key: (tombstone) => tombstone.workflowId,
      remove: (tombstone) =>
        db
          .prepare("DELETE FROM workflow_tombstones WHERE workflow_id = ?")
          .run(tombstone.workflowId),
      write: (tombstone) => writeWorkflowTombstone(db, tombstone),
    });
    syncRows(
      previous?.pendingCloudUpserts ?? [],
      state.pendingCloudUpserts,
      cloudMutationSync(db, "pending_cloud_upserts", writeCloudUpsert),
    );
    syncRows(
      previous?.pendingCloudDeletes ?? [],
      state.pendingCloudDeletes,
      cloudMutationSync(db, "pending_cloud_deletes", writeCloudDelete),
    );
    syncRows(previous ? [previous.hermes] : [], [state.hermes], {
      key: () => "default",
      remove: () =>
        db.prepare("DELETE FROM hermes_status WHERE id = 'default'").run(),
      write: (hermes) => writeHermesStatus(db, hermes),
    });
    syncRows(
      previous?.capabilityProviders ?? [],
      state.capabilityProviders,
      entitySync(db, "capability_providers", writeCapabilityProvider),
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

interface RowSyncOptions<T> {
  key: (value: T) => string;
  remove: (value: T) => void;
  write: (value: T) => void;
}

function syncRows<T>(
  previous: readonly T[],
  next: readonly T[],
  options: RowSyncOptions<T>,
): void {
  const previousByKey = new Map(
    previous.map((value) => [options.key(value), value]),
  );
  const nextKeys = new Set(next.map(options.key));
  for (const value of previous) {
    if (!nextKeys.has(options.key(value))) {
      options.remove(value);
    }
  }
  for (const value of next) {
    const previousValue = previousByKey.get(options.key(value));
    if (!previousValue || !samePersistedValue(previousValue, value)) {
      options.write(value);
    }
  }
}

function entitySync<T extends { id: string }>(
  db: DatabaseSync,
  tableName: string,
  writer: (db: DatabaseSync, value: T) => void,
): RowSyncOptions<T> {
  const removeStatement = db.prepare(`DELETE FROM ${tableName} WHERE id = ?`);
  return {
    key: (value) => value.id,
    remove: (value) => removeStatement.run(value.id),
    write: (value) => writer(db, value),
  };
}

function cloudMutationSync<T extends { entityType: string; entityId: string }>(
  db: DatabaseSync,
  tableName: "pending_cloud_upserts" | "pending_cloud_deletes",
  writer: (db: DatabaseSync, value: T) => void,
): RowSyncOptions<T> {
  const removeStatement = db.prepare(
    `DELETE FROM ${tableName} WHERE entity_type = ? AND entity_id = ?`,
  );
  return {
    key: (value) => `${value.entityType}\u0000${value.entityId}`,
    remove: (value) => removeStatement.run(value.entityType, value.entityId),
    write: (value) => writer(db, value),
  };
}

function samePersistedValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function writeMeta(db: DatabaseSync, state: ProductState): void {
  upsertMeta(db, "updated_at", state.updatedAt);
  upsertMeta(db, "schema_version", String(CURRENT_SCHEMA_VERSION));
}

function readMeta(db: DatabaseSync, key: string): string | null {
  const row = db
    .prepare("SELECT value FROM product_meta WHERE key = ?")
    .get(key) as SqlRow | undefined;
  return typeof row?.value === "string" ? row.value : null;
}

function upsertMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    `INSERT INTO product_meta (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

function ensureInstallationId(db: DatabaseSync): string {
  const existing = readMeta(db, "installation_id")?.trim();
  if (existing) {
    return existing;
  }
  const candidate = createInstallationId();
  db.prepare(
    "INSERT INTO product_meta (key, value) VALUES ('installation_id', ?) ON CONFLICT(key) DO NOTHING",
  ).run(candidate);
  return readMeta(db, "installation_id") ?? candidate;
}

function dataMigrationMetaKey(migrationId: string): string {
  return `data_migration.${migrationId}`;
}

function writeAccount(db: DatabaseSync, account: ProductAccount): void {
  db.prepare(
    `INSERT OR REPLACE INTO accounts
      (id, name, email, workspace_id, signed_in_label, cloud_provider, cloud_user_id, cloud_sync_revision, setup_completed, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    account.id,
    account.name,
    account.email,
    account.workspaceId,
    account.signedInLabel,
    account.cloudProvider,
    account.cloudUserId,
    account.cloudSyncRevision,
    account.setupCompleted ? 1 : 0,
    account.updatedAt,
  );
}

function writeWorkspace(db: DatabaseSync, workspace: ProductWorkspace): void {
  db.prepare(
    "INSERT OR REPLACE INTO workspaces (id, name, mode) VALUES (?, ?, ?)",
  ).run(workspace.id, workspace.name, workspace.mode);
}

function writeDevice(db: DatabaseSync, device: ProductDevice): void {
  db.prepare(
    `INSERT OR REPLACE INTO devices
      (id, name, status, owner, assigned_worker_id, heartbeat, location, runtime_version, queue_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    device.id,
    device.name,
    device.status,
    device.owner,
    device.assignedWorkerId,
    device.heartbeat,
    device.location,
    device.runtimeVersion,
    JSON.stringify(device.queue),
  );
}

function writePermissionSnapshot(
  db: DatabaseSync,
  snapshot: ProductPermissionSnapshot,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO permission_snapshots
      (id, checked_at, all_granted, can_start_recording, source, summary, items_json)
      VALUES ('recorder', ?, ?, ?, ?, ?, ?)`,
  ).run(
    snapshot.checkedAt,
    snapshot.allGranted ? 1 : 0,
    snapshot.canStartRecording ? 1 : 0,
    snapshot.source,
    snapshot.summary,
    JSON.stringify(snapshot.items),
  );
}

function writeWorker(db: DatabaseSync, worker: ProductWorker): void {
  db.prepare(
    `INSERT OR REPLACE INTO workers
      (id, name, initials, description, status, tone, avatar_key, device_id, selected_installed_workflow_id, heartbeat, activities_json, config_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    worker.id,
    worker.name,
    worker.initials,
    worker.description,
    worker.status,
    worker.tone,
    worker.avatarKey,
    worker.deviceId,
    worker.selectedInstalledWorkflowId,
    worker.heartbeat,
    JSON.stringify(worker.activities),
    JSON.stringify(worker.config),
  );
}

function writeChannelConnection(
  db: DatabaseSync,
  connection: ProductChannelConnection,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO channel_connections
      (id, worker_id, platform, label, setup_method, status, account_label,
       hermes_profile, configured_fields_json, missing_fields_json,
       last_checked_at, last_connected_at, last_error, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    connection.id,
    connection.workerId,
    connection.platform,
    connection.label,
    connection.setupMethod,
    connection.status,
    connection.accountLabel,
    connection.hermesProfile,
    JSON.stringify(connection.configuredFields),
    JSON.stringify(connection.missingFields),
    connection.lastCheckedAt,
    connection.lastConnectedAt,
    connection.lastError,
    connection.createdAt,
    connection.updatedAt,
  );
}

function writeChannelSetup(db: DatabaseSync, setup: ProductChannelSetup): void {
  db.prepare(
    `INSERT OR REPLACE INTO channel_setups
      (id, connection_id, worker_id, platform, status, qr_payload,
       qr_expires_at, account_label, process_id, last_error, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    setup.id,
    setup.connectionId,
    setup.workerId,
    setup.platform,
    setup.status,
    // QR payloads are short-lived bearer material. They stay in the in-memory
    // ProductState response and Hermes' 0600 setup file, never this database.
    null,
    setup.qrExpiresAt,
    setup.accountLabel,
    setup.processId,
    setup.lastError,
    setup.createdAt,
    setup.updatedAt,
  );
}

function writeChannelBinding(
  db: DatabaseSync,
  binding: ProductChannelBinding,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO channel_bindings
      (id, connection_id, worker_id, platform, conversation_id, thread_id,
       conversation_label, hermes_profile, hermes_session_id, status,
       last_error, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    binding.id,
    binding.connectionId,
    binding.workerId,
    binding.platform,
    binding.conversationId,
    binding.threadId,
    binding.conversationLabel,
    binding.hermesProfile,
    binding.hermesSessionId,
    binding.status,
    binding.lastError,
    binding.createdAt,
    binding.updatedAt,
  );
}

function writeWorkflow(db: DatabaseSync, workflow: ProductWorkflow): void {
  db.prepare(
    `INSERT OR REPLACE INTO workflows
      (id, title, description, status, source_type, source_text, confidence, apps_json,
       stats_json, detected_at, artifact_path, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    workflow.id,
    workflow.title,
    workflow.description,
    workflow.status,
    workflow.sourceType,
    workflow.sourceText ?? null,
    workflow.confidence,
    JSON.stringify(workflow.apps),
    JSON.stringify(workflow.stats),
    workflow.detectedAt,
    workflow.artifactPath,
    workflow.createdAt,
    workflow.updatedAt,
  );
}

function writeCaptureSession(
  db: DatabaseSync,
  session: ProductCaptureSession,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO capture_sessions
      (id, lab_session_id, session_path, artifact_root, status, title, latest_run_id,
       latest_run_dir, ingest_summary_path, workflow_discovery_path, selected_workflow_id,
       skill_path, stats_json, artifact_missing, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    session.id,
    session.labSessionId,
    session.sessionPath,
    session.artifactRoot,
    session.status,
    session.title,
    session.latestRunId,
    session.latestRunDir,
    session.ingestSummaryPath,
    session.workflowDiscoveryPath,
    session.selectedWorkflowId,
    session.skillPath,
    JSON.stringify(session.stats),
    session.artifactMissing ? 1 : 0,
    session.createdAt,
    session.updatedAt,
  );
}

function writeArtifact(db: DatabaseSync, artifact: ProductArtifact): void {
  db.prepare(
    `INSERT OR REPLACE INTO product_artifacts
      (id, capture_session_id, kind, path, status, size_bytes, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    artifact.id,
    artifact.captureSessionId,
    artifact.kind,
    artifact.path,
    artifact.status,
    artifact.sizeBytes,
    artifact.updatedAt,
  );
}

function writeInstalledWorkflow(
  db: DatabaseSync,
  workflow: ProductInstalledWorkflow,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO installed_workflows
      (id, worker_id, workflow_id, workflow_title, description, status, apps_json, installed_at,
       deploy_target_device_id, approval_policy, hermes_skill_reference, hermes_install_reference,
       hermes_skill_name, hermes_skill_path, source_skill_path, source_workflow_revision_id,
       baseline_runs, baseline_successes, baseline_last_run, update_available)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    workflow.id,
    workflow.workerId,
    workflow.workflowId,
    workflow.workflowTitle,
    workflow.description,
    workflow.status,
    JSON.stringify(workflow.apps),
    workflow.installedAt,
    workflow.deployTargetDeviceId,
    workflow.approvalPolicy,
    workflow.hermesSkillReference,
    workflow.hermesInstallReference,
    workflow.hermesSkillName,
    workflow.hermesSkillPath,
    workflow.sourceSkillPath,
    workflow.sourceWorkflowRevisionId,
    workflow.baselineRuns,
    workflow.baselineSuccesses,
    workflow.baselineLastRun,
    workflow.updateAvailable ? 1 : 0,
  );
}

function writeRun(db: DatabaseSync, run: ProductRun): void {
  db.prepare(
    `INSERT OR REPLACE INTO runs
      (id, worker_id, installed_workflow_id, workflow_title, kind, status, command, started_at, ended_at, hermes_session_id, error_message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    run.id,
    run.workerId,
    run.installedWorkflowId,
    run.workflowTitle,
    run.kind ?? "workflow",
    run.status,
    run.command,
    run.startedAt,
    run.endedAt,
    run.hermesSessionId,
    run.errorMessage,
  );
}

function writeRunEvent(db: DatabaseSync, event: ProductRunEvent): void {
  db.prepare(
    `INSERT OR REPLACE INTO run_events
      (id, run_id, worker_id, source, status, body, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    event.id,
    event.runId,
    event.workerId,
    event.source,
    event.status,
    event.body,
    event.createdAt,
  );
}

function writeCommand(db: DatabaseSync, command: ProductCommand): void {
  db.prepare(
    `INSERT OR REPLACE INTO commands
      (id, run_id, worker_id, command, source, status, created_at, error_message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    command.id,
    command.runId,
    command.workerId,
    command.command,
    command.source,
    command.status,
    command.createdAt,
    command.errorMessage,
  );
}

function writeApprovalPolicy(
  db: DatabaseSync,
  policy: ProductApprovalPolicy,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO approval_policies
      (id, scope_type, scope_id, mode, description, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    policy.id,
    policy.scopeType,
    policy.scopeId,
    policy.mode,
    policy.description,
    policy.updatedAt,
  );
}

function writeWorkflowTombstone(
  db: DatabaseSync,
  tombstone: ProductWorkflowTombstone,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO workflow_tombstones
      (workflow_id, workflow_title, deleted_at, deleted_by_account_id)
      VALUES (?, ?, ?, ?)`,
  ).run(
    tombstone.workflowId,
    tombstone.workflowTitle,
    tombstone.deletedAt,
    tombstone.deletedByAccountId,
  );
}

function writeCloudDelete(
  db: DatabaseSync,
  pendingDelete: ProductCloudDelete,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO pending_cloud_deletes
      (entity_type, entity_id, deleted_at)
      VALUES (?, ?, ?)`,
  ).run(
    pendingDelete.entityType,
    pendingDelete.entityId,
    pendingDelete.deletedAt,
  );
}

function writeCloudUpsert(
  db: DatabaseSync,
  pendingUpsert: ProductCloudUpsert,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO pending_cloud_upserts
      (entity_type, entity_id, updated_at)
      VALUES (?, ?, ?)`,
  ).run(
    pendingUpsert.entityType,
    pendingUpsert.entityId,
    pendingUpsert.updatedAt,
  );
}

function writeHermesStatus(
  db: DatabaseSync,
  hermes: ProductHermesStatus,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO hermes_status
      (id, command, available, model, provider, provider_health_json, enabled_toolsets_json, missing_computer_use_toolsets_json, computer_use_ready, computer_use_summary, config_source, config_path, runtime_home, last_checked_at, last_probe_session_id, last_error)
      VALUES ('default', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    hermes.command,
    hermes.available ? 1 : 0,
    hermes.model,
    hermes.provider,
    JSON.stringify(hermes.providerHealth),
    JSON.stringify(hermes.enabledToolsets),
    JSON.stringify(hermes.missingComputerUseToolsets),
    hermes.computerUseReady ? 1 : 0,
    hermes.computerUseSummary,
    hermes.configSource,
    hermes.configPath,
    hermes.runtimeHome,
    hermes.lastCheckedAt,
    hermes.lastProbeSessionId,
    hermes.lastError,
  );
}

function writeCapabilityProvider(
  db: DatabaseSync,
  provider: ProductCapabilityProvider,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO capability_providers
      (id, kind, label, description, status, enabled, required, installed, version, pinned_version,
       command_path, last_checked_at, last_error, last_success_at, detail)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    provider.id,
    provider.kind,
    provider.label,
    provider.description,
    provider.status,
    provider.enabled ? 1 : 0,
    provider.required ? 1 : 0,
    provider.installed ? 1 : 0,
    provider.version,
    provider.pinnedVersion,
    provider.commandPath,
    provider.lastCheckedAt,
    provider.lastError,
    provider.lastSuccessAt,
    provider.detail,
  );
}

function accountFromRow(row: SqlRow): ProductAccount {
  return {
    id: text(row.id),
    name: text(row.name),
    email: text(row.email),
    workspaceId: text(row.workspace_id),
    signedInLabel: text(row.signed_in_label),
    cloudProvider: nullableText(row.cloud_provider),
    cloudUserId: nullableText(row.cloud_user_id),
    cloudSyncRevision: numeric(row.cloud_sync_revision),
    setupCompleted: Boolean(row.setup_completed),
    updatedAt: text(row.updated_at),
  };
}

function cloudDeleteFromRow(row: SqlRow): ProductCloudDelete {
  return {
    entityType: text(row.entity_type) as ProductCloudDelete["entityType"],
    entityId: text(row.entity_id),
    deletedAt: text(row.deleted_at),
  };
}

function cloudUpsertFromRow(row: SqlRow): ProductCloudUpsert {
  return {
    entityType: text(row.entity_type) as ProductCloudUpsert["entityType"],
    entityId: text(row.entity_id),
    updatedAt: text(row.updated_at),
  };
}

function workspaceFromRow(row: SqlRow): ProductWorkspace {
  return {
    id: text(row.id),
    name: text(row.name),
    mode: text(row.mode) as ProductWorkspace["mode"],
  };
}

function deviceFromRow(row: SqlRow): ProductDevice {
  return {
    id: text(row.id),
    name: text(row.name),
    status: text(row.status) as ProductDevice["status"],
    owner: text(row.owner),
    assignedWorkerId: nullableText(row.assigned_worker_id),
    heartbeat: text(row.heartbeat),
    location: text(row.location),
    runtimeVersion: text(row.runtime_version),
    queue: parseStringArray(row.queue_json),
  };
}

function permissionSnapshotFromRow(row: SqlRow): ProductPermissionSnapshot {
  return {
    checkedAt: text(row.checked_at),
    allGranted: Boolean(row.all_granted),
    canStartRecording: Boolean(row.can_start_recording),
    source: text(row.source) as ProductPermissionSnapshot["source"],
    summary: text(row.summary),
    items: parseJson(row.items_json) as ProductPermissionSnapshot["items"],
  };
}

function workerFromRow(row: SqlRow): ProductWorker {
  return {
    id: text(row.id),
    name: text(row.name),
    initials: text(row.initials),
    description: text(row.description),
    status: text(row.status) as ProductWorker["status"],
    tone: text(row.tone) as ProductWorker["tone"],
    avatarKey: text(row.avatar_key) as ProductWorker["avatarKey"],
    deviceId: nullableText(row.device_id),
    selectedInstalledWorkflowId: nullableText(
      row.selected_installed_workflow_id,
    ),
    heartbeat: text(row.heartbeat),
    activities: parseStringArray(row.activities_json),
    config: parseJson(row.config_json) as ProductWorker["config"],
  };
}

function channelConnectionFromRow(row: SqlRow): ProductChannelConnection {
  return {
    id: text(row.id),
    workerId: text(row.worker_id),
    platform: text(row.platform) as ProductChannelConnection["platform"],
    label: text(row.label),
    setupMethod: text(
      row.setup_method,
    ) as ProductChannelConnection["setupMethod"],
    status: text(row.status) as ProductChannelConnection["status"],
    accountLabel: nullableText(row.account_label),
    hermesProfile: text(row.hermes_profile),
    configuredFields: parseStringArray(row.configured_fields_json),
    missingFields: parseStringArray(row.missing_fields_json),
    lastCheckedAt: nullableText(row.last_checked_at),
    lastConnectedAt: nullableText(row.last_connected_at),
    lastError: nullableText(row.last_error),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

function channelSetupFromRow(row: SqlRow): ProductChannelSetup {
  return {
    id: text(row.id),
    connectionId: text(row.connection_id),
    workerId: text(row.worker_id),
    platform: text(row.platform) as ProductChannelSetup["platform"],
    status: text(row.status) as ProductChannelSetup["status"],
    qrPayload: nullableText(row.qr_payload),
    qrExpiresAt: nullableText(row.qr_expires_at),
    accountLabel: nullableText(row.account_label),
    processId:
      row.process_id === null || row.process_id === undefined
        ? null
        : numeric(row.process_id),
    lastError: nullableText(row.last_error),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

function channelBindingFromRow(row: SqlRow): ProductChannelBinding {
  return {
    id: text(row.id),
    connectionId: text(row.connection_id),
    workerId: text(row.worker_id),
    platform: text(row.platform) as ProductChannelBinding["platform"],
    conversationId: text(row.conversation_id),
    threadId: nullableText(row.thread_id),
    conversationLabel: nullableText(row.conversation_label),
    hermesProfile: text(row.hermes_profile),
    hermesSessionId: text(row.hermes_session_id),
    status: text(row.status) as ProductChannelBinding["status"],
    lastError: nullableText(row.last_error),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

function workflowFromRow(row: SqlRow): ProductWorkflow {
  return {
    id: text(row.id),
    title: text(row.title),
    description: text(row.description),
    status: text(row.status) as ProductWorkflow["status"],
    sourceType: text(row.source_type) as ProductWorkflow["sourceType"],
    sourceText: nullableText(row.source_text),
    confidence:
      row.confidence === null || row.confidence === undefined
        ? null
        : Number(row.confidence),
    apps: parseStringArray(row.apps_json),
    stats: parseJson(row.stats_json) as ProductWorkflow["stats"],
    detectedAt: text(row.detected_at),
    artifactPath: nullableText(row.artifact_path),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

function captureSessionFromRow(row: SqlRow): ProductCaptureSession {
  return {
    id: text(row.id),
    labSessionId: text(row.lab_session_id),
    sessionPath: text(row.session_path),
    artifactRoot: text(row.artifact_root),
    status: text(row.status) as ProductCaptureSession["status"],
    title: text(row.title),
    latestRunId: nullableText(row.latest_run_id),
    latestRunDir: nullableText(row.latest_run_dir),
    ingestSummaryPath: nullableText(row.ingest_summary_path),
    workflowDiscoveryPath: nullableText(row.workflow_discovery_path),
    selectedWorkflowId: nullableText(row.selected_workflow_id),
    skillPath: nullableText(row.skill_path),
    stats: parseJson(row.stats_json) as ProductCaptureSession["stats"],
    artifactMissing: Boolean(row.artifact_missing),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

function artifactFromRow(row: SqlRow): ProductArtifact {
  return {
    id: text(row.id),
    captureSessionId: text(row.capture_session_id),
    kind: text(row.kind) as ProductArtifact["kind"],
    path: text(row.path),
    status: text(row.status) as ProductArtifact["status"],
    sizeBytes:
      row.size_bytes === null || row.size_bytes === undefined
        ? null
        : Number(row.size_bytes),
    updatedAt: text(row.updated_at),
  };
}

function installedWorkflowFromRow(row: SqlRow): ProductInstalledWorkflow {
  return {
    id: text(row.id),
    workerId: text(row.worker_id),
    workflowId: text(row.workflow_id),
    workflowTitle: text(row.workflow_title),
    description: text(row.description),
    status: text(row.status) as ProductInstalledWorkflow["status"],
    apps: parseStringArray(row.apps_json),
    installedAt: text(row.installed_at),
    deployTargetDeviceId: nullableText(row.deploy_target_device_id),
    approvalPolicy: "allow_all",
    hermesSkillReference: text(row.hermes_skill_reference),
    hermesInstallReference: text(row.hermes_install_reference),
    hermesSkillName: text(row.hermes_skill_name),
    hermesSkillPath: text(row.hermes_skill_path),
    sourceSkillPath: nullableText(row.source_skill_path),
    sourceWorkflowRevisionId: nullableText(row.source_workflow_revision_id),
    baselineRuns: Number(row.baseline_runs),
    baselineSuccesses: Number(row.baseline_successes),
    baselineLastRun: text(row.baseline_last_run),
    updateAvailable: Boolean(row.update_available),
  };
}

function runFromRow(row: SqlRow): ProductRun {
  return {
    id: text(row.id),
    workerId: text(row.worker_id),
    installedWorkflowId: text(row.installed_workflow_id),
    workflowTitle: text(row.workflow_title),
    kind: text(row.kind ?? "workflow") as ProductRun["kind"],
    status: text(row.status) as ProductRun["status"],
    command: nullableText(row.command),
    startedAt: text(row.started_at),
    endedAt: nullableText(row.ended_at),
    hermesSessionId: nullableText(row.hermes_session_id),
    errorMessage: nullableText(row.error_message),
  };
}

function runEventFromRow(row: SqlRow): ProductRunEvent {
  return {
    id: text(row.id),
    runId: text(row.run_id),
    workerId: text(row.worker_id),
    source: text(row.source) as ProductRunEvent["source"],
    status: text(row.status),
    body: text(row.body),
    createdAt: text(row.created_at),
  };
}

function commandFromRow(row: SqlRow): ProductCommand {
  return {
    id: text(row.id),
    runId: text(row.run_id),
    workerId: text(row.worker_id),
    command: text(row.command),
    source: text(row.source) as ProductCommand["source"],
    status: text(row.status) as ProductCommand["status"],
    createdAt: text(row.created_at),
    errorMessage: nullableText(row.error_message),
  };
}

function approvalPolicyFromRow(row: SqlRow): ProductApprovalPolicy {
  return {
    id: text(row.id),
    scopeType: text(row.scope_type) as ProductApprovalPolicy["scopeType"],
    scopeId: text(row.scope_id),
    mode: "allow_all",
    description: text(row.description),
    updatedAt: text(row.updated_at),
  };
}

function workflowTombstoneFromRow(row: SqlRow): ProductWorkflowTombstone {
  return {
    workflowId: text(row.workflow_id),
    workflowTitle: text(row.workflow_title),
    deletedAt: text(row.deleted_at),
    deletedByAccountId: text(row.deleted_by_account_id),
  };
}

function hermesFromRow(row: SqlRow): ProductHermesStatus {
  return {
    command: text(row.command),
    available: Boolean(row.available),
    model: nullableText(row.model),
    provider: nullableText(row.provider),
    providerHealth: normalizeHermesProviderHealth(
      parseJson(row.provider_health_json),
    ),
    enabledToolsets: parseStringArray(row.enabled_toolsets_json),
    missingComputerUseToolsets: parseStringArray(
      row.missing_computer_use_toolsets_json,
    ),
    computerUseReady: Boolean(row.computer_use_ready),
    computerUseSummary: nullableText(row.computer_use_summary),
    configSource: nullableText(row.config_source),
    configPath: nullableText(row.config_path),
    runtimeHome: nullableText(row.runtime_home),
    lastCheckedAt: nullableText(row.last_checked_at),
    lastProbeSessionId: nullableText(row.last_probe_session_id),
    lastError: nullableText(row.last_error),
  };
}

function capabilityProviderFromRow(row: SqlRow): ProductCapabilityProvider {
  return {
    id: text(row.id) as ProductCapabilityProvider["id"],
    kind: text(row.kind) as ProductCapabilityProvider["kind"],
    label: text(row.label),
    description: text(row.description),
    status: text(row.status) as ProductCapabilityProvider["status"],
    enabled: Boolean(row.enabled),
    required: Boolean(row.required),
    installed: Boolean(row.installed),
    version: nullableText(row.version),
    pinnedVersion: nullableText(row.pinned_version),
    commandPath: nullableText(row.command_path),
    lastCheckedAt: nullableText(row.last_checked_at),
    lastError: nullableText(row.last_error),
    lastSuccessAt: nullableText(row.last_success_at),
    detail: nullableText(row.detail),
  };
}

function parseStringArray(value: unknown): string[] {
  const parsed = parseJson(value);
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === "string")
    : [];
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") {
    return null;
  }
  return JSON.parse(value) as unknown;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : text(value);
}

function numeric(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
