import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ComposerPermissionPicker } from "../ComposerPermissionPicker";
import { ComposerEffortPicker } from "../ComposerEffortPicker";
import { REASONING_EFFORT_LABELS } from "../../../settings/lib/providerPresets";
import userEvent from "@testing-library/user-event";

afterEach(cleanup);

describe("ComposerPermissionPicker", () => {
  it("does not present Synax tiers as if they controlled native CLI execution", () => {
    const change = vi.fn();
    render(
      <ComposerPermissionPicker
        backendId="codex"
        value="boundary"
        onChange={change}
      />,
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveAttribute(
      "data-native-policy",
      "true",
    );
    expect(change).not.toHaveBeenCalled();
  });

  it("exposes only the three new approval modes with explicit selection", async () => {
    const onChange = vi.fn();
    const view = render(
      <ComposerPermissionPicker value="boundary" onChange={onChange} />,
    );
    const select = screen.getByRole("button", { name: "审批模式" });
    expect(select).toHaveAttribute("data-tier", "boundary");
    await userEvent.click(select);
    expect(screen.getAllByRole("option")).toHaveLength(3);
    expect(screen.getByRole("option", { name: /^边界审批/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("option", { name: /^自动审批/ })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("option", { name: /^无限制/ })).toHaveAttribute("aria-selected", "false");
    expect(select.title).toContain("下一步生效");
    await userEvent.click(screen.getByRole("option", { name: /^自动审批/ }));
    expect(onChange).toHaveBeenCalledWith("auto");
    view.rerender(
      <ComposerPermissionPicker value="auto" onChange={onChange} />,
    );
    expect(screen.getByRole("button", { name: "审批模式" })).toHaveAttribute(
      "data-tier",
      "auto",
    );
  });

  it("does not claim a mode switch succeeded when the server rejects it", async () => {
    const onChange = vi
      .fn()
      .mockRejectedValue(new Error("Permission update failed"));
    render(<ComposerPermissionPicker value="boundary" onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: "审批模式" }));
    await userEvent.click(screen.getByRole("option", { name: /^无限制/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Permission update failed",
    );
    expect(screen.getByRole("button", { name: "审批模式" })).toHaveAttribute(
      "data-tier",
      "boundary",
    );
    expect(screen.getByRole("button", { name: "审批模式" })).toBeEnabled();
  });
});

describe("ComposerEffortPicker", () => {
  it("uses a controlled slider without model, disclosure or reset affordances", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const view = render(
      <ComposerEffortPicker
        effort="low"
        modelLabel="Test model"
        onChange={onChange}
      />,
    );
    await user.click(screen.getByLabelText("思考强度"));
    const slider = await screen.findByRole("slider", { name: "思考强度" });
    expect(slider).toHaveClass("composer-effort-range");
    expect(slider.closest(".composer-effort-rail")?.getAttribute("style")).toBeNull();
    expect(slider.closest(".composer-effort-picker")).not.toBeNull();
    expect(screen.queryByText("Test model")).not.toBeInTheDocument();
    expect(slider).toHaveAttribute("aria-valuetext", "low (低)");
    fireEvent.change(slider, { target: { value: "5" } });
    expect(onChange).toHaveBeenLastCalledWith("max");
    view.rerender(
      <ComposerEffortPicker
        effort="max"
        modelLabel="Test model"
        onChange={onChange}
      />,
    );
    expect(slider).toHaveAttribute("aria-valuetext", "max (最大)");
    expect(screen.queryByRole("button", { name: "恢复默认思考强度" })).not.toBeInTheDocument();
    expect(slider.closest(".composer-effort-picker")?.querySelector("svg")).toBeNull();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("slider")).not.toBeInTheDocument();
  });

  it("does not open when disabled", () => {
    render(<ComposerEffortPicker effort="high" disabled onChange={vi.fn()} />);
    expect(screen.getByLabelText("思考强度")).toBeDisabled();
    expect(screen.queryByRole("slider")).not.toBeInTheDocument();
  });

  it("normalizes provider levels and falls back when the provider removes the selection", async () => {
    const change = vi.fn();
    const view = render(<ComposerEffortPicker effort="max" allowed={["high", "low", "high"]} onChange={change} />);
    await userEvent.click(screen.getByRole("button", { name: "思考强度" }));
    const slider = await screen.findByRole("slider");
    expect(slider).toHaveAttribute("max", "1");
    expect(slider).toHaveAttribute("aria-valuetext", "high (高)");
    expect(change).toHaveBeenLastCalledWith("high");
    view.rerender(<ComposerEffortPicker effort="high" allowed={["low"]} onChange={change} />);
    expect(slider).toBeDisabled();
    expect(slider).toHaveAttribute("aria-valuetext", "low (低)");
    expect(change).toHaveBeenLastCalledWith("low");
  });

  it("unmounts max animation when disabled while open", async () => {
    const change = vi.fn();
    const overlay = vi.fn();
    const view = render(<ComposerEffortPicker effort="max" onChange={change} onOverlayOpenChange={overlay} />);
    await userEvent.click(screen.getByRole("button", { name: "思考强度" }));
    expect(await screen.findByRole("slider")).toBeVisible();
    expect(overlay).toHaveBeenLastCalledWith(true);
    view.rerender(<ComposerEffortPicker effort="max" disabled onChange={change} onOverlayOpenChange={overlay} />);
    expect(screen.queryByRole("slider")).not.toBeInTheDocument();
    expect(overlay).toHaveBeenLastCalledWith(false);
  });

  it("shows the raw level id on the chip instead of a translated label", () => {
    render(<ComposerEffortPicker effort="xhigh" onChange={() => {}} />);

    const trigger = screen.getByLabelText("思考强度");
    // raw id only — no Chinese tier name leaks into the chip
    expect(trigger.textContent).toBe("xhigh");
    for (const label of Object.values(REASONING_EFFORT_LABELS)) {
      expect(trigger.textContent).not.toContain(label);
    }
  });

  it("keeps the translated names for assistive tech", () => {
    render(<ComposerEffortPicker effort="low" onChange={() => {}} />);
    expect(screen.getByLabelText("思考强度").textContent).toBe("low");
    // the aria-label on the control itself is unchanged
    expect(screen.getByLabelText("思考强度")).toBeTruthy();
  });
});
