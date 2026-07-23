import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const stylesPath = resolve(process.cwd(), "src/styles.css");

describe("modal layer tokens", () => {
  it("keeps transient results above onboarding and nested dialogs", () => {
    const styles = readFileSync(stylesPath, "utf8");
    const modal = readLayer(styles, "--ow-layer-modal");
    const dialog = readLayer(styles, "--ow-layer-dialog");
    const connector = readLayer(styles, "--ow-layer-connector");
    const toast = readLayer(styles, "--ow-layer-toast");

    expect(dialog).toBeGreaterThan(modal);
    expect(connector).toBeGreaterThan(dialog);
    expect(toast).toBeGreaterThan(connector);
    expect(styles).toMatch(
      /\.demo-toast\s*\{[^}]*z-index:\s*var\(--ow-layer-toast\)/su,
    );
  });
});

function readLayer(styles: string, token: string): number {
  const escapedToken = token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = styles.match(new RegExp(`${escapedToken}:\\s*(\\d+)`, "u"));
  if (!match?.[1]) {
    throw new Error(`Missing CSS layer token: ${token}`);
  }
  return Number(match[1]);
}
