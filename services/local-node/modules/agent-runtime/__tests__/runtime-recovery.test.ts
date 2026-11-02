import { beforeEach, describe, expect, it, vi } from "vitest";
import { admitActiveFixtureRun, resetAgentRuntimeFixtures, plannerSessionInput } from "./agent-runtime-fixtures.js";
import { agentSessionRuntime } from "../session-runtime.js";
import { agentRuntimeStore } from "../session-store.js";
import { ensureSynaxAgentRegistered } from "../synax/index.js";
import { interactionService } from "../interaction-service.js";
import { makeRuntimeId, nowIso } from "../runtime-ids.js";
import { runtimeFacade } from "../sidecar/runtime-facade.js";
import { runtimeClient } from "../sidecar/runtime-repository.js";
import { needsRuntimeRecovery, recoverRuntime, recoverRuntimeSession } from "../runtime-recovery.js";

beforeEach(async () => {
  await resetAgentRuntimeFixtures();
});

/** Park a real fixture run on a human question, exactly like `human.ask`. */
async function parkOnQuestion(sessionId: string) {
  const run = await admitActiveFixtureRun(sessionId, "Ask which file");
  const at = nowIso();
  const step = agentRuntimeStore.appendRunStep({
    id: makeRuntimeId("stp"), runId: run.id, sessionId, index: 1, status: "running",
    model: null, startedAt: at, completedAt: null, finishReason: null, metadata: {},
  });
  const call = agentRuntimeStore.appendToolCall({
    id: makeRuntimeId("call"), sessionId, runId: run.id, stepId: step.id,
    modelToolCallId: "provider-question", toolId: "human.ask", category: "task",
    mutability: "read", argsHash: "", inputSummary: "Which file?", inputRef: {},
    outputSummary: null, outputRef: null, status: "running", permissionDecisionId: null,
    startedAt: at, endedAt: null, error: null,
  });
  const form = await interactionService.requestAuthoritative({
    sessionId, runId: run.id, stepId: step.id, toolCallId: call.id, kind: "clarification",
    request: { title: "Pick a file", questions: [{ id: "file", type: "text", label: "Which file?" }] },
  });
  return { run, step, call, form };
}

describe("recoverRuntime", () => {
  it("cleans up an uncommitted fork from a previous host without exposing an empty session", async () => {
    const session = agentSessionRuntime.create({ ...plannerSessionInput, sessionMetadata: {
      forkPreparing: true, forkRequestId: "interrupted-copy", forkHostId: "old-host",
    } }, { forkPreparing: true });
    await agentRuntimeStore.flushSession(session.id);
    expect(needsRuntimeRecovery({ ...session, runtimeRecoveryRequired: false })).toBe(true);
    await expect(recoverRuntimeSession("new-host", session.id)).resolves.toMatchObject({ reviewed: 1 });
    const recovered = await runtimeFacade.sessionSummaryAuthoritative(session.id);
    expect(recovered.sessionMetadata).toMatchObject({ forkPreparing: false, forkCopyComplete: false, forkInterrupted: true });
    expect(recovered.sessionMetadata?.deletedAt).toBeTruthy();
    expect(agentRuntimeStore.listSessions({ limit: Infinity })).not.toContainEqual(expect.objectContaining({ id: session.id }));
  });
  it("leaves settled indexed sessions cold but still checks live leases and older indexes", () => {
    const summary = { status: "completed", activeRunId: null, runtimeRecoveryRequired: false } as Parameters<typeof needsRuntimeRecovery>[0];
    expect(needsRuntimeRecovery(summary)).toBe(false);
    expect(needsRuntimeRecovery({ ...summary, runtimeRecoveryRequired: true })).toBe(true);
    expect(needsRuntimeRecovery({ ...summary, runtimeRecoveryRequired: undefined })).toBe(true);
    expect(needsRuntimeRecovery({ ...summary, status: "running" })).toBe(true);
    expect(needsRuntimeRecovery({ ...summary, activeRunId: "run" })).toBe(true);
  });
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

  it("keeps an interrupted question answerable instead of pausing the session", async () => {
    ensureSynaxAgentRegistered();
    const session = agentSessionRuntime.create({ ...plannerSessionInput, profileId: "synax", workDir: process.cwd() });
    const { form, call } = await parkOnQuestion(session.id);

    // The user closed the app while the form was open; the next launch has a new host.
    await recoverRuntimeSession("new-host", session.id);

    const recovered = await runtimeFacade.uiSnapshotAuthoritative(session.id);
    expect(recovered.session).toMatchObject({
      status: "waiting_input",
      activeRunId: null,
      pendingResumeToken: `interaction:${form.id}`,
      blockedReason: "Pick a file",
    });
    expect(recovered.run!.status).toBe("interrupted");
    // The question survives: the answer still starts the continuation turn,
    // and nothing auto-continues the work without it.
    expect(interactionService.pending(session.id)).toMatchObject({ id: form.id, status: "pending" });
    const control = await runtimeFacade.controlState(session.id) as { interactions?: Array<Record<string, unknown>> };
    expect(control.interactions).toContainEqual(expect.objectContaining({ id: form.id, status: "pending" }));
    expect(agentRuntimeStore.getToolCall(session.id, call.id).status).toBe("pending");
    expect(agentRuntimeStore.getSession(session.id)).toMatchObject({
      status: "waiting_input",
      activeRunId: null,
      pendingResumeToken: `interaction:${form.id}`,
    });
  });

  it("still pauses a session whose interrupted run had no open question", async () => {
    const session = agentSessionRuntime.create({ ...plannerSessionInput, workDir: process.cwd() });
    const run = await admitActiveFixtureRun(session.id, "Write the file");

    await recoverRuntimeSession("new-host", session.id);

    const recovered = await runtimeFacade.uiSnapshotAuthoritative(session.id);
    expect(recovered.session).toMatchObject({ status: "paused", activeRunId: null, pendingResumeToken: null });
    expect(recovered.run!.status).toBe("interrupted");
    expect(run.id).toBe(recovered.run!.id);
  });
});
