import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MessageActionToolbar } from "../MessageActionToolbar";
import { useShellStore } from "../../../shared/state/shellStore";
import { copyTextToClipboard } from "../../../adapters/electron/clipboard";
vi.mock("../../../adapters/electron/clipboard", () => ({ copyTextToClipboard: vi.fn() }));
beforeEach(() => {
  vi.clearAllMocks();
  useShellStore.setState((s) => ({
    preferences: { ...s.preferences, locale: "en" },
  }));
});
describe("message action toolbar", () => {
  it("copies exact Markdown including fenced code and announces success", async () => {
    vi.mocked(copyTextToClipboard).mockResolvedValue(true);
    const text = "Answer\n\n```ts\nconst x = 1;\n```";
    render(<MessageActionToolbar role="assistant" text={text} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(copyTextToClipboard).toHaveBeenCalledWith(text));
    expect(
      await screen.findByRole("button", { name: "Copied" }),
    ).toBeInTheDocument();
  });
  it("reports clipboard failures without showing a success state", async () => {
    vi.mocked(copyTextToClipboard).mockResolvedValue(false);
    render(<MessageActionToolbar role="user" text="hello" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(
      await screen.findByText("Copy failed. Select the text manually."),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Copied" }),
    ).not.toBeInTheDocument();
  });
  it("keeps destructive controls inert while providing discoverable reasons", () => {
    const onRollback = vi.fn(),
      onFork = vi.fn();
    render(
      <MessageActionToolbar
        role="assistant"
        text="reply"
        disabledReason="Stop first"
        onRollback={onRollback}
        onFork={onFork}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Roll back to here" }));
    fireEvent.click(screen.getByRole("button", { name: "Fork from here" }));
    expect(onRollback).not.toHaveBeenCalled();
    expect(onFork).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Roll back to here" }),
    ).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "Copy" })).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });
  it("allows fork independently when rollback needs the running session to stop", async () => {
    const onFork = vi.fn();
    const onRollback = vi.fn();
    render(
      <MessageActionToolbar
        role="assistant"
        text="completed reply"
        disabledReason="Stop first"
        forkDisabledReason={null}
        onFork={onFork}
        onRollback={onRollback}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Roll back to here" }));
    fireEvent.click(screen.getByRole("button", { name: "Fork from here" }));
    expect(onFork).not.toHaveBeenCalled();
    expect(await screen.findAllByRole("menuitem")).toHaveLength(2);
    fireEvent.click(screen.getByRole("menuitem", { name: "In a new worktree" }));
    expect(onFork).toHaveBeenCalledExactlyOnceWith("new_worktree");
    expect(onRollback).not.toHaveBeenCalled();
  });
  it("dismisses the two-option pop with Escape without executing a fork", async () => {
    const onFork = vi.fn();
    render(<MessageActionToolbar role="assistant" text="reply" onFork={onFork} />);
    const trigger = screen.getByRole("button", { name: "Fork from here" });
    fireEvent.click(trigger);
    const menu = await screen.findByRole("menu");
    expect(menu.textContent).toBe("In a new worktreeIn the original workspace");
    expect(menu.querySelector('[data-glass-finish="flat"]')).not.toBeNull();
    expect(menu.querySelector('svg.liquid-glass-svg, canvas')).toBeNull();
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    expect(onFork).not.toHaveBeenCalled();
    await waitFor(() => expect(trigger).toHaveFocus());
  });
  it("shows exactly the actions appropriate for each role", () => {
    const onEdit = vi.fn();
    render(<MessageActionToolbar role="user" text="hello" onEdit={onEdit} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit message" }));
    expect(onEdit).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole("button", { name: "Fork from here" }),
    ).not.toBeInTheDocument();
  });
});
