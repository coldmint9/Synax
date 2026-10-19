import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import * as z from "zod/v4";

const root = await mkdtemp(path.join(tmpdir(), "synax-rust-agent-loop-"));
let providerCalls = 0;
const requestBodies: Record<string, unknown>[] = [];
const provider = http.createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => { body += String(chunk); });
  request.on("end", () => {
    providerCalls += 1;
    requestBodies.push(JSON.parse(body));
    const afterTool = body.includes('"role":"tool"');
    response.writeHead(200, { "content-type": "text/event-stream" });
    const base = { id: "rust-agent-loop-smoke", object: "chat.completion.chunk", created: 0, model: "fixture" };
    if (!afterTool) {
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: "Preparing both echo calls." }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "smoke-call", type: "function", function: { name: "rust-smoke.echo", arguments: '{"value":"ok"}' } }] }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: "smoke-call-2", type: "function", function: { name: "rust-smoke.echo", arguments: '{"value":"second"}' } }] }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`);
    } else {
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: "Rust loop completed after the tool." }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
    }
    response.end("data: [DONE]\n\n");
  });
});
const listen = promisify(provider.listen.bind(provider)) as (port: number, host: string) => Promise<void>;
const close = promisify(provider.close.bind(provider));
let supervisor: { start(): Promise<void>; stop(): Promise<void> } | undefined;
try {
  await writeFile(path.join(root, "projects.json"), JSON.stringify({ items: [{ id: "rust-loop", source: { localPath: root } }] }));
  await listen(0, "127.0.0.1");
  const port = (provider.address() as { port: number }).port;
  Object.assign(process.env, {
    DATA_ROOT: root,
    NODE_ENV: "test",
    SYNAX_AGENT_LOOP_ENGINE: "rust",
    SYNAX_AGENT_SESSION_IN_PROCESS: "1",
    SYNAX_RUNTIME_SIDECAR_STREAM: "authoritative",
  });
  const { RustRuntimeSupervisor } = await import("../services/local-node/infrastructure/runtime/rust-sidecar.js");
  supervisor = new RustRuntimeSupervisor({ dataRoot: root });
  await supervisor.start();
  const { updateGlobalConfig } = await import("../services/local-node/infrastructure/runtime/config/config-store.js");
  updateGlobalConfig({
    defaultApiProviderId: "openai",
    providerConnections: { openai: { providerId: "openai", apiKey: "local", baseUrl: `http://127.0.0.1:${port}/v1`, extra: { kind: "api", apiFormat: "openai", model: "fixture" } } },
  }, "rust-agent-loop-smoke");
  const { toolRegistry } = await import("../services/local-node/modules/agent-runtime/tool-registry.js");
  toolRegistry.register({
    id: "rust-smoke.echo", label: "Rust smoke echo", description: "Echo a value.", category: "read", mutability: "read", resumeBehavior: "auto",
    inputSchema: z.object({ value: z.string() }),
    execute: (input) => ({ result: { echoed: (input.args as { value: string }).value }, displaySummary: "Echoed", artifacts: [] }),
  });
  const { agentSessionRuntime } = await import("../services/local-node/modules/agent-runtime/session-runtime.js");
  const { agentRuntimeStore } = await import("../services/local-node/modules/agent-runtime/session-store.js");
  const { RunCoordinator } = await import("../services/local-node/modules/agent-runtime/run-coordinator.js");
  const { ensureSynaxAgentRegistered, ensureLegacyGoalProfileRegistered } = await import("../services/local-node/modules/agent-runtime/synax/index.js");
  ensureSynaxAgentRegistered(); ensureLegacyGoalProfileRegistered();
  const session = agentSessionRuntime.create({ projectId: "rust-loop", profileId: "synax", prompt: "Use the echo tool then answer.", workDir: root });
  const coordinator = new RunCoordinator();
  const accepted = await coordinator.submitAsync(session.id, { message: "Call echo and finish." }, "rust-agent-loop-smoke");
  await coordinator.waitForIdle();
  const run = agentRuntimeStore.getRun(accepted.run.id);
  const messages = agentRuntimeStore.listMessages(session.id);
  assert.equal(run.status, "completed");
  assert.equal(providerCalls, 2);
  assert.deepEqual(agentRuntimeStore.listRunSteps(run.id).map(step => step.index).sort(), [1, 2]);
  assert.equal(agentRuntimeStore.listToolCalls(session.id).filter(call => call.status === "completed").length, 2);
  assert(messages.some(message => message.role === "assistant" && message.content === "Preparing both echo calls."));
  assert(JSON.stringify(requestBodies[1]).includes('second'));
  assert(JSON.stringify(requestBodies[1]).includes('Preparing both echo calls.'));
  assert(messages.some((message) => message.role === "assistant" && message.content.includes("Rust loop completed")));
  toolRegistry.unregister("rust-smoke.echo");
  console.log("Rust agent loop smoke passed: Rust multi-step controller → Node tool execution → Rust continuation → terminal run.");
} finally {
  await supervisor?.stop().catch(() => {});
  await close().catch(() => {});
  await rm(root, { recursive: true, force: true });
}
