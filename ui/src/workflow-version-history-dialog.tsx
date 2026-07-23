import { useEffect, useState } from "react";
import type { AppLanguage } from "./app-language";
import {
  fetchProductWorkflowVersions,
  restoreProductWorkflowVersion,
} from "./product-runtime";
import type {
  ProductState,
  ProductWorkflowVersionsResponse,
} from "../../src/product/contracts.js";

interface WorkflowVersionHistoryDialogProps {
  language: AppLanguage;
  workflowId: string;
  workflowTitle: string;
  onRestored: (state: ProductState, workflowId: string) => void;
  onClose: () => void;
}

/**
 * EN: Shows immutable workflow versions and restores one with a single explicit action.
 * 中文: 展示不可变工作流版本，并通过一次明确操作恢复历史版本。
 * @param props workflow identity, language and completion callbacks.
 * @returns focused version history modal.
 */
export function WorkflowVersionHistoryDialog({
  language,
  workflowId,
  workflowTitle,
  onRestored,
  onClose,
}: WorkflowVersionHistoryDialogProps) {
  const [history, setHistory] =
    useState<ProductWorkflowVersionsResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [restoringRevisionId, setRestoringRevisionId] = useState<string | null>(
    null,
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const isChinese = language === "zh";

  const loadHistory = async () => {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      setHistory(await fetchProductWorkflowVersions(workflowId));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadHistory();
  }, [workflowId]);

  const restore = async (revisionId: string) => {
    setRestoringRevisionId(revisionId);
    setErrorMessage(null);
    try {
      const response = await restoreProductWorkflowVersion(
        workflowId,
        revisionId,
      );
      onRestored(response.state, workflowId);
      setHistory(await fetchProductWorkflowVersions(workflowId));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setRestoringRevisionId(null);
    }
  };

  return (
    <div
      className="modal-layer workflow-version-layer"
      role="dialog"
      aria-modal="true"
      aria-labelledby="workflow-version-title"
    >
      <button
        className="modal-backdrop"
        type="button"
        aria-label={isChinese ? "关闭版本历史" : "Close version history"}
        onClick={onClose}
        disabled={restoringRevisionId !== null}
      />
      <section className="workflow-version-dialog">
        <header className="modal-header">
          <div>
            <p className="section-kicker">
              {isChinese ? "版本历史" : "Version history"}
            </p>
            <h2 id="workflow-version-title">{workflowTitle}</h2>
            <span>
              {isChinese
                ? "恢复会创建一个新版本，现有历史不会被覆盖。"
                : "Restoring creates a new version without overwriting history."}
            </span>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label={isChinese ? "关闭" : "Close"}
            onClick={onClose}
            disabled={restoringRevisionId !== null}
          >
            ×
          </button>
        </header>

        <div className="workflow-version-body">
          {isLoading ? (
            <div className="workflow-version-state" role="status">
              {isChinese ? "正在读取版本…" : "Loading versions…"}
            </div>
          ) : errorMessage && !history ? (
            <div className="workflow-version-state is-error" role="alert">
              <p>{errorMessage}</p>
              <button
                className="ghost-button"
                type="button"
                onClick={() => void loadHistory()}
              >
                {isChinese ? "重试" : "Retry"}
              </button>
            </div>
          ) : (
            <ol className="workflow-version-list">
              {history?.versions.map((version) => (
                <li key={version.revisionId}>
                  <div className="workflow-version-index">
                    <span>{version.revisionNumber}</span>
                  </div>
                  <div className="workflow-version-copy">
                    <div>
                      <strong>
                        {isChinese
                          ? `版本 ${version.revisionNumber}`
                          : `Version ${version.revisionNumber}`}
                      </strong>
                      {version.isCurrent ? (
                        <em>{isChinese ? "当前版本" : "Current"}</em>
                      ) : null}
                    </div>
                    <small>
                      {formatVersionDate(version.createdAt, language)}
                    </small>
                    <code>{version.contentHash.slice(0, 12)}</code>
                  </div>
                  {version.isCurrent ? (
                    <span
                      className="workflow-version-current-check"
                      aria-hidden="true"
                    >
                      ✓
                    </span>
                  ) : (
                    <button
                      className="ghost-button compact"
                      type="button"
                      disabled={restoringRevisionId !== null}
                      onClick={() => void restore(version.revisionId)}
                    >
                      {restoringRevisionId === version.revisionId
                        ? isChinese
                          ? "正在恢复…"
                          : "Restoring…"
                        : isChinese
                          ? "恢复此版本"
                          : "Restore"}
                    </button>
                  )}
                </li>
              ))}
            </ol>
          )}
          {errorMessage && history ? (
            <p className="inline-error" role="alert">
              {errorMessage}
            </p>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function formatVersionDate(value: string, language: AppLanguage): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}
