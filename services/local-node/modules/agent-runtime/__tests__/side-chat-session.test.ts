import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { admitActiveFixtureRun, resetAgentRuntimeFixtures } from "./agent-runtime-fixtures.js";
import { restartTestRuntime } from "../../../../test-fixtures/rust-runtime.js";
import { agentSessionRuntime } from "../session-runtime.js";
import { agentRuntimeStore as store } from "../session-store.js";
import { ensureSynaxAgentRegistered } from "../synax/index.js";
import { runtimeFacade } from "../sidecar/runtime-facade.js";
import { openSideChat } from "../side-chat-service.js";
import { sideChatRequestSchema } from "../side-chat-contract.js";
import { profileService } from "../profile-service.js";
import { toolRegistry } from "../tool-registry.js";
import { permissionPolicy } from "../permission-policy.js";
import { applySessionPermissionUpdate } from "../session-permissions.js";
import { acceptRuntimeRunAuthoritative } from "../run-admission.js";
import { listOwnedSubagentSessions, subagentBlocksParent, subagentCompletionBroker } from "../subagent-control-broker.js";
import { controlToolError } from "../control-policy.js";
import { agentRuntimeRoutes } from "../../../transport/http/agent-runtime.js";
import { interactionService } from "../interaction-service.js";
import { RunCoordinator } from "../run-coordinator.js";
import { inputQueueRuntime } from "../input-queue-runtime.js";
import { recoverRuntimeSession } from "../runtime-recovery.js";

let root: string;
let parentId: string;
const parentSecret = "Remember the release codename: saffron.";
async function appendMessage(content: string, id = crypto.randomUUID()) {
  store.appendMessage({ id, sessionId: parentId, runId: null, stepId: null, role: "user",
    content, createdAt: new Date().toISOString(), metadata: {} });
  await store.flushSession(parentId);
  return id;
}
async function childHistory(sessionId: string) {
  return await runtimeFacade.listMessageHistory(sessionId) as Array<{ id: string; content: string; createdAt: string }>;
}
async function childProjection() {
  return await runtimeFacade.listSessionProjection() as Array<{ id: string; parentSessionId: string | null }>;
}
beforeEach(async () => {
  await resetAgentRuntimeFixtures(); ensureSynaxAgentRegistered();
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "synax-side-chat-")));
  fs.writeFileSync(path.join(root, "context.txt"), "parent workspace");
  parentId = agentSessionRuntime.create({ projectId: "project-alpha", profileId: "synax", prompt: "Original request",
    workDir: root, permissionTier: "unrestricted", sessionMetadata: { mode: "goal" } }).id;
  store.updateSession(parentId, { status: "completed" });
  await appendMessage(parentSecret);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await store.flush();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("interactive side chat beside the primary session", () => {
  it("starts from a parent history snapshot and records where the inherited context ends", async () => {
    const parentUpdatedAt = store.getSession(parentId).updatedAt;
    const result = await openSideChat(parentId);
    const child = result.session;
    expect(result).toMatchObject({ reused: false, sideChatContext: { kind: "side-chat", sourceSessionId: parentId } });
    expect(Number.isSafeInteger(result.sideChatContext.sourceRevision)).toBe(true);
    expect(result.sideChatContext.inheritedThrough).toEqual(expect.any(String));
    expect(child).toMatchObject({ parentSessionId: parentId, profileId: "subagent", status: "completed", activeRunId: null,
      sessionMetadata: { mode: "chat", subagentKind: "side-chat", sideChatReady: true, forkPreparing: false } });
    expect(child.sessionMetadata?.goal).toBeUndefined();
    expect(child.sessionMetadata?.runtimeControl).toBeUndefined();
    expect(store.getSession(parentId).updatedAt).toBe(parentUpdatedAt);
    // The snapshot is model context, and every inherited record predates the boundary.
    const inherited = await childHistory(child.id);
    expect(inherited.map(message => message.content)).toContain(parentSecret);
    const boundary = Date.parse(result.sideChatContext.inheritedThrough!);
    expect(inherited.every(message => Date.parse(message.createdAt) <= boundary)).toBe(true);
    const tools = toolRegistry.listForSession(child.id).map(tool => tool.id);
    expect(tools).toEqual(expect.arrayContaining(["file.read", "file.write", "human.ask"]));
    expect(tools).not.toContain("subagent.delegate");
    const hints = profileService.getForSession(child).loopHints!.join("\n");
    expect(hints).toContain("snapshot of the primary conversation");
    expect(hints).not.toContain("Complete the delegated task");
    expect(hints).not.toContain("Read-only assignment");
    expect(controlToolError(child, { id: "file.read" })).toBeNull();
    expect(controlToolError(child, { id: "human.ask" })).toBeNull();
    expect(controlToolError(child, { id: "plan.propose" })).toContain("primary workflow");
    await appendMessage("A later parent message must stay out of the side chat.");
    expect((await childHistory(child.id)).map(message => message.content)).not.toContain("A later parent message must stay out of the side chat.");
    const read = await toolRegistry.execute(child.id, "file.read", { path: "context.txt" });
    expect(read.record.status).toBe("completed");
    const write = await toolRegistry.execute(child.id, "file.write", { path: "side-note.txt", content: "side change" });
    expect(write.record.status, write.record.error ?? "").toBe("completed");
    expect(fs.readFileSync(path.join(root, "side-note.txt"), "utf8")).toBe("side change");
    const accepted = await acceptRuntimeRunAuthoritative(child.id, { message: "What does the workspace contain?" }, "side-first-turn");
    expect(accepted.run.sessionId).toBe(child.id);
    expect(Date.parse(accepted.run.startedAt)).toBeGreaterThan(boundary);
    expect(subagentBlocksParent({ ...child, status: "running" })).toBe(false);
    expect(listOwnedSubagentSessions(parentId)).toEqual([]);
    expect(await subagentCompletionBroker.wait({ parentSessionId: parentId, timeoutMs: 50 })).toMatchObject({ reason: "terminal" });
  });

  it("reuses one child under concurrent opens and after a Rust/Node cache restart", async () => {
    const clone = vi.spyOn(runtimeFacade, "cloneHistoryAuthoritative");
    const results = await Promise.all(Array.from({ length: 5 }, () => openSideChat(parentId)));
    expect(new Set(results.map(result => result.session.id)).size).toBe(1);
    expect(results.filter(result => !result.reused)).toHaveLength(1);
    expect(clone).toHaveBeenCalledTimes(1);
    await appendMessage("Parent history advanced after opening.");
    await restartTestRuntime(); store.reset();
    const reopened = await openSideChat(parentId);
    expect(reopened.reused).toBe(true);
    expect(reopened.session.id).toBe(results[0].session.id);
    expect(reopened.sideChatContext).toEqual(results[0].sideChatContext);
    expect(clone).toHaveBeenCalledTimes(1);
    expect((await childHistory(reopened.session.id)).map(message => message.content)).not.toContain("Parent history advanced after opening.");
  });

  it("finishes the committed snapshot when the readiness acknowledgement was lost", async () => {
    const clone = vi.spyOn(runtimeFacade, "cloneHistoryAuthoritative");
    const original = runtimeFacade.sessionPatch.bind(runtimeFacade);
    vi.spyOn(runtimeFacade, "sessionPatch").mockImplementationOnce(async () => { throw new Error("lost readiness reply"); });
    await expect(openSideChat(parentId)).rejects.toThrow("lost readiness reply");
    vi.mocked(runtimeFacade.sessionPatch).mockImplementation(original);
    expect(clone).toHaveBeenCalledTimes(1);
    await appendMessage("Append after the committed snapshot.");
    await restartTestRuntime(); store.reset();
    const preparing = (await runtimeFacade.listSessionProjection() as Array<{ id: string; parentSessionId: string }>)
      .find(session => session.parentSessionId === parentId)!;
    // Generic fork recovery must not claim a side chat; opening resumes it.
    expect(await recoverRuntimeSession("restarted-host", preparing.id, true)).toEqual({ reviewed: 0, resumable: [] });
    expect((await runtimeFacade.sessionSummaryAuthoritative(preparing.id)).sessionMetadata)
      .toMatchObject({ sideChatReady: false, forkPreparing: true });
    const recovered = await openSideChat(parentId);
    expect(recovered.reused).toBe(true);
    expect(recovered.session.id).toBe(preparing.id);
    expect(recovered.session.sessionMetadata?.sideChatReady).toBe(true);
    expect(recovered.sideChatContext.inheritedThrough).toEqual(expect.any(String));
    // The durable receipt is reused: the snapshot is never copied twice.
    expect(clone).toHaveBeenCalledTimes(1);
    expect((await childHistory(recovered.session.id)).map(message => message.content))
      .toContain(parentSecret);
    expect((await childHistory(recovered.session.id)).map(message => message.content))
      .not.toContain("Append after the committed snapshot.");
    expect((await childProjection()).filter(session => session.parentSessionId === parentId)).toHaveLength(1);
  });

  it("reads the side chat a conversation would reopen without creating one", async () => {
    const readBefore = await (await agentRuntimeRoutes.request(`/sessions/${parentId}/side-chat`)).json() as { session: unknown };
    expect(readBefore.session).toBeNull();
    expect((await childProjection()).filter(session => session.parentSessionId === parentId)).toHaveLength(0);

    const created = await openSideChat(parentId);
    const response = await agentRuntimeRoutes.request(`/sessions/${parentId}/side-chat`);
    expect(response.status).toBe(200);
    const read = await response.json() as {
      session: { id: string; parentSessionId: string; sessionMetadata?: { sideChatReady?: boolean } };
    };
    expect(read.session).toMatchObject({ id: created.session.id, parentSessionId: parentId });
    expect(read.session.sessionMetadata?.sideChatReady).toBe(true);
    // A lookup is not an open: the snapshot is never copied again.
    expect((await childProjection()).filter(session => session.parentSessionId === parentId)).toHaveLength(1);
    const unopenedParent = agentSessionRuntime.create({ projectId: "project-alpha", profileId: "synax",
      prompt: "No side chat here", workDir: root }).id;
    const readMissing = await (await agentRuntimeRoutes.request(`/sessions/${unopenedParent}/side-chat`)).json() as { session: unknown };
    expect(readMissing.session).toBeNull();
  });

  it("retries a snapshot that never committed without leaving a second child", async () => {
    vi.spyOn(runtimeFacade, "cloneHistoryAuthoritative").mockRejectedValueOnce(new Error("snapshot interrupted"));
    await expect(openSideChat(parentId)).rejects.toThrow("snapshot interrupted");
    const retried = await openSideChat(parentId);
    expect(retried.reused).toBe(true);
    expect(retried.session.sessionMetadata?.sideChatReady).toBe(true);
    expect(retried.sideChatContext.inheritedThrough).toEqual(expect.any(String));
    expect((await childHistory(retried.session.id)).map(message => message.content)).toContain(parentSecret);
    expect((await childProjection()).filter(session => session.parentSessionId === parentId)).toHaveLength(1);
  });

  it("erases every side chat of the conversation so the next open starts fresh", async () => {
    const before = await agentRuntimeRoutes.request(`/sessions/${parentId}/side-chat`, { method: "DELETE" });
    expect(before.status).toBe(200);
    expect(await before.json()).toEqual({ ok: true, deletedSessionIds: [] });

    const created = await openSideChat(parentId);
    // A pre-boundary child without a snapshot context still holds a transcript.
    const legacy = agentSessionRuntime.create({ projectId: "project-alpha", profileId: "subagent",
      parentSessionId: parentId, prompt: "Legacy side chat", workDir: root,
      sessionMetadata: { mode: "chat", subagentKind: "side-chat", sideChatReady: true,
        subagentProfile: { version: 1, parentSessionId: parentId, workspaceRoot: root,
          profile: { name: "Side chat", access: "read-only" }, capabilities: ["file.read"] } } });
    expect(store.getSession(parentId).childSessionIds)
      .toEqual(expect.arrayContaining([created.session.id, legacy.id]));

    const response = await agentRuntimeRoutes.request(`/sessions/${parentId}/side-chat`, { method: "DELETE" });
    expect(response.status).toBe(200);
    const payload = await response.json() as { ok: boolean; deletedSessionIds: string[] };
    expect(payload.deletedSessionIds).toEqual(
      expect.arrayContaining([created.session.id, legacy.id]));
    // Nothing is kept: no durable rows, no cached session, no parent link.
    for (const id of payload.deletedSessionIds) {
      expect(await runtimeFacade.sessionExists(id)).toBe(false);
      expect(store.tryGetSession(id)).toBeUndefined();
    }
    expect(store.getSession(parentId).childSessionIds).toEqual([]);
    expect((await childProjection()).filter(session => session.parentSessionId === parentId)).toHaveLength(0);
    const readAfter = await (await agentRuntimeRoutes.request(`/sessions/${parentId}/side-chat`)).json() as { session: unknown };
    expect(readAfter.session).toBeNull();

    // The slot is free, so the button opens a brand-new snapshot.
    const fresh = await openSideChat(parentId);
    expect(fresh.reused).toBe(false);
    expect(fresh.session.id).not.toBe(created.session.id);
    expect(fresh.sideChatContext.inheritedThrough).toEqual(expect.any(String));
    expect((await childHistory(fresh.session.id)).map(message => message.content)).toContain(parentSecret);
  });

  it("opens beside a running primary conversation and snapshots only what the copy captured", async () => {
    const parentRun = await admitActiveFixtureRun(parentId);
    await appendMessage("Committed while side chat was opening.");
    const result = await openSideChat(parentId);
    expect(result.session.sessionMetadata?.sideChatReady).toBe(true);
    expect(store.getRun(parentRun.id).status).toBe("running");
    const inherited = await childHistory(result.session.id);
    const boundary = Date.parse(result.sideChatContext.inheritedThrough!);
    expect(inherited.every(message => Date.parse(message.createdAt) <= boundary)).toBe(true);
    expect(inherited.map(message => message.content)).toContain(parentSecret);
  });

  it("inherits permission changes from the primary session and never expands them", async () => {
    const { session } = await openSideChat(parentId);
    applySessionPermissionUpdate(parentId, { permissionOverrides: { write: "deny", read: "deny" } });
    // Raising the child's own tier cannot exceed the primary session's ceiling.
    applySessionPermissionUpdate(session.id, { permissionTier: "unrestricted" });
    const write = await toolRegistry.execute(session.id, "file.write", { path: "forbidden", content: "bad" });
    expect(["denied", "failed"]).toContain(write.record.status);
    expect(fs.existsSync(path.join(root, "forbidden"))).toBe(false);
    const read = await toolRegistry.execute(session.id, "file.read", { path: "context.txt" });
    expect(["denied", "failed"]).toContain(read.record.status);
    applySessionPermissionUpdate(parentId, { permissionOverrides: { write: "allow", read: "allow" } });
    const allowed = await toolRegistry.execute(session.id, "file.write", { path: "allowed", content: "ok" });
    expect(allowed.record.status, allowed.record.error ?? "").toBe("completed");
  });

  it("asks the user in the side chat instead of denying an approval-gated operation", async () => {
    const { session } = await openSideChat(parentId);
    applySessionPermissionUpdate(parentId, { permissionTier: "auto" });
    const removed = await toolRegistry.execute(session.id, "file.delete", { path: "context.txt" });
    expect(removed.record.status).toBe("pending");
    const pending = permissionPolicy.list(session.id).find(item => item.id === removed.permission?.id);
    expect(pending).toMatchObject({ action: "ask", userReply: null, sessionId: session.id });
    expect(store.getSession(session.id).status).toBe("waiting_permission");
    expect(fs.existsSync(path.join(root, "context.txt"))).toBe(true);
    expect(permissionPolicy.reply(session.id, pending!.id, "once")).toMatchObject({ action: "allow", userReply: "once" });
  });

  it("owns clarification interactions while its parent is completed", async () => {
    const { session } = await openSideChat(parentId);
    const run = await admitActiveFixtureRun(session.id);
    const stepId = "side-chat-ask-step";
    store.appendRunStep({ id: stepId, sessionId: session.id, runId: run.id, index: 1,
      status: "running", model: null, startedAt: new Date().toISOString(), completedAt: null, finishReason: null, metadata: {} });
    const result = await toolRegistry.execute(session.id, "human.ask", {
      title: "Select focus", questions: [{ id: "focus", type: "text", label: "Which module?" }],
    }, { runId: run.id, stepId });
    expect(result.record.status).toBe("pending");
    expect(result.interactionId).toBeTruthy();
    expect(interactionService.pending(session.id)?.kind).toBe("clarification");
    expect(interactionService.pending(parentId)).toBeNull();
  });

  it("dispatches queued user input after a side-chat turn completes", async () => {
    const { session } = await openSideChat(parentId);
    const time = new Date().toISOString();
    store.appendRun({ id: "finished-side-turn", sessionId: session.id, status: "completed", startedAt: time,
      completedAt: time, triggerMessageId: null, currentStep: 1, stopReason: "stop", model: null, metadata: {} });
    await store.flushSession(session.id);
    const [queued] = await inputQueueRuntime.enqueue(session.id, { message: "Follow-up question" });
    const coordinator = new RunCoordinator();
    const launch = vi.spyOn(coordinator as unknown as { launch: (...args: unknown[]) => void }, "launch").mockImplementation(() => {});
    expect(await coordinator.dispatchQueuedInput(session.id)).toBe(true);
    expect(launch).toHaveBeenCalledWith(session.id, expect.any(String), "turn", expect.objectContaining({ message: "Follow-up question" }));
    expect(store.listRuns(session.id).some(run => (run.metadata.runtime as { requestId?: string })?.requestId === `input-queue:${queued.id}`)).toBe(true);
  });

  it("carries the system-injection marker from a queued item into the turn", async () => {
    const { session } = await openSideChat(parentId);
    const time = new Date().toISOString();
    store.appendRun({ id: "finished-side-injection-turn", sessionId: session.id, status: "completed", startedAt: time,
      completedAt: time, triggerMessageId: null, currentStep: 1, stopReason: "stop", model: null, metadata: {} });
    await store.flushSession(session.id);
    await inputQueueRuntime.enqueue(session.id, { message: "Continue the graph.", messageSource: "system_injection" });
    const coordinator = new RunCoordinator();
    const launch = vi.spyOn(coordinator as unknown as { launch: (...args: unknown[]) => void }, "launch").mockImplementation(() => {});
    expect(await coordinator.dispatchQueuedInput(session.id)).toBe(true);
    // Without the marker the runtime scaffolding would surface as a user turn.
    expect(launch).toHaveBeenCalledWith(session.id, expect.any(String), "turn",
      expect.objectContaining({ message: "Continue the graph.", messageSource: "system_injection" }));
  });

  it("leaves a legacy history-copying side chat untouched and opens a bounded one", async () => {
    const legacy = agentSessionRuntime.create({ projectId: "project-alpha", profileId: "subagent", parentSessionId: parentId,
      prompt: "Legacy side chat", workDir: root,
      sessionMetadata: { mode: "chat", subagentKind: "side-chat", sideChatReady: true,
        subagentProfile: { version: 1, parentSessionId: parentId, workspaceRoot: root,
          profile: { name: "Side chat", access: "read-only" }, capabilities: ["file.read"] },
        sideChatContext: { kind: "side-chat", sourceSessionId: parentId, sourceRevision: 1,
          sourceCheckpointId: null, access: "read-only", createdAt: new Date().toISOString() } } });
    const result = await openSideChat(parentId);
    expect(result.reused).toBe(false);
    expect(result.session.id).not.toBe(legacy.id);
    expect(result.session.sessionMetadata?.sideChatContext).toMatchObject({ inheritedThrough: expect.any(String) });
    expect((await childProjection()).filter(session => session.parentSessionId === parentId))
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: legacy.id })]));
  });

  it("rejects history anchors and hidden-primary opens", async () => {
    expect(() => sideChatRequestSchema.parse({ sourceRevision: 1 })).toThrow();
    expect(() => sideChatRequestSchema.parse({ access: "inherit" })).toThrow();
    const childParent = await openSideChat(parentId);
    await expect(openSideChat(childParent.session.id)).rejects.toThrow("primary conversation");
  });

  it("keeps legacy root chats accessible and includes child conversations only on request", async () => {
    const legacy = agentSessionRuntime.create({ projectId: "project-alpha", profileId: "synax", prompt: "Legacy side chat", workDir: root,
      sessionMetadata: { sideChat: true, sideChatSourceSessionId: parentId } });
    const response = await agentRuntimeRoutes.request(`/sessions/${parentId}/side-chat`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    expect(response.status).toBe(201);
    const result = await response.json() as { session: { id: string } };
    const roots = await (await agentRuntimeRoutes.request("/sessions?projectId=project-alpha")).json() as { items: Array<{ id: string }> };
    expect(roots.items.map(item => item.id)).toContain(legacy.id);
    expect(roots.items.map(item => item.id)).not.toContain(result.session.id);
    const all = await (await agentRuntimeRoutes.request("/sessions?projectId=project-alpha&includeChildren=true")).json() as { items: Array<{ id: string }> };
    expect(all.items.map(item => item.id)).toContain(result.session.id);
  });
});
