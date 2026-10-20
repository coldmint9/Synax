import { beforeEach, describe, expect, it } from "vitest";
import { admitActiveFixtureRun, resetAgentRuntimeFixtures, plannerSessionInput } from "./agent-runtime-fixtures.js";
import { agentSessionRuntime } from "../session-runtime.js";
import { agentRuntimeStore } from "../session-store.js";
import { runtimeFacade } from "../sidecar/runtime-facade.js";
import { runtimeClient } from "../sidecar/runtime-repository.js";
import { recoverRuntime } from "../runtime-recovery.js";

beforeEach(async () => {
  await resetAgentRuntimeFixtures();
});

describe("recoverRuntime", () => {
  it("keeps clearing a stranded runtime control marker across repeated starts", async () => {
    const sessionId = agentSessionRuntime.create(plannerSessionInput).id;
    const run = await admitActiveFixtureRun(sessionId, "Ask which file");
    await runtimeFacade.finishExecution(sessionId, { ...run, status: "completed", completedAt: new Date().toISOString() });
    const snapshot = await runtimeClient().snapshot(sessionId);
    // A previous start promised to finish this run but died before it could.
    await runtimeClient().controlCommand({
      sessionId,
      requestId: `stop_unconfirmed:${sessionId}:${run.id}`,
      epoch: snapshot.epoch,
      revision: snapshot.revision,
      operation: "stop_unconfirmed",
      payload: { runId: "", reason: "The runtime restarted without a confirmed active run." },
    });
    await agentRuntimeStore.hydrateSession(sessionId, true);

    await expect(recoverRuntime("host-first-start")).resolves.toBeDefined();
    // Every start used to replay the same stop_unconfirmed request id with a
    // fresh timestamped reason, which Rust rejects as a request conflict.
    await expect(recoverRuntime("host-later-start")).resolves.toBeDefined();
    await expect(recoverRuntime("host-later-start")).resolves.toBeDefined();
    // The stranded marker is durable; recovery reports it without stalling boot.
    const control = await runtimeFacade.controlState(sessionId) as { runtimeControl?: { state?: string } };
    expect(control.runtimeControl?.state).toBe("unconfirmed");
  });
});
