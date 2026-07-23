import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildWatchdogFallbackScan } from "../scripts/lib/codex-watchdog-fallback.mjs";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-06-11T05:03:00.000Z");

let tempRoot = "";

afterEach(async () => {
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true });
    tempRoot = "";
  }
});

async function createErrorCodexHome() {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "oyster-watchdog-"));
  const codexHome = path.join(tempRoot, "codex-home");
  const sessionDir = path.join(codexHome, "sessions", "2026", "06", "11");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    path.join(codexHome, "session_index.jsonl"),
    `${JSON.stringify({
      id: SESSION_ID,
      thread_name: "watchdog fixture error session",
      updated_at: "2026-06-11T05:00:00.000Z",
    })}\n`,
    "utf8",
  );
  await writeFile(
    path.join(sessionDir, `rollout-2026-06-11T05-00-00-${SESSION_ID}.jsonl`),
    [
      {
        timestamp: "2026-06-11T05:00:00.000Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "fixture-turn" },
      },
      {
        timestamp: "2026-06-11T05:00:10.000Z",
        type: "event_msg",
        payload: {
          type: "error",
          message:
            "unexpected status 503 Service Unavailable: fixture transient error",
          codex_error_info: "other",
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
    "utf8",
  );
  return codexHome;
}

describe("codex watchdog fallback", () => {
  it("finds an error session in dry-run mode without writing retry state", async () => {
    const codexHome = await createErrorCodexHome();
    const scan = await buildWatchdogFallbackScan({
      codexHome,
      delayMs: 1_000,
      liveWindowMs: 10 * 60_000,
      maxSessions: 5,
      now: NOW,
      protectedCodexHome: path.join(tempRoot, "real-codex-home"),
    });

    expect(scan.dryRun).toBe(true);
    expect(scan.resumeCandidateCount).toBe(1);
    expect(scan.executedResumeCount).toBe(0);
    expect(scan.decisions[0].action).toBe("resume");
    expect(scan.decisions[0].fingerprint).toBe("http_503");
    await expect(
      readFile(
        path.join(codexHome, "auto-continue-watchdog-state.json"),
        "utf8",
      ),
    ).rejects.toThrow();
  });

  it("executes an explicitly requested fixture resume once and then skips the same error", async () => {
    const codexHome = await createErrorCodexHome();
    const baseOptions = {
      codexHome,
      delayMs: 1_000,
      liveWindowMs: 10 * 60_000,
      maxSessions: 5,
      now: NOW,
      protectedCodexHome: path.join(tempRoot, "real-codex-home"),
      resumeBin: "/bin/echo",
      resumeMode: "execute",
      resumeTimeoutMs: 10_000,
      useTtyWrapper: false,
    };

    const firstScan = await buildWatchdogFallbackScan(baseOptions);
    expect(firstScan.dryRun).toBe(false);
    expect(firstScan.resumeCandidateCount).toBe(1);
    expect(firstScan.executedResumeCount).toBe(1);
    expect(firstScan.decisions[0].result.ok).toBe(true);
    expect(firstScan.decisions[0].result.stdoutSnippet).toContain(
      `resume ${SESSION_ID}`,
    );

    const state = JSON.parse(
      await readFile(
        path.join(codexHome, "auto-continue-watchdog-state.json"),
        "utf8",
      ),
    );
    expect(state.attempts[`${SESSION_ID}:http_503`].count).toBe(1);

    const secondScan = await buildWatchdogFallbackScan(baseOptions);
    expect(secondScan.resumeCandidateCount).toBe(0);
    expect(secondScan.executedResumeCount).toBe(0);
    expect(secondScan.decisions[0].action).toBe("skip");
    expect(secondScan.decisions[0].reason).toBe("already_attempted");
  });

  it("requires an explicit allow flag before executing against the protected real codex home", async () => {
    const codexHome = await createErrorCodexHome();
    await expect(
      buildWatchdogFallbackScan({
        codexHome,
        now: NOW,
        protectedCodexHome: codexHome,
        resumeMode: "execute",
      }),
    ).rejects.toThrow("--watchdog-allow-real-resume");
  });
});
