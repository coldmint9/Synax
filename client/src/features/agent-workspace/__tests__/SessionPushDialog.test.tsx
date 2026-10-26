import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useShellStore } from "../../../shared/state/shellStore";

const listSessionWorkspaceCommits = vi.fn();
const pushSessionWorkspace = vi.fn();

vi.mock("../../../adapters/transport/agentRuntime", () => ({
  agentRuntimeApi: {
    listSessionWorkspaceCommits: (...args: unknown[]) =>
      listSessionWorkspaceCommits(...args),
    pushSessionWorkspace: (...args: unknown[]) => pushSessionWorkspace(...args),
  },
}));

const { SessionPushDialog } = await import("../SessionPushDialog");

describe("SessionPushDialog", () => {
  beforeEach(() => {
    listSessionWorkspaceCommits.mockReset();
    pushSessionWorkspace.mockReset();
    useShellStore.setState((state) => ({
      preferences: { ...state.preferences, locale: "zh" },
    }));
  });

  it("loads and reviews the commits before pushing", async () => {
    listSessionWorkspaceCommits.mockResolvedValue({
      rootId: "primary",
      branch: "feature/push-review",
      headCommitSha: "1234567890abcdef",
      upstream: "origin/feature/push-review",
      commits: [
        {
          sha: "1234567890abcdef",
          subject: "feat: add push review",
          body: "",
          author: "Test User",
          email: "test@example.com",
          authoredAt: "2026-10-26T06:00:00Z",
        },
      ],
    });
    pushSessionWorkspace.mockResolvedValue({
      rootId: "primary",
      branch: "feature/push-review",
      pushed: true,
      upstream: "origin/feature/push-review",
    });
    const onClose = vi.fn();
    const onPushed = vi.fn();
    render(
      <SessionPushDialog
        isOpen
        sessionId="session-1"
        rootId="primary"
        rootName="API"
        branch="feature/push-review"
        pendingCount={1}
        onClose={onClose}
        onPushed={onPushed}
      />,
    );

    expect(await screen.findByText("feat: add push review")).toBeInTheDocument();
    expect(screen.getByText("12345678")).toBeInTheDocument();
    expect(screen.getByText("origin/feature/push-review")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "仅推送" }));
    await waitFor(() =>
      expect(pushSessionWorkspace).toHaveBeenCalledWith("session-1", {
        rootId: "primary",
        expectedHeadSha: "1234567890abcdef",
        expectedBranch: "feature/push-review",
        expectedUpstream: "origin/feature/push-review",
      }),
    );
    await waitFor(() => expect(onPushed).toHaveBeenCalledTimes(1));
    expect(screen.getByText("提交已推送到远程分支。")).toBeInTheDocument();
  });
  it.each(["error", "empty"])("does not push an unreviewed %s response even with a stale positive count", async (mode) => {
    if (mode === "error") listSessionWorkspaceCommits.mockRejectedValue(new Error("Cannot load commits"));
    else listSessionWorkspaceCommits.mockResolvedValue({ rootId: "primary", branch: "main", headCommitSha: "a".repeat(40), upstream: "origin/main", commits: [] });
    render(<SessionPushDialog isOpen sessionId="s" rootId="primary" branch="main" pendingCount={5} onClose={vi.fn()} onPushed={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText("正在读取待推送提交…")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "仅推送" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "仅推送" }));
    expect(pushSessionWorkspace).not.toHaveBeenCalled();
    listSessionWorkspaceCommits.mockResolvedValue({ rootId: "primary", branch: "main", headCommitSha: "a".repeat(40), upstream: "origin/main", commits: [] });
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() => expect(listSessionWorkspaceCommits).toHaveBeenCalledTimes(2));
  });

  it("ignores a stale repository response after switching roots", async () => {
    let resolve!: (value: unknown) => void;
    listSessionWorkspaceCommits.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    listSessionWorkspaceCommits.mockResolvedValueOnce({ rootId: "second", branch: "web", headCommitSha: "b".repeat(40), upstream: "origin/web", commits: [] });
    const props = { isOpen: true, sessionId: "s", branch: "main", onClose: vi.fn(), onPushed: vi.fn() };
    const { rerender } = render(<SessionPushDialog {...props} rootId="primary" />);
    rerender(<SessionPushDialog {...props} rootId="second" />);
    await screen.findByText("origin/web");
    await act(async () => resolve({ rootId: "primary", branch: "main", upstream: "origin/main", commits: [] }));
    expect(screen.queryByText("origin/main")).not.toBeInTheDocument();
    expect(listSessionWorkspaceCommits.mock.calls[0][2].aborted).toBe(true);
  });

});

