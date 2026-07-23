import { describe, expect, it } from "vitest";
import { parseCaseLoopCliArgs } from "../src/cli/commands/case-loop.js";

describe("case-loop command arg parsing", () => {
  // EN: Should apply default time window and defaults.
  it("parses defaults", () => {
    const parsed = parseCaseLoopCliArgs({
      out: "/tmp/.runs",
    });

    expect(parsed.date).toBe("2026-03-03");
    expect(parsed.fromTime).toBe("11:50:00");
    expect(parsed.toTime).toBe("11:57:00");
    expect(parsed.minScore).toBe(70);
    expect(parsed.apps).toBe("*");
  });
  // EN: Should parse custom values with type coercion.
  it("parses custom values", () => {
    const parsed = parseCaseLoopCliArgs({
      out: "/tmp/.runs",
      apps: "Google Chrome,Terminal",
      minScore: "82",
      date: "2026-03-04",
      fromTime: "10:00:00",
      toTime: "10:10:00",
      wireApi: "responses",
    });

    expect(parsed.apps).toBe("Google Chrome,Terminal");
    expect(parsed.minScore).toBe(82);
    expect(parsed.date).toBe("2026-03-04");
    expect(parsed.fromTime).toBe("10:00:00");
    expect(parsed.toTime).toBe("10:10:00");
    expect(parsed.wireApi).toBe("responses");
    expect("maxSteps" in parsed).toBe(false);
  });
});
