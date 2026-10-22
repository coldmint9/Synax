import http from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { updateGlobalConfig } from "../../../infrastructure/runtime/config/config-store.js";
import { DATA_ROOT } from "../../../infrastructure/runtime/env.js";
import { RunCoordinator, runCoordinator } from "../run-coordinator.js";
import { agentSessionRuntime } from "../session-runtime.js";
import { agentRuntimeStore as store } from "../session-store.js";
import { ensureSynaxAgentRegistered } from "../synax/index.js";
import { resetAgentRuntimeFixtures } from "./agent-runtime-fixtures.js";
import { subagentTemplates } from "../subagent-templates.js";
import { businessStore } from "../../../infrastructure/persistence/business-store.js";

let root: string;
let provider: http.Server;
let coordinator: RunCoordinator;
let sessionId: string;
let childRequests: number;
let parentResults: string[];
let scenario: "complete" | "fail" | "hang";

beforeEach(async () => {
  vi.stubEnv("SYNAX_AGENT_SESSION_IN_PROCESS", "1");
  vi.stubEnv("DATA_ROOT", DATA_ROOT);
  await resetAgentRuntimeFixtures();
  ensureSynaxAgentRegistered();
  root = await mkdtemp(path.join(os.tmpdir(), "synax-delegation-"));
  coordinator = new RunCoordinator();
  childRequests = 0;
  parentResults = [];
  scenario = "complete";
  provider = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const { messages } = JSON.parse(body) as { messages: Array<{ role: string; content: unknown }> };
    const child = messages.some(message => message.role === "user" && JSON.stringify(message.content).includes("CHILD_WRITE_TASK"));
    const results = messages.filter(message => message.role === "tool");
    if (child) childRequests++;
    else parentResults.push(...results.map(message => String(message.content)));
    if (child && scenario === "fail") {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "CHILD_PROVIDER_FAILED", type: "invalid_request_error" } }));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (child && scenario === "hang") { response.flushHeaders(); return; }
    const chunk = (delta: object, finish_reason: string | null = null) => response.write(`data: ${JSON.stringify({
      id: "fixture", object: "chat.completion.chunk", model: "fixture", created: 0,
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`);
    const call = (name: string, args: unknown) => {
      chunk({ tool_calls: [{ index: 0, id: `${child ? "child" : "parent"}-${results.length}`, type: "function",
        function: { name, arguments: JSON.stringify(args) } }] });
      chunk({}, "tool_calls");
    };
    if (child && results.length === 0) call("file_write", { path: "child.txt", content: "CHILD_ARTIFACT" });
    else if (!child && results.length === 0) call("subagent_delegate", {
      name: "阿墨", prompt: "CHILD_WRITE_TASK: create child.txt and report completion.",
      profile: { name: "阿墨", description: "File implementer", instructions: "Create the assigned file.",
        capabilities: ["file.write"], skillIds: [], writeScope: ["child.txt"] },
    });
    else if (!child && results.length === 1) call("bash", { command: scenario === "fail" ? "printf PARENT_CONTINUED" : "cat child.txt" });
    else {
      chunk({ content: child ? "CHILD_FINISHED" : "Parent verified the child artifact." });
      chunk({}, "stop");
    }
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  updateGlobalConfig({ defaultApiProviderId: "openai", providerConnections: { openai: {
    providerId: "openai", apiKey: "fixture", baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`,
    extra: { kind: "api", apiFormat: "openai", model: "fixture" },
  } } }, "subagent-delegation-test");
  sessionId = agentSessionRuntime.create({ projectId: "project-alpha", profileId: "synax", prompt: "Delegate and verify",
    workDir: root, permissionTier: "unrestricted", sessionMetadata: { mode: "chat" } }).id;
});

afterEach(async () => {
  if (sessionId) {
    await coordinator?.interrupt(sessionId, "Test cleanup");
    for (const id of store.getSession(sessionId).childSessionIds) await runCoordinator.interrupt(id, "Test cleanup");
  }
  await coordinator?.waitForIdle();
  await runCoordinator.waitForIdle();
  provider?.closeAllConnections();
  if (provider) await new Promise<void>(resolve => provider.close(() => resolve()));
  if (root) await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each(["1", "0"])("executes a delegated writer and lets the parent verify in the same turn (in process: %s)", async (inProcess) => {
  vi.stubEnv("SYNAX_AGENT_SESSION_IN_PROCESS", inProcess);
  const accepted = await coordinator.submitAsync(sessionId, { message: "Delegate and verify" }, "delegate-writer");
  await coordinator.waitForIdle();
  expect(store.getRun(accepted.run.id).status).toBe("completed");
  expect(childRequests).toBe(2);
  const [childId] = store.getSession(sessionId).childSessionIds;
  await store.hydrateSession(childId, true);
  expect(store.getSession(childId)).toMatchObject({ status: "completed", activeRunId: null, resultSummary: "CHILD_FINISHED" });
  expect(await readFile(path.join(root, "child.txt"), "utf8")).toBe("CHILD_ARTIFACT");
  expect(parentResults.some(result => result.includes("CHILD_FINISHED"))).toBe(true);
  expect(store.listToolCalls(sessionId)).toEqual(expect.arrayContaining([
    expect.objectContaining({ toolId: "subagent.delegate", status: "completed" }),
    expect.objectContaining({ toolId: "bash", status: "completed", outputRef: expect.objectContaining({ stdout: "CHILD_ARTIFACT", exitCode: 0 }) }),
  ]));
  expect(store.listRuns(childId)).toHaveLength(1);
}, 60_000);

it("reports a failed child and releases its write slot before the parent continues", async () => {
  scenario = "fail";
  const accepted = await coordinator.submitAsync(sessionId, { message: "Delegate and verify" }, "delegate-failure");
  await coordinator.waitForIdle();
  expect(store.getRun(accepted.run.id).status).toBe("completed");
  const [childId] = store.getSession(sessionId).childSessionIds;
  expect(store.getSession(childId)).toMatchObject({ status: "failed", activeRunId: null });
  expect(store.listToolCalls(sessionId)).toEqual(expect.arrayContaining([
    expect.objectContaining({ toolId: "subagent.delegate", status: "failed", outputRef: expect.objectContaining({ status: "failed" }) }),
    expect.objectContaining({ toolId: "bash", status: "completed", outputRef: expect.objectContaining({ stdout: "PARENT_CONTINUED" }) }),
  ]));
}, 30_000);

it("applies the user-selected custom profile through the actual Rust delegation path", async () => {
  const template = subagentTemplates.save({ name: "Custom writer", description: "Create an artifact", instructions: "CUSTOM_PROFILE_INSTRUCTIONS",
    access: "inherit", writeScope: ["child.txt"], capabilities: ["file.write"] });
  await businessStore.flush();
  const accepted = await coordinator.submitAsync(sessionId, { message: "Delegate and verify", references: [{ kind: "subagent", id: template.id }] }, "selected-profile");
  await coordinator.waitForIdle();
  expect(store.getRun(accepted.run.id).status).toBe("completed");
  const [childId] = store.getSession(sessionId).childSessionIds;
  expect(store.getSession(childId).sessionMetadata?.subagentProfile).toMatchObject({ templateId: template.id,
    profile: { instructions: expect.stringContaining("CUSTOM_PROFILE_INSTRUCTIONS"), writeScope: ["child.txt"] } });
  expect(await readFile(path.join(root, "child.txt"), "utf8")).toBe("CHILD_ARTIFACT");
}, 30_000);

it("stops a delegated child when the parent is interrupted without requiring another user turn", async () => {
  scenario = "hang";
  await coordinator.submitAsync(sessionId, { message: "Delegate and verify" }, "delegate-interruption");
  await vi.waitFor(() => expect(childRequests).toBe(1), { timeout: 15_000 });
  const [childId] = store.getSession(sessionId).childSessionIds;
  expect(store.getSession(childId).activeRunId).toBeTruthy();
  await coordinator.interrupt(sessionId, "Stop delegated work");
  await coordinator.waitForIdle();
  expect(runCoordinator.isActive(childId)).toBe(false);
  expect(store.getSession(childId).activeRunId).toBeNull();
  expect(["paused", "interrupted", "cancelled", "failed"]).toContain(store.getSession(childId).status);
  expect(store.listToolCalls(sessionId).some(call => call.toolId === "bash")).toBe(false);
}, 30_000);
