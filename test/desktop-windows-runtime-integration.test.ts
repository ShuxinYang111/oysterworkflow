import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("desktop Windows Runtime termination integration", () => {
  it("uses the bounded Windows tree terminator before direct SIGKILL fallback", async () => {
    const source = await readFile("desktop/main.ts", "utf8");

    expect(source).toContain(
      'import { terminateWindowsProcessTree } from "../src/process/windows-tree.js";',
    );
    expect(source).toMatch(
      /if \(process\.platform === "win32" && child\.pid\)[\s\S]*terminateWindowsProcessTree\(child\.pid\)[\s\S]*signalRuntimeProcessTree\(child, "SIGKILL"\)/u,
    );
  });
});
