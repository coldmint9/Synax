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
