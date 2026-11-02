import { StrictMode } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { agentRuntimeApi, type AgentSession } from "../../../adapters/transport/agentRuntime";
import { AppError } from "../../../shared/lib/appError";
import { handleError } from "../../../shared/lib/errors";
import {
  isRuntimeResourceGone,
  resetRuntimeResourceRegistryForTests,
} from "../../../shared/lib/runtimeResourceRegistry";
import { useNotificationStore } from "../../../shared/state/notificationStore";
import { useShellStore } from "../../../shared/state/shellStore";
import { useAgentSessionStore } from "../state/agentSessionStore";
import { listRootSessions } from "../sessionBuckets";
import { SideChatPanel } from "../SideChatPanel";

vi.mock("../SideChatConversation", () => ({
  SideChatConversation: ({ session }: { session: AgentSession }) => <>
    <div data-testid="side-composer">{session.id}</div>
    <div data-testid="side-transcript">{session.id}</div>
  </>,
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
  ...source, id: "side", parentSessionId: source.id, activeRunId: null,
  sessionMetadata: {
    mode: "chat", subagentKind: "side-chat",
    sideChatContext: {
      kind: "side-chat", sourceSessionId: source.id, sourceRevision: 1,
      inheritedThrough: "2026-10-28T00:00:00.000Z", createdAt: "2026-10-28T00:00:00.000Z",
    },
  },
} as AgentSession;
const payload = { session: side, reused: false } as Awaited<ReturnType<typeof agentRuntimeApi.createSideChat>>;

function missingResource(id: string): AppError {
  return new AppError(`Agent runtime resource not found: ${id}`, {
    level: "business",
    code: "NOT_FOUND",
    statusCode: 404,
  });
}

function renderPanel(overrides: {
  sideChatId?: string | null;
  onCollapse?: () => void;
  onSessionReady?: (sessionId: string) => void;
  onSessionMissing?: () => void;
  onDeleted?: () => void;
} = {}) {
  return render(
    <SideChatPanel
      parentSession={source}
      sideChatId={overrides.sideChatId}
      onCollapse={overrides.onCollapse ?? vi.fn()}
      onSessionReady={overrides.onSessionReady ?? vi.fn()}
      onSessionMissing={overrides.onSessionMissing ?? vi.fn()}
      onDeleted={overrides.onDeleted ?? vi.fn()}
    />,
  );
}

beforeEach(() => {
  resetRuntimeResourceRegistryForTests();
  useNotificationStore.setState({ notifications: [], unreadCount: 0 });
  useShellStore.setState((state) => ({ preferences: { ...state.preferences, locale: "zh" } }));
  useAgentSessionStore.setState({
    ...useAgentSessionStore.getInitialState(),
    projectId: source.projectId, selectedSessionId: source.id, sessions: [source],
    refreshSessions: vi.fn(async () => {}),
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  resetRuntimeResourceRegistryForTests();
  useAgentSessionStore.setState(useAgentSessionStore.getInitialState());
});

it("creates an interactive child and leaves the selected conversation intact", async () => {
  const create = vi.spyOn(agentRuntimeApi, "createSideChat").mockResolvedValue(payload);
  const ready = vi.fn();
  renderPanel({ onSessionReady: ready });
  expect(await screen.findByTestId("side-composer")).toHaveTextContent("side");
  expect(create).toHaveBeenCalledWith("main");
  expect(ready).toHaveBeenCalledExactlyOnceWith("side");
  expect(useAgentSessionStore.getState().selectedSessionId).toBe("main");
  expect(listRootSessions(useAgentSessionStore.getState().sessions)).toEqual([source]);
  expect(useAgentSessionStore.getState().sessions).toEqual([source]);
  expect(useAgentSessionStore.getState().refreshSessions).not.toHaveBeenCalled();
});

it("shares one creation across StrictMode replay and parent status updates", async () => {
  let resolve!: (value: typeof payload) => void;
  const create = vi.spyOn(agentRuntimeApi, "createSideChat").mockReturnValue(
    new Promise((done) => { resolve = done; }),
  );
  const ready = vi.fn();
  const view = render(
    <StrictMode>
      <SideChatPanel parentSession={source} onCollapse={vi.fn()} onSessionReady={ready} onSessionMissing={vi.fn()} onDeleted={vi.fn()} />
    </StrictMode>,
  );
  view.rerender(
    <StrictMode>
      <SideChatPanel parentSession={{ ...source, status: "completed" }} onCollapse={vi.fn()} onSessionReady={ready} onSessionMissing={vi.fn()} onDeleted={vi.fn()} />
    </StrictMode>,
  );
  expect(create).toHaveBeenCalledOnce();
  await act(async () => resolve(payload));
  expect(await screen.findByTestId("side-transcript")).toHaveTextContent("side");
  expect(screen.queryByText("正在准备侧边聊天…")).not.toBeInTheDocument();
  expect(ready).toHaveBeenCalledExactlyOnceWith("side");
});

it("reopens the stored side chat of a restored layout without creating another", async () => {
  const create = vi.spyOn(agentRuntimeApi, "createSideChat");
  const read = vi.spyOn(agentRuntimeApi, "getSessionSummary").mockResolvedValue({ session: side });
  renderPanel({ sideChatId: "side" });
  expect(await screen.findByTestId("side-composer")).toHaveTextContent("side");
  // The panel classifies a missing child itself; the HTTP layer must stay quiet.
  expect(read).toHaveBeenCalledWith("side", { silent: true });
  expect(create).not.toHaveBeenCalled();
});

it("turns a stored side chat the runtime no longer has into a fresh one", async () => {
  vi.spyOn(agentRuntimeApi, "getSessionSummary")
    .mockRejectedValue(Object.assign(new Error("side chat removed"), { statusCode: 404 }));
  const create = vi.spyOn(agentRuntimeApi, "createSideChat").mockResolvedValue(payload);
  const missing = vi.fn();
  const ready = vi.fn();
  const view = renderPanel({ sideChatId: "gone", onSessionMissing: missing, onSessionReady: ready });
  await waitFor(() => expect(missing).toHaveBeenCalledOnce());
  expect(create).not.toHaveBeenCalled();
  // The page drops the stale slot, so the same panel owns the new side chat.
  view.rerender(
    <SideChatPanel parentSession={source} onCollapse={vi.fn()} onSessionReady={ready} onSessionMissing={missing} onDeleted={vi.fn()} />,
  );
  expect(await screen.findByTestId("side-composer")).toHaveTextContent("side");
  expect(create).toHaveBeenCalledWith("main");
  expect(ready).toHaveBeenCalledExactlyOnceWith("side");
});

it("adopts a restored side chat once across StrictMode replay", async () => {
  const read = vi.spyOn(agentRuntimeApi, "getSessionSummary").mockResolvedValue({ session: side });
  render(
    <StrictMode>
      <SideChatPanel parentSession={source} sideChatId="side" onCollapse={vi.fn()} onSessionReady={vi.fn()} onSessionMissing={vi.fn()} onDeleted={vi.fn()} />
    </StrictMode>,
  );
  expect(await screen.findByTestId("side-composer")).toHaveTextContent("side");
  expect(read).toHaveBeenCalledOnce();
});

it("keeps a failure visible across rerenders and retries only on request", async () => {
  const create = vi.spyOn(agentRuntimeApi, "createSideChat")
    .mockRejectedValueOnce(new Error("Temporary failure"))
    .mockResolvedValueOnce(payload);
  const ready = vi.fn();
  const view = renderPanel({ onSessionReady: ready });
  expect(await screen.findByRole("alert")).toHaveTextContent("Temporary failure");
  view.rerender(
    <SideChatPanel parentSession={{ ...source }} onCollapse={vi.fn()} onSessionReady={ready} onSessionMissing={vi.fn()} onDeleted={vi.fn()} />,
  );
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Temporary failure"));
  expect(create).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  expect(await screen.findByTestId("side-composer")).toHaveTextContent("side");
  expect(create).toHaveBeenCalledTimes(2);
});

it("does not apply an abandoned creation to a newly selected conversation", async () => {
  let resolve!: (value: typeof payload) => void;
  vi.spyOn(agentRuntimeApi, "createSideChat").mockReturnValue(new Promise((done) => { resolve = done; }));
  const ready = vi.fn();
  const view = renderPanel({ onSessionReady: ready });
  view.unmount();
  useAgentSessionStore.setState({ projectId: "other-project", selectedSessionId: "other", sessions: [] });
  await act(async () => resolve(payload));
  expect(ready).not.toHaveBeenCalled();
  expect(useAgentSessionStore.getState().sessions).toEqual([]);
  expect(useAgentSessionStore.getState().selectedSessionId).toBe("other");
});

it("states the consequence before erasing the side chat, then discards it", async () => {
  const remove = vi.spyOn(agentRuntimeApi, "deleteSideChat")
    .mockResolvedValue({ ok: true, deletedSessionIds: ["side"] });
  vi.spyOn(agentRuntimeApi, "getSessionSummary").mockResolvedValue({ session: side });
  const deleted = vi.fn();
  renderPanel({ sideChatId: "side", onDeleted: deleted });
  expect(await screen.findByTestId("side-composer")).toHaveTextContent("side");
  fireEvent.click(screen.getByRole("button", { name: "删除侧边聊天" }));
  const dialog = screen.getByRole("alertdialog");
  expect(dialog).toHaveTextContent("无法恢复");
  expect(remove).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "删除侧边聊天" }));
  await waitFor(() => expect(deleted).toHaveBeenCalledOnce());
  expect(remove).toHaveBeenCalledWith("main");
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  // A reply that was already in flight when the data went away must not become
  // the "resource not found" toast the user reported after deleting.
  expect(isRuntimeResourceGone("side")).toBe(true);
  handleError(missingResource("side"));
  expect(useNotificationStore.getState().notifications).toHaveLength(0);
  handleError(missingResource("ars_unrelated"));
  expect(useNotificationStore.getState().notifications).toHaveLength(1);
});

it("keeps the side chat and reports a failed discard", async () => {
  vi.spyOn(agentRuntimeApi, "deleteSideChat").mockRejectedValue(new Error("purge failed"));
  vi.spyOn(agentRuntimeApi, "getSessionSummary").mockResolvedValue({ session: side });
  const deleted = vi.fn();
  renderPanel({ sideChatId: "side", onDeleted: deleted });
  expect(await screen.findByTestId("side-composer")).toHaveTextContent("side");
  fireEvent.click(screen.getByRole("button", { name: "删除侧边聊天" }));
  fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "删除侧边聊天" }));
  expect(await within(screen.getByRole("alertdialog")).findByRole("alert"))
    .toHaveTextContent("purge failed");
  expect(deleted).not.toHaveBeenCalled();
  expect(screen.getByTestId("side-composer")).toHaveTextContent("side");
});
