import * as Sentry from "@sentry/electron/renderer";
import {
  scrubSentryErrorEvent,
  SENTRY_DATA_COLLECTION,
} from "../../src/observability/sentry-config";

/**
 * EN: Initializes renderer error capture without logs, tracing, replay, or PII.
 * 中文: 初始化 renderer 错误捕获，不启用日志、追踪、回放或个人信息采集。
 * @returns {void}
 */
export function initializeRendererErrorMonitoring(): void {
  Sentry.init({
    sampleRate: 1,
    tracesSampleRate: 0,
    enableLogs: false,
    maxBreadcrumbs: 30,
    maxValueLength: 2_000,
    dataCollection: SENTRY_DATA_COLLECTION,
    beforeSend: (event) => scrubSentryErrorEvent(event),
  });
}
