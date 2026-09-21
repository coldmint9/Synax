import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation } from "react-router-dom";
import { agentRuntimeApi as api, type AgentSession } from "../../../../lib/api/agentRuntime";
import { AppError } from "../../../../lib/appError";
import { isRuntimeResourceRemoved, resetRuntimeResourceRegistryForTests } from "../../../../lib/runtimeResourceRegistry";
import { ensureSessionLiveSubscription, releaseSessionLiveSubscription } from "../../../../lib/api/sessionLiveClient";
import { useAgentSessionStore as store } from "../state/agentSessionStore";
import { useSessionWorkspaceStore } from "../state/sessionWorkspaceStore";
import { loadSessionLastVisit, saveSessionLastVisit } from "../sessionLastVisit";
import { useSessionRouteSync } from "../useSessionRouteSync";
import { useSessionDetailPolling, ACTIVE_SESSION_POLL_MS } from "../useSessionDetailPolling";
import { useApiConnectivityStore } from "../../../../lib/apiConnectivity";

vi.mock("../../../../lib/api/sessionLiveClient", () => ({
  ensureSessionLiveSubscription: vi.fn(),
  releaseSessionLiveSubscription: vi.fn(),
}));

const session = { id: "missing", projectId: "p", status: "running", childSessionIds: [] } as unknown as AgentSession;
const missing = (id = session.id) => new AppError(`Agent runtime resource not found: ${id}`, {
  level: "business", code: "NOT_FOUND", statusCode: 404,
});

beforeEach(() => {
  resetRuntimeResourceRegistryForTests();
  localStorage.clear();
  store.setState({ ...store.getInitialState(), projectId: "p", sessions: [session], selectedSessionId: session.id, panelOpen: true });
  useSessionWorkspaceStore.setState({ sessions: {} });
  useApiConnectivityStore.setState({ apiReachable: "reachable" });
  vi.spyOn(api, "listSessions").mockResolvedValue({ items: [], totalCount: 0 });
  vi.spyOn(api, "getSession").mockRejectedValue(missing());
  vi.spyOn(api, "getSessionStats").mockResolvedValue({} as never);
  vi.spyOn(api, "getSessionTodos").mockResolvedValue({ items: [] });
  vi.spyOn(api, "getSessionInvocationUsage").mockResolvedValue({ items: [], totalCalls: 0 });
  vi.spyOn(api, "listInputQueue").mockResolvedValue({ items: [] });
  for (const key of ["listSessionSteps", "listRuns", "listEvents", "listMessages", "listToolCalls", "listPermissions"] as const) {
    vi.spyOn(api, key).mockResolvedValue({ items: [] });
  }
});

afterEach(() => {
  cleanup();
  store.getState().resetSessionDetailForDraft();
  store.setState(store.getInitialState());
  resetRuntimeResourceRegistryForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("missing session cleanup", () => {
  it("clears only the missing session's state and stops opening or refreshing it", async () => {
    saveSessionLastVisit("p", { kind: "session", sessionId: session.id });
    useSessionWorkspaceStore.getState().openTab(session.id, { kind: "file", title: "old", path: "old.ts" });
    store.setState({ sessionListTotal: 1, sessionListOffset: 1, messages: [{ id: "old" } as never] });
    vi.mocked(api.listMessages).mockRejectedValue(missing());
    await store.getState().refreshDetail();
    await waitFor(() => expect(store.getState().selectedSessionId).toBeNull());
    expect(store.getState()).toMatchObject({ panelOpen: false, detailLoading: false, detailError: null, messages: [], sessions: [], sessionDetailCache: {} });
    expect(isRuntimeResourceRemoved(session.id)).toBe(true);
    expect(loadSessionLastVisit("p")).toBeNull();
    expect(useSessionWorkspaceStore.getState().sessions[session.id]).toBeUndefined();
    expect(releaseSessionLiveSubscription).toHaveBeenCalled();
    await store.getState().refreshDetail();
    store.getState().openPanel(session.id);
    expect(api.listMessages).toHaveBeenCalledTimes(1);
    expect(ensureSessionLiveSubscription).not.toHaveBeenCalled();
  });

  it("handles an authoritative getSession 404 even when transcript endpoints return empty lists", async () => {
    store.setState({ sessions: [] });
    await store.getState().refreshDetail();
    expect(isRuntimeResourceRemoved(session.id)).toBe(true);
    expect(store.getState().selectedSessionId).toBeNull();
  });

  it.each([
    new Error("offline"),
    new AppError("forbidden", { level: "business", statusCode: 403, code: "FORBIDDEN" }),
    new AppError("Not Found", { level: "business", statusCode: 404 }),
    missing("nested-resource"),
  ])("preserves the session and retry UI for non-session failures: %s", async (error) => {
    saveSessionLastVisit("p", { kind: "session", sessionId: session.id });
    vi.mocked(api.listMessages).mockRejectedValue(error);
    await store.getState().refreshDetail();
    await waitFor(() => expect(store.getState().detailError).toBeTruthy());
    expect(isRuntimeResourceRemoved(session.id)).toBe(false);
    expect(store.getState().selectedSessionId).toBe(session.id);
    expect(loadSessionLastVisit("p")).not.toBeNull();
  });

  it("ignores an old 404 after switching to another session", async () => {
    let reject!: (error: Error) => void;
    vi.mocked(api.listMessages).mockReturnValueOnce(new Promise((_, fail) => { reject = fail; }));
    await store.getState().refreshDetail();
    const next = { ...session, id: "next" };
    store.setState({ sessions: [session, next] });
    saveSessionLastVisit("p", { kind: "session", sessionId: next.id });
    store.getState().openPanel(next.id);
    reject(missing());
    await waitFor(() => expect(store.getState().detailLoading).toBe(false));
    expect(store.getState()).toMatchObject({ selectedSessionId: next.id, panelOpen: true, detailError: null });
    expect(isRuntimeResourceRemoved(session.id)).toBe(false);
    expect(loadSessionLastVisit("p")).toEqual({ kind: "session", sessionId: next.id });
    expect(releaseSessionLiveSubscription).not.toHaveBeenCalled();
  });

  it("ignores an older refresh's 404 after a newer refresh succeeds", async () => {
    let reject!: (error: Error) => void;
    vi.mocked(api.listMessages).mockReturnValueOnce(new Promise((_, fail) => { reject = fail; }));
    await store.getState().refreshDetail();
    vi.mocked(api.listMessages).mockResolvedValue({ items: [{ id: "fresh" } as never] });
    await store.getState().refreshDetail();
    reject(missing());
    await act(async () => {});
    expect(store.getState()).toMatchObject({ selectedSessionId: session.id, panelOpen: true, messages: [{ id: "fresh" }], detailError: null });
    expect(isRuntimeResourceRemoved(session.id)).toBe(false);
  });

  it("does not clear the new project's state when an old project deletion finishes", async () => {
    let reject!: (error: Error) => void;
    vi.spyOn(api, "deleteSession").mockReturnValue(new Promise((_, fail) => { reject = fail; }));
    saveSessionLastVisit("p", { kind: "session", sessionId: session.id });
    const pending = store.getState().deleteSession(session.id);
    store.setState({ projectId: "other", selectedSessionId: "next", messages: [{ id: "next-message" } as never] });
    saveSessionLastVisit("other", { kind: "session", sessionId: "next" });
    reject(missing());
    await pending;
    expect(store.getState()).toMatchObject({ projectId: "other", selectedSessionId: "next", panelOpen: true, messages: [{ id: "next-message" }] });
    expect(loadSessionLastVisit("p")).toBeNull();
    expect(loadSessionLastVisit("other")).toEqual({ kind: "session", sessionId: "next" });
    expect(releaseSessionLiveSubscription).not.toHaveBeenCalled();
  });

  it("preserves the session when deletion fails with a permission error", async () => {
    const error = new AppError("forbidden", { level: "business", statusCode: 403, code: "FORBIDDEN" });
    vi.spyOn(api, "deleteSession").mockRejectedValue(error);
    await expect(store.getState().deleteSession(session.id)).rejects.toBe(error);
    expect(isRuntimeResourceRemoved(session.id)).toBe(false);
    expect(store.getState()).toMatchObject({ selectedSessionId: session.id, panelOpen: true, sessions: [session] });
  });

  it("treats deletion of an already missing session as successful local cleanup", async () => {
    vi.spyOn(api, "deleteSession").mockRejectedValue(missing());
    expect(await store.getState().deleteSession(session.id)).toEqual([session.id]);
    expect(store.getState()).toMatchObject({ selectedSessionId: null, panelOpen: false, sessions: [] });
  });

  it("preserves another session's last visit and visible detail when deletion finishes late", async () => {
    let reject!: (error: Error) => void;
    vi.spyOn(api, "deleteSession").mockReturnValue(new Promise((_, fail) => { reject = fail; }));
    const pending = store.getState().deleteSession(session.id);
    store.setState({ selectedSessionId: "next", messages: [{ id: "next-message" } as never] });
    saveSessionLastVisit("p", { kind: "session", sessionId: "next" });
    reject(missing());
    await pending;
    expect(store.getState()).toMatchObject({ selectedSessionId: "next", panelOpen: true, messages: [{ id: "next-message" }] });
    expect(loadSessionLastVisit("p")).toEqual({ kind: "session", sessionId: "next" });
    expect(releaseSessionLiveSubscription).not.toHaveBeenCalled();
  });
});

function RouteHarness({ workflow = false }: { workflow?: boolean }) {
  useSessionRouteSync(workflow ? "workflow" : "sessions", "p");
  useSessionDetailPolling();
  const location = useLocation();
  return <output data-testid="route">{location.pathname}{location.search}</output>;
}

describe("missing session routes", () => {
  it.each([false, true])("removes stale URL selection and stops polling (workflow=%s)", async (workflow) => {
    vi.useFakeTimers();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    vi.mocked(api.listMessages).mockRejectedValue(missing());
    const path = `/projects/p/sessions${workflow ? "/workflows" : ""}`;
    render(<MemoryRouter initialEntries={[`${path}?session=missing&filter=all`]}><RouteHarness workflow={workflow} /></MemoryRouter>);
    await act(async () => {});
    expect(screen.getByTestId("route").textContent).toBe(`${path}?filter=all`);
    expect(loadSessionLastVisit("p")).toBeNull();
    const calls = vi.mocked(api.listMessages).mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(ACTIVE_SESSION_POLL_MS * 3); });
    expect(api.listMessages).toHaveBeenCalledTimes(calls);
    expect(releaseSessionLiveSubscription).toHaveBeenCalled();
  });

  it("recovers from a persisted last visit without reopening it on remount", async () => {
    store.setState({ selectedSessionId: null, panelOpen: false, sessions: [] });
    saveSessionLastVisit("p", { kind: "session", sessionId: session.id });
    const view = render(<MemoryRouter initialEntries={["/projects/p/sessions"]}><RouteHarness /></MemoryRouter>);
    await waitFor(() => expect(isRuntimeResourceRemoved(session.id)).toBe(true));
    await waitFor(() => expect(screen.getByTestId("route").textContent).toBe("/projects/p/sessions"));
    expect(loadSessionLastVisit("p")).toBeNull();
    view.unmount();
    const calls = vi.mocked(api.getSession).mock.calls.length;
    render(<MemoryRouter initialEntries={["/projects/p/sessions"]}><RouteHarness /></MemoryRouter>);
    await act(async () => {});
    expect(api.getSession).toHaveBeenCalledTimes(calls);
  });
});
