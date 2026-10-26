import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { updateGlobalConfig } from "../../../infrastructure/runtime/config/config-store.js";
import { DATA_ROOT } from "../../../infrastructure/runtime/env.js";
import { RunCoordinator } from "../run-coordinator.js";
import { agentSessionRuntime } from "../session-runtime.js";
import { agentRuntimeStore as store } from "../session-store.js";
import { ensureSynaxAgentRegistered } from "../synax/index.js";
import { resetAgentRuntimeFixtures } from "./agent-runtime-fixtures.js";

let root: string;
let provider: http.Server;
let coordinator: RunCoordinator;
let sessionId: string;
let receivedResults: string[];
let calls: number;

beforeEach(async () => {
  vi.stubEnv("DATA_ROOT", DATA_ROOT);
  await resetAgentRuntimeFixtures();
  ensureSynaxAgentRegistered();
  root = await mkdtemp(path.join(os.tmpdir(), "synax-tool-timeout-"));
  coordinator = new RunCoordinator();
  receivedResults = [];
  calls = 0;
  provider = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const { messages } = JSON.parse(body) as { messages: Array<{ role: string; content: unknown }> };
    const results = messages.filter(message => message.role === "tool");
    receivedResults = results.map(message => String(message.content));
    response.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta: object, finish_reason: string | null = null) => response.write(`data: ${JSON.stringify({
      id: "fixture", object: "chat.completion.chunk", model: "fixture", created: 0,
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`);
    if (results.length < 2) {
      calls++;
      chunk({ tool_calls: [{ index: 0, id: `timeout-${results.length}`, type: "function", function: {
        name: "bash", arguments: JSON.stringify({ command: `trap '' TERM; echo partial-${results.length}; sleep 10`, timeoutMs: 1000 }),
      } }] });
      chunk({}, "tool_calls");
    } else {
      chunk({ content: "Continued after both timeouts." });
      chunk({}, "stop");
    }
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  updateGlobalConfig({ defaultApiProviderId: "openai", providerConnections: { openai: {
    providerId: "openai", apiKey: "fixture", baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`,
    extra: { kind: "api", apiFormat: "openai", model: "fixture" },
  } } }, "tool-timeout-test");
  sessionId = agentSessionRuntime.create({ projectId: "project-alpha", profileId: "synax", prompt: "Inspect slow commands",
    workDir: root, permissionTier: "unrestricted", sessionMetadata: { mode: "chat" } }).id;
});

afterEach(async () => {
  if (sessionId) await coordinator?.interrupt(sessionId, "Test cleanup");
  await coordinator?.waitForIdle();
  provider?.closeAllConnections();
  if (provider) await new Promise<void>(resolve => provider.close(() => resolve()));
  if (root) await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

it.each(["1", "0"])("returns both timeout receipts to the model and completes the same run (in process: %s)", async inProcess => {
  vi.stubEnv("SYNAX_AGENT_SESSION_IN_PROCESS", inProcess);
  const accepted = await coordinator.submitAsync(sessionId, { message: "Inspect slow commands" }, "two-timeouts");
  await coordinator.waitForIdle();
  await store.hydrateSession(sessionId, true);
  expect(store.getRun(accepted.run.id).status).toBe("completed");
  expect(store.getSession(sessionId)).toMatchObject({ activeRunId: null, resultSummary: "Continued after both timeouts." });
  expect(calls).toBe(2);
  expect(store.listRuns(sessionId)).toHaveLength(1);
  expect(store.listToolCalls(sessionId)).toHaveLength(2);
  expect(receivedResults).toHaveLength(2);
  receivedResults.forEach((result, index) => {
    expect(result).toContain(`partial-${index}`);
    expect(result).toContain("[TIMED OUT after 1s");
  });
}, 60_000);
