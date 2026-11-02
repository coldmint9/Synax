import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitBranch } from "lucide-react";
import { useShellStore } from "../../../../shared/state/shellStore";
import { ToolbarBadge } from "../ToolbarBadge";
import { ToolbarMenu } from "../ToolbarMenu";
import { WorkbenchNav } from "../WorkbenchNav";
import { useToolbarBadges } from "../useToolbarBadges";
import type { ToolbarBadgeSource } from "../toolbarBadges";
import type { WorkspaceRepositoryGit } from "../../../../adapters/transport/agentRuntime";

const gitState = vi.hoisted(() => ({
  snapshot: null as unknown,
  listeners: new Set<() => void>(),
}));

vi.mock("../../../../features/agent-workspace/workspaceGitStore", () => ({
  subscribeWorkspaceGit: (listener: () => void) => {
    gitState.listeners.add(listener);
    return () => gitState.listeners.delete(listener);
  },
  getWorkspaceGitSnapshot: () => gitState.snapshot,
  loadWorkspaceGit: async () => null,
}));

function setRepositories(repositories: Partial<WorkspaceRepositoryGit>[]) {
  gitState.snapshot =
    repositories.length > 0
      ? {
          projectId: "p",
          revision: "rev",
          refreshedAt: new Date(0).toISOString(),
          repositories,
        }
      : null;
  for (const listener of gitState.listeners) listener();
}

const queueItems = [
  { id: "open", label: "Open workspace", onSelect: () => {} },
  { id: "manage", label: "Manage workspace", disabled: true },
] as const;

function renderMenu(overrides: Partial<Parameters<typeof ToolbarMenu>[0]> = {}) {
  return render(
    <ToolbarMenu
      label="Workspace actions"
      icon={GitBranch}
      description="2 pending changes"
      items={queueItems}
      {...overrides}
    />,
  );
}

beforeEach(() => {
  gitState.snapshot = null;
  gitState.listeners.clear();
  useShellStore.setState((state) => ({
    preferences: { ...state.preferences, locale: "en" },
  }));
});

describe("workbench toolbar", () => {

  it("derives workspace availability from props", () => {
    const view = render(
      <WorkbenchNav activePanel={null} hasProject={false} projectId={null} onPanelToggle={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "Work" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Git" })).toBeDisabled();
    view.rerender(
      <WorkbenchNav activePanel="sessions" hasProject projectId="p" onPanelToggle={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "Work" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Git" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Kanban" })).not.toBeInTheDocument();
  });

  it("moves focus across switches with arrows, Home and End", async () => {
    const user = userEvent.setup();
    render(
      <WorkbenchNav
        activePanel="sessions"
        hasProject
        projectId="p"
        onPanelToggle={() => {}}
      />,
    );
    const work = screen.getByRole("button", { name: "Work" });
    const git = screen.getByRole("button", { name: "Git" });
    await user.tab();
    expect(work).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(git).toHaveFocus();
    await user.keyboard("{End}");
    expect(git).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(work).toHaveFocus();
    await user.keyboard("{Home}");
    expect(work).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(git).toHaveFocus();
  });

  it("keeps the unpushed count on the Git switch and reveals the time on the badge", async () => {
    const user = userEvent.setup();
    const onPanelToggle = vi.fn();
    render(
      <WorkbenchNav
        activePanel="sessions"
        hasProject
        projectId="p"
        onPanelToggle={onPanelToggle}
      />,
    );
    const git = screen.getByRole("button", { name: "Git" });
    expect(git.querySelector(".wh-tab__badge")).toBeNull();

    setRepositories([
      {
        role: "primary",
        status: "ready",
        revision: "rev-1",
        unpushedCommitCount: 3,
        unpushedSince: "2026-10-31T14:32:00+08:00",
      },
    ]);
    await waitFor(() =>
      expect(git.querySelector(".wh-tab__badge")).toHaveTextContent("3"),
    );
    expect(git).toHaveAccessibleDescription(
      /^3 unpushed commits · oldest /,
    );

    await user.click(git.querySelector(".wh-tab__badge") as HTMLElement);
    expect(onPanelToggle).not.toHaveBeenCalled();
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      /^3 unpushed commits · oldest /,
    );
  });

  it("hides the unpushed badge when the workspace has nothing ahead", async () => {
    render(
      <WorkbenchNav
        activePanel={null}
        hasProject
        projectId="p"
        onPanelToggle={() => {}}
      />,
    );
    setRepositories([{ role: "primary", status: "ready", revision: "rev-0", unpushedCommitCount: 0 }]);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Git" })).not.toHaveAttribute(
        "aria-describedby",
      ),
    );
    expect(screen.getByRole("button", { name: "Git" }).querySelector(".wh-tab__badge")).toBeNull();
  });

  it("describes its trigger without renaming the control", () => {
    renderMenu();
    const trigger = screen.getByRole("button", { name: "Workspace actions" });
    expect(trigger).toHaveAccessibleDescription("2 pending changes");
  });

  it("opens a placeholder panel, runs the enabled row and closes on Escape", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderMenu({
      items: [
        { id: "open", label: "Open workspace", onSelect },
        { id: "manage", label: "Manage workspace", disabled: true },
      ],
    });
    const trigger = screen.getByRole("button", { name: "Workspace actions" });
    await user.click(trigger);
    const menu = await screen.findByRole("menu", { name: "Workspace actions" });
    expect(within(menu).getByRole("menuitem", { name: "Manage workspace" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await user.click(within(menu).getByRole("menuitem", { name: "Open workspace" }));
    expect(onSelect).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());

    await user.click(trigger);
    await screen.findByRole("menu", { name: "Workspace actions" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it("tears down an open panel when the toolbar unmounts", async () => {
    const user = userEvent.setup();
    const view = renderMenu();
    await user.click(screen.getByRole("button", { name: "Workspace actions" }));
    await screen.findByRole("menu", { name: "Workspace actions" });
    view.unmount();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("closes its panel on an outside pointer press", async () => {
    const user = userEvent.setup();
    const view = render(
      <div>
        <button type="button">Outside</button>
        <ToolbarMenu label="Workspace actions" icon={GitBranch} items={queueItems} />
      </div>,
    );
    const outside = view.container.querySelector("button") as HTMLButtonElement;
    await user.click(screen.getByRole("button", { name: "Workspace actions" }));
    await screen.findByRole("menu", { name: "Workspace actions" });
    await user.click(outside);
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
  });

  it("renders badges as decoration, hides empty ones and caps large counts", () => {
    const view = render(<ToolbarBadge count={0} />);
    expect(view.container.firstChild).toBeNull();
    view.rerender(<ToolbarBadge count={3} />);
    expect(view.container.querySelector(".wh-badge")).toHaveTextContent("3");
    expect(view.container.querySelector(".wh-badge")).toHaveAttribute("aria-hidden", "true");
    view.rerender(<ToolbarBadge count={120} />);
    expect(view.container.querySelector(".wh-badge")).toHaveTextContent("99+");
    view.rerender(<ToolbarBadge count={2} tone="attention" />);
    expect(view.container.querySelector(".wh-badge")).toHaveClass("wh-badge--attention");
    view.rerender(<ToolbarBadge dot status="offline" />);
    expect(view.container.querySelector(".wh-badge")).toHaveClass("wh-badge--dot");
    expect(view.container.querySelector(".wh-badge")).toHaveAttribute("data-status", "offline");
  });

  it("keeps placeholder badge data referentially stable", () => {
    const seen: ToolbarBadgeSource[] = [];
    function Probe() {
      seen.push(useToolbarBadges());
      return null;
    }
    const view = render(<Probe />);
    view.rerender(<Probe />);
    expect(new Set(seen).size).toBe(1);
  });

});
