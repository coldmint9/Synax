import { afterEach, describe, expect, it, vi } from "vitest";
import { agentRuntimeApi, type QueuedInput } from "../../../../adapters/transport/agentRuntime";
import {
  resetWorkspaceSessionCache,
  useAgentSessionStore,
} from "../agentSessionStore";

vi.mock("../../../../adapters/transport/agentRuntime", () => ({
  agentRuntimeApi: {
    listSessions: vi.fn(async () => ({
      items: [],
      totalCount: 0,
      countByStatus: {},
    })),
    listInputQueue: vi.fn(async () => ({ items: [] })),
    enqueueInput: vi.fn(async () => ({ items: [] })),
    createSession: vi.fn(async (body) => ({
      session: {
        id: "ars_new",
        projectId: body.projectId,
        parentSessionId: null,
        childSessionIds: [],
        nodeId: null,
        profileId: body.profileId,
        status: "running",
        title: null,
        prompt: body.prompt,
        contextSnapshotId: null,
        thinkingMode: "standard",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        completedAt: null,
        resultSummary: null,
        blockedReason: null,
        skillIds: body.skillIds ?? [],
        activeRunId: null,
        pendingResumeToken: null,
        sessionMetadata: body.sessionMetadata ?? null,
      },
    })),
  },
}));

afterEach(() => {
  resetWorkspaceSessionCache();
  useAgentSessionStore.setState({
    projectId: null,
    draftMode: "chat",
    sessions: [],
    sessionListTotal: null,
    sessionListOffset: 0,
    sessionListLoadedAt: 0,
    sessionListLoading: false,
    sessionListError: null,
    selectedSessionId: null,
    panelOpen: false,
    runs: [],
    steps: [],
    events: [],
    messages: [],
    toolCalls: [],
    childSessions: {},
    permissions: [],
    sessionStats: null,
    sessionTodos: [],
    sessionInvocationUsage: null,
    readSessionMarkers: {},
    sessionDetailCache: {},
    streamingStepId: null,
    streamingLive: {
      blocks: [],
      pendingThinking: "",
      pendingText: "",
      pendingToolCalls: [],
    },
    streamingCompletedSteps: [],
    inputQueues: {},
  });
  vi.clearAllMocks();
});

describe("useAgentSessionStore.setProjectId", () => {
  it("clears session selection and detail state when switching projects", () => {
    useAgentSessionStore.setState({
      projectId: "project-a",
      selectedSessionId: "session-a",
      panelOpen: true,
      messages: [
        {
          id: "m1",
          sessionId: "session-a",
          role: "user",
          content: "hello",
          createdAt: "",
        },
      ],
      steps: [
        {
          id: "s1",
          runId: "r1",
          sessionId: "session-a",
          stepIndex: 0,
          status: "completed",
          createdAt: "",
          updatedAt: "",
        },
      ],
    });

    useAgentSessionStore.getState().setProjectId("project-b");

    const state = useAgentSessionStore.getState();
    expect(state.projectId).toBe("project-b");
    expect(state.selectedSessionId).toBeNull();
    expect(state.panelOpen).toBe(false);
    expect(state.messages).toEqual([]);
    expect(state.steps).toEqual([]);
    expect(agentRuntimeApi.listSessions).toHaveBeenCalledWith({
      projectId: "project-b",
      limit: 20,
    });
  });

  it("is a no-op when projectId is unchanged", () => {
    useAgentSessionStore.setState({
      projectId: "project-a",
      selectedSessionId: "session-a",
      panelOpen: true,
    });

    useAgentSessionStore.getState().setProjectId("project-a");

    expect(useAgentSessionStore.getState().selectedSessionId).toBe("session-a");
    expect(useAgentSessionStore.getState().panelOpen).toBe(true);
    expect(agentRuntimeApi.listSessions).not.toHaveBeenCalled();
  });
});

describe("useAgentSessionStore.loadMoreSessions", () => {
  it("requests the next batch of 20 sessions at the current offset", async () => {
    useAgentSessionStore.setState({
      projectId: "project-a",
      sessionListTotal: 40,
      sessionListOffset: 20,
    });

    await useAgentSessionStore.getState().loadMoreSessions();

    expect(agentRuntimeApi.listSessions).toHaveBeenCalledWith({
      projectId: "project-a",
      limit: 20,
      offset: 20,
    });
  });
});

describe("useAgentSessionStore input queue", () => {
  const item: QueuedInput = { id: "consumed-item", message: "Queued input", model: null, enqueuedAt: "" };

  it("coalesces changes during a queue read without publishing the stale snapshot", async () => {
    let releaseFirst!: (value: { items: QueuedInput[] }) => void;
    let firstStarted!: () => void;
    const firstStartedPromise = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const firstResponse = new Promise<{ items: QueuedInput[] }>(
      (resolve) => {
        releaseFirst = resolve;
      },
    );
    let calls = 0;
    vi.mocked(agentRuntimeApi.listInputQueue).mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        firstStarted();
        return firstResponse;
      }
      return { items: [] };
    });

    const firstLoad = useAgentSessionStore
      .getState()
      .loadInputQueue("session-a");
    await firstStartedPromise;
    const secondLoad = useAgentSessionStore
      .getState()
      .loadInputQueue("session-a");
    const thirdLoad = useAgentSessionStore.getState().loadInputQueue("session-a");
    const published: QueuedInput[][] = [];
    const unsubscribe = useAgentSessionStore.subscribe(state => {
      published.push(state.inputQueues["session-a"]);
    });
    // Let a concurrent newer read finish before releasing the stale one.
    // Without serialization the stale response is the last state published.
    await Promise.resolve();

    releaseFirst({ items: [item] });
    await Promise.all([firstLoad, secondLoad, thirdLoad]);
    unsubscribe();

    expect(agentRuntimeApi.listInputQueue).toHaveBeenCalledTimes(2);
    expect(published).toEqual([[]]);
    expect(useAgentSessionStore.getState().inputQueues["session-a"]).toEqual(
      [],
    );
  });

  it("reconciles the queue after enqueueing instead of applying the enqueue response snapshot", async () => {
    vi.mocked(agentRuntimeApi.enqueueInput).mockResolvedValue({
      items: [item],
    });
    vi.mocked(agentRuntimeApi.listInputQueue).mockResolvedValue({ items: [] });

    await useAgentSessionStore.getState().enqueueSessionInput("session-a", {
      message: "queued message",
    });

    expect(useAgentSessionStore.getState().inputQueues["session-a"]).toEqual(
      [],
    );
  });
});

describe("useAgentSessionStore.submitSessionDraft", () => {

  it("falls back to message when prompt is omitted", async () => {
    await useAgentSessionStore.getState().submitSessionDraft("project-a", {
      message: "plain message",
    });

    expect(agentRuntimeApi.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "plain message",
        sessionMetadata: {
          mode: "chat",
          source: "session-page",
          userPrompt: "plain message",
        },
      }),
    );
  });
});
