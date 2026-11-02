import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { projectApi } from "../../../adapters/transport/project";
import { hydrateShellPreferences, useShellStore } from "../../../shared/state/shellStore";
import {
  clearLastOpenedWorkspaceId,
  loadLastOpenedWorkspaceId,
  saveLastOpenedWorkspaceId,
} from "../../../features/workspace/lastOpenedWorkspace";
import { saveSessionLastVisit } from "../../../features/agent-workspace/sessionLastVisit";
import WorkbenchLayout from "../WorkbenchLayout";

vi.mock("../../../adapters/transport/project", () => ({
  projectApi: { deleteProject: vi.fn(), getProject: vi.fn() },
}));
vi.mock("../WorkbenchHeader", () => ({
  WorkbenchHeader: () => null,
}));
vi.mock("../../../features/git/GitToolbarPortal", () => ({
  GitToolbarProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../../features/agent-workspace/SessionEnvironmentContext", () => ({
  SessionEnvironmentProvider: ({ children }: { children: ReactNode }) =>
    children,
}));
vi.mock("../../../features/terminal/TerminalDrawer", () => ({
  TerminalDrawer: () => null,
}));
vi.mock("../../../features/project-create/ProjectCreateDialog", () => ({
  ProjectCreateDialog: () => null,
}));
vi.mock("../../../shared/ui/ToastContainer", () => ({
  ToastContainer: () => null,
}));
vi.mock("../CachedWorkbenchPage", () => ({
  CachedWorkbenchPage: () => null,
  PageLoading: () => <span>Loading workspace</span>,
}));
vi.mock("../../pages/SessionsPage", () => ({ default: () => <span>Workspace sessions</span> }));
vi.mock("../../../shared/hooks/useAgentPermissionNotifier", () => ({
  useAgentPermissionNotifier: () => {},
}));
vi.mock("../../../shared/hooks/useDesktopNotification", () => ({
  useDesktopNotification: () => {},
}));
vi.mock("../../../shared/hooks/useTaskNotificationListener", () => ({
  useTaskNotificationListener: () => {},
}));
vi.mock("../../../features/agent-workspace/useRuntimeSSE", () => ({
  useRuntimeSSE: () => {},
}));

function Location() {
  const location = useLocation();
  return <><output data-testid="location">{location.pathname + location.search}</output>
    <Link to="/">Go home</Link><Link to="/settings">Settings</Link></>;
}

function mount(initialRoute: string) {
  return render(
    <MemoryRouter initialEntries={[initialRoute]}>
      <Location />
      <Routes>
        <Route element={<WorkbenchLayout />}>
          <Route path="/" element={<span>Global home</span>} />
          <Route path="/settings" element={<span>Global settings</span>} />
          <Route path="/projects/:projectId" element={null} />
          <Route path="/projects/:projectId/*" element={null} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  clearLastOpenedWorkspaceId();
  useShellStore.setState({
    preferences: { ...useShellStore.getInitialState().preferences, defaultHome: 'last-project' },
    projects: [
      { id: "ws-a", name: "A", updatedAt: "2026-10-01T00:00:00.000Z" },
      { id: "ws-b", name: "B", updatedAt: "2026-10-22T00:00:00.000Z" },
    ],
    projectsLoaded: true,
    currentProjectId: null,
  });
  vi.mocked(projectApi.getProject).mockResolvedValue(null);
});

afterEach(() => { cleanup(); useShellStore.setState(useShellStore.getInitialState()); });

describe('startup landing preference in the real workbench entry', () => {
  it('hydrates the saved setting and restores the last workspace and session', async () => {
    useShellStore.getState().setDefaultHome('last-project');
    useShellStore.setState(state => ({ preferences: { ...state.preferences, defaultHome: 'global-home' } }));
    hydrateShellPreferences();
    saveLastOpenedWorkspaceId('ws-a');
    saveSessionLastVisit('ws-a', { kind: 'session', sessionId: 'session-a' });
    mount('/');
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/projects/ws-a/sessions?session=session-a'));
    expect(screen.queryByText('Global home')).not.toBeInTheDocument();
  });

  it('waits for the initial project load instead of mounting the home composer', async () => {
    const ensureProjects = vi.fn(async () => {});
    useShellStore.setState({ projects: [], projectsLoaded: false, ensureProjects });
    saveLastOpenedWorkspaceId('ws-a');
    mount('/');
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/$/);
    expect(screen.queryByText('Global home')).not.toBeInTheDocument();
    act(() => useShellStore.setState({ projects: [{ id: 'ws-a', name: 'A' }], projectsLoaded: true }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/projects/ws-a/sessions'));
    expect(ensureProjects).toHaveBeenCalledOnce();
  });

  it('respects global home even when a workspace was remembered', async () => {
    useShellStore.getState().setDefaultHome('global-home');
    saveLastOpenedWorkspaceId('ws-a');
    mount('/');
    expect(await screen.findByText('Global home')).toBeVisible();
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/$/);
  });

  it('falls back from a removed workspace and stays home when no workspaces exist', async () => {
    saveLastOpenedWorkspaceId('removed');
    const view = mount('/');
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/projects/ws-b/sessions'));
    view.unmount();
    useShellStore.setState({ projects: [], currentProjectId: null });
    mount('/');
    expect(await screen.findByText('Global home')).toBeVisible();
  });

  it('does not redirect manual home navigation or settings deep links', async () => {
    saveLastOpenedWorkspaceId('ws-a');
    mount('/settings');
    expect(await screen.findByText('Global settings')).toBeVisible();
    fireEvent.click(screen.getByText('Go home'));
    expect(await screen.findByText('Global home')).toBeVisible();
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/$/);
  });

  it('consumes startup restoration once, so returning home stays there', async () => {
    saveLastOpenedWorkspaceId('ws-a');
    mount('/');
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/projects/ws-a/sessions'));
    fireEvent.click(screen.getByText('Go home'));
    expect(await screen.findByText('Global home')).toBeVisible();
  });

  it('does not steal navigation if the user leaves home before projects finish loading', async () => {
    useShellStore.setState({ projectsLoaded: false, ensureProjects: vi.fn(async () => {}) });
    mount('/');
    fireEvent.click(screen.getByText('Settings'));
    act(() => useShellStore.setState({ projectsLoaded: true }));
    expect(await screen.findByText('Global settings')).toBeVisible();
    fireEvent.click(screen.getByText('Go home'));
    expect(await screen.findByText('Global home')).toBeVisible();
  });
});

describe("remembering the active workspace", () => {
  it("records the workspace route the user is in, not the freshest project", async () => {
    mount("/projects/ws-a");
    await waitFor(() => expect(loadLastOpenedWorkspaceId()).toBe("ws-a"));
  });

  it("updates the remembered workspace when the user switches", async () => {
    const view = mount("/projects/ws-a");
    await waitFor(() => expect(loadLastOpenedWorkspaceId()).toBe("ws-a"));
    view.unmount();
    mount("/projects/ws-b");
    await waitFor(() => expect(loadLastOpenedWorkspaceId()).toBe("ws-b"));
  });

  it("never overwrites the remembered workspace from the home route", async () => {
    mount("/projects/ws-a");
    await waitFor(() => expect(loadLastOpenedWorkspaceId()).toBe("ws-a"));
    mount("/");
    await waitFor(() => expect(loadLastOpenedWorkspaceId()).toBe("ws-a"));
  });
});
