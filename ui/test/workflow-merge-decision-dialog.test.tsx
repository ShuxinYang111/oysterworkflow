import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WorkflowMergeDecisionDialog } from "../src/workflow-merge-decision-dialog";
import type { ProductPendingWorkflowMerge } from "../../src/product/contracts.js";

describe("WorkflowMergeDecisionDialog", () => {
  it("offers only create or merge and applies the single eligible target directly", () => {
    const onCreateNew = vi.fn();
    const onMerge = vi.fn();
    render(
      <WorkflowMergeDecisionDialog
        language="zh"
        decision={buildDecision(1)}
        isSubmitting={false}
        errorMessage={null}
        onCreateNew={onCreateNew}
        onMerge={onMerge}
        onClose={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: /保留为独立工作流/u }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: /合并工作流/u })).toBeVisible();
    expect(screen.queryByText("Canonical")).not.toBeInTheDocument();
    expect(screen.queryByText("New case")).not.toBeInTheDocument();
    expect(screen.queryByText("Merge proposal")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /合并工作流/u }));
    expect(onMerge).toHaveBeenCalledWith("workflow.target-1");
    expect(onCreateNew).not.toHaveBeenCalled();
  });

  it("adds a target selection step only when multiple workflows are eligible", () => {
    const onMerge = vi.fn();
    render(
      <WorkflowMergeDecisionDialog
        language="en"
        decision={buildDecision(2)}
        isSubmitting={false}
        errorMessage={null}
        onCreateNew={vi.fn()}
        onMerge={onMerge}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Merge workflow/u }));
    expect(screen.getByText("Choose where to merge")).toBeVisible();
    fireEvent.click(screen.getByRole("radio", { name: /Target 2/u }));
    fireEvent.click(screen.getByRole("button", { name: "Merge workflow" }));

    expect(onMerge).toHaveBeenCalledWith("workflow.target-2");
  });
});

function buildDecision(targetCount: number): ProductPendingWorkflowMerge {
  return {
    sourceWorkflowId: "workflow.source",
    sourceTitle: "Recorded Xiaohongshu publishing flow",
    sourceDescription: "Publish a prepared note.",
    proposalId: "proposal.source",
    proposalHash: "a".repeat(64),
    targets: Array.from({ length: targetCount }, (_, index) => ({
      workflowId: `workflow.target-${index + 1}`,
      title: `Target ${index + 1}`,
      description: `Existing workflow ${index + 1}`,
      revisionNumber: index + 1,
      revisionId: `workflow.family:rev-${index + 1}`,
    })),
    recommendedTargetWorkflowId: "workflow.target-1",
  };
}
