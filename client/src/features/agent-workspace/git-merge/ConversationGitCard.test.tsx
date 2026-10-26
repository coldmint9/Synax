import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationGitSnapshot } from "../../../adapters/transport/conversationGit";
import type { SessionLiveEvent } from "../../../adapters/transport/sessionLive";
const store = vi.hoisted(() => ({ ingestConversationMessages: vi.fn() }));
const scope = vi.hoisted(() => ({
  sessionId: "session-a",
  workspacePath: "/repo",
  roots: [],
}));
const live = vi.hoisted(() => ({
  handler: null as ((event: SessionLiveEvent) => void) | null,
  release: vi.fn(),
}));
const editor = vi.hoisted(() => ({ flush: vi.fn(async () => true) }));
vi.mock("../SessionTranscriptContext", () => ({
  useTranscriptSession: () => scope,
}));
vi.mock("../state/agentSessionStore", () => ({
  useAgentSessionStore: (select: (value: typeof store) => unknown) =>
    select(store),
}));
vi.mock("../workspaceRefresh", () => ({ refreshWorkspace: vi.fn() }));
vi.mock("../../../adapters/transport/sessionLiveClient", () => ({
  addSessionLiveListener: (_: string, handler: typeof live.handler) => {
    live.handler = handler;
    return live.release;
  },
}));
vi.mock("../../../adapters/transport/conversationGit", () => ({
  conversationGitApi: {
    get: vi.fn(),
    action: vi.fn(),
    file: vi.fn(),
    saveFile: vi.fn(),
  },
}));
vi.mock("../../../shared/ui/file-viewer/FileViewerDialog", async () => {
  const { useEffect } = await import("react");
  return {
    FileViewerDialog: ({
      file,
      readOnly,
      onSave,
      onClose,
      controls,
      registerDraftFlush,
    }: any) => {
      useEffect(() => {
        registerDraftFlush?.(editor.flush);
        return () => registerDraftFlush?.(null);
      }, []);
      return (
        <div role="dialog" aria-label="合并编辑器">
          <span>{file.path}</span>
          <button
            disabled={readOnly}
            onClick={() =>
              onSave({
                expectedRevision: file.revision,
                content: "edited",
                resolve: false,
              })
            }
          >
            保存草稿
          </button>
          <button onClick={onClose}>关闭编辑器</button>
          {controls}
        </div>
      );
    },
  };
});
import ConversationGitCard from "./ConversationGitCard";
import { conversationGitApi } from "../../../adapters/transport/conversationGit";
import { refreshWorkspace } from "../workspaceRefresh";
const reference = {
  schema: "synax.git-merge",
  schemaVersion: 1,
  objectId: "task-1",
  sessionId: "session-a",
  projectId: "project",
  rootId: "root",
  title: "智能合并",
} as const;
const file = {
  id: "file-1",
  path: "src/auth.ts",
  status: "U",
  conflicted: true,
  kind: "text" as const,
  base: "base",
  target: "target",
  source: "source",
  result: "<<<<<<< HEAD\ntarget\n=======\nsource\n>>>>>>> branch",
  revision: "rev-1",
  targetExists: true,
  sourceExists: true,
  baseExists: true,
};
function snapshot(
  status: NonNullable<
    ConversationGitSnapshot["execution"]
  >["status"] = "running",
): ConversationGitSnapshot {
  return {
    reference,
    task: {
      id: reference.objectId,
      sessionId: reference.sessionId,
      projectId: reference.projectId,
      rootId: reference.rootId,
      mrId: "mr-1",
      previousMrIds: [],
      messageId: "anchor",
      createdAt: "2026-10-23",
      updatedAt: "2026-10-23",
      revision: 2,
    },
    mr: {
      id: "mr-1",
      projectId: "project",
      title: reference.title,
      target: "main",
      targetOid: "target",
      strategy: "merge_commit",
      steps: [
        { branch: "feature/session", oid: "source", status: "conflicted" },
      ],
      status: "conflicted",
      version: 7,
      currentStep: 0,
      repository: "/repo",
      commonDir: "/repo/.git",
      createdAt: "2026-10-23",
      updatedAt: "2026-10-23",
      checks: [],
      checkResults: [],
      autoFinalize: false,
      allowCheckedOutTarget: false,
      events: [],
    },
    execution: {
      status,
      phase: "resolving",
      childSessionId: "child",
      joinMode: "blocking",
      revision: 1,
      epoch: 1,
      updatedAt: "2026-10-23",
      summary: "正在解决冲突",
    },
    files: [file],
    proposals: [],
    commits: [],
    stale: false,
    messages: [],
  };
}
const mount = (readOnly = false) =>
  render(<ConversationGitCard reference={reference} readOnly={readOnly} />);
const emit = (event: SessionLiveEvent) =>
  act(() => {
    live.handler?.(event);
  });
beforeEach(() => {
  vi.clearAllMocks();
  scope.sessionId = "session-a";
  live.handler = null;
  editor.flush.mockResolvedValue(true);
  vi.mocked(conversationGitApi.get).mockResolvedValue(snapshot());
  vi.mocked(conversationGitApi.file).mockResolvedValue(file);
  vi.mocked(conversationGitApi.action).mockResolvedValue(snapshot("paused"));
  vi.mocked(conversationGitApi.saveFile).mockResolvedValue(snapshot("paused"));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("conversation merge workbench", () => {
  describe("merge graph visibility and execution state", () => {
    const withCommits = (value = snapshot()) => ({
      ...value,
      commits: [
        { oid: "target", parents: ["base"], subject: "Target change",
          refs: ["main"], author: "A", date: "2026-10-23" },
        { oid: "source", parents: ["base"], subject: "Source change",
          refs: ["feature/session"], author: "B", date: "2026-10-23" },
        { oid: "base", parents: [], subject: "Common base",
          refs: [], author: "A", date: "2026-10-22" },
      ],
    });
    beforeEach(() => {
      // Treat the rendered graph as visible; observer lifecycle is covered in CommitGraph.test.tsx.
      vi.stubGlobal("IntersectionObserver", undefined);
      vi.mocked(conversationGitApi.get).mockResolvedValue(withCommits());
    });
    afterEach(() => vi.unstubAllGlobals());

    it("shows the animated merge preview above files without expanding history", async () => {
      const { container } = mount();
      const graph = await screen.findByRole("region", { name: "提交关系与待合并预览" });
      expect(graph).toBeVisible();
      expect(graph.closest("details")).toBeNull();
      expect(within(graph).getByText("待合并")).toBeVisible();
      expect(graph.querySelectorAll("path.is-pending")).toHaveLength(2);
      await waitFor(() => expect(graph).toHaveAttribute("data-motion", "running"));
      expect(
        graph.compareDocumentPosition(container.querySelector(".conversation-git-files")!),
      ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    });

    it("pauses and resumes the visible preview with execution controls", async () => {
      vi.mocked(conversationGitApi.action)
        .mockResolvedValueOnce(withCommits(snapshot("paused")))
        .mockResolvedValueOnce(withCommits());
      mount();
      const graph = await screen.findByRole("region", { name: "提交关系与待合并预览" });
      await waitFor(() => expect(graph).toHaveAttribute("data-motion", "running"));
      fireEvent.click(screen.getByRole("button", { name: "停止" }));
      await screen.findByRole("button", { name: "继续" });
      expect(graph).toHaveAttribute("data-motion", "paused");
      expect(within(graph).getByText("待合并")).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: "继续" }));
      await waitFor(() => expect(graph).toHaveAttribute("data-motion", "running"));
    });

    it.each(["queued", "pausing", "paused", "waiting_user", "failed", "recovery_required", "cancelling"] as const)(
      "keeps the preview static while execution is %s",
      async (status) => {
        vi.mocked(conversationGitApi.get).mockResolvedValue(withCommits(snapshot(status)));
        mount();
        const graph = await screen.findByRole("region", { name: "提交关系与待合并预览" });
        expect(graph).toBeVisible();
        expect(graph).toHaveAttribute("data-motion", "paused");
      },
    );

    it("keeps read-only history static and removes stale merge projections", async () => {
      const view = mount(true);
      const graph = await screen.findByRole("region", { name: "提交关系与待合并预览" });
      expect(graph).toHaveAttribute("data-motion", "paused");
      view.unmount();
      vi.mocked(conversationGitApi.get).mockResolvedValue({ ...withCommits(), stale: true });
      mount();
      const staleGraph = await screen.findByRole("region", { name: "提交关系与待合并预览" });
      expect(staleGraph).toHaveAttribute("data-motion", "paused");
      expect(staleGraph.querySelector(".is-pending")).toBeNull();
    });

    it("replaces the preview with actual commit history after a completion event", async () => {
      const { container } = mount();
      await screen.findByText("待合并");
      const completed = withCommits(snapshot("completed"));
      completed.task.revision = 3;
      completed.mr.version = 8;
      completed.mr.status = "merged";
      completed.mr.candidateOid = "merged";
      completed.commits.unshift({
        oid: "merged", parents: ["target", "source"], subject: "Merged changes",
        refs: ["main"], author: "A", date: "2026-10-23",
      });
      vi.mocked(conversationGitApi.get).mockResolvedValue(completed);
      emit({
        type: "conversation_git_state", taskId: reference.objectId,
        taskRevision: 3, mrVersion: 8, status: "merged", eventSeq: 3,
        execution: completed.execution,
      });
      await waitFor(() => expect(container.querySelector(".is-pending")).toBeNull());
      expect(container.querySelector(".conversation-git-history")).not.toHaveAttribute("open");
      fireEvent.click(screen.getByText("提交关系"));
      expect(await screen.findByText("Merged changes")).toBeVisible();
      expect(screen.getByRole("region", { name: "提交关系与待合并预览" })).toHaveAttribute("data-motion", "paused");
    });
  });

  it("opens a conflict file directly without the duplicate preview actions", async () => {
    mount();
    fireEvent.click(
      await screen.findByRole("button", { name: /src\/auth.ts 冲突/ }),
    );
    const dialog = await screen.findByRole("dialog", { name: "合并编辑器" });
    expect(
      within(dialog).getByRole("button", { name: "保存草稿" }),
    ).toBeDisabled();
    expect(screen.queryByText("对比两侧")).toBeNull();
    expect(screen.queryByText("生成解决建议")).toBeNull();
    expect(conversationGitApi.file).toHaveBeenCalledOnce();
  });
  it("exposes only pause/resume and cancel execution controls with both concurrency tokens", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "停止" }));
    await waitFor(() =>
      expect(conversationGitApi.action).toHaveBeenCalledWith(
        reference.sessionId,
        reference.objectId,
        expect.objectContaining({
          action: "pause",
          expectedVersion: 7,
          expectedTaskRevision: 2,
          requestId: expect.any(String),
        }),
      ),
    );
    expect(await screen.findByRole("button", { name: "继续" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "运行检查" })).toBeNull();
    expect(screen.queryByRole("button", { name: /确认更新/ })).toBeNull();
  });
  it("requires one explicit cancel decision and sends the terminal cancel command", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "取消" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认取消" }));
    await waitFor(() =>
      expect(conversationGitApi.action).toHaveBeenCalledWith(
        reference.sessionId,
        reference.objectId,
        expect.objectContaining({ action: "cancel" }),
      ),
    );
  });
  it("flushes the editor before resuming and keeps a failed draft paused", async () => {
    vi.mocked(conversationGitApi.get).mockResolvedValue(snapshot("paused"));
    editor.flush.mockResolvedValue(false);
    mount();
    fireEvent.click(
      await screen.findByRole("button", { name: /src\/auth.ts 冲突/ }),
    );
    const dialog = await screen.findByRole("dialog", { name: "合并编辑器" });
    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "继续" })).toBeEnabled(),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "继续" }));
    await waitFor(() => expect(editor.flush).toHaveBeenCalledOnce());
    expect(conversationGitApi.action).not.toHaveBeenCalled();
  });
  it("saves paused edits as drafts without marking a file resolved", async () => {
    vi.mocked(conversationGitApi.get).mockResolvedValue(snapshot("paused"));
    mount();
    fireEvent.click(
      await screen.findByRole("button", { name: /src\/auth.ts 冲突/ }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "保存草稿" }));
    await waitFor(() =>
      expect(conversationGitApi.saveFile).toHaveBeenCalledWith(
        reference.sessionId,
        reference.objectId,
        file.id,
        expect.objectContaining({
          content: "edited",
          resolve: false,
          expectedRevision: "rev-1",
          expectedVersion: 7,
          expectedTaskRevision: 2,
        }),
      ),
    );
  });
  it("projects a burst of state events without fetching a snapshot per event", async () => {
    mount();
    await screen.findByRole("button", { name: "停止" });
    act(() => {
      for (let i = 0; i < 1000; i++)
        live.handler?.({
          type: "conversation_git_state",
          taskId: reference.objectId,
          taskRevision: i + 3,
          mrVersion: 7,
          status: "conflicted",
          eventSeq: i + 2,
          execution: {
            ...snapshot().execution!,
            revision: i + 2,
            summary: `进度 ${i}`,
          },
        });
    });
    await waitFor(() =>
      expect(screen.getByText("进度 999")).toBeInTheDocument(),
    );
    expect(conversationGitApi.get).toHaveBeenCalledOnce();
    emit({
      type: "conversation_git_state",
      taskId: reference.objectId,
      taskRevision: 1,
      mrVersion: 1,
      status: "conflicted",
      eventSeq: 1,
      execution: snapshot("paused").execution,
    });
    expect(screen.getByRole("button", { name: "停止" })).toBeEnabled();
  });
  it("performs a followup read when reconnect arrives during the first snapshot", async () => {
    let finish!: (value: ConversationGitSnapshot) => void;
    vi.mocked(conversationGitApi.get)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue(snapshot("paused"));
    mount();
    emit({ type: "domain_reconnected", sessionId: reference.sessionId });
    await act(async () => finish(snapshot()));
    await screen.findByRole("button", { name: "继续" });
    expect(conversationGitApi.get).toHaveBeenCalledTimes(2);
  });
  it("rebuilds a reconnect manifest then replays concurrent deltas instead of losing missed files", async () => {
    const initial = snapshot();
    initial.files = [
      { ...file, id: "a", path: "a.ts" },
      { ...file, id: "b", path: "b.ts" },
    ];
    let complete!: (value: ConversationGitSnapshot) => void;
    vi.mocked(conversationGitApi.get)
      .mockResolvedValueOnce(initial)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
      );
    mount();
    await screen.findByRole("button", { name: /a.ts 冲突/ });
    emit({ type: "domain_reconnected", sessionId: reference.sessionId });
    emit({
      type: "conversation_git_state",
      taskId: reference.objectId,
      taskRevision: 11,
      mrVersion: 11,
      eventSeq: 11,
      status: "conflicted",
      changedFiles: [{ ...file, id: "b", path: "b.ts", conflicted: false }],
    });
    const recovered = snapshot();
    recovered.task.revision = 10;
    recovered.mr.version = 10;
    recovered.files = [
      { ...file, id: "a", path: "a.ts", conflicted: false },
      { ...file, id: "b", path: "b.ts" },
      { ...file, id: "c", path: "c.ts" },
    ];
    await act(async () => complete(recovered));
    expect(
      await screen.findByRole("button", { name: /a.ts 已解决/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /b.ts 已解决/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /c.ts 冲突/ }),
    ).toBeInTheDocument();
  });
  it("rejects a late manifest before it can downgrade the snapshot file watermark", async () => {
    const newest = snapshot();
    newest.task.revision = 20;
    newest.mr.version = 20;
    newest.files = [{ ...file, id: "a", path: "a.ts", conflicted: false }];
    const older = snapshot();
    older.task.revision = 17;
    older.mr.version = 17;
    older.files = [{ ...file, id: "a", path: "a.ts", conflicted: true }];
    vi.mocked(conversationGitApi.get)
      .mockResolvedValueOnce(newest)
      .mockResolvedValueOnce(older);
    mount();
    await screen.findByRole("button", { name: /a.ts 已解决/ });
    emit({
      type: "conversation_git_state",
      taskId: reference.objectId,
      taskRevision: 15,
      mrVersion: 15,
      eventSeq: 15,
      status: "conflicted",
      files: [{ ...file, id: "a", path: "a.ts", conflicted: true }],
    });
    emit({ type: "domain_reconnected", sessionId: reference.sessionId });
    await waitFor(() =>
      expect(conversationGitApi.get).toHaveBeenCalledTimes(2),
    );
    await act(async () => Promise.resolve());
    expect(
      screen.getByRole("button", { name: /a.ts 已解决/ }),
    ).toBeInTheDocument();
  });
  it("applies file changes incrementally and coalesces refreshes for the open file", async () => {
    mount();
    fireEvent.click(
      await screen.findByRole("button", { name: /src\/auth.ts 冲突/ }),
    );
    await screen.findByRole("dialog", { name: "合并编辑器" });
    vi.useFakeTimers();
    act(() => {
      for (let index = 0; index < 100; index++)
        live.handler?.({
          type: "conversation_git_state",
          taskId: reference.objectId,
          taskRevision: index + 3,
          mrVersion: 8,
          status: "conflicted",
          eventSeq: index + 2,
          changedFiles: [{ ...file, conflicted: false }],
          changedFileIds: [file.id],
        });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(conversationGitApi.file).toHaveBeenCalledTimes(2);
    expect(conversationGitApi.get).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("button", { name: /src\/auth.ts 已解决/ }),
    ).toBeInTheDocument();
  });
  it("does not poll and releases subscriptions and pending reads on unmount", async () => {
    const view = mount();
    await screen.findByRole("button", { name: "停止" });
    vi.useFakeTimers();
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(conversationGitApi.get).toHaveBeenCalledOnce();
    vi.useRealTimers();
    view.unmount();
    expect(live.release).toHaveBeenCalledOnce();
  });
  it("retains action receipts when the view closes before the response", async () => {
    let finish!: (value: ConversationGitSnapshot) => void;
    vi.mocked(conversationGitApi.action).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const view = mount();
    fireEvent.click(await screen.findByRole("button", { name: "停止" }));
    view.unmount();
    await act(async () => finish(snapshot("paused")));
    expect(store.ingestConversationMessages).toHaveBeenCalledWith(
      reference.sessionId,
      [],
    );
    expect(refreshWorkspace).toHaveBeenCalled();
  });
  it("virtualizes repository-sized file lists and only loads the selected file", async () => {
    const value = snapshot();
    value.files = Array.from({ length: 1200 }, (_, index) => ({
      id: `f${index}`,
      path: `file-${index}.ts`,
      status: "UU",
      conflicted: true,
    }));
    vi.mocked(conversationGitApi.get).mockResolvedValue(value);
    mount();
    await screen.findByRole("button", { name: /file-0.ts 冲突/ });
    expect(
      screen.getAllByRole("button", { name: /file-\d+.ts 冲突/ }).length,
    ).toBeLessThan(20);
    expect(conversationGitApi.file).not.toHaveBeenCalled();
  });
  it("keeps history and a foreign session from issuing execution commands", async () => {
    const view = mount(true);
    await screen.findByText("正在解决冲突");
    expect(screen.queryByRole("button", { name: "停止" })).toBeNull();
    view.unmount();
    scope.sessionId = "other";
    mount();
    expect(screen.getByText(/另一个会话/)).toBeInTheDocument();
    expect(conversationGitApi.action).not.toHaveBeenCalled();
  });
});

 it('expires a stale timeline position after fetching a newer task anchor', async () => {
  const current = snapshot('running');
  current.task.messageId = 'resumed-anchor';
  vi.mocked(conversationGitApi.get).mockResolvedValue(current);
  render(<ConversationGitCard reference={reference} messageId="original-anchor" />);
  expect(await screen.findByRole('note', { name: '已过期的合并任务卡片' })).toBeVisible();
  expect(screen.queryByRole('group', { name: '智能合并控制' })).toBeNull();
});
