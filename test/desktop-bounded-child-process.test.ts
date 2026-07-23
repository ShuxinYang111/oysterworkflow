import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForBoundedChildProcess } from "../desktop/bounded-child-process.js";

describe("bounded desktop child process", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("escalates a TERM-ignoring child to KILL and settles after the hard deadline", async () => {
    vi.useFakeTimers();
    const child = new FakeChildProcess();
    const result = waitForBoundedChildProcess(
      child as unknown as ChildProcess,
      {
        timeoutMs: 10,
        terminateGraceMs: 20,
        killGraceMs: 30,
        timeoutMessage: "permission request timed out",
      },
    );
    const rejection = expect(result).rejects.toThrow(
      "permission request timed out",
    );

    await vi.advanceTimersByTimeAsync(10);
    expect(child.killSignals).toEqual(["SIGTERM"]);
    await vi.advanceTimersByTimeAsync(20);
    expect(child.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
    await vi.advanceTimersByTimeAsync(30);

    await rejection;
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
  });

  it("returns a normal close result and cancels escalation timers", async () => {
    vi.useFakeTimers();
    const child = new FakeChildProcess();
    const result = waitForBoundedChildProcess(
      child as unknown as ChildProcess,
      {
        timeoutMs: 100,
        timeoutMessage: "timed out",
      },
    );

    child.emit("close", 0, null);
    await expect(result).resolves.toEqual({ exitCode: 0, signal: null });
    await vi.advanceTimersByTimeAsync(500);
    expect(child.killSignals).toEqual([]);
  });

  it("cancels an active child on desktop shutdown and still hard-settles", async () => {
    vi.useFakeTimers();
    const child = new FakeChildProcess();
    const controller = new AbortController();
    const result = waitForBoundedChildProcess(
      child as unknown as ChildProcess,
      {
        timeoutMs: 10_000,
        terminateGraceMs: 20,
        killGraceMs: 30,
        timeoutMessage: "timed out",
        abortMessage: "desktop is shutting down",
        signal: controller.signal,
      },
    );
    const rejection = expect(result).rejects.toThrow(
      "desktop is shutting down",
    );

    controller.abort();
    expect(child.killSignals).toEqual(["SIGTERM"]);
    await vi.advanceTimersByTimeAsync(20);
    expect(child.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
    await vi.advanceTimersByTimeAsync(30);
    await rejection;
  });

  it("force-terminates the whole Windows tree before falling back to direct kill", async () => {
    vi.useFakeTimers();
    const child = new FakeChildProcess();
    const windowsTreeTerminator = vi.fn().mockResolvedValue(true);
    const result = waitForBoundedChildProcess(
      child as unknown as ChildProcess,
      {
        timeoutMs: 10,
        terminateGraceMs: 20,
        killGraceMs: 30,
        timeoutMessage: "timed out",
        platform: "win32",
        windowsTreeTerminator,
      },
    );
    const rejection = expect(result).rejects.toThrow("timed out");

    await vi.advanceTimersByTimeAsync(30);
    expect(windowsTreeTerminator).toHaveBeenCalledWith(child.pid);
    expect(child.killSignals).toEqual(["SIGTERM"]);
    await vi.advanceTimersByTimeAsync(30);
    await rejection;
  });

  it("uses direct SIGKILL when Windows tree termination fails", async () => {
    vi.useFakeTimers();
    const child = new FakeChildProcess();
    const result = waitForBoundedChildProcess(
      child as unknown as ChildProcess,
      {
        timeoutMs: 10,
        terminateGraceMs: 20,
        killGraceMs: 30,
        timeoutMessage: "timed out",
        platform: "win32",
        windowsTreeTerminator: vi.fn().mockResolvedValue(false),
      },
    );
    const rejection = expect(result).rejects.toThrow("timed out");

    await vi.advanceTimersByTimeAsync(30);
    expect(child.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
    await vi.advanceTimersByTimeAsync(30);
    await rejection;
  });
});

class FakeChildProcess extends EventEmitter {
  readonly pid = 4_321;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly killSignals: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals): boolean {
    this.killSignals.push(signal);
    return true;
  }
}
