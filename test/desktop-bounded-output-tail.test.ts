import { describe, expect, it } from "vitest";
import { BoundedOutputTail } from "../desktop/bounded-output-tail.js";

describe("bounded child-process output tail", () => {
  it("caps noisy output while retaining the final permission JSON", () => {
    const output = new BoundedOutputTail(64 * 1024);
    output.append("x".repeat(96 * 1024));
    output.append(
      '\n{"screenRecording":"granted","inputMonitoring":"granted"}\n',
    );

    expect(output.byteLength()).toBeLessThanOrEqual(64 * 1024);
    expect(output.text()).not.toContain("x".repeat(65 * 1024));
    expect(output.text()).toContain('"screenRecording":"granted"');
  });

  it("retains a valid UTF-8 diagnostic tail after trimming multibyte text", () => {
    const output = new BoundedOutputTail(24);
    output.append("权限检查".repeat(20));
    output.append(" final error");

    expect(output.byteLength()).toBeLessThanOrEqual(24);
    expect(output.text()).toContain("final error");
    expect(output.text()).not.toContain("�");
  });
});
