import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentRuntimeMessage, AgentSession } from "../../../adapters/transport/agentRuntime";
import { SessionTreeItem } from "../SessionTreeItem";
import { useAgentSessionStore, type SessionDetailCacheEntry } from "../state/agentSessionStore";

vi.mock("../../../shared/ui/context-menu/ContextMenuProvider", () => ({
  useContextMenu: () => ({ openFromAnchor: vi.fn(), onContextMenu: vi.fn() }),
}));
vi.mock("../../../shared/hooks/useLocale", () => ({
  useLocale: () => ({ locale: "en", t: (key: string) => key }),
}));
vi.mock("../useSessionDisplayTitle", () => ({
  useSessionDisplayTitle: (session: AgentSession) => session.title,
  resolveSessionUserInput: () => "",
}));

beforeEach(() => {
  useAgentSessionStore.setState(useAgentSessionStore.getInitialState());
});
afterEach(cleanup);

it("does not reread cached transcripts on unrelated stream updates, but updates changed previews", () => {
  const reads = vi.fn();
  const message = (id: string, content: string): AgentRuntimeMessage => ({
    id: `message-${id}`, sessionId: id, role: "assistant",
    get content() { reads(id); return content; },
  } as AgentRuntimeMessage);
  const sessions = Array.from({ length: 20 }, (_, index) => ({
    id: `s${index}`, title: `Session ${index}`, status: "running", prompt: "",
  } as AgentSession));
  const cache = Object.fromEntries(sessions.map((session) => [session.id, {
    messages: [message(session.id, `Reply ${session.id}`)],
  } as SessionDetailCacheEntry]));
  useAgentSessionStore.setState({ sessions, selectedSessionId: "s0",
    messages: cache.s0.messages, sessionDetailCache: cache });
  render(<>{sessions.map((session) => <SessionTreeItem key={session.id}
    node={{ session, depth: 0, children: [], expanded: false }}
    isSelected={session.id === "s0"} onSelect={() => {}} onToggleExpand={() => {}}
  />)}</>);
  expect(screen.getByText("Reply s19")).toBeInTheDocument();
  reads.mockClear();
  act(() => {
    for (let index = 0; index < 100; index++) {
      useAgentSessionStore.setState({ streamingStepId: `step-${index}` });
    }
  });
  expect(reads).not.toHaveBeenCalled();
  act(() => {
    useAgentSessionStore.setState({ messages: [message("s0", "New foreground reply")] });
  });
  expect(screen.getByText("New foreground reply")).toBeInTheDocument();
  expect(reads.mock.calls.every(([id]) => id === "s0")).toBe(true);
  reads.mockClear();
  act(() => {
    useAgentSessionStore.setState({ sessionDetailCache: {
      ...cache, s19: { ...cache.s19, messages: [message("s19", "New background reply")] },
    } });
  });
  expect(screen.getByText("New background reply")).toBeInTheDocument();
  expect(reads.mock.calls.every(([id]) => id === "s19")).toBe(true);
});
