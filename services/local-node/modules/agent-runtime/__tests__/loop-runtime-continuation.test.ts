import { describe, expect, it } from "vitest";
import { AgentLoopRuntime } from "../loop-runtime.js";
import type { AgentRun, AgentSession } from "../contracts.js";

describe("AgentLoopRuntime continuation admission", () => {
  it("uses the admitted session status after sidecar activation", async () => {
    const session = {
      id: "session-1",
      status: "running",
      sessionMetadata: null,
    } as unknown as AgentSession;
    const acceptedRun = {
      id: "run-2",
      sessionId: session.id,
      status: "running",
      metadata: {
        runtime: {
          previousSessionStatus: "completed",
        },
      },
    } as unknown as AgentRun;
    const store = {
      getSession: () => session,
      getRun: () => acceptedRun,
      listRuns: () => [],
    };
    const runtime = new AgentLoopRuntime(store as never);
    (runtime as unknown as {
      streamRun: () => AsyncGenerator<unknown>;
    }).streamRun = async function* () {
      yield { type: "done", sessionId: session.id, runId: acceptedRun.id };
    };

    const chunks = [];
    for await (const chunk of runtime.streamContinue(session.id, {
      acceptedRunId: acceptedRun.id,
      message: "continue the conversation",
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      { type: "done", sessionId: session.id, runId: acceptedRun.id },
    ]);
  });
});
