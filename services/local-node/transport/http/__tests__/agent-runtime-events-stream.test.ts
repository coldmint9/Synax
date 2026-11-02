import { beforeEach, describe, expect, it } from "vitest";
import { resetAgentRuntimeFixtures } from "../../../modules/agent-runtime/__tests__/agent-runtime-fixtures.js";
import { agentSessionRuntime } from "../../../modules/agent-runtime/session-runtime.js";
import { agentRuntimeStore } from "../../../modules/agent-runtime/session-store.js";
import { runtimeBus } from "../../../modules/agent-runtime/runtime-bus.js";

interface SseFrame { event: string; data: string }

/** Read the shared event stream until a named frame arrives or the test stalls. */
function openEventStream() {
  let release!: () => void;
  let stop!: () => void;
  const closed = new Promise<void>(resolve => { release = resolve; });
  const readerReady = (async () => {
    const { agentRuntimeRoutes } = await import("../agent-runtime.js");
    const controller = new AbortController();
    stop = () => { controller.abort(); release(); };
    const response = await agentRuntimeRoutes.request(
      "http://localhost/events/stream",
      { signal: controller.signal },
    );
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const next = async (name: string): Promise<SseFrame> => {
      for (;;) {
        const boundary = buffer.indexOf("\n\n");
        const head = boundary === -1 ? null : buffer.slice(0, boundary);
        if (boundary !== -1) {
          buffer = buffer.slice(boundary + 2);
          const event = /^event: (.+)$/m.exec(head!)?.[1];
          if (event === name)
            return { event, data: /^data: (.+)$/m.exec(head!)?.[1] ?? "" };
          continue;
        }
        const chunk = await Promise.race([
          reader.read(),
          closed.then(() => ({ done: true, value: undefined })),
        ]);
        if (chunk.done) throw new Error(`stream closed before ${name}`);
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    };
    return { next, close: () => { stop(); void reader.cancel().catch(() => {}); } };
  })();
  return { readerReady, stop: () => stop() };
}

describe("agent runtime event stream", () => {
  beforeEach(async () => { await resetAgentRuntimeFixtures(); });

  it("relays the worker's terminal status even when this process still has the session running", async () => {
    const session = agentSessionRuntime.create({
      projectId: "project-alpha",
      profileId: "executor",
      prompt: "Notify when the run settles.",
    });
    // The API process never sees the worker's own lifecycle writes, so its copy
    // stays running until the next authoritative read.
    agentRuntimeStore.updateSession(session.id, {
      status: "running",
      activeRunId: "run-worker",
    });
    const stream = openEventStream();
    try {
      const reader = await stream.readerReady;
      await reader.next("connected");
      runtimeBus.emit({
        type: "session_changed",
        sessionId: session.id,
        patch: { status: "completed", activeRunId: null, completedAt: "2026-10-28T00:00:00Z" },
      });
      const frame = await reader.next("session_changed");
      expect(JSON.parse(frame.data)).toMatchObject({
        sessionId: session.id,
        projectId: session.projectId,
        patch: { status: "completed", activeRunId: null },
      });
      reader.close();
    } finally {
      stream.stop();
    }
  });

  it("relays a pending question instead of the stale running copy", async () => {
    const session = agentSessionRuntime.create({
      projectId: "project-alpha",
      profileId: "executor",
      prompt: "Ask before continuing.",
    });
    agentRuntimeStore.updateSession(session.id, {
      status: "running",
      activeRunId: "run-worker",
    });
    const stream = openEventStream();
    try {
      const reader = await stream.readerReady;
      await reader.next("connected");
      runtimeBus.emit({
        type: "session_changed",
        sessionId: session.id,
        patch: { status: "waiting_input", pendingResumeToken: "request-1" },
      });
      const frame = await reader.next("session_changed");
      expect(JSON.parse(frame.data)).toMatchObject({
        sessionId: session.id,
        patch: { status: "waiting_input", pendingResumeToken: "request-1" },
      });
      reader.close();
    } finally {
      stream.stop();
    }
  });
});
