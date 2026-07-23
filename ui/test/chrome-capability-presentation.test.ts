import { describe, expect, it } from "vitest";
import type { ProductCapabilityProvider } from "../../src/product/contracts.js";
import {
  formatChromeCapabilityDetail,
  isChromeWindowBindingFailure,
} from "../src/chrome-capability-presentation";

const unavailableChrome: ProductCapabilityProvider = {
  id: "chrome",
  kind: "browser",
  label: "Chrome",
  description: "Local Chrome",
  enabled: true,
  required: false,
  status: "unavailable",
  installed: true,
  pinnedVersion: "1.0.6",
  version: "1.0.6",
  commandPath: "/Applications/OysterWorkflow.app/helper",
  lastCheckedAt: "2026-07-17T05:00:00.000Z",
  lastError:
    "Error 210101: {'code': -32000, 'message': 'Browser window not found'}",
  lastSuccessAt: null,
  detail: "Chrome could not be reached.",
};

describe("Chrome capability presentation", () => {
  it("recognizes the BrowserAct window-binding failure", () => {
    expect(isChromeWindowBindingFailure(unavailableChrome.lastError)).toBe(
      true,
    );
  });

  it("replaces raw diagnostics with actionable bilingual copy", () => {
    expect(formatChromeCapabilityDetail(unavailableChrome, "en")).toContain(
      "waiting for Chrome to start",
    );
    expect(formatChromeCapabilityDetail(unavailableChrome, "zh")).toContain(
      "等待 Chrome 启动",
    );
    expect(formatChromeCapabilityDetail(unavailableChrome, "zh")).not.toMatch(
      /210101|Browser window not found/u,
    );
  });

  it("explains the one-time restart before the first Chrome check", () => {
    const notCheckedChrome: ProductCapabilityProvider = {
      ...unavailableChrome,
      status: "not_checked",
      lastError: null,
    };

    expect(formatChromeCapabilityDetail(notCheckedChrome, "en")).toContain(
      "fully restart once",
    );
    expect(formatChromeCapabilityDetail(notCheckedChrome, "zh")).toContain(
      "完整重启一次",
    );
  });
});
