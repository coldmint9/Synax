import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { WorkbenchHeader } from "../WorkbenchHeader";
import { useTerminalStore } from "../../../features/terminal/terminalStore";
import {
  useShellStore,
  type ProjectSummary,
} from "../../../shared/state/shellStore";
import { useAgentSessionStore } from "../../../features/agent-workspace/state/agentSessionStore";
import { useApiConnectivityStore } from "../../../shared/lib/apiConnectivity";
import type { ProjectSessionBadge } from "../../../features/agent-workspace/projectSessionBadges";

const badgeState = vi.hoisted(() => ({ badges: {} as Record<string, ProjectSessionBadge> }));

vi.mock("../../../shared/hooks/useLocale", () => ({
  useLocale: () => ({ locale: "en", t: (key: string) => key }),
}));
vi.mock("../../../features/agent-workspace/projectSessionBadges", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../features/agent-workspace/projectSessionBadges")>(),
  useProjectSessionBadges: () => ({ badges: badgeState.badges, refresh: async () => {} }),
}));
vi.mock("../useIslandPresence", () => ({
  useIslandPresence: (open: boolean) => ({ ref: () => {}, present: open }),
}));
vi.mock("../IslandSelection", () => ({
  IslandSelection: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));
const project = {
  id: "p",
  name: "Example",
  status: "healthy",
} as ProjectSummary;
const base = {
  chromeMode: "global" as const,
  activePanel: "sessions" as const,
  onPanelToggle: vi.fn(),
  hasProject: true,
  projectName: "Example",
  currentProjectId: "p",
  projects: [project],
  onProjectSwitch: vi.fn(),
  onCreateProject: vi.fn(),
  onRemoveProject: vi.fn(async () => {}),
};
function RouteMarker() {
  const location = useLocation();
  return <output data-testid="route">{location.pathname}</output>;
}
const wrapper = ({ children }: { children: ReactNode }) => (
  <MemoryRouter>
    {children}
    <RouteMarker />
  </MemoryRouter>
);
beforeEach(() => {
  badgeState.badges = {};
  useAgentSessionStore.setState(useAgentSessionStore.getInitialState());
  useTerminalStore.setState({ open: false });
  useApiConnectivityStore.setState({
    browserOnline: true,
    apiReachable: "reachable",
    failureCount: 0,
    lastCheckedAt: null,
  });
  useShellStore.setState((s) => ({
    preferences: { ...s.preferences, locale: "en" },
  }));
});
afterEach(() => {
  vi.clearAllMocks();
  useTerminalStore.setState(useTerminalStore.getInitialState());
  useShellStore.setState(useShellStore.getInitialState());
});
async function openRemoval(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "appSwitchProject" }));
  await user.click(
    await screen.findByRole("button", { name: "Workspace actions: Example" }),
  );
  await user.click(
    await screen.findByRole("button", { name: "appRemoveProject: Example" }),
  );
  return screen.findByRole("dialog", { name: "appRemoveProject" });
}

describe("workbench action state", () => {
  it("shows running sessions elsewhere and updates the count when switching workspaces or sessions finish", () => {
    badgeState.badges = {
      p: { waitingInput: 0, unreadFailed: 0, running: 4, unreadCompleted: 0, total: 4 },
      other: { waitingInput: 0, unreadFailed: 0, running: 2, unreadCompleted: 3, total: 5 },
      third: { waitingInput: 0, unreadFailed: 0, running: 1, unreadCompleted: 0, total: 1 },
      removed: { waitingInput: 10, unreadFailed: 10, running: 20, unreadCompleted: 0, total: 40 },
    };
    const props = {
      ...base,
      projects: [project, { ...project, id: "other", name: "Other" }, { ...project, id: "third", name: "Third" }],
    };
    const view = render(<WorkbenchHeader {...props} />, { wrapper });
    const trigger = screen.getByRole("button", { name: "appSwitchProject" });
    expect(trigger).toHaveTextContent("Example3");
    expect(trigger).toHaveAccessibleDescription("Active sessions in other workspaces: 3");

    view.rerender(<WorkbenchHeader {...props} currentProjectId="other" projectName="Other" />);
    expect(trigger).toHaveTextContent("Other5");
    expect(trigger).toHaveAccessibleDescription("Active sessions in other workspaces: 5");

    badgeState.badges = {
      p: { waitingInput: 0, unreadFailed: 0, running: 0, unreadCompleted: 4, total: 4 },
      other: { waitingInput: 2, unreadFailed: 3, running: 2, unreadCompleted: 3, total: 10 },
      third: { waitingInput: 0, unreadFailed: 0, running: 0, unreadCompleted: 1, total: 1 },
    };
    view.rerender(<WorkbenchHeader {...props} currentProjectId="other" projectName="Other" />);
    expect(trigger).toHaveTextContent("Other5");
    expect(trigger).toHaveAccessibleDescription("Unread completed sessions in other workspaces: 5");
    expect(trigger.querySelector(".workspace-activity")).toHaveAttribute("data-status", "unread");

    badgeState.badges.p = { waitingInput: 0, unreadFailed: 0, running: 0, unreadCompleted: 0, total: 0 };
    badgeState.badges.third = { ...badgeState.badges.p };
    view.rerender(<WorkbenchHeader {...props} currentProjectId="other" projectName="Other" />);
    expect(trigger).toHaveTextContent(/^Other$/);
    expect(trigger).not.toHaveAttribute("aria-describedby");
    expect(screen.getByText("No sessions need attention in other workspaces")).toHaveAttribute("role", "status");
  });

  it("prioritizes waiting over failed, running and unread completion in both trigger and workspace rows", async () => {
    const user = userEvent.setup();
    const props = { ...base, projects: [project, { ...project, id: "other", name: "Other" }] };
    badgeState.badges.other = { waitingInput: 1, unreadFailed: 2, running: 3, unreadCompleted: 4, total: 10 };
    const view = render(<WorkbenchHeader {...props} />, { wrapper });
    const trigger = screen.getByRole("button", { name: "appSwitchProject" });
    const activity = () => trigger.querySelector(".workspace-activity");
    expect(activity()).toHaveAttribute("data-status", "waiting");
    expect(activity()).toHaveTextContent("1");
    expect(trigger).toHaveAccessibleDescription("Sessions waiting for input or approval in other workspaces: 1");
    await user.click(trigger);
    const list = await screen.findByRole("group", { name: "Workspaces" });
    expect(list.querySelector('.project-session-badge__dot')).toHaveAttribute("data-status", "waiting");
    expect(list.querySelector('.project-session-badge__count')).toHaveTextContent("1");
    await user.keyboard("{Escape}");

    badgeState.badges.other = { ...badgeState.badges.other, waitingInput: 0, total: 9 };
    view.rerender(<WorkbenchHeader {...props} />);
    expect(activity()).toHaveAttribute("data-status", "failed");
    expect(activity()).toHaveTextContent("2");
    expect(trigger).toHaveAccessibleDescription("Unread failed sessions in other workspaces: 2");

    badgeState.badges.other = { ...badgeState.badges.other, unreadFailed: 0, total: 7 };
    view.rerender(<WorkbenchHeader {...props} />);
    expect(activity()).toHaveAttribute("data-status", "running");
    expect(activity()).toHaveTextContent("3");

    badgeState.badges.other = { ...badgeState.badges.other, running: 0, total: 4 };
    view.rerender(<WorkbenchHeader {...props} />);
    expect(activity()).toHaveAttribute("data-status", "unread");
    expect(activity()).toHaveTextContent("4");
  });

  it("keeps the workspace menu and navigation in the same header when entering a viewer", async () => {
    const user = userEvent.setup();
    const view = render(<WorkbenchHeader {...base} />, { wrapper });
    const header = screen.getByRole("banner", { name: "Workspace toolbar" });
    const switcher = screen.getByRole("button", { name: "appSwitchProject" });
    await user.click(switcher);
    const search = await screen.findByRole("textbox", { name: "Search workspaces" });
    await user.type(search, "Exam");
    view.rerender(<WorkbenchHeader {...base} chromeMode="workspaceFocus" />);
    expect(screen.getByRole("banner", { name: "Workspace toolbar" })).toBe(header);
    expect(screen.getByRole("button", { name: "appSwitchProject" })).toBe(switcher);
    expect(screen.getByRole("textbox", { name: "Search workspaces" })).toHaveValue("Exam");
    expect(within(header).getByRole("button", { name: "Work" })).toHaveTextContent("Work");
    expect(within(header).getByRole("button", { name: "Git" })).toHaveTextContent("Git");
  });

  it("filters workspaces and supports keyboard return from target actions", async () => {
    const user = userEvent.setup();
    render(
      <WorkbenchHeader
        {...base}
        projects={[project, { ...project, id: "other", name: "Other" }]}
      />,
      { wrapper },
    );
    await user.click(screen.getByRole("button", { name: "appSwitchProject" }));
    const search = await screen.findByRole("textbox", {
      name: "Search workspaces",
    });
    await user.type(search, "Other");
    expect(
      screen.queryByRole("button", { name: "Workspace actions: Example" }),
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Workspace actions: Other" }),
    );
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Workspace actions: Other" }),
      ).toHaveFocus(),
    );
    expect(
      screen.getByRole("textbox", { name: "Search workspaces" }),
    ).toHaveValue("Other");
    await user.click(
      screen.getByRole("button", { name: "Other", exact: true }),
    );
    expect(base.onProjectSwitch).toHaveBeenCalledWith("other");
    expect(
      screen.queryByRole("textbox", { name: "Search workspaces" }),
    ).not.toBeInTheDocument();
  });
  it("keeps creation available when workspace search has no results", async () => {
    const user = userEvent.setup();
    render(<WorkbenchHeader {...base} />, { wrapper });
    await user.click(screen.getByRole("button", { name: "appSwitchProject" }));
    await user.type(
      await screen.findByRole("textbox", { name: "Search workspaces" }),
      "not found",
    );
    expect(screen.getByText("No matching workspaces")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create workspace" }));
    expect(base.onCreateProject).toHaveBeenCalledOnce();
  });
  it("opens settings directly from the island button", async () => {
    const user = userEvent.setup();
    render(<WorkbenchHeader {...base} />, { wrapper });
    await user.click(screen.getByRole("button", { name: "appSettings" }));
    expect(base.onPanelToggle).toHaveBeenCalledWith("settings");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Rearrange widgets" }),
    ).not.toBeInTheDocument();
  });
  it("opens management for the menu target without switching the current workspace", async () => {
    const user = userEvent.setup();
    render(
      <WorkbenchHeader
        {...base}
        projects={[project, { ...project, id: "other", name: "Other" }]}
      />,
      { wrapper },
    );
    await user.click(screen.getByRole("button", { name: "appSwitchProject" }));
    await user.click(
      await screen.findByRole("button", { name: "Workspace actions: Other" }),
    );
    await user.click(screen.getByRole("button", { name: "Manage workspace" }));
    expect(screen.getByTestId("route")).toHaveTextContent(
      "/workspaces/other/manage",
    );
    expect(base.onProjectSwitch).not.toHaveBeenCalled();
  });
  it("keeps Settings selection independent from Terminal", () => {
    useTerminalStore.setState({ open: true });
    const view = render(<WorkbenchHeader {...base} />, { wrapper });
    expect(screen.getByRole("button", { name: "appSettings" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByRole("button", { name: "Terminal" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    act(() => useTerminalStore.setState({ open: false }));
    view.rerender(<WorkbenchHeader {...base} activePanel="settings" />);
    expect(screen.getByRole("button", { name: "appSettings" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Terminal" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });
  it("shows one red disconnected indicator in the menu when the backend is unreachable", () => {
    useApiConnectivityStore.setState({ apiReachable: "unreachable" });
    render(<WorkbenchHeader {...base} />, { wrapper });

    expect(
      screen.getByRole("img", { name: "Backend disconnected" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: "Backend disconnected" }),
    ).toHaveClass("text-danger");
  });
  it("protects a pending removal from Escape and outside click until it settles", async () => {
    const user = userEvent.setup();
    let resolve!: () => void;
    const remove = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolve = r;
        }),
    );
    render(<WorkbenchHeader {...base} onRemoveProject={remove} />, { wrapper });
    const dialog = await openRemoval(user);
    await user.click(
      within(dialog).getByRole("button", { name: "appConfirmRemove" }),
    );
    expect(remove).toHaveBeenCalledExactlyOnceWith("p");
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBe(dialog);
    await user.click(
      dialog.querySelector(".ui-dialog-viewport") as HTMLElement,
    );
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(
      within(dialog).getByRole("button", { name: "appCancel" }),
    ).toBeDisabled();
    await act(async () => resolve());
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });
  it("retains the confirmation and reports a rejected removal without an unhandled promise", async () => {
    const user = userEvent.setup();
    const remove = vi.fn().mockRejectedValue(new Error("Removal failed"));
    render(<WorkbenchHeader {...base} onRemoveProject={remove} />, { wrapper });
    const dialog = await openRemoval(user);
    await user.click(
      within(dialog).getByRole("button", { name: "appConfirmRemove" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Removal failed",
    );
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(
      within(dialog).getByRole("button", { name: "appConfirmRemove" }),
    ).toBeEnabled();
  });
});
