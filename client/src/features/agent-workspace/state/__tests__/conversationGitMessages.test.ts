import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntimeMessage } from "../../../../adapters/transport/agentRuntime";
import type { ConversationGitReference } from "../../gitMergeTranscript";
import { useAgentSessionStore as store, type SessionDetailCacheEntry } from "../agentSessionStore";

vi.mock("../../../../adapters/transport/sessionLiveClient", () => ({
  ensureSessionLiveSubscription: vi.fn(),
  releaseSessionLiveSubscription: vi.fn(),
}));
vi.mock("../sessionCache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sessionCache")>();
  return { ...actual, schedulePersistDetail: vi.fn(), scheduleDeletePersistedDetail: vi.fn() };
});

const parentId = "parent-session";
const childId = "child-session";
const timestamp = "2026-10-22T02:00:00Z";

function reference(sessionId: string, title = "检查合并方案"): ConversationGitReference {
  return {
    schema: "synax.git-merge", schemaVersion: 1, objectId: `task:${sessionId}`,
    sessionId, projectId: "project", rootId: "root", title,
  };
}
function anchor(sessionId: string, title = "检查合并方案"): AgentRuntimeMessage {
  return {
    id: `anchor:${sessionId}`, sessionId, runId: null, stepId: null,
    role: "assistant", content: title, createdAt: timestamp,
    metadata: { source: "git_merge_task", gitMergeTask: reference(sessionId, title) },
  };
}
function receipt(sessionId: string): AgentRuntimeMessage {
  return {
    ...anchor(sessionId), id: `receipt:${sessionId}`, content: "已保存冲突解决方案。",
    metadata: { source: "git_merge_receipt" },
  };
}
function cache(messages: AgentRuntimeMessage[] = []): SessionDetailCacheEntry {
  return {
    runs: [], steps: [], events: [], messages, toolCalls: [], permissions: [],
    sessionStats: null, sessionTodos: [], sessionInvocationUsage: null, cachedAt: 1,
  };
}

beforeEach(() => {
  store.setState({ ...store.getInitialState(), selectedSessionId: parentId });
});
afterEach(() => {
  store.setState(store.getInitialState());
  vi.clearAllMocks();
});

describe("owner-scoped conversation Git messages", () => {
  it("upserts a stable anchor in the visible transcript and cache without duplicate cards", () => {
    const original = anchor(parentId);
    const updated = anchor(parentId, "验证完成，等待合并");
    store.getState().ingestConversationMessages(parentId, [original]);
    store.getState().ingestConversationMessages(parentId, [original, updated, updated]);

    const state = store.getState();
    expect(state.messages).toEqual([updated]);
    expect(state.sessionDetailCache[parentId].messages).toEqual([updated]);
    expect(state.messages[0].createdAt).toBe(timestamp);
    expect(state.messages[0].metadata.gitMergeTask).toMatchObject({ objectId: reference(parentId).objectId });
  });

  it("routes a background child stream receipt into only the child's existing cache", () => {
    const parentAnchor = anchor(parentId);
    const childAnchor = anchor(childId);
    const parentCache = cache([parentAnchor]);
    store.setState({
      messages: [parentAnchor],
      sessionDetailCache: { [parentId]: parentCache, [childId]: cache([childAnchor]) },
    });
    const parentMessages = store.getState().messages;
    store.getState().applyLiveEvent({ type: "conversation_git_messages", messages: [receipt(childId)] }, childId);

    const state = store.getState();
    expect(state.messages).toBe(parentMessages);
    expect(state.sessionDetailCache[parentId]).toBe(parentCache);
    expect(state.sessionDetailCache[childId].messages).toEqual([childAnchor, receipt(childId)]);
    expect(state.selectedSessionId).toBe(parentId);
  });

  it("creates a missing child cache without copying the visible parent's rows or status", () => {
    const parentCache: SessionDetailCacheEntry = {
      ...cache([anchor(parentId)]),
      runs: [{ id: "parent-run" } as never],
      steps: [{ id: "parent-step" } as never],
      events: [{ id: "parent-event" } as never],
      toolCalls: [{ id: "parent-tool" } as never],
      permissions: [{ id: "parent-permission" } as never],
      sessionStats: { status: "running" } as never,
      sessionTodos: [{ id: "parent-todo" } as never],
      sessionInvocationUsage: { sessionId: parentId } as never,
      historyWindow: { revision: 3, epoch: 1, hasEarlier: true, latest: true, detailsTruncated: false },
    };
    store.setState({
      ...parentCache,
      sessionDetailCache: { [parentId]: parentCache },
    });
    store.getState().ingestConversationMessages(childId, [receipt(childId)]);

    const state = store.getState();
    const childCache = state.sessionDetailCache[childId];
    expect(childCache.messages).toEqual([receipt(childId)]);
    for (const key of ["runs", "steps", "events", "toolCalls", "permissions", "sessionTodos"] as const)
      expect(childCache[key]).toEqual([]);
    expect(childCache.sessionStats).toBeNull();
    expect(childCache.sessionInvocationUsage).toBeNull();
    expect(childCache.historyWindow).toBeUndefined();
    expect(state.messages).toBe(parentCache.messages);
    expect(state.runs).toBe(parentCache.runs);
    expect(state.steps).toBe(parentCache.steps);
    expect(state.sessionStats).toBe(parentCache.sessionStats);
  });

  it("drops messages for a different owner, unsupported sources, and non-assistant roles", () => {
    const before = store.getState();
    const valid = anchor(parentId);
    store.getState().ingestConversationMessages(parentId, [
      anchor(childId),
      { ...valid, metadata: { source: "user" } },
      { ...valid, metadata: {} },
      { ...valid, role: "user" },
      { ...valid, role: "tool" },
    ]);
    expect(store.getState()).toBe(before);
    store.getState().ingestConversationMessages(parentId, [anchor(childId), valid]);
    expect(store.getState().messages).toEqual([valid]);
    expect(store.getState().sessionDetailCache[childId]).toBeUndefined();
  });

  it("preserves the validated small task reference when updating a paged history index", () => {
    const original = anchor(parentId);
    const updated = {
      ...anchor(parentId, "基线已重新分析"), content: "新的合并结果 ".repeat(100),
      metadata: {
        source: "git_merge_task", largePayload: "x".repeat(4000),
        gitMergeTask: { ...reference(parentId, "基线已重新分析"), unexpectedPayload: "x".repeat(4000) },
      },
    };
    store.setState({
      messages: [original],
      sessionDetailCache: { [parentId]: { ...cache([original]), timelineMessages: [original], timelineIndexLoaded: true } },
    });
    store.getState().ingestConversationMessages(parentId, [updated, updated]);

    const entry = store.getState().sessionDetailCache[parentId];
    expect(entry.timelineMessages).toHaveLength(1);
    expect(entry.timelineMessages![0].content).toHaveLength(240);
    expect(entry.timelineMessages![0].metadata.gitMergeTask).toEqual(reference(parentId, "基线已重新分析"));
    expect(entry.timelineMessages![0].metadata).not.toHaveProperty("largePayload");
    expect(entry.timelineIndexLoaded).toBe(true);
    expect(entry.messages).toEqual([updated]);
  });

  it("does not ingest an auxiliary event without an explicit owner stream", () => {
    const before = store.getState();
    store.getState().applyLiveEvent({ type: "conversation_git_messages", messages: [anchor(parentId)] });
    expect(store.getState()).toBe(before);
  });
});
