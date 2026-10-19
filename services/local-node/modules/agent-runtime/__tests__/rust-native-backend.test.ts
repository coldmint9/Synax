import http from "node:http";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resetAgentRuntimeFixtures } from "./agent-runtime-fixtures.js";
import { updateGlobalConfig } from "../../../infrastructure/runtime/config/config-store.js";
import { agentSessionRuntime } from "../session-runtime.js";
import { agentRuntimeStore as store } from "../session-store.js";
import { ensureSynaxAgentRegistered } from "../synax/index.js";
import { RunCoordinator } from "../run-coordinator.js";
import { interactionService } from "../interaction-service.js";
import { permissionPolicy } from "../permission-policy.js";
import { createAsset } from "../media-assets.js";

let root: string;
let provider: http.Server;
let coordinator: RunCoordinator;
let requests: Array<Record<string, unknown>>;
let sessionId: string;
let multiple = false;
let askHuman = false;
let scenario: "normal" | "goal" | "plan" | "mixed" | "restart" | "compact" | "media" = "normal";
let mediaAssetId: string;
beforeEach(async () => {
  vi.stubEnv("SYNAX_AGENT_LOOP_ENGINE", "rust");
  vi.stubEnv("SYNAX_AGENT_SESSION_IN_PROCESS", "1");
  await resetAgentRuntimeFixtures();
  ensureSynaxAgentRegistered();
  root = await mkdtemp(path.join(os.tmpdir(), "synax-rust-native-"));
  requests = [];
  multiple = false;
  askHuman = false;
  scenario = "normal";
  coordinator = new RunCoordinator();
  provider = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    const afterTools = requests.length > 1;
    const base = { id: "fixture", object: "chat.completion.chunk", model: "fixture", created: 0 };
    const chunk = (delta: object, finish_reason: string | null = null) => response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    response.writeHead(200, { "content-type": "text/event-stream" });
    const call = (index: number, name: string, args: unknown) => chunk({ tool_calls: [{ index, id: `provider-call-${requests.length}-${index}`, type: "function", function: { name: name.replaceAll(".", "_"), arguments: JSON.stringify(args) } }] });
    if (scenario === "media" && requests.length === 1) {
      call(0, "agent.discover", { ids: ["media.read"] }); chunk({}, "tool_calls");
    } else if (scenario === "media" && requests.length === 2) {
      call(0, "media.read", { assetId: mediaAssetId }); chunk({}, "tool_calls");
    } else if (scenario === "compact") {
      chunk({ content: body.includes("You maintain a conversation checkpoint.")
        ? "Earlier inspected history, evidence and unresolved work are recorded." : "Final response." });
      chunk({}, "stop");
    } else if (scenario === "restart" && !afterTools) {
      chunk({ content: "Partial before restart" });
      return;
    } else if (scenario === "goal") {
      if (requests.length === 1) { chunk({ content: "I am done." }); chunk({}, "stop"); }
      else { call(0, "work.checkpoint", { action: "blocked", summary: "A required service is unavailable." }); chunk({}, "tool_calls"); }
    } else if (scenario === "plan" && !afterTools) {
      call(0, "plan.propose", { title: "Fixture plan", objective: "Inspect the project", steps: [{ id: "read", title: "Read", description: "Inspect README", dependsOn: [], expectedFiles: [] }], acceptanceCriteria: ["README inspected"], humanAcceptanceCriteria: [], assumptions: [], risks: [] });
      chunk({}, "tool_calls");
    } else if (scenario === "mixed" && !afterTools) {
      call(0, "human.ask", { title: "Question", questions: [{ id: "q", type: "text", label: "Which file?" }] });
      call(1, "file.write", { path: path.join(root, "forbidden.txt"), content: "must not run" });
      chunk({}, "tool_calls");
    } else if (afterTools) {
      chunk({ content: "Final response." }); chunk({}, "stop");
    } else {
      chunk({ content: "Preparing a write." });
      for (let index = 0; index < (multiple ? 2 : 1); index++) chunk({ tool_calls: [{ index, id: `provider-call-${index}`, type: "function",
        function: { name: askHuman ? "human_ask" : "file_write", arguments: JSON.stringify(askHuman ? { title: "Pick a file", questions: [{ id: "file", label: "Which file?", type: "text", required: true }] } : { path: path.join(root, `${index}.txt`), content: `written-${index}` }) } }] });
      chunk({}, "tool_calls");
    }
    response.write(`data: ${JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  updateGlobalConfig({ defaultApiProviderId: "openai", providerConnections: {
    openai: { providerId: "openai", apiKey: "local", baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`, extra: { kind: "api", apiFormat: "openai", model: "fixture" } },
  } }, "rust-native-test");
  sessionId = agentSessionRuntime.create({ projectId: "project-alpha", profileId: "executor", prompt: "Write files", workDir: root }).id;
});
afterEach(async () => {
  if (sessionId) await coordinator.interrupt(sessionId, "Test cleanup");
  await coordinator.waitForIdle();
  provider.closeAllConnections();
  await new Promise<void>(resolve => provider.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
async function submit() {
  const accepted = await coordinator.submitAsync(sessionId, { message: "Please write the files" }, "rust-test");
  await coordinator.waitForIdle();
  expect(store.getRun(accepted.run.id).status).toBe("waiting_permission");
  expect(requests).toHaveLength(1);
  return accepted.run.id;
}
async function reply(action: "once" | "reject") {
  const pending = store.listPermissions(sessionId).find(permission => permission.action === "ask")!;
  expect(pending).toBeDefined();
  permissionPolicy.reply(sessionId, pending.id, action);
  await store.flushSession(sessionId);
  coordinator.resume(sessionId);
  await coordinator.waitForIdle();
}
it("resumes the exact provider call after approval and preserves step usage/history", async () => {
  const runId = await submit();
  expect(store.listToolCalls(sessionId)[0].id).not.toBe("provider-call-0");
  await reply("once");
  expect(store.getRun(runId).status).toBe("completed");
  expect(await readFile(path.join(root, "0.txt"), "utf8")).toBe("written-0");
  expect(store.listRunSteps(runId).map(step => step.index).sort()).toEqual([1, 2]);
  expect(store.listMessages(sessionId).filter(message => message.role === "assistant").map(message => message.content)).toEqual(["Preparing a write.", "Final response."]);
  expect(store.listToolCalls(sessionId)).toHaveLength(1);
  expect(JSON.stringify(requests[1])).toContain("provider-call-0");
  expect(JSON.stringify(requests[1])).toContain("Preparing a write.");
  for (const step of store.listRunSteps(runId)) expect(step.metadata.usage).toMatchObject({ inputTokens: 10, outputTokens: 4 });
}, 15_000);
it("returns denial to Rust without executing the requested write", async () => {
  const runId = await submit();
  await reply("reject");
  expect(store.getRun(runId).status).toBe("completed");
  await expect(stat(path.join(root, "0.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(store.listToolCalls(sessionId)[0].status).toBe("denied");
  expect(requests).toHaveLength(2);
});
it("resumes two approvals in one Rust step without repeating the first tool", async () => {
  multiple = true;
  const runId = await submit();
  await reply("once");
  expect(store.getRun(runId).status).toBe("waiting_permission");
  expect(await readFile(path.join(root, "0.txt"), "utf8")).toBe("written-0");
  expect(requests).toHaveLength(1);
  await reply("once");
  expect(store.getRun(runId).status).toBe("completed");
  expect(await readFile(path.join(root, "1.txt"), "utf8")).toBe("written-1");
  expect(store.listToolCalls(sessionId)).toHaveLength(2);
  expect(store.listToolCalls(sessionId).every(call => call.status === "completed")).toBe(true);
  expect(requests).toHaveLength(2);
});

it("suspends on human input and resumes with the saved answer", async () => {
  askHuman = true;
  store.updateSession(sessionId, { profileId: "synax" });
  const accepted = await coordinator.submitAsync(sessionId, { message: "Ask which file" }, "human-test");
  await coordinator.waitForIdle();
  expect(store.getRun(accepted.run.id).status).toBe("waiting_input");
  expect(requests).toHaveLength(1);
  const interaction = interactionService.pending(sessionId)!;
  expect(interaction).not.toBeNull();
  await interactionService.replyAuthoritative(sessionId, interaction.id, { revision: interaction.revision, action: "submit", answers: { file: "README.md" } });
  coordinator.resume(sessionId);
  await coordinator.waitForIdle();
  expect(store.getRun(accepted.run.id).status).toBe("completed");
  expect(requests).toHaveLength(2);
  expect(JSON.stringify(requests[1])).toContain("README.md");
  expect(interactionService.pending(sessionId)).toBeNull();
});

it("keeps tool call/result identities in the next user turn", async () => {
  await submit();
  await reply("once");
  const accepted = await coordinator.submitAsync(sessionId, { message: "Continue with a summary" }, "second-user-turn");
  await coordinator.waitForIdle();
  expect(store.getRun(accepted.run.id).status).toBe("completed");
  expect(requests).toHaveLength(3);
  const history = requests[2].messages as Array<Record<string, unknown>>;
  expect(history.some(message => message.role === "tool" && message.tool_call_id === "provider-call-0"), JSON.stringify({ history, messages: store.listMessages(sessionId) })).toBe(true);
  expect(JSON.stringify(history)).toContain("Preparing a write.");
  expect(JSON.stringify(history)).toContain("Continue with a summary");
});

it("requires goal acceptance instead of completing on a plain-text claim", async () => {
  scenario = "goal";
  store.updateSession(sessionId, { profileId: "synax" });
  store.updateSessionMetadata(sessionId, { mode: "goal", goal: { objective: "Inspect project", status: "executing" } });
  const accepted = await coordinator.submitAsync(sessionId, { message: "Continue the goal", maxSteps: 3 }, "goal-policy");
  await coordinator.waitForIdle();
  expect(requests).toHaveLength(2);
  expect(JSON.stringify(requests[1])).toContain("A plain-text answer does not satisfy acceptance");
  expect(store.getRun(accepted.run.id)).toMatchObject({ status: "blocked", stopReason: "goal_stopped" });
  expect(store.getSession(sessionId).sessionMetadata?.goal).toMatchObject({ status: "blocked" });
});

it("ends a saved plan without making an extra model request", async () => {
  scenario = "plan";
  store.updateSession(sessionId, { profileId: "synax" });
  const accepted = await coordinator.submitAsync(sessionId, { message: "Plan the inspection" }, "plan-policy");
  await coordinator.waitForIdle();
  const interaction = interactionService.pending(sessionId)!;
  expect(interaction.kind).toBe("plan_approval");
  await interactionService.replyAuthoritative(sessionId, interaction.id, { revision: interaction.revision, action: "cancel" });
  coordinator.resume(sessionId);
  await coordinator.waitForIdle();
  expect(store.getRun(accepted.run.id)).toMatchObject({ status: "completed", stopReason: "plan_saved" });
  expect(requests).toHaveLength(1);
});

it("cancels a human input checkpoint without continuing the model", async () => {
  askHuman = true;
  store.updateSession(sessionId, { profileId: "synax" });
  const accepted = await coordinator.submitAsync(sessionId, { message: "Ask which file" }, "human-cancel");
  await coordinator.waitForIdle();
  const interaction = interactionService.pending(sessionId)!;
  await interactionService.replyAuthoritative(sessionId, interaction.id, { revision: interaction.revision, action: "cancel" });
  coordinator.resume(sessionId);
  await coordinator.waitForIdle();
  expect(store.getRun(accepted.run.id)).toMatchObject({ status: "blocked", stopReason: "input_cancelled" });
  expect(requests).toHaveLength(1);
});

it("rejects a mixed control batch before executing either operation", async () => {
  scenario = "mixed";
  store.updateSession(sessionId, { profileId: "synax" });
  const accepted = await coordinator.submitAsync(sessionId, { message: "Inspect", maxSteps: 3 }, "mixed-control");
  await coordinator.waitForIdle();
  expect(store.getRun(accepted.run.id).status).toBe("completed");
  expect(store.listToolCalls(sessionId)).toHaveLength(0);
  expect(interactionService.pending(sessionId)).toBeNull();
  await expect(stat(path.join(root, "forbidden.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(JSON.stringify(requests[1])).toContain("No operation from this batch was executed");
});

it("includes workspace rules, environment and the selected workflow in Rust's request", async () => {
  await writeFile(path.join(root, "AGENTS.md"), "Use project-specific verification SENTINEL_RULE.");
  await submit();
  const messages = requests[0].messages as Array<{ role: string; content: unknown }>;
  expect(JSON.stringify(messages.filter(message => message.role === "system"))).toContain("SENTINEL_RULE");
  expect(JSON.stringify(messages)).toContain(root);
});

it("refreshes tool availability after plan execution is approved", async () => {
  scenario = "plan";
  store.updateSession(sessionId, { profileId: "synax" });
  store.updateSessionMetadata(sessionId, { mode: "plan" });
  const accepted = await coordinator.submitAsync(sessionId, { message: "Plan the inspection" }, "plan-execute");
  await coordinator.waitForIdle();
  const firstTools = requests[0].tools as Array<{ function: { name: string } }>;
  expect(firstTools.map(tool => tool.function.name)).not.toContain("file_write");
  const interaction = interactionService.pending(sessionId)!;
  await interactionService.replyAuthoritative(sessionId, interaction.id, { revision: interaction.revision, action: "execute" });
  coordinator.resume(sessionId);
  await coordinator.waitForIdle();
  expect(store.getRun(accepted.run.id).status).toBe("completed");
  expect(requests).toHaveLength(2);
  const nextTools = requests[1].tools as Array<{ function: { name: string } }>;
  expect(nextTools.map(tool => tool.function.name)).toContain("file_write");
  expect(store.getSession(sessionId).sessionMetadata?.mode).toBe("chat");
});

it("keeps an acknowledged step context immutable across retries", async () => {
  scenario = "restart";
  const accepted = await coordinator.submitAsync(sessionId, { message: "Wait for context replay" }, "context-replay");
  const runId = accepted.run.id;
  await vi.waitFor(() => expect(requests).toHaveLength(1));
  const run = store.getRun(runId);
  const step = store.listRunSteps(runId)[0];
  const context = step.metadata.rustPreparedContext as { contextId: string; systemPrompt: string; tools: unknown[] };
  const post = (value: unknown) => fetch(`http://127.0.0.1:${process.env.SYNAX_RUNTIME_PROVIDER_PORT}/agent-loop/context`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${process.env.SYNAX_RUNTIME_SIDECAR_TOKEN}` },
    body: JSON.stringify(value),
  });
  expect(context.contextId).toBeTruthy();
  expect((await post({ loopId: run.metadata.rustLoopId, ...context })).status).toBe(409);
  expect((await post({ loopId: run.metadata.rustLoopId, ...context, executionContext: {
    ...(run.metadata.executionLease as object), epoch: "superseded-executor",
  } })).status).toBe(409);
  expect((await post({ loopId: run.metadata.rustLoopId, executionContext: run.metadata.executionLease, ...context })).status).toBe(200);
  expect((await post({ loopId: run.metadata.rustLoopId, executionContext: run.metadata.executionLease, ...context, systemPrompt: "changed" })).status).toBe(409);
  expect(requests).toHaveLength(1);
});

it("delivers user images and tool-returned images through the Rust loop", async () => {
  scenario = "media";
  const gateway = await import("../../../infrastructure/llm-runtime/gateway.js");
  const actual = gateway.resolveGatewaySelection;
  const selection = vi.spyOn(gateway, "resolveGatewaySelection").mockImplementation(async (...args) => {
    const resolved = await actual(...args);
    return { ...resolved, modelDef: { ...resolved.modelDef, inputModalities: ["text", "image"] } };
  });
  try {
    const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=", "base64");
    const asset = await createAsset("project-alpha", "fixture.png", bytes, "image/png");
    mediaAssetId = asset.id;
    const accepted = await coordinator.submitAsync(sessionId, { message: "Inspect this image and read it with the media tool", contentParts: [
      { type: "text", text: "Inspect this image" }, { type: "image", assetId: asset.id },
    ] }, "media-rust");
    await coordinator.waitForIdle();
    expect(store.getRun(accepted.run.id).status, JSON.stringify(store.getRun(accepted.run.id))).toBe("completed");
    expect(requests).toHaveLength(3);
    expect(JSON.stringify(requests[0])).toContain(bytes.toString("base64"));
    expect(JSON.stringify(requests[1].tools)).toContain("media_read");
    const second = requests[2].messages as Array<any>;
    expect(second.some(message => JSON.stringify(message).includes(bytes.toString("base64")) &&
      (message.role === "tool" || second.indexOf(message) > second.findIndex(item => item.role === "assistant")))).toBe(true);
    expect(store.listToolCalls(sessionId).find(call => call.toolId === "media.read")?.status).toBe("completed");
  } finally { selection.mockRestore(); }
});

it("recovers an active coordinator run after the Rust process is killed", async () => {
  scenario = "restart";
  const accepted = await coordinator.submitAsync(sessionId, { message: "Keep running" }, "runtime-crash");
  const { runtimeFacade } = await import("../sidecar/runtime-facade.js");
  await vi.waitFor(async () => {
    const snapshot = await runtimeFacade.uiSnapshotAuthoritative(sessionId);
    expect(JSON.stringify(snapshot.liveChunks), JSON.stringify({ run: store.getRun(accepted.run.id), requests })).toContain("Partial before restart");
  }, { timeout: 5000 });
  const loopId = store.getRun(accepted.run.id).metadata.rustLoopId;
  process.kill(Number(process.env.SYNAX_RUNTIME_SIDECAR_PID), "SIGKILL");
  await coordinator.waitForIdle();
  expect(store.getRun(accepted.run.id)).toMatchObject({ status: "completed", metadata: { rustLoopId: loopId } });
  expect(store.listRunSteps(accepted.run.id)).toHaveLength(1);
  expect(store.listMessages(sessionId).filter(message => message.role === "assistant").map(message => message.content)).toEqual(["Final response."]);
  expect(requests).toHaveLength(2);
}, 15_000);

it("persists Rust compaction checkpoints and accounts for auxiliary requests once", async () => {
  scenario = "compact";
  const gateway = await import("../../../infrastructure/llm-runtime/gateway.js");
  const actual = gateway.resolveGatewaySelection;
  const selection = vi.spyOn(gateway, "resolveGatewaySelection").mockImplementation(async (...args) => {
    const resolved = await actual(...args);
    return { ...resolved, modelDef: { ...resolved.modelDef, contextLimit: 30_000, maxTokens: 256 } };
  });
  try {
    store.appendMessage({ id: "pinned-request", sessionId, runId: null, stepId: null, role: "user", content: "Keep USER_INVARIANT exactly.", metadata: {}, createdAt: new Date().toISOString() });
    for (let index = 0; index < 8; index++) store.appendMessage({ id: `old-history-${index}`, sessionId, runId: null, stepId: null,
      role: "assistant", content: `Observation ${index}: ` + "historical detail ".repeat(index < 5 ? 6000 : 1), metadata: {}, createdAt: new Date().toISOString() });
    const accepted = await coordinator.submitAsync(sessionId, { message: "Summarize the remaining work", maxTokens: 256 }, "context-native");
    await coordinator.waitForIdle();
    expect(store.getRun(accepted.run.id).status, JSON.stringify(store.getRun(accepted.run.id))).toBe("completed");
    const compacted = store.getLatestCompactionRecord(sessionId)!;
    expect(compacted.summaryText).toContain("Earlier inspected history");
    expect(compacted.compressedTokenCount).toBeLessThan(compacted.originalTokenCount);
    const summaryRequests = requests.filter(body => JSON.stringify(body).includes("You maintain a conversation checkpoint."));
    const aux = store.listRecords<{ id: string; purpose: string; completedAt: string | null; usage: unknown }>("aux_usage", sessionId)
      .filter(item => item.purpose === "context-compaction");
    expect(aux).toHaveLength(summaryRequests.length);
    expect(aux.length).toBeGreaterThan(0);
    expect(aux.every(item => item.completedAt && item.usage)).toBe(true);
    const totals = store.getSessionStats(sessionId);
    expect(totals.usage.auxiliary.self.input).toBe(aux.length * 10);
    expect(totals.usage.steps.self.input).toBe(10);
    expect(store.listMessages(sessionId).some(message => message.id === "old-history-0")).toBe(true);
    expect(JSON.stringify(requests.at(-1))).toContain("USER_INVARIANT");
  } finally { selection.mockRestore(); }
}, 20_000);
