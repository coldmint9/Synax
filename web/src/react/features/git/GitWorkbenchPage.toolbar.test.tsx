import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gitMrApi } from "../../../lib/api/gitMr";
import { projectApi } from "../../../lib/api/project";
import { ToolbarPill } from "../../layouts/ToolbarPill";
import {
  GitToolbarProvider,
  GitToolbarTarget,
} from "./GitToolbarPortal";
import GitWorkbenchPage from "./GitWorkbenchPage";

vi.mock("../../../lib/api/gitMr", () => ({
  gitMrApi: { list: vi.fn(), presets: vi.fn() },
}));
vi.mock("../../../lib/api/project", () => ({
  projectApi: { getWorkspace: vi.fn(), listGitWorkspaces: vi.fn() },
}));
vi.mock("./MergeRequestForm", () => ({
  MergeRequestForm: () => <div role="dialog">新建合并请求</div>,
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    disconnect() {}
  });
  vi.mocked(gitMrApi.list).mockResolvedValue([]);
  vi.mocked(gitMrApi.presets).mockResolvedValue([]);
  vi.mocked(projectApi.getWorkspace).mockResolvedValue({
    roots: [{ id: "root", role: "primary", status: "available", name: "Synax" }],
  } as Awaited<ReturnType<typeof projectApi.getWorkspace>>);
  vi.mocked(projectApi.listGitWorkspaces).mockResolvedValue({
    repositoryRoot: "/repo",
    branches: [],
    worktrees: [],
  } as Awaited<ReturnType<typeof projectApi.listGitWorkspaces>>);
});

afterEach(() => vi.unstubAllGlobals());

function mount() {
  return render(
    <MemoryRouter initialEntries={["/projects/p/git"]}>
      <GitToolbarProvider>
        <ToolbarPill visible>
          <GitToolbarTarget />
        </ToolbarPill>
        <Routes>
          <Route path="/projects/:projectId/git" element={<GitWorkbenchPage />} />
        </Routes>
      </GitToolbarProvider>
    </MemoryRouter>,
  );
}

describe("Git secondary island", () => {
  it("hosts views and actions without duplicating them in the page", async () => {
    const { container } = mount();
    const island = container.querySelector(".wh-pill-slot")!;
    const page = container.querySelector(".git-workbench")!;
    expect(island.querySelector('nav[aria-label="Git 视图"]')).not.toBeNull();
    expect(page.querySelector('nav[aria-label="Git 视图"]')).toBeNull();
    expect(page.querySelector(".mr-root-select")).not.toBeNull();

    const create = screen.getByRole("button", { name: "新建 MR" });
    expect(create).toBeDisabled();
    await waitFor(() => expect(create).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "分支" }));
    expect(page).toHaveTextContent("本地分支");
    fireEvent.change(island.querySelector(".git-island-view-select")!, {
      target: { value: "history" },
    });
    expect(page).toHaveTextContent("运行记录");

    fireEvent.click(screen.getByRole("button", { name: "刷新 Git 工作台" }));
    await waitFor(() => expect(gitMrApi.list).toHaveBeenCalledTimes(2));
    fireEvent.click(create);
    expect(screen.getByRole("dialog")).toHaveTextContent("新建合并请求");
  });
});
