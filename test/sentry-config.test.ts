import type { ErrorEvent } from "@sentry/electron/main";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SENTRY_DSN,
  redactSensitiveText,
  resolveSentryRuntimeConfig,
  scrubSentryErrorEvent,
} from "../src/observability/sentry-config.js";

describe("Sentry error-only configuration", () => {
  it("enables production reporting and keeps development disabled by default", () => {
    expect(
      resolveSentryRuntimeConfig({
        appVersion: "0.2.0",
        isPackaged: true,
        env: {},
      }),
    ).toMatchObject({
      dsn: DEFAULT_SENTRY_DSN,
      enabled: true,
      environment: "production",
      release: "oysterworkflow@0.2.0",
      verificationRequested: false,
    });

    expect(
      resolveSentryRuntimeConfig({
        appVersion: "0.2.0",
        isPackaged: false,
        env: {},
      }).enabled,
    ).toBe(false);
  });

  it("supports explicit development verification and a global opt-out", () => {
    expect(
      resolveSentryRuntimeConfig({
        appVersion: "0.2.0",
        isPackaged: false,
        env: { OYSTERWORKFLOW_SENTRY_VERIFY: "1" },
      }),
    ).toMatchObject({
      enabled: true,
      verificationRequested: true,
    });

    expect(
      resolveSentryRuntimeConfig({
        appVersion: "0.2.0",
        isPackaged: true,
        env: { OYSTERWORKFLOW_SENTRY_DISABLED: "true" },
      }).enabled,
    ).toBe(false);
  });

  it("removes user content and credentials from error events", () => {
    const event = {
      type: undefined,
      message:
        "authorization=secret@example.com token=abc123 https://example.com?q=private",
      user: { id: "user-1", email: "secret@example.com" },
      request: {
        url: "https://example.com?q=private",
        headers: { Authorization: "Bearer secret-token" },
      },
      extra: { transcript: "private text" },
      transaction: "/Users/demo/private",
      server_name: "demo-mac",
      tags: {
        component: "runtime",
        private_tag: "private",
      },
      contexts: {
        runtime: { name: "Electron", version: "37" },
        private: { transcript: "private text" },
      },
      breadcrumbs: [
        {
          category: "console",
          message: "private user content",
          data: { body: "private" },
        },
        {
          category: "electron",
          message: "window.focus",
          data: { url: "https://example.com?q=private" },
        },
      ],
      exception: {
        values: [
          {
            type: "Error",
            value: "password=hunter2 at /Users/demo/project/file.ts",
            stacktrace: {
              frames: [
                {
                  filename: "/Users/demo/project/file.ts?token=abc",
                  abs_path: "/Users/demo/project/file.ts",
                  context_line: "const token = 'secret'",
                  pre_context: ["private"],
                  post_context: ["private"],
                  vars: { token: "secret" },
                },
              ],
            },
          },
        ],
      },
    } satisfies ErrorEvent;

    const scrubbed = scrubSentryErrorEvent(event, "/Users/demo");

    expect(scrubbed.user).toBeUndefined();
    expect(scrubbed.request).toBeUndefined();
    expect(scrubbed.extra).toBeUndefined();
    expect(scrubbed.transaction).toBeUndefined();
    expect(scrubbed.server_name).toBeUndefined();
    expect(scrubbed.message).not.toContain("secret@example.com");
    expect(scrubbed.message).not.toContain("private");
    expect(scrubbed.tags).toEqual({ component: "runtime" });
    expect(scrubbed.contexts).toEqual({
      runtime: { name: "Electron", version: "37" },
    });
    expect(scrubbed.breadcrumbs).toEqual([
      {
        category: "electron",
        level: undefined,
        message: "window.focus",
        timestamp: undefined,
        type: undefined,
      },
    ]);
    expect(scrubbed.exception?.values?.[0]?.value).toBe(
      "password=[REDACTED] at ~/project/file.ts",
    );
    expect(
      scrubbed.exception?.values?.[0]?.stacktrace?.frames?.[0],
    ).toMatchObject({
      filename: "~/project/file.ts?token=[REDACTED]",
      abs_path: "~/project/file.ts",
      context_line: undefined,
      pre_context: undefined,
      post_context: undefined,
      vars: undefined,
    });
  });

  it("redacts common secret formats from bounded text", () => {
    expect(
      redactSensitiveText(
        "Bearer abc.def apiKey=sk-1234567890ABC user@example.com",
      ),
    ).toBe("Bearer [REDACTED] apiKey=[REDACTED] [REDACTED_EMAIL]");
  });
});
