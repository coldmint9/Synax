import { Activity, StrictMode } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { agentRuntimeApi, type AgentSession } from "../../../adapters/transport/agentRuntime";
import { useShellStore } from "../../../shared/state/shellStore";
import { useAgentSessionStore } from "../state/agentSessionStore";
import { useSideChatStore } from "../state/sideChatStore";
import { useSessionWorkspaceStore } from "../state/sessionWorkspaceStore";
import { listRootSessions } from "../sessionBuckets";
import { SideChatPanel } from "../SideChatPanel";
import { SideChatIsland } from "../SideChatIsland";
import { resetRuntimeResourceRegistryForTests } from "../../../shared/lib/runtimeResourceRegistry";

vi.mock("../SessionComposer", () => ({ SessionComposer: ({ session }: { session: AgentSession }) => <div data-testid="side-composer">{session.id}</div> }));
vi.mock("../SubagentReadonlyView", () => ({ SubagentReadonlyView: ({ sessionId }: { sessionId: string }) => <div data-testid="side-transcript">{sessionId}</div> }));
vi.mock("../../../app/layouts/IslandSurface", () => ({ IslandSurface: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

const source = {
  id: "main", projectId: "p", profileId: "synax", parentSessionId: null,
  childSessionIds: [], status: "running", activeRunId: "run-main", updatedAt: "2026-10-26T00:00:00Z",
  sessionMetadata: { source: "session-page", mode: "goal" },
} as AgentSession;
const side = {
  ...source, id: "side", activeRunId: null, status: "completed",
  sessionMetadata: { source: "session-page", mode: "chat", sideChat: true, sideChatSourceSessionId: source.id },
} as AgentSession;
const payload = { session: side, sessionId: side.id };

beforeEach(() => {
  resetRuntimeResourceRegistryForTests();
  useShellStore.setState((state) => ({ preferences: { ...state.preferences, locale: "zh" } }));
  useAgentSessionStore.setState({ ...useAgentSessionStore.getInitialState(), projectId: "p", selectedSessionId: "main", sessions: [source] });
  useSideChatStore.setState({ chats: {} });
  useSessionWorkspaceStore.setState({ sessions: {} });
});
afterEach(() => { vi.restoreAllMocks(); });

function mount() { return render(<><SideChatIsland sessionId="main" /><SideChatPanel ownerSessionId="main" /></>); }
async function start() {
  act(() => useSideChatStore.getState().start(source));
  await screen.findByTestId("side-composer");
}

it("shows the highlighted header icon only after creation starts and hides the chat from the session list", async () => {
  const create = vi.spyOn(agentRuntimeApi, "createSideChat").mockResolvedValue(payload);
  mount();
  expect(screen.queryByRole("button", { name: "侧边聊天" })).toBeNull();
  await start();
  expect(create).toHaveBeenCalledWith("main", expect.any(String));
  expect(screen.getByRole("button", { name: "侧边聊天" })).toHaveAttribute("data-active", "true");
  expect(useAgentSessionStore.getState().selectedSessionId).toBe("main");
  expect(listRootSessions(useAgentSessionStore.getState().sessions)).toEqual([source]);
});

it("does not recreate or delete on StrictMode replay, hide/reveal, or a repeated open", async () => {
  const create = vi.spyOn(agentRuntimeApi, "createSideChat").mockResolvedValue(payload);
  const remove = vi.spyOn(agentRuntimeApi, "permanentlyDeleteSession");
  const view = render(<StrictMode><Activity mode="visible"><SideChatPanel ownerSessionId="main" /></Activity></StrictMode>);
  await start();
  view.rerender(<StrictMode><Activity mode="hidden"><SideChatPanel ownerSessionId="main" /></Activity></StrictMode>);
  view.rerender(<StrictMode><Activity mode="visible"><SideChatPanel ownerSessionId="main" /></Activity></StrictMode>);
  act(() => useSideChatStore.getState().start({ ...source, status: "completed" }));
  expect(create).toHaveBeenCalledOnce();
  expect(remove).not.toHaveBeenCalled();
  expect(screen.getByTestId("side-transcript")).toHaveTextContent("side");
});

it("confirms before destruction, allows cancelling, and removes the temporary icon only on success", async () => {
  const user = userEvent.setup();
  vi.spyOn(agentRuntimeApi, "createSideChat").mockResolvedValue(payload);
  const remove = vi.spyOn(agentRuntimeApi, "permanentlyDeleteSession").mockResolvedValue({ ok: true, deletedSessionIds: ["side"] });
  useAgentSessionStore.setState({ sessionListTotal: 1, sessionListOffset: 1 });
  mount(); await start();
  await user.click(screen.getByRole("button", { name: "关闭侧边聊天" }));
  const dialog = await screen.findByRole("alertdialog");
  expect(dialog).toHaveTextContent("无法恢复");
  expect(remove).not.toHaveBeenCalled();
  await user.click(within(dialog).getByRole("button", { name: "取消" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(screen.getByTestId("side-composer")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "关闭侧边聊天" }));
  await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "关闭并删除" }));
  await waitFor(() => expect(screen.queryByTestId("side-composer")).toBeNull());
  expect(remove).toHaveBeenCalledExactlyOnceWith("side");
  expect(screen.queryByRole("button", { name: "侧边聊天" })).toBeNull();
  expect(useAgentSessionStore.getState().sessions).toEqual([source]);
  expect(useAgentSessionStore.getState().sessionListTotal).toBe(1);
  expect(useAgentSessionStore.getState().sessionListOffset).toBe(1);
});

it("waits for an in-flight creation before deleting the confirmed temporary window", async () => {
  let resolve!: (value: typeof payload) => void;
  const create = vi.spyOn(agentRuntimeApi, "createSideChat").mockReturnValue(new Promise((done) => { resolve = done; }));
  const remove = vi.spyOn(agentRuntimeApi, "permanentlyDeleteSession").mockResolvedValue({ ok: true, deletedSessionIds: ["side"] });
  mount(); act(() => useSideChatStore.getState().start(source));
  fireEvent.click(screen.getByRole("button", { name: "关闭侧边聊天" }));
  fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "关闭并删除" }));
  expect(remove).not.toHaveBeenCalled();
  await act(async () => resolve(payload));
  await waitFor(() => expect(useSideChatStore.getState().chats.main).toBeUndefined());
  expect(remove).toHaveBeenCalledExactlyOnceWith("side");
  expect(create).toHaveBeenCalledOnce();
});

it("retains the conversation and confirmation on deletion failure so the user can retry", async () => {
  vi.spyOn(agentRuntimeApi, "createSideChat").mockResolvedValue(payload);
  const remove = vi.spyOn(agentRuntimeApi, "permanentlyDeleteSession")
    .mockRejectedValueOnce(new Error("Delete failed")).mockResolvedValueOnce({ ok: true, deletedSessionIds: ["side"] });
  mount(); await start();
  fireEvent.click(screen.getByRole("button", { name: "关闭侧边聊天" }));
  const dialog = await screen.findByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "关闭并删除" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent("Delete failed");
  expect(useSideChatStore.getState().chats.main.session).toBe(side);
  fireEvent.click(within(dialog).getByRole("button", { name: "关闭并删除" }));
  await waitFor(() => expect(useSideChatStore.getState().chats.main).toBeUndefined());
  expect(remove).toHaveBeenCalledTimes(2);
});

it("retries creation with the same key, and creates a fresh snapshot after closing", async () => {
  const create = vi.spyOn(agentRuntimeApi, "createSideChat").mockRejectedValueOnce(new Error("Temporary failure")).mockResolvedValue(payload);
  vi.spyOn(agentRuntimeApi, "permanentlyDeleteSession").mockResolvedValue({ ok: true, deletedSessionIds: ["side"] });
  mount(); act(() => useSideChatStore.getState().start(source));
  expect(await screen.findByRole("alert")).toHaveTextContent("Temporary failure");
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await screen.findByTestId("side-composer");
  expect(create.mock.calls[0]).toEqual(create.mock.calls[1]);
  await act(async () => useSideChatStore.getState().destroy("main"));
  await start();
  expect(create.mock.calls[2][1]).not.toBe(create.mock.calls[0][1]);
});

it("switches back from a subagent without destroying the temporary chat", async () => {
  vi.spyOn(agentRuntimeApi, "createSideChat").mockResolvedValue(payload);
  const remove = vi.spyOn(agentRuntimeApi, "permanentlyDeleteSession");
  mount(); await start();
  act(() => useSessionWorkspaceStore.getState().openSubagent("main", "child", "Child"));
  expect(screen.getByRole("button", { name: "侧边聊天" })).toHaveAttribute("aria-pressed", "false");
  fireEvent.click(screen.getByRole("button", { name: "侧边聊天" }));
  expect(useSessionWorkspaceStore.getState().sessions.main.subagent).toBeUndefined();
  expect(remove).not.toHaveBeenCalled();
  expect(useSideChatStore.getState().chats.main.session).toBe(side);
});
