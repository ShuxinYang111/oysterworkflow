import type {
  LabScreenpipeLanguage,
  RecorderBootstrapResponse,
} from "../../src/lab-api/api-contracts.js";
import type { ProductState } from "../../src/product/contracts.js";
import {
  fetchProductState,
  prepareProductCapabilityProvider,
  refreshProductHermes,
} from "./product-runtime";
import { bootstrapRuntimeRecorder } from "./settings-runtime";

export type StartupDependencyId = "screenpipe" | "hermes" | "browser";
export type StartupDependencyPhase = "preparing" | "ready" | "attention";

export interface StartupDependencyStatus {
  id: StartupDependencyId;
  phase: StartupDependencyPhase;
  detail: string | null;
}

export interface StartupRuntimePreparationStatus {
  phase: "idle" | "preparing" | "ready" | "attention";
  dependencies: StartupDependencyStatus[];
}

export interface StartupRuntimePreparationResult {
  status: StartupRuntimePreparationStatus;
  recorder: RecorderBootstrapResponse | null;
  productState: ProductState | null;
}

/**
 * EN: Builds the initial status shown while managed runtime dependencies prepare.
 * 中文: 构建托管运行时依赖准备期间显示的初始状态。
 * @returns preparing status for each managed dependency.
 */
export function createPreparingStartupRuntimeStatus(): StartupRuntimePreparationStatus {
  return {
    phase: "preparing",
    dependencies: [
      { id: "hermes", phase: "preparing", detail: null },
      { id: "screenpipe", phase: "preparing", detail: null },
      { id: "browser", phase: "preparing", detail: null },
    ],
  };
}

/**
 * EN: Prepares Hermes, Screenpipe, and the browser sidecar concurrently after permissions are ready.
 * 中文: 权限就绪后并行准备 Hermes、Screenpipe 与浏览器 sidecar。
 * @param input current recording preferences.
 * @returns aggregate status plus the latest recorder and product snapshots.
 */
export async function prepareStartupRuntimeDependencies(input: {
  enableAudio: boolean;
  ocrLanguagePriority: LabScreenpipeLanguage[];
  onDependencyChange?: (dependency: StartupDependencyStatus) => void;
}): Promise<StartupRuntimePreparationResult> {
  const hermesTask = refreshProductHermes();
  const recorderTask = bootstrapRuntimeRecorder({
    enableAudio: input.enableAudio,
    ocrLanguagePriority: input.ocrLanguagePriority,
  });
  const browserTask = prepareProductCapabilityProvider("chrome");
  observeDependency(
    "hermes",
    hermesTask,
    (state) =>
      state.hermes.available
        ? { id: "hermes", phase: "ready", detail: null }
        : {
            id: "hermes",
            phase: "attention",
            detail: state.hermes.lastError,
          },
    input.onDependencyChange,
  );
  observeDependency(
    "screenpipe",
    recorderTask,
    (recorder) => ({
      id: "screenpipe",
      phase: recorder.ready ? "ready" : "attention",
      detail: recorder.ready ? null : recorder.summary,
    }),
    input.onDependencyChange,
  );
  observeDependency(
    "browser",
    browserTask,
    (result) => ({
      id: "browser",
      phase: result.provider.installed ? "ready" : "attention",
      detail: result.provider.installed ? null : result.provider.detail,
    }),
    input.onDependencyChange,
  );

  const [hermesResult, recorderResult, browserResult] =
    await Promise.allSettled([hermesTask, recorderTask, browserTask]);

  const dependencies: StartupDependencyStatus[] = [
    {
      id: "hermes",
      phase:
        hermesResult.status === "fulfilled" &&
        hermesResult.value.hermes.available
          ? "ready"
          : "attention",
      detail:
        hermesResult.status === "rejected"
          ? errorMessage(hermesResult.reason)
          : hermesResult.value.hermes.available
            ? null
            : hermesResult.value.hermes.lastError,
    },
    {
      id: "screenpipe",
      phase:
        recorderResult.status === "fulfilled" && recorderResult.value.ready
          ? "ready"
          : "attention",
      detail:
        recorderResult.status === "rejected"
          ? errorMessage(recorderResult.reason)
          : recorderResult.value.summary,
    },
    {
      id: "browser",
      phase:
        browserResult.status === "fulfilled" &&
        browserResult.value.provider.installed
          ? "ready"
          : "attention",
      detail:
        browserResult.status === "rejected"
          ? errorMessage(browserResult.reason)
          : browserResult.value.provider.installed
            ? null
            : browserResult.value.provider.detail,
    },
  ];
  const productState = await fetchProductState().catch(() => null);
  return {
    status: {
      phase: dependencies.every((item) => item.phase === "ready")
        ? "ready"
        : "attention",
      dependencies,
    },
    recorder:
      recorderResult.status === "fulfilled" ? recorderResult.value : null,
    productState,
  };
}

/**
 * EN: Reports one dependency as soon as its parallel preparation settles.
 * 中文: 单个并行依赖一完成就立即上报状态，避免等待最慢任务。
 * @param id dependency identifier used for failures.
 * @param task dependency preparation promise.
 * @param mapSuccess maps a fulfilled result to display state.
 * @param listener optional status listener owned by the UI state orchestrator.
 */
function observeDependency<T>(
  id: StartupDependencyId,
  task: Promise<T>,
  mapSuccess: (value: T) => StartupDependencyStatus,
  listener?: (dependency: StartupDependencyStatus) => void,
): void {
  if (!listener) {
    return;
  }
  void task.then(
    (value) => listener(mapSuccess(value)),
    (error) =>
      listener({
        id,
        phase: "attention",
        detail: errorMessage(error),
      }),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
