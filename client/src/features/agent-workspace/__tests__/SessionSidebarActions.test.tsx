import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SessionSidebarActions } from "../SessionSidebarActions";
import { useShellStore } from "../../../shared/state/shellStore";

const noop = () => {};

function renderActions(
  props: Partial<React.ComponentProps<typeof SessionSidebarActions>> = {},
) {
  return render(
    <SessionSidebarActions
      collapsed={false}
      onTogglePanel={noop}
      sidebarView="sessions"
      onNewSession={noop}
      onClearInactive={noop}
      archiving={false}
      {...props}
    />,
  );
}

beforeEach(() => {
  useShellStore.setState((state) => ({
    preferences: { ...state.preferences, locale: "zh" },
  }));
});

it("offers the sidebar view as an icon button", () => {
  const onSidebarViewChange = vi.fn();
  renderActions({ onSidebarViewChange });

  const viewButton = screen.getByRole("button", { name: "切换到工作区目录树" });
  expect(viewButton).toHaveAttribute("aria-pressed", "false");
  expect(viewButton).toHaveClass("wh-view-btn");
  expect(screen.queryByText("目录树")).toBeNull();

  fireEvent.click(viewButton);
  expect(onSidebarViewChange).toHaveBeenCalledWith("workspace");
});

it("shows the tree view as switched on while keeping every action visible", () => {
  const onSidebarViewChange = vi.fn();
  renderActions({ sidebarView: "workspace", onSidebarViewChange });

  const viewButton = screen.getByRole("button", { name: "切换到会话列表" });
  expect(viewButton).toHaveAttribute("aria-pressed", "true");
  expect(viewButton).toHaveClass("wh-view-btn");
  expect(screen.getByRole("button", { name: "新对话" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "归档不活跃会话" })).toBeInTheDocument();

  fireEvent.click(viewButton);
  expect(onSidebarViewChange).toHaveBeenCalledWith("sessions");
});
