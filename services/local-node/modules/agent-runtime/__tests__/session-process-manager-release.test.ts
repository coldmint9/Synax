import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { forkMock, hydrateSessionMock, getSessionMock, tryGetSessionMock, listSessionTreeMock,
  listRunsMock, listRunStepsMock, updateSessionMock, updateRunMock, updateRunStepMock } = vi.hoisted(() => ({
  forkMock: vi.fn(),
  hydrateSessionMock: vi.fn(),
  getSessionMock: vi.fn(),
  tryGetSessionMock: vi.fn(),
  listSessionTreeMock: vi.fn(),
  listRunsMock: vi.fn(),
  listRunStepsMock: vi.fn(),
  updateSessionMock: vi.fn(),
  updateRunMock: vi.fn(),
  updateRunStepMock: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    fork: forkMock,
  };
});

vi.mock("../session-store.js", () => ({
  agentRuntimeStore: {
    hydrateSession: hydrateSessionMock,
    hydrateExecutionSession: hydrateSessionMock,
    flushSession: vi.fn(async () => {}),
    getSession: getSessionMock,
    tryGetSession: tryGetSessionMock,
    listSessionTree: listSessionTreeMock,
    listRuns: listRunsMock,
    listRunSteps: listRunStepsMock,
    updateSession: updateSessionMock,
    updateRun: updateRunMock,
    updateRunStep: updateRunStepMock,
  },
}));

vi.mock("../session-title-service.js", () => ({
  ensureSessionTitleGenerated: vi.fn(),
  maybeScheduleSessionTitleFromStreamChunk: vi.fn(),
}));

vi.mock("../session-live-bus.js", () => ({
  sessionLiveBus: { emit: vi.fn(), subscribe: vi.fn(), cleanup: vi.fn() },
}));

vi.mock("../runtime-bus.js", () => ({
  runtimeBus: { emit: vi.fn() },
}));

vi.mock("../tools/workspace.js", () => ({
  resolveSessionWorkDir: () => "/tmp/synax-test-workdir",
  resolveSessionWorkspaceRoots: () => [],
}));

vi.mock("../../../infrastructure/runtime/env.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../infrastructure/runtime/env.js")>();
  return {
    ...actual,
    MAX_AGENT_SESSION_PROCESSES: 2,
    AGENT_SESSION_CHILD_READY_TIMEOUT_MS: 5_000,
  };
});

import {
  prepareOwnedProcess,
  releaseOwnedProcess,
} from "../process-ownership.js";
import { sessionProcessManager } from "../session-process-manager.js";

function createMockChild(sessionId: string) {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    connected: boolean;
    killed: boolean;
    send: ReturnType<typeof vi.fn>;
    kill: ReturnType<typeof vi.fn>;
    stdout: EventEmitter | null;
    stderr: EventEmitter | null;
  };
  child.pid = Math.floor(Math.random() * 10_000) + 1;
  child.connected = true;
  child.killed = false;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.send = vi.fn((message: { type: string; streamId?: string }) => {
    if (message.type === "stream:start" && message.streamId) {
      queueMicrotask(() => {
        child.emit("message", {
          type: "stream:done",
          sessionId,
          streamId: message.streamId,
        });
      });
    }
  });
  child.kill = vi.fn((signal?: string) => {
    child.killed = true;
    child.connected = false;
    queueMicrotask(() => child.emit("exit", 0, signal ?? null));
    return true;
  });
  return child;
}

describe("sessionProcessManager idle child release", () => {
  beforeEach(() => {
    forkMock.mockReset();
    hydrateSessionMock.mockReset().mockResolvedValue(undefined);
    getSessionMock.mockReset();
    tryGetSessionMock.mockReset();
    listSessionTreeMock.mockReset().mockImplementation((id: string) => [getSessionMock(id)]);
    listRunsMock.mockReset().mockReturnValue([]);
    listRunStepsMock.mockReset().mockReturnValue([]);
    updateSessionMock.mockReset();
    updateRunMock.mockReset();
    updateRunStepMock.mockReset();
    getSessionMock.mockImplementation((sessionId: string) => ({
      id: sessionId,
      projectId: "proj-test",
      status: "running",
    }));
  });

  afterEach(() => {
    sessionProcessManager.interruptSessions(
      ["sess-release-a", "sess-release-b", "sess-release-c"],
      "test cleanup",
    );
  });

  it.each([false, true])(
    "routes child-only stop to its host and requires acknowledgement (timeout: %s)",
    async (timeout) => {
      const hostId = "sess-release-a";
      const child = createMockChild(hostId);
      let request: { requestId: string; sessionId: string } | undefined;
      child.send.mockImplementation((message) => {
        if (message.type === "stream:start")
          queueMicrotask(() =>
            child.emit("message", {
              type: "stream:chunk",
              sessionId: hostId,
              streamId: message.streamId,
              chunk: { type: "done", sessionId: hostId, runId: "test-run" },
            }),
          );
        if (message.type === "session:interrupt-subtree") request = message;
      });
      tryGetSessionMock.mockImplementation((id: string) => ({
        id,
        parentSessionId: id === "delegate" ? hostId : null,
      }));
      forkMock.mockImplementationOnce(() => {
        queueMicrotask(() =>
          child.emit("message", { type: "session:ready", sessionId: hostId }),
        );
        return child;
      });
      const stream = sessionProcessManager.streamSession(hostId, "turn", {});
      await stream.next();
      try {
        let confirmed = false;
        const stop = sessionProcessManager
          .interruptAndWaitForSessions(
            ["delegate"],
            "Stop child",
            timeout ? 20 : 1000,
          )
          .then(() => {
            confirmed = true;
          });
        expect(request?.sessionId).toBe("delegate");
        expect(confirmed).toBe(false);
        expect(child.kill).not.toHaveBeenCalled();
        if (timeout)
          await expect(stop).rejects.toMatchObject({ code: "DELETE_TIMEOUT" });
        else {
          child.emit("message", {
            ...request,
            type: "session:subtree-stopped",
          });
          await stop;
          expect(confirmed).toBe(true);
        }
        expect(child.kill).not.toHaveBeenCalled();
        expect(sessionProcessManager.isSessionStreaming(hostId)).toBe(true);
      } finally {
        await stream.return(undefined);
        await sessionProcessManager.waitForIdleSessions([hostId]);
      }
    },
  );

  it.each(["waiting_input", "waiting_permission", "running"])(
    "refreshes stale host state before releasing a worker with durable %s state",
    async (status) => {
      const id = "sess-release-a";
      const session = { id, projectId: "proj-test", status: "running", activeRunId: "run-wait",
        pendingResumeToken: null as string | null };
      hydrateSessionMock.mockImplementation(async () => {
        session.status = status;
        session.pendingResumeToken = "interaction:pending";
      });
      getSessionMock.mockReturnValue(session);
      tryGetSessionMock.mockReturnValue(session);
      listRunsMock.mockReturnValue([{ id: "run-wait", status }]);
      listRunStepsMock.mockReturnValue([{ id: "step-wait", status }]);
      updateSessionMock.mockImplementation((_id, patch) => Object.assign(session, patch));
      const child = createMockChild(id);
      forkMock.mockImplementationOnce(() => {
        queueMicrotask(() => child.emit("message", { type: "session:ready", sessionId: id }));
        return child;
      });
      for await (const _chunk of sessionProcessManager.streamSession(id, "turn", {})) {
        /* drain the paused turn */
      }
      await sessionProcessManager.waitForIdleSessions([id]);
      expect(hydrateSessionMock).toHaveBeenCalledWith(id, true);
      expect(child.kill).toHaveBeenCalled();
      expect(sessionProcessManager.canSpawnChild(id)).toBe(true);
      if (status === "running") {
        expect(session.status).toBe("interrupted");
        expect(session.activeRunId).toBeNull();
        expect(updateRunMock).toHaveBeenCalled();
        expect(updateRunStepMock).toHaveBeenCalled();
      } else {
        expect(session).toMatchObject({ status, activeRunId: "run-wait", pendingResumeToken: "interaction:pending" });
        expect(updateSessionMock).not.toHaveBeenCalled();
        expect(updateRunMock).not.toHaveBeenCalled();
        expect(updateRunStepMock).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["stop", "crash", "stop-during-release"])(
    "still interrupts waiting input on %s",
    async (mode) => {
      const id = "sess-release-a";
      const session = { id, projectId: "proj-test", status: "waiting_input", activeRunId: "run-wait" };
      getSessionMock.mockReturnValue(session);
      tryGetSessionMock.mockReturnValue(session);
      listRunsMock.mockReturnValue([{ id: "run-wait", status: "waiting_input" }]);
      listRunStepsMock.mockReturnValue([{ id: "step-wait", status: "waiting_input" }]);
      const child = createMockChild(id);
      child.kill.mockImplementation(() => { child.killed = true; return true; });
      child.send.mockImplementation((message) => {
        if (message.type === "stream:start") queueMicrotask(() => child.emit("message", {
          type: "stream:chunk", sessionId: id, streamId: message.streamId,
          chunk: { type: "done", sessionId: id, runId: "run-wait" },
        }));
      });
      forkMock.mockImplementationOnce(() => {
        queueMicrotask(() => child.emit("message", { type: "session:ready", sessionId: id }));
        return child;
      });
      const stream = sessionProcessManager.streamSession(id, "turn", {});
      await stream.next();
      if (mode === "stop-during-release") await stream.return(undefined);
      if (mode !== "crash") sessionProcessManager.interruptSessions([id], "User stopped session.");
      child.emit("exit", mode === "crash" ? 1 : 0, null);
      await stream.return(undefined);
      await sessionProcessManager.waitForIdleSessions([id]);
      expect(updateSessionMock).toHaveBeenCalledWith(id, expect.objectContaining({
        status: "interrupted", activeRunId: null, pendingResumeToken: null,
      }));
      expect(updateRunMock).toHaveBeenCalledWith("run-wait", expect.objectContaining({ status: "interrupted" }));
      expect(updateRunStepMock).toHaveBeenCalledWith("step-wait", expect.objectContaining({ status: "interrupted" }));
    },
  );

  it("releases the child after stream finishes so capacity is freed", async () => {
    const childA = createMockChild("sess-release-a");
    forkMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        childA.emit("message", {
          type: "session:ready",
          sessionId: "sess-release-a",
        });
      });
      return childA;
    });

    const chunks: unknown[] = [];
    for await (const chunk of sessionProcessManager.streamSession(
      "sess-release-a",
      "turn",
      {},
    )) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([]);
    expect(childA.kill).toHaveBeenCalled();
    expect(sessionProcessManager.canSpawnChild()).toBe(true);
    await sessionProcessManager.waitForIdleSessions(["sess-release-a"]);
  });

  it("still interrupts waiting sessions when the worker exits unexpectedly", async () => {
    const id = "sess-release-a";
    const session = { id, status: "waiting_input", activeRunId: "run-waiting" };
    tryGetSessionMock.mockReturnValue(session);
    listSessionTreeMock.mockReturnValue([session]);
    listRunsMock.mockReturnValue([{ id: "run-waiting", status: "waiting_input" }]);
    listRunStepsMock.mockReturnValue([{ id: "step-waiting", status: "waiting_input" }]);
    const child = createMockChild(id);
    child.send.mockImplementation((message) => {
      if (message.type === "stream:start") {
        queueMicrotask(() => child.emit("exit", 1, null));
      }
    });
    forkMock.mockImplementationOnce(() => {
      queueMicrotask(() => child.emit("message", { type: "session:ready", sessionId: id }));
      return child;
    });
    await expect(async () => {
      for await (const _chunk of sessionProcessManager.streamSession(id, "turn", {})) {
        /* drain */
      }
    }).rejects.toThrow("Agent session child process exited.");
    expect(updateSessionMock).toHaveBeenCalledWith(id, expect.objectContaining({
      status: "interrupted", activeRunId: null, pendingResumeToken: null,
    }));
    expect(updateRunMock).toHaveBeenCalledWith("run-waiting", expect.objectContaining({ status: "interrupted" }));
    expect(updateRunStepMock).toHaveBeenCalledWith("step-waiting", expect.objectContaining({ status: "interrupted" }));
  });

  it("keeps a service-owning worker alive after the turn, then releases it when the service stops", async () => {
    const id = "sess-release-a";
    const receipt = prepareOwnedProcess("test service", true, {
      sessionId: id,
      background: true,
    });
    const child = createMockChild(id);
    forkMock.mockImplementationOnce(() => {
      queueMicrotask(() =>
        child.emit("message", { type: "session:ready", sessionId: id }),
      );
      return child;
    });
    try {
      for await (const _chunk of sessionProcessManager.streamSession(
        id,
        "turn",
        {},
      )) {
        /* drain */
      }
      expect(child.kill).not.toHaveBeenCalled();
      releaseOwnedProcess(receipt.id);
      child.emit("message", {
        type: "runtime:event",
        event: { type: "session_process_changed", sessionId: id },
      });
      expect(child.kill).toHaveBeenCalled();
      await sessionProcessManager.waitForIdleSessions([id]);
    } finally {
      releaseOwnedProcess(receipt.id);
    }
  });

  it("does not leak slots across sequential one-shot sessions at capacity", async () => {
    const sessions = [
      "sess-release-a",
      "sess-release-b",
      "sess-release-c",
    ] as const;

    for (const sessionId of sessions) {
      const child = createMockChild(sessionId);
      forkMock.mockImplementationOnce(() => {
        queueMicrotask(() => {
          child.emit("message", { type: "session:ready", sessionId });
        });
        return child;
      });

      for await (const _chunk of sessionProcessManager.streamSession(
        sessionId,
        "turn",
        {},
      )) {
        // drain
      }
    }

    // MAX_AGENT_SESSION_PROCESSES is mocked to 2; without release the 3rd spawn would fail.
    expect(forkMock).toHaveBeenCalledTimes(3);
    expect(sessionProcessManager.canSpawnChild()).toBe(true);
  });
  it("waits for the real exit event rather than just clearing tracking maps", async () => {
    const child = createMockChild("sess-release-a");
    child.kill.mockImplementation(() => {
      child.killed = true;
      return true;
    });
    forkMock.mockImplementationOnce(() => {
      queueMicrotask(() =>
        child.emit("message", {
          type: "session:ready",
          sessionId: "sess-release-a",
        }),
      );
      return child;
    });
    for await (const _chunk of sessionProcessManager.streamSession(
      "sess-release-a",
      "turn",
      {},
    )) {
      /* drain */
    }
    expect(sessionProcessManager.canSpawnChild("sess-release-a")).toBe(false);
    let idle = false;
    const waiting = sessionProcessManager
      .waitForIdleSessions(["sess-release-a"])
      .then(() => {
        idle = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(idle).toBe(false);
    child.connected = false;
    child.emit("exit", 0, "SIGTERM");
    await waiting;
    expect(idle).toBe(true);
    expect(sessionProcessManager.canSpawnChild("sess-release-a")).toBe(true);
  });
});
