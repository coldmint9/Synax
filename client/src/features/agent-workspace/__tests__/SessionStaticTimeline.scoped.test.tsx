import { act, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentSession, AgentRunStep } from "../../../adapters/transport/agentRuntime";
import type { ConversationTimelineEntry } from "../buildConversationTimeline";
import { SessionStaticTimeline } from "../SessionStaticTimeline";
import { ConversationController } from "../state/conversationController";
import { useAgentSessionStore } from "../state/agentSessionStore";
import { EMPTY_STREAMING_BUFFERS } from "../streamingLiveBlocks";

vi.mock("../TimelineEntryView", () => ({ TimelineEntryView: ({ entry }: { entry: ConversationTimelineEntry }) => <div>{entry.kind === "agent" ? entry.turn.blocks.map(block => "content" in block ? block.content : "").join("") : entry.label}</div> }));
vi.mock("../TimelineLazyEntry", () => ({ TimelineLazyEntry: ({ children }: { children: React.ReactNode }) => children, estimateEntryHeight: () => 100 }));
afterEach(() => act(() => useAgentSessionStore.setState(useAgentSessionStore.getInitialState())));

it("renders only the scoped child's live text while the selected main stream changes", () => {
  const controller = new ConversationController("child");
  const session = { id: "child", status: "running", createdAt: "2026-10-28T00:00:00Z", prompt: "" } as AgentSession;
  const step = { id: "child-step", sessionId: "child", runId: "child-run", status: "running", index: 1 } as AgentRunStep;
  controller.store.setState({ session, streamingStepId: step.id, streamingLive: { ...EMPTY_STREAMING_BUFFERS, pendingText: "child answer" } });
  useAgentSessionStore.setState({ selectedSessionId: "main", streamingStepId: "main-step", streamingLive: { ...EMPTY_STREAMING_BUFFERS, pendingText: "main answer" } });
  render(<SessionStaticTimeline scopedConversation={controller} unifiedLive session={session} runs={[]} steps={[step]} messages={[]} toolCalls={[]} excludeStepId={step.id} isRunning />);
  expect(screen.getAllByText("child answer")).toHaveLength(1);
  expect(screen.queryByText("main answer")).toBeNull();
  act(() => useAgentSessionStore.setState({ streamingLive: { ...EMPTY_STREAMING_BUFFERS, pendingText: "main next answer" } }));
  expect(screen.getAllByText("child answer")).toHaveLength(1);
  act(() => controller.store.setState({ streamingLive: { ...EMPTY_STREAMING_BUFFERS, pendingText: "child next answer" } }));
  expect(screen.getAllByText("child next answer")).toHaveLength(1);
  expect(screen.queryByText("main next answer")).toBeNull();
});
