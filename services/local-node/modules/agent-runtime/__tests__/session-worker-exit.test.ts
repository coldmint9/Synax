import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { executorInput, resetAgentRuntimeFixtures } from "./agent-runtime-fixtures.js";
import { agentRuntimeStore } from "../session-store.js";
import { agentSessionRuntime } from "../session-runtime.js";
import { sessionProcessManager } from "../session-process-manager.js";

const mocks = vi.hoisted(() => ({ fork: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(), fork: mocks.fork,
}));
vi.mock("../process-ownership.js", () => ({
  prepareOwnedProcess: () => ({ id: "test-worker" }),
  recordOwnedPid: vi.fn(), releaseOwnedProcess: vi.fn(), hasBackgroundProcesses: () => false,
}));

class TestWorker extends EventEmitter {
  connected = true;
  killed = false;
  pid = 12345;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn(() => { this.killed = true; return true; });
  started!: () => void;
  sessionId = "";
  send(message: { type: string }, callback?: (error: Error | null) => void) {
    if (message.type === "session:initialize")
      queueMicrotask(() => this.emit("message", { type: "session:ready", sessionId: this.sessionId }));
    if (message.type === "stream:start") this.started();
    callback?.(null);
  }
}

describe("session worker exit cleanup", () => {
  beforeEach(() => { resetAgentRuntimeFixtures(); mocks.fork.mockReset(); });

  it("ignores duplicate exits from an old worker after a replacement starts", async () => {
    const parent = agentSessionRuntime.create(executorInput);
    const child = agentSessionRuntime.create({ ...executorInput, profileId: "explorer", parentSessionId: parent.id });
    agentRuntimeStore.updateSession(parent.id, { status: "running" });
    agentRuntimeStore.updateSession(child.id, { status: "running" });
    const oldWorker = new TestWorker();
    oldWorker.sessionId = parent.id;
    const oldStarted = new Promise<void>((resolve) => { oldWorker.started = resolve; });
    mocks.fork.mockReturnValueOnce(oldWorker);
    const oldStream = sessionProcessManager.streamSession(parent.id, "turn", { message: "Old run" });
    const oldRejected = expect(oldStream.next()).rejects.toThrow("Test release");
    await oldStarted;
    sessionProcessManager.interruptSessions([parent.id], "Test release");
    await oldRejected;
    oldWorker.emit("exit", 0, null);
    agentRuntimeStore.updateSession(parent.id, { status: "running" });
    agentRuntimeStore.updateSession(child.id, { status: "running" });

    const replacement = new TestWorker();
    replacement.sessionId = parent.id;
    const newStarted = new Promise<void>((resolve) => { replacement.started = resolve; });
    mocks.fork.mockReturnValueOnce(replacement);
    const newStream = sessionProcessManager.streamSession(parent.id, "turn", { message: "New run" });
    const newRejected = expect(newStream.next()).rejects.toThrow("Agent session child process exited");
    await newStarted;
    oldWorker.emit("exit", 0, null);
    expect(agentRuntimeStore.getSession(parent.id).status).toBe("running");
    expect(agentRuntimeStore.getSession(child.id).status).toBe("running");
    expect(sessionProcessManager.isSessionStreaming(parent.id)).toBe(true);
    replacement.emit("exit", 1, null);
    await newRejected;
  });

  it.each([false, true])("reconciles the dead worker's session tree, runs and steps (released=%s)", async (released) => {
    const parent = agentSessionRuntime.create(executorInput);
    const child = agentSessionRuntime.create({ ...executorInput, profileId: "explorer", parentSessionId: parent.id });
    const completed = agentSessionRuntime.create({ ...executorInput, profileId: "explorer", parentSessionId: parent.id });
    const unrelated = agentSessionRuntime.create(executorInput);
    agentRuntimeStore.updateSession(parent.id, { status: "running" });
    agentRuntimeStore.updateSession(child.id, { status: "running" });
    agentRuntimeStore.updateSession(completed.id, { status: "completed", resultSummary: "Keep this result" });
    const startedAt = new Date().toISOString();
    const run = agentRuntimeStore.appendRun({
      id: "worker-child-run", sessionId: child.id, status: "running", startedAt,
      completedAt: null, triggerMessageId: null, currentStep: 1, stopReason: null, model: null, metadata: {},
    });
    agentRuntimeStore.appendRunStep({
      id: "worker-child-step", runId: run.id, sessionId: child.id, index: 1, status: "running",
      model: null, startedAt, completedAt: null, finishReason: null, metadata: {},
    });
    const failedRun = agentRuntimeStore.appendRun({
      ...run, id: "worker-parent-run", sessionId: parent.id, status: "failed",
      completedAt: startedAt, stopReason: "Provider error",
    });
    agentRuntimeStore.appendRunStep({
      id: "worker-parent-step", runId: failedRun.id, sessionId: parent.id, index: 1,
      status: "running", model: null, startedAt, completedAt: null, finishReason: null, metadata: {},
    });
    const worker = new TestWorker();
    worker.sessionId = parent.id;
    const started = new Promise<void>((resolve) => { worker.started = resolve; });
    mocks.fork.mockReturnValue(worker);
    const stream = sessionProcessManager.streamSession(parent.id, "turn", { message: "Start" });
    const next = stream.next();
    const rejected = expect(next).rejects.toThrow(released ? "Test release" : "Agent session child process exited");
    await started;
    if (released) {
      sessionProcessManager.interruptSessions([parent.id], "Test release");
      expect(agentRuntimeStore.getSession(child.id).status).toBe("running");
    }
    worker.emit("exit", 1, null);
    await rejected;
    expect(agentRuntimeStore.getSession(parent.id).status).toBe("interrupted");
    expect(agentRuntimeStore.getSession(child.id)).toMatchObject({
      status: "interrupted", blockedReason: expect.stringContaining("worker exited"),
      sessionMetadata: { subagentTask: { state: "completed", phase: "interrupted" } },
    });
    expect(agentRuntimeStore.getRun(run.id).status).toBe("interrupted");
    expect(agentRuntimeStore.listRunSteps(run.id)[0].status).toBe("interrupted");
    expect(agentRuntimeStore.getRun(failedRun.id)).toEqual(failedRun);
    expect(agentRuntimeStore.listRunSteps(failedRun.id)[0].status).toBe("interrupted");
    expect(agentRuntimeStore.getSession(completed.id)).toMatchObject({ status: "completed", resultSummary: "Keep this result" });
    expect(agentRuntimeStore.getSession(unrelated.id)).toEqual(unrelated);
    expect(sessionProcessManager.isSessionStreaming(parent.id)).toBe(false);
    worker.emit("exit", 1, null);
    expect(agentRuntimeStore.getSession(completed.id).resultSummary).toBe("Keep this result");
  });
});
