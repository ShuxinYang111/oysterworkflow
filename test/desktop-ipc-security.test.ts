import { describe, expect, it } from "vitest";
import { assertTrustedIpcSender } from "../desktop/ipc-security.js";

describe("desktop IPC sender validation", () => {
  it("accepts only the current primary window webContents", () => {
    expect(() =>
      assertTrustedIpcSender(
        { sender: { id: 7 } },
        { isDestroyed: () => false, webContents: { id: 7 } },
      ),
    ).not.toThrow();
    expect(() =>
      assertTrustedIpcSender(
        { sender: { id: 8 } },
        { isDestroyed: () => false, webContents: { id: 7 } },
      ),
    ).toThrow("IPC request rejected: untrusted renderer.");
  });

  it("rejects missing or destroyed primary windows", () => {
    expect(() => assertTrustedIpcSender({ sender: { id: 7 } }, null)).toThrow();
    expect(() =>
      assertTrustedIpcSender(
        { sender: { id: 7 } },
        { isDestroyed: () => true, webContents: { id: 7 } },
      ),
    ).toThrow();
  });
});
