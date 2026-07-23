import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { useRef, useState } from "react";
import { resetModalFocusForTests, useTopmostModal } from "../src/modal-focus";

afterEach(() => {
  resetModalFocusForTests();
});

describe("topmost modal focus", () => {
  it("isolates nested layers, traps focus, closes only the top, and restores openers", async () => {
    const user = userEvent.setup();
    render(<ModalHarness />);

    const outerOpener = screen.getByRole("button", { name: "Open settings" });
    await user.click(outerOpener);
    const outer = screen.getByTestId("outer-dialog");
    await waitFor(() =>
      expect(
        within(outer).getByRole("button", { name: "First" }),
      ).toHaveFocus(),
    );
    expect(outerOpener).toHaveAttribute("inert");

    const nestedOpener = within(outer).getByRole("button", {
      name: "Open connection",
    });
    await user.click(nestedOpener);
    const nested = screen.getByTestId("nested-dialog");
    const nestedFirst = within(nested).getByRole("button", {
      name: "Nested first",
    });
    const nestedLast = within(nested).getByRole("button", {
      name: "Nested last",
    });
    await waitFor(() => expect(nestedFirst).toHaveFocus());

    nestedLast.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(nestedFirst).toHaveFocus();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByTestId("nested-dialog")).not.toBeInTheDocument(),
    );
    expect(nestedOpener).toHaveFocus();
    expect(screen.getByTestId("outer-dialog")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByTestId("outer-dialog")).not.toBeInTheDocument(),
    );
    expect(outerOpener).toHaveFocus();
    expect(outerOpener).not.toHaveAttribute("inert");
  });
});

function ModalHarness() {
  const [outerOpen, setOuterOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOuterOpen(true)}>Open settings</button>
      <div>Background content</div>
      {outerOpen ? <OuterDialog onClose={() => setOuterOpen(false)} /> : null}
    </>
  );
}

function OuterDialog({ onClose }: { onClose: () => void }) {
  const [nestedOpen, setNestedOpen] = useState(false);
  const ref = useRef<HTMLElement>(null);
  useTopmostModal({ open: true, containerRef: ref, onClose });
  return (
    <section ref={ref} role="dialog" data-testid="outer-dialog">
      <button>First</button>
      <button onClick={() => setNestedOpen(true)}>Open connection</button>
      <button>Last</button>
      {nestedOpen ? (
        <NestedDialog onClose={() => setNestedOpen(false)} />
      ) : null}
    </section>
  );
}

function NestedDialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLElement>(null);
  useTopmostModal({ open: true, containerRef: ref, onClose });
  return (
    <section ref={ref} role="dialog" data-testid="nested-dialog">
      <button>Nested first</button>
      <button>Nested last</button>
    </section>
  );
}
