import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAgentDockStore } from "./agentDockStore";
import { initialDockSessionState } from "../dock/dockSessionStream";
import { goalApi } from "../../../../lib/api/goal";
import { sessionPromptApi } from "../../../../lib/api/sessionPrompt";
import { agentRuntimeApi } from "../../../../lib/api/agentRuntime";
import { useWikiStore } from "../../../state/wikiStore";
import { useShellStore } from "../../../state/shellStore";
import { useNotificationStore } from "../../../state/notificationStore";
import { useAgentSessionStore } from "./agentSessionStore";

beforeEach(() => {
  useAgentDockStore.getState().reset();
  useWikiStore.getState().reset();
  useShellStore.setState({ currentProjectId: "project" });
  useAgentSessionStore.setState({ selectedSessionId: null, permissions: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
  useShellStore.setState({ currentProjectId: null });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function changeContext(change: "reset" | "project-switch") {
  if (change === "reset") useAgentDockStore.getState().reset();
  else useShellStore.setState({ currentProjectId: "next-project" });
}

it("ignores old dock stream chunks, completion, and errors after a session switch", async () => {
  let receive: (chunk: unknown) => void = () => {};
  let fail: (reason: Error) => void = () => {};
  vi.spyOn(agentRuntimeApi, "streamTurn").mockImplementation(
    (_id, _body, onChunk) => {
      receive = onChunk;
      return new Promise((_resolve, reject) => {
        fail = reject;
      });
    },
  );
  useAgentDockStore.setState({
    session: {
      ...initialDockSessionState,
      sessionId: "old",
      title: "Old title",
      status: "completed",
    },
    dockState: "expanded",
    composerContent: "Same input",
  });
  const pending = useAgentDockStore.getState().submitSession("project");
  useAgentDockStore.setState({
    session: {
      ...initialDockSessionState,
      sessionId: "new",
      title: "New title",
    },
    dockState: "input",
    composerContent: "Same input",
  });
  receive({ type: "run_started" });
  receive({ type: "message_delta", delta: "Old text" });
  receive({
    type: "permission_requested",
    permission: { id: "old permission" },
  });
  fail(new Error("Old failure"));
  await pending;
  expect(useAgentDockStore.getState()).toMatchObject({
    session: {
      sessionId: "new",
      title: "New title",
      status: "idle",
      streamingText: "",
      permissions: [],
      error: null,
    },
    dockState: "input",
    composerContent: "Same input",
  });
});

it("does not change the new dock session when an old approval finishes", async () => {
  let finish: (decision: any) => void = () => {};
  vi.spyOn(agentRuntimeApi, "replyPermission").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  useAgentDockStore.setState({
    session: {
      ...initialDockSessionState,
      sessionId: "old",
      status: "waiting_permission",
    },
  });
  const reply = useAgentDockStore
    .getState()
    .replyPermission("old-permission", "once");
  useAgentDockStore.setState({
    session: { ...initialDockSessionState, sessionId: "new" },
  });
  finish({ id: "old-permission", action: "allow" });
  await reply;
  expect(useAgentDockStore.getState().session).toMatchObject({
    sessionId: "new",
    status: "idle",
    permissions: [],
  });
});

it("does not replace the visible title when parallel session creation finishes out of order", async () => {
  vi.spyOn(sessionPromptApi, "build").mockImplementation(
    async (_id, input) => ({ prompt: input.content, wikiContext: {} }) as any,
  );
  vi.spyOn(goalApi, "create").mockResolvedValue({ id: "goal" } as any);
  vi.spyOn(goalApi, "list").mockResolvedValue([]);
  vi.spyOn(goalApi, "linkLastSession").mockResolvedValue(undefined as any);
  vi.spyOn(agentRuntimeApi, "streamTurn").mockResolvedValue(undefined);
  const pendingCreates: Array<(session: any) => void> = [];
  vi.spyOn(agentRuntimeApi, "createSession").mockImplementation(
    () => new Promise((resolve) => pendingCreates.push(resolve)),
  );
  useAgentDockStore.setState({
    session: { ...initialDockSessionState },
    dockState: "input",
    composerContent: "First request",
  });
  const first = useAgentDockStore.getState().submitSession("project");
  useAgentDockStore.setState({ composerContent: "Second request" });
  const second = useAgentDockStore.getState().submitSession("project");
  await vi.waitFor(() => expect(pendingCreates).toHaveLength(2));
  pendingCreates[1]({ session: { id: "second", title: "Second title" } });
  await second;
  pendingCreates[0]({ session: { id: "first", title: "First title" } });
  await first;
  expect(useAgentDockStore.getState().session).toMatchObject({
    sessionId: "second",
    title: "Second title",
  });
  expect(agentRuntimeApi.streamTurn).toHaveBeenCalledTimes(2);
});

it("resets dock state and attachments independently of the Wiki document selection", () => {
  useAgentDockStore.setState({
    session: { ...initialDockSessionState, sessionId: "active-session" },
    dockState: "expanded",
    composerContent: "Draft for the current project",
    composerContentParts: [{ type: "text", text: "Attached context" }],
  });

  useWikiStore.getState().reset();
  expect(useAgentDockStore.getState()).toMatchObject({
    session: { sessionId: "active-session" },
    dockState: "expanded",
    composerContent: "Draft for the current project",
  });

  useWikiStore.setState({ selectedDocumentId: "wiki-document" });
  useAgentDockStore.getState().reset();
  expect(useAgentDockStore.getState()).toMatchObject({
    session: { sessionId: null, status: "idle" },
    dockState: "idle",
    composerContent: "",
    composerContentParts: [],
  });
  expect(useWikiStore.getState().selectedDocumentId).toBe("wiki-document");
});

it("uses the Wiki document context while submitting through the independent dock", async () => {
  const anchor = { type: "heading" as const, heading: "Appendix" };
  useWikiStore.setState({
    documents: [
      {
        id: "wiki-document",
        snapshotId: "snapshot",
        projectId: "project",
        title: "Architecture",
        docType: "module",
        parentId: null,
        contentMd: "# Architecture",
        references: [],
        pipelineStage: "drafted",
        sortOrder: 0,
        manualState: "none",
        staleState: "fresh",
        isSection: false,
        createdAt: "2026-09-20",
        updatedAt: "2026-09-20",
      },
    ],
  });
  vi.spyOn(sessionPromptApi, "build").mockResolvedValue({
    prompt: "Review the appendix with document context",
    wikiContext: {
      mode: "manual",
      documentId: "wiki-document",
      documentTitle: "Architecture",
      anchorJson: anchor,
      autoMatched: false,
    },
  });
  vi.spyOn(goalApi, "create").mockResolvedValue({ id: "wiki-goal" } as any);
  vi.spyOn(goalApi, "list").mockResolvedValue([]);
  vi.spyOn(goalApi, "linkLastSession").mockResolvedValue(undefined);
  vi.spyOn(agentRuntimeApi, "createSession").mockResolvedValue({
    session: { id: "dock-session", title: "Review appendix" },
  } as any);
  vi.spyOn(agentRuntimeApi, "streamTurn").mockResolvedValue(undefined);
  const dock = useAgentDockStore.getState();
  dock.openComposer({
    content: "Review the appendix",
    documentId: "wiki-document",
    anchor,
  });
  dock.setComposerProviderId("custom-api:kiro-local");
  dock.setComposerModelId("claude-opus-5");

  await dock.submitSession("project");

  expect(sessionPromptApi.build).toHaveBeenCalledWith("project", {
    mode: "direct",
    content: "Review the appendix",
    wikiAttachMode: "manual",
    documentId: "wiki-document",
    documentTitle: "Architecture",
    anchorJson: anchor,
  });
  expect(agentRuntimeApi.createSession).toHaveBeenCalledWith(
    expect.objectContaining({
      prompt: "Review the appendix with document context",
      sessionMetadata: expect.objectContaining({
        mode: "goal",
        source: "agent-dock",
        goalId: "wiki-goal",
        userPrompt: "Review the appendix",
        documentId: "wiki-document",
      }),
    }),
  );
  expect(agentRuntimeApi.streamTurn).toHaveBeenCalledWith(
    "dock-session",
    expect.objectContaining({ model: "custom-api:kiro-local/claude-opus-5" }),
    expect.any(Function),
  );
  expect(goalApi.linkLastSession).toHaveBeenCalledWith(
    "wiki-goal",
    "dock-session",
  );
});

const creationStages = ["prompt", "goal", "goals", "session"] as const;
const contextChanges = ["reset", "project-switch"] as const;
const outcomes = ["resolve", "reject"] as const;

it.each(
  creationStages.flatMap((stage) =>
    contextChanges.flatMap((change) =>
      outcomes.map((outcome) => ({ stage, change, outcome })),
    ),
  ),
)(
  "ignores $stage $outcome after $change while the session ID is still null",
  async ({ stage, change, outcome }) => {
    const pending = deferred<any>();
    const results = {
      prompt: {
        prompt: "Old prompt",
        wikiContext: { documentId: null, anchorJson: null },
      },
      goal: { id: "old-goal" },
      goals: [{ id: "old-goal" }],
      session: { session: { id: "old-session", title: "Old title" } },
    };
    const calls = {
      prompt: vi
        .spyOn(sessionPromptApi, "build")
        .mockResolvedValue(results.prompt as any),
      goal: vi.spyOn(goalApi, "create").mockResolvedValue(results.goal as any),
      goals: vi.spyOn(goalApi, "list").mockResolvedValue(results.goals as any),
      session: vi
        .spyOn(agentRuntimeApi, "createSession")
        .mockResolvedValue(results.session as any),
    };
    calls[stage].mockImplementationOnce(() => pending.promise);
    const link = vi
      .spyOn(goalApi, "linkLastSession")
      .mockResolvedValue(undefined);
    const stream = vi
      .spyOn(agentRuntimeApi, "streamTurn")
      .mockResolvedValue(undefined);
    const toast = vi
      .spyOn(useNotificationStore.getState(), "push")
      .mockReturnValue("toast");
    useAgentDockStore.getState().openComposer({ content: "Old request" });
    const submission = useAgentDockStore.getState().submitSession("project");
    await vi.waitFor(() => expect(calls[stage]).toHaveBeenCalledOnce());

    changeContext(change);
    useAgentDockStore.getState().openComposer({ content: "New request" });
    const currentGoals = [{ id: "current-goal" }] as any;
    useWikiStore.setState({ goals: currentGoals });
    if (outcome === "resolve") pending.resolve(results[stage]);
    else pending.reject(new Error("Old request failed"));
    await submission;

    expect(useAgentDockStore.getState()).toMatchObject({
      session: { sessionId: null, status: "idle", error: null },
      dockState: "input",
      composerContent: "New request",
    });
    expect(useWikiStore.getState().goals).toBe(currentGoals);
    expect(link).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
    if (stage !== "session") expect(calls.session).not.toHaveBeenCalled();
    if (stage === "prompt") expect(calls.goal).not.toHaveBeenCalled();
  },
);

it.each(
  (["reply", "tier"] as const).flatMap((operation) =>
    contextChanges.flatMap((change) =>
      outcomes.map((outcome) => ({ operation, change, outcome })),
    ),
  ),
)(
  "ignores permission $operation $outcome after $change even if the same session reopens",
  async ({ operation, change, outcome }) => {
    const pending = deferred<any>();
    vi.spyOn(agentRuntimeApi, "replyPermission").mockImplementation(
      () => pending.promise,
    );
    vi.spyOn(agentRuntimeApi, "updateSessionPermissions").mockImplementation(
      () => pending.promise,
    );
    const patch = vi.spyOn(useAgentSessionStore.getState(), "patchSession");
    const refresh = vi
      .spyOn(useAgentSessionStore.getState(), "refreshDetail")
      .mockResolvedValue(undefined);
    const removeNotification = vi.spyOn(
      useNotificationStore.getState(),
      "remove",
    );
    useAgentDockStore.setState({
      session: {
        ...initialDockSessionState,
        sessionId: "shared-session",
        status: "waiting_permission",
      },
    });
    const request =
      operation === "reply"
        ? useAgentDockStore.getState().replyPermission("permission", "once")
        : useAgentDockStore.getState().setPermissionTier("unrestricted");

    changeContext(change);
    const currentPermission = {
      id: "permission",
      action: "ask",
      reason: "Current request",
    } as any;
    useAgentDockStore.setState({
      session: {
        ...initialDockSessionState,
        sessionId: "shared-session",
        permissions: [currentPermission],
      },
    });
    useAgentSessionStore.setState({
      selectedSessionId: "shared-session",
      permissions: [currentPermission],
    });
    if (outcome === "reject")
      pending.reject(new Error("Old permission failed"));
    else
      pending.resolve(
        operation === "reply"
          ? { id: "permission", action: "allow" }
          : {
              session: {
                sessionMetadata: { permissionTier: "unrestricted" },
                updatedAt: "old-result",
              },
            },
      );
    await expect(request).resolves.toBeUndefined();

    expect(useAgentDockStore.getState()).toMatchObject({
      session: {
        sessionId: "shared-session",
        status: "idle",
        permissions: [currentPermission],
      },
      composerPermissionTier: "boundary",
    });
    expect(useAgentSessionStore.getState().permissions).toEqual([
      currentPermission,
    ]);
    expect(patch).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(removeNotification).not.toHaveBeenCalled();
  },
);

it("does not publish an old input queue after resetting the dock", async () => {
  const pending = deferred<any>();
  vi.spyOn(agentRuntimeApi, "enqueueInput").mockImplementation(
    () => pending.promise,
  );
  const setQueue = vi.spyOn(useAgentSessionStore.getState(), "setInputQueue");
  useAgentDockStore.setState({
    session: {
      ...initialDockSessionState,
      sessionId: "running-session",
      status: "running",
    },
    composerContent: "Queued input",
  });
  const submission = useAgentDockStore.getState().submitSession("project");
  useAgentDockStore.getState().reset();
  useAgentDockStore.getState().openComposer({ content: "New draft" });
  pending.resolve({ items: [{ id: "old-input" }] });
  await submission;
  expect(setQueue).not.toHaveBeenCalled();
  expect(useAgentDockStore.getState().composerContent).toBe("New draft");
});

it("ignores stream updates after resetSession even if the same session reopens", async () => {
  const pending = deferred<void>();
  let receive: (chunk: unknown) => void = () => {};
  vi.spyOn(agentRuntimeApi, "streamTurn").mockImplementation(
    (_id, _body, onChunk) => {
      receive = onChunk;
      return pending.promise;
    },
  );
  const toast = vi
    .spyOn(useNotificationStore.getState(), "push")
    .mockReturnValue("toast");
  useAgentDockStore.setState({
    session: {
      ...initialDockSessionState,
      sessionId: "shared-session",
      status: "completed",
    },
    composerContent: "Continue",
  });
  const submission = useAgentDockStore.getState().submitSession("project");
  useAgentDockStore.getState().resetSession();
  useAgentDockStore.setState({
    session: { ...initialDockSessionState, sessionId: "shared-session" },
  });
  receive({ type: "message_delta", delta: "Old response" });
  pending.reject(new Error("Old stream failed"));
  await submission;
  expect(useAgentDockStore.getState().session).toMatchObject({
    status: "idle",
    streamingText: "",
    error: null,
  });
  expect(toast).not.toHaveBeenCalled();
});
