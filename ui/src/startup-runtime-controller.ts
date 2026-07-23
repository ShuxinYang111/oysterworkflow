import { useCallback, useRef, useState } from "react";
import type { LabScreenpipeLanguage } from "../../src/lab-api/api-contracts.js";
import {
  createPreparingStartupRuntimeStatus,
  prepareStartupRuntimeDependencies,
  type StartupDependencyStatus,
  type StartupRuntimePreparationResult,
  type StartupRuntimePreparationStatus,
} from "./startup-runtime-preparation";

interface StartupRuntimePreparationInput {
  enableAudio: boolean;
  ocrLanguagePriority: LabScreenpipeLanguage[];
}

/**
 * EN: Owns startup dependency preparation, progress, and single-flight execution.
 * 中文: 统一管理启动依赖准备、进度状态与单飞执行。
 * @returns startup status plus run and targeted dependency update operations.
 */
export function useStartupRuntimePreparationController() {
  const [status, setStatus] = useState<StartupRuntimePreparationStatus>({
    phase: "idle",
    dependencies: [],
  });
  const generationRef = useRef(0);
  const inFlightRef =
    useRef<Promise<StartupRuntimePreparationResult | null> | null>(null);

  const updateDependency = useCallback(
    (dependency: StartupDependencyStatus): void => {
      setStatus((current) => mergeDependencyStatus(current, dependency));
    },
    [],
  );

  const run = useCallback(
    (
      input: StartupRuntimePreparationInput,
    ): Promise<StartupRuntimePreparationResult | null> => {
      if (inFlightRef.current) {
        return inFlightRef.current;
      }
      generationRef.current += 1;
      const generation = generationRef.current;
      setStatus(createPreparingStartupRuntimeStatus());
      const task = prepareStartupRuntimeDependencies({
        ...input,
        onDependencyChange: (dependency) => {
          if (generationRef.current === generation) {
            updateDependency(dependency);
          }
        },
      })
        .then((result) => {
          if (generationRef.current === generation) {
            setStatus(result.status);
            return result;
          }
          return null;
        })
        .catch((error: unknown) => {
          if (generationRef.current === generation) {
            const detail =
              error instanceof Error ? error.message : String(error);
            setStatus({
              phase: "attention",
              dependencies:
                createPreparingStartupRuntimeStatus().dependencies.map(
                  (dependency) => ({
                    ...dependency,
                    phase: "attention",
                    detail,
                  }),
                ),
            });
          }
          return null;
        })
        .finally(() => {
          if (inFlightRef.current === task) {
            inFlightRef.current = null;
          }
        });
      inFlightRef.current = task;
      return task;
    },
    [updateDependency],
  );

  return { status, run, updateDependency };
}

function mergeDependencyStatus(
  current: StartupRuntimePreparationStatus,
  dependency: StartupDependencyStatus,
): StartupRuntimePreparationStatus {
  const baseline =
    current.dependencies.length > 0
      ? current.dependencies
      : createPreparingStartupRuntimeStatus().dependencies;
  const dependencies = baseline.map((item) =>
    item.id === dependency.id ? dependency : item,
  );
  return {
    phase: dependencies.every((item) => item.phase === "ready")
      ? "ready"
      : dependencies.some((item) => item.phase === "attention")
        ? "attention"
        : "preparing",
    dependencies,
  };
}
