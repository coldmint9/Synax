import { RuntimeStreamWriter } from "../runtime-stream-writer.js";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRunStreamChunk, StreamTurnRequest } from "../contracts.js";
import type { AgentSessionStreamMode } from "../../../lib/ipc/agent-session-protocol.js";
import { agentRuntimeStore } from "../session-store.js";
import { agentSessionRuntime } from "../session-runtime.js";
import { activateAcceptedRun } from "../run-admission.js";
import { runtimeJournal } from "../runtime-journal.js";
import { RunCoordinator } from "../run-coordinator.js";
import { normalizeAgentSessionStatus } from "../session-projection.js";
import { inputQueueService } from "../input-queue-service.js";
import {
  plannerSessionInput,
  resetAgentRuntimeFixtures,
} from "./agent-runtime-fixtures.js";

let release: () => void;
let gate: Promise<void>;
let seenSignal: AbortSignal | undefined;
const execute = vi.fn(async function* (
  sessionId: string,
  _mode: AgentSessionStreamMode,
  input: StreamTurnRequest,
  signal?: AbortSignal,
): AsyncGenerator<AgentRunStreamChunk> {
  seenSignal = signal;
  const run = activateAcceptedRun(
    sessionId,
    input.acceptedRunId!,
    "user",
    null,
  );
  agentRuntimeStore.updateSession(sessionId, {
    status: "running",
    activeRunId: run.id,
  });
  yield { type: "run_started", run };
  yield {
    type: "message_delta",
    runId: run.id,
    stepId: "step",
    delta: "hello",
  };
  await gate;
  const finished = agentRuntimeStore.updateRun(run.id, {
    status: signal?.aborted ? "interrupted" : "completed",
    completedAt: new Date().toISOString(),
  });
  agentRuntimeStore.updateSession(sessionId, {
    status: normalizeAgentSessionStatus(finished.status),
    activeRunId: null,
  });
  yield { type: "run_completed", run: finished };
  yield { type: "done", sessionId, runId: run.id };
});
let coordinator: RunCoordinator;
beforeEach(() => {
  resetAgentRuntimeFixtures();
  execute.mockClear();
  seenSignal = undefined;
  gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  coordinator = new RunCoordinator({
    execute,
    interrupt: async () => {
      release();
    },
  });
});
afterEach(async () => {
  release();
  await coordinator.waitForIdle();
});
const create = () =>
  agentSessionRuntime.create({ ...plannerSessionInput, workDir: os.tmpdir() });

describe("headless Run coordinator", () => {
  it("waits for completion, then starts queued messages as separate FIFO runs without an observer", async () => {
    const session = create();
    const first = coordinator.submit(
      session.id,
      { message: "Original" },
      "queue-original",
    );
    inputQueueService.enqueue(session.id, {
      message: "Second",
      reasoningEffort: "high",
    });
    inputQueueService.enqueue(session.id, { message: "Third" });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    expect(inputQueueService.list(session.id)).toHaveLength(2);
    expect(coordinator.dispatchQueuedInput(session.id)).toBe(false);
    release();
    await coordinator.waitForIdle();
    expect(execute.mock.calls.map((call) => call[2].message)).toEqual([
      "Original",
      "Second",
      "Third",
    ]);
    expect(execute.mock.calls[1][2].reasoningEffort).toBe("high");
    expect(
      new Set(execute.mock.calls.map((call) => call[2].acceptedRunId)).size,
    ).toBe(3);
    expect(agentRuntimeStore.getRun(first.run.id).status).toBe("completed");
    expect(inputQueueService.list(session.id)).toHaveLength(0);
  });

  it.each([
    {
      label: "round handoff",
      runStatus: "completed",
      sessionStatus: "completed",
      stopReason: "round_yielded",
    },
    {
      label: "failed",
      runStatus: "failed",
      sessionStatus: "failed",
      stopReason: "failed",
    },
    {
      label: "blocked run",
      runStatus: "blocked",
      sessionStatus: "completed",
      stopReason: "blocked",
    },
    {
      label: "waiting_input",
      runStatus: "waiting_input",
      sessionStatus: "waiting_input",
      stopReason: "waiting_input",
    },
    {
      label: "waiting_permission",
      runStatus: "waiting_permission",
      sessionStatus: "waiting_permission",
      stopReason: "waiting_permission",
    },
    {
      label: "cancelled",
      runStatus: "cancelled",
      sessionStatus: "cancelled",
      stopReason: "cancelled",
    },
    {
      label: "interrupted",
      runStatus: "interrupted",
      sessionStatus: "interrupted",
      stopReason: "interrupted",
    },
  ] as const)(
    "keeps queued messages when the conversation ends in $label",
    async ({ runStatus, sessionStatus, stopReason }) => {
      const session = create();
      execute.mockImplementationOnce(async function* (id, _mode, input) {
        const run = activateAcceptedRun(id, input.acceptedRunId!, "user", null);
        await gate;
        const finished = agentRuntimeStore.updateRun(run.id, {
          status: runStatus,
          stopReason,
          completedAt: new Date().toISOString(),
        });
        agentRuntimeStore.updateSession(id, {
          status: sessionStatus,
          activeRunId: null,
        });
        yield { type: "done", sessionId: id, runId: finished.id };
      });
      coordinator.submit(
        session.id,
        { message: "Original" },
        `queue-${runStatus}`,
      );
      inputQueueService.enqueue(session.id, { message: "Later" });
      release();
      await coordinator.waitForIdle();
      expect(execute).toHaveBeenCalledTimes(1);
      expect(inputQueueService.list(session.id)).toHaveLength(1);
    },
  );

  it("dispatches an input arriving after completion and does not submit it twice", async () => {
    const session = create();
    coordinator.submit(session.id, { message: "Original" }, "late-queue");
    release();
    await coordinator.waitForIdle();
    inputQueueService.enqueue(session.id, { message: "Late input" });
    expect(coordinator.dispatchQueuedInput(session.id)).toBe(true);
    expect(coordinator.dispatchQueuedInput(session.id)).toBe(false);
    await coordinator.waitForIdle();
    expect(execute.mock.calls.map((call) => call[2].message)).toEqual([
      "Original",
      "Late input",
    ]);
  });

  it("rolls back admission if removing the queue item fails", async () => {
    const session = create();
    coordinator.submit(session.id, { message: "Original" }, "queue-rollback");
    release();
    await coordinator.waitForIdle();
    inputQueueService.enqueue(session.id, { message: "Retry later" });
    const take = vi
      .spyOn(inputQueueService, "take")
      .mockImplementationOnce(() => {
        throw new Error("Queue write failed");
      });
    try {
      expect(coordinator.dispatchQueuedInput(session.id)).toBe(false);
      expect(inputQueueService.list(session.id)).toHaveLength(1);
      expect(agentRuntimeStore.listRuns(session.id)).toHaveLength(1);
      expect(agentRuntimeStore.getSession(session.id).status).toBe("completed");
    } finally {
      take.mockRestore();
    }
    expect(coordinator.dispatchQueuedInput(session.id)).toBe(true);
    await coordinator.waitForIdle();
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("does not drain the queue after a user stop", async () => {
    const session = create();
    coordinator.submit(session.id, { message: "Original" }, "queue-stop");
    inputQueueService.enqueue(session.id, { message: "Later" });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    await coordinator.interrupt(session.id, "User stop");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(inputQueueService.list(session.id)).toHaveLength(1);
  });

  it("quarantines an unpersisted terminal outcome instead of rejecting an unobserved background promise", async () => {
    const session = create();
    const interrupt = vi.fn(async () => {
      release();
    });
    coordinator = new RunCoordinator({ execute, interrupt });
    const finish = vi
      .spyOn(RuntimeStreamWriter.prototype, "finish")
      .mockImplementationOnce(() => {
        throw new Error("cannot commit transaction");
      });
    coordinator.submit(session.id, { message: "Run" }, "persistence-failure");
    release();
    try {
      await vi.waitFor(() =>
        expect(
          agentRuntimeStore.getSession(session.id).sessionMetadata
            ?.runtimeControl,
        ).toMatchObject({ state: "unconfirmed" }),
      );
      await vi.waitFor(() => expect(interrupt).toHaveBeenCalledTimes(1));
      expect(() =>
        coordinator.submit(session.id, { message: "Next" }, "unsafe-next"),
      ).toThrow(/release/i);
      await expect(coordinator.waitForIdle()).rejects.toThrow(/recovery/i);
    } finally {
      finish.mockRestore();
      await coordinator.reconcileFailedStop(session.id);
    }
  });

  it("executes once without an observer and deduplicates repeated submissions", async () => {
    const session = create();
    const accepted = coordinator.submit(
      session.id,
      { message: "Run" },
      "same-request",
    );
    expect(
      coordinator.submit(session.id, { message: "Run" }, "same-request").run.id,
    ).toBe(accepted.run.id);
    release();
    await coordinator.waitForIdle();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(agentRuntimeStore.getRun(accepted.run.id).status).toBe("completed");
    expect(
      runtimeJournal
        .read(session.id)
        .some((record) => record.chunk.type === "message_delta"),
    ).toBe(true);
  });

  it("detaches an observer without aborting the owned execution", async () => {
    const session = create();
    const accepted = coordinator.submit(
      session.id,
      { message: "Run" },
      "detach",
    );
    const controller = new AbortController();
    const observer = coordinator.observeRun(
      session.id,
      accepted.run.id,
      0,
      controller.signal,
    );
    expect((await observer.next()).done).toBe(false);
    controller.abort();
    expect((await observer.next()).done).toBe(true);
    expect(seenSignal?.aborted).toBe(false);
    release();
    await coordinator.waitForIdle();
    expect(agentRuntimeStore.getRun(accepted.run.id).status).toBe("completed");
  });

  it("interrupts the owner and waits for it before reporting stopped", async () => {
    const session = create();
    const accepted = coordinator.submit(session.id, { message: "Run" }, "stop");
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    await coordinator.interrupt(session.id, "Stop requested");
    expect(seenSignal?.aborted).toBe(true);
    expect(coordinator.isActive(session.id)).toBe(false);
    expect(agentRuntimeStore.getRun(accepted.run.id).status).toBe(
      "interrupted",
    );
  });
});

describe("stop release fence", () => {
  it("does not release the session just because the generator ended before process shutdown", async () => {
    const session = create();
    let confirmStop!: () => void;
    const stopGate = new Promise<void>((resolve) => {
      confirmStop = resolve;
    });
    coordinator = new RunCoordinator({
      execute,
      interrupt: async () => {
        release();
        await stopGate;
      },
    });
    coordinator.submit(session.id, { message: "Run" }, "fenced");
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    const stopped = coordinator.interrupt(session.id, "Stop");
    await vi.waitFor(() =>
      expect(agentRuntimeStore.listRuns(session.id)[0].status).toBe(
        "interrupted",
      ),
    );
    expect(() =>
      coordinator.submit(session.id, { message: "Next" }, "next"),
    ).toThrow(/release/i);
    expect(runtimeJournal.snapshot(session.id).session.status).toBe("stopping");
    confirmStop();
    await stopped;
    expect(coordinator.isActive(session.id)).toBe(false);
  });
});

describe("scoped control completion", () => {
  it("runs state finalizers before allowing another request and rejects a stale Run target", async () => {
    const session = create();
    const first = coordinator.submit(session.id, { message: "First" }, "first");
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    const finalized = vi.fn(() =>
      expect(() =>
        coordinator.submit(session.id, { message: "Racing" }, "race"),
      ).toThrow(),
    );
    await coordinator.interrupt(
      session.id,
      "Stop first",
      finalized,
      first.run.id,
    );
    expect(finalized).toHaveBeenCalledTimes(1);
    const second = coordinator.submit(
      session.id,
      { message: "Second" },
      "second",
    );
    await expect(
      coordinator.interrupt(session.id, "Stale stop", undefined, first.run.id),
    ).rejects.toThrow(/stale/i);
    expect(second.run.id).not.toBe(first.run.id);
  });
});

describe("parent-hosted child control", () => {
  it("stops a child through its driver without stopping its parent or siblings", async () => {
    const parent = create();
    const child = agentSessionRuntime.create({
      ...plannerSessionInput,
      profileId: "explorer",
      parentSessionId: parent.id,
    });
    const sibling = agentSessionRuntime.create({
      ...plannerSessionInput,
      profileId: "explorer",
      parentSessionId: parent.id,
    });
    const interrupt = vi.fn(async () => {});
    coordinator = new RunCoordinator({ execute, interrupt });
    await coordinator.interrupt(child.id, "Stop child", () =>
      agentSessionRuntime.cancel(child.id),
    );
    expect(interrupt).toHaveBeenCalledWith(child.id, "Stop child");
    expect(agentRuntimeStore.getSession(child.id).status).toBe("interrupted");
    expect(agentRuntimeStore.getSession(parent.id).status).toBe("running");
    expect(agentRuntimeStore.getSession(sibling.id).status).toBe("running");
    expect(coordinator.isActive(child.id)).toBe(false);
  });
});
