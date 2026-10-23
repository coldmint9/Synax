import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { updateGlobalConfig } from "../../../infrastructure/runtime/config/config-store.js";
import { agentRuntimeRoutes } from "../../../transport/http/agent-runtime.js";
import { RunCoordinator } from "../run-coordinator.js";
import { agentSessionRuntime } from "../session-runtime.js";
import { agentRuntimeStore } from "../session-store.js";
import { runtimeFacade } from "../sidecar/runtime-facade.js";
import { resetAgentRuntimeFixtures } from "./agent-runtime-fixtures.js";

let root: string;
let provider: http.Server;
let coordinator: RunCoordinator;
let sessionId: string;

beforeEach(async () => {
  vi.stubEnv("SYNAX_AGENT_SESSION_IN_PROCESS", "1");
  await resetAgentRuntimeFixtures();
  root = await mkdtemp(path.join(os.tmpdir(), "synax-history-checkpoints-"));
  coordinator = new RunCoordinator();
  let round = 0;
  provider = http.createServer(async (request, response) => {
    for await (const _ of request) { /* drain the request */ }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture",
      choices: [{ index: 0, delta: { content: `Reply ${++round}` }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  updateGlobalConfig({ defaultApiProviderId: "openai", providerConnections: { openai: {
    providerId: "openai", apiKey: "fixture", baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`,
    extra: { kind: "api", apiFormat: "openai", model: "fixture" },
  } } }, "history-checkpoint-test");
  sessionId = agentSessionRuntime.create({ projectId: "project-alpha", profileId: "executor", prompt: "Answer", workDir: root }).id;
});

afterEach(async () => {
  await coordinator?.interrupt(sessionId, "Test cleanup");
  await coordinator?.waitForIdle();
  provider?.closeAllConnections();
  await new Promise<void>(resolve => provider.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

it("forks the complete conversation once through Rust even from an earlier checkpoint", async () => {
  await coordinator.submitAsync(sessionId, { message: "First question" }, "fork-first");
  await coordinator.waitForIdle();
  const [checkpoint] = await runtimeFacade.listHistoryCheckpoints(sessionId);
  await coordinator.submitAsync(sessionId, { message: "Second question" }, "fork-second");
  await coordinator.waitForIdle();
  const source = await runtimeFacade.listMessageHistory(sessionId) as Array<{ id: string; content: string }>;
  const revision = (await runtimeFacade.historyHeadAuthoritative(sessionId)).revision;
  const payload = { checkpointId: checkpoint.id, revision, requestId: "complete-fork-request", includeFiles: false, workspaceMode: "reuse_worktree" };
  const send = () => agentRuntimeRoutes.request(`/sessions/${sessionId}/history/fork`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
  });
  const historyCommand = runtimeFacade.historyCommand.bind(runtimeFacade);
  let lostAcknowledgement = false;
  const lostReply = vi.spyOn(runtimeFacade, "historyCommand").mockImplementation(async input => {
    const result = await historyCommand(input);
    if (input.operation === "fork_copy" && !lostAcknowledgement) {
      lostAcknowledgement = true;
      throw new Error("Simulated lost fork acknowledgement after commit");
    }
    return result;
  });
  const [response, concurrent] = await Promise.all([send(), send()]);
  lostReply.mockRestore();
  expect(lostAcknowledgement).toBe(true);
  const result = await response.json();
  expect(response.status, JSON.stringify(result)).toBe(201);
  const targetId = result.sessionId;
  expect(concurrent.status).toBe(201);
  expect((await concurrent.json()).sessionId).toBe(targetId);
  const copied = await runtimeFacade.listMessageHistory(targetId) as Array<{ id: string; content: string; sessionId: string }>;
  expect(copied.map(message => message.content)).toEqual(source.map(message => message.content));
  expect(copied).toHaveLength(4);
  expect(copied.every(message => message.sessionId === targetId)).toBe(true);
  expect(copied.every(message => !source.some(original => original.id === message.id))).toBe(true);
  const retry = await send();
  expect(retry.status).toBe(201);
  expect((await retry.json()).sessionId).toBe(targetId);
  await runtimeFacade.sessionPatch(targetId, "simulate-lost-fork-header", { sessionMetadata: {
    forkPreparing: true, forkCopyComplete: false, forkHostId: "previous-process", forkRequestId: payload.requestId,
  } });
  const { recoverRuntimeSession } = await import("../runtime-recovery.js");
  await recoverRuntimeSession("replacement-process", targetId);
  expect((await runtimeFacade.sessionSummaryAuthoritative(targetId)).sessionMetadata?.forkCopyComplete).toBe(true);
  await agentRuntimeStore.hydrateSession(targetId, true);
  const continued = await coordinator.submitAsync(targetId, { message: "Continue the fork" }, "fork-continue");
  await coordinator.waitForIdle();
  expect(agentRuntimeStore.getRun(continued.run.id).status).toBe("completed");
  expect(await runtimeFacade.listMessageHistory(sessionId)).toEqual(source);
  expect(await runtimeFacade.listMessageHistory(targetId)).toHaveLength(6);
}, 40_000);

it("saves Rust reply boundaries and restores the first reply after a later round", async () => {
  const first = await coordinator.submitAsync(sessionId, { message: "First question" }, "first");
  await coordinator.waitForIdle();
  expect(agentRuntimeStore.getRun(first.run.id).status).toBe("completed");
  const [checkpoint] = await runtimeFacade.listHistoryCheckpoints(sessionId);
  expect(checkpoint).toMatchObject({ metadata: { kind: "reply", sessionId } });
  const firstMessages = await runtimeFacade.listMessageHistory(sessionId);

  const second = await coordinator.submitAsync(sessionId, { message: "Second question" }, "second");
  await coordinator.waitForIdle();
  expect(agentRuntimeStore.getRun(second.run.id).status).toBe("completed");
  const response = await agentRuntimeRoutes.request(`/sessions/${sessionId}/checkpoints`);
  expect(response.status).toBe(200);
  const summary = await response.json();
  expect(summary.rollbackEnabled).toBe(true);
  expect(summary.checkpoints).toHaveLength(2);
  expect(summary.checkpoints.find((item: { id: string }) => item.id === checkpoint.id))
    .toMatchObject({ available: true, hasLaterHistory: true });

  const preview = await runtimeFacade.previewHistoryAuthoritative(sessionId, checkpoint.id, false);
  expect(preview).toMatchObject({ canApply: true, removedMessages: 2 });
  await runtimeFacade.applyHistoryAuthoritative({ sessionId, checkpointId: checkpoint.id,
    revision: preview.revision, requestId: "restore-first", action: "rollback", includeFiles: false });
  expect(await runtimeFacade.listMessageHistory(sessionId)).toEqual(firstMessages);

  // Hydration reconciles retained stream events. Removed messages must stay
  // removed both on refresh and after the next turn.
  await agentRuntimeStore.hydrateSession(sessionId, true);
  expect(await runtimeFacade.listMessageHistory(sessionId)).toEqual(firstMessages);
  const third = await coordinator.submitAsync(sessionId, { message: "Replacement question" }, "third");
  await coordinator.waitForIdle();
  expect(agentRuntimeStore.getRun(third.run.id).status).toBe("completed");
  const messages = await runtimeFacade.listMessageHistory(sessionId) as Array<{ content: string }>;
  expect(messages.map(message => message.content)).toEqual(["First question", "Reply 1", "Replacement question", "Reply 3"]);
  const checkpoints = await runtimeFacade.listHistoryCheckpoints(sessionId);
  const latest = agentRuntimeStore.listMessages(sessionId).find(message => message.content === "Reply 3")!;
  expect(checkpoints).toContainEqual(expect.objectContaining({ metadata: expect.objectContaining({ messageId: latest.id }) }));
}, 30_000);

it("edits a user message without input checkpoints, removes later execution, and resends once", async () => {
  await coordinator.submitAsync(sessionId, { message: "First question" }, "first");
  await coordinator.waitForIdle();
  const firstMessages = await runtimeFacade.listMessageHistory(sessionId);
  await coordinator.submitAsync(sessionId, { message: "Second question" }, "second");
  await coordinator.waitForIdle();
  const messages = await runtimeFacade.listMessageHistory(sessionId) as Array<{id:string;content:string}>;
  const target = messages.find(message=>message.content === "Second question")!;
  // No persisted checkpoints of any kind are needed for an edit.
  for (const checkpoint of await runtimeFacade.listHistoryCheckpoints(sessionId))
    await runtimeFacade.historyCommand({sessionId,requestId:`unpin:${checkpoint.id}`,operation:'unpin',payload:{pinId:checkpoint.id}});
  const edit = {sessionId,messageId:target.id,message:'Replacement question',requestId:'edit-second'};
  const edited = await runtimeFacade.editMessageAuthoritative(edit);
  expect(edited.input.message).toBe('Replacement question');
  expect(await runtimeFacade.listMessageHistory(sessionId)).toEqual(firstMessages);
  expect(await runtimeFacade.listHistoryObjects(sessionId,'list_runs')).toHaveLength(1);
  await agentRuntimeStore.hydrateSession(sessionId,true);
  expect(await runtimeFacade.listMessageHistory(sessionId)).toEqual(firstMessages);
  const replacement = await coordinator.submitAsync(sessionId,edited.input,'resend');
  await coordinator.waitForIdle();
  expect(agentRuntimeStore.getRun(replacement.run.id).status).toBe('completed');
  expect((await runtimeFacade.listMessageHistory(sessionId) as Array<{content:string}>).map(item=>item.content))
    .toEqual(['First question','Reply 1','Replacement question','Reply 3']);
  const retry = await runtimeFacade.editMessageAuthoritative(edit);
  expect(retry.input).toEqual(edited.input);
  expect(await runtimeFacade.listMessageHistory(sessionId)).toHaveLength(4);
  await expect(runtimeFacade.editMessageAuthoritative({...edit,message:'Different'})).rejects.toMatchObject({code:'REQUEST_CONFLICT'});
},30_000);

it("edits the first user message and keeps workspace files", async () => {
  await coordinator.submitAsync(sessionId,{message:'First question'},'first');
  await coordinator.waitForIdle();
  const [original] = await runtimeFacade.listMessageHistory(sessionId) as Array<import('../contracts.js').AgentRuntimeMessage>;
  const {writeFile,readFile}=await import('node:fs/promises');
  const file=path.join(root,'keep.txt');
  await writeFile(file,'User work');
  const edited=await runtimeFacade.editMessageAuthoritative({sessionId,messageId:original.id,message:'New first question',requestId:'edit-first'});
  expect(edited.input.message).toBe('New first question');
  expect(await runtimeFacade.listMessageHistory(sessionId)).toEqual([]);
  expect(await readFile(file,'utf8')).toBe('User work');
  await agentRuntimeStore.hydrateSession(sessionId,true);
  expect(await runtimeFacade.listMessageHistory(sessionId)).toEqual([]);
  const session=await runtimeFacade.sessionSummaryAuthoritative(sessionId);
  expect(session.contextSnapshotId).toBeNull();
  expect(session.sessionMetadata?.nativeBackend).toBeNull();
},30_000);
