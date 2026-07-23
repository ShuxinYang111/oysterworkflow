import type { ProductRunEvent } from "./contracts.js";
import { isInternalWorkerDiagnosticText } from "./worker-presentation.js";

/**
 * EN: Ranks Hermes conversation lifecycle statuses for deterministic deduplication.
 * 中文: 为 Hermes 对话生命周期状态排序，供确定性去重使用。
 * @param status product-facing run-event status.
 * @returns numeric preference rank; zero means it is not a conversation status.
 */
export function hermesConversationStatusRank(status: string): number {
  const normalized = status.toLowerCase();
  if (/failed|blocked/u.test(normalized)) {
    return 50;
  }
  if (/waiting for user/u.test(normalized)) {
    return 45;
  }
  if (/completed|response/u.test(normalized)) {
    return 40;
  }
  if (/ready/u.test(normalized)) {
    return 30;
  }
  if (/started/u.test(normalized)) {
    return 20;
  }
  return 0;
}

/**
 * EN: Detects Hermes statuses intended for the user-facing Agent conversation.
 * 中文: 判断 Hermes 状态是否应进入面向用户的 Agent 对话。
 * @param status run-event status.
 * @returns whether the status belongs in conversation history.
 */
export function isHermesAgentMessageStatus(status: string): boolean {
  return hermesConversationStatusRank(status) > 0;
}

/**
 * EN: Detects Product-owned system events that carry conversation meaning.
 * 中文: 判断 Product 自有系统事件是否包含应展示的对话语义。
 * @param event product run event.
 * @returns whether the system event belongs in the Agent conversation.
 */
export function isProductSystemAgentEvent(event: ProductRunEvent): boolean {
  const normalized = event.status.toLowerCase();
  if (event.source === "executor") {
    return normalized === "workflow selected";
  }
  if (event.source === "system") {
    return (
      normalized === "initializing" ||
      normalized === "initialized" ||
      normalized === "paused" ||
      normalized === "ai worker failed"
    );
  }
  return false;
}

/**
 * EN: Filters and deduplicates user-facing Agent conversation events while preserving input order.
 * 中文: 筛选并去重面向用户的 Agent 对话事件，同时保持输入顺序。
 * @param events product run events in caller-defined display order.
 * @returns displayable conversation events in the same order.
 */
export function selectProductAgentConversationEvents(
  events: ProductRunEvent[],
): ProductRunEvent[] {
  return dedupeProductAgentConversationEvents(
    events.filter(isProductAgentConversationEvent),
  );
}

function isProductAgentConversationEvent(event: ProductRunEvent): boolean {
  if (
    /runtime recovered/i.test(event.status) ||
    /runtime restarted before this run finished/i.test(event.body)
  ) {
    return false;
  }
  if (event.source === "user") {
    return true;
  }
  if (event.source === "hermes") {
    return (
      isHermesAgentMessageStatus(event.status) &&
      !isInternalWorkerDiagnosticText(event.body)
    );
  }
  return isProductSystemAgentEvent(event);
}

function dedupeProductAgentConversationEvents(
  events: ProductRunEvent[],
): ProductRunEvent[] {
  const deduped: ProductRunEvent[] = [];
  for (const event of events) {
    if (event.source !== "hermes" || !event.body.trim()) {
      deduped.push(event);
      continue;
    }
    const existingIndex = deduped.findIndex(
      (item) =>
        item.source === "hermes" &&
        item.runId === event.runId &&
        item.workerId === event.workerId &&
        item.body.trim() === event.body.trim(),
    );
    if (existingIndex < 0) {
      deduped.push(event);
      continue;
    }
    if (
      hermesConversationStatusRank(event.status) >
      hermesConversationStatusRank(deduped[existingIndex]!.status)
    ) {
      deduped[existingIndex] = event;
    }
  }
  return deduped;
}
