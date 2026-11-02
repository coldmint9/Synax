import http from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resetAgentRuntimeFixtures } from "./agent-runtime-fixtures.js";
import { updateGlobalConfig } from "../../../infrastructure/runtime/config/config-store.js";
import { agentSessionRuntime } from "../session-runtime.js";
import { agentRuntimeStore as store } from "../session-store.js";
import { ensureSynaxAgentRegistered } from "../synax/index.js";
import { RunCoordinator } from "../run-coordinator.js";
import { permissionPolicy } from "../permission-policy.js";
import { skillRegistry } from "../../skills/skill-registry.js";

type Scenario = "selected" | "preview" | "invalid-preview" | "forbidden" | "execute-plan";
let scenario: Scenario;
let root: string;
let provider: http.Server;
let coordinator: RunCoordinator;
let sessionId: string;
let requests: Array<{ messages: Array<{ role: string; content?: unknown }>; tools: Array<{ function: { name: string } }> }>;

beforeEach(async () => {
  vi.stubEnv("SYNAX_AGENT_SESSION_IN_PROCESS", "1");
  await resetAgentRuntimeFixtures();
  ensureSynaxAgentRegistered();
  root = await mkdtemp(path.join(os.tmpdir(), "synax-prompt-lifecycle-"));
  requests = [];
  scenario = "selected";
  coordinator = new RunCoordinator();
  provider = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    response.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta: object, finish_reason: string | null = null) => response.write(`data: ${JSON.stringify({
      id: "fixture", object: "chat.completion.chunk", model: "fixture", created: 0,
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`);
    const call = (name: string, args: unknown) => {
      chunk({ tool_calls: [{ index: 0, id: `call-${requests.length}`, type: "function", function: {
        name: name.replaceAll(".", "_"), arguments: JSON.stringify(args),
      } }] });
      chunk({}, "tool_calls");
    };
    if (scenario === "execute-plan" && requests.length === 1) {
      call("plan.propose", { title: "Inspection", objective: "Inspect the repository", steps: [
        { id: "inspect", title: "Inspect", description: "Read source files", dependsOn: [], expectedFiles: [] },
      ], acceptanceCriteria: ["Source inspected"], assumptions: [], risks: [], humanAcceptanceCriteria: [] });
    } else if (scenario === "execute-plan" && requests.length === 2) {
      call("plan.execute", { revision: 1 });
    } else if (["preview", "invalid-preview", "forbidden"].includes(scenario) && requests.length === 1) {
      call("presentation.select", { mode: scenario === "forbidden" ? "text" : "inline_visualization",
        requirement: scenario === "forbidden" ? "forbidden" : "required", source: "explicit", reason: "User chose the presentation" });
    } else {
      const content = scenario === "forbidden" ? "Explanation\n```synax-visualize\n<div>forbidden</div>\n```"
        : scenario === "preview" && requests.length >= 3 ? "Preview\n```synax-visualize\n<div>Verified preview</div>\n```"
          : "Explanation only.";
      chunk({ content }); chunk({}, "stop");
    }
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  updateGlobalConfig({ defaultApiProviderId: "openai", providerConnections: {
    openai: { providerId: "openai", apiKey: "fixture", baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`,
      extra: { kind: "api", apiFormat: "openai", model: "fixture" } },
  } }, "prompt-lifecycle-test");
  sessionId = agentSessionRuntime.create({ projectId: "project-alpha", profileId: "synax", prompt: "Inspect",
    workDir: root, permissionTier: "unrestricted", sessionMetadata: { mode: "chat" } }).id;
});

afterEach(async () => {
  await coordinator.interrupt(sessionId, "Test cleanup");
  await coordinator.waitForIdle();
  provider.closeAllConnections();
  await new Promise<void>(resolve => provider.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});

const skillId = "synax-builtin/synax-explore";
async function run(message: string, selected = false) {
  const accepted = await coordinator.submitAsync(sessionId, { message, ...(selected ? { references: [{ kind: "skill" as const, id: skillId }] } : {}) }, `prompt-lifecycle-${scenario}-${randomUUID()}`);
  await coordinator.waitForIdle();
  const result = store.getRun(accepted.run.id);
  expect(result.status, JSON.stringify(result)).toBe("completed");
  return result;
}

it("loads a selected skill before the first provider request with paired history and no duplicate loads", async () => {
  await run("Explain using the selected skill", true);
  const calls = store.listToolCalls(sessionId).filter(call => call.toolId === "skill.load");
  expect(calls).toHaveLength(1);
  expect(calls[0].status).toBe("completed");
  expect(requests).toHaveLength(1);
  expect(JSON.stringify(requests[0].messages)).toContain("Investigate architecture");
  expect(JSON.stringify(requests[0].messages)).toContain(calls[0].modelToolCallId);
  expect(requests[0].messages.some(message => message.role === "tool")).toBe(true);
});

it("loads configured session skills even without a turn reference", async () => {
  store.updateSession(sessionId, { skillIds: [skillId] });
  await run("Use the configured skill");
  expect(store.listToolCalls(sessionId).filter(call => call.toolId === "skill.load")).toHaveLength(1);
  expect(JSON.stringify(requests[0].messages)).toContain("Investigate architecture");
});

it.each(["session", "turn"] as const)("reuses unchanged %s skills across user turns without growing skill history", async (selection) => {
  if (selection === "session") store.updateSession(sessionId, { skillIds: [skillId] });
  await run("Explain the repository", selection === "turn");
  await run("Explain the request lifecycle", selection === "turn");
  await run("Explain the error handling", selection === "turn");

  expect(store.listToolCalls(sessionId).filter(call => call.toolId === "skill.load")).toHaveLength(1);
  expect(requests).toHaveLength(3);
  const initialCopies = JSON.stringify(requests[0].messages).split("Investigate architecture").length - 1;
  expect(initialCopies).toBeGreaterThan(0);
  for (const request of requests.slice(1)) {
    expect(JSON.stringify(request.messages.filter(message => message.role === "system"))).toContain("Investigate architecture");
    expect(JSON.stringify(request.messages).split("Investigate architecture").length - 1).toBe(initialCopies);
  }
}, 15_000);

it("loads only newly selected skills on a later turn", async () => {
  store.updateSession(sessionId, { skillIds: [skillId] });
  await run("Explain the repository");
  const added = "synax-builtin/systematic-debugging";
  store.updateSession(sessionId, { skillIds: [skillId, added] });
  const second = await run("Investigate the reported issue");
  const calls = store.listRunToolCalls(second.id).filter(call => call.toolId === "skill.load");
  expect(calls).toHaveLength(1);
  expect(calls[0].inputRef).toEqual({ skillId: added });
  const instructions = JSON.stringify(requests[1].messages.filter(message => message.role === "system"));
  expect(instructions).toContain("Investigate architecture");
  expect(instructions).toContain("Debugging is hypothesis testing");
}, 15_000);

it("reloads changed instructions once and then reuses the updated body", async () => {
  store.updateSession(sessionId, { skillIds: [skillId] });
  await run("Explain the repository");
  const loadDetail = skillRegistry.loadDetail.bind(skillRegistry);
  vi.spyOn(skillRegistry, "loadDetail").mockImplementation(input => {
    const skill = loadDetail(input);
    return input.skillId === skillId ? { ...skill, content: `${skill.content}\nUpdated skill fixture instruction.` } : skill;
  });
  await run("Explain the request lifecycle");
  await run("Explain the error handling");
  expect(store.listToolCalls(sessionId).filter(call => call.toolId === "skill.load")).toHaveLength(2);
  for (const request of requests.slice(1)) {
    expect(JSON.stringify(request.messages.filter(message => message.role === "system"))).toContain("Updated skill fixture instruction.");
  }
}, 15_000);

it("does not bypass tightened permissions when a successful load already exists", async () => {
  store.updateSession(sessionId, { skillIds: [skillId] });
  await run("Explain the repository");
  store.updateSession(sessionId, { permissionRules: [
    { gate: "*", pattern: "*", action: "allow" }, { gate: "skill", pattern: skillId, action: "ask" },
  ] });
  const accepted = await coordinator.submitAsync(sessionId, { message: "Explain the request lifecycle" }, "recheck-skill-permission");
  await coordinator.waitForIdle();
  expect(store.getRun(accepted.run.id).status).toBe("waiting_permission");
  expect(requests).toHaveLength(1);
  const permission = store.listPermissions(sessionId).find(item => item.action === "ask")!;
  permissionPolicy.reply(sessionId, permission.id, "once");
  coordinator.resume(sessionId);
  await coordinator.waitForIdle();
  expect(store.getRun(accepted.run.id).status).toBe("completed");
  expect(store.listToolCalls(sessionId).filter(call => call.toolId === "skill.load")).toHaveLength(2);
  expect(requests).toHaveLength(2);
  // A one-time approval authorizes this load, not future user inputs.
  const third = await coordinator.submitAsync(sessionId, { message: "Explain the error handling" }, "recheck-once-grant");
  await coordinator.waitForIdle();
  expect(store.getRun(third.run.id).status).toBe("waiting_permission");
  expect(requests).toHaveLength(2);
}, 15_000);

it("keeps the real permission checkpoint for a runtime-requested skill load", async () => {
  store.updateSession(sessionId, { skillIds: [skillId], permissionRules: [
    { gate: "*", pattern: "*", action: "allow" }, { gate: "skill", pattern: skillId, action: "ask" },
  ] });
  const accepted = await coordinator.submitAsync(sessionId, { message: "Use the configured skill" }, "skill-permission");
  await coordinator.waitForIdle();
  expect(store.getRun(accepted.run.id).status).toBe("waiting_permission");
  expect(requests).toHaveLength(0);
  const permission = store.listPermissions(sessionId).find(item => item.action === "ask")!;
  permissionPolicy.reply(sessionId, permission.id, "once");
  coordinator.resume(sessionId);
  await coordinator.waitForIdle();
  expect(store.getRun(accepted.run.id).status).toBe("completed");
  expect(store.listToolCalls(sessionId).filter(call => call.toolId === "skill.load")).toHaveLength(1);
  expect(requests).toHaveLength(1);
});

it("loads visualize automatically and repairs a required preview exactly once", async () => {
  scenario = "preview";
  await run("Show an interactive preview");
  expect(requests).toHaveLength(3);
  expect(store.listToolCalls(sessionId).filter(call => call.toolId === "skill.load")).toHaveLength(1);
  expect(JSON.stringify(requests[1].messages)).toContain("# Inline visualizations");
  expect(JSON.stringify(requests[2].messages)).toContain("only automatic repair attempt");
  expect(store.listRuns(sessionId).at(-1)?.metadata.presentation).toMatchObject({ status: "validated", repairAttempted: true });
  expect(store.listMessages(sessionId).at(-1)?.content).toContain("Verified preview");
});

it("reports a failed required preview after one repair without claiming success", async () => {
  scenario = "invalid-preview";
  await run("Show an interactive preview");
  expect(requests).toHaveLength(3);
  expect(store.listMessages(sessionId).at(-1)?.content).toContain("交互预览未完成");
  expect(store.listRuns(sessionId).at(-1)?.metadata.presentation).toMatchObject({ status: "failed" });
});

it("honors forbidden previews in the persisted final answer", async () => {
  scenario = "forbidden";
  await run("Do not show a preview");
  expect(requests).toHaveLength(2);
  const final = store.listMessages(sessionId).filter(message => message.role === "assistant").at(-1)!;
  expect(final.content).toContain("Explanation");
  expect(final.content).not.toContain("synax-visualize");
  expect(store.listToolCalls(sessionId).some(call => call.toolId === "skill.load")).toBe(false);
});

it("executes a saved plan in the same authorized turn without another confirmation", async () => {
  scenario = "execute-plan";
  await run("Inspect and implement the change; execute the plan");
  expect(requests).toHaveLength(3);
  expect(store.getSession(sessionId).sessionMetadata?.plan).toMatchObject({ status: "approved", revision: 1 });
  expect(requests[1].tools.map(tool => tool.function.name)).not.toContain("file_write");
  expect(requests[2].tools.map(tool => tool.function.name)).toContain("file_write");
});
