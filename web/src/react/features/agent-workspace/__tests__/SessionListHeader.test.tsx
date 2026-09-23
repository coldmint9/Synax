import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SessionListHeader } from "../SessionListHeader";
import { useShellStore } from "../../../state/shellStore";

const noop = () => {};

function renderHeader(
  props: Partial<React.ComponentProps<typeof SessionListHeader>> = {},
) {
  return render(
    <SessionListHeader
      listView="sessions"
      workflowCount={0}
      searchQuery=""
      onSearchChange={noop}
      onClearInactive={noop}
      onNewSession={noop}
      {...props}
    />,
  );
}

describe("SessionListHeader", () => {
  beforeEach(() => {
    useShellStore.setState((state) => ({
      preferences: { ...state.preferences, locale: "zh" },
    }));
  });

  it("removes the redundant task heading", () => {
    const { container } = renderHeader();

    expect(screen.queryByText("任务", { exact: true })).toBeNull();
    expect(container.textContent).not.toMatch(/\(\d+\)/);
  });

  it("renders the new-chat button with a leading icon and no manual refresh", () => {
    const onNewSession = vi.fn();
    renderHeader({ onNewSession });

    const newChat = screen.getByRole("button", { name: "新对话" });
    expect(newChat.firstElementChild?.tagName.toLowerCase()).toBe("svg");
    expect(newChat.querySelector(".lucide-square-pen")).toBeTruthy();
    expect(newChat.className).toContain("text-foreground");
    expect(newChat.className).not.toContain("text-primary");
    fireEvent.click(newChat);
    expect(onNewSession).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: /refresh|刷新/i })).toBeNull();
    // Only "新对话" and the clear-inactive action remain in the header actions.
    expect(screen.getAllByRole("button")).toHaveLength(2);
  });
  it("disables new-chat while creating a session", () => {
    const onNewSession = vi.fn();
    renderHeader({ onNewSession, isCreatingSession: true });
    const newChat = screen.getByRole("button", { name: "新对话" });
    expect(newChat).toBeDisabled();
    fireEvent.click(newChat);
    expect(onNewSession).not.toHaveBeenCalled();
  });

  it("uses the localized new-chat label in English", () => {
    useShellStore.setState((state) => ({
      preferences: { ...state.preferences, locale: "en" },
    }));
    renderHeader();
    expect(screen.getByRole("button", { name: "New chat" })).toBeTruthy();
  });

  it("never uses pagination as proof that a Wiki exists", () => {
    renderHeader({
      workflowCount: 0,
      hasMoreSessions: true,
      onOpenWorkflows: noop,
    });
    expect(screen.queryByRole("button", { name: /Workflow/ })).toBeNull();
  });

  it("shows workflows only after the current project has generated Wiki content", () => {
    renderHeader({
      hasGeneratedWiki: true,
      workflowCount: 0,
      onOpenWorkflows: noop,
    });
    expect(screen.getByRole("button", { name: /Workflow/ })).toBeTruthy();
  });
});
