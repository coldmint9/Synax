import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { projectApi, type GitWorkspaceSummary, type GitWorktreeSummary } from "../../adapters/transport/project";
import { WorktreeDeleteDialog } from "./WorktreeDeleteDialog";

vi.mock("../../adapters/transport/project", () => ({ projectApi: { listGitWorkspaces: vi.fn(), removeGitWorktree: vi.fn(), gitWorktreeChanges: vi.fn() } }));

const base: GitWorktreeSummary = { path: "/repo/wip", head: "a".repeat(40), branch: null, detached: true, primary: false, locked: false, prunable: false, managed: true, dirty: false, sessionCount: 0, activeSessionCount: 0, statusKnown: true };
const main: GitWorktreeSummary = { ...base, path: "/repo", branch: "main", detached: false, primary: true };
const onClose = vi.fn(), onDeleted = vi.fn();

function summary(...worktrees: GitWorktreeSummary[]): GitWorkspaceSummary {
  return { repositoryRoot: "/repo", defaultPath: "/repo", branches: [], commits: [], worktrees };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(projectApi.removeGitWorktree).mockResolvedValue({ removed: true });
  vi.mocked(projectApi.gitWorktreeChanges).mockResolvedValue({ path: base.path, entries: [{ code: "M", path: "a.java" }, { code: "??", path: "notes.md" }], total: 2, truncated: false });
});
describe("Worktree delete dialog", () => {
  it("discards local changes only after listing them and confirming a second time", async () => {
    const user = userEvent.setup();
    const dirty = { ...base, dirty: true };
    vi.mocked(projectApi.listGitWorkspaces).mockResolvedValue(summary(main, dirty));
    render(<WorktreeDeleteDialog projectId="p" target={dirty} onClose={onClose} onDeleted={onDeleted} />);
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(dialog).toHaveTextContent("工作树包含未提交或未跟踪的修改"));
    expect(within(dialog).queryByRole("button", { name: "删除工作树" })).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "强制删除（丢弃修改）…" }));
    expect(projectApi.gitWorktreeChanges).toHaveBeenCalledWith("p", dirty.path, undefined);
    await waitFor(() => expect(dialog).toHaveTextContent("将永久丢弃 2 处本地修改"));
    expect(dialog).toHaveTextContent("a.java");
    expect(dialog).toHaveTextContent("notes.md");
    expect(projectApi.removeGitWorktree).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "返回" }));
    expect(within(dialog).queryByText(/将永久丢弃/)).toBeNull();
    expect(projectApi.removeGitWorktree).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "强制删除（丢弃修改）…" }));
    await user.click(await within(dialog).findByRole("button", { name: "确认丢弃 2 处修改并删除" }));
    await waitFor(() => expect(projectApi.removeGitWorktree).toHaveBeenCalledWith("p", { path: dirty.path, rootId: undefined, force: true }));
    expect(onDeleted).toHaveBeenCalledWith(dirty.path);
  });
  it("never offers discarding when another guard also blocks the removal", async () => {
    const busy = { ...base, dirty: true, activeSessionCount: 1 };
    vi.mocked(projectApi.listGitWorkspaces).mockResolvedValue(summary(main, busy));
    render(<WorktreeDeleteDialog projectId="p" target={busy} onClose={onClose} onDeleted={onDeleted} />);
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(dialog).toHaveTextContent("工作树仍被活跃会话占用"));
    expect(within(dialog).queryByRole("button", { name: /强制删除/ })).toBeNull();
    expect(projectApi.gitWorktreeChanges).not.toHaveBeenCalled();
  });
  it("rechecks instead of deleting when the listed changes disappeared", async () => {
    const user = userEvent.setup();
    const dirty = { ...base, dirty: true };
    vi.mocked(projectApi.listGitWorkspaces).mockResolvedValue(summary(main, dirty));
    vi.mocked(projectApi.gitWorktreeChanges).mockResolvedValue({ path: dirty.path, entries: [], total: 0, truncated: false });
    render(<WorktreeDeleteDialog projectId="p" target={dirty} onClose={onClose} onDeleted={onDeleted} />);
    const dialog = await screen.findByRole("dialog");
    await user.click(await within(dialog).findByRole("button", { name: "强制删除（丢弃修改）…" }));
    await waitFor(() => expect(dialog).toHaveTextContent("已经没有本地修改了"));
    expect(projectApi.removeGitWorktree).not.toHaveBeenCalled();
  });
  it("keeps the plain deletion for a clean worktree", async () => {
    const user = userEvent.setup();
    vi.mocked(projectApi.listGitWorkspaces).mockResolvedValue(summary(main, base));
    render(<WorktreeDeleteDialog projectId="p" target={base} onClose={onClose} onDeleted={onDeleted} />);
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(dialog).toHaveTextContent("将删除工作目录与工作树登记"));
    expect(within(dialog).queryByRole("button", { name: /强制删除/ })).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "删除工作树" }));
    await waitFor(() => expect(projectApi.removeGitWorktree).toHaveBeenCalledWith("p", { path: base.path, rootId: undefined, force: false }));
    expect(onDeleted).toHaveBeenCalledWith(base.path);
  });
});
