import http, { type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resetAgentRuntimeFixtures } from "./agent-runtime-fixtures.js";
import { updateGlobalConfig } from "../../../infrastructure/runtime/config/config-store.js";
import { agentSessionRuntime } from "../session-runtime.js";
import { agentRuntimeStore as store } from "../session-store.js";
import { RunCoordinator } from "../run-coordinator.js";
import { runtimeJournal, type RuntimeStreamRecord } from "../runtime-journal.js";
import { countTokens } from "../context-tokenizer.js";

type Protocol = "openai" | "openai-responses" | "anthropic";
let root: string;
let server: http.Server;
let coordinator: RunCoordinator;
let sessionId: string;
let onRequest: (response: ServerResponse) => void;

beforeEach(async () => {
  vi.stubEnv("SYNAX_AGENT_SESSION_IN_PROCESS", "1");
  await resetAgentRuntimeFixtures();
  root = await mkdtemp(path.join(os.tmpdir(), "synax-token-telemetry-"));
  coordinator = new RunCoordinator();
  server = http.createServer(async (request, response) => {
    for await (const _ of request) { /* consume the request before streaming */ }
    onRequest(response);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  sessionId = agentSessionRuntime.create({ projectId: "project-alpha", profileId: "executor", prompt: "Answer", workDir: root }).id;
});

afterEach(async () => {
  await coordinator?.interrupt(sessionId, "Test cleanup");
  await coordinator?.waitForIdle();
  server?.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const first = { text: "Hello 世界", thought: "Think carefully." };
const second = { text: " More output.", thought: " Then verify." };

function wire(protocol: Protocol, response: ServerResponse) {
  const event = (type: string, payload: object) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
  const chat = (delta: object, finish_reason: string | null = null) => response.write(`data: ${JSON.stringify({
    id: "fixture", object: "chat.completion.chunk", model: "fixture", created: 0,
    choices: [{ index: 0, delta, finish_reason }],
  })}\n\n`);
  response.writeHead(200, { "content-type": "text/event-stream" });
  if (protocol === "anthropic") {
    event("message_start", { message: { id: "fixture", role: "assistant", model: "fixture", content: [], usage: { input_tokens: 10, output_tokens: 0 } } });
    event("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } });
    event("content_block_start", { index: 1, content_block: { type: "text", text: "" } });
  } else if (protocol === "openai-responses") {
    event("response.output_item.added", { output_index: 0, item: { id: "rs", type: "reasoning", summary: [] } });
    event("response.output_item.added", { output_index: 1, item: { id: "msg", type: "message", role: "assistant", content: [] } });
  }
  return {
    delta(value: typeof first) {
      if (protocol === "openai") {
        chat({ reasoning_content: value.thought });
        chat({ content: value.text });
      } else if (protocol === "openai-responses") {
        event("response.reasoning_summary_text.delta", { output_index: 0, delta: value.thought });
        event("response.output_text.delta", { output_index: 1, item_id: "msg", content_index: 0, delta: value.text });
      } else {
        event("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: value.thought } });
        event("content_block_delta", { index: 1, delta: { type: "text_delta", text: value.text } });
      }
    },
    finish() {
      if (protocol === "openai") {
        chat({}, "stop");
        response.end("data: [DONE]\n\n");
      } else if (protocol === "openai-responses") {
        event("response.output_item.done", { output_index: 0, item: { id: "rs", type: "reasoning", summary: [{ type: "summary_text", text: first.thought + second.thought }] } });
        event("response.output_item.done", { output_index: 1, item: { id: "msg", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: first.text + second.text, annotations: [] }] } });
        event("response.completed", { response: { usage: { input_tokens: 10, output_tokens: 100, output_tokens_details: { reasoning_tokens: 60 } } } });
        response.end();
      } else {
        event("content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "opaque-signature" } });
        event("content_block_stop", { index: 0 });
        event("content_block_stop", { index: 1 });
        event("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 100 } });
        event("message_stop", {});
        response.end();
      }
    },
  };
}

it.each<Protocol>(["openai", "openai-responses", "anthropic"])("%s carries live counters through Rust, the host and journal snapshots", async protocol => {
  updateGlobalConfig({ defaultApiProviderId: "openai", providerConnections: { openai: {
    providerId: "openai", apiKey: "fixture", baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    extra: { kind: "api", apiFormat: protocol, model: "fixture" },
  } } }, "telemetry-test");
  let upstream: ReturnType<typeof wire> | undefined;
  onRequest = response => {
    upstream = wire(protocol, response);
    upstream.delta(first);
  };
  const accepted = await coordinator.submitAsync(sessionId, { message: "Answer" }, "telemetry-test");
  let snapshot: Awaited<ReturnType<typeof runtimeJournal.snapshotDurable>> | undefined;
  await vi.waitFor(async () => {
    snapshot = await runtimeJournal.snapshotDurable(sessionId);
    expect(snapshot.liveChunks.find(chunk => chunk.type === "message_delta")?.outputTokens).toBe(countTokens(first.text));
    expect(snapshot.liveChunks.find(chunk => chunk.type === "thought_delta")?.thinkingTokens).toBe(countTokens(first.thought));
  }, { timeout: 5000 });
  upstream!.delta(second);
  let records: RuntimeStreamRecord[] = [];
  await vi.waitFor(async () => {
    records = await runtimeJournal.readDurable(sessionId, snapshot!.cursor);
    expect(records.some(({ chunk }) => chunk.type === "message_delta" && chunk.outputTokens === countTokens(first.text + second.text))).toBe(true);
    expect(records.some(({ chunk }) => chunk.type === "thought_delta" && chunk.thinkingTokens === countTokens(first.thought + second.thought))).toBe(true);
  }, { timeout: 5000 });
  const expected = countTokens(first.text + second.text) - countTokens(first.text)
    + countTokens(first.thought + second.thought) - countTokens(first.thought);
  expect(expected).toBeGreaterThan(0);
  upstream!.finish();
  await coordinator.waitForIdle();
  expect(store.getRun(accepted.run.id).status).toBe("completed");
}, 15_000);
