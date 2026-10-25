import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { agentRuntimeRoutes } from "../agent-runtime.js";
import { agentRuntimeStore } from "../../../modules/agent-runtime/session-store.js";
import { agentSessionRuntime } from "../../../modules/agent-runtime/session-runtime.js";
import { runtimeFacade } from "../../../modules/agent-runtime/sidecar/runtime-facade.js";
import { ensureSynaxAgentRegistered } from "../../../modules/agent-runtime/synax/index.js";
import { needsGeneratedSessionTitle } from "../../../modules/agent-runtime/session-title-service.js";
import { admitActiveFixtureRun, resetAgentRuntimeFixtures } from "../../../modules/agent-runtime/__tests__/agent-runtime-fixtures.js";

beforeEach(async () => { await resetAgentRuntimeFixtures(); ensureSynaxAgentRegistered(); });

async function create() {
  const session = agentSessionRuntime.create({ projectId: "project-alpha", profileId: "synax", prompt: "Hello",
    workDir: process.cwd(), sessionMetadata: { source: "session-page", pinned: true, mode: "chat" } });
  await agentRuntimeStore.flushSession(session.id);
  return session;
}
function post(id: string, action: string, body: unknown = {}) {
  return agentRuntimeRoutes.request(`/sessions/${id}/${action}`, {
    method: action === "title" ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}

describe("session management", () => {
  it("forks a running session without stopping it and stops it before permanent deletion", async () => {
    const source = await create();
    const run = await admitActiveFixtureRun(source.id);
    const fork = await post(source.id, "fork", { requestId: "running-fork", workspaceMode: "reuse_worktree" });
    expect(fork.status, await fork.clone().text()).toBe(201);
    expect((await runtimeFacade.sessionSummaryAuthoritative(source.id)).activeRunId).toBe(run.id);
    const response = await post(source.id, "delete-permanently");
    expect(response.status, await response.clone().text()).toBe(200);
    expect(agentRuntimeStore.tryGetSession(source.id)).toBeUndefined();
  });

  it("physically deletes archived batches through the existing archive settings action", async () => {
    const source = await create();
    const archived = await post(source.id, "archive");
    expect(archived.status).toBe(200);
    const response = await agentRuntimeRoutes.request(`/session-archives/${source.id}`, { method: "DELETE" });
    expect(response.status, await response.clone().text()).toBe(200);
    agentRuntimeStore.reset();
    await expect(runtimeFacade.sessionSummaryAuthoritative(source.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("validates names, persists manual titles, and preserves activity time and settings", async () => {
    const source = await create();
    for (const title of ["", "  ", "x".repeat(201), 42]) expect((await post(source.id, "title", { title })).status).toBe(400);
    expect((await post(source.id, "title", { title: "Name", prompt: "replace" })).status).toBe(400);
    const response = await post(source.id, "title", { title: "  new session  " });
    expect(response.status).toBe(200);
    const { session } = await response.json();
    expect(session.title).toBe("new session");
    expect(session.updatedAt).toBe(source.updatedAt);
    expect(session.sessionMetadata).toMatchObject({ pinned: true, titleSource: "user", titleSummarized: true });
    expect(needsGeneratedSessionTitle(agentRuntimeStore.getSession(source.id))).toBe(false);
    expect((await runtimeFacade.sessionSummaryAuthoritative(source.id)).title).toBe("new session");
  });

  it("forks the entire saved history without checkpoints and reuses a request on retry", async () => {
    const source = await create();
    await post(source.id, "title", { title: "用户标题" });
    const messages = Array.from({ length: 75 }, (_, index) => ({ kind: "runtime.message", value: {
      id: `message-${index}`, sessionId: source.id, sequence: index + 1, role: index % 2 ? "assistant" : "user",
      content: `Message ${index}`, runId: null, stepId: null, metadata: {}, createdAt: new Date().toISOString(),
    } }));
    await runtimeFacade.historyCommandGlobal({ scopeId: source.id, requestId: "seed-messages",
      operation: "append_entities", payload: { objects: messages } });
    const assetId = "asset_11111111111111111111111111111111";
    await runtimeFacade.putAssetBlob(assetId, { id: assetId, projectId: source.projectId,
      mediaType: "text/plain", filename: "evidence.txt", size: 17,
      sha256: createHash("sha256").update("Shared attachment").digest("hex"), createdAt: new Date().toISOString() }, Buffer.from("Shared attachment"));
    await runtimeFacade.bindAsset(source.id, assetId);
    const body = { requestId: "full-fork", workspaceMode: "reuse_worktree" };
    const response = await post(source.id, "fork", body);
    expect(response.status, await response.clone().text()).toBe(201);
    const fork = await response.json();
    expect(fork.sessionId).not.toBe(source.id);
    expect(fork.session.title).toBe("用户标题(2)");
    expect(fork.session.parentSessionId).toBeNull();
    expect(fork.session.sessionMetadata.pinned).not.toBe(true);
    expect(fork.session.status).toBe("completed");
    const copied = await runtimeFacade.listMessageHistory(fork.sessionId) as Array<{ id: string; content: string }>;
    expect(copied).toHaveLength(75);
    expect(copied[74].content).toBe("Message 74");
    expect(copied[0].id).not.toBe("message-0");
    expect((await (await post(source.id, "fork", body)).json()).sessionId).toBe(fork.sessionId);
    expect((await post(source.id, "fork", { ...body, workspaceMode: "new_worktree" })).status).toBe(409);
    const deleted = await post(source.id, "delete-permanently");
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    expect((await deleted.json()).deletedSessionIds).toContain(source.id);
    expect(await runtimeFacade.sessionExists(source.id)).toBe(false);
    agentRuntimeStore.reset();
    const missing = await agentRuntimeRoutes.request(`/sessions/${source.id}`);
    expect(missing.status, await missing.text()).toBe(404);
    expect(await runtimeFacade.listMessageHistory(fork.sessionId)).toEqual(copied);
    expect(await runtimeFacade.hasAssetBinding(fork.sessionId, assetId)).toBe(true);
    expect(Buffer.from(await runtimeFacade.readAssetBlob(assetId)).toString()).toBe("Shared attachment");
    expect((await post(source.id, "delete-permanently")).status).toBe(200);
    const deletedFork = await post(fork.sessionId, "delete-permanently");
    expect(deletedFork.status, await deletedFork.clone().text()).toBe(200);
    await expect(runtimeFacade.getAssetMetadata(assetId)).rejects.toThrow();
    await expect(runtimeFacade.readAssetBlob(assetId)).rejects.toThrow();
  });

  it("forks an empty session and permanently removes child conversations", async () => {
    const source = await create();
    const child = agentSessionRuntime.create({ projectId: source.projectId, parentSessionId: source.id,
      profileId: "subagent", prompt: "Child", workDir: process.cwd() });
    await agentRuntimeStore.flush();
    expect((await post(source.id, "fork", { requestId: "empty-fork", workspaceMode: "reuse_worktree" })).status).toBe(201);
    const response = await post(source.id, "delete-permanently");
    expect(response.status, await response.clone().text()).toBe(200);
    expect((await response.json()).deletedSessionIds).toEqual(expect.arrayContaining([source.id, child.id]));
    expect(agentRuntimeStore.tryGetSession(source.id)).toBeUndefined();
    expect(await runtimeFacade.sessionExists(child.id)).toBe(false);
    expect((await (await agentRuntimeRoutes.request("/session-archives")).json()).items).toHaveLength(0);
  });
});
