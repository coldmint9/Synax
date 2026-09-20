import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { forkMock, getSessionMock, tryGetSessionMock } = vi.hoisted(() => ({
  forkMock: vi.fn(),
  getSessionMock: vi.fn(),
  tryGetSessionMock: vi.fn(),
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
    getSession: getSessionMock,
    tryGetSession: tryGetSessionMock,
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
}));

vi.mock("../../../lib/env.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/env.js")>();
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
    getSessionMock.mockReset();
    tryGetSessionMock.mockReset();
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
