import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentRuntimeApi, type AgentRuntimeMessage, type AgentRunStep, type AgentSession, type HistoryWindowResponse, type PermissionDecision } from "../../../../adapters/transport/agentRuntime";
import type { SessionLiveEvent } from "../../../../adapters/transport/sessionLive";
import { ConversationController } from "../conversationController";
import { materializeLiveBlocks } from "../../streamingLiveBlocks";
import { usePendingSubmissionStore } from "../pendingSubmissionStore";

const transport = vi.hoisted(() => ({ handlers: new Map<string, (event: SessionLiveEvent) => void>(), opens: vi.fn(), closes: vi.fn(), snapshot: null as SessionLiveEvent | null }));
vi.mock("../../../../adapters/transport/sessionLiveClient", () => ({
  addSessionLiveListener: (id: string, callback: (event: SessionLiveEvent) => void) => {
    transport.opens(id);
    transport.handlers.set(id, callback);
    if (transport.snapshot) callback(transport.snapshot);
    return () => { transport.closes(id); transport.handlers.delete(id); };
  },
}));
const stamp = "2026-10-28T00:00:00.000Z";
const session = (id = "child", status: AgentSession["status"] = "running") => ({ id, projectId: "p", parentSessionId: "main", childSessionIds: [], status, activeRunId: status === "running" ? `run-${id}` : null, prompt: "prompt", createdAt: stamp, updatedAt: stamp, sessionMetadata: {} } as AgentSession);
const step = (id = "child") => ({ id: `step-${id}`, sessionId: id, runId: `run-${id}`, index: 0, status: "running", startedAt: stamp } as AgentRunStep);
const emptyHistory = (): HistoryWindowResponse => ({ messages: [], runs: [], steps: [], toolCalls: [], events: [], permissions: [], historyWindow: { revision: 1, epoch: 1, generation: 1, syncCursor: "cursor-1", latest: true, hasEarlier: false, detailsTruncated: false } });
const snapshot = (id = "child", text = "") => ({ type: "runtime_snapshot", sessionId: id, session: session(id), cursor: 5, completedStepIds: [], liveChunks: [{ type: "step_started", step: step(id) }, ...(text ? [{ type: "message_delta", stepId: `step-${id}`, delta: text }] : [])] } as SessionLiveEvent);
const textOf = (controller: ConversationController) => materializeLiveBlocks(controller.getSnapshot().streamingLive).filter(block => block.type === "text").map(block => block.content).join("");
const message = (content: string, id = "child") => ({ id: `message-${id}`, sessionId: id, role: "assistant", runId: `run-${id}`, stepId: `step-${id}`, content, createdAt: stamp, metadata: {} } as AgentRuntimeMessage);
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
const releases: Array<() => void> = [];
function open(id = "child") { const c = new ConversationController(id); releases.push(c.retain()); return c; }

beforeEach(() => {
  vi.useFakeTimers(); transport.handlers.clear(); transport.opens.mockClear(); transport.closes.mockClear(); transport.snapshot = null;
  usePendingSubmissionStore.setState({ items: {} });
  vi.spyOn(agentRuntimeApi, "getSessionSummary").mockImplementation(async id => ({ session: session(id) }));
  vi.spyOn(agentRuntimeApi, "historyWindow").mockImplementation(async () => emptyHistory());
  vi.spyOn(agentRuntimeApi, "listInteractions").mockResolvedValue({ interactions: [] });
});
afterEach(async () => { for (const release of releases.splice(0)) release(); await vi.runOnlyPendingTimersAsync(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("independent conversation controller", () => {
  it("keeps a synchronous snapshot and more than 256 pre-load deltas", async () => {
    const history = deferred<HistoryWindowResponse>();
    vi.mocked(agentRuntimeApi.historyWindow).mockReturnValueOnce(history.promise);
    transport.snapshot = snapshot("child", "early ");
    const c = open();
    for (let index = 0; index < 300; index++) transport.handlers.get("child")!({ type: "message_delta", stepId: "step-child", delta: "x" });
    history.resolve(emptyHistory()); await settle();
    expect(textOf(c)).toBe(`early ${"x".repeat(300)}`);
    expect(c.getSnapshot().history.steps.map(item => item.id)).toEqual(["step-child"]);
  });

  it("isolates interleaved deltas and permission records between two children", async () => {
    const left = open("left"), right = open("right"); await settle();
    const sendLeft = transport.handlers.get("left")!, sendRight = transport.handlers.get("right")!;
    sendLeft(snapshot("left")); sendRight(snapshot("right"));
    sendLeft({ type: "message_delta", stepId: "step-left", delta: "left" });
    sendRight({ type: "message_delta", stepId: "step-right", delta: "right" });
    const permission = { id: "permission-right", sessionId: "right", runId: "run-right", status: "pending" } as unknown as PermissionDecision;
    sendLeft({ type: "permission_updated", permission }); sendRight({ type: "permission_updated", permission });
    await settle();
    expect(textOf(left)).toBe("left"); expect(textOf(right)).toBe("right");
    expect(left.getSnapshot().history.permissions).toEqual([]);
    expect(right.getSnapshot().history.permissions).toEqual([permission]);
  });

  it("reuses StrictMode retention then restores a closed transcript from a replacement snapshot", async () => {
    const c = new ConversationController("child");
    const release = c.retain(); release();
    const reopened = c.retain(); releases.push(reopened);
    await vi.advanceTimersByTimeAsync(0); await settle();
    expect(transport.opens).toHaveBeenCalledTimes(1);
    transport.handlers.get("child")!(snapshot("child", "original")); await settle();
    reopened(); await vi.advanceTimersByTimeAsync(0);
    expect(transport.closes).toHaveBeenCalledTimes(1);
    transport.snapshot = snapshot("child", "original plus missed text");
    releases.push(c.retain()); await settle();
    expect(textOf(c)).toBe("original plus missed text");
    expect(c.getSnapshot().streamingCompletedSteps).toHaveLength(0);
    expect(agentRuntimeApi.historyWindow).toHaveBeenLastCalledWith("child", undefined, "cursor-1");
  });

  it("keeps the final live answer after terminal state and retires it with the persisted message", async () => {
    const c = open(); await settle(); const emit = transport.handlers.get("child")!;
    emit(snapshot("child", "final answer")); await settle();
    emit({ type: "runtime_state", sessionId: "child", patch: { status: "completed", activeRunId: null }, reset: true, refresh: false });
    expect(c.getSnapshot().streamingStepId).toBeNull();
    expect(c.getSnapshot().streamingCompletedSteps[0].blocks).toEqual([{ type: "text", content: "final answer" }]);
    emit({ type: "message", message: message("final answer") });
    expect(c.getSnapshot().streamingCompletedSteps).toHaveLength(0);
    expect(c.getSnapshot().history.messages[0].content).toBe("final answer");
  });

  it("never polls history while idle and batches deltas after the first token", async () => {
    const c = open(); await settle(); const emit = transport.handlers.get("child")!;
    emit(snapshot()); await settle();
    const reads = vi.mocked(agentRuntimeApi.historyWindow).mock.calls.length;
    const listener = vi.fn(); c.subscribe(listener);
    emit({ type: "message_delta", stepId: "step-child", delta: "a" });
    expect(textOf(c)).toBe("a"); expect(listener).toHaveBeenCalledTimes(1);
    for (let index = 0; index < 50; index++) emit({ type: "message_delta", stepId: "step-child", delta: "b" });
    expect(listener).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(32);
    expect(listener).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(agentRuntimeApi.historyWindow).toHaveBeenCalledTimes(reads);
  });

  it("projects an optimistic submission until its own durable user message arrives", async () => {
    const c = open(); await settle();
    const pending = { ...message("same prompt"), id: "pending", role: "user" as const, metadata: { requestId: "send-1" } };
    usePendingSubmissionStore.getState().begin("child", { requestId: "send-1", message: pending });
    expect(c.getSnapshot().history.messages).toContain(pending);
    transport.handlers.get("child")!({ type: "message", message: { ...pending, id: "persisted" } });
    expect(c.getSnapshot().history.messages.map(item => item.id)).toEqual(["persisted"]);
    expect(usePendingSubmissionStore.getState().items.child).toBeUndefined();
  });

  it("loads earlier history with the cursor without replacing live or optimistic state", async () => {
    const history = emptyHistory(); history.historyWindow.olderCursor = "older"; history.historyWindow.hasEarlier = true;
    vi.mocked(agentRuntimeApi.historyWindow).mockResolvedValueOnce(history);
    const c = open(); await settle();
    const page = emptyHistory(); page.messages = [{ ...message("older text"), id: "old" }];
    vi.mocked(agentRuntimeApi.historyWindow).mockResolvedValueOnce(page);
    await c.loadEarlier();
    expect(agentRuntimeApi.historyWindow).toHaveBeenLastCalledWith("child", "older");
    expect(c.getSnapshot().history.messages[0].content).toBe("older text");
    expect(c.getSnapshot().history.historyWindow?.hasEarlier).toBe(false);
  });

  it("does not resurrect a completed run when the submission acknowledgement arrives late", async () => {
    const c = open(); await settle();
    transport.handlers.get("child")!({ type: "runtime_state", sessionId: "child", patch: { status: "completed", activeRunId: null }, reset: true, refresh: false });
    c.acceptRun({ id: "run-child", sessionId: "child", status: "running" } as never);
    expect(c.getSnapshot().session?.status).toBe("completed");
  });

  it("preserves the terminal event across a stale HTTP response started by that event", async () => {
    const c = open(); await settle();
    transport.handlers.get("child")!({ type: "runtime_state", sessionId: "child", patch: { status: "completed", activeRunId: null }, reset: true, refresh: true });
    await settle();
    expect(c.getSnapshot().session?.status).toBe("completed");
  });

  it("routes permission replies only to the retained child and reconciles pending interactions", async () => {
    const c = open(); await settle();
    const permission = { id: "p", sessionId: "child", runId: "run-child", decision: "approved" } as unknown as PermissionDecision;
    const reply = vi.spyOn(agentRuntimeApi, "replyPermission").mockResolvedValue(permission);
    await c.replyPermission("p", "once");
    expect(reply).toHaveBeenCalledWith("child", "p", "once", undefined);
    const interaction = { id: "ask", sessionId: "child", revision: 1, status: "pending" } as never;
    vi.mocked(agentRuntimeApi.listInteractions).mockResolvedValueOnce({ interactions: [interaction] });
    transport.handlers.get("child")!({ type: "event", event: { id: "event-ask", sessionId: "child", type: "interaction_requested" } as never });
    await settle();
    expect(c.getSnapshot().interactions).toEqual([interaction]);
  });
});
