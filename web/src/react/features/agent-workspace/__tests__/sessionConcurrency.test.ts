import { beforeEach, expect, it, vi } from "vitest";
import {
  agentRuntimeApi,
  type AgentSession,
} from "../../../../lib/api/agentRuntime";
import { ensureSessionLiveSubscription } from "../../../../lib/api/sessionLiveClient";
import { useAgentSessionStore } from "../state/agentSessionStore";

vi.mock("../../../../lib/api/agentRuntime", () => ({
  agentRuntimeApi: {
    listSessions: vi.fn(),
    createSession: vi.fn(),
    submitRun: vi.fn(),
  },
}));
vi.mock("../../../../lib/api/sessionLiveClient", () => ({
  ensureSessionLiveSubscription: vi.fn(),
  releaseSessionLiveSubscription: vi.fn(),
}));
const row = (id: string, projectId = "one") =>
  ({
    id,
    projectId,
    title: id,
    status: "completed",
    updatedAt: "2026-09-16T00:00:00Z",
    sessionMetadata: { mode: "chat" },
  }) as AgentSession;
const page = (items: AgentSession[]) => ({
  items,
  totalCount: items.length,
  countByStatus: {},
});
beforeEach(() => {
  vi.resetAllMocks();
  useAgentSessionStore.setState({
    ...useAgentSessionStore.getInitialState(),
    projectId: "one",
    sessions: [row("s1")],
  });
  vi.mocked(agentRuntimeApi.listSessions).mockResolvedValue(page([]));
});

it("coalesces concurrent list refreshes and preserves a title patch newer than a response snapshot", async () => {
  let finish: (value: any) => void = () => {};
  vi.mocked(agentRuntimeApi.listSessions)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue(page([row("s1"), row("added")]));
  const requests = Array.from({ length: 8 }, () =>
    useAgentSessionStore.getState().refreshSessions(),
  );
  expect(agentRuntimeApi.listSessions).toHaveBeenCalledTimes(1);
  useAgentSessionStore.getState().patchSession("s1", {
    title: "Generated title",
    updatedAt: "2026-09-16T00:00:01Z",
  });
  useAgentSessionStore.setState((s) => ({
    sessions: [...s.sessions, row("added")],
  }));
  finish(page([row("s1")]));
  await Promise.all(requests);
  expect(agentRuntimeApi.listSessions).toHaveBeenCalledTimes(2);
  expect(
    useAgentSessionStore.getState().sessions.find((s) => s.id === "s1")?.title,
  ).toBe("Generated title");
  expect(
    useAgentSessionStore.getState().sessions.some((s) => s.id === "added"),
  ).toBe(true);
});

it("does not replace the current project list with an old project response or creation", async () => {
  let finishList: (value: any) => void = () => {};
  let finishCreate: (value: any) => void = () => {};
  vi.mocked(agentRuntimeApi.listSessions)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishList = resolve;
        }),
    )
    .mockResolvedValue(page([row("s2", "two")]));
  vi.mocked(agentRuntimeApi.createSession).mockImplementation(
    () =>
      new Promise((resolve) => {
        finishCreate = resolve;
      }),
  );
  const oldList = useAgentSessionStore.getState().refreshSessions();
  const oldCreate = useAgentSessionStore
    .getState()
    .submitSessionDraft("one", { message: "Old request", mode: "chat" });
  useAgentSessionStore.getState().setProjectId("two");
  await vi.waitFor(() =>
    expect(useAgentSessionStore.getState().sessions[0]?.id).toBe("s2"),
  );
  finishList(page([row("s1")]));
  finishCreate({ session: row("created-old", "one") });
  await Promise.all([oldList, oldCreate]);
  expect(useAgentSessionStore.getState()).toMatchObject({
    projectId: "two",
    sessions: [expect.objectContaining({ id: "s2", projectId: "two" })],
  });
});

it("does not let a background send steal the visible session live subscription", async () => {
  useAgentSessionStore.setState({
    selectedSessionId: "visible",
    sessions: [row("visible"), row("background")],
  });
  vi.mocked(agentRuntimeApi.submitRun).mockResolvedValue({} as never);
  vi.mocked(agentRuntimeApi.listSessions).mockResolvedValue(
    page([row("visible"), row("background")]),
  );
  await useAgentSessionStore
    .getState()
    .sendSessionMessage("background", { message: "Continue" });
  expect(ensureSessionLiveSubscription).not.toHaveBeenCalled();
  await useAgentSessionStore
    .getState()
    .sendSessionMessage("visible", { message: "Continue" });
  expect(ensureSessionLiveSubscription).toHaveBeenCalledWith(
    "visible",
    expect.any(Function),
  );
});

it("merges and deduplicates subsequent pages, preserving old pages across head refreshes", async () => {
  const first = Array.from({ length: 20 }, (_, i) => row(`s${i}`));
  vi.mocked(agentRuntimeApi.listSessions).mockResolvedValue({
    ...page(first),
    totalCount: 22,
  });
  await useAgentSessionStore.getState().refreshSessions();
  const original = useAgentSessionStore.getState().sessions[0];
  vi.mocked(agentRuntimeApi.listSessions).mockResolvedValue({
    ...page([row("s20"), row("s21")]),
    totalCount: 22,
  });
  await Promise.all([
    useAgentSessionStore.getState().loadMoreSessions(),
    useAgentSessionStore.getState().loadMoreSessions(),
  ]);
  expect(useAgentSessionStore.getState().sessions).toHaveLength(22);
  expect(agentRuntimeApi.listSessions).toHaveBeenCalledTimes(2);
  expect(agentRuntimeApi.listSessions).toHaveBeenLastCalledWith({
    projectId: "one",
    limit: 20,
    offset: 20,
  });
  vi.mocked(agentRuntimeApi.listSessions).mockResolvedValue({
    ...page(first.map((item) => ({ ...item }))),
    totalCount: 22,
  });
  await useAgentSessionStore.getState().refreshSessions();
  expect(useAgentSessionStore.getState().sessions).toHaveLength(22);
  expect(useAgentSessionStore.getState().sessions[0]).toBe(original);
});

it("discards a next-page response after changing projects", async () => {
  let resolve!: (value: ReturnType<typeof page>) => void;
  vi.mocked(agentRuntimeApi.listSessions).mockReturnValueOnce(
    new Promise((r) => {
      resolve = r;
    }),
  );
  const pending = useAgentSessionStore.getState().loadMoreSessions();
  vi.mocked(agentRuntimeApi.listSessions).mockResolvedValue(
    page([row("new", "two")]),
  );
  useAgentSessionStore.getState().setProjectId("two");
  resolve(page([row("old")]));
  await pending;
  await vi.waitFor(() =>
    expect(
      useAgentSessionStore.getState().sessions.map((item) => item.id),
    ).toEqual(["new"]),
  );
});

it("does not count a deep-linked session as a paginated row", async () => {
  useAgentSessionStore.setState({
    sessions: [row("linked")],
    sessionListOffset: 0,
  });
  vi.mocked(agentRuntimeApi.listSessions).mockResolvedValue({
    ...page([row("s1")]),
    totalCount: 31,
  });
  await useAgentSessionStore.getState().loadMoreSessions();
  expect(agentRuntimeApi.listSessions).toHaveBeenCalledWith({
    projectId: "one",
    limit: 20,
    offset: 0,
  });
  expect(useAgentSessionStore.getState().sessionListOffset).toBe(1);
});
