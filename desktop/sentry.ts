import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import * as Sentry from "@sentry/electron/main";
import { app } from "electron";
import {
  resolveSentryRuntimeConfig,
  scrubSentryErrorEvent,
  SENTRY_DATA_COLLECTION,
  type RuntimeErrorContext,
  type SentryRuntimeConfig,
} from "../src/observability/sentry-config.js";

const DISABLED_INTEGRATIONS = new Set(["MainProcessSession", "Screenshots"]);
let runtimeConfig: SentryRuntimeConfig | null = null;

/**
 * EN: Initializes error-only Sentry monitoring before Electron becomes ready.
 * 中文: 在 Electron ready 前初始化仅错误模式的 Sentry 监控。
 * @returns the resolved runtime configuration without exposing secrets.
 */
export function initializeDesktopErrorMonitoring(): SentryRuntimeConfig {
  runtimeConfig = resolveSentryRuntimeConfig({
    appVersion: resolveDesktopAppVersion(),
    isPackaged: app.isPackaged,
  });

  Sentry.init({
    dsn: runtimeConfig.dsn,
    enabled: runtimeConfig.enabled,
    environment: runtimeConfig.environment,
    release: runtimeConfig.release,
    sampleRate: 1,
    tracesSampleRate: 0,
    enableLogs: false,
    attachScreenshot: false,
    enableRendererProfiling: false,
    maxBreadcrumbs: 30,
    maxValueLength: 2_000,
    dataCollection: SENTRY_DATA_COLLECTION,
    integrations: (defaultIntegrations) =>
      defaultIntegrations.filter(
        (integration) => !DISABLED_INTEGRATIONS.has(integration.name),
      ),
    initialScope: {
      tags: {
        component: "desktop",
      },
    },
    beforeSend: (event) => scrubSentryErrorEvent(event, homedir()),
  });

  return runtimeConfig;
}

/**
 * EN: Captures an unexpected Runtime HTTP failure through the main-process SDK.
 * 中文: 通过主进程 SDK 捕获 Runtime HTTP 的非预期失败。
 * @param error thrown Runtime error.
 * @param context safe HTTP method and route metadata.
 * @returns Sentry event id, or null when monitoring is disabled.
 */
export function captureRuntimeError(
  error: unknown,
  context: RuntimeErrorContext,
): string | null {
  if (!runtimeConfig?.enabled) {
    return null;
  }

  return Sentry.withScope((scope) => {
    scope.setTag("component", "runtime");
    scope.setTag("http.method", context.method);
    scope.setTag("http.route", context.route);
    return Sentry.captureException(error);
  });
}

/**
 * EN: Sends one explicit verification event only when the dedicated env flag is set.
 * 中文: 仅在专用环境变量开启时发送一次显式验证事件。
 * @returns verification result, or null during normal launches.
 */
export async function sendSentryVerificationEvent(): Promise<{
  eventId: string;
  flushed: boolean;
} | null> {
  if (!runtimeConfig?.enabled || !runtimeConfig.verificationRequested) {
    return null;
  }

  const eventId = Sentry.withScope((scope) => {
    scope.setTag("component", "desktop-verification");
    return Sentry.captureException(
      new Error("OysterWorkflow Sentry verification error"),
    );
  });
  const flushed = await Sentry.flush(10_000);
  return { eventId, flushed };
}

/**
 * EN: Reads the product version from package metadata during local Electron runs.
 * 中文: 在本地 Electron 运行时从项目清单读取产品版本。
 * @returns OysterWorkflow product version with an Electron fallback.
 */
function resolveDesktopAppVersion(): string {
  if (app.isPackaged) {
    return app.getVersion();
  }

  const manifestCandidates = [
    resolve(process.cwd(), "package.json"),
    resolve(app.getAppPath(), "../../..", "package.json"),
  ];
  for (const manifestPath of manifestCandidates) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        version?: unknown;
      };
      if (typeof manifest.version === "string" && manifest.version.trim()) {
        return manifest.version.trim();
      }
    } catch {
      // EN: Fall through to the next development manifest candidate.
    }
  }

  return app.getVersion();
}
