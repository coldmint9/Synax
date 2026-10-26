import { StrictMode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { agentRuntimeApi, type AgentSession } from "../../../adapters/transport/agentRuntime";
import { useShellStore } from "../../../shared/state/shellStore";
import { useAgentSessionStore } from "../state/agentSessionStore";
import { isAgentWorkspaceSession, listRootSessions } from "../sessionBuckets";
import { SideChatPanel } from "../SideChatPanel";

vi.mock("../SessionComposer", () => ({
  SessionComposer: ({ session }: { session: AgentSession }) => (
    <div data-testid="side-composer">{session.id}</div>
  ),
}));
vi.mock("../SubagentReadonlyView", () => ({
  SubagentReadonlyView: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="side-transcript">{sessionId}</div>
  ),
}));

const source = {
  id: "main", projectId: "p", nodeId: null, profileId: "synax",
  parentSessionId: null, childSessionIds: [], status: "running", activeRunId: "run-main",
  model: "provider/model", reasoningEffort: "high", skillIds: [],
  sessionMetadata: {
    source: "session-page", mode: "goal", permissionTier: "boundary",
    backend: { id: "native", workDir: "/workspace/feature" },
  },
} as AgentSession;
const side = {
  ...source, id: "side", activeRunId: null,
  sessionMetadata: {
    source: "session-page", mode: "chat", sideChat: true,
    sideChatSourceSessionId: source.id,
  },
} as AgentSession;
const payload = { session: side } as Awaited<ReturnType<typeof agentRuntimeApi.createSession>>;

beforeEach(() => {
  useShellStore.setState((state) => ({ preferences: { ...state.preferences, locale: "zh" } }));
  useAgentSessionStore.setState({
    ...useAgentSessionStore.getInitialState(),
    projectId: source.projectId, selectedSessionId: source.id, sessions: [source],
    refreshSessions: vi.fn(async () => {}),
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  useAgentSessionStore.setState(useAgentSessionStore.getInitialState());
});

it("creates an independent interactive session and leaves the selected conversation intact", async () => {
  const create = vi.spyOn(agentRuntimeApi, "createSession").mockResolvedValue(payload);
  const ready = vi.fn();
  render(<SideChatPanel projectId="p" parentSession={source} onClose={vi.fn()} onSessionReady={ready} />);
  expect(await screen.findByTestId("side-composer")).toHaveTextContent("side");
  const request = create.mock.calls[0][0];
  expect(request).toMatchObject({
    profileId: "synax", projectId: "p", model: source.model,
    workDir: "/workspace/feature",
    sessionMetadata: { source: "session-page", mode: "chat", sideChatSourceSessionId: "main" },
  });
  expect(request).not.toHaveProperty("parentSessionId");
  expect(request.sessionMetadata).not.toHaveProperty("parentSessionId");
  expect(ready).toHaveBeenCalledExactlyOnceWith(side);
  expect(useAgentSessionStore.getState().selectedSessionId).toBe("main");
  expect(source.childSessionIds).toEqual([]);
  expect(listRootSessions(useAgentSessionStore.getState().sessions)).toContain(side);
  expect(isAgentWorkspaceSession(side)).toBe(true);
});

it("shares one creation across StrictMode replay and parent status updates", async () => {
  let resolve!: (value: typeof payload) => void;
  const create = vi.spyOn(agentRuntimeApi, "createSession").mockReturnValue(
    new Promise((done) => { resolve = done; }),
  );
  const ready = vi.fn();
  const view = render(<StrictMode><SideChatPanel projectId="p" parentSession={source} onClose={vi.fn()} onSessionReady={ready} /></StrictMode>);
  view.rerender(<StrictMode><SideChatPanel projectId="p" parentSession={{ ...source, status: "completed" }} onClose={vi.fn()} onSessionReady={ready} /></StrictMode>);
  expect(create).toHaveBeenCalledOnce();
  await act(async () => resolve(payload));
  expect(await screen.findByTestId("side-transcript")).toHaveTextContent("side");
  expect(screen.queryByText("正在准备侧边聊天…")).not.toBeInTheDocument();
  expect(ready).toHaveBeenCalledExactlyOnceWith(side);
});

it("reopens an existing side chat without creating another session", async () => {
  const create = vi.spyOn(agentRuntimeApi, "createSession");
  render(<SideChatPanel projectId="p" parentSession={source} session={side} onClose={vi.fn()} onSessionReady={vi.fn()} />);
  expect(screen.getByTestId("side-composer")).toHaveTextContent("side");
  expect(create).not.toHaveBeenCalled();
});

it("keeps a failure visible across rerenders and retries only on request", async () => {
  const create = vi.spyOn(agentRuntimeApi, "createSession")
    .mockRejectedValueOnce(new Error("Temporary failure"))
    .mockResolvedValueOnce(payload);
  const ready = vi.fn();
  const view = render(<SideChatPanel projectId="p" parentSession={source} onClose={vi.fn()} onSessionReady={ready} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Temporary failure");
  view.rerender(<SideChatPanel projectId="p" parentSession={{ ...source }} onClose={vi.fn()} onSessionReady={ready} />);
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Temporary failure"));
  expect(create).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  expect(await screen.findByTestId("side-composer")).toHaveTextContent("side");
  expect(create).toHaveBeenCalledTimes(2);
});

it("does not apply an abandoned creation to a newly selected conversation", async () => {
  let resolve!: (value: typeof payload) => void;
  vi.spyOn(agentRuntimeApi, "createSession").mockReturnValue(new Promise((done) => { resolve = done; }));
  const ready = vi.fn();
  const view = render(<SideChatPanel projectId="p" parentSession={source} onClose={vi.fn()} onSessionReady={ready} />);
  view.unmount();
  useAgentSessionStore.setState({ projectId: "other-project", selectedSessionId: "other", sessions: [] });
  await act(async () => resolve(payload));
  expect(ready).not.toHaveBeenCalled();
  expect(useAgentSessionStore.getState().sessions).toEqual([]);
  expect(useAgentSessionStore.getState().selectedSessionId).toBe("other");
});
