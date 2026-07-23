import type { ProductCapabilityProvider } from "../../src/product/contracts.js";
import type { AppLanguage } from "./app-language";

/**
 * EN: Identifies the Chrome window-binding failure returned by the local browser connector.
 * 中文: 识别本地浏览器连接器返回的 Chrome 窗口绑定失败。
 * @param value raw provider error or diagnostic text.
 * @returns whether the text represents the known window-binding failure.
 */
export function isChromeWindowBindingFailure(
  value: string | null | undefined,
): boolean {
  return /Browser window not found|\b210101\b/iu.test(value ?? "");
}

/**
 * EN: Converts Chrome provider state into concise bilingual recovery guidance while preserving raw diagnostics separately.
 * 中文: 将 Chrome provider 状态转换为简洁的双语恢复说明，并将原始诊断保留在独立区域。
 * @param provider current Chrome capability provider snapshot.
 * @param language active application language.
 * @param fallbackError transport-level error when no provider error is available.
 * @returns primary user-facing connection detail, or null when none is available.
 */
export function formatChromeCapabilityDetail(
  provider: ProductCapabilityProvider | null,
  language: AppLanguage,
  fallbackError?: string | null,
): string | null {
  const diagnostic = provider?.lastError ?? fallbackError ?? null;
  if (provider?.status === "not_checked") {
    return language === "zh"
      ? "连接当前已登录的 Chrome 并验证页面读取。首次批准调试后，Chrome 可能会完整重启一次。"
      : "Connect the current signed-in Chrome session and verify page access. Chrome may fully restart once after first-time debug approval.";
  }
  if (provider?.status === "checking") {
    return language === "zh"
      ? "正在连接 Chrome。首次批准调试后，Chrome 可能会完整重启一次。"
      : "Connecting to Chrome. Chrome may fully restart once after first-time debug approval.";
  }
  if (provider?.status === "ready") {
    return language === "zh"
      ? "Chrome 已连接，可在浏览器工作流中使用当前登录状态。"
      : "Chrome is connected and can use the current signed-in session for browser workflows.";
  }
  if (provider?.detail?.includes("active AI Worker")) {
    return language === "zh"
      ? "Chrome 正由运行中的 AI Worker 使用。请先停止当前任务，再重新连接 Chrome。"
      : provider.detail;
  }
  if (
    provider?.status === "unavailable" &&
    isChromeWindowBindingFailure(diagnostic)
  ) {
    return language === "zh"
      ? "OysterWorkflow 等待 Chrome 启动后仍未能绑定当前浏览器窗口。请保持 Chrome 打开后重新连接。"
      : "OysterWorkflow could not bind the current browser window after waiting for Chrome to start. Keep Chrome open and reconnect.";
  }
  return provider?.detail ?? diagnostic;
}
