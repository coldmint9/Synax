import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../../adapters/transport/agentRuntime";
import { useAgentSessionStore } from "../state/agentSessionStore";
import { useSessionWorkspaceStore } from "../state/sessionWorkspaceStore";
import { useShellStore } from "../../../shared/state/shellStore";
import SessionsPage from "../../../app/pages/SessionsPage";

vi.mock("../useSessionDetailPolling", () => ({
  useSessionDetailPolling: () => {},
}));
vi.mock("../useSessionLiveStream", () => ({ useSessionLiveStream: () => {} }));
vi.mock("../useSessionRouteSync", () => ({ useSessionRouteSync: () => {} }));
vi.mock("../../../shared/hooks/useMediaQuery", () => ({
  useMediaQuery: (query: string) =>
    narrow ? query.includes("767") : query.includes("1280"),
}));
vi.mock("../../../app/layouts/WorkbenchIsland", () => ({
  WorkbenchIslandSlot: () => null,
}));
vi.mock("../WorkQuickActions", () => ({
  WorkQuickActions: ({ showDetailsButton }: { showDetailsButton: boolean }) =>
    showDetailsButton ? <button>Task details</button> : null,
}));
vi.mock("../SessionTranscript", () => ({
  SessionTranscript: () => <div data-testid="parent-transcript">主对话</div>,
}));
vi.mock("../SessionListPanel", () => ({ SessionListPanel: () => null }));
vi.mock("../SessionWorkspacePanel", () => ({
  SessionWorkspacePanel: ({ mode }: { mode: string }) =>
    mode === "content" ? (
      <div data-testid="workspace-content">Workspace content</div>
    ) : (
      <div data-testid="dashboard">
        <input aria-label="Widget filter" defaultValue="" />
      </div>
    ),
}));
vi.mock("../SessionComposer", () => ({ SessionComposer: () => null }));
vi.mock("../AgentCommandRail", () => ({
  AgentCommandRail: ({
    hidden,
    insetRight,
    onOpenSideChat,
  }: {
    hidden: boolean;
    insetRight: number;
    onOpenSideChat: () => void;
  }) => (
    <div
      data-testid="command-rail"
      hidden={hidden}
      data-inset-right={insetRight}
    >
      <button onClick={onOpenSideChat}>Open side chat</button>
    </div>
  ),
}));
vi.mock("../SideChatPanel", () => ({
  SideChatPanel: ({ onClose }: { onClose: () => void }) => (
    <div>
      <span>Side chat content</span>
      <button onClick={onClose}>Close side chat</button>
    </div>
  ),
}));
vi.mock("../SubagentReadonlyView", () => ({
  SubagentReadonlyView: () => <div data-testid="child-transcript">子对话</div>,
}));

let availableWidth = 1500;
let narrow = false;
beforeEach(() => {
  availableWidth = 1500;
  narrow = false;
  localStorage.removeItem("synax-sessions-right-panel");
  useAgentSessionStore.setState({
    selectedSessionId: "parent",
    panelOpen: true,
    sessions: [{ id: "parent", status: "completed" } as AgentSession],
  });
  useSessionWorkspaceStore.setState({ sessions: {} });
  useSessionWorkspaceStore.getState().openSubagent("parent", "child", "林墨");
  useShellStore.setState((state) => ({
    preferences: { ...state.preferences, locale: "zh" },
  }));
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.classList.contains("work-session-layout")
        ? availableWidth
        : 300;
    },
  );
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(
    function (this: HTMLElement) {
      return parseFloat(this.style.width) || 300;
    },
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.removeItem("synax-sessions-right-panel");
});
function mount() {
  return render(
    <MemoryRouter initialEntries={["/projects/project/sessions/parent"]}>
      <SessionsPage />
    </MemoryRouter>,
  );
}
function drag(pane: HTMLElement, from: number, to: number) {
  const handle = pane.querySelector('[role="separator"]')!;
  fireEvent.pointerDown(handle, { clientX: from, pointerId: 1 });
  fireEvent.pointerMove(window, { clientX: to, pointerId: 1 });
  fireEvent.pointerUp(window, { clientX: to, pointerId: 1 });
}

describe("Subagent conversation layout", () => {
  it("resizes beyond the old limit, clamps to 240–960px and matches the composer inset", () => {
    const { container } = mount();
    const pane = container.querySelector<HTMLElement>(".session-side-panel")!;
    drag(pane, 1000, 600);
    expect(pane.style.width).toBe("700px");
    expect(screen.getByTestId("command-rail")).toHaveAttribute(
      "data-inset-right",
      "700",
    );
    drag(pane, 1000, 0);
    expect(pane.style.width).toBe("960px");
    drag(pane, 0, 2000);
    expect(pane.style.width).toBe("240px");
  });

  it("reserves 320px for the parent when the window is narrower", () => {
    availableWidth = 900;
    const { container } = mount();
    const pane = container.querySelector<HTMLElement>(".session-side-panel")!;
    drag(pane, 1000, 0);
    expect(pane.style.width).toBe("580px");
  });

  it("restores the original pane width and mounted transcripts after fullscreen", () => {
    const { container } = mount();
    const pane = container.querySelector<HTMLElement>(".session-side-panel")!;
    drag(pane, 1000, 600);
    const parent = screen.getByTestId("parent-transcript");
    const child = screen.getByTestId("child-transcript");
    fireEvent.click(screen.getByRole("button", { name: "全屏查看子代理对话" }));
    expect(pane).toHaveAttribute("data-fullscreen", "true");
    expect(pane.querySelector('[role="separator"]')).toBeNull();
    expect(container.querySelector(".work-content-layout")).toHaveClass(
      "hidden",
    );
    expect(
      container.querySelector(".session-panel-host--left"),
    ).toHaveAttribute("hidden");
    expect(screen.getByTestId("command-rail")).toHaveAttribute("hidden");
    expect(screen.getByTestId("child-transcript")).toBe(child);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(pane).not.toHaveAttribute("data-fullscreen");
    expect(pane.style.width).toBe("700px");
    expect(container.querySelector(".work-content-layout")).not.toHaveClass(
      "hidden",
    );
    expect(screen.getByTestId("command-rail")).not.toHaveAttribute("hidden");
    expect(screen.getByTestId("parent-transcript")).toBe(parent);
    expect(screen.getByTestId("child-transcript")).toBe(child);
  });

  it("keeps widget and subagent widths independent across switches and remounts", () => {
    localStorage.setItem("synax-sessions-right-panel", "360");
    localStorage.setItem("synax-sessions-subagent-panel", "500");
    const view = mount();
    const pane = view.container.querySelector<HTMLElement>(
      ".session-side-panel",
    )!;
    expect(pane.style.width).toBe("500px");
    drag(pane, 1000, 800);
    expect(localStorage.getItem("synax-sessions-subagent-panel")).toBe("700");
    expect(localStorage.getItem("synax-sessions-right-panel")).toBe("360");
    fireEvent.click(screen.getByRole("button", { name: "关闭子代理对话" }));
    expect(pane).toHaveAttribute("data-view", "widgets");
    expect(pane.style.width).toBe("360px");
    expect(screen.getByTestId("command-rail")).toHaveAttribute(
      "data-inset-right",
      "360",
    );
    drag(pane, 1000, 900);
    view.unmount();
    act(() =>
      useSessionWorkspaceStore
        .getState()
        .openSubagent("parent", "child", "林墨"),
    );
    const restored = mount().container.querySelector<HTMLElement>(
      ".session-side-panel",
    )!;
    expect(restored.style.width).toBe("700px");
    fireEvent.click(screen.getByRole("button", { name: "关闭子代理对话" }));
    expect(restored.style.width).toBe("460px");
  });

  it("preserves collapsed widgets and their mounted content while viewing a child", () => {
    useSessionWorkspaceStore.getState().closeSubagent("parent");
    const { container } = mount();
    const pane = container.querySelector<HTMLElement>(".session-side-panel")!;
    const filter = screen.getByRole("textbox", { name: "Widget filter" });
    fireEvent.change(filter, { target: { value: "unchanged" } });
    fireEvent.click(screen.getByRole("button", { name: "收起工作组件" }));
    act(() =>
      useSessionWorkspaceStore
        .getState()
        .openSubagent("parent", "child", "林墨"),
    );
    expect(pane).not.toHaveAttribute("data-collapsed");
    expect(pane.style.width).toBe("300px");
    expect(filter).not.toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "关闭子代理对话" }));
    expect(pane).toHaveAttribute("data-collapsed", "true");
    expect(pane.style.width).toBe("40px");
    expect(screen.getByTestId("command-rail")).toHaveAttribute(
      "data-inset-right",
      "40",
    );
    fireEvent.click(screen.getByRole("button", { name: "展开工作组件" }));
    expect(screen.getByRole("textbox", { name: "Widget filter" })).toBe(filter);
    expect(filter).toHaveValue("unchanged");
  });

  it("hides widgets for workspace content and restores their width and mounted state on close", () => {
    useSessionWorkspaceStore.getState().closeSubagent("parent");
    const { container } = mount();
    const pane = container.querySelector<HTMLElement>(".session-side-panel")!;
    const filter = screen.getByRole("textbox", { name: "Widget filter" });
    fireEvent.change(filter, { target: { value: "kept" } });
    drag(pane, 1000, 900);
    expect(pane.style.width).toBe("400px");
    expect(
      screen.queryByRole("button", { name: "Task details" }),
    ).not.toBeInTheDocument();

    act(() =>
      useSessionWorkspaceStore.getState().openTab("parent", {
        kind: "file",
        title: "main.ts",
        path: "main.ts",
      }),
    );
    expect(screen.getByTestId("workspace-content")).toBeVisible();
    expect(pane).not.toBeVisible();
    expect(filter).not.toBeVisible();
    expect(screen.getByTestId("command-rail")).toHaveAttribute(
      "data-inset-right",
      "0",
    );
    expect(screen.getByRole("button", { name: "Task details" })).toBeVisible();

    const activeTabId =
      useSessionWorkspaceStore.getState().sessions.parent.activeTabId!;
    act(() =>
      useSessionWorkspaceStore.getState().closeTab("parent", activeTabId),
    );
    expect(screen.queryByTestId("workspace-content")).not.toBeInTheDocument();
    expect(pane).toBeVisible();
    expect(pane.style.width).toBe("400px");
    expect(screen.getByRole("textbox", { name: "Widget filter" })).toBe(filter);
    expect(filter).toHaveValue("kept");
    expect(screen.getByTestId("command-rail")).toHaveAttribute(
      "data-inset-right",
      "400",
    );
  });

  it("keeps widgets hidden while another content tab remains and restores their collapsed state", () => {
    useSessionWorkspaceStore.getState().closeSubagent("parent");
    const { container } = mount();
    const pane = container.querySelector<HTMLElement>(".session-side-panel")!;
    fireEvent.click(screen.getByRole("button", { name: "收起工作组件" }));
    act(() => {
      const workspace = useSessionWorkspaceStore.getState();
      workspace.openTab("parent", {
        kind: "file",
        title: "main.ts",
        path: "main.ts",
      });
      workspace.openTab("parent", {
        kind: "diff",
        title: "main.ts diff",
        path: "main.ts",
      });
    });
    expect(pane).not.toBeVisible();
    const diffTab =
      useSessionWorkspaceStore.getState().sessions.parent.activeTabId!;
    act(() => useSessionWorkspaceStore.getState().closeTab("parent", diffTab));
    expect(screen.getByTestId("workspace-content")).toBeVisible();
    expect(pane).not.toBeVisible();
    act(() => useSessionWorkspaceStore.getState().showDashboard("parent"));
    expect(pane).toBeVisible();
    expect(pane).toHaveAttribute("data-collapsed", "true");
    expect(pane.style.width).toBe("40px");
    expect(screen.getByRole("button", { name: "展开工作组件" })).toBeVisible();
    expect(
      useSessionWorkspaceStore.getState().sessions.parent.tabs,
    ).toHaveLength(1);
  });

  it("uses a third independent layout for side chat and lets a child replace it", () => {
    const { container } = mount();
    const pane = container.querySelector<HTMLElement>(".session-side-panel")!;
    drag(pane, 1000, 700);
    fireEvent.click(screen.getByRole("button", { name: "Open side chat" }));
    expect(pane).toHaveAttribute("data-view", "side-chat");
    expect(pane.style.width).toBe("300px");
    drag(pane, 1000, 850);
    expect(localStorage.getItem("synax-sessions-side-chat-panel")).toBe("450");
    act(() =>
      useSessionWorkspaceStore
        .getState()
        .openSubagent("parent", "child", "林墨"),
    );
    expect(pane).toHaveAttribute("data-view", "subagent");
    expect(pane.style.width).toBe("600px");
    expect(screen.queryByText("Side chat content")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭子代理对话" }));
    expect(pane).toHaveAttribute("data-view", "widgets");
    expect(pane.style.width).toBe("300px");
    fireEvent.click(screen.getByRole("button", { name: "Open side chat" }));
    expect(pane.style.width).toBe("450px");
    fireEvent.click(screen.getByRole("button", { name: "Close side chat" }));
    expect(pane).toHaveAttribute("data-view", "widgets");
  });

  it("supports keyboard resizing with the same limits and saves only the active layout", () => {
    availableWidth = 900;
    mount();
    const resize = screen.getByRole("separator", {
      name: "调整子代理会话宽度",
    });
    fireEvent.keyDown(resize, { key: "ArrowLeft" });
    expect(resize).toHaveAttribute("aria-valuenow", "320");
    fireEvent.keyDown(resize, { key: "End" });
    expect(resize).toHaveAttribute("aria-valuenow", "580");
    fireEvent.keyDown(resize, { key: "Home" });
    expect(resize).toHaveAttribute("aria-valuenow", "240");
    expect(localStorage.getItem("synax-sessions-subagent-panel")).toBe("240");
    expect(localStorage.getItem("synax-sessions-right-panel")).toBeNull();
  });

  it("does not reserve horizontal composer space in the mobile split layout", () => {
    narrow = true;
    const { container } = mount();
    expect(container.querySelector(".work-page")).toHaveAttribute(
      "data-side-panel",
      "true",
    );
    expect(screen.getByTestId("command-rail")).toHaveAttribute(
      "data-inset-right",
      "0",
    );
    fireEvent.click(screen.getByRole("button", { name: "关闭子代理对话" }));
    expect(container.querySelector(".session-side-panel")).toHaveAttribute(
      "hidden",
    );
  });
});
