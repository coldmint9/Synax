import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SessionListHeader } from "../SessionListHeader";
import { useShellStore } from "../../../shared/state/shellStore";

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
      preferences: {
        ...state.preferences,
        locale: "zh",
        sessionListDisplayMode: "preview",
      },
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
    expect(screen.getAllByRole("button")).toHaveLength(4);
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

  it("switches and persists the two session row display modes", () => {
    renderHeader();

    const titles = screen.getByRole("button", { name: "仅标题" });
    const previews = screen.getByRole("button", { name: "标题与摘要" });
    expect(previews).toHaveAttribute("aria-pressed", "true");
    expect(titles).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(titles);

    expect(titles).toHaveAttribute("aria-pressed", "true");
    expect(previews).toHaveAttribute("aria-pressed", "false");
    expect(useShellStore.getState().preferences.sessionListDisplayMode).toBe(
      "title",
    );
    expect(
      JSON.parse(localStorage.getItem("rumbling-shell-preferences")!).sessionListDisplayMode,
    ).toBe("title");
  });

  it("toggles between the session list and workspace tree views", () => {
    const onChange = vi.fn();
    renderHeader({
      sidebarView: "sessions",
      onSidebarViewChange: onChange,
    });

    const toggle = screen.getByRole("button", { name: "切换到工作区目录树" });
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith("workspace");
  });
});

it('keeps the same collapse element when switching sidebar content', () => {
  const onCollapsePanel = vi.fn();
  const base = { listView: 'sessions' as const, workflowCount: 0, searchQuery: '', onSearchChange: noop,
    onClearInactive: noop, onCollapsePanel, onSidebarViewChange: vi.fn() };
  const view = render(<SessionListHeader {...base} sidebarView="sessions" />);
  const collapse = screen.getByRole('button', { name: '收起侧栏' });
  view.rerender(<SessionListHeader {...base} sidebarView="workspace" />);
  expect(screen.getByRole('button', { name: '收起侧栏' })).toBe(collapse);
  expect(screen.queryByRole('button', { name: /刷新/ })).toBeNull();
  expect(screen.queryByRole('textbox')).toBeNull();
  fireEvent.click(collapse);
  expect(onCollapsePanel).toHaveBeenCalledOnce();
});
