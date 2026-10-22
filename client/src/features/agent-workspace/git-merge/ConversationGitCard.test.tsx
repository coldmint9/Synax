import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationGitSnapshot } from "../../../adapters/transport/conversationGit";
import { AppError } from "../../../shared/lib/appError";

const store = vi.hoisted(() => ({
  ingestConversationMessages: vi.fn(),
  submitOrEnqueueSessionInput: vi.fn().mockResolvedValue("sent"),
}));
const scope = vi.hoisted(() => ({
  sessionId: "session-a",
  workspacePath: "/repo",
  roots: [],
}));
vi.mock("../SessionTranscriptContext", () => ({
  useTranscriptSession: () => scope,
}));
vi.mock("../state/agentSessionStore", () => ({
  useAgentSessionStore: (select: (value: typeof store) => unknown) =>
    select(store),
}));
vi.mock("../workspaceRefresh", () => ({ refreshWorkspace: vi.fn() }));
vi.mock("../../../adapters/transport/conversationGit", () => ({
  conversationGitApi: {
    get: vi.fn(),
    action: vi.fn(),
    file: vi.fn(),
    saveFile: vi.fn(),
    applyProposal: vi.fn(),
  },
}));
vi.mock("../../../shared/ui/file-viewer/FileViewerDialog", () => ({
  FileViewerDialog: ({ file, readOnly, onSave, onClose }: any) => (
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
    </div>
  ),
}));

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
  title: "合并会话刷新",
} as const;
function snapshot(
  status: ConversationGitSnapshot["mr"]["status"] = "draft",
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
      createdAt: "2026-10-22T00:00:00Z",
      updatedAt: "2026-10-22T00:00:00Z",
      revision: 2,
    },
    mr: {
      id: "mr-1",
      projectId: "project",
      rootId: "root",
      title: reference.title,
      target: "main",
      targetOid: "target",
      strategy: "merge_commit",
      steps: [{ branch: "feature/session", oid: "source", status: "pending" }],
      status,
      version: 7,
      currentStep: status === "ready" ? 1 : 0,
      candidateOid: "candidate",
      candidateTree: "tree",
      repository: "/repo",
      commonDir: "/repo/.git",
      createdAt: "2026-10-22",
      updatedAt: "2026-10-22",
      checks: [],
      checkResults: [],
      autoFinalize: false,
      allowCheckedOutTarget: false,
      events: [],
    },
    files: [],
    proposals: [],
    commits: [
      {
        oid: "source",
        parents: ["target"],
        subject: "刷新会话",
        author: "Mint",
        date: "2026-10-22",
        refs: ["feature/session"],
      },
      {
        oid: "target",
        parents: [],
        subject: "共同祖先",
        author: "Mint",
        date: "2026-10-21",
        refs: ["main"],
      },
    ],
    stale: false,
    messages: [],
  };
}
const file = {
  id: "file-1",
  path: "src/auth.ts",
  status: "U",
  conflicted: true,
  kind: "text" as const,
  base: "base",
  target: "target content",
  source: "source content",
  result: "unresolved",
  revision: "rev-1",
  targetExists: true,
  sourceExists: true,
  baseExists: true,
};
const mount = (readOnly = false) =>
  render(<ConversationGitCard reference={reference} readOnly={readOnly} />);
beforeEach(() => {
  vi.clearAllMocks();
  scope.sessionId = "session-a";
  vi.mocked(conversationGitApi.get).mockResolvedValue(snapshot());
  vi.mocked(conversationGitApi.file).mockResolvedValue(file);
  store.submitOrEnqueueSessionInput.mockResolvedValue("sent");
});

describe("conversation Git task", () => {
  it("keeps one task card while preparing and uses both concurrency versions", async () => {
    const next = snapshot("conflicted");
    next.files = [file];
    next.messages = [
      {
        id: "receipt",
        sessionId: "session-a",
        runId: null,
        stepId: null,
        role: "assistant",
        content: "已准备",
        metadata: {},
        createdAt: "now",
      },
    ];
    vi.mocked(conversationGitApi.action).mockResolvedValue(next);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "开始分析" }));
    await waitFor(() =>
      expect(conversationGitApi.action).toHaveBeenCalledWith(
        "session-a",
        "task-1",
        expect.objectContaining({
          action: "prepare",
          expectedVersion: 7,
          expectedTaskRevision: 2,
          requestId: expect.any(String),
        }),
      ),
    );
    expect(
      await screen.findByRole("button", { name: /src\/auth.ts 冲突/ }),
    ).toBeInTheDocument();
    expect(document.querySelectorAll('[data-object-id="task-1"]')).toHaveLength(
      1,
    );
    expect(store.ingestConversationMessages).toHaveBeenCalledWith(
      "session-a",
      next.messages,
    );
    expect(refreshWorkspace).toHaveBeenCalledWith("session-a", "root");
  });
  it("does not request or mutate a task belonging to another transcript", async () => {
    scope.sessionId = "other";
    mount();
    expect(screen.getByText(/此任务属于另一个会话/)).toBeInTheDocument();
    expect(conversationGitApi.get).not.toHaveBeenCalled();
    expect(conversationGitApi.action).not.toHaveBeenCalled();
  });
  it("makes history read-only and does not submit assistant requests", async () => {
    mount(true);
    expect(
      await screen.findByRole("button", { name: "开始分析" }),
    ).toBeDisabled();
    expect(screen.queryByRole("button", { name: "让助手解释" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "开始分析" }));
    expect(conversationGitApi.action).not.toHaveBeenCalled();
  });
  it("requires explicit confirmation when checks are absent", async () => {
    vi.mocked(conversationGitApi.get).mockResolvedValue(snapshot("ready"));
    vi.mocked(conversationGitApi.action).mockResolvedValue(snapshot("merged"));
    mount();
    fireEvent.click(
      await screen.findByRole("button", { name: "确认跳过检查" }),
    );
    expect(conversationGitApi.action).not.toHaveBeenCalled();
    expect(
      screen.getByText(/本任务没有配置检查，本次确认将跳过验证/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认更新本地 main" }));
    await waitFor(() =>
      expect(conversationGitApi.action).toHaveBeenCalledWith(
        "session-a",
        "task-1",
        expect.objectContaining({ action: "finalize" }),
      ),
    );
  });
  it("does not equate ready with tests passed", async () => {
    const value = snapshot("ready");
    value.mr.checks = [
      { id: "test", executable: "npm", args: ["test"], timeoutMs: 5000 },
    ];
    vi.mocked(conversationGitApi.get).mockResolvedValue(value);
    mount();
    expect(
      await screen.findByRole("button", { name: "运行检查" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "确认更新 main" }),
    ).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "确认更新 main" }));
    expect(screen.getByRole("button", { name: "确认更新本地 main" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "跳过验证检查，我已审阅候选改动" }));
    expect(screen.getByRole("button", { name: "确认更新本地 main" })).toBeEnabled();
    expect(screen.getByText("0/1 通过")).toBeInTheDocument();
  });
  it("renders stale recovery without offering publish", async () => {
    const value = snapshot("ready");
    value.stale = true;
    value.staleReason = "main moved";
    vi.mocked(conversationGitApi.get).mockResolvedValue(value);
    vi.mocked(conversationGitApi.action).mockResolvedValue(snapshot());
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "重新分析" }));
    await waitFor(() =>
      expect(conversationGitApi.action).toHaveBeenCalledWith(
        "session-a",
        "task-1",
        expect.objectContaining({ action: "replan", expectedTaskRevision: 2 }),
      ),
    );
  });
  it("saves a whole-file decision with the file, task and MR revisions", async () => {
    const value = snapshot("conflicted");
    value.files = [file];
    const saved = snapshot("conflicted");
    saved.files = [{ ...file, conflicted: false }];
    saved.mr.version = 8;
    vi.mocked(conversationGitApi.get).mockResolvedValue(value);
    vi.mocked(conversationGitApi.saveFile).mockResolvedValue(saved);
    mount();
    fireEvent.click(
      await screen.findByRole("button", { name: /src\/auth.ts 冲突/ }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "采用目标全文" }),
    );
    await waitFor(() =>
      expect(conversationGitApi.saveFile).toHaveBeenCalledWith(
        "session-a",
        "task-1",
        "file-1",
        expect.objectContaining({
          expectedRevision: "rev-1",
          expectedVersion: 7,
          expectedTaskRevision: 2,
          choice: "target",
          resolve: true,
        }),
      ),
    );
  });
  it("keeps a stale write error and refreshes authoritative state", async () => {
    vi.mocked(conversationGitApi.action).mockRejectedValue(
      new AppError("分支版本已过期", {
        level: "business",
        code: "STALE_VERSION",
        statusCode: 409,
      }),
    );
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "开始分析" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "分支版本已过期",
    );
    expect(conversationGitApi.get).toHaveBeenCalledTimes(2);
  });
  it("omits revision chrome, explanatory assistant actions and the stepper", async () => {
    mount();
    await screen.findByRole("button", { name: "开始分析" });
    expect(screen.queryByRole("button", { name: "让助手解释" })).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "合并任务进度" })).not.toBeInTheDocument();
    expect(screen.queryByText(/· v7|版本 2/)).not.toBeInTheDocument();
    expect(store.submitOrEnqueueSessionInput).not.toHaveBeenCalled();
  });
  it("sends an explicit verification bypass only after the user selects it", async () => {
    const value = snapshot("check_failed");
    value.mr.checks = [{ id: "unit", executable: "node", args: ["test"], timeoutMs: 1000 }];
    vi.mocked(conversationGitApi.get).mockResolvedValue(value);
    vi.mocked(conversationGitApi.action).mockResolvedValue(snapshot("merged"));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "确认更新 main" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "跳过验证检查，我已审阅候选改动" }));
    fireEvent.click(screen.getByRole("button", { name: "确认更新本地 main" }));
    await waitFor(() => expect(conversationGitApi.action).toHaveBeenCalledWith("session-a", "task-1", expect.objectContaining({ action: "finalize", skipChecks: true, expectedVersion: 7, expectedTaskRevision: 2 })));
  });
  it("keeps one renderer and state while opening and closing focus view", async () => {
    mount();
    fireEvent.click(
      await screen.findByRole("button", { name: "展开专注视图" }),
    );
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(document.querySelectorAll('[data-object-id="task-1"]')).toHaveLength(
      1,
    );
    fireEvent.click(screen.getByRole("button", { name: "关闭专注视图" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(conversationGitApi.get).toHaveBeenCalledTimes(1);
  });

  it("shows actual proposals but rejects a stale proposal revision", async () => {
    const value = snapshot("conflicted");
    value.files = [file];
    value.proposals = [
      {
        id: "proposal",
        mrId: "mr-1",
        fileId: file.id,
        revision: "older",
        content: "proposed",
        rationale: "保留两侧逻辑",
        createdAt: "2026-10-22",
      },
    ];
    vi.mocked(conversationGitApi.get).mockResolvedValue(value);
    mount();
    fireEvent.click(
      await screen.findByRole("button", { name: /src\/auth.ts 冲突/ }),
    );
    fireEvent.click(await screen.findByRole("tab", { name: "助手建议" }));
    expect(
      await screen.findByRole("button", { name: "采纳建议到草稿" }),
    ).toBeDisabled();
    expect(
      screen.getByText("此建议依据的文件已变化，请让助手重新生成。"),
    ).toBeInTheDocument();
    expect(conversationGitApi.applyProposal).not.toHaveBeenCalled();
  });

  it("saves a current proposal as a draft and never silently resolves it", async () => {
    const value = snapshot("conflicted");
    value.files = [file];
    value.proposals = [
      {
        id: "proposal",
        mrId: "mr-1",
        fileId: file.id,
        revision: file.revision,
        content: "proposed",
        rationale: "保留两侧逻辑",
        createdAt: "2026-10-22",
      },
    ];
    vi.mocked(conversationGitApi.get).mockResolvedValue(value);
    vi.mocked(conversationGitApi.applyProposal).mockResolvedValue({
      ...value,
      mr: { ...value.mr, version: 8 },
    });
    vi.mocked(conversationGitApi.file)
      .mockResolvedValueOnce(file)
      .mockResolvedValue({ ...file, result: "proposed", revision: "rev-2" });
    mount();
    fireEvent.click(
      await screen.findByRole("button", { name: /src\/auth.ts 冲突/ }),
    );
    fireEvent.click(await screen.findByRole("tab", { name: "助手建议" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "采纳建议到草稿" }),
    );
    await waitFor(() =>
      expect(conversationGitApi.applyProposal).toHaveBeenCalledWith(
        "session-a",
        "task-1",
        expect.objectContaining({
          proposalId: "proposal",
          expectedVersion: 7,
          expectedTaskRevision: 2,
        }),
      ),
    );
    expect(conversationGitApi.saveFile).not.toHaveBeenCalled();
    expect(await screen.findByText(/建议已保存为草稿/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("tab", { name: "当前结果" })).toHaveAttribute("aria-selected", "true"));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "确认此结果" })).toBeEnabled(),
    );
  });

  it("confirms a clean inline result with explicit resolve and content", async () => {
    const value = snapshot("conflicted");
    value.files = [file];
    vi.mocked(conversationGitApi.get).mockResolvedValue(value);
    vi.mocked(conversationGitApi.file).mockResolvedValue({
      ...file,
      result: "const clean = true;",
    });
    vi.mocked(conversationGitApi.saveFile).mockResolvedValue({
      ...value,
      files: [{ ...file, conflicted: false }],
    });
    mount();
    fireEvent.click(
      await screen.findByRole("button", { name: /src\/auth.ts 冲突/ }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "确认此结果" }));
    await waitFor(() =>
      expect(conversationGitApi.saveFile).toHaveBeenCalledWith(
        "session-a",
        "task-1",
        "file-1",
        expect.objectContaining({
          content: "const clean = true;",
          resolve: true,
          expectedRevision: "rev-1",
          expectedVersion: 7,
        }),
      ),
    );
  });

  it("does not confirm an inline result containing conflict markers", async () => {
    const value = snapshot("conflicted");
    value.files = [file];
    vi.mocked(conversationGitApi.get).mockResolvedValue(value);
    vi.mocked(conversationGitApi.file).mockResolvedValue({
      ...file,
      result: "<<<<<<< HEAD\nold\n=======\nnew\n>>>>>>> source",
    });
    mount();
    fireEvent.click(
      await screen.findByRole("button", { name: /src\/auth.ts 冲突/ }),
    );
    const confirm = await screen.findByRole("button", { name: "确认此结果" });
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(conversationGitApi.saveFile).not.toHaveBeenCalled();
    expect(screen.getByText(/仍有冲突标记/)).toBeInTheDocument();
  });

  it("shows compact check names and keeps the full command inside details", async () => {
    const value = snapshot("ready");
    value.mr.checks = [
      {
        id: "auth-regression",
        executable: "/usr/local/bin/node",
        args: ["--test", "very-long-test-file-name.js"],
        timeoutMs: 60000,
      },
    ];
    vi.mocked(conversationGitApi.get).mockResolvedValue(value);
    mount();
    expect(await screen.findByText("auth-regression")).toBeInTheDocument();
    const check = screen.getByText("auth-regression").closest("details");
    expect(check).toBeTruthy();
    expect(check!.querySelector("summary")).toHaveTextContent(
      "auth-regression",
    );
    expect(check!.querySelector("summary")).not.toHaveTextContent(
      "/usr/local/bin/node",
    );
    expect(
      within(check!).getByText(
        "/usr/local/bin/node --test very-long-test-file-name.js",
      ),
    ).toBeInTheDocument();
  });

  it("allows cancelling a checking operation while its request is still pending", async () => {
    const value = snapshot("ready");
    value.mr.checks = [
      { id: "check", executable: "node", args: ["test.js"], timeoutMs: 60000 },
    ];
    vi.mocked(conversationGitApi.get).mockResolvedValue(value);
    let finish: (value: ConversationGitSnapshot) => void = () => {};
    vi.mocked(conversationGitApi.action).mockImplementation(
      (_session, _task, input) =>
        input.action === "checks"
          ? new Promise((resolve) => {
              finish = resolve;
            })
          : Promise.resolve(snapshot("cancelled")),
    );
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "运行检查" }));
    const checking = {
      ...value,
      mr: { ...value.mr, status: "checking" as const, version: 8 },
    };
    vi.mocked(conversationGitApi.get).mockResolvedValue(checking);
    await waitFor(
      () => expect(screen.getByRole("button", { name: "取消" })).toBeEnabled(),
      { timeout: 3000 },
    );
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() =>
      expect(conversationGitApi.action).toHaveBeenCalledWith(
        "session-a",
        "task-1",
        expect.objectContaining({ action: "cancel", expectedVersion: 8 }),
      ),
    );
    await act(async () => {
      finish({
        ...value,
        mr: { ...value.mr, status: "cancelled", version: 9 },
      });
    });
  });
});
