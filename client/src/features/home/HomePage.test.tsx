import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useShellStore, type ProjectSummary } from "../../shared/state/shellStore";
import { saveLastOpenedWorkspaceId } from "../workspace/lastOpenedWorkspace";
import HomePage from "./HomePage";

vi.mock("../agent-workspace/SessionComposer", () => ({
  SessionComposer: ({ projectId, layout }: { projectId: string; layout: string }) =>
    <div data-testid="composer" data-project={projectId} data-layout={layout} />,
}));
vi.mock("../../shared/design/motion", () => ({ reducedMotion: () => true }));

const project = (id: string) => ({ id, name: id, status: "healthy" } as ProjectSummary);
const onCreateProject = vi.fn();
function renderHome() {
  return render(<MemoryRouter><Routes>
    <Route element={<Outlet context={{ onCreateProject }} />}><Route path="/" element={<HomePage />} /></Route>
  </Routes></MemoryRouter>);
}
beforeEach(() => {
  useShellStore.setState({ ...useShellStore.getInitialState(), projects: [], projectsLoaded: true, currentProjectId: null });
  vi.clearAllMocks();
});
afterEach(() => useShellStore.setState(useShellStore.getInitialState()));

describe("home entry", () => {
  it("offers import and navigation without creating a composer for an empty workspace id", () => {
    renderHome();
    expect(screen.queryByTestId("composer")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /任务看板/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /可视化图解/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "导入工作区" }));
    expect(onCreateProject).toHaveBeenCalledOnce();
  });

  it("uses the remembered workspace and follows subsequent workspace switches", () => {
    useShellStore.setState({ projects: [project("a"), project("b")] });
    saveLastOpenedWorkspaceId("b");
    renderHome();
    expect(screen.getByTestId("composer")).toHaveAttribute("data-project", "b");
    expect(screen.getByTestId("composer")).toHaveAttribute("data-layout", "centered");
    expect(useShellStore.getState().currentProjectId).toBe("b");
    act(() => useShellStore.getState().setCurrentProjectId("a"));
    expect(screen.getByTestId("composer")).toHaveAttribute("data-project", "a");
  });
});
