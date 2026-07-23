import { useCallback, useEffect, useState } from "react";
import type { DesktopUpdateSnapshot } from "../../src/desktop-update/contracts.js";
import {
  checkForDesktopUpdates,
  downloadDesktopUpdate,
  getDesktopUpdateState,
  installDesktopUpdate,
  subscribeDesktopUpdateState,
  unsupportedDesktopUpdateState,
} from "./desktop-update-client";

export interface DesktopUpdateController {
  snapshot: DesktopUpdateSnapshot;
  check: () => Promise<void>;
  download: () => Promise<void>;
  install: () => Promise<void>;
}

/**
 * EN: Keeps the settings UI synchronized with the main-process updater state.
 * 中文: 让设置界面与主进程更新状态保持同步。
 * @param enabled whether the current renderer is hosted by Electron desktop.
 * @returns current snapshot plus user-triggered update actions.
 */
export function useDesktopUpdateController(
  enabled: boolean,
): DesktopUpdateController {
  const [snapshot, setSnapshot] = useState<DesktopUpdateSnapshot>(
    unsupportedDesktopUpdateState,
  );

  useEffect(() => {
    if (!enabled) {
      setSnapshot(unsupportedDesktopUpdateState());
      return;
    }
    let active = true;
    const unsubscribe = subscribeDesktopUpdateState((next) => {
      if (active) {
        setSnapshot(next);
      }
    });
    void getDesktopUpdateState()
      .then((next) => {
        if (active) {
          setSnapshot(next);
        }
      })
      .catch(() => {
        if (active) {
          setSnapshot((current) => toLocalErrorSnapshot(current));
        }
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [enabled]);

  const run = useCallback(
    async (operation: () => Promise<DesktopUpdateSnapshot>): Promise<void> => {
      try {
        setSnapshot(await operation());
      } catch {
        try {
          setSnapshot(await getDesktopUpdateState());
        } catch {
          setSnapshot((current) => toLocalErrorSnapshot(current));
        }
      }
    },
    [],
  );

  return {
    snapshot,
    check: () => run(checkForDesktopUpdates),
    download: () => run(downloadDesktopUpdate),
    install: () => run(installDesktopUpdate),
  };
}

function toLocalErrorSnapshot(
  current: DesktopUpdateSnapshot,
): DesktopUpdateSnapshot {
  return {
    ...current,
    phase: "error",
    progress: null,
    errorMessage: "OysterWorkflow could not complete the update operation.",
    errorCode: "operation_failed",
  };
}
