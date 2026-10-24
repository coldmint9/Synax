import http from "node:http";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { updateGlobalConfig } from "../../../infrastructure/runtime/config/config-store.js";
import { agentRuntimeRoutes } from "../../../transport/http/agent-runtime.js";
import { RustNativeBackend } from "../backends/rust-native-backend.js";
import type { AgentRunStreamChunk, AgentRuntimeMessage } from "../contracts.js";
import { RunCoordinator } from "../run-coordinator.js";
import { agentSessionRuntime } from "../session-runtime.js";
import { agentRuntimeStore as store } from "../session-store.js";
import { runtimeFacade } from "../sidecar/runtime-facade.js";
import { resetAgentRuntimeFixtures } from "./agent-runtime-fixtures.js";

const html = '<button onclick="this.textContent=\'Ready\'">Preview</button>';
let root: string;
let sessionId: string;
let reply: string;
let provider: http.Server;
let coordinator: RunCoordinator;
let chunks: AgentRunStreamChunk[];

beforeEach(async () => {
  await resetAgentRuntimeFixtures();
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "synax-preview-regression-")));
  reply = `Before\n\`\`\`synax-visualize\n${html}\n\`\`\`\nAfter`;
  chunks = [];
  const backend = new RustNativeBackend();
  coordinator = new RunCoordinator({
    async *execute(id, mode, input, signal) {
      for await (const chunk of backend.stream(id, mode, input, signal)) {
        chunks.push(chunk);
        yield chunk;
      }
    },
    interrupt: (id, reason) => backend.interrupt(id, reason),
  });
  provider = http.createServer(async (request, response) => {
    for await (const _ of request) { /* drain */ }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const base = { id: "preview-fixture", object: "chat.completion.chunk", model: "fixture" };
    for (const [delta, finish_reason] of [[{ content: reply }, null], [{}, "stop"]]) {
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    }
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  updateGlobalConfig({ defaultApiProviderId: "openai", providerConnections: { openai: {
    providerId: "openai", apiKey: "fixture", baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`,
    extra: { kind: "api", apiFormat: "openai", model: "fixture" },
  } } }, "preview-regression");
  sessionId = agentSessionRuntime.create({ projectId: "project-alpha", profileId: "executor", prompt: "Show preview", workDir: root }).id;
});

afterEach(async () => {
  if (coordinator.isActive(sessionId)) await coordinator.interrupt(sessionId, "Test cleanup");
  await coordinator.waitForIdle();
  provider.closeAllConnections();
  await new Promise<void>(resolve => provider.close(() => resolve()));
  await store.flush();
  await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

it.each(["fragment", "file", "large file"])("persists a native %s preview before completion and restores it after cache eviction", async kind => {
  const file = path.join(root, "preview.html");
  const source = kind === "large file" ? `${html}<!--${"snapshot ".repeat(10_000)}-->` : html;
  if (kind !== "fragment") {
    await writeFile(file, source);
    reply = `Before\nvisualize${JSON.stringify({ path: file, title: "Demo" })}\nAfter`;
  }
  const accepted = await coordinator.submitAsync(sessionId, { message: "Show preview" }, "preview");
  await coordinator.waitForIdle();
  expect(store.getRun(accepted.run.id).status).toBe("completed");
  const completed = chunks.find(chunk => chunk.type === "run_completed");
  expect(completed).toMatchObject({ message: { metadata: {
    source: "inline_visualization", visualization: { html: source },
  } } });
  const message = store.listMessages(sessionId).find(item => item.role === "assistant")!;
  expect(message.metadata.visualization).toMatchObject({ html: source });
  await rm(file, { force: true });
  await store.flushSession(sessionId);
  store.reset();
  const response = await agentRuntimeRoutes.request(`/sessions/${sessionId}/messages/${message.id}/visualization`);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ message: { content: reply, metadata: { visualization: { html: source } } } });
}, 30_000);

it.each(["completed", "failed", "running", "interrupted"] as const)("recovers only a successful historical reply from a cold cache (%s)", async status => {
  const run = store.appendRun({ id: "old-run", sessionId, status,
    startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), triggerMessageId: null,
    currentStep: 1, stopReason: status, model: null, metadata: {} });
  const file = path.join(root, "old-preview.html");
  await writeFile(file, html);
  const content = `Before\nvisualize${JSON.stringify({ path: file })}\nAfter`;
  const message = store.appendMessage({ id: "old-message", sessionId, runId: run.id, stepId: null,
    role: "assistant", content, metadata: { engine: "rust" }, createdAt: new Date().toISOString() });
  store.updateSession(sessionId, { status: "completed" });
  await store.flushSession(sessionId);
  store.reset();
  const fullHistory = vi.spyOn(runtimeFacade, "listMessageHistory");
  const response = await agentRuntimeRoutes.request(`/sessions/${sessionId}/messages/${message.id}/visualization`);
  const result = await response.json() as { message: AgentRuntimeMessage | null };
  expect(response.status, JSON.stringify(result)).toBe(200);
  if (status === "completed") {
    expect(result.message?.metadata.visualization).toMatchObject({ html });
    await rm(file);
    store.reset();
    const again = await agentRuntimeRoutes.request(`/sessions/${sessionId}/messages/${message.id}/visualization`);
    expect(await again.json()).toMatchObject({ message: { metadata: { visualization: { html } } } });
  } else expect(result.message).toBeNull();
  expect(fullHistory).not.toHaveBeenCalled();
}, 30_000);
