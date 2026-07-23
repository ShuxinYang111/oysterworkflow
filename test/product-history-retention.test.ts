import { describe, expect, it } from "vitest";
import {
  PRODUCT_COMMAND_RETENTION_LIMIT,
  PRODUCT_COMPLETED_RUN_RETENTION_LIMIT,
  PRODUCT_RUN_EVENT_RETENTION_LIMIT,
  retainProductStateHistory,
} from "../src/product/history-retention.js";
import { seedProductState } from "../src/product/seed-state.js";
import type {
  ProductCommand,
  ProductRun,
  ProductRunEvent,
} from "../src/product/contracts.js";

describe("product operational history retention", () => {
  it("bounds completed history while preserving open runs", () => {
    const state = seedProductState("empty");
    const completedRuns = Array.from(
      { length: PRODUCT_COMPLETED_RUN_RETENTION_LIMIT + 25 },
      (_, index) => buildRun(`completed-${String(index)}`, "succeeded"),
    );
    const openRun = buildRun("open-run", "waiting_for_user");
    const runEvents = Array.from(
      { length: PRODUCT_RUN_EVENT_RETENTION_LIMIT + 25 },
      (_, index) => buildEvent(`event-${String(index)}`, "completed-0"),
    );
    const commands = Array.from(
      { length: PRODUCT_COMMAND_RETENTION_LIMIT + 25 },
      (_, index) => buildCommand(`command-${String(index)}`, "completed-0"),
    );

    const retained = retainProductStateHistory({
      ...state,
      runs: [...completedRuns, openRun],
      runEvents,
      commands,
    });

    expect(retained.runs).toHaveLength(
      PRODUCT_COMPLETED_RUN_RETENTION_LIMIT + 1,
    );
    expect(retained.runs.at(-1)).toEqual(openRun);
    expect(retained.runEvents).toHaveLength(PRODUCT_RUN_EVENT_RETENTION_LIMIT);
    expect(retained.commands).toHaveLength(PRODUCT_COMMAND_RETENTION_LIMIT);
    expect(retained.runs.some((run) => run.id === "completed-524")).toBe(false);
  });
});

function buildRun(id: string, status: ProductRun["status"]): ProductRun {
  return {
    id,
    workerId: "worker",
    installedWorkflowId: "workflow",
    workflowTitle: "Workflow",
    status,
    command: null,
    startedAt: "2026-07-17T00:00:00.000Z",
    endedAt: status === "succeeded" ? "2026-07-17T00:01:00.000Z" : null,
    hermesSessionId: null,
    errorMessage: null,
  };
}

function buildEvent(id: string, runId: string): ProductRunEvent {
  return {
    id,
    runId,
    workerId: "worker",
    source: "system",
    status: "complete",
    body: "complete",
    createdAt: "2026-07-17T00:01:00.000Z",
  };
}

function buildCommand(id: string, runId: string): ProductCommand {
  return {
    id,
    runId,
    workerId: "worker",
    command: "continue",
    source: "api",
    status: "accepted",
    createdAt: "2026-07-17T00:01:00.000Z",
    errorMessage: null,
  };
}
