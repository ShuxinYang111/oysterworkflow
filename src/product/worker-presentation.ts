export const START_WORKER_PREPARATION_MESSAGE =
  "Start worker to prepare this AI worker";

/**
 * EN: Converts implementation-specific runtime wording into product language for user-visible surfaces.
 * 中文: 将运行时实现细节转换为适合用户界面展示的产品文案。
 * @param value raw runtime, provider, or event text.
 * @returns user-facing text without bundled runtime or browser-provider names.
 */
export function productizeWorkerFacingText(value: string): string {
  return value
    .replace(
      /Check Hermes provider credentials and run hermes doctor\./giu,
      "Check the AI worker model connection in Settings.",
    )
    .replace(
      /Hermes stopped with signal\s+[A-Z0-9_-]+\.?/giu,
      "AI worker stopped unexpectedly.",
    )
    .replace(/BrowserAct\s*\/\s*managed browser/giu, "browser connection")
    .replace(
      /OysterWorkflow BrowserAct wrapper/giu,
      "OysterWorkflow browser connection",
    )
    .replace(
      /Hermes built-in browser automation/giu,
      "built-in browser control",
    )
    .replace(/Hermes worker session/giu, "AI worker session")
    .replace(/Hermes session/giu, "AI worker session")
    .replace(/Hermes Agent/giu, "AI worker")
    .replace(/Hermes stopped/giu, "AI worker stopped")
    .replace(/\$OYSTER_BROWSER_CLI/gu, "the browser connection")
    .replace(
      /\bBrowserAct(?:\s+chrome-direct)?(?:\s+browser)?\b/giu,
      "browser connection",
    )
    .replace(/\bbrowser-act(?:-cli)?\b/giu, "browser connection")
    .replace(/\bchrome-direct\b/giu, "local Chrome connection")
    .replace(/\bbrowser sidecar\b/giu, "browser connection")
    .replace(/\bsidecar\b/giu, "local runtime component")
    .replace(/\bHermes\b/giu, "AI worker runtime");
}

/**
 * EN: Detects stdout, CLI banners, diffs, and tool diagnostics that must not appear as Agent chat messages.
 * 中文: 识别不应作为 Agent 对话消息展示的 stdout、CLI 横幅、diff 与工具诊断。
 * @param value candidate event body.
 * @returns true when the body is internal diagnostic output.
 */
export function isInternalWorkerDiagnosticText(value: string): boolean {
  const text = value.trim();
  if (!text) {
    return false;
  }
  return (
    /(?:^|\n)\s*┊\s*review diff\b/iu.test(text) ||
    /\b(?:cua-driver-rs|cua-driver)\b/iu.test(text) ||
    /(?:^|\n)\s*(?:---|\+\+\+)\s+\/(?:tmp|private\/tmp|var\/folders)\//iu.test(
      text,
    ) ||
    /\bUsed\s+(?:terminal|computer_use|browser|file|vision)\s*\([^)]*\bchars?\b[^)]*\)/iu.test(
      text,
    ) ||
    /\bUpdate with:\s*\S+/iu.test(text) ||
    /\bRelease notes:\s*https?:\/\//iu.test(text) ||
    /(?:^|\n)\s*OYSTERWORKFLOW_(?:SESSION_STATUS|WORKER_|HERMES_)/u.test(text)
  );
}

/**
 * EN: Defines the response boundary shared by worker prompts and generated runtime skills.
 * 中文: 定义 worker 提示词与运行时 skill 共用的用户回复边界。
 * @returns prompt lines that keep implementation details and raw diagnostics out of normal responses.
 */
export function workerUserFacingResponsePolicyLines(): string[] {
  return [
    "User-facing response policy:",
    "Write as the OysterWorkflow AI worker. In normal user-facing responses, do not mention Hermes, BrowserAct, `$OYSTER_BROWSER_CLI`, `browser-act`, chrome-direct, sidecars, provider adapters, CLI commands, or internal tool routing.",
    "Translate implementation failures into product language such as ‘browser connection unavailable’, ‘AI worker stopped’, or ‘connected app unavailable’.",
    "Never include raw stdout or stderr, CLI banners, update notices, release notes, diff output, protocol markers, or tool diagnostics in a user-facing response.",
    "Keep implementation names only in internal tool calls, diagnostics, and protocol output, never in the normal response.",
  ];
}
