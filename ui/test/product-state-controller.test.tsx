import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useProductStateController } from "../src/product-state-controller";

describe("product state controller", () => {
  it("shares one refresh within a generation", async () => {
    const request = deferred<{ revision: string }>();
    const loader = vi.fn(() => request.promise);
    const secondLoader = vi.fn(async () => ({ revision: "duplicate" }));
    const { result } = renderHook(() =>
      useProductStateController<{ revision: string }>(),
    );

    let first!: Promise<unknown>;
    let second!: Promise<unknown>;
    act(() => {
      first = result.current.runRefresh(loader);
      second = result.current.runRefresh(secondLoader);
    });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(secondLoader).not.toHaveBeenCalled();

    await act(async () => {
      request.resolve({ revision: "server-1" });
      await Promise.all([first, second]);
    });
    expect(result.current.state).toEqual({ revision: "server-1" });
  });

  it("does not let an old refresh overwrite a mutation and serializes its replacement", async () => {
    const oldRequest = deferred<{ revision: string }>();
    const newRequest = deferred<{ revision: string }>();
    const newLoader = vi.fn(() => newRequest.promise);
    const { result } = renderHook(() =>
      useProductStateController<{ revision: string }>(),
    );

    let oldRun!: Promise<unknown>;
    act(() => {
      oldRun = result.current.runRefresh(() => oldRequest.promise);
    });
    act(() => {
      result.current.applySnapshot({ revision: "mutation" });
    });
    let newRun!: Promise<unknown>;
    act(() => {
      newRun = result.current.runRefresh(newLoader);
    });
    expect(newLoader).not.toHaveBeenCalled();

    await act(async () => {
      oldRequest.resolve({ revision: "stale-server" });
      await oldRun;
    });
    expect(result.current.state).toEqual({ revision: "mutation" });
    expect(newLoader).toHaveBeenCalledTimes(1);

    await act(async () => {
      newRequest.resolve({ revision: "fresh-server" });
      await newRun;
    });
    expect(result.current.state).toEqual({ revision: "fresh-server" });
  });

  it("runs only the latest queued generation after a stale request settles", async () => {
    const activeRequest = deferred<{ revision: string }>();
    const supersededLoader = vi.fn(async () => ({ revision: "superseded" }));
    const latestLoader = vi.fn(async () => ({ revision: "latest" }));
    const { result } = renderHook(() =>
      useProductStateController<{ revision: string }>(),
    );

    let activeRun!: Promise<unknown>;
    act(() => {
      activeRun = result.current.runRefresh(() => activeRequest.promise);
      result.current.invalidate();
      void result.current.runRefresh(supersededLoader);
      result.current.invalidate();
      void result.current.runRefresh(latestLoader);
    });
    await act(async () => {
      activeRequest.resolve({ revision: "stale" });
      await activeRun;
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(supersededLoader).not.toHaveBeenCalled();
    expect(latestLoader).toHaveBeenCalledTimes(1);
    expect(result.current.state).toEqual({ revision: "latest" });
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
