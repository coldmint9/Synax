import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionStaticTimeline } from "../SessionStaticTimeline";
import { useAgentSessionStore as store } from "../state/agentSessionStore";
import type { ConversationTimelineEntry } from "../buildConversationTimeline";
import type { AgentRun, AgentRunStep, AgentRuntimeMessage, AgentSession } from "../../../adapters/transport/agentRuntime";

vi.mock("../TimelineEntryView", () => ({
  TimelineEntryView: ({ entry }: { entry: ConversationTimelineEntry }) => <section data-testid={entry.id}>
    {entry.kind === "user" ? entry.content : entry.kind === "agent" ? entry.turn.blocks.map(block => "content" in block ? block.content : "").join(" ") : entry.kind === "work_log" ? entry.turns.flatMap(turn => turn.blocks.map(block => "content" in block ? block.content : "")).join(" ") : entry.label}
  </section>,
}));
const session = { id: "s", prompt: "hello", status: "completed", createdAt: "2026-01-01T00:00:00Z" } as AgentSession;
const runs = [1, 2].map(i => ({ id: `r${i}`, sessionId: "s", status: "completed", startedAt: `2026-01-01T00:00:${i === 1 ? "01" : "11"}Z` } as AgentRun));
const steps = runs.map((run, i) => ({ id: `step${i + 1}`, runId: run.id, sessionId: "s", index: 1, status: "completed", startedAt: `2026-01-01T00:00:${i === 0 ? "02" : "12"}Z`, completedAt: `2026-01-01T00:00:${i === 0 ? "04" : "14"}Z`, metadata: {} } as AgentRunStep));
const messages = [
  { id: "u1", role: "user", runId: "r1", stepId: null, content: "hello", createdAt: "2026-01-01T00:00:01Z" },
  { id: "a1", role: "assistant", runId: "r1", stepId: "step1", content: "First answer", metadata: { thought: "First reasoning" }, createdAt: "2026-01-01T00:00:04Z" },
  { id: "u2", role: "user", runId: "r2", stepId: null, content: "dd", createdAt: "2026-01-01T00:00:11Z" },
  { id: "a2", role: "assistant", runId: "r2", stepId: "step2", content: "Second answer", metadata: { thought: "Second reasoning" }, createdAt: "2026-01-01T00:00:14Z" },
].map(message => ({ sessionId: "s", metadata: {}, ...message } as AgentRuntimeMessage));
const props = { unifiedLive: true, session, runs, steps, messages, toolCalls: [], isRunning: false };
const snapshot = { stepId: "step1", stepIndex: 1, runId: "r1", blocks: [{ type: "thinking" as const, content: "First reasoning" }] };
beforeEach(() => store.setState({ ...store.getInitialState(), selectedSessionId: "s", streamingCompletedSteps: [snapshot] }));
afterEach(() => act(() => store.setState(store.getInitialState())));
const precedes = (first: HTMLElement, second: HTMLElement) => expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

it("renders persisted answers in their original turns even with a stale reasoning cache", () => {
  render(<SessionStaticTimeline {...props} />);
  expect(screen.getAllByText("First answer")).toHaveLength(1);
  precedes(screen.getByText("hello"), screen.getByText("First reasoning"));
  precedes(screen.getByText("First reasoning"), screen.getByText("First answer"));
  precedes(screen.getByText("First answer"), screen.getByText("dd"));
  precedes(screen.getByText("dd"), screen.getByText("Second answer"));
});

it("keeps a genuinely pending first turn before the next prompt and hands it off when history arrives", () => {
  const { rerender } = render(<SessionStaticTimeline {...props} messages={messages.filter(message => message.id !== "a1")} />);
  precedes(screen.getByText("hello"), screen.getByText("First reasoning"));
  precedes(screen.getByText("First reasoning"), screen.getByText("dd"));
  rerender(<SessionStaticTimeline {...props} />);
  expect(screen.getAllByText("First reasoning")).toHaveLength(1);
  expect(screen.getAllByText("First answer")).toHaveLength(1);
  precedes(screen.getByText("First answer"), screen.getByText("dd"));
});

it("keeps the captured position when the previous step is absent from the next history page", () => {
  store.setState({ streamingCompletedSteps: [{ ...snapshot, startedAt: steps[0].startedAt }] });
  render(<SessionStaticTimeline {...props} steps={[steps[1]]} runs={[runs[1]]} messages={messages.filter(message => message.id !== "a1")} />);
  precedes(screen.getByText("hello"), screen.getByText("First reasoning"));
  precedes(screen.getByText("First reasoning"), screen.getByText("dd"));
});
