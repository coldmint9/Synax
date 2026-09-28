import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ComposerEffortPicker, type ComposerReasoningEffort } from "../ComposerEffortPicker";

vi.mock("../../../../../hooks/useLocale", () => ({ useLocale: () => ({ t: (key: string) => key }) }));

describe("Headless effort choices", () => {
  it("uses arrow-key radio selection, stays open for adjustments, resets and restores focus on Escape", async () => {
    const user = userEvent.setup();
    const overlay = vi.fn();
    function Example() {
      const [effort, setEffort] = useState<ComposerReasoningEffort>("low");
      return <ComposerEffortPicker effort={effort} allowed={["low", "high", "max"]} onChange={setEffort} onOverlayOpenChange={overlay} modelLabel="Native model" />;
    }
    const { container } = render(<Example />);
    const trigger = screen.getByRole("button", { name: "effortLabel" });
    await user.click(trigger);
    const group = screen.getByRole("radiogroup", { name: "effortLabel" });
    expect(container).not.toContainElement(group);
    expect(screen.getByText("Native model")).toBeVisible();
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(3);
    await user.click(radios[0]);
    await user.keyboard("{ArrowRight}");
    expect(radios[1]).toBeChecked();
    expect(radios[1]).toHaveFocus();
    expect(trigger).toHaveTextContent("high");
    expect(group).toBeVisible();
    await user.keyboard("{ArrowRight}");
    expect(trigger).toHaveTextContent("max");
    await user.click(screen.getByRole("button", { name: "effortResetAria" }));
    expect(trigger).toHaveTextContent("high");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(group).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
    expect(overlay.mock.calls).toEqual([[false], [true], [false]]);
  });

  it("normalizes an unsupported level only while open and closes when disabled", async () => {
    const user = userEvent.setup(), change = vi.fn(), overlay = vi.fn();
    const view = render(<ComposerEffortPicker effort="max" allowed={["low", "medium"]} onChange={change} onOverlayOpenChange={overlay} />);
    expect(change).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "effortLabel" }));
    expect(change).toHaveBeenCalledExactlyOnceWith("low");
    view.rerender(<ComposerEffortPicker effort="max" allowed={["low", "medium"]} onChange={change} onOverlayOpenChange={overlay} disabled />);
    await waitFor(() => expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "effortLabel" })).toBeDisabled();
    expect(overlay).toHaveBeenLastCalledWith(false);
  });
});
