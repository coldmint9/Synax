import { act, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAgentSessionStore } from "../../features/agent-workspace/state/agentSessionStore";
import { useSessionWorkspaceStore } from "../../features/agent-workspace/state/sessionWorkspaceStore";
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
  useMediaQuery: () => false,
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
vi.mock("../../features/agent-workspace/SideChatPanel", () => ({
  SideChatPanel: () => null,
}));
vi.mock("../../features/agent-workspace/SubagentConversationPanel", () => ({
  SubagentConversationPanel: () => null,
}));
vi.mock("../../features/agent-workspace/WorkspaceWidgetDock", () => ({
  WorkspaceWidgetDock: () => null,
}));

let navigateTo: (to: string) => void;

function Harness() {
  navigateTo = useNavigate();
  return (
    <Routes>
      <Route path="/projects/:projectId/sessions" element={<SessionsPage />} />
      <Route
        path="/projects/:projectId/sessions/workflows"
        element={<SessionsPage />}
      />
    </Routes>
  );
}

function mount() {
  return render(
    <MemoryRouter initialEntries={["/projects/a/sessions"]}>
      <Harness />
    </MemoryRouter>,
  );
}

function conversation(container: HTMLElement) {
  const element = container.querySelector(".work-content-layout");
  if (!element) throw new Error("conversation surface not rendered");
  return element;
}

function shell(container: HTMLElement) {
  const element = container.querySelector(".agent-page-shell");
  if (!element) throw new Error("workspace shell not rendered");
  return element;
}

function isSwitching(container: HTMLElement) {
  return conversation(container).getAttribute("data-conversation-switch") === "true";
}

beforeEach(() => {
  localStorage.removeItem("synax.sessionLastVisit:a");
  localStorage.removeItem("synax.sessionLastVisit:b");
  localStorage.removeItem("synax.sessionLastVisit:c");
  useAgentSessionStore.setState({
    ...useAgentSessionStore.getInitialState(),
    projectId: "a",
    sessions: [],
    selectedSessionId: null,
    panelOpen: false,
    sessionListLoading: false,
    sessionListLoadedAt: Date.now(),
    detailLoading: false,
    detailRefreshing: false,
  });
  useSessionWorkspaceStore.setState({ sessions: {} });
});

afterEach(() => {
  vi.restoreAllMocks();
});

it("blurs the conversation surface until the new workspace is loaded and bound", async () => {
  const { container } = mount();
  expect(isSwitching(container)).toBe(false);

  act(() => navigateTo("/projects/b/sessions"));
  expect(conversation(container).getAttribute("data-conversation-switch")).toBe("true");
  // The mask stops at the conversation: neither the page shell nor the session
  // list is blurred or locked while the workspace loads.
  expect(shell(container).hasAttribute("inert")).toBe(false);
  expect(
    container.querySelector(".session-panel-host--left")?.hasAttribute("inert"),
  ).toBe(false);
  expect(conversation(container).hasAttribute("inert")).toBe(true);

  // The store still belongs to the workspace being left, so the blur holds.
  await new Promise((resolve) => setTimeout(resolve, 350));
  expect(conversation(container).getAttribute("data-conversation-switch")).toBe("true");

  act(() => useAgentSessionStore.setState({ projectId: "b" }));
  await waitFor(() =>
    expect(isSwitching(container)).toBe(false),
  );
});

it("keeps the blur while the new workspace list is still loading", async () => {
  const { container } = mount();
  act(() => navigateTo("/projects/c/sessions"));
  act(() =>
    useAgentSessionStore.setState({
      projectId: "c",
      sessionListLoading: true,
      sessionListLoadedAt: 0,
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 350));
  expect(conversation(container).getAttribute("data-conversation-switch")).toBe("true");

  act(() =>
    useAgentSessionStore.setState({
      sessionListLoading: false,
      sessionListLoadedAt: Date.now(),
    }),
  );
  await waitFor(() =>
    expect(isSwitching(container)).toBe(false),
  );
});


it("holds the blur while a remembered conversation is replayed", async () => {
  localStorage.setItem(
    "synax.sessionLastVisit:c",
    JSON.stringify({ kind: "session", sessionId: "s1" }),
  );
  const { container } = mount();
  act(() => navigateTo("/projects/c/sessions"));
  act(() =>
    useAgentSessionStore.setState({
      projectId: "c",
      sessionListLoadedAt: Date.now(),
      sessionListLoading: false,
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 350));
  expect(conversation(container).getAttribute("data-conversation-switch")).toBe("true");

  // The route replays the remembered session; the blur keeps holding until
  // that conversation and its records are in place.
  act(() => navigateTo("/projects/c/sessions?session=s1"));
  act(() => useAgentSessionStore.setState({ selectedSessionId: "s1" }));
  await waitFor(() =>
    expect(isSwitching(container)).toBe(false),
  );
});

it("does not wait for a replay on the workflow list", async () => {
  localStorage.setItem(
    "synax.sessionLastVisit:c",
    JSON.stringify({ kind: "session", sessionId: "s1" }),
  );
  const { container } = mount();
  act(() => navigateTo("/projects/c/sessions/workflows"));
  act(() => useAgentSessionStore.setState({ projectId: "c" }));
  await waitFor(
    () => expect(isSwitching(container)).toBe(false),
    { timeout: 900 },
  );
});

it("releases a workspace switch that never settles at the wait ceiling", async () => {
  const { container } = mount();
  act(() => navigateTo("/projects/b/sessions"));
  expect(conversation(container).getAttribute("data-conversation-switch")).toBe("true");
  await waitFor(
    () => expect(isSwitching(container)).toBe(false),
    { timeout: 3_000 },
  );
}, 10_000);
