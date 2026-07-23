import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSession,
  deleteSessionRawCaptureArtifacts,
  ensureSessionDirectories,
  listSessions,
  readSession,
} from "../src/lab-api/session-store.js";

describe.sequential("lab session store compatibility", () => {
  const originalCwd = process.cwd();
  let tempRoot = "";

  beforeEach(async () => {
    tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-lab-session-"),
    );
    process.chdir(tempRoot);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("hydrates legacy sessions that predate generalization and planner optimization fields", async () => {
    const sessionId = "ui-recording-codex-20260401-214235-i312w3";
    const sessionDir = path.join(tempRoot, ".runs", sessionId);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      path.join(sessionDir, "session.json"),
      `${JSON.stringify(
        {
          schemaVersion: "recording-session-v1",
          sessionId,
          createdAt: "2026-04-02T04:42:35.638Z",
          updatedAt: "2026-04-02T06:21:54.077Z",
          status: "ready",
          paths: {
            sessionDir,
            dataDir: path.join(sessionDir, "screenpipe-data"),
            ingestOutDir: path.join(sessionDir, "ingest"),
            workflowDir: path.join(sessionDir, "workflow"),
            skillDir: path.join(sessionDir, "skill"),
            sessionPath: path.join(sessionDir, "session.json"),
            recordingLogPath: path.join(sessionDir, "recording.log"),
            queryLogPath: path.join(sessionDir, "query-mode.log"),
          },
          screenpipe: {
            recording: {
              state: "stopped",
              pid: 123,
              port: 3030,
              workdir: "/Users/tester/Documents/screenpipe_chinese_first",
              command: ["./target/debug/screenpipe"],
              logPath: path.join(sessionDir, "recording.log"),
              startedAt: "2026-04-02T04:42:35.641Z",
              stoppedAt: "2026-04-02T04:44:50.223Z",
              exitCode: 0,
            },
          },
          recordingWindow: {
            startedAt: "2026-04-02T04:42:35.638Z",
            requestedStopAt: "2026-04-02T04:44:49.996Z",
            scheduledStopAt: null,
            autoStopMinutes: null,
          },
          ingest: {
            latestRunId: "run-001",
            latestRunDir: path.join(sessionDir, "ingest", "runs", "run-001"),
            summaryPath: path.join(
              sessionDir,
              "ingest",
              "runs",
              "run-001",
              "summary.json",
            ),
            summary: null,
          },
          selection: {
            workflowId: "workflow-1",
            workflowPath: path.join(sessionDir, "workflow", "latest.json"),
          },
          workflowDiscovery: {
            latestPath: path.join(sessionDir, "workflow", "latest.json"),
            workflowCandidates: [],
          },
          skillExtraction: {
            latestOutDir: path.join(sessionDir, "skill", "latest"),
            skillPath: path.join(sessionDir, "skill", "latest", "skill.json"),
            summaryPath: path.join(
              sessionDir,
              "skill",
              "latest",
              "summary.json",
            ),
            skill: null,
            summary: null,
          },
          warnings: [],
          error: null,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const session = await readSession(sessionId);
    const listed = await listSessions();

    expect(
      toPortablePath(session.paths.generalizationDir).endsWith(
        `/${sessionId}/generalization`,
      ),
    ).toBe(true);
    expect(
      toPortablePath(session.paths.plannerOptimizationDir).endsWith(
        `/${sessionId}/planner-optimization`,
      ),
    ).toBe(true);
    expect(session.recordingConfig.ocrLanguagePriority).toEqual([
      "chinese",
      "english",
    ]);
    expect(session.recordingConfig.enableAudio).toBe(false);
    expect(session.screenpipe.recordingDataBaseUrl).toBeNull();
    expect(session.screenpipe.queryMode.state).toBe("idle");
    expect(session.sessionName).toBeNull();
    expect(session.generalization.summaryPath).toBeNull();
    expect(session.plannerOptimization.skillPath).toBeNull();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.generalization.latestOutDir).toBeNull();
  });

  it("deletes Screenpipe and ingest raw data while preserving derived artifacts", async () => {
    const options = {
      runsRoot: path.join(tempRoot, "runs"),
      screenpipeWorkDir: tempRoot,
    };
    const session = createSession(
      new Date("2026-07-20T10:00:00.000Z"),
      options,
    );
    await ensureSessionDirectories(session);
    const firstRunDir = path.join(
      session.paths.ingestOutDir,
      "runs",
      "run-001",
    );
    const secondRunDir = path.join(
      session.paths.ingestOutDir,
      "runs",
      "run-002",
    );
    const normalizedPath = path.join(
      firstRunDir,
      "normalized",
      "events.ndjson",
    );
    const summaryPath = path.join(secondRunDir, "summary.json");
    await mkdir(path.join(firstRunDir, "raw"), { recursive: true });
    await mkdir(path.join(secondRunDir, "raw"), { recursive: true });
    await mkdir(path.dirname(normalizedPath), { recursive: true });
    await writeFile(path.join(session.paths.dataDir, "db.sqlite"), "private");
    await writeFile(path.join(firstRunDir, "raw", "ui_events.ndjson"), "{}");
    await writeFile(path.join(secondRunDir, "raw", "ocr.ndjson"), "{}");
    await writeFile(normalizedPath, "{}\n");
    await writeFile(summaryPath, "{}\n");

    await deleteSessionRawCaptureArtifacts(session.sessionId, options);
    await deleteSessionRawCaptureArtifacts(session.sessionId, options);

    await expect(access(session.paths.dataDir)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(access(path.join(firstRunDir, "raw"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(access(path.join(secondRunDir, "raw"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(access(normalizedPath)).resolves.toBeUndefined();
    await expect(access(summaryPath)).resolves.toBeUndefined();
  });

  it("rejects cleanup outside the canonical session root", async () => {
    const options = {
      runsRoot: path.join(tempRoot, "runs"),
      screenpipeWorkDir: tempRoot,
    };
    const outsidePath = path.join(tempRoot, "outside", "sentinel.txt");
    await mkdir(path.dirname(outsidePath), { recursive: true });
    await writeFile(outsidePath, "keep");

    await expect(
      deleteSessionRawCaptureArtifacts("../outside", options),
    ).rejects.toThrow("Refusing to clean an invalid lab session id");
    await expect(access(outsidePath)).resolves.toBeUndefined();
  });
});

function toPortablePath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}
