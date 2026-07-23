import { useState } from "react";
import type { AppLanguage } from "./app-language";
import type { ProductPendingWorkflowMerge } from "../../src/product/contracts.js";

interface WorkflowMergeDecisionDialogProps {
  language: AppLanguage;
  decision: ProductPendingWorkflowMerge;
  isSubmitting: boolean;
  errorMessage: string | null;
  onCreateNew: () => void;
  onMerge: (targetWorkflowId: string) => void;
  onClose: () => void;
}

/**
 * EN: Asks one product-level question when a generated workflow can improve an existing workflow.
 * 中文: 当生成结果可以完善已有工作流时，只询问“独立保留或合并”这一项产品决策。
 * @param props pending decision, language and user actions.
 * @returns focused two-step modal without graph or diff review.
 */
export function WorkflowMergeDecisionDialog({
  language,
  decision,
  isSubmitting,
  errorMessage,
  onCreateNew,
  onMerge,
  onClose,
}: WorkflowMergeDecisionDialogProps) {
  const [selectingTarget, setSelectingTarget] = useState(false);
  const [selectedTargetId, setSelectedTargetId] = useState(
    decision.recommendedTargetWorkflowId,
  );
  const isChinese = language === "zh";
  const selectedTarget = decision.targets.find(
    (target) => target.workflowId === selectedTargetId,
  );

  const chooseMerge = () => {
    if (decision.targets.length === 1) {
      onMerge(decision.targets[0].workflowId);
      return;
    }
    setSelectingTarget(true);
  };

  return (
    <div
      className="modal-layer workflow-merge-decision-layer"
      role="dialog"
      aria-modal="true"
      aria-labelledby="workflow-merge-decision-title"
    >
      <button
        className="modal-backdrop"
        type="button"
        aria-label={isChinese ? "稍后处理" : "Decide later"}
        onClick={onClose}
        disabled={isSubmitting}
      />
      <section className="workflow-merge-decision-dialog">
        <header>
          <div className="workflow-merge-decision-mark" aria-hidden="true">
            ↗
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label={isChinese ? "稍后处理" : "Decide later"}
            onClick={onClose}
            disabled={isSubmitting}
          >
            ×
          </button>
        </header>

        {selectingTarget ? (
          <>
            <div className="workflow-merge-decision-copy">
              <h2 id="workflow-merge-decision-title">
                {isChinese ? "选择要合并到的工作流" : "Choose where to merge"}
              </h2>
              <p>
                {isChinese
                  ? "这次录制会成为所选工作流的新版本。"
                  : "This recording will become a new version of the selected workflow."}
              </p>
            </div>
            <div
              className="workflow-merge-target-list"
              role="radiogroup"
              aria-label={isChinese ? "可合并的工作流" : "Eligible workflows"}
            >
              {decision.targets.map((target) => (
                <label
                  key={target.workflowId}
                  className={
                    target.workflowId === selectedTargetId ? "is-selected" : ""
                  }
                >
                  <input
                    type="radio"
                    name="workflow-merge-target"
                    value={target.workflowId}
                    checked={target.workflowId === selectedTargetId}
                    onChange={() => setSelectedTargetId(target.workflowId)}
                  />
                  <span>
                    <strong>{target.title}</strong>
                    <small>{target.description}</small>
                  </span>
                  <em>
                    {isChinese
                      ? `版本 ${target.revisionNumber}`
                      : `Version ${target.revisionNumber}`}
                  </em>
                </label>
              ))}
            </div>
            {errorMessage ? (
              <p className="inline-error" role="alert">
                {errorMessage}
              </p>
            ) : null}
            <div className="workflow-merge-decision-actions is-confirming">
              <button
                className="ghost-button"
                type="button"
                onClick={() => setSelectingTarget(false)}
                disabled={isSubmitting}
              >
                {isChinese ? "返回" : "Back"}
              </button>
              <button
                className="primary-button"
                type="button"
                onClick={() =>
                  selectedTarget && onMerge(selectedTarget.workflowId)
                }
                disabled={isSubmitting || !selectedTarget}
              >
                {isSubmitting
                  ? isChinese
                    ? "正在合并…"
                    : "Merging…"
                  : isChinese
                    ? "确认合并"
                    : "Merge workflow"}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="workflow-merge-decision-copy">
              <p className="section-kicker">
                {isChinese ? "发现相似工作流" : "Similar workflow found"}
              </p>
              <h2 id="workflow-merge-decision-title">
                {isChinese
                  ? "这次录制要独立保留，还是完善已有工作流？"
                  : "Keep this recording separate or improve an existing workflow?"}
              </h2>
              <p>
                <strong>{decision.sourceTitle}</strong>
                {isChinese
                  ? " 可以合并到已有工作流。你只需要选择归类方式。"
                  : " can be merged into an existing workflow. Choose how to file it."}
              </p>
            </div>
            {decision.targets.length === 1 ? (
              <div className="workflow-merge-recommendation">
                <span>{isChinese ? "可合并到" : "Can merge into"}</span>
                <strong>{decision.targets[0].title}</strong>
                <small>{decision.targets[0].description}</small>
              </div>
            ) : null}
            {errorMessage ? (
              <p className="inline-error" role="alert">
                {errorMessage}
              </p>
            ) : null}
            <div className="workflow-merge-decision-actions">
              <button
                className="workflow-decision-option"
                type="button"
                onClick={onCreateNew}
                disabled={isSubmitting}
              >
                <span aria-hidden="true">＋</span>
                <strong>
                  {isChinese ? "保留为独立工作流" : "Keep as separate workflow"}
                </strong>
                <small>
                  {isChinese
                    ? "保留为一张独立卡片"
                    : "Keep it as a separate workflow"}
                </small>
              </button>
              <button
                className="workflow-decision-option is-primary"
                type="button"
                onClick={chooseMerge}
                disabled={isSubmitting}
              >
                <span aria-hidden="true">↗</span>
                <strong>
                  {isSubmitting
                    ? isChinese
                      ? "正在合并…"
                      : "Merging…"
                    : isChinese
                      ? "合并工作流"
                      : "Merge workflow"}
                </strong>
                <small>
                  {decision.targets.length > 1
                    ? isChinese
                      ? "下一步选择目标工作流"
                      : "Choose the target next"
                    : isChinese
                      ? "更新已有工作流并保留版本"
                      : "Update it and keep version history"}
                </small>
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
