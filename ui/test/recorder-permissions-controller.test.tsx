import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { RecorderPermissionsResponse } from "../../src/lab-api/api-contracts.js";
import { useRecorderPermissionsController } from "../src/recorder-permissions-controller";

describe("recorder permissions controller", () => {
  it("lets an interactive check supersede an older passive poll", async () => {
    const passive = deferred<RecorderPermissionsResponse>();
    const interactive = deferred<RecorderPermissionsResponse>();
    const check = vi
      .fn()
      .mockReturnValueOnce(passive.promise)
      .mockReturnValueOnce(interactive.promise);
    const { result } = renderHook(() =>
      useRecorderPermissionsController(check, String),
    );

    let passiveRun!: Promise<RecorderPermissionsResponse | null>;
    let interactiveRun!: Promise<RecorderPermissionsResponse | null>;
    act(() => {
      passiveRun = result.current.refresh({
        force: true,
        priority: "passive",
        showLoading: false,
      });
      interactiveRun = result.current.refresh({
        force: true,
        priority: "interactive",
        showLoading: true,
      });
    });

    await act(async () => {
      interactive.resolve(permissionSnapshot(true));
      await interactiveRun;
    });
    expect(result.current.permissions?.canStartRecording).toBe(true);

    await act(async () => {
      passive.resolve(permissionSnapshot(false));
      await passiveRun;
    });
    expect(result.current.permissions?.canStartRecording).toBe(true);
    expect(result.current.loading).toBe(false);
  });
});

function permissionSnapshot(
  canStartRecording: boolean,
): RecorderPermissionsResponse {
  return {
    platform: "darwin",
    canStartRecording,
    items: [],
    checkedAt: "2026-07-17T00:00:00.000Z",
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
