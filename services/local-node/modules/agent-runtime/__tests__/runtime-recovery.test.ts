import { beforeEach, describe, expect, it, vi } from "vitest";
import { admitActiveFixtureRun, resetAgentRuntimeFixtures, plannerSessionInput } from "./agent-runtime-fixtures.js";
import { agentSessionRuntime } from "../session-runtime.js";
import { agentRuntimeStore } from "../session-store.js";
import { runtimeFacade } from "../sidecar/runtime-facade.js";
import { runtimeClient } from "../sidecar/runtime-repository.js";
import { recoverRuntime, recoverRuntimeSession } from "../runtime-recovery.js";

beforeEach(async () => {
  await resetAgentRuntimeFixtures();
});

describe("recoverRuntime", () => {
  it('recovers an idle target without enumerating sessions or reading every transcript collection', async () => {
    const session = agentSessionRuntime.create(plannerSessionInput);
    await agentRuntimeStore.flushSession(session.id);
    await runtimeFacade.sessionPatch(session.id, 'idle-before-boot', { status: 'completed', activeRunId: null });
    const list = vi.spyOn(runtimeFacade, 'listSessionProjection').mockRejectedValue(new Error('global index not ready'));
    const hydrate = vi.spyOn(agentRuntimeStore, 'hydrateSession').mockRejectedValue(new Error('history should remain cold'));
    try {
      await expect(recoverRuntimeSession('new-host', session.id)).resolves.toMatchObject({ reviewed: 0 });
      expect(list).not.toHaveBeenCalled();
      expect(hydrate).not.toHaveBeenCalled();
    } finally { list.mockRestore(); hydrate.mockRestore(); }
  });
  it("settles a stranded runtime control marker instead of parking a manual retry", async () => {
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
    // A stable acknowledgement id keeps repeated starts idempotent.
    await expect(recoverRuntime("host-later-start")).resolves.toBeDefined();
    await expect(recoverRuntime("host-later-start")).resolves.toBeDefined();
    // The fence is gone without any user action, so the session can run again.
    const control = await runtimeFacade.controlState(sessionId) as { runtimeControl?: { state?: string } };
    expect(control.runtimeControl ?? null).toBeNull();
    const settled = await runtimeFacade.uiSnapshotAuthoritative(sessionId);
    expect(settled.session.status).toBe("interrupted");
    expect((settled.session.sessionMetadata as { runtimeControl?: unknown } | undefined)?.runtimeControl ?? null).toBeNull();
  });

  it("settles a legacy recovery receipt whose absent run was encoded as null", async () => {
    const sessionId = agentSessionRuntime.create(plannerSessionInput).id;
    const reason = "The runtime restarted without a confirmed active run. Continue the session explicitly.";
    const snapshot = await runtimeClient().snapshot(sessionId);

    // Older builds used this id and serialized an absent active run as null.
    await runtimeClient().controlCommand({
      sessionId,
      requestId: `recovery-unconfirmed:${sessionId}`,
      epoch: snapshot.epoch,
      revision: snapshot.revision,
      operation: "stop_unconfirmed",
      payload: { runId: null, reason },
    });
    // Recreate the stale compatibility projection that caused startup to
    // replay the old request even though its receipt was already durable.
    await runtimeFacade.sessionPatch(sessionId, "clear-legacy-recovery", {
      status: "running",
      activeRunId: null,
      sessionMetadata: { runtimeControl: null },
    });
    await agentRuntimeStore.hydrateSession(sessionId, true);

    await expect(recoverRuntime("legacy-receipt-host")).resolves.toBeDefined();
    const control = await runtimeFacade.controlState(sessionId) as { runtimeControl?: { state?: string } };
    expect(control.runtimeControl ?? null).toBeNull();
  });

  it("clears a stop fence whose run id no longer matches anything", async () => {
    const sessionId = agentSessionRuntime.create(plannerSessionInput).id;
    const run = await admitActiveFixtureRun(sessionId, "Ask which file");
    await runtimeFacade.finishExecution(sessionId, {
      ...run,
      status: "completed",
      completedAt: new Date().toISOString(),
    });
    const snapshot = await runtimeClient().snapshot(sessionId);
    // The stop was acknowledged nowhere: `finish` closes the lease but keeps
    // the control fence, which would block every later execution.
    await runtimeClient().controlCommand({
      sessionId,
      requestId: `stop_unconfirmed:${sessionId}:${run.id}`,
      epoch: snapshot.epoch,
      revision: snapshot.revision,
      operation: "stop_unconfirmed",
      payload: { runId: run.id, reason: "Shutdown was not confirmed." },
    });
    await agentRuntimeStore.hydrateSession(sessionId, true);

    await recoverRuntimeSession("other-host", sessionId);

    const control = await runtimeFacade.controlState(sessionId) as { runtimeControl?: unknown };
    expect(control.runtimeControl ?? null).toBeNull();
    const settled = await runtimeFacade.uiSnapshotAuthoritative(sessionId);
    expect(settled.session.status).toBe("interrupted");
    expect((settled.session.sessionMetadata as { runtimeControl?: unknown } | undefined)?.runtimeControl ?? null).toBeNull();
  });
});
