import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { SessionEnvironment } from "../../../../lib/api/agentRuntime";
import { WorkspaceDashboard } from "../WorkspaceDashboard";
import { useAgentSessionStore } from "../agentSessionStore";
import { useSessionWorkspaceStore } from "../sessionWorkspaceStore";

vi.mock("../SessionBackgroundProcesses", () => ({
  SessionBackgroundProcesses: () => null,
}));

const environment: SessionEnvironment = {
  sessionId: "session-1",
  projectId: "proj-1",
  workspacePath: "/Users/mint/IdeaProjects/jbolt-ai-vue/.worktrees/feature",
  branch: "feature/dynamic-workflow-refactor",
  headCommitSha: "5e5727b0abcdef0123456789",
  dirty: true,
  additions: 585,
  deletions: 138,
  changedFiles: [
    {
      path: "src/views/chat-cli/index.vue",
      status: "modified",
      additions: 40,
      deletions: 12,
      staged: false,
      untracked: false,
    },
    {
      path: "src/views/cli_chat/components/blocks/BlockAsk.vue",
      status: "added",
      additions: 62,
      deletions: 0,
      staged: true,
      untracked: false,
    },
    {
      path: "notes.md",
      status: "untracked",
      additions: 4,
      deletions: 0,
      staged: false,
      untracked: true,
    },
  ],
  agentChangedFiles: [],
  inputSources: [
    {
      kind: "file",
      label: "src/views/cli_chat/index.vue",
      path: "src/views/cli_chat/index.vue",
    },
    {
      kind: "file",
      label: "src/views/cli_chat/utils/toolDisplay.js",
      path: "src/views/cli_chat/utils/toolDisplay.js",
    },
  ],
  subagents: [
    {
      id: "sub-1",
      parentSessionId: "session-1",
      profileId: "explorer",
      status: "completed",
      title: null,
      prompt:
        "## Investigation Task\n用只读方式深度调研 src/views/cli_chat 目录",
      updatedAt: "2026-09-10T00:00:00.000Z",
      completedAt: "2026-09-10T00:10:00.000Z",
      resultSummary: null,
    },
    {
      id: "sub-2",
      parentSessionId: "session-1",
      profileId: "worker",
      status: "running",
      title: "Writer",
      prompt: "重写 BlockTool.vue",
      updatedAt: "2026-09-10T00:20:00.000Z",
      completedAt: null,
      resultSummary: null,
    },
  ],
  refreshedAt: "2026-09-10T00:30:00.000Z",
};

function renderDashboard(overrides: Partial<SessionEnvironment> = {}) {
  return render(
    <WorkspaceDashboard
      sessionId="session-1"
      environment={{ ...environment, ...overrides }}
      loading={false}
      reload={() => {}}
    />,
  );
}

describe("WorkspaceDashboard", () => {
  beforeEach(() => {
    useSessionWorkspaceStore.setState({ sessions: {} });
    useAgentSessionStore.setState({
      selectedSessionId: "session-1",
      sessionTodos: [],
    });
  });

  afterEach(() => cleanup());

  it("divides the snapshot into one card per component group", () => {
    const { container } = renderDashboard();

    expect(screen.getByText("feature/dynamic-workflow-refactor")).toBeTruthy();

    expect(screen.getByRole("button", { name: /Subagents/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Git 变更/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /输入源/ })).toBeTruthy();
    expect(screen.getByText("运行中 1")).toBeTruthy();
    expect(screen.getByText("已暂存 1")).toBeTruthy();
    expect(container.querySelectorAll("[data-file-type-icon]")).toHaveLength(3);
    expect(
      container.querySelector('[data-file-type-icon="index.vue"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-file-type-icon="notes.md"]'),
    ).not.toBeNull();
  });

  it("falls back to the prompt headline for untitled subagents", () => {
    renderDashboard();

    expect(screen.getByText("Investigation Task")).toBeTruthy();
    expect(
      screen.getByText("用只读方式深度调研 src/views/cli_chat 目录"),
    ).toBeTruthy();
    expect(screen.getByText("Writer")).toBeTruthy();
  });

  it("opens diff, file, and subagent tabs from the card rows", () => {
    renderDashboard();

    fireEvent.click(screen.getByText("BlockAsk.vue"));
    expect(
      useSessionWorkspaceStore.getState().sessions["session-1"].tabs,
    ).toMatchObject([
      {
        id: "diff:src/views/cli_chat/components/blocks/BlockAsk.vue",
        kind: "diff",
      },
    ]);

    if (!screen.queryByText("toolDisplay.js"))
      fireEvent.click(screen.getByRole("button", { name: /输入源/ }));
    fireEvent.click(screen.getByText("toolDisplay.js"));
    expect(
      useSessionWorkspaceStore.getState().sessions["session-1"].tabs,
    ).toMatchObject([
      {
        id: "diff:src/views/cli_chat/components/blocks/BlockAsk.vue",
        kind: "diff",
      },
      { id: "file:src/views/cli_chat/utils/toolDisplay.js", kind: "file" },
    ]);

    fireEvent.click(screen.getByText("Investigation Task"));
    expect(
      useSessionWorkspaceStore.getState().sessions["session-1"].tabs,
    ).toMatchObject([
      {
        id: "diff:src/views/cli_chat/components/blocks/BlockAsk.vue",
        kind: "diff",
      },
      { id: "file:src/views/cli_chat/utils/toolDisplay.js", kind: "file" },
      { id: "subagent:sub-1", kind: "subagent" },
    ]);
  });

  it("switches git changes between tree and flat views while input files stay flat", () => {
    const { container } = renderDashboard();

    const gitCard = screen
      .getByRole("button", { name: /Git 变更/ })
      .closest(".ws-card");
    const inputCard = screen
      .getByRole("button", { name: /输入源/ })
      .closest(".ws-card");

    fireEvent.click(screen.getByRole("button", { name: "目录视图" }));
    expect(
      gitCard?.querySelector('[data-directory-path="src/views"]'),
    ).not.toBeNull();
    expect(inputCard?.querySelector(".ws-tree-folder")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "blocks" }));
    expect(screen.queryByText("BlockAsk.vue")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "平铺视图" }));
    expect(screen.getByText("BlockAsk.vue")).toBeTruthy();
    expect(gitCard?.querySelector(".ws-tree-folder")).toBeNull();
    expect(
      screen
        .getByRole("button", { name: /Git 变更/ })
        .getAttribute("aria-expanded"),
    ).toBe("true");

    expect(container.querySelector(".ws-row-dir")).toBeNull();
    expect(screen.queryByText("src/views/chat-cli")).toBeNull();
  });

  it("collapses a card body from its header", () => {
    renderDashboard();

    const header = screen.getByRole("button", { name: /Git 变更/ });
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("notes.md")).toBeTruthy();

    fireEvent.click(header);

    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("notes.md")).toBeNull();
    expect(screen.getByRole("button", { name: /输入源/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("hides empty input, output and subagent sections while keeping Git controls", () => {
    renderDashboard({
      changedFiles: [],
      dirty: false,
      inputSources: [],
      outputFiles: [],
      subagents: [],
    });

    expect(screen.queryByRole("button", { name: /Subagents/ })).toBeNull();
    expect(screen.getAllByText("无变更").length).toBeGreaterThan(0);
    expect(screen.queryByText("暂无读取文件")).toBeNull();
    expect(screen.queryByText("还没有产出物")).toBeNull();
    expect(screen.queryByText("产出文件")).toBeNull();
    expect(screen.getByRole("button", { name: "提交并推送" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "刷新工作区" })).toBeEnabled();
  });

  it("marks repositories with project records as content-sized cards", () => {
    const repository = {
      ...environment,
      rootId: "primary",
      name: "Synax",
      role: "primary" as const,
      status: "ready" as const,
    };
    render(
      <WorkspaceDashboard
        sessionId="session-1"
        environment={{ ...environment, repositories: [repository] }}
      />,
    );

    expect(
      screen
        .getByRole("button", { name: /^Synax/ })
        .closest(".ws-project-card"),
    ).toHaveClass("ws-project-card--with-content");
  });

  it("keeps project Git controls in the header when clean or collapsed", () => {
    const reload = vi.fn();
    const repository = {
      ...environment,
      rootId: "primary",
      name: "Synax",
      role: "primary" as const,
      status: "ready" as const,
      branch: "main",
      dirty: false,
      changedFiles: [],
      inputSources: [],
      outputFiles: [],
    };
    const view = render(
      <WorkspaceDashboard
        sessionId="session-1"
        environment={{ ...environment, repositories: [repository] }}
        reload={reload}
      />,
    );
    const toggle = screen.getByRole("button", { name: "Synax" });
    const header = toggle.closest(".ws-card-head")!;
    expect(toggle.closest(".ws-project-card")).toHaveClass(
      "ws-project-card--status-only",
    );
    expect(within(header).getByText("main")).toBeInTheDocument();
    expect(
      within(header).getByRole("button", { name: "提交并推送" }),
    ).toBeDisabled();
    expect(screen.queryByText("产出文件")).toBeNull();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(within(header).getByRole("button", { name: "刷新工作区" }));
    expect(reload).toHaveBeenCalledTimes(1);
    view.rerender(
      <WorkspaceDashboard
        sessionId="session-1"
        environment={{
          ...environment,
          repositories: [
            {
              ...repository,
              dirty: true,
              changedFiles: environment.changedFiles,
            },
          ],
        }}
        reload={reload}
      />,
    );
    expect(screen.getAllByRole("button", { name: "提交并推送" })).toHaveLength(
      1,
    );
    expect(
      within(header).getByRole("button", { name: "提交并推送" }),
    ).toBeEnabled();
    expect(screen.queryByText("BlockAsk.vue")).toBeNull();
  });

  it("reflects the agent change status on each row", () => {
    const { container } = renderDashboard();

    const badges = [...container.querySelectorAll(".ws-badge")].map(
      (node) => node.textContent,
    );
    expect(badges).toEqual(["M", "A", "U"]);
  });

  it("reloads the snapshot from the repository card", () => {
    const reload = vi.fn();
    render(
      <WorkspaceDashboard
        sessionId="session-1"
        environment={environment}
        loading={false}
        reload={reload}
      />,
    );

    fireEvent.click(screen.getByLabelText("刷新工作区"));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("gives each repository its own collapsible project and keeps file tabs isolated", () => {
    renderDashboard({
      repositories: [
        {
          ...environment,
          rootId: "primary",
          name: "API",
          role: "primary",
          status: "ready",
        },
        {
          ...environment,
          rootId: "secondary",
          name: "Web",
          role: "reference",
          status: "ready",
          branch: "web-branch",
          workspacePath: "/repos/web",
        },
        {
          ...environment,
          rootId: "missing",
          name: "Gone",
          role: "reference",
          status: "missing",
          changedFiles: [],
          inputSources: [],
        },
      ],
    });
    const apiHeader = screen.getByRole("button", { name: /^API/ });
    const webHeader = screen.getByRole("button", { name: /^Web/ });
    const goneHeader = screen.getByRole("button", { name: /^Gone/ });
    const apiCard = apiHeader.closest(".ws-project-card")!;
    const webCard = webHeader.closest(".ws-project-card")!;
    const goneCard = goneHeader.closest(".ws-project-card")!;
    const pane = apiCard.parentElement!;
    expect(pane).toHaveClass("workspace-projects-pane--multiple");
    expect(webCard.parentElement).toBe(pane);
    expect(goneCard.parentElement).toBe(pane);
    expect(pane.querySelectorAll(":scope > .ws-project-card")).toHaveLength(3);
    expect(pane.closest(".ws-card")).toBeNull();
    expect(screen.queryByRole("button", { name: /^项目\s*3$/ })).toBeNull();

    expect(apiHeader).toHaveAttribute("aria-expanded", "true");
    expect(webHeader).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(webHeader);
    expect(webHeader).toHaveAttribute("aria-expanded", "false");
    expect(within(webCard).queryByText("BlockAsk.vue")).toBeNull();
    expect(within(apiCard).getByText("BlockAsk.vue")).toBeInTheDocument();
    fireEvent.click(webHeader);

    fireEvent.click(within(apiCard).getByText("BlockAsk.vue"));
    fireEvent.click(within(apiCard).getByText("toolDisplay.js"));
    fireEvent.click(within(webCard).getByText("BlockAsk.vue"));
    fireEvent.click(within(webCard).getByText("toolDisplay.js"));
    const tabs = useSessionWorkspaceStore.getState().sessions["session-1"].tabs;
    expect(tabs).toHaveLength(4);
    expect(new Set(tabs.map((tab) => tab.id)).size).toBe(4);
    expect(tabs.map((tab) => tab.rootId)).toEqual([
      "primary",
      "primary",
      "secondary",
      "secondary",
    ]);
    expect(tabs[2].title).toBe("Web / BlockAsk.vue");
    expect(within(goneCard).getByText("目录缺失")).toBeInTheDocument();
    expect(
      within(goneCard).getByRole("button", { name: "提交并推送" }),
    ).toBeDisabled();
  });

  it("remembers project folds after the workspace is reopened", () => {
    const snapshot: SessionEnvironment = {
      ...environment,
      repositories: [
        {
          ...environment,
          rootId: "primary",
          name: "API",
          role: "primary",
          status: "ready",
        },
        {
          ...environment,
          rootId: "web",
          name: "Web",
          role: "reference",
          status: "ready",
        },
      ],
    };
    const view = render(
      <WorkspaceDashboard sessionId="session-1" environment={snapshot} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Web/ }));
    view.unmount();
    render(<WorkspaceDashboard sessionId="session-1" environment={snapshot} />);
    expect(screen.getByRole("button", { name: /^Web/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("opens a committed output in its owning repository without treating hand edits as outputs", () => {
    renderDashboard({
      outputFiles: ["docs/deliverable.md"],
      agentChangedFiles: [],
    });
    expect(
      screen.queryByRole("button", { name: /notes.md.*工作目录/ }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "deliverable.md docs" }),
    );
    expect(
      useSessionWorkspaceStore.getState().sessions["session-1"].tabs,
    ).toMatchObject([{ kind: "file", path: "docs/deliverable.md" }]);
  });

  it("keeps same-name outputs scoped to their owning repository", () => {
    renderDashboard({
      repositories: [
        {
          ...environment,
          rootId: "api",
          name: "API",
          role: "primary",
          status: "ready",
          outputFiles: ["result.md"],
        },
        {
          ...environment,
          rootId: "web",
          name: "Web",
          role: "reference",
          status: "ready",
          outputFiles: ["result.md"],
        },
      ],
    });
    const apiCard = screen
      .getByRole("button", { name: /^API/ })
      .closest(".ws-project-card")!;
    const webCard = screen
      .getByRole("button", { name: /^Web/ })
      .closest(".ws-project-card")!;
    fireEvent.click(
      within(apiCard).getByRole("button", { name: "result.md 工作目录" }),
    );
    fireEvent.click(
      within(webCard).getByRole("button", { name: "result.md 工作目录" }),
    );
    expect(
      useSessionWorkspaceStore
        .getState()
        .sessions["session-1"].tabs.map((tab) => tab.rootId),
    ).toEqual(["api", "web"]);
  });

  it("shows todos for the selected session and never leaks them into another session", () => {
    useAgentSessionStore.setState({
      selectedSessionId: "session-1",
      sessionTodos: [
        { id: "todo-1", label: "Review outputs", status: "in_progress" },
      ],
    });
    const view = renderDashboard();
    expect(screen.getByText("Review outputs")).toBeTruthy();
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "0",
    );
    view.rerender(
      <WorkspaceDashboard
        sessionId="session-2"
        environment={{ ...environment, sessionId: "session-2" }}
      />,
    );
    expect(screen.queryByText("Review outputs")).toBeNull();
  });
});
