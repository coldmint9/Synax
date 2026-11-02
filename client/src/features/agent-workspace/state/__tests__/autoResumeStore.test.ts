import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoResumeStore } from "../autoResumeStore";

const api = vi.hoisted(() => ({
  getAutoResumeState: vi.fn(),
  dismissAutoResume: vi.fn(),
}));

vi.mock("../../../../adapters/transport/agentRuntime", () => ({
  agentRuntimeApi: api,
}));

function item(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "session-1",
    projectId: "project-1",
    title: "Ship it",
    cause: "restart",
    phase: "queued",
    attempts: 0,
    enqueuedAt: "2026-10-29T10:00:00.000Z",
    updatedAt: "2026-10-29T10:00:00.000Z",
    nextAttemptAt: null,
    lastError: null,
    ...overrides,
  };
}

describe("autoResumeStore", () => {
  beforeEach(() => {
    api.getAutoResumeState.mockReset();
    api.dismissAutoResume.mockReset();
    useAutoResumeStore.getState().reset();
  });

  it("reads the runtime queue once", async () => {
    api.getAutoResumeState.mockResolvedValue({
      online: false,
      items: [item()],
    });
    await useAutoResumeStore.getState().refresh();
    const state = useAutoResumeStore.getState();
    expect(state.loaded).toBe(true);
    expect(state.online).toBe(false);
    expect(state.items["session-1"]?.phase).toBe("queued");
  });

  it("keeps the previous queue when the runtime is not reachable yet", async () => {
    api.getAutoResumeState.mockResolvedValue({ online: true, items: [item()] });
    await useAutoResumeStore.getState().refresh();
    api.getAutoResumeState.mockRejectedValue(new Error("offline"));
    await useAutoResumeStore.getState().refresh();
    expect(useAutoResumeStore.getState().items["session-1"]).toBeDefined();
  });

  it("applies queue events without another read", () => {
    const store = useAutoResumeStore.getState();
    store.applyChange({
      sessionId: "session-1",
      patch: { phase: "waiting_network", attempts: 0, online: false },
    });
    expect(useAutoResumeStore.getState().items["session-1"]).toMatchObject({
      phase: "waiting_network",
      attempts: 0,
    });
    expect(useAutoResumeStore.getState().online).toBe(false);

    store.applyChange({
      sessionId: "session-1",
      patch: { phase: "retrying", attempts: 2, online: true },
    });
    expect(useAutoResumeStore.getState().items["session-1"]).toMatchObject({
      phase: "retrying",
      attempts: 2,
    });

    useAutoResumeStore.getState().applyChange({
      sessionId: "session-1",
      patch: { removed: true, online: true },
    });
    expect(useAutoResumeStore.getState().items["session-1"]).toBeUndefined();
  });

  it("drops a session optimistically when the user stops auto-resume", async () => {
    api.getAutoResumeState.mockResolvedValue({ online: true, items: [item()] });
    await useAutoResumeStore.getState().refresh();
    api.dismissAutoResume.mockResolvedValue({ ok: true });

    await useAutoResumeStore.getState().dismiss("session-1");

    expect(api.dismissAutoResume).toHaveBeenCalledWith("session-1");
    expect(useAutoResumeStore.getState().items["session-1"]).toBeUndefined();
  });

  it("keeps the removal even if the runtime rejects the request", async () => {
    api.getAutoResumeState.mockResolvedValue({ online: true, items: [item()] });
    await useAutoResumeStore.getState().refresh();
    api.dismissAutoResume.mockRejectedValue(new Error("offline"));

    await useAutoResumeStore.getState().dismiss("session-1");

    expect(useAutoResumeStore.getState().items["session-1"]).toBeUndefined();
  });
});
