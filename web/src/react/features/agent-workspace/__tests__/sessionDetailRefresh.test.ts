import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { useAgentSessionStore as store } from "../state/agentSessionStore";
import {
  agentRuntimeApi as api,
  type AgentSession,
  type SessionStats,
} from "../../../../lib/api/agentRuntime";
vi.mock("../../../../lib/api/sessionLiveClient", () => ({
  ensureSessionLiveSubscription: vi.fn(),
  releaseSessionLiveSubscription: vi.fn(),
}));
const session = {
  id: "refresh-session",
  projectId: "p",
  status: "running",
  childSessionIds: [],
} as unknown as AgentSession;
const stats = (status: "running" | "completed") =>
  ({
    status,
    runningDuration: 1000,
    tokenUsage: { input: 1, output: 1, total: 2 },
    contextLimit: 1000,
    contextUsedPercent: 0,
    toolCallCount: 0,
    activeSubAgentCount: 0,
  }) as SessionStats;
beforeEach(() => {
  store.setState({
    ...store.getInitialState(),
    sessions: [session],
    selectedSessionId: session.id,
  });
  vi.spyOn(api, "getSessionStats").mockResolvedValue(stats("completed"));
  vi.spyOn(api, "getSessionTodos").mockResolvedValue({ items: [] });
  vi.spyOn(api, "getSessionCapabilities").mockResolvedValue({} as never);
  for (const key of [
    "listSessionSteps",
    "listRuns",
    "listEvents",
    "listMessages",
    "listToolCalls",
    "listPermissions",
  ] as const)
    vi.spyOn(api, key).mockResolvedValue({ items: [] });
});
afterEach(() => {
  vi.restoreAllMocks();
  store.setState(store.getInitialState());
});
describe("detail refresh freshness", () => {
  it("performs a trailing refresh when completion arrives during a running stats request", async () => {
    let resolve!: (value: SessionStats) => void;
    vi.mocked(api.getSessionStats).mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const first = store.getState().refreshDetail();
    store.getState().patchSession(session.id, { status: "completed" });
    const trailing = store.getState().refreshDetail();
    resolve(stats("running"));
    await Promise.all([first, trailing]);
    expect(api.getSessionStats).toHaveBeenCalledTimes(2);
    expect(store.getState().sessionStats?.status).toBe("completed");
  });
  it("does not let a detached old transcript response replace a newer one", async () => {
    let resolve!: (value: Awaited<ReturnType<typeof api.listMessages>>) => void;
    vi.mocked(api.listMessages)
      .mockReturnValueOnce(
        new Promise((r) => {
          resolve = r;
        }),
      )
      .mockResolvedValueOnce({
        items: [{ id: "new", content: "newest" } as never],
      });
    await store.getState().refreshDetail();
    await store.getState().refreshDetail();
    resolve({ items: [{ id: "old", content: "stale" } as never] });
    await Promise.resolve();
    await Promise.resolve();
    expect(store.getState().messages.map((message) => message.id)).toEqual([
      "new",
    ]);
  });
});

it("does not mark a profile-only cache entry as a loaded transcript", async () => {
  let resolve!: (value: Awaited<ReturnType<typeof api.listMessages>>) => void;
  vi.mocked(api.listMessages).mockReturnValueOnce(
    new Promise((r) => {
      resolve = r;
    }),
  );
  await store.getState().refreshDetail();
  expect(store.getState().sessionDetailCache[session.id].cachedAt).toBe(0);
  expect(store.getState().detailLoading).toBe(true);
  resolve({ items: [] });
  await vi.waitFor(() => expect(store.getState().detailLoading).toBe(false));
  expect(
    store.getState().sessionDetailCache[session.id].cachedAt,
  ).toBeGreaterThan(0);
});

it("retains existing content and exposes failure instead of permanently loading", async () => {
  vi.mocked(api.listMessages).mockRejectedValueOnce(new Error("offline"));
  await store.getState().refreshDetail();
  await vi.waitFor(() =>
    expect(store.getState().detailError).toContain("offline"),
  );
  expect(store.getState().detailLoading).toBe(false);
  expect(store.getState().sessionDetailCache[session.id].cachedAt).toBe(0);
});

it("does not refresh transcript freshness when an optional profile fetch completes later", async () => {
  let resolve!: (value: SessionStats) => void;
  vi.mocked(api.getSessionStats).mockReturnValueOnce(
    new Promise((r) => {
      resolve = r;
    }),
  );
  const pending = store.getState().refreshDetail();
  await vi.waitFor(() =>
    expect(
      store.getState().sessionDetailCache[session.id]?.cachedAt,
    ).toBeGreaterThan(0),
  );
  const cachedAt = store.getState().sessionDetailCache[session.id].cachedAt;
  resolve(stats("completed"));
  await pending;
  expect(store.getState().sessionDetailCache[session.id].cachedAt).toBe(
    cachedAt,
  );
});

it("lets polling join a slow transcript without repeatedly invalidating its result", async () => {
  let resolve!: (value: Awaited<ReturnType<typeof api.listMessages>>) => void;
  vi.mocked(api.listMessages).mockReturnValueOnce(
    new Promise((r) => {
      resolve = r;
    }),
  );
  await store.getState().refreshDetail();
  const poll = store.getState().refreshDetail({ joinPending: true });
  expect(api.listMessages).toHaveBeenCalledTimes(1);
  resolve({ items: [{ id: "slow-but-valid", content: "done" } as never] });
  await poll;
  expect(store.getState().messages[0].id).toBe("slow-but-valid");
});

it("rejects an old response after switching A → B → A", async () => {
  vi.spyOn(api, "listInputQueue").mockResolvedValue({ items: [] });
  const other = { ...session, id: "other" };
  store.setState({
    projectId: "p",
    panelOpen: true,
    sessions: [session, other],
  });
  let resolve!: (value: Awaited<ReturnType<typeof api.listMessages>>) => void;
  vi.mocked(api.listMessages)
    .mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    )
    .mockResolvedValueOnce({
      items: [{ id: "b-current", sessionId: "other" } as never],
    })
    .mockResolvedValueOnce({
      items: [{ id: "a-current", sessionId: session.id } as never],
    });
  await store.getState().refreshDetail();
  store.getState().openPanel(other.id);
  await vi.waitFor(() =>
    expect(store.getState().messages[0]?.id).toBe("b-current"),
  );
  store.getState().openPanel(session.id);
  await vi.waitFor(() =>
    expect(store.getState().messages[0]?.id).toBe("a-current"),
  );
  resolve({ items: [{ id: "a-stale" } as never] });
  await Promise.resolve();
  await Promise.resolve();
  expect(store.getState().messages[0].id).toBe("a-current");
});
