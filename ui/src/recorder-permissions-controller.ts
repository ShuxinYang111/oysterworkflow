import { useCallback, useRef, useState } from "react";
import type { RecorderPermissionsResponse } from "../../src/lab-api/api-contracts.js";
import type { PermissionsModalMode } from "./settings-ui";

type PermissionRefreshPriority = "passive" | "interactive";

interface PermissionRefreshOptions {
  force: boolean;
  priority?: PermissionRefreshPriority;
  showLoading?: boolean;
}

interface ActivePermissionRefresh {
  id: number;
  priority: PermissionRefreshPriority;
}

/**
 * EN: Owns recorder permission and startup-gate state while rejecting stale probes.
 * 中文: 管理录制权限与启动拦截状态，并拒绝迟到的旧探测结果。
 * @param check permission probe implementation.
 * @param formatError converts unknown errors into user-facing copy.
 * @returns permission state and serialized refresh operations.
 */
export function useRecorderPermissionsController(
  check: (input: { force?: boolean }) => Promise<RecorderPermissionsResponse>,
  formatError: (error: unknown) => string,
) {
  const [permissions, setPermissions] =
    useState<RecorderPermissionsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<PermissionsModalMode | null>(null);
  const [startupGateOpen, setStartupGateOpen] = useState(false);
  const [startupPhase, setStartupPhase] = useState<
    "checking" | "blocked" | "ready"
  >("checking");
  const [restartRequired, setRestartRequired] = useState(false);
  const sequenceRef = useRef(0);
  const activeRef = useRef<ActivePermissionRefresh | null>(null);

  const invalidate = useCallback((): void => {
    sequenceRef.current += 1;
    activeRef.current = null;
    setLoading(false);
  }, []);

  const refresh = useCallback(
    async ({
      force,
      priority = "interactive",
      showLoading = priority === "interactive",
    }: PermissionRefreshOptions): Promise<RecorderPermissionsResponse | null> => {
      if (
        priority === "passive" &&
        activeRef.current?.priority === "interactive"
      ) {
        return null;
      }
      sequenceRef.current += 1;
      const active = { id: sequenceRef.current, priority };
      activeRef.current = active;
      if (showLoading) {
        setLoading(true);
        setError(null);
      }
      try {
        const nextPermissions = await check({ force });
        if (activeRef.current?.id !== active.id) {
          return null;
        }
        setPermissions(nextPermissions);
        if (nextPermissions.canStartRecording) {
          setMode(null);
        }
        return nextPermissions;
      } catch (refreshError) {
        if (activeRef.current?.id !== active.id) {
          return null;
        }
        if (showLoading) {
          setError(formatError(refreshError));
        }
        return null;
      } finally {
        if (activeRef.current?.id === active.id) {
          activeRef.current = null;
          if (showLoading) {
            setLoading(false);
          }
        }
      }
    },
    [check, formatError],
  );

  return {
    permissions,
    loading,
    error,
    mode,
    startupGateOpen,
    startupPhase,
    restartRequired,
    invalidate,
    refresh,
    setError,
    setMode,
    setRestartRequired,
    setStartupGateOpen,
    setStartupPhase,
  };
}
