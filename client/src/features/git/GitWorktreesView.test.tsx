import { useState } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { projectApi, type GitWorkspaceSummary, type GitWorktreeSummary } from "../../adapters/transport/project";
import { GitWorktreesView } from "./GitWorktreesView";

vi.mock("../../adapters/transport/project", () => ({ projectApi: {
  listGitWorkspaces: vi.fn(), previewGitWorktree: vi.fn(), createGitWorktree: vi.fn(), removeGitWorktree: vi.fn(),
  previewGitWorktreeCleanup: vi.fn(), cleanupGitWorktrees: vi.fn(), previewGitWorktreePrune: vi.fn(), pruneGitWorktrees: vi.fn(),
} }));
const clean: GitWorktreeSummary = { path: "/repo/clean", head: "a".repeat(40), branch: "feature/clean", detached: false, primary: false, locked: false, prunable: false, managed: true, dirty: false, sessionCount: 2, activeSessionCount: 0, statusKnown: true };
const main = { ...clean, path: "/repo", branch: "main", primary: true };
const dirty = { ...clean, path: "/repo/dirty", branch: "feature/dirty", dirty: true };
const active = { ...clean, path: "/repo/active", branch: "feature/active", activeSessionCount: 1 };
const workspace: GitWorkspaceSummary = { repositoryRoot: "/repo", defaultPath: "/repo", commits: [], branches: [{ name: "main", head: main.head, checkedOutPath: main.path, upstream: null }], worktrees: [main, clean, dirty, active] };
const onHistory = vi.fn(), onBusy = vi.fn();
function Location() { const location = useLocation(); return <output aria-label="地址">{location.pathname}{location.search}</output>; }
function Harness() {
  const [data, setData] = useState(workspace);
  return <MemoryRouter><GitWorktreesView projectId="p" rootId="reference" repositoryName="示例仓库" workspace={data} onUpdate={setData} onBusy={onBusy} onHistory={onHistory} /><Location /></MemoryRouter>;
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(projectApi.listGitWorkspaces).mockResolvedValue(workspace);
  vi.mocked(projectApi.previewGitWorktree).mockResolvedValue({ path: "/repo/new" });
  vi.mocked(projectApi.previewGitWorktreeCleanup).mockResolvedValue({ candidates: [clean], retained: [{ worktree: main, reasons: ["主工作树不可删除"] }, { worktree: dirty, reasons: ["有未提交修改"] }] });
  vi.mocked(projectApi.cleanupGitWorktrees).mockImplementation(async (_projectId, paths) => ({ results: paths.map(path => ({ path, branch: path === clean.path ? clean.branch : "second", status: "removed" as const })) }));
});
describe("Git worktree management", () => {
  it("creates from the keyboard and highlights the new worktree without leaving the list", async () => {
    const user = userEvent.setup();
    const created = { ...clean, path: "/repo/new", branch: "feat/keyboard" };
    vi.mocked(projectApi.createGitWorktree).mockResolvedValue({ worktree: created });
    vi.mocked(projectApi.listGitWorkspaces).mockResolvedValue({ ...workspace, worktrees: [...workspace.worktrees, created] });
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "创建工作树" }));
    const input = screen.getByRole("textbox", { name: "分支名称" });
    expect(input).toHaveFocus();
    await user.type(input, "feat/keyboard");
    await waitFor(() => expect(screen.getByRole("dialog")).toHaveTextContent("/repo/new"));
    await user.keyboard("{Enter}");
    const row = (await screen.findByText("feat/keyboard")).closest("tr");
    expect(row).toHaveClass("is-fresh");
    expect(projectApi.createGitWorktree).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("preselects the exact root and worktree for a new session, and opens history without checkout", () => {
    render(<Harness />);
    const row = screen.getByText("feature/clean").closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "新建会话" }));
    expect(screen.getByLabelText("地址")).toHaveTextContent("worktree=%2Frepo%2Fclean&rootId=reference");
    fireEvent.click(within(row).getByRole("button", { name: "查看历史" }));
    expect(onHistory).toHaveBeenCalledWith(clean);
  });
  it("previews the whole repository even when search hides the candidate, and cancellation never deletes", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    fireEvent.change(screen.getByRole("textbox", { name: "搜索分支或目录" }), { target: { value: "main" } });
    fireEvent.click(screen.getByRole("button", { name: /一键清理/ }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("feature/clean");
    expect(dialog).toHaveTextContent("不受搜索和筛选影响");
    expect(projectApi.previewGitWorktreeCleanup).toHaveBeenCalledWith("p", "reference");
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(projectApi.cleanupGitWorktrees).not.toHaveBeenCalled();
  });
  it("submits only the confirmed paths and shows results without repeating the deletion", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /一键清理/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "确认清理 1 个" }));
    await waitFor(() => expect(dialog).toHaveTextContent("已清理 1 个"));
    expect(projectApi.cleanupGitWorktrees).toHaveBeenCalledWith("p", [clean.path], "reference");
    expect(within(dialog).queryByRole("button", { name: /确认清理/ })).toBeNull();
  });
  it("continues after a single request failure and preserves per-item failure information", async () => {
    vi.mocked(projectApi.previewGitWorktreeCleanup).mockResolvedValue({ candidates: [clean, { ...clean, path: "/repo/second", branch: "second" }], retained: [] });
    vi.mocked(projectApi.cleanupGitWorktrees).mockRejectedValueOnce(new Error("网络连接中断"));
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /一键清理/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "确认清理 2 个" }));
    await waitFor(() => expect(dialog).toHaveTextContent("网络连接中断"));
    expect(projectApi.cleanupGitWorktrees).toHaveBeenCalledTimes(2);
    expect(dialog).toHaveTextContent("已清理 1 个，跳过 / 失败 1 个");
  });
  it("explains why an empty candidate list cannot be confirmed", async () => {
    vi.mocked(projectApi.previewGitWorktreeCleanup).mockResolvedValue({ candidates: [], retained: [{ worktree: main, reasons: ["主工作树不可删除"] }] });
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /一键清理/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByRole("button", { name: /确认清理/ })).toBeNull();
    expect(dialog).toHaveTextContent("主工作树不可删除");
  });
  it("retains the branch input on creation failure and uses the server path preview", async () => {
    vi.mocked(projectApi.createGitWorktree).mockRejectedValue(new Error("目录不可写"));
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "创建工作树" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox", { name: "分支名称" }), { target: { value: "feat/new" } });
    await waitFor(() => expect(dialog).toHaveTextContent("/repo/new"));
    fireEvent.click(within(dialog).getByRole("button", { name: "创建工作树" }));
    await waitFor(() => expect(dialog).toHaveTextContent("目录不可写"));
    expect(within(dialog).getByRole("textbox", { name: "分支名称" })).toHaveValue("feat/new");
    expect(projectApi.createGitWorktree).toHaveBeenCalledWith("p", expect.objectContaining({ rootId: "reference", branch: "feat/new", createBranch: true }));
  });
  it("previews the full prune impact before cleaning stale records", async () => {
    vi.mocked(projectApi.listGitWorkspaces).mockResolvedValue({ ...workspace, worktrees: [...workspace.worktrees, { ...clean, path: "/repo/stale", branch: "old", prunable: true }] });
    vi.mocked(projectApi.previewGitWorktreePrune).mockResolvedValue({ paths: ["/repo/stale", "/repo/other-stale"] });
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    fireEvent.click(await screen.findByRole("button", { name: "清理记录" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("/repo/other-stale");
    expect(projectApi.pruneGitWorktrees).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "确认清理 2 条记录" }));
    await waitFor(() => expect(projectApi.pruneGitWorktrees).toHaveBeenCalledWith("p", "reference", ["/repo/stale", "/repo/other-stale"]));
  });
});
