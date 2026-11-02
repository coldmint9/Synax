import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectApi } from "../../adapters/transport/project";
import { quickMergeApi } from "../../adapters/transport/quickMerge";
import { ToolbarPill } from "../../app/layouts/ToolbarPill";
import { GitToolbarProvider, GitToolbarTarget } from "./GitToolbarPortal";
import { clearStaleResourceCache } from "../../shared/lib/staleResource";
import GitWorkbenchPage from "./GitWorkbenchPage";

vi.mock("../../adapters/transport/project", () => ({
  projectApi: {
    getWorkspace: vi.fn(),
    listGitWorkspaces: vi.fn(),
    gitHistory: vi.fn(),
    gitState: vi.fn(),
    gitAssociations: vi.fn(),
  },
}));
vi.mock("../../adapters/transport/quickMerge", () => ({
  quickMergeApi: {
    board: vi.fn(),
    createGroup: vi.fn(),
    renameGroup: vi.fn(),
    deleteGroup: vi.fn(),
    createRule: vi.fn(),
    updateRule: vi.fn(),
    deleteRule: vi.fn(),
    merge: vi.fn(),
    push: vi.fn(),
  },
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
  vi.mocked(projectApi.getWorkspace).mockResolvedValue({
    roots: [{ id: "root", role: "primary", status: "available", name: "Synax" }],
  } as Awaited<ReturnType<typeof projectApi.getWorkspace>>);
  vi.mocked(projectApi.listGitWorkspaces).mockResolvedValue({
    repositoryRoot: "/repo",
    branches: [],
    worktrees: [],
  } as Awaited<ReturnType<typeof projectApi.listGitWorkspaces>>);
  vi.mocked(projectApi.gitHistory).mockResolvedValue({
    commits: [],
    refs: [],
    snapshot: "s",
    nextOffset: null,
  } as Awaited<ReturnType<typeof projectApi.gitHistory>>);
  vi.mocked(projectApi.gitState).mockResolvedValue({
    head: "",
    branch: "main",
    operation: null,
    conflicts: [],
    output: "",
  } as Awaited<ReturnType<typeof projectApi.gitState>>);
  vi.mocked(projectApi.gitAssociations).mockResolvedValue({
    epics: [],
    branches: [],
    refs: [],
    sessions: [],
  } as Awaited<ReturnType<typeof projectApi.gitAssociations>>);
  vi.mocked(quickMergeApi.board).mockResolvedValue({
    groups: [{ id: "g1", projectId: "p", name: "发布到测试", order: 0, createdAt: "2026-01-01T00:00:00.000Z" }],
    rules: [
      {
        id: "r1",
        projectId: "p",
        groupId: "g1",
        source: "feature/login",
        target: "test",
        order: 0,
        createdAt: "2026-01-01T00:00:00.000Z",
        status: "idle",
      },
    ],
  });
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
          <Route path="/projects/:projectId/git" element={<GitWorkbenchPage />} />
          <Route path="/projects/:projectId/git/mr/:mrId" element={<div>detail</div>} />
        </Routes>
      </GitToolbarProvider>
    </MemoryRouter>,
  );
}

describe("Git secondary island", () => {
  it("keeps repository selection and exposes no manual MR entry", async () => {
    const { container } = mount("/projects/p/git?view=worktrees&rootId=root");
    await screen.findByRole("table", { name: "Git 工作树列表" });
    expect(
      container.querySelector('.git-island-views [data-island-option="worktrees"]'),
    ).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("button", { name: "新建 MR" })).toBeNull();
    expect(screen.queryByRole("button", { name: "合并请求" })).toBeNull();
    expect(projectApi.listGitWorkspaces).toHaveBeenCalledWith("p", "root", "inventory");
  });

  it("offers exactly history, worktrees and quick merge", async () => {
    const { container } = mount();
    await waitFor(() => expect(projectApi.listGitWorkspaces).toHaveBeenCalled());
    const options = Array.from(
      container.querySelectorAll("[data-island-option]"),
    ).map((node) => node.textContent?.trim());
    expect(options).toEqual(["历史树", "工作树", "快捷合并"]);
    expect(screen.queryByRole("button", { name: "预设" })).toBeNull();
    expect(screen.queryByRole("button", { name: "新建 MR" })).toBeNull();
  });

  it("renders the quick-merge board and runs a rule", async () => {
    mount("/projects/p/git?view=quick");
    expect(
      await screen.findByRole("heading", { name: "快捷合并", level: 1 }),
    ).toBeInTheDocument();
    expect(await screen.findByText("发布到测试")).toBeInTheDocument();
    expect(screen.getByText("feature/login")).toBeInTheDocument();
    expect(quickMergeApi.board).toHaveBeenCalledWith("p");

    vi.mocked(quickMergeApi.merge).mockResolvedValue({
      id: "r1",
      projectId: "p",
      groupId: "g1",
      source: "feature/login",
      target: "test",
      order: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      status: "merged",
      message: "已合并 · 待推送 2",
      ahead: 2,
      steps: [{ command: "git fetch origin --prune", status: "ok", detail: "远端引用已同步" }],
    });
    fireEvent.click(screen.getByRole("button", { name: "合并" }));
    await waitFor(() => expect(quickMergeApi.merge).toHaveBeenCalledWith("p", "r1", "root"));
    expect(await screen.findByText("已合并 · 待推送 2")).toBeInTheDocument();
    expect(screen.getByText("git fetch origin --prune")).toBeInTheDocument();
  });

  it("reverses a rule in place without disabling the control", async () => {
    mount("/projects/p/git?view=quick");
    const swap = await screen.findByRole("button", {
      name: "对调方向：变为 test → feature/login",
    });
    expect(swap).toBeEnabled();
    vi.mocked(quickMergeApi.updateRule).mockResolvedValue({
      id: "r1",
      projectId: "p",
      groupId: "g1",
      source: "test",
      target: "feature/login",
      order: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      status: "idle",
    });
    fireEvent.click(swap);
    await waitFor(() =>
      expect(quickMergeApi.updateRule).toHaveBeenCalledWith("p", "r1", {
        source: "test",
        target: "feature/login",
      }),
    );
    expect(
      await screen.findByRole("button", { name: "对调方向：变为 feature/login → test" }),
    ).toBeInTheDocument();
  });
});
