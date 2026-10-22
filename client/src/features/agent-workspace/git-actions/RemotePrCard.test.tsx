import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, it, expect, vi } from "vitest";
const store = vi.hoisted(() => ({ ingestConversationMessages: vi.fn() }));
const owner = vi.hoisted(() => ({ sessionId: "s" }));
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
import {
  remotePrApi,
  type RemotePrSnapshot,
} from "../../../adapters/transport/remotePr";
import RemotePrCard from "./RemotePrCard";
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
describe("remote PR native card", () => {
  it("requires explicit confirmation and sends the current remote SHA and task revision", async () => {
    const completed = fixture();
    completed.pr.state = "merged";
    vi.mocked(remotePrApi.action).mockResolvedValue(completed);
    render(<RemotePrCard reference={reference} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "合并远程请求" }),
    );
    expect(remotePrApi.action).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "确认远程合并", exact: true }),
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
    render(<RemotePrCard reference={reference} readOnly />);
    expect(
      await screen.findByRole("button", { name: "合并远程请求" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "同步本地" })).toBeDisabled();
  });
  it("does not load another session task", () => {
    owner.sessionId = "other";
    render(<RemotePrCard reference={reference} />);
    expect(remotePrApi.get).not.toHaveBeenCalled();
  });
  it("uses GitLab wording and does not offer unsupported rebase merge method", async () => {
    const data = fixture();
    data.task.repository.provider = "gitlab";
    data.task.repository.host = "gitlab.com";
    vi.mocked(remotePrApi.get).mockResolvedValue(data);
    render(<RemotePrCard reference={reference} />);
    expect(
      await screen.findByRole("button", { name: "Rebase 来源分支" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "合并远程请求" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("GitLab MR");
  });
});
