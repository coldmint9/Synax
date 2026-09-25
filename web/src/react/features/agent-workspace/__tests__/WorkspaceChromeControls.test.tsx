import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render as testingRender, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ContextMenuProvider } from "../../../components/context-menu/ContextMenuProvider";
import type { SessionEnvironment } from "../../../../lib/api/agentRuntime";

const render: typeof testingRender = (ui, options) => testingRender(ui, {
  wrapper: ({ children }) => <MemoryRouter><ContextMenuProvider>{children}</ContextMenuProvider></MemoryRouter>,
  ...options,
});

import { registerWorkspaceSaveHandler, useSessionWorkspaceStore } from "../state/sessionWorkspaceStore";

const mocks = vi.hoisted(() => ({
  reload: vi.fn(),
  environment: null as SessionEnvironment | null,
}));

vi.mock("../SessionEnvironmentContext", () => ({
  useSessionWorkspaceEnvironment: () => ({
    environment: mocks.environment,
    loading: false,
    reload: mocks.reload,
  }),
}));

const { WorkspaceTabStrip } = await import("../WorkspaceChromeControls");

function matchWideViewport() {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

describe("WorkspaceTabStrip", () => {
  const scrollIntoView = vi.fn();

  beforeEach(() => {
    matchWideViewport();
    mocks.reload.mockReset();
    mocks.environment = null;
    scrollIntoView.mockReset();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    useSessionWorkspaceStore.setState({
      sessions: {
        "session-1": {
          tabs: [
            { id: "file:a.ts", kind: "file", title: "a.ts", path: "a.ts" },
            { id: "diff:b.ts", kind: "diff", title: "b.ts", path: "b.ts" },
            { id: "diff:c.ts", kind: "diff", title: "c.ts", path: "c.ts" },
            { id: "diff:d.ts", kind: "diff", title: "d.ts", path: "d.ts" },
          ],
          activeTabId: "diff:d.ts",
          presentation: "dock",
        },
      },
    });
  });

  afterEach(() => cleanup());

  it("renders every tab in a scrollable rail and keeps the active tab visible", () => {
    const { container } = render(<WorkspaceTabStrip sessionId="session-1" />);

    expect(screen.getAllByRole("tab")).toHaveLength(4);
    expect(container.querySelector(".workspace-tab-rail")).toBeTruthy();
    expect(
      container.querySelectorAll('[data-file-type-icon$=".ts"]'),
    ).toHaveLength(4);
    expect(screen.queryByLabelText("还有 1 个标签")).toBeNull();
    expect(
      screen.getByRole("tab", { name: "d.ts" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(scrollIntoView).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("tab", { name: "b.ts" }));
    expect(
      useSessionWorkspaceStore.getState().sessions["session-1"].activeTabId,
    ).toBe("diff:b.ts");
  });

  it("marks multi-project tabs with project colors without prefixing filenames", () => {
    mocks.environment = {
      sessionId: "session-1",
      projectId: "api",
      workspacePath: "/repos/api",
      branch: "main",
      headCommitSha: "head",
      dirty: false,
      additions: 0,
      deletions: 0,
      changedFiles: [],
      agentChangedFiles: [],
      inputSources: [],
      subagents: [],
      refreshedAt: "2026-09-25T00:00:00.000Z",
      repositories: [
        {
          rootId: "api",
          name: "API",
          role: "primary",
          status: "ready",
          workspacePath: "/repos/api",
          branch: "main",
          headCommitSha: "head",
          dirty: false,
          additions: 0,
          deletions: 0,
          changedFiles: [],
          agentChangedFiles: [],
          inputSources: [],
        },
        {
          rootId: "web",
          name: "Web",
          role: "reference",
          status: "ready",
          workspacePath: "/repos/web",
          branch: "main",
          headCommitSha: "head",
          dirty: false,
          additions: 0,
          deletions: 0,
          changedFiles: [],
          agentChangedFiles: [],
          inputSources: [],
        },
      ],
    };
    useSessionWorkspaceStore.setState({
      sessions: {
        "session-1": {
          tabs: [
            { id: "file@api:src/index.ts", kind: "file", title: "index.ts", path: "src/index.ts", rootId: "api" },
            { id: "file@web:src/index.ts", kind: "file", title: "index.ts", path: "src/index.ts", rootId: "web" },
          ],
          activeTabId: "file@api:src/index.ts",
          presentation: "dock",
        },
      },
    });

    const { container } = render(<WorkspaceTabStrip sessionId="session-1" />);
    const colors = [...container.querySelectorAll<HTMLElement>(".workspace-tab-item")]
      .map((item) => item.dataset.projectColor);
    expect(screen.getAllByRole("tab", { name: "index.ts" })).toHaveLength(2);
    expect(colors.every((color) => color && color !== "default")).toBe(true);
    expect(new Set(colors).size).toBe(2);
  });

  it("returns to the conversation without discarding output tabs", () => {
    render(<WorkspaceTabStrip sessionId="session-1" />);
    fireEvent.click(screen.getByRole("button", { name: "返回对话" }));
    const workspace = useSessionWorkspaceStore.getState().sessions["session-1"];
    expect(workspace.activeTabId).toBeNull();
    expect(workspace.tabs).toHaveLength(4);
  });

  it("closes a tab and selects the remaining tab", () => {
    render(<WorkspaceTabStrip sessionId="session-1" />);

    fireEvent.click(screen.getByLabelText("关闭 d.ts"));

    expect(
      useSessionWorkspaceStore.getState().sessions["session-1"],
    ).toMatchObject({
      activeTabId: "diff:c.ts",
      presentation: "dock",
    });
  });

  it("refreshes and toggles fullscreen mode from the tab actions", () => {
    render(<WorkspaceTabStrip sessionId="session-1" />);

    fireEvent.click(screen.getByLabelText("刷新工作区"));
    expect(mocks.reload).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByLabelText("全屏"));
    expect(
      useSessionWorkspaceStore.getState().sessions["session-1"].presentation,
    ).toBe("focus");

    fireEvent.click(screen.getByLabelText("退出全屏"));
    expect(
      useSessionWorkspaceStore.getState().sessions["session-1"].presentation,
    ).toBe("dock");
  });

  it("guards dirty tabs during close-others and cancellation", () => {
    useSessionWorkspaceStore.setState((state) => ({ sessions: {
      ...state.sessions,
      "session-1": { ...state.sessions["session-1"], tabs: state.sessions["session-1"].tabs.map((tab) =>
        tab.id === "diff:c.ts" ? { ...tab, dirty: true } : tab),
      },
    } }));
    render(<WorkspaceTabStrip sessionId="session-1" />);
    fireEvent.contextMenu(screen.getByRole("tab", { name: "a.ts" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "关闭其他标签" }));
    expect(screen.getByRole("dialog", { name: "文件有未保存的修改" })).toBeTruthy();
    expect(useSessionWorkspaceStore.getState().sessions["session-1"].tabs.some((tab) => tab.id === "diff:c.ts")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(useSessionWorkspaceStore.getState().sessions["session-1"].tabs.some((tab) => tab.id === "diff:c.ts")).toBe(true);
  });

  it("saves a dirty tab before closing the rest", async () => {
    useSessionWorkspaceStore.setState((state) => ({ sessions: {
      ...state.sessions,
      "session-1": { ...state.sessions["session-1"], tabs: state.sessions["session-1"].tabs.map((tab) =>
        tab.id === "diff:c.ts" ? { ...tab, dirty: true } : tab),
      },
    } }));
    const save = vi.fn().mockResolvedValue(true);
    const unregister = registerWorkspaceSaveHandler("diff:c.ts", save);
    render(<WorkspaceTabStrip sessionId="session-1" />);
    fireEvent.contextMenu(screen.getByRole("tab", { name: "a.ts" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "关闭其他标签" }));
    fireEvent.click(screen.getByRole("button", { name: "保存并关闭" }));
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(useSessionWorkspaceStore.getState().sessions["session-1"].tabs.map((tab) => tab.id)).toEqual(["file:a.ts"]));
    unregister();
  });

  it("renders nothing without an active tab", () => {
    useSessionWorkspaceStore.setState({
      sessions: {
        "session-1": {
          tabs: [],
          activeTabId: null,
          presentation: "dock",
        },
      },
    });

    render(<WorkspaceTabStrip sessionId="session-1" />);

    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.queryByLabelText("刷新工作区")).toBeNull();
  });
});
