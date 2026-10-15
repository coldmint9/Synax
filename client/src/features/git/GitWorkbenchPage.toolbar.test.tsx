import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gitMrApi } from "../../adapters/transport/gitMr";
import { projectApi } from "../../adapters/transport/project";
import { ToolbarPill } from "../../app/layouts/ToolbarPill";
import { GitToolbarProvider, GitToolbarTarget } from "./GitToolbarPortal";
import { clearStaleResourceCache } from "../../shared/lib/staleResource";
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
  clearStaleResourceCache();
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
  it("opens worktree management in the existing Island and keeps repository selection", async () => {
    const { container } = mount("/projects/p/git?view=worktrees&rootId=root");
    await screen.findByRole("table", { name: "Git 工作树列表" });
    expect(container.querySelector('.git-island-views [data-island-option="worktrees"]')).toHaveAttribute("aria-current", "page");
    expect(container.querySelector(".git-worktree-island")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "新建 MR" })).toBeNull();
    expect(projectApi.listGitWorkspaces).toHaveBeenCalledWith("p", "root", "inventory");
  });
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

    // The workbench toolbar no longer exposes a manual refresh action.
    expect(
      screen.queryByRole("button", { name: "刷新 Git 工作台" }),
    ).toBeNull();
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

// A slow secondary endpoint must not hold the repository views behind it.
it("loads history while MR lists and presets are still pending", async () => {
  vi.mocked(gitMrApi.list).mockReturnValue(new Promise(() => {}));
  vi.mocked(gitMrApi.presets).mockReturnValue(new Promise(() => {}));
  mount();
  await waitFor(() => expect(projectApi.gitHistory).toHaveBeenCalled());
  expect(projectApi.listGitWorkspaces).toHaveBeenCalledWith("p", "root", "inventory");
  expect(projectApi.listGitWorkspaces).toHaveBeenCalledTimes(1);
  expect(screen.queryByText("正在加载 Git 工作台…")).not.toBeInTheDocument();
});

it("renders worktree inventory before status inspection finishes", async () => {
  vi.mocked(projectApi.listGitWorkspaces).mockImplementation((_id, _root, mode) => mode === "inventory"
    ? Promise.resolve({ repositoryRoot: "/repo", defaultPath: "/repo", branches: [], commits: [], worktrees: [
      { path: "/repo", branch: "main", head: "a".repeat(40), primary: true, managed: false, locked: false, prunable: false, detached: false, dirty: false, statusKnown: false, sessionCount: 0 },
    ] }) : new Promise(() => {}));
  mount("/projects/p/git?view=worktrees");
  expect(await screen.findByRole("table", { name: "Git 工作树列表" })).toBeInTheDocument();
  expect(screen.getAllByText("/repo").length).toBeGreaterThan(0);
  await waitFor(() => expect(projectApi.listGitWorkspaces).toHaveBeenCalledWith("p", "root"));
});

it("keeps a refreshed worktree snapshot when an earlier background scan returns late", async () => {
  type Workspace = Awaited<ReturnType<typeof projectApi.listGitWorkspaces>>;
  const inventory: Workspace = { repositoryRoot: "/repo", defaultPath: "/repo", branches: [], commits: [], worktrees: [
    { path: "/repo", branch: "main", head: "a".repeat(40), primary: true, managed: false, locked: false, prunable: false, detached: false, dirty: false, statusKnown: false, sessionCount: 0 },
  ] };
  let resolveOld!: (workspace: Workspace) => void;
  let scans = 0;
  const updated = { ...inventory, worktrees: inventory.worktrees.map(tree => ({ ...tree, dirty: true, statusKnown: true })) };
  vi.mocked(projectApi.listGitWorkspaces).mockImplementation((_id, _root, mode) => {
    if (mode === "inventory") return Promise.resolve(inventory);
    if (++scans === 1) return new Promise(resolve => { resolveOld = resolve; });
    return Promise.resolve(updated);
  });
  const { container } = mount("/projects/p/git?view=worktrees");
  await screen.findByRole("table", { name: "Git 工作树列表" });
  await waitFor(() => expect(scans).toBe(1));
  fireEvent.click(within(container.querySelector(".git-worktree-island") as HTMLElement).getByRole("button", { name: "刷新", exact: true }));
  await waitFor(() => expect(container.querySelector("tbody")).toHaveTextContent("有未提交修改"));
  await act(async () => { resolveOld({ ...inventory, worktrees: inventory.worktrees.map(tree => ({ ...tree, statusKnown: true })) }); });
  expect(container.querySelector("tbody")).toHaveTextContent("有未提交修改");
  expect(scans).toBe(2);
});
