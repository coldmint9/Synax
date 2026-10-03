import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ComposerEffortPicker, type ComposerReasoningEffort } from "../ComposerEffortPicker";

vi.mock("../../../../shared/hooks/useLocale", () => ({ useLocale: () => ({ t: (key: string) => key }) }));

describe("Headless effort choices", () => {
  it("sorts and deduplicates allowed levels while retaining the selected semantic value", async () => {
    const user = userEvent.setup();
    const change = vi.fn();
    const view = render(<ComposerEffortPicker effort="medium" allowed={["high", "low", "medium", "high"]} onChange={change} />);
    await user.click(screen.getByRole("button", { name: "effortLabel" }));
    const slider = screen.getByRole("slider");
    expect(slider).toHaveAttribute("max", "2");
    expect(slider).toHaveValue("1");
    expect(slider).toHaveAttribute("aria-valuetext", "medium (中)");
    view.rerender(<ComposerEffortPicker effort="medium" allowed={["medium", "high", "low"]} onChange={change} />);
    expect(slider).toHaveValue("1");
    expect(change).not.toHaveBeenCalled();
    fireEvent.change(slider, { target: { value: "0" } });
    expect(change).toHaveBeenLastCalledWith("low");
    fireEvent.change(slider, { target: { value: "2" } });
    expect(change).toHaveBeenLastCalledWith("high");
  });
  it("focuses the native slider, stays open for adjustments and restores focus on Escape", async () => {
    const user = userEvent.setup();
    const overlay = vi.fn();
    function Example() {
      const [effort, setEffort] = useState<ComposerReasoningEffort>("low");
      return <ComposerEffortPicker effort={effort} allowed={["low", "high", "max"]} onChange={setEffort} onOverlayOpenChange={overlay} modelLabel="Native model" />;
    }
    const { container } = render(<Example />);
    const trigger = screen.getByRole("button", { name: "effortLabel" });
    await user.click(trigger);
    const slider = screen.getByRole("slider", { name: "effortLabel" });
    expect(container).not.toContainElement(slider);
    expect(screen.queryByText("Native model")).not.toBeInTheDocument();
    expect(slider).toHaveAttribute("type", "range");
    expect(slider).toHaveAttribute("step", "1");
    expect(slider).toHaveFocus();
    fireEvent.change(slider, { target: { value: "1" } });
    expect(trigger).toHaveTextContent("high");
    expect(slider).toBeVisible();
    fireEvent.change(slider, { target: { value: "2" } });
    expect(trigger).toHaveTextContent("max");
    expect(screen.queryByRole("button", { name: "effortResetAria" })).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(slider).not.toBeInTheDocument());
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
    await waitFor(() => expect(screen.queryByRole("slider")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "effortLabel" })).toBeDisabled();
    expect(overlay).toHaveBeenLastCalledWith(false);
  });
});
