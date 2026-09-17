import { afterEach, expect, it, vi } from "vitest";
import { useWikiStore } from "./wikiStore";
import { initialGoalSessionState } from "../features/wiki/goal/goalSessionStream";
import { goalApi } from "../../lib/api/goal";
import { agentRuntimeApi } from "../../lib/api/agentRuntime";

afterEach(() => vi.restoreAllMocks());

it("ignores old goal stream chunks, completion, and errors after a session switch", async () => {
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
  useWikiStore.setState({
    goalSession: {
      ...initialGoalSessionState,
      sessionId: "old",
      title: "Old title",
      status: "completed",
    },
    goalDockState: "expanded",
    goalComposerContent: "Same input",
  });
  const pending = useWikiStore.getState().submitGoal("project");
  useWikiStore.setState({
    goalSession: {
      ...initialGoalSessionState,
      sessionId: "new",
      title: "New title",
    },
    goalDockState: "input",
    goalComposerContent: "Same input",
  });
  receive({ type: "run_started" });
  receive({ type: "message_delta", delta: "Old text" });
  receive({
    type: "permission_requested",
    permission: { id: "old permission" },
  });
  fail(new Error("Old failure"));
  await pending;
  expect(useWikiStore.getState()).toMatchObject({
    goalSession: {
      sessionId: "new",
      title: "New title",
      status: "idle",
      streamingText: "",
      permissions: [],
      error: null,
    },
    goalDockState: "input",
    goalComposerContent: "Same input",
  });
});

it("does not change the new goal session when an old approval finishes", async () => {
  let finish: (decision: any) => void = () => {};
  vi.spyOn(agentRuntimeApi, "replyPermission").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  useWikiStore.setState({
    goalSession: {
      ...initialGoalSessionState,
      sessionId: "old",
      status: "waiting_permission",
    },
  });
  const reply = useWikiStore
    .getState()
    .replyGoalPermission("old-permission", "once");
  useWikiStore.setState({
    goalSession: { ...initialGoalSessionState, sessionId: "new" },
  });
  finish({ id: "old-permission", action: "allow" });
  await reply;
  expect(useWikiStore.getState().goalSession).toMatchObject({
    sessionId: "new",
    status: "idle",
    permissions: [],
  });
});

it("does not replace the visible title when parallel session creation finishes out of order", async () => {
  vi.spyOn(goalApi, "buildSessionPrompt").mockImplementation(
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
  useWikiStore.setState({
    goalSession: { ...initialGoalSessionState },
    goalDockState: "input",
    goalComposerContent: "First request",
  });
  const first = useWikiStore.getState().submitGoal("project");
  useWikiStore.setState({ goalComposerContent: "Second request" });
  const second = useWikiStore.getState().submitGoal("project");
  await vi.waitFor(() => expect(pendingCreates).toHaveLength(2));
  pendingCreates[1]({ session: { id: "second", title: "Second title" } });
  await second;
  pendingCreates[0]({ session: { id: "first", title: "First title" } });
  await first;
  expect(useWikiStore.getState().goalSession).toMatchObject({
    sessionId: "second",
    title: "Second title",
  });
  expect(agentRuntimeApi.streamTurn).toHaveBeenCalledTimes(2);
});
