import type { ProductRun, ProductState } from "./contracts.js";

export const PRODUCT_COMPLETED_RUN_RETENTION_LIMIT = 500;
export const PRODUCT_RUN_EVENT_RETENTION_LIMIT = 5_000;
export const PRODUCT_COMMAND_RETENTION_LIMIT = 2_000;
export const PRODUCT_WORKER_ACTIVITY_RETENTION_LIMIT = 100;

/**
 * EN: Bounds high-churn operational history while always retaining open runs and their newest evidence.
 * 中文: 限制高频运行历史，同时始终保留未结束 run 及其最新证据。
 * @param state normalized product state in newest-first history order.
 * @returns state with bounded run, event, command, and worker activity history.
 */
export function retainProductStateHistory(state: ProductState): ProductState {
  let completedRuns = 0;
  const retainedRuns = state.runs.filter((run) => {
    if (isOpenRun(run)) {
      return true;
    }
    completedRuns += 1;
    return completedRuns <= PRODUCT_COMPLETED_RUN_RETENTION_LIMIT;
  });
  const retainedRunIds = new Set(retainedRuns.map((run) => run.id));

  return {
    ...state,
    workers: state.workers.map((worker) => ({
      ...worker,
      activities: worker.activities.slice(
        0,
        PRODUCT_WORKER_ACTIVITY_RETENTION_LIMIT,
      ),
    })),
    runs: retainedRuns,
    runEvents: state.runEvents
      .filter((event) => retainedRunIds.has(event.runId))
      .slice(0, PRODUCT_RUN_EVENT_RETENTION_LIMIT),
    commands: state.commands
      .filter((command) => retainedRunIds.has(command.runId))
      .slice(0, PRODUCT_COMMAND_RETENTION_LIMIT),
  };
}

function isOpenRun(run: ProductRun): boolean {
  return (
    run.status === "queued" ||
    run.status === "running" ||
    run.status === "waiting_for_user" ||
    run.status === "blocked"
  );
}
