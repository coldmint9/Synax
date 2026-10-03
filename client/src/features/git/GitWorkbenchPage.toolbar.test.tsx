import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gitMrApi } from "../../adapters/transport/gitMr";
import { projectApi } from "../../adapters/transport/project";
import { ToolbarPill } from "../../app/layouts/ToolbarPill";
import { GitToolbarProvider, GitToolbarTarget } from "./GitToolbarPortal";
import GitWorkbenchPage from "./GitWorkbenchPage";

vi.mock("../../adapters/transport/gitMr", () => ({
  gitMrApi: { list: vi.fn(), presets: vi.fn() },
}));
vi.mock("../../adapters/transport/project", () => ({
  projectApi: {
    getWorkspace: vi.fn(),
    listGitWorkspaces: vi.fn(),
    gitHistory: vi
      .fn()
      .mockResolvedValue({
        commits: [],
        refs: [],
        snapshot: "s",
        nextOffset: null,
      }),
    gitState: vi
      .fn()
      .mockResolvedValue({
        head: "",
        branch: "main",
        operation: null,
        conflicts: [],
        output: "",
      }),
    gitAssociations: vi
      .fn()
      .mockResolvedValue({ epics: [], branches: [], refs: [], sessions: [] }),
  },
}));
vi.mock("./MergeRequestForm", () => ({
  MergeRequestForm: () => <div role="dialog">新建合并请求</div>,
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.mocked(gitMrApi.list).mockResolvedValue([]);
  vi.mocked(gitMrApi.presets).mockResolvedValue([]);
  vi.mocked(projectApi.getWorkspace).mockResolvedValue({
    roots: [
      { id: "root", role: "primary", status: "available", name: "Synax" },
    ],
  } as Awaited<ReturnType<typeof projectApi.getWorkspace>>);
  vi.mocked(projectApi.listGitWorkspaces).mockResolvedValue({
    repositoryRoot: "/repo",
    branches: [],
    worktrees: [],
  } as Awaited<ReturnType<typeof projectApi.listGitWorkspaces>>);
});

afterEach(() => vi.unstubAllGlobals());

function mount(path = "/projects/p/git") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <GitToolbarProvider>
        <ToolbarPill visible>
          <GitToolbarTarget />
        </ToolbarPill>
        <Routes>
          <Route
            path="/projects/:projectId/git"
            element={<GitWorkbenchPage />}
          />
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
    expect(page.querySelector(".mr-root-tabs")).not.toBeNull();

    const create = screen.getByRole("button", { name: "新建 MR" });
    expect(create).toBeDisabled();
    await waitFor(() => expect(create).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "历史树" }));
    expect(page).toHaveTextContent("历史树");
    fireEvent.change(island.querySelector(".git-island-view-select")!, {
      target: { value: "presets" },
    });
    expect(page).not.toHaveTextContent("运行记录");
    expect(
      screen.queryByRole("option", { name: "运行记录" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "刷新 Git 工作台" }));
    await waitFor(() => expect(gitMrApi.list).toHaveBeenCalledTimes(2));
    fireEvent.click(create);
    expect(screen.getByRole("dialog")).toHaveTextContent("新建合并请求");
  });
});

it("opens the requested MR list when returning from a detail page", async () => {
  mount("/projects/p/git?view=requests");
  expect(
    await screen.findByRole("heading", { name: "还没有本地合并请求" }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "合并请求", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  fireEvent.click(screen.getByRole("button", { name: "历史树", exact: true }));
  expect(
    screen.getByRole("button", { name: "历史树", exact: true }),
  ).toHaveAttribute("aria-current", "page");
});
