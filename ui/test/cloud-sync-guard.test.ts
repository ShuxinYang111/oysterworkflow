import { describe, expect, it } from "vitest";
import { createLatestCloudSyncGuard } from "../src/cloud-sync-guard";

describe("latest cloud sync guard", () => {
  it("ignores a deferred Account A result after Account B finishes first", async () => {
    const guard = createLatestCloudSyncGuard();
    const accountA = deferred<string>();
    const accountB = deferred<string>();
    const applied: string[] = [];

    guard.setIdentity("account-a");
    const accountARun = applyWhenCurrent(
      guard,
      "account-a",
      accountA.promise,
      applied,
    );
    guard.setIdentity("account-b");
    const accountBRun = applyWhenCurrent(
      guard,
      "account-b",
      accountB.promise,
      applied,
    );

    accountB.resolve("Account B synced");
    await accountBRun;
    accountA.resolve("Account A synced late");
    await accountARun;

    expect(applied).toEqual(["Account B synced"]);
  });

  it("does not let a stale Account A callback invalidate Account B", () => {
    const guard = createLatestCloudSyncGuard();
    guard.setIdentity("account-b");
    const accountBAttempt = guard.begin("account-b");
    const staleAccountAAttempt = guard.begin("account-a");

    expect(guard.isCurrent(accountBAttempt)).toBe(true);
    expect(guard.isCurrent(staleAccountAAttempt)).toBe(false);
  });
});

async function applyWhenCurrent(
  guard: ReturnType<typeof createLatestCloudSyncGuard>,
  userId: string,
  result: Promise<string>,
  applied: string[],
): Promise<void> {
  const attempt = guard.begin(userId);
  const value = await result;
  if (guard.isCurrent(attempt)) {
    applied.push(value);
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
