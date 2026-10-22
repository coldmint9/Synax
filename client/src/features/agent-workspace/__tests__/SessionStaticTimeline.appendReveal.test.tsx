import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionStaticTimeline } from "../SessionStaticTimeline";
import { useAgentSessionStore as store } from "../state/agentSessionStore";
import type { ConversationTimelineEntry } from "../buildConversationTimeline";
import type {
  AgentRun,
  AgentRunStep,
  AgentRuntimeMessage,
  AgentSession,
} from "../../../adapters/transport/agentRuntime";

vi.mock("../TimelineEntryView", () => ({
  TimelineEntryView: ({ entry }: { entry: ConversationTimelineEntry }) => (
    <section data-testid={entry.id} />
  ),
}));

const session = {
  id: "s",
  prompt: "hello",
  status: "completed",
  createdAt: "2026-01-01T00:00:00Z",
} as AgentSession;
const runs = [
  { id: "r1", sessionId: "s", status: "completed", startedAt: "2026-01-01T00:00:01Z" },
  { id: "r2", sessionId: "s", status: "completed", startedAt: "2026-01-01T00:00:11Z" },
] as AgentRun[];
const steps = runs.map(
  (run, index) =>
    ({
      id: `step${index + 1}`,
      runId: run.id,
      sessionId: "s",
      index: 1,
      status: "completed",
      startedAt: `2026-01-01T00:00:0${index === 0 ? 2 : 2}Z`,
      completedAt: `2026-01-01T00:00:0${index === 0 ? 4 : 4}Z`,
      metadata: {},
    }) as AgentRunStep,
);
const earlier = {
  id: "u0",
  role: "user",
  runId: "r1",
  stepId: null,
  content: "older",
  createdAt: "2026-01-01T00:00:00Z",
  sessionId: "s",
  metadata: {},
} as AgentRuntimeMessage;
const messages = [
  {
    id: "u1",
    role: "user",
    runId: "r1",
    stepId: null,
    content: "hello",
    createdAt: "2026-01-01T00:00:01Z",
  },
  {
    id: "u2",
    role: "user",
    runId: "r2",
    stepId: null,
    content: "next",
    createdAt: "2026-01-01T00:00:11Z",
  },
  {
    id: "u3",
    role: "user",
    runId: "r2",
    stepId: null,
    content: "latest",
    createdAt: "2026-01-01T00:00:21Z",
  },
].map((message) => ({ sessionId: "s", metadata: {}, ...message }) as AgentRuntimeMessage);
const props = { unifiedLive: true, session, runs, steps, toolCalls: [], isRunning: false };

beforeEach(() => store.setState({ ...store.getInitialState(), selectedSessionId: "s" }));
afterEach(() => act(() => store.setState(store.getInitialState())));

function rowIds(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLElement>("[data-session-entry]")].map(
    (row) => row.dataset.sessionEntry ?? "",
  );
}
function revealedIds(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLElement>("[data-session-entry]")]
    .filter((row) => row.classList.contains("session-entry-appended"))
    .map((row) => row.dataset.sessionEntry ?? "");
}

it("does not reveal the transcript that is already on screen", () => {
  const { container } = render(<SessionStaticTimeline {...props} messages={messages} />);
  expect(rowIds(container)).toEqual(expect.arrayContaining(["u1", "u2", "u3"]));
  expect(revealedIds(container)).toEqual([]);
});

it("reveals only the row appended to the tail", () => {
  const { container, rerender } = render(
    <SessionStaticTimeline {...props} messages={messages.slice(0, 2)} />,
  );
  rerender(<SessionStaticTimeline {...props} messages={messages} />);
  expect(revealedIds(container)).toEqual(["u3"]);
});

it("does not reveal an earlier history page that lands above the transcript", () => {
  const { container, rerender } = render(
    <SessionStaticTimeline {...props} messages={messages} />,
  );
  rerender(<SessionStaticTimeline {...props} messages={[earlier, ...messages]} />);
  expect(rowIds(container)).toContain("u0");
  expect(revealedIds(container)).toEqual([]);
});

it("keeps the reveal on the row it was applied to and never re-animates the rest", () => {
  const { container, rerender } = render(
    <SessionStaticTimeline {...props} messages={messages.slice(0, 2)} />,
  );
  rerender(<SessionStaticTimeline {...props} messages={messages} />);
  rerender(<SessionStaticTimeline {...props} messages={[...messages]} />);
  expect(revealedIds(container)).toEqual(["u3"]);
});
