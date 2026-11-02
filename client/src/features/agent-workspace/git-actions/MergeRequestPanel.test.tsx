import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../adapters/transport/remotePr", () => ({
  remotePrApi: {
    discover: vi.fn(),
    list: vi.fn(),
    attach: vi.fn(),
    create: vi.fn(),
    push: vi.fn(),
  },
}));
vi.mock("../state/agentSessionStore", () => ({
  useAgentSessionStore: {
    getState: () => ({ ingestConversationMessages: vi.fn() }),
  },
}));
vi.mock("../workspaceRefresh", () => ({ refreshWorkspace: vi.fn() }));
import {
  remotePrApi,
  type RemotePrDiscovery,
  type RemotePullRequest,
} from "../../../adapters/transport/remotePr";
import MergeRequestPanel from "./MergeRequestPanel";

const pullRequest = (number: number, title: string): RemotePullRequest => ({
  number,
  title,
  body: "",
  url: `https://example.test/${number}`,
  state: "open",
  draft: false,
  head: "feature/x",
  base: "main",
  headSha: "a".repeat(40),
  baseSha: "b".repeat(40),
  mergeable: true,
  mergeStatus: "clean",
  author: "mint",
  checks: [],
  sameRepository: true,
  updatedAt: "",
});

const discovery = (remotes: RemotePrDiscovery["remotes"]): RemotePrDiscovery => ({
  rootId: "root",
  branch: "feature/x",
  headSha: "a".repeat(40),
  dirty: false,
  remotes,
  branches: ["feature/x", "main"],
});

function renderPanel() {
  return render(
    <MemoryRouter>
      <MergeRequestPanel
        sessionId="s"
        rootId="root"
        onBusy={vi.fn()}
        onTaskReady={vi.fn()}
      />
    </MemoryRouter>,
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("merge request panel", () => {
  it("drops a list answer for the remote the user just left", async () => {
    vi.mocked(remotePrApi.discover).mockResolvedValue(
      discovery([
        { name: "origin", provider: "github", path: "acme/app" },
        { name: "mirror", provider: "gitlab", path: "acme/app" },
      ]),
    );
    const slow = deferred<{ items: RemotePullRequest[]; hasMore: boolean }>();
    vi.mocked(remotePrApi.list).mockImplementation((_sessionId, scope) =>
      scope.remote === "origin"
        ? slow.promise
        : Promise.resolve({
            items: [pullRequest(2, "镜像请求")],
            hasMore: false,
          }),
    );
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole("button", { name: "远程仓库" }));
    await user.click(await screen.findByRole("option", { name: "mirror · acme/app" }));
    expect(await screen.findByText(/镜像请求/)).toBeVisible();

    // The abandoned request answers last: it must not repaint the new list.
    slow.resolve({ items: [pullRequest(1, "旧远端请求")], hasMore: false });
    await waitFor(() => expect(screen.queryByText(/旧远端请求/)).toBeNull());
    expect(screen.getByText(/镜像请求/)).toBeVisible();
  });

  it("explains an unusable remote instead of loading forever", async () => {
    vi.mocked(remotePrApi.discover).mockResolvedValue(
      discovery([
        { name: "origin", unsupportedReason: "PR 需要 SSH 或 HTTPS 远程仓库。" },
      ]),
    );
    renderPanel();

    expect(
      await screen.findByText("PR 需要 SSH 或 HTTPS 远程仓库。"),
    ).toBeVisible();
    expect(screen.queryByText(/正在读取/)).toBeNull();
    expect(remotePrApi.list).not.toHaveBeenCalled();
  });

  it("does not claim a platform before the user chooses one", async () => {
    vi.mocked(remotePrApi.discover).mockResolvedValue(
      discovery([{ name: "origin", host: "git.corp", path: "acme/app" }]),
    );
    vi.mocked(remotePrApi.list).mockResolvedValue({ items: [], hasMore: false });
    renderPanel();

    expect(await screen.findByText("请选择平台")).toBeVisible();
    // The platform the panel would send is still undecided.
    expect(screen.queryByText("GitLab · MR")).toBeNull();
  });

  it("returns to the first page when the remote changes", async () => {
    vi.mocked(remotePrApi.discover).mockResolvedValue(
      discovery([
        { name: "origin", provider: "github", path: "acme/app" },
        { name: "mirror", provider: "gitlab", path: "acme/app" },
      ]),
    );
    vi.mocked(remotePrApi.list).mockImplementation((_sessionId, scope, page = 1) => {
      if (scope.remote !== "origin")
        return Promise.resolve({ items: [], hasMore: false });
      return Promise.resolve(
        page === 1
          ? { items: [pullRequest(1, "第一页")], hasMore: true }
          : { items: [pullRequest(2, "第二页")], hasMore: false },
      );
    });
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole("button", { name: "下一页" }));
    expect(await screen.findByText("第 2 页")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "远程仓库" }));
    await user.click(await screen.findByRole("option", { name: "mirror · acme/app" }));
    await waitFor(() => expect(screen.queryByText("第 2 页")).toBeNull());
    expect(screen.queryByRole("button", { name: "上一页" })).toBeNull();
  });
});
