import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowVersionHistoryDialog } from "../src/workflow-version-history-dialog";

const runtimeMock = vi.hoisted(() => ({
  fetchProductWorkflowVersions: vi.fn(),
  restoreProductWorkflowVersion: vi.fn(),
}));

vi.mock("../src/product-runtime", () => runtimeMock);

describe("WorkflowVersionHistoryDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtimeMock.fetchProductWorkflowVersions.mockResolvedValue({
      workflowId: "workflow.target",
      workflowTitle: "Publish Xiaohongshu note",
      currentRevisionId: "revision-2",
      versions: [
        {
          revisionId: "revision-2",
          revisionNumber: 2,
          previousRevisionId: "revision-1",
          createdAt: "2026-07-21T12:00:00.000Z",
          contentHash: "b".repeat(64),
          isCurrent: true,
        },
        {
          revisionId: "revision-1",
          revisionNumber: 1,
          previousRevisionId: null,
          createdAt: "2026-07-20T12:00:00.000Z",
          contentHash: "a".repeat(64),
          isCurrent: false,
        },
      ],
    });
    runtimeMock.restoreProductWorkflowVersion.mockResolvedValue({
      state: { workflows: [] },
      workflowId: "workflow.target",
      restoredFromRevisionId: "revision-1",
      canonicalGraph: {},
      graphPath: "/runs/target/workflow.json",
    });
  });

  it("restores a historical version without showing a diff", async () => {
    const onRestored = vi.fn();
    render(
      <WorkflowVersionHistoryDialog
        language="zh"
        workflowId="workflow.target"
        workflowTitle="发布小红书笔记"
        onRestored={onRestored}
        onClose={vi.fn()}
      />,
    );

    expect(await screen.findByText("版本 2")).toBeVisible();
    expect(screen.getByText("当前版本")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "恢复此版本" }));

    await waitFor(() =>
      expect(runtimeMock.restoreProductWorkflowVersion).toHaveBeenCalledWith(
        "workflow.target",
        "revision-1",
      ),
    );
    expect(onRestored).toHaveBeenCalledWith(
      { workflows: [] },
      "workflow.target",
    );
    expect(screen.queryByText(/diff/iu)).not.toBeInTheDocument();
  });
});
