import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ComposerPermissionPicker } from "../ComposerPermissionPicker";

vi.mock("../../../../../hooks/useLocale", () => ({
  useLocale: () => ({
    locale: "zh",
    t: (key: string) =>
      ({
        agentPermTierBoundary: "边界审批",
        agentPermTierAuto: "自动审批",
        agentPermTierUnrestricted: "无限制",
        agentPermTierBoundaryDesc: "边界操作需审批",
        agentPermTierAutoDesc: "自动处理审批",
        agentPermTierUnrestrictedDesc: "跳过全部审批",
      })[key] ?? key,
  }),
}));

describe("permission dropdown", () => {
  it("opens the themed list with descriptions and selected state, then changes tier", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { container } = render(
      <ComposerPermissionPicker value="boundary" onChange={onChange} />,
    );
    expect(container.querySelector("select")).toBeNull();
    await user.click(screen.getByRole("button", { name: "审批模式" }));
    expect(screen.getByRole("option", { name: /^边界审批/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByText("跳过全部审批")).toBeVisible();
    await user.click(screen.getByRole("option", { name: /^自动审批/ }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith("auto");
    await waitFor(() =>
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument(),
    );
  });

  it("supports keyboard selection and Escape without changing the tier", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ComposerPermissionPicker value="boundary" onChange={onChange} />);
    const trigger = screen.getByRole("button", { name: "审批模式" });
    trigger.focus();
    await user.keyboard("{Enter}");
    await user.keyboard("{Escape}");
    expect(onChange).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument(),
    );
    expect(trigger).toHaveFocus();
    await user.keyboard("{Enter}");
    // happy-dom has no layout, so the dialog focus scope cannot find visible options.
    screen.getByRole("option", { name: /^边界审批/ }).focus();
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onChange).toHaveBeenCalledExactlyOnceWith("auto");
  });

  it("disables while saving and displays a rejected update without changing the value", async () => {
    const user = userEvent.setup();
    let reject!: (error: Error) => void;
    const onChange = vi.fn(
      () =>
        new Promise<void>((_, fail) => {
          reject = fail;
        }),
    );
    render(<ComposerPermissionPicker value="boundary" onChange={onChange} />);
    const trigger = screen.getByRole("button", { name: "审批模式" });
    await user.click(trigger);
    await user.click(screen.getByRole("option", { name: /^无限制/ }));
    expect(trigger).toBeDisabled();
    await act(async () => reject(new Error("保存失败")));
    expect(screen.getByRole("alert")).toHaveTextContent("保存失败");
    expect(trigger).not.toBeDisabled();
    expect(trigger).toHaveTextContent("边界审批");
  });

  it("does not open when disabled or submit the already selected mode", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const view = render(
      <ComposerPermissionPicker value="auto" onChange={onChange} disabled />,
    );
    await user.click(screen.getByRole("button", { name: "审批模式" }));
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    view.rerender(
      <ComposerPermissionPicker value="auto" onChange={onChange} />,
    );
    await user.click(screen.getByRole("button", { name: "审批模式" }));
    await user.click(screen.getByRole("option", { name: /^自动审批/ }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("closes an open menu when switching sessions", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const view = render(
      <ComposerPermissionPicker
        sessionId="a"
        value="boundary"
        onChange={onChange}
      />,
    );
    const trigger = screen.getByRole("button", { name: "审批模式" });
    await user.click(trigger);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    view.rerender(
      <ComposerPermissionPicker
        sessionId="b"
        value="auto"
        onChange={onChange}
      />,
    );
    await waitFor(() =>
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "审批模式" })).toBe(trigger);
    expect(trigger).toHaveTextContent("自动审批");
    expect(onChange).not.toHaveBeenCalled();
  });

  it.each(["codex", "claude-code"])(
    "keeps native approval behavior for %s",
    (backendId) => {
      render(
        <ComposerPermissionPicker
          backendId={backendId}
          value="boundary"
          onChange={vi.fn()}
        />,
      );
      expect(screen.getByRole("note")).toHaveTextContent("CLI 原生审批");
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
    },
  );
});
