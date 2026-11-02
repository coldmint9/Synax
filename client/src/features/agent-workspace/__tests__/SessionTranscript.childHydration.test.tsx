import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentRuntimeApi, type AgentSession, type ToolCallRecord } from "../../../adapters/transport/agentRuntime";
import { useApiConnectivityStore } from "../../../shared/lib/apiConnectivity";
import { isRuntimeResourceRemoved, markRuntimeResourcesRestored, resetRuntimeResourceRegistryForTests } from "../../../shared/lib/runtimeResourceRegistry";
import { useNotificationStore } from "../../../shared/state/notificationStore";
import { SessionTranscript } from "../SessionTranscript";
import { useAgentSessionStore as store } from "../state/agentSessionStore";
import { usePendingSubmissionStore } from "../state/pendingSubmissionStore";

vi.mock("../SessionNavigationPanel", () => ({ SessionNavigationPanel: () => null }));
vi.mock("../useTranscriptScroll", () => ({ useTranscriptScroll: () => ({ scrollToBottom: vi.fn() }) }));
vi.mock("../useTranscriptReveal", () => ({ useTranscriptReveal: () => true }));
vi.mock("../SessionEnvironmentContext", () => ({ useSessionWorkspaceEnvironment: () => ({ environment: null }) }));
vi.mock("../AgentConversationView", () => ({ AgentConversationView: () => null }));

const parent = { id: "parent", projectId: "project", status: "running", childSessionIds: [] } as unknown as AgentSession;
const child = { id: "child", parentSessionId: parent.id, projectId: parent.projectId, status: "completed" } as AgentSession;
const missingId = "child-typo";
const missing = (id = missingId) => ({ error: `Agent runtime resource not found: ${id}`, code: "NOT_FOUND" });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const fetchMock = vi.fn<typeof fetch>();
const lifecycle = (status: ToolCallRecord["status"]): ToolCallRecord => ({
  id: "call", sessionId: parent.id, runId: "run", stepId: "step-0", toolId: "subagent.lifecycle",
  category: "task", mutability: "task", status, startedAt: "2026-10-30T02:31:23.256+08:00",
  endedAt: null, error: status === "failed" ? "The requested subagent is not a child of the current session." : null,
  inputRef: { action: "wait", childSessionId: missingId }, inputSummary: "", outputRef: null, outputSummary: null,
});

beforeEach(() => {
  resetRuntimeResourceRegistryForTests();
  useNotificationStore.getState().clearAll();
  useApiConnectivityStore.setState({ apiReachable: "reachable" });
  usePendingSubmissionStore.setState({ items: {} });
  store.setState({ ...store.getInitialState(), projectId: parent.projectId, selectedSessionId: parent.id,
    sessions: [parent], childSessions: { [parent.id]: [child] }, streamingStepId: "step-0" });
  fetchMock.mockReset().mockImplementation(async (input) => {
    const path = String(input);
    if (path.endsWith(`/sessions/${child.id}/summary`)) return response({ session: child });
    if (path.endsWith(`/sessions/${missingId}/summary`)) return response(missing(), 404);
    throw new Error(`Unexpected request: ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  store.setState(store.getInitialState());
  resetRuntimeResourceRegistryForTests();
  useNotificationStore.getState().clearAll();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function advanceSteps() {
  for (let step = 1; step <= 3; step += 1) {
    await act(async () => store.setState({ streamingStepId: `step-${step}` }));
  }
}

describe("transcript child hydration", () => {
  it("does not promote a failed lifecycle input into a child lookup on each step", async () => {
    const failed = lifecycle("failed");
    store.setState({ toolCalls: [failed] });
    await act(async () => { render(<SessionTranscript />); });
    await advanceSteps();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(useNotificationStore.getState().notifications).toEqual([]);
    // The real tool error stays in the transcript; only the speculative lookup stops.
    expect(store.getState().toolCalls).toEqual([failed]);
  });

  it("stops probing an authoritative missing child across steps and remounts without a global toast", async () => {
    // The request can also arrive before the tool failure settles.
    store.setState({ toolCalls: [lifecycle("running")] });
    let view!: ReturnType<typeof render>;
    await act(async () => { view = render(<SessionTranscript />); });
    await advanceSteps();
    view.unmount();
    await act(async () => { render(<SessionTranscript />); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(useNotificationStore.getState().notifications).toEqual([]);
    expect(isRuntimeResourceRemoved(missingId)).toBe(true);
    expect(store.getState().selectedSessionId).toBe(parent.id);
    expect(store.getState().childSessions[parent.id]).toEqual([child]);
  });

  it("still hydrates an authoritative output from a failed delegate", async () => {
    store.setState({ childSessions: {}, toolCalls: [{ ...lifecycle("failed"), toolId: "subagent.delegate", outputRef: { childSessionId: child.id } }] });
    await act(async () => { render(<SessionTranscript />); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain(`/sessions/${child.id}/summary`);
    expect(store.getState().childSessions[parent.id]).toEqual([child]);
  });

  it.each([
    ["permission", 403, { error: "forbidden", code: "FORBIDDEN" }],
    ["recovering projection", 503, { error: "recovering", code: "PROJECTION_RECOVERING" }],
    ["generic 404", 404, { error: "Not Found" }],
    ["nested resource 404", 404, missing("nested-resource")],
  ])("does not mark a child removed after %s", async (_label, status, body) => {
    fetchMock.mockImplementationOnce(async () => response(body, status as number));
    await store.getState().fetchChildSessions(parent.id, [missingId]);
    expect(isRuntimeResourceRemoved(missingId)).toBe(false);
    fetchMock.mockImplementationOnce(async () => response({ session: { ...child, id: missingId } }));
    await store.getState().fetchChildSessions(parent.id, [missingId]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(store.getState().childSessions[parent.id].map(item => item.id)).toEqual([child.id, missingId]);
    if (status === 403) expect(useNotificationStore.getState().notifications).toHaveLength(1);
  });

  it("can hydrate again after an explicit restore", async () => {
    await store.getState().fetchChildSessions(parent.id, [missingId]);
    expect(isRuntimeResourceRemoved(missingId)).toBe(true);
    markRuntimeResourcesRestored([missingId]);
    fetchMock.mockImplementationOnce(async () => response({ session: { ...child, id: missingId } }));
    await store.getState().fetchChildSessions(parent.id, [missingId]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(store.getState().childSessions[parent.id].map(item => item.id)).toEqual([child.id, missingId]);
  });

  it("keeps a network failure retryable", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await store.getState().fetchChildSessions(parent.id, [missingId]);
    expect(isRuntimeResourceRemoved(missingId)).toBe(false);
    useApiConnectivityStore.getState().markSuccess();
    fetchMock.mockImplementationOnce(async () => response({ session: { ...child, id: missingId } }));
    await store.getState().fetchChildSessions(parent.id, [missingId]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(store.getState().childSessions[parent.id].map(item => item.id)).toEqual([child.id, missingId]);
  });

  it("removes only a confirmed missing child from the existing child cache", async () => {
    store.setState({ childSessions: { [parent.id]: [child, { ...child, id: missingId }] } });
    await store.getState().fetchChildSessions(parent.id, [missingId, missingId]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store.getState().childSessions[parent.id]).toEqual([child]);
    expect(store.getState().sessions).toEqual([parent]);
  });

  it("preserves notifications for unrelated direct summary failures", async () => {
    await expect(agentRuntimeApi.getSessionSummary(missingId)).rejects.toMatchObject({ statusCode: 404, code: "NOT_FOUND" });
    expect(useNotificationStore.getState().notifications).toHaveLength(1);
  });
});
