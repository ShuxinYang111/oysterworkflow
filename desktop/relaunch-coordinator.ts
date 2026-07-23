export interface DesktopRelaunchCoordinator {
  requestRelaunch: () => void;
  recoverSecondInstanceDuringQuit: () => boolean;
  relaunchBeforeExit: () => boolean;
}

interface DesktopRelaunchCoordinatorInput {
  isQuitting: () => boolean;
  requestQuit: () => void;
  relaunch: () => void;
  scheduleQuit?: (callback: () => void) => void;
}

/**
 * EN: Coordinates relaunch with graceful Runtime shutdown and macOS single-instance handoff.
 * 中文: 协调重启、Runtime 优雅退出与 macOS 单实例交接，避免新实例在旧实例退出期间丢失。
 * @param input host lifecycle operations supplied by Electron main.
 * @returns idempotent relaunch lifecycle operations.
 */
export function createDesktopRelaunchCoordinator(
  input: DesktopRelaunchCoordinatorInput,
): DesktopRelaunchCoordinator {
  let relaunchRequested = false;
  let quitScheduled = false;
  let relaunchScheduled = false;
  const scheduleQuit =
    input.scheduleQuit ??
    ((callback: () => void) => {
      setTimeout(callback, 50);
    });

  return {
    requestRelaunch() {
      relaunchRequested = true;
      if (quitScheduled || input.isQuitting()) {
        return;
      }
      quitScheduled = true;
      scheduleQuit(() => {
        quitScheduled = false;
        if (!input.isQuitting()) {
          input.requestQuit();
        }
      });
    },
    recoverSecondInstanceDuringQuit() {
      if (!input.isQuitting()) {
        return false;
      }
      relaunchRequested = true;
      return true;
    },
    relaunchBeforeExit() {
      if (!relaunchRequested || relaunchScheduled) {
        return false;
      }
      relaunchScheduled = true;
      input.relaunch();
      return true;
    },
  };
}
