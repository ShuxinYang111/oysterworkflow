import { describe, expect, it } from "vitest";
import { parseE2eAnalyzeCliArgs } from "../src/cli/commands/e2e-analyze.js";

describe("e2e-analyze CLI args", () => {
  it("accepts an explicitly selected case catalog", () => {
    expect(
      parseE2eAnalyzeCliArgs({
        out: "/tmp/e2e-output",
        cases: "/tmp/current-cases.json",
      }),
    ).toEqual({
      out: "/tmp/e2e-output",
      casesPath: "/tmp/current-cases.json",
    });
  });

  it("rejects an invocation without an explicit case catalog", () => {
    expect(() => parseE2eAnalyzeCliArgs({})).toThrow();
  });
});
