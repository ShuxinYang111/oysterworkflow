import { describe, expect, it } from "vitest";
import {
  normalizeRuntimeRequestId,
  normalizeRuntimeRequestMethod,
  normalizeRuntimeRequestPath,
  normalizeRuntimeRequestTimeout,
  RuntimeRequestAbortRegistry,
} from "../desktop/runtime-request-proxy.js";

describe("desktop authenticated Runtime request proxy", () => {
  it("accepts only local API paths and preserves query parameters", () => {
    expect(
      normalizeRuntimeRequestPath(
        "/api/product/integrations/composio?filter=connected",
      ),
    ).toBe("/api/product/integrations/composio?filter=connected");
  });

  it("rejects absolute and protocol-relative destinations", () => {
    expect(() =>
      normalizeRuntimeRequestPath("https://attacker.example/api/product"),
    ).toThrow("Only local OysterWorkflow API paths are allowed.");
    expect(() =>
      normalizeRuntimeRequestPath("//attacker.example/api/product"),
    ).toThrow("Only local OysterWorkflow API paths are allowed.");
    expect(() => normalizeRuntimeRequestPath("/settings")).toThrow(
      "Only local OysterWorkflow API paths are allowed.",
    );
  });

  it("rejects encoded dot segments that normalize outside the API namespace", () => {
    expect(() => normalizeRuntimeRequestPath("/api/%2e%2e/settings")).toThrow(
      "Only local OysterWorkflow API paths are allowed.",
    );
    expect(() =>
      normalizeRuntimeRequestPath("/api/product/%2e%2e/%2e%2e/settings"),
    ).toThrow("Only local OysterWorkflow API paths are allowed.");
  });

  it("validates renderer request ids and caps renderer-owned deadlines", () => {
    expect(normalizeRuntimeRequestId("renderer-abc:1")).toBe("renderer-abc:1");
    expect(() => normalizeRuntimeRequestId("renderer request")).toThrow(
      "Invalid local Runtime request identifier.",
    );
    expect(normalizeRuntimeRequestTimeout(undefined, 90_000)).toBe(90_000);
    expect(normalizeRuntimeRequestTimeout(2_000_000, 90_000)).toBe(900_000);
  });

  it("allows Graph PATCH requests while rejecting unknown methods", () => {
    expect(normalizeRuntimeRequestMethod("patch")).toBe("PATCH");
    expect(normalizeRuntimeRequestMethod(undefined)).toBe("GET");
    expect(() => normalizeRuntimeRequestMethod("CONNECT")).toThrow(
      "不支持的本地 Runtime 请求方法",
    );
    expect(() => normalizeRuntimeRequestMethod({ method: "PATCH" })).toThrow(
      "本地 Runtime 请求方法格式无效",
    );
  });

  it("aborts and releases an in-flight request by its renderer id", () => {
    const registry = new RuntimeRequestAbortRegistry();
    const lease = registry.acquire("renderer-active-1");

    expect(registry.cancel("renderer-active-1")).toBe(true);
    expect(lease.signal.aborted).toBe(true);
    lease.release();
    expect(registry.cancel("renderer-active-1")).toBe(false);
  });
});
