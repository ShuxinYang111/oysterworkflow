import type { ErrorEvent, StackFrame } from "@sentry/electron/main";

export const DEFAULT_SENTRY_DSN =
  "https://5adac4d9ce17d7496f820af584d3e2d5@o4511721099755520.ingest.us.sentry.io/4511721106243584";

export const SENTRY_DATA_COLLECTION = {
  userInfo: false,
  cookies: false,
  httpHeaders: {
    request: false,
    response: false,
  },
  httpBodies: [],
  queryParams: false,
  genAI: {
    inputs: false,
    outputs: false,
  },
  stackFrameVariables: false,
  frameContextLines: 0,
};

const ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);
const SAFE_CONTEXT_KEYS = new Set([
  "app",
  "browser",
  "chrome",
  "device",
  "node",
  "os",
  "runtime",
]);
const SAFE_TAG_KEYS = new Set([
  "component",
  "event.environment",
  "event.origin",
  "event.process",
  "http.method",
  "http.route",
]);
const MAX_TEXT_LENGTH = 2_000;

export interface SentryRuntimeConfig {
  dsn: string;
  enabled: boolean;
  environment: "development" | "production";
  release: string;
  verificationRequested: boolean;
}

export interface RuntimeErrorContext {
  method: string;
  route: string;
  status: 500;
}

/**
 * EN: Resolves the release-safe Sentry configuration for desktop startup.
 * 中文: 解析桌面端启动时使用的安全 Sentry 配置。
 * @param input package state, app version, and process environment.
 * @returns resolved DSN, release, environment, and opt-in state.
 */
export function resolveSentryRuntimeConfig(input: {
  appVersion: string;
  isPackaged: boolean;
  env?: NodeJS.ProcessEnv;
}): SentryRuntimeConfig {
  const env = input.env ?? process.env;
  const verificationRequested = envFlag(env.OYSTERWORKFLOW_SENTRY_VERIFY);
  const disabled = envFlag(env.OYSTERWORKFLOW_SENTRY_DISABLED);
  const developmentEnabled =
    verificationRequested || envFlag(env.OYSTERWORKFLOW_SENTRY_ENABLE_DEV);

  return {
    dsn: env.SENTRY_DSN?.trim() || DEFAULT_SENTRY_DSN,
    enabled: !disabled && (input.isPackaged || developmentEnabled),
    environment: input.isPackaged ? "production" : "development",
    release: `oysterworkflow@${input.appVersion}`,
    verificationRequested,
  };
}

/**
 * EN: Removes user content and credentials before an error leaves the device.
 * 中文: 在错误事件离开设备前移除用户内容与凭证。
 * @param event Sentry error event.
 * @param homeDirectory optional local home directory to normalize from paths.
 * @returns the scrubbed event accepted by Sentry.
 */
export function scrubSentryErrorEvent(
  event: ErrorEvent,
  homeDirectory?: string,
): ErrorEvent {
  event.user = undefined;
  event.request = undefined;
  event.extra = undefined;
  event.transaction = undefined;
  event.server_name = undefined;

  event.message = redactSensitiveText(event.message, homeDirectory);
  if (event.logentry) {
    event.logentry.message = redactSensitiveText(
      event.logentry.message,
      homeDirectory,
    );
    event.logentry.params = undefined;
  }

  event.exception?.values?.forEach((exception) => {
    exception.value = redactSensitiveText(exception.value, homeDirectory);
    scrubStackFrames(exception.stacktrace?.frames, homeDirectory);
  });

  event.breadcrumbs = event.breadcrumbs
    ?.filter((breadcrumb) => breadcrumb.category === "electron")
    .map((breadcrumb) => ({
      category: breadcrumb.category,
      level: breadcrumb.level,
      message: redactSensitiveText(breadcrumb.message, homeDirectory),
      timestamp: breadcrumb.timestamp,
      type: breadcrumb.type,
    }));

  if (event.contexts) {
    event.contexts = Object.fromEntries(
      Object.entries(event.contexts).filter(([key]) =>
        SAFE_CONTEXT_KEYS.has(key),
      ),
    );
  }
  if (event.tags) {
    event.tags = Object.fromEntries(
      Object.entries(event.tags).filter(([key]) => SAFE_TAG_KEYS.has(key)),
    );
  }

  return event;
}

/**
 * EN: Redacts common credentials, email addresses, query values, and home paths.
 * 中文: 遮蔽常见凭证、邮箱、查询参数值和用户主目录路径。
 * @param value possibly sensitive text.
 * @param homeDirectory optional home directory to replace with `~`.
 * @returns bounded redacted text or the original nullish value.
 */
export function redactSensitiveText<T extends string | null | undefined>(
  value: T,
  homeDirectory?: string,
): T extends string ? string : T {
  if (typeof value !== "string") {
    return value as T extends string ? string : T;
  }

  let redacted: string = value;
  if (homeDirectory) {
    redacted = redacted.split(homeDirectory).join("~");
  }
  redacted = redacted
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{10,}\b/gu, "[REDACTED_API_KEY]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "[REDACTED_EMAIL]")
    .replace(
      /(\b(?:api[_-]?key|authorization|cookie|password|secret|token)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
      "$1[REDACTED]",
    )
    .replace(/([?&][^=\s&#]+)=([^&#\s]+)/gu, "$1=[REDACTED]");

  return redacted.slice(0, MAX_TEXT_LENGTH) as T extends string ? string : T;
}

function envFlag(value: string | undefined): boolean {
  return value ? ENABLED_VALUES.has(value.trim().toLowerCase()) : false;
}

function scrubStackFrames(
  frames: StackFrame[] | undefined,
  homeDirectory?: string,
): void {
  frames?.forEach((frame) => {
    frame.abs_path = redactSensitiveText(frame.abs_path, homeDirectory);
    frame.filename = redactSensitiveText(frame.filename, homeDirectory);
    frame.context_line = undefined;
    frame.pre_context = undefined;
    frame.post_context = undefined;
    frame.vars = undefined;
  });
}
