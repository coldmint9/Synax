import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../../adapters/transport/agentRuntime";
import { useAgentSessionStore } from "../state/agentSessionStore";
import { useSessionWorkspaceStore } from "../state/sessionWorkspaceStore";
import { useShellStore } from "../../../shared/state/shellStore";
import SessionsPage from "../../../app/pages/SessionsPage";

vi.mock("../useSessionDetailPolling", () => ({ useSessionDetailPolling: () => {} }));
vi.mock("../useSessionLiveStream", () => ({ useSessionLiveStream: () => {} }));
vi.mock("../useSessionRouteSync", () => ({ useSessionRouteSync: () => {} }));
vi.mock("../../../shared/hooks/useMediaQuery", () => ({ useMediaQuery: (query: string) => query.includes("1280") }));
vi.mock("../../../app/layouts/WorkbenchIsland", () => ({ WorkbenchIslandSlot: () => null }));
vi.mock("../WorkQuickActions", () => ({ WorkQuickActions: () => null }));
vi.mock("../SessionTranscript", () => ({ SessionTranscript: () => <div data-testid="parent-transcript">主对话</div> }));
vi.mock("../SessionListPanel", () => ({ SessionListPanel: () => null }));
vi.mock("../SessionWorkspacePanel", () => ({ SessionWorkspacePanel: () => null }));
vi.mock("../SessionComposer", () => ({ SessionComposer: () => null }));
vi.mock("../AgentCommandRail", () => ({ AgentCommandRail: ({ hidden, insetRight }: { hidden: boolean; insetRight: number }) => <div data-testid="command-rail" hidden={hidden} data-inset-right={insetRight} /> }));
vi.mock("../SubagentReadonlyView", () => ({ SubagentReadonlyView: () => <div data-testid="child-transcript">子对话</div> }));

let availableWidth = 1500;
beforeEach(() => {
  availableWidth = 1500;
  localStorage.removeItem("synax-sessions-right-panel");
  useAgentSessionStore.setState({ selectedSessionId: "parent", panelOpen: true, sessions: [{ id: "parent", status: "completed" } as AgentSession] });
  useSessionWorkspaceStore.setState({ sessions: {} });
  useSessionWorkspaceStore.getState().openSubagent("parent", "child", "林墨");
  useShellStore.setState(state => ({ preferences: { ...state.preferences, locale: "zh" } }));
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("work-session-layout") ? availableWidth : 300;
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
    return parseFloat(this.style.width) || 300;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.removeItem("synax-sessions-right-panel");
});
function mount() {
  return render(<MemoryRouter initialEntries={["/projects/project/sessions/parent"]}><SessionsPage /></MemoryRouter>);
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
    const pane = container.querySelector<HTMLElement>(".subagent-conversation-panel")!;
    drag(pane, 1000, 600);
    expect(pane.style.width).toBe("700px");
    expect(screen.getByTestId("command-rail")).toHaveAttribute("data-inset-right", "700");
    drag(pane, 1000, 0);
    expect(pane.style.width).toBe("960px");
    drag(pane, 0, 2000);
    expect(pane.style.width).toBe("240px");
  });

  it("reserves 320px for the parent when the window is narrower", () => {
    availableWidth = 900;
    const { container } = mount();
    const pane = container.querySelector<HTMLElement>(".subagent-conversation-panel")!;
    drag(pane, 1000, 0);
    expect(pane.style.width).toBe("580px");
  });

  it("restores the original pane width and mounted transcripts after fullscreen", () => {
    const { container } = mount();
    const pane = container.querySelector<HTMLElement>(".subagent-conversation-panel")!;
    drag(pane, 1000, 600);
    const parent = screen.getByTestId("parent-transcript");
    const child = screen.getByTestId("child-transcript");
    fireEvent.click(screen.getByRole("button", { name: "全屏查看子代理对话" }));
    expect(pane).toHaveAttribute("data-fullscreen", "true");
    expect(pane.querySelector('[role="separator"]')).toBeNull();
    expect(container.querySelector(".work-content-layout")).toHaveClass("hidden");
    expect(container.querySelector(".session-panel-host--left")).toHaveAttribute("hidden");
    expect(screen.getByTestId("command-rail")).toHaveAttribute("hidden");
    expect(screen.getByTestId("child-transcript")).toBe(child);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(pane).not.toHaveAttribute("data-fullscreen");
    expect(pane.style.width).toBe("700px");
    expect(container.querySelector(".work-content-layout")).not.toHaveClass("hidden");
    expect(screen.getByTestId("command-rail")).not.toHaveAttribute("hidden");
    expect(screen.getByTestId("parent-transcript")).toBe(parent);
    expect(screen.getByTestId("child-transcript")).toBe(child);
  });
});
