import { StrictMode } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { agentRuntimeApi, type AgentSession, type HistoryWindowResponse } from "../../../adapters/transport/agentRuntime";
import type { SessionLiveEvent } from "../../../adapters/transport/sessionLive";
import { useAgentSessionStore } from "../state/agentSessionStore";
import { useScopedConversationValue } from "../state/useConversationState";
import type { ConversationController } from "../state/conversationController";
import { materializeLiveBlocks } from "../streamingLiveBlocks";
import { InteractiveSubagentView } from "../InteractiveSubagentView";

const fixtures = vi.hoisted(() => ({ callbacks: new Map<string, (event: SessionLiveEvent) => void>(), opens: vi.fn(), renders: vi.fn() }));
vi.mock("../../../adapters/transport/sessionLiveClient", () => ({ addSessionLiveListener: (id: string, callback: (event: SessionLiveEvent) => void) => { fixtures.opens(id); fixtures.callbacks.set(id, callback); return () => fixtures.callbacks.delete(id); } }));
vi.mock("../useTranscriptScroll", () => ({ useTranscriptScroll: () => ({ scrollToBottom: vi.fn() }) }));
vi.mock("../AgentInteractionPanel", () => ({ InteractionSessionProvider: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("../ThinkingIndicator", () => ({ ThinkingIndicator: () => <span>thinking</span> }));
vi.mock("../AgentConversationView", () => ({
  AgentConversationView: (props: { scopedConversation: ConversationController; session: AgentSession }) => {
    fixtures.renders(props.session.id);
    return <StreamProbe controller={props.scopedConversation} />;
  },
}));
function StreamProbe({ controller }: { controller: ConversationController }) {
  const live = useScopedConversationValue(controller, state => state.streamingLive)!;
  return <div data-testid={controller.sessionId}>{materializeLiveBlocks(live).filter(block => block.type === "text").map(block => block.content).join("")}</div>;
}
const session = (id: string) => ({ id, projectId: "project", parentSessionId: "parent", childSessionIds: [], status: "running", activeRunId: `run-${id}`, sessionMetadata: {}, prompt: "question" } as AgentSession);
const history = (): HistoryWindowResponse => ({ messages: [], runs: [], steps: [], toolCalls: [], permissions: [], events: [], historyWindow: { revision: 0, epoch: 0, latest: true, hasEarlier: false, detailsTruncated: false } });
beforeEach(() => {
  fixtures.opens.mockClear(); fixtures.renders.mockClear(); fixtures.callbacks.clear();
  vi.spyOn(agentRuntimeApi, "getSessionSummary").mockImplementation(async id => ({ session: session(id) }));
  vi.spyOn(agentRuntimeApi, "historyWindow").mockImplementation(async () => history());
  vi.spyOn(agentRuntimeApi, "listInteractions").mockResolvedValue({ interactions: [] });
});
afterEach(() => vi.restoreAllMocks());

it("shares one retained StrictMode controller and keeps token rendering out of its parent and main session", async () => {
  const parent = { ...session("main-ui"), parentSessionId: null };
  useAgentSessionStore.setState({ selectedSessionId: parent.id, sessions: [parent] });
  const changed = vi.fn();
  render(<StrictMode><InteractiveSubagentView sessionId="child-ui" onSessionChange={changed} /></StrictMode>);
  await screen.findByTestId("child-ui");
  expect(fixtures.opens).toHaveBeenCalledTimes(1);
  act(() => fixtures.callbacks.get("child-ui")!({ type: "step_started", stepId: "step-child", stepIndex: 0, step: { id: "step-child", runId: "run-child-ui", sessionId: "child-ui", index: 0, status: "running" } as never }));
  const renderedBefore = fixtures.renders.mock.calls.length;
  const summariesBefore = changed.mock.calls.length;
  act(() => fixtures.callbacks.get("child-ui")!({ type: "message_delta", stepId: "step-child", delta: "streamed child text" }));
  await waitFor(() => expect(screen.getByTestId("child-ui")).toHaveTextContent("streamed child text"));
  expect(fixtures.renders).toHaveBeenCalledTimes(renderedBefore);
  expect(changed).toHaveBeenCalledTimes(summariesBefore);
  expect(useAgentSessionStore.getState().selectedSessionId).toBe("main-ui");
  expect(useAgentSessionStore.getState().sessions).toEqual([parent]);
});
