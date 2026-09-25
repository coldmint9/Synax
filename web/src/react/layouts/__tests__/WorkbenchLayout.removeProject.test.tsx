import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { projectApi } from "../../../lib/api/project";
import { useShellStore, type ProjectSummary } from "../../state/shellStore";
import WorkbenchLayout from "../WorkbenchLayout";

vi.mock("../../../lib/api/project", () => ({
  projectApi: { deleteProject: vi.fn(), getProject: vi.fn() },
}));
vi.mock("../WorkbenchHeader", () => ({
  WorkbenchHeader: ({ onRemoveProject }: { onRemoveProject: (id: string) => Promise<void> }) => (
    <button onClick={() => void onRemoveProject("only").catch(() => {})}>Remove</button>
  ),
}));
vi.mock("../WorkbenchIsland", () => ({ WorkbenchIslandProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("../../features/git/GitToolbarPortal", () => ({ GitToolbarProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("../../features/agent-workspace/SessionEnvironmentContext", () => ({ SessionEnvironmentProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("../../features/terminal/TerminalDrawer", () => ({ TerminalDrawer: () => null }));
vi.mock("../../features/project-create/ProjectCreateDialog", () => ({ ProjectCreateDialog: () => null }));
vi.mock("../../components/ToastContainer", () => ({ ToastContainer: () => null }));
vi.mock("../CachedWorkbenchPage", () => ({ CachedWorkbenchPage: () => null, PageLoading: () => null }));
vi.mock("../../../hooks/useContextStream", () => ({ useContextStream: () => {} }));
vi.mock("../../../hooks/useAgentPermissionNotifier", () => ({ useAgentPermissionNotifier: () => {} }));
vi.mock("../../../hooks/useDesktopNotification", () => ({ useDesktopNotification: () => {} }));
vi.mock("../../../hooks/useTaskNotificationListener", () => ({ useTaskNotificationListener: () => {} }));
vi.mock("../../features/agent-workspace/useRuntimeSSE", () => ({ useRuntimeSSE: () => {} }));

const project = { id: "only", name: "Only workspace" } as ProjectSummary;

function Location() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}

function mount() {
  render(
    <MemoryRouter initialEntries={["/projects/only"]}>
      <Location />
      <Routes>
        <Route element={<WorkbenchLayout />}>
          <Route path="/projects/:projectId" element={null} />
          <Route path="/" element={null} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useShellStore.setState({ projects: [project], projectsLoaded: true, currentProjectId: project.id });
  vi.mocked(projectApi.getProject).mockResolvedValue(null);
  vi.mocked(projectApi.deleteProject).mockReset();
});

describe("removing the only workspace", () => {
  it("clears its id and replaces the route with home", async () => {
    vi.mocked(projectApi.deleteProject).mockResolvedValue({ deleted: true });
    mount();
    fireEvent.click(screen.getByText("Remove"));

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/"));
    expect(useShellStore.getState().projects).toEqual([]);
    expect(useShellStore.getState().currentProjectId).toBeNull();
  });

  it("restores the selection when deletion fails", async () => {
    let rejectDelete!: (error: Error) => void;
    vi.mocked(projectApi.deleteProject).mockImplementation(() => new Promise((_, reject) => { rejectDelete = reject; }));
    mount();
    fireEvent.click(screen.getByText("Remove"));
    expect(useShellStore.getState().currentProjectId).toBeNull();

    await act(async () => {
      rejectDelete(new Error("Delete failed"));
      await Promise.resolve();
    });
    await waitFor(() => expect(useShellStore.getState().currentProjectId).toBe("only"));
    expect(screen.getByTestId("location")).toHaveTextContent("/projects/only");
  });
});
