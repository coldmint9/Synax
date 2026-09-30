import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { projectApi, type GitWorkspaceSummary } from "../../../lib/api/project";
import { ContextMenuProvider } from "../../components/context-menu/ContextMenuProvider";
import GitHistoryTree from "./GitHistoryTree";
vi.mock("../../../lib/api/project", () => ({ projectApi: { gitHistory: vi.fn(), gitCommit: vi.fn(), gitState: vi.fn(), gitAssociations: vi.fn(), gitAction: vi.fn() } }));
const sha = "a".repeat(40), older = "b".repeat(40);
const commit = { id: sha, parents: [older], subject: "New feature", author: "Author", authoredAt: "2026-09-29T10:00:00Z", refs: ["refs/remotes/origin/topic"], rebase: false };
const workspace: GitWorkspaceSummary = { repositoryRoot: "/fixture", defaultPath: "/fixture", commits: [], branches: [], worktrees: [] };
const state = { head: sha, branch: "main", operation: null, conflicts: [], output: "" };
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(projectApi.gitHistory).mockImplementation(async (_id, input) => ({ commits: input?.offset ? [{ ...commit, id: older, subject: "Older feature", refs: [], parents: [] }] : [commit], refs: [], snapshot: "snapshot", nextOffset: input?.offset ? null : 1 }));
  vi.mocked(projectApi.gitState).mockResolvedValue(state);
  vi.mocked(projectApi.gitAssociations).mockResolvedValue({ epics: [], refs: [], sessions: [{ id: "s1", title: "Active work", status: "idle" }], branches: [{ ref: "refs/remotes/origin/topic", sessions: [{ id: "s1", title: "Active work", status: "idle" }], epicIds: [] }] });
  vi.mocked(projectApi.gitCommit).mockResolvedValue({ ...commit, authorEmail: "author@example.com", committer: "Committer", committerEmail: "committer@example.com", committedAt: commit.authoredAt, message: "New feature\n\nFull message", files: [{ path: "src/example.ts", status: "M" }], diff: "+added" });
  vi.mocked(projectApi.gitAction).mockResolvedValue({ ...state, output: "Done" });
});
function mount() { return render(<MemoryRouter><ContextMenuProvider><GitHistoryTree workspace={workspace} projectId="p" rootId="r" /></ContextMenuProvider></MemoryRouter>); }
describe("history API interactions", () => {
  it("deduplicates overlapping pages and ignores scrolls after the final cursor", async () => {
    vi.mocked(projectApi.gitHistory).mockImplementation(async (_id, input) => ({ commits: input?.offset ? [commit, { ...commit, id: older, subject: "Older feature", refs: [], parents: [] }] : [commit], refs: [], snapshot: "snapshot", nextOffset: input?.offset ? null : 1 }));
    const user = userEvent.setup(); const { container } = mount();
    await screen.findByRole("button", { name: "New feature" });
    await user.click(screen.getByRole("button", { name: "加载更多提交" }));
    await screen.findByRole("button", { name: "Older feature" });
    expect(screen.getAllByRole("button", { name: "New feature" })).toHaveLength(1);
    expect(container.querySelectorAll("tbody tr")).toHaveLength(2);
    fireEvent.scroll(container.querySelector(".history-tree-viewport")!);
    await waitFor(() => expect(projectApi.gitHistory).toHaveBeenCalledTimes(2));
  });
  it("appends pages with a snapshot and loads full commit metadata", async () => {
    const user = userEvent.setup(); mount();
    await screen.findByRole("button", { name: "New feature" });
    await user.click(screen.getByRole("button", { name: "加载更多提交" }));
    await screen.findByRole("button", { name: "Older feature" });
    expect(projectApi.gitHistory).toHaveBeenLastCalledWith("p", expect.objectContaining({ rootId: "r", offset: 1, snapshot: "snapshot" }));
    await user.click(screen.getByRole("button", { name: "New feature" }));
    await screen.findByText(/Full message/);
    expect(screen.getByText(/src\/example.ts/)).toBeInTheDocument();
    expect(screen.getByText(/author@example.com/)).toBeInTheDocument();
  });
  it("opens a remote branch's unarchived sessions and exposes navigation", async () => {
    const user = userEvent.setup(); mount();
    await screen.findByRole("button", { name: "New feature" });
    await user.click(await screen.findByTitle("1 个未归档会话"));
    expect(screen.getByRole("link", { name: "Active work" })).toHaveAttribute("href", expect.stringContaining("s1"));
  });
  it("sends the selected commit and expected HEAD after confirming a context action", async () => {
    const user = userEvent.setup(); mount();
    const title = await screen.findByRole("button", { name: "New feature" });
    fireEvent.contextMenu(title.closest("tr")!);
    await user.click(await screen.findByRole("menuitem", { name: "Cherry-pick 到当前分支…" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("/fixture");
    await user.click(screen.getByRole("button", { name: "确认执行" }));
    await waitFor(() => expect(projectApi.gitAction).toHaveBeenCalledWith("p", expect.objectContaining({ rootId: "r", action: "cherry-pick", target: sha, expectedHead: sha, confirmed: true })));
  });
});
