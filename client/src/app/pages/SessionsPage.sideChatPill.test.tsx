import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { agentRuntimeApi, type AgentSession } from "../../adapters/transport/agentRuntime";
import { useAgentSessionStore } from "../../features/agent-workspace/state/agentSessionStore";
import { useSessionWorkspaceStore } from "../../features/agent-workspace/state/sessionWorkspaceStore";
import { SWITCH_TRANSITION_MIN_MS } from "../../features/agent-workspace/useSwitchTransition";
import { useShellStore } from "../../shared/state/shellStore";
import SessionsPage from "./SessionsPage";

vi.mock("../../features/agent-workspace/useSessionDetailPolling", () => ({
  useSessionDetailPolling: () => {},
}));
vi.mock("../../features/agent-workspace/useSessionLiveStream", () => ({
  useSessionLiveStream: () => {},
}));
vi.mock("../../features/agent-workspace/useSessionRouteSync", () => ({
  useSessionRouteSync: () => {},
}));
vi.mock("../../shared/hooks/useMediaQuery", () => ({
  useMediaQuery: () => true,
}));
vi.mock("../../features/agent-workspace/SessionTranscript", () => ({
  SessionTranscript: () => <div data-testid="transcript" />,
}));
vi.mock("../../features/agent-workspace/SessionListPanel", () => ({
  SessionListPanel: () => null,
}));
vi.mock("../../features/agent-workspace/SessionWorkspacePanel", () => ({
  SessionWorkspacePanel: () => null,
}));
vi.mock("../../features/agent-workspace/SessionComposer", () => ({
  SessionComposer: () => null,
}));
vi.mock("../../features/agent-workspace/AgentCommandRail", () => ({
  AgentCommandRail: () => null,
}));
vi.mock("../../features/agent-workspace/SubagentConversationPanel", () => ({
  SubagentConversationPanel: () => null,
}));
vi.mock("../../features/agent-workspace/WorkspaceWidgetDock", () => ({
  WorkspaceWidgetDock: () => null,
}));
vi.mock("../../features/agent-workspace/SideChatPanel", () => ({
  SideChatPanel: ({ onCollapse }: { onCollapse: () => void }) => (
    <div data-testid="side-chat-panel">
      <button type="button" onClick={onCollapse}>
        收起侧边聊天
      </button>
    </div>
  ),
}));

function mount() {
  return render(
    <MemoryRouter initialEntries={["/projects/project/sessions/parent"]}>
      <SessionsPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useShellStore.setState((state) => ({
    preferences: { ...state.preferences, locale: "zh" },
  }));
  useAgentSessionStore.setState({
    ...useAgentSessionStore.getInitialState(),
    projectId: "project",
    selectedSessionId: "parent",
    panelOpen: true,
    sessions: [
      { id: "parent", status: "completed" } as AgentSession,
      { id: "other", status: "completed" } as AgentSession,
    ],
  });
  useSessionWorkspaceStore.setState({ sessions: {} });
  vi.spyOn(agentRuntimeApi, "readSideChat").mockResolvedValue({ session: null });
});
afterEach(() => {
  vi.restoreAllMocks();
  useSessionWorkspaceStore.setState({ sessions: {} });
  useAgentSessionStore.setState(useAgentSessionStore.getInitialState());
});

async function settleSwitch() {
  await act(async () => {
    await new Promise((resolve) =>
      window.setTimeout(resolve, SWITCH_TRANSITION_MIN_MS + 20),
    );
  });
}

it("collapses the side chat into a pill and restores the expanded layout per conversation", async () => {
  mount();
  expect(
    screen.queryByRole("button", { name: "打开侧边聊天" }),
  ).not.toBeInTheDocument();

  act(() =>
    useSessionWorkspaceStore.getState().attachSideChat("parent", "side"),
  );
  expect(screen.getByTestId("side-chat-panel")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "收起侧边聊天" }));
  expect(screen.queryByTestId("side-chat-panel")).not.toBeInTheDocument();
  expect(
    useSessionWorkspaceStore.getState().sessions.parent.sideChat,
  ).toEqual({ sessionId: "side", open: false });

  fireEvent.click(screen.getByRole("button", { name: "打开侧边聊天" }));
  expect(screen.getByTestId("side-chat-panel")).toBeInTheDocument();

  // Another conversation has no side chat, and coming back keeps this one open.
  act(() => useAgentSessionStore.setState({ selectedSessionId: "other" }));
  await settleSwitch();
  expect(
    screen.queryByRole("button", { name: "打开侧边聊天" }),
  ).not.toBeInTheDocument();
  act(() => useAgentSessionStore.setState({ selectedSessionId: "parent" }));
  await settleSwitch();
  expect(screen.getByTestId("side-chat-panel")).toBeInTheDocument();
});

it("keeps the expanded side chat when another activity panel replaces the page", () => {
  const view = mount();
  act(() =>
    useSessionWorkspaceStore.getState().attachSideChat("parent", "side"),
  );
  view.unmount();

  // The page remounts on the way back; the layout store still owns the state.
  mount();
  expect(screen.getByTestId("side-chat-panel")).toBeInTheDocument();
});
