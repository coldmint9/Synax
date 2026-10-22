import http from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { updateGlobalConfig } from "../../../infrastructure/runtime/config/config-store.js";
import { RunCoordinator } from "../run-coordinator.js";
import { agentSessionRuntime } from "../session-runtime.js";
import { agentRuntimeStore as store } from "../session-store.js";
import { resetAgentRuntimeFixtures } from "./agent-runtime-fixtures.js";
import { toolRegistry } from "../tool-registry.js";
import { logger } from "../../../infrastructure/runtime/logger.js";
import { AgentNotFoundError } from "../runtime-errors.js";

let root: string;
let provider: http.Server;
let coordinator: RunCoordinator;
let sessionId: string;
let requestedTool: string;
let requests: Array<{
  messages?: Array<{ role: string; content: string; tool_call_id?: string }>;
  input?: Array<{ type: string; output?: string; call_id?: string }>;
}>;

beforeEach(async () => {
  vi.stubEnv("SYNAX_AGENT_LOOP_ENGINE", "rust");
  vi.stubEnv("SYNAX_AGENT_SESSION_IN_PROCESS", "1");
  await resetAgentRuntimeFixtures();
  root = await mkdtemp(path.join(os.tmpdir(), "synax-tool-resolution-"));
  await writeFile(path.join(root, "fixture.txt"), "RECOVERED_FILE_CONTENT");
  requests = [];
  coordinator = new RunCoordinator();
  provider = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (request.url?.endsWith("/responses")) {
      const event = (type: string, payload: object) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
      if (requests.length <= 2) {
        const call = { type: "function_call", id: `fc_${requests.length}`, call_id: `provider-call-${requests.length}`,
          name: requests.length === 1 ? requestedTool : "file_read" };
        const args = JSON.stringify(requests.length === 1 ? { file: "fixture.txt" } : { path: "fixture.txt" });
        event("response.output_item.added", { output_index: 0, item: call });
        event("response.function_call_arguments.delta", { output_index: 0, item_id: call.id, delta: args });
        event("response.output_item.done", { output_index: 0, item: { ...call, arguments: args, status: "completed" } });
      } else {
        const message = { id: "msg_fixture", type: "message", role: "assistant" };
        event("response.output_item.added", { output_index: 0, item: { ...message, content: [] } });
        event("response.output_text.delta", { output_index: 0, item_id: message.id, content_index: 0, delta: "Recovered and read the file." });
        event("response.output_item.done", { output_index: 0, item: { ...message, status: "completed",
          content: [{ type: "output_text", text: "Recovered and read the file.", annotations: [] }] } });
      }
      event("response.completed", { response: { usage: { input_tokens: 2, output_tokens: 3 } } });
      response.end();
      return;
    }
    const chunk = (delta: object, finish_reason: string | null = null) => response.write(`data: ${JSON.stringify({
      id: "fixture", object: "chat.completion.chunk", model: "fixture", created: 0,
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`);
    if (requests.length <= 2) {
      chunk({ tool_calls: [{ index: 0, id: `provider-call-${requests.length}`, type: "function", function: {
        name: requests.length === 1 ? requestedTool : "file_read",
        arguments: JSON.stringify(requests.length === 1 ? { file: "fixture.txt" } : { path: "fixture.txt" }),
      } }] });
      chunk({}, "tool_calls");
    } else {
      chunk({ content: "Recovered and read the file." });
      chunk({}, "stop");
    }
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  updateGlobalConfig({ defaultApiProviderId: "openai", providerConnections: {
    openai: { providerId: "openai", apiKey: "fixture", baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`,
      extra: { kind: "api", apiFormat: "openai", model: "fixture" } },
  } }, "tool-resolution-test");
  sessionId = agentSessionRuntime.create({ projectId: "project-alpha", profileId: "executor",
    prompt: "Read the fixture", workDir: root, permissionTier: "unrestricted" }).id;
});

afterEach(async () => {
  if (sessionId) await coordinator?.interrupt(sessionId, "Test cleanup");
  await coordinator?.waitForIdle();
  provider?.closeAllConnections();
  if (provider) await new Promise<void>(resolve => provider.close(() => resolve()));
  if (root) await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each([
  { name: "read", apiFormat: "openai" },
  { name: "file_glob", apiFormat: "openai" },
  { name: "mcp_disconnected_read", apiFormat: "openai" },
  { name: "read", apiFormat: "openai-responses" },
] as const)(
  "returns $name failure through $apiFormat and completes the same run after a corrected tool call",
  async ({ name, apiFormat }) => {
    requestedTool = name;
    if (apiFormat === "openai-responses") updateGlobalConfig({ providerConnections: {
      openai: { providerId: "openai", apiKey: "fixture", baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`,
        extra: { kind: "api", apiFormat, model: "fixture" } },
    } }, "tool-resolution-responses-test");
    const accepted = await coordinator.submitAsync(sessionId, { message: "Read fixture.txt" }, "recover-unknown-tool");
    await coordinator.waitForIdle();
    const run = store.getRun(accepted.run.id);
    expect(run.status, run.stopReason ?? "").toBe("completed");
    expect(requests).toHaveLength(3);
    for (const [index, content] of [[1, "TOOL_NOT_FOUND"], [2, "RECOVERED_FILE_CONTENT"]] as const) {
      expect(requests[index].messages ?? requests[index].input).toContainEqual(expect.objectContaining(
        apiFormat === "openai" ? {
          role: "tool", tool_call_id: `provider-call-${index}`, content: expect.stringContaining(content),
        } : {
          type: "function_call_output", call_id: `provider-call-${index}`, output: expect.stringContaining(content),
        },
      ));
    }
    const calls = store.listToolCalls(sessionId);
    expect(calls).toHaveLength(2);
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ toolId: name, status: "failed", modelToolCallId: "provider-call-1" }),
      expect.objectContaining({ toolId: "file.read", status: "completed", modelToolCallId: "provider-call-2" }),
    ]));
    expect(store.getSession(sessionId).blockedReason).toBeNull();
  }, 20_000,
);

it("logs a genuine missing runtime resource with run identity and preserves the failure", async () => {
  requestedTool = "file_read";
  const error = new AgentNotFoundError("run_missing_fixture");
  vi.spyOn(toolRegistry, "execute").mockRejectedValueOnce(error);
  const log = vi.spyOn(logger, "error");
  const accepted = await coordinator.submitAsync(sessionId, { message: "Read fixture.txt" }, "missing-runtime-resource");
  await coordinator.waitForIdle();
  expect(store.getRun(accepted.run.id)).toMatchObject({ status: "failed", stopReason: error.message });
  expect(log).toHaveBeenCalledWith(expect.objectContaining({
    sessionId, runId: accepted.run.id, stepId: expect.any(String), code: "NOT_FOUND", err: error,
  }), "[agent-runtime] native run failed");
  expect(requests).toHaveLength(1);
}, 20_000);
