import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, it, expect, vi } from "vitest";
const store = vi.hoisted(() => ({ ingestConversationMessages: vi.fn() }));
const owner = vi.hoisted(() => ({ sessionId: "s" }));
const localTask = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../state/agentSessionStore", () => ({
  useAgentSessionStore: { getState: () => store },
}));
vi.mock("../SessionTranscriptContext", () => ({
  useTranscriptSession: () => owner,
}));
vi.mock("../workspaceRefresh", () => ({ refreshWorkspace: vi.fn() }));
vi.mock("../../../adapters/transport/remotePr", () => ({
  remotePrApi: { get: vi.fn(), action: vi.fn() },
}));
vi.mock("../../../adapters/transport/conversationGit", () => ({
  conversationGitApi: { get: localTask.get },
}));
import {
  remotePrApi,
  type RemotePrSnapshot,
} from "../../../adapters/transport/remotePr";
import MergeRequestCard from "./MergeRequestCard";
const reference = {
  schema: "synax.git-pr",
  schemaVersion: 1,
  objectId: "task",
  sessionId: "s",
  projectId: "p",
  rootId: "root",
  title: "Auth",
} as const;
const fixture = (): RemotePrSnapshot => ({
  reference,
  task: {
    id: "task",
    sessionId: "s",
    projectId: "p",
    rootId: "root",
    repository: {
      remote: "origin",
      host: "github.com",
      path: "acme/app",
      provider: "github",
    },
    number: 7,
    revision: 2,
    messageId: "m",
    createdAt: "",
    updatedAt: "",
  },
  pr: {
    number: 7,
    title: "Auth",
    body: "desc",
    url: "https://github.com/acme/app/pull/7",
    state: "open",
    draft: false,
    head: "feature/auth",
    base: "main",
    headSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    mergeable: true,
    mergeStatus: "clean",
    author: "user",
    checks: [{ name: "unit", status: "passed" }],
    sameRepository: true,
    updatedAt: "",
  },
  local: { branch: "feature/auth", headSha: "a".repeat(40), dirty: false },
  messages: [],
});
beforeEach(() => {
  vi.clearAllMocks();
  owner.sessionId = "s";
  vi.mocked(remotePrApi.get).mockResolvedValue(fixture());
});
describe("merge request native card", () => {
  it("requires explicit confirmation and sends the current remote SHA and task revision", async () => {
    const completed = fixture();
    completed.pr.state = "merged";
    vi.mocked(remotePrApi.action).mockResolvedValue(completed);
    render(<MergeRequestCard reference={reference} />);
    fireEvent.click(await screen.findByRole("button", { name: "合并 PR" }));
    expect(remotePrApi.action).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "确认合并", exact: true }),
    );
    await waitFor(() =>
      expect(remotePrApi.action).toHaveBeenCalledWith(
        "s",
        "task",
        expect.objectContaining({
          action: "merge",
          expectedRevision: 2,
          expectedHeadSha: "a".repeat(40),
          mergeMethod: "merge",
        }),
      ),
    );
    expect(await screen.findByRole("status")).toHaveTextContent("已合并");
    expect(store.ingestConversationMessages).toHaveBeenCalledWith("s", []);
  });
  it("blocks failed checks and preserves history read-only state", async () => {
    const data = fixture();
    data.pr.checks[0].status = "failed";
    vi.mocked(remotePrApi.get).mockResolvedValue(data);
    render(<MergeRequestCard reference={reference} readOnly />);
    expect(
      await screen.findByRole("button", { name: "合并 PR" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "同步本地" })).toBeDisabled();
  });
  it("does not load another session task", () => {
    owner.sessionId = "other";
    render(<MergeRequestCard reference={reference} />);
    expect(remotePrApi.get).not.toHaveBeenCalled();
  });
  it("uses GitLab wording and does not offer unsupported rebase merge method", async () => {
    const data = fixture();
    data.task.repository.provider = "gitlab";
    data.task.repository.host = "gitlab.com";
    vi.mocked(remotePrApi.get).mockResolvedValue(data);
    render(<MergeRequestCard reference={reference} />);
    expect(
      await screen.findByRole("button", { name: "Rebase 来源分支" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "合并 MR" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("GitLab MR");
  });
  it("visualizes GitLab pipeline stages, approvals and diff size", async () => {
    const data = fixture();
    data.task.repository.provider = "gitlab";
    data.task.repository.host = "gitlab.com";
    data.pr.pipeline = {
      id: 12,
      stages: [
        { name: "build", status: "passed", jobs: [] },
        {
          name: "test",
          status: "failed",
          jobs: [
            {
              name: "unit",
              status: "failed",
              url: "https://gitlab.com/acme/-/jobs/1",
            },
          ],
        },
        { name: "deploy", status: "pending", jobs: [] },
      ],
    };
    data.pr.stats = { additions: 120, deletions: 30, files: 6 };
    data.pr.review = {
      required: 2,
      approvedBy: ["mint"],
      reviewers: ["mint", "ana"],
    };
    data.pr.commits = [
      { sha: "c".repeat(40), title: "Fix session", author: "mint", createdAt: "" },
    ];
    vi.mocked(remotePrApi.get).mockResolvedValue(data);
    render(<MergeRequestCard reference={reference} />);
    expect(await screen.findByText("MR !7")).toBeVisible();
    expect(screen.getByRole("button", { name: "build：通过" })).toBeVisible();
    expect(screen.getByRole("button", { name: "test：失败" })).toBeVisible();
    expect(screen.getByText("unit")).toBeVisible();
    expect(screen.getByText("1/2")).toBeVisible();
    expect(screen.getByText("+120")).toBeVisible();
    expect(screen.getByText("6 个文件")).toBeVisible();
    expect(screen.getByText("1 个提交")).toBeVisible();
  });

  it("keeps a successful merge successful when the resolution card cannot be fetched", async () => {
    const completed = fixture();
    completed.pr.state = "merged";
    completed.resolutionReference = reference;
    vi.mocked(remotePrApi.action).mockResolvedValue(completed);
    localTask.get.mockRejectedValue(new Error("resolution fetch failed"));
    render(<MergeRequestCard reference={reference} />);

    fireEvent.click(await screen.findByRole("button", { name: "合并 PR" }));
    fireEvent.click(
      screen.getByRole("button", { name: "确认合并", exact: true }),
    );

    expect(await screen.findByRole("status")).toHaveTextContent("已合并");
    // The remote action succeeded; a failed card fetch is not a failed merge.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("lets a manual refresh supersede a read that is still in flight", async () => {
    vi.mocked(remotePrApi.get)
      .mockResolvedValueOnce(fixture())
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValue(fixture());
    render(<MergeRequestCard reference={reference} />);

    const refresh = await screen.findByRole("button", { name: "刷新 PR" });
    fireEvent.click(refresh);
    await waitFor(() => expect(remotePrApi.get).toHaveBeenCalledTimes(2));
    fireEvent.click(refresh);
    await waitFor(() => expect(remotePrApi.get).toHaveBeenCalledTimes(3));
  });
});
