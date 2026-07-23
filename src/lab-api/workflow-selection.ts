import type { WorkflowCandidate } from "../types/contracts.js";

/**
 * EN: Compares workflow candidates using the discovery priority contract.
 * 中文: 按工作流发现阶段的优先级契约比较候选项。
 * @param left First workflow candidate.
 * @param right Second workflow candidate.
 * @returns Negative when left should be preferred.
 */
export function compareWorkflowCandidatePriority(
  left: WorkflowCandidate,
  right: WorkflowCandidate,
): number {
  return (
    left.priority - right.priority ||
    right.eventCount - left.eventCount ||
    left.workflowId.localeCompare(right.workflowId)
  );
}

/**
 * EN: Returns the highest-priority workflow candidate without mutating input.
 * 中文: 在不修改输入数组的前提下返回最高优先级候选项。
 * @param candidates Discovered workflow candidates.
 * @returns Preferred candidate or null when the list is empty.
 */
export function selectPreferredWorkflowCandidate(
  candidates: readonly WorkflowCandidate[],
): WorkflowCandidate | null {
  return [...candidates].sort(compareWorkflowCandidatePriority)[0] ?? null;
}
