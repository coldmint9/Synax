import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { projectApi, type GitWorkspaceSummary } from "../../../../lib/api/project";
import { GitWorkspacePicker } from "../GitWorkspacePicker";

vi.mock("../../../../lib/api/project", () => ({ projectApi: { listGitWorkspaces: vi.fn() } }));
vi.mock("../../../../hooks/useLocale", () => ({ useLocale: () => ({ locale: "en" }) }));
const summary: GitWorkspaceSummary = {
  repositoryRoot: "/repo", defaultPath: "/repo", commits: [],
  branches: [
    { name: "main", head: "abc123456789", checkedOutPath: "/repo", upstream: null },
    { name: "feature/ui", head: "def123456789", checkedOutPath: null, upstream: "origin/feature/ui" },
  ],
  worktrees: [{ path: "/repo", head: "abc123456789", branch: "main", detached: false, primary: true, locked: false, prunable: false, managed: false, dirty: true, sessionCount: 1 }],
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(projectApi.listGitWorkspaces).mockResolvedValue(summary);
});

it("preserves default, worktree and managed-branch detail and selects with Headless keyboard navigation", async () => {
  const user = userEvent.setup(), change = vi.fn();
  const { container } = render(<GitWorkspacePicker projectId="p" value={{ kind: "default" }} disabled={false} onChange={change} />);
  const trigger = screen.getByRole("button", { name: "Git workspace" });
  await waitFor(() => expect(trigger).toBeEnabled());
  await user.tab();
  await user.keyboard(" ");
  const list = await screen.findByRole("listbox", { name: "Workspace options" });
  expect(container).not.toContainElement(list);
  expect(screen.getAllByRole("option")).toHaveLength(4);
  expect(screen.getByRole("option", { name: "main" })).toHaveTextContent("Primary worktree · HEAD abc12345 · Dirty");
  expect(screen.getByRole("option", { name: "feature/ui" })).toHaveTextContent("A managed worktree will be used");
  const search = screen.getByRole("combobox", { name: "Search workspaces" });
  await user.keyboard("{End}");
  await waitFor(() => expect(search).toHaveAttribute("aria-activedescendant", screen.getByRole("option", { name: "feature/ui" }).id));
  await user.keyboard("{Enter}");
  expect(change).toHaveBeenCalledExactlyOnceWith({ kind: "branch", branch: "feature/ui" });
  expect(trigger).toHaveFocus();
  await user.click(trigger);
  await user.click(screen.getByRole("option", { name: "main" }));
  expect(change).toHaveBeenLastCalledWith({ kind: "worktree", path: "/repo" });
});

it("does not allow selecting a workspace while disabled and hides unavailable repositories", async () => {
  const change = vi.fn();
  const view = render(<GitWorkspacePicker projectId="p" value={{ kind: "default" }} disabled onChange={change} />);
  await waitFor(() => expect(projectApi.listGitWorkspaces).toHaveBeenCalledWith("p"));
  await userEvent.click(screen.getByRole("button", { name: "Git workspace" }));
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  expect(change).not.toHaveBeenCalled();
  vi.mocked(projectApi.listGitWorkspaces).mockRejectedValue(new Error("Not a Git repository"));
  view.rerender(<GitWorkspacePicker projectId="other" value={{ kind: "default" }} disabled={false} onChange={change} />);
  await waitFor(() => expect(screen.queryByRole("button", { name: "Git workspace" })).not.toBeInTheDocument());
});

it('offers a fresh detached worktree first and filters workspaces without changing selection', async () => {
  const user = userEvent.setup(), change = vi.fn();
  render(<GitWorkspacePicker projectId="p" value={{ kind: "default" }} disabled={false} onChange={change} />);
  const trigger = screen.getByRole('button', { name: 'Git workspace' });
  await waitFor(() => expect(trigger).toBeEnabled());
  await user.click(trigger);
  const search = screen.getByRole('combobox', { name: 'Search workspaces' });
  const options = await screen.findAllByRole('option');
  expect(options[0]).toHaveTextContent('Start in a new worktree');
  expect(options[0]).toHaveTextContent('HEAD');
  await user.type(search, 'feature/ui');
  expect(screen.getAllByRole('option')).toHaveLength(1);
  expect(change).not.toHaveBeenCalled();
  await user.clear(search);
  await user.click(screen.getByRole('option', { name: /Start in a new worktree/ }));
  expect(change).toHaveBeenCalledExactlyOnceWith({ kind: 'new-worktree' });
});
