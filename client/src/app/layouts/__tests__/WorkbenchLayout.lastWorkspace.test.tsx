import { render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { projectApi } from "../../../adapters/transport/project";
import { useShellStore } from "../../../shared/state/shellStore";
import {
  clearLastOpenedWorkspaceId,
  loadLastOpenedWorkspaceId,
} from "../../../features/workspace/lastOpenedWorkspace";
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
  PageLoading: () => null,
}));
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

function mount(initialRoute: string) {
  return render(
    <MemoryRouter initialEntries={[initialRoute]}>
      <Routes>
        <Route element={<WorkbenchLayout />}>
          <Route path="/" element={null} />
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
    projects: [
      { id: "ws-a", name: "A", updatedAt: "2026-10-01T00:00:00.000Z" },
      { id: "ws-b", name: "B", updatedAt: "2026-10-22T00:00:00.000Z" },
    ],
    projectsLoaded: true,
    currentProjectId: null,
  });
  vi.mocked(projectApi.getProject).mockResolvedValue(null);
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
