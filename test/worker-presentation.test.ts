import { describe, expect, it } from "vitest";
import {
  isInternalWorkerDiagnosticText,
  productizeWorkerFacingText,
  workerUserFacingResponsePolicyLines,
} from "../src/product/worker-presentation.js";

describe("worker presentation boundaries", () => {
  it("removes bundled runtime and browser implementation names from user-facing text", () => {
    const result = productizeWorkerFacingText(
      "BrowserAct/managed browser was unavailable, so Hermes stopped with signal SIGKILL. Retry with $OYSTER_BROWSER_CLI instead of browser-act-cli.",
    );

    expect(result).toBe(
      "browser connection was unavailable, so AI worker stopped unexpectedly. Retry with the browser connection instead of browser connection.",
    );
    expect(result).not.toMatch(
      /Hermes|BrowserAct|browser-act|OYSTER_BROWSER_CLI/u,
    );
  });

  it("turns internal recovery commands into a product action", () => {
    expect(
      productizeWorkerFacingText(
        "Check Hermes provider credentials and run hermes doctor.",
      ),
    ).toBe("Check the AI worker model connection in Settings.");
  });

  it("leaves the explicitly out-of-scope provider, model, session, permission, and path details unchanged", () => {
    const details =
      "codex-local / gpt-5.5 · session 20260710010101aa · allow_all · /Users/alex/project";

    expect(productizeWorkerFacingText(details)).toBe(details);
  });

  it("detects raw CLI and tool diagnostics without rejecting normal worker replies", () => {
    expect(
      isInternalWorkerDiagnosticText(
        "✨ cua-driver-rs: update available\nRelease notes: https://github.com/trycua/cua",
      ),
    ).toBe(true);
    expect(
      isInternalWorkerDiagnosticText(
        "┊ review diff\n--- /tmp/outlook_message.applescript",
      ),
    ).toBe(true);
    expect(
      isInternalWorkerDiagnosticText("Used terminal (0.20s, 29093 chars)."),
    ).toBe(true);
    expect(
      isInternalWorkerDiagnosticText(
        "The draft is ready for review and remains unsent.",
      ),
    ).toBe(false);
  });

  it("defines a normal-response policy that keeps implementation details and stdout internal", () => {
    const policy = workerUserFacingResponsePolicyLines().join("\n");

    expect(policy).toContain("do not mention Hermes, BrowserAct");
    expect(policy).toContain("Never include raw stdout or stderr");
    expect(policy).toContain("browser connection unavailable");
  });
});
