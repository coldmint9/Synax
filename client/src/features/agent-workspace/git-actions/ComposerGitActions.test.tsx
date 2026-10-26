import {
  act,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { beforeEach, describe, it, expect, vi } from "vitest";
const git = vi.hoisted(() => ({ repositories: [] as Array<{ status: string; dirty: boolean; unpushedCommitCount?: number }> }));
vi.mock("../workspaceGitStore", () => ({
  useWorkspaceGit: () => git,
}));
vi.mock("./GitActionDialog", () => ({
  default: ({ intent, session, onTaskReady }: any) => (
    <div role="dialog" aria-label={intent}>
      <span>{session.id}</span>
      <button onClick={onTaskReady}>Done</button>
    </div>
  ),
}));
vi.mock("../SessionCommitDialog", () => ({
  SessionCommitDialog: ({ sessionId, onClose }: any) => (
    <div role="dialog" aria-label="commit">
      <span>{sessionId}</span>
      <button onClick={onClose}>Done</button>
    </div>
  ),
}));
vi.mock("../SessionPushDialog", () => ({
  SessionPushDialog: ({ sessionId, rootId, repositories, onClose }: any) => (
    <div role="dialog" aria-label="push"><span>{sessionId}</span><span>{rootId}</span><span>{repositories?.length} repositories</span><button onClick={onClose}>Done</button></div>
  ),
}));
import ComposerGitActions from "./ComposerGitActions";
import type { AgentSession } from "../../../adapters/transport/agentRuntime";
const session = { id: "owner", projectId: "p" } as AgentSession;
beforeEach(() => {
  git.repositories = [{ status: "ready", dirty: true, unpushedCommitCount: 1 }];
});
describe("explicit composer Git entries", () => {
  it("renders Commit and PR when both have pending work without creating sessions until clicked", async () => {
    const ensure = vi.fn().mockResolvedValue(session);
    const open = vi.fn();
    render(
      <ComposerGitActions
        projectId="p"
        ensureSession={ensure}
        onOpenConversation={open}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Commit", exact: true }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "PR", exact: true }),
    ).toBeVisible();
    expect(ensure).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "PR", exact: true }));
    expect(await screen.findByRole("dialog", { name: "pr" })).toHaveTextContent(
      "owner",
    );
    expect(ensure).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("Done"));
    expect(open).toHaveBeenCalledWith("owner");
  });
  it.each([
    [false, 0, false, false],
    [true, 0, true, false],
    [false, 2, false, true],
    [true, 2, true, true],
    [false, undefined, false, false],
  ])("shows the matching actions for dirty=%s and unpushed=%s", (dirty, unpushedCommitCount, commitVisible, prVisible) => {
    git.repositories = [{ status: "ready", dirty, unpushedCommitCount }];
    const { container } = render(<ComposerGitActions projectId="p" ensureSession={vi.fn()} onOpenConversation={vi.fn()} />);
    expect(Boolean(screen.queryByRole("button", { name: "Commit", exact: true }))).toBe(commitVisible);
    expect(Boolean(screen.queryByRole("button", { name: "PR", exact: true }))).toBe(prVisible);
    expect(Boolean(screen.queryByRole("button", { name: "Push", exact: true }))).toBe(prVisible);
    if (!commitVisible && !prVisible) expect(container).toBeEmptyDOMElement();
  });
  it("hides actions until a usable repository is available", () => {
    git.repositories = [];
    const props = { projectId: "p", ensureSession: vi.fn(), onOpenConversation: vi.fn() };
    const { container, rerender } = render(<ComposerGitActions {...props} />);
    expect(container).toBeEmptyDOMElement();
    git.repositories = [{ status: "error", dirty: true, unpushedCommitCount: 2 }];
    rerender(<ComposerGitActions {...props} />);
    expect(container).toBeEmptyDOMElement();
  });
  it("updates actions after commit and push while preserving an open panel", async () => {
    git.repositories = [{ status: "ready", dirty: true, unpushedCommitCount: 0 }];
    const props = { session, projectId: "p", ensureSession: vi.fn(), onOpenConversation: vi.fn() };
    const { rerender } = render(<ComposerGitActions {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Commit", exact: true }));
    await screen.findByRole("dialog", { name: "commit" });
    git.repositories = [{ status: "ready", dirty: false, unpushedCommitCount: 1 }];
    rerender(<ComposerGitActions {...props} />);
    expect(screen.queryByRole("button", { name: "Commit", exact: true })).toBeNull();
    expect(screen.getByRole("button", { name: "PR", exact: true })).toBeVisible();
    expect(screen.getByRole("dialog", { name: "commit" })).toBeVisible();
    fireEvent.click(screen.getByText("Done"));
    git.repositories = [{ status: "ready", dirty: false, unpushedCommitCount: 0 }];
    rerender(<ComposerGitActions {...props} />);
    expect(screen.queryByRole("group", { name: "Git 操作" })).toBeNull();
  });
  it("checks all workspace repositories", () => {
    git.repositories = [
      { status: "ready", dirty: false, unpushedCommitCount: 0 },
      { status: "ready", dirty: true, unpushedCommitCount: 1 },
    ];
    render(<ComposerGitActions projectId="p" ensureSession={vi.fn()} onOpenConversation={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Commit", exact: true })).toBeVisible();
    expect(screen.getByRole("button", { name: "PR", exact: true })).toBeVisible();
  });
  it("opens Push review with all pending repositories and prefers the primary root", async () => {
    git.repositories = [
      { status: "ready", dirty: false, unpushedCommitCount: 1, rootId: "reference", role: "reference" },
      { status: "ready", dirty: false, unpushedCommitCount: 2, rootId: "primary", role: "primary" },
    ] as typeof git.repositories;
    const ensure = vi.fn().mockResolvedValue(session);
    render(<ComposerGitActions projectId="p" ensureSession={ensure} onOpenConversation={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Push", exact: true }));
    const dialog = await screen.findByRole("dialog", { name: "push" });
    expect(dialog).toHaveTextContent("primary");
    expect(dialog).toHaveTextContent("2 repositories");
    expect(ensure).toHaveBeenCalledTimes(1);
  });
  it("uses the existing owner and blocks history/running actions", async () => {
    const ensure = vi.fn();
    const { rerender } = render(
      <ComposerGitActions
        session={session}
        projectId="p"
        ensureSession={ensure}
        onOpenConversation={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Commit", exact: true }),
    );
    await screen.findByRole("dialog", { name: "commit" });
    expect(ensure).not.toHaveBeenCalled();
    rerender(
      <ComposerGitActions
        session={session}
        projectId="p"
        disabled
        ensureSession={ensure}
        onOpenConversation={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: "PR", exact: true }),
    ).toBeDisabled();
  });
  it("does not open a stale workspace after async creation", async () => {
    let resolve!: (s: AgentSession) => void;
    const ensure = vi.fn(
      () =>
        new Promise<AgentSession>((r) => {
          resolve = r;
        }),
    );
    const { rerender } = render(
      <ComposerGitActions
        projectId="p"
        ensureSession={ensure}
        onOpenConversation={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "PR", exact: true }));
    rerender(
      <ComposerGitActions
        projectId="other"
        ensureSession={ensure}
        onOpenConversation={vi.fn()}
      />,
    );
    await act(async () => resolve(session));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
