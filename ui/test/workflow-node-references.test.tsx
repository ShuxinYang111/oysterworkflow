import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WorkflowNodeReferences } from "../src/workflow-node-references";

describe("WorkflowNodeReferences", () => {
  it("renders only the node-bound Reference values", () => {
    render(
      <WorkflowNodeReferences
        language="en"
        references={[
          {
            id: "reference:skill-1:candidate-profile",
            name: "Candidate profile",
            value: "https://example.com/candidate/42",
            notes: "Compare location and recent activity.",
          },
        ]}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "References" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /example\.com/i })).toHaveAttribute(
      "href",
      "https://example.com/candidate/42",
    );
    expect(
      screen.getByText("Compare location and recent activity."),
    ).toBeInTheDocument();
  });

  it("renders nothing when the selected node has no References", () => {
    const { container } = render(
      <WorkflowNodeReferences language="zh" references={[]} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
