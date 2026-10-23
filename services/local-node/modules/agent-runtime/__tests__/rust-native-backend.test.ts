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
import { runCoordinator as _rcProbe } from "../run-coordinator.js";
import { createAsset } from "../media-assets.js";
import { DATA_ROOT } from "../../../infrastructure/runtime/env.js";
import { replyAndContinueInteraction } from "../interaction-reply.js";
import fsx from "node:fs";
const debug = function (label: string, value: unknown) { fsx.appendFileSync("/tmp/synax-probe.log", "[[P]] " + label + " " + (typeof value === "string" ? value : JSON.stringify(value)) + "\n"); };
import { runtimeFacade as _rfProbe } from "../sidecar/runtime-facade.js";
import { RustNativeBackend } from "../backends/rust-native-backend.js";
import { sessionProcessManager } from "../session-process-manager.js";
debug("sidecar-port", JSON.stringify({ env: process.env.SYNAX_RUNTIME_PROVIDER_PORT, delegate: (globalThis as any).__synaxPortSnap }));
for (const name of ["controlCommand", "finishExecution", "admitExecution", "stopSessionAuthoritative"] as const) {
  const anyFacade: any = _rfProbe;
  const orig = anyFacade[name].bind(anyFacade);
  anyFacade[name] = async (...args: any[]) => {
    const tag = JSON.stringify(args.map((a: any) => a && typeof a === "object" ? Object.keys(a).slice(0, 3) : String(a).slice(0, 40)));
    debug("enter " + name, tag);
    try { const result = await orig(...args); debug("ok " + name, tag); return result; }
    catch (error) { debug("ERR " + name, tag + " => " + (error as Error).message + " || " + String((error as Error).stack).split("\n").slice(0, 5).join(" | ")); throw error; }
  };
}


let root: string;
let provider: http.Server;
let coordinator: RunCoordinator;
let requests: Array<Record<string, unknown>>;
let sessionId: string;
let multiple = false;
let askHuman = false;
let scenario: "normal" | "goal" | "plan" | "mixed" | "restart" | "compact" | "media" | "long" | "overflow" | "active-compact" = "normal";
let rejectedContextRequests = 0;
let mediaAssetId: string;
let longToolRounds = 34;

it("lets a waiting conversation take a real worker at a safe step boundary", async () => {
  vi.stubEnv("SYNAX_AGENT_SESSION_IN_PROCESS", "0");
  vi.stubEnv("DATA_ROOT", DATA_ROOT);
  scenario = "long"; longToolRounds = 6;
  const manager = sessionProcessManager as any;
  const original = manager.canSpawnChild.bind(manager);
  const cap = vi.spyOn(manager, "canSpawnChild").mockImplementation((value: unknown) => {
    const id = typeof value === "string" ? value : undefined;
    return original(id) && (Boolean(id && manager.children.get(id)?.child.connected) || manager.countChildren() < 2);
  });
  const messages = vi.spyOn(manager, "handleChildMessage");
  const ids = [sessionId, ...Array.from({ length: 2 }, () => agentSessionRuntime.create({
    projectId: "project-alpha", profileId: "executor", prompt: "Read files", workDir: root,
  }).id)];
  try {
    const accepted = await Promise.all(ids.map(id => coordinator.submitAsync(id, { message: "Inspect files" }, `worker-fairness:${id}`)));
    await coordinator.waitForIdle();
    expect(messages.mock.calls.some(([, message]) => (message as { type?: string })?.type === "stream:parked")).toBe(true);
    for (const [index, id] of ids.entries()) {
      await store.hydrateSession(id, true);
      expect(store.getRun(accepted[index].run.id).status, JSON.stringify(store.getRun(accepted[index].run.id))).toBe("completed");
      expect(store.listMessages(id).filter(message => message.role === "user")).toHaveLength(1);
    }
  } finally {
    await Promise.all(ids.map(id => coordinator.interrupt(id, "Fairness test cleanup")));
    await coordinator.waitForIdle();
    cap.mockRestore(); messages.mockRestore();
  }
}, 60_000);

it("hands off at completed steps and reattaches without replaying user input or tools", async () => {
  scenario = "long"; longToolRounds = 3;
  let handoffs = 0;
  const fair = new RunCoordinator({
    async *execute(id, mode, input, signal) {
      for (;;) {
        let parked = false;
        const backend = new RustNativeBackend();
        for await (const chunk of backend.stream(id, mode, { ...input, shouldYieldWorker: () => true }, signal)) {
          if (chunk.type === "worker_yield") { parked = true; handoffs++; break; }
          yield chunk;
        }
        if (!parked) return;
        mode = "resume"; input = { ...input, resumeExecution: true };
      }
    },
    async interrupt() {},
  });
  coordinator = fair;
  const accepted = await fair.submitAsync(sessionId, { message: "Continue until all reads finish" }, "fair-handoff");
  await fair.waitForIdle();
  expect(store.getRun(accepted.run.id).status, JSON.stringify(store.getRun(accepted.run.id))).toBe("completed");
  expect(handoffs).toBeGreaterThan(0);
  expect(requests).toHaveLength(4);
  expect(store.listMessages(sessionId).filter(message => message.role === "user")).toHaveLength(1);
  expect(new Set(store.listToolCalls(sessionId).map(call => call.modelToolCallId)).size).toBe(store.listToolCalls(sessionId).length);
}, 30_000);
{
  const anyStore: any = store;
  const origAppend = anyStore.appendMessage.bind(anyStore);
  anyStore.appendMessage = (message: any) => { const r = origAppend(message); if (String(r.content).includes("Question") && message.metadata?.runtimeReminder) debug("MODEL-TOLD", String(r.content)); return r; };
}
if (process.env.PROBE_TARGET) debug("target", process.env.PROBE_TARGET);
for (const [name, target] of [["saveRecord", store], ["appendPermission", store]] as const) {
  const anyTarget: any = target;
  const orig = anyTarget[name].bind(anyTarget);
  anyTarget[name] = (...args: any[]) => { let r: any; try { r = orig(...args); } catch (e) { debug("save " + name + " THREW", (e as Error).message + " || " + String((e as Error).stack).split("\n").slice(0,8).join(" | ")); throw e; } debug("save " + name, JSON.stringify({ kind: args[0] && typeof args[0] === "object" && "resolvedAt" in args[0] ? "record" : args[0], id: r?.id, sessionId: r?.sessionId })); return r; };
}
for (const name of ["resume", "launchAccepted"] as const) {
  const anyRc: any = _rcProbe;
  if (typeof anyRc[name] !== "function") { debug("missing " + name, ""); continue; }
  const orig = anyRc[name].bind(anyRc);
  anyRc[name] = (...args: any[]) => { debug("rc " + name, String(args[0]).slice(0, 20)); try { return orig(...args); } catch (e) { debug("rc " + name + " THREW", (e as Error).message); throw e; } };
}
for (const name of ["consumeAuthoritative", "ready", "pending", "resume"] as const) {
  const anyIs: any = interactionService;
  if (typeof anyIs[name] !== "function") continue;
  const orig = anyIs[name].bind(anyIs);
  anyIs[name] = (...args: any[]) => { try { const r = orig(...args); if (name !== "pending") debug("isvc " + name, String(r === null ? null : (r?.id ?? typeof r))); else debug("isvc pending", String(r?.id ?? null)); return r; } catch (e) { debug("isvc " + name + " THREW", (e as Error).message + " || " + String((e as Error).stack).split("\n").slice(0,6).join(" | ")); throw e; } };
}
for (const name of ["resumePendingRun", "resolvePendingRun"] as const) {
  try {
    const mod: any = await import("../loop-resume.js");
    const anySvc: any = mod.loopResumeService;
    if (typeof anySvc[name] !== "function") continue;
    const orig = anySvc[name].bind(anySvc);
    anySvc[name] = async (...args: any[]) => { const r = await orig(...args); debug("resume " + name, String(r?.toolCall?.id ?? r)); return r; };
  } catch {}
}
beforeEach(async () => {
  vi.stubEnv("SYNAX_AGENT_LOOP_ENGINE", "rust");
  vi.stubEnv("SYNAX_AGENT_SESSION_IN_PROCESS", "1");
  await resetAgentRuntimeFixtures();
  ensureSynaxAgentRegistered();
  root = await mkdtemp(path.join(os.tmpdir(), "synax-rust-native-"));
  requests = [];
  multiple = false;
  askHuman = false;
  scenario = "normal"; longToolRounds = 34;
  rejectedContextRequests = 0;
  coordinator = new RunCoordinator();
  provider = http.createServer(async (request, response) => {
    debug("provider request", String(request.url) + " auth=" + String(request.headers.authorization).slice(0, 12) + " keys=" + Object.keys(request.headers).join(","));
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    if (scenario === "overflow" && !body.includes("Maintain a structured conversation checkpoint") && rejectedContextRequests++ === 0) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "context_length_exceeded", message: "maximum context length exceeded" } }));
      return;
    }
    const afterTools = requests.length > 1;
    const base = { id: "fixture", object: "chat.completion.chunk", model: "fixture", created: 0 };
    const chunk = (delta: object, finish_reason: string | null = null) => response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    response.writeHead(200, { "content-type": "text/event-stream" });
    const call = (index: number, name: string, args: unknown) => chunk({ tool_calls: [{ index, id: `provider-call-${requests.length}-${index}`, type: "function", function: { name: name.replaceAll(".", "_"), arguments: JSON.stringify(args) } }] });
    if (scenario === "active-compact" && !body.includes("Maintain a structured conversation checkpoint")) {
      const mainRequests = requests.filter(item => !JSON.stringify(item).includes("Maintain a structured conversation checkpoint"));
      if (mainRequests.length <= 3) {
        chunk({ content: "Historical observation USER_INVARIANT. ".repeat(6000) });
        call(0, "file.list", { path: "." }); chunk({}, "tool_calls");
      } else { chunk({ content: "Final response." }); chunk({}, "stop"); }
    } else if (scenario === "long" && requests.length <= longToolRounds) {
      call(0, "file.list", { path: "." }); chunk({}, "tool_calls");
    } else if (scenario === "media" && requests.length === 1) {
      call(0, "agent.discover", { ids: ["media.read"] }); chunk({}, "tool_calls");
    } else if (scenario === "media" && requests.length === 2) {
      call(0, "media.read", { assetId: mediaAssetId }); chunk({}, "tool_calls");
    } else if (scenario === "compact" || scenario === "overflow" || scenario === "active-compact") {
      chunk({ content: body.includes("Maintain a structured conversation checkpoint")
        ? JSON.stringify({ summary: { goal: ["Continue the work"], constraints: ["Keep USER_INVARIANT exactly."],
            completedWork: ["Earlier inspected history"], evidence: [], decisions: [], failures: [], openQuestions: [], nextActions: ["Continue"] }, sourceRefs: [] })
        : "Final response." });
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
  (globalThis as typeof globalThis & { __synaxPortSnap?: unknown }).__synaxPortSnap = { port: (provider.address() as { port: number }).port, env: process.env.SYNAX_RUNTIME_PROVIDER_PORT };
  debug("provider listen", JSON.stringify({ port: (provider.address() as { port: number }).port, runtimeProviderPort: process.env.SYNAX_RUNTIME_PROVIDER_PORT, token: Boolean(process.env.SYNAX_RUNTIME_SIDECAR_TOKEN), dataRoot: DATA_ROOT, engine: process.env.SYNAX_AGENT_LOOP_ENGINE }));
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
  debug("submit() entered", "");
  const accepted = await coordinator.submitAsync(sessionId, { message: "Please write the files" }, "rust-test");
  debug("submit: submitted", accepted.run.id);
  await coordinator.waitForIdle();
  debug("submit: idle", JSON.stringify({ run: store.getRun(accepted.run.id).status, stop: store.getRun(accepted.run.id).stopReason, session: store.getSession(sessionId).status, requests: requests.length, blocked: store.getSession(sessionId).blockedReason }));
  expect(store.getRun(accepted.run.id).status).toBe("waiting_permission");
  expect(requests).toHaveLength(1);
  return accepted.run.id;
}
async function reply(action: "once" | "reject") {
  debug("reply() entered", action);
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
  debug("TEST-ENTER denial", "");
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

it.each(["1", "0"])("suspends on human input and resumes with the saved answer (in-process=%s)", async (inProcess) => {
  vi.stubEnv("SYNAX_AGENT_SESSION_IN_PROCESS", inProcess);
  vi.stubEnv("DATA_ROOT", DATA_ROOT);
  askHuman = true;
  store.updateSession(sessionId, { profileId: "synax" });
  const accepted = await coordinator.submitAsync(sessionId, { message: "Ask which file" }, "human-test");
  await coordinator.waitForIdle();
  expect(store.getRun(accepted.run.id).status, JSON.stringify(store.getRun(accepted.run.id))).toBe("waiting_input");
  expect(store.getSession(sessionId)).toMatchObject({ status: "waiting_input", activeRunId: accepted.run.id });
  expect(requests).toHaveLength(1);
  const interaction = interactionService.pending(sessionId)!;
  expect(interaction).not.toBeNull();
  expect(store.getSession(sessionId).pendingResumeToken).toBe(`interaction:${interaction.id}`);
  expect(store.getRunStep(interaction.stepId)).toMatchObject({ status: "waiting_input", completedAt: null });
  expect(store.getToolCall(sessionId, interaction.toolCallId)).toMatchObject({ status: "pending", endedAt: null });
  if (inProcess === "0") {
    // A reopened app has no in-memory coordinator or form cache.
    store.reset();
    coordinator = new RunCoordinator();
  }
  await interactionService.replyAuthoritative(sessionId, interaction.id, { revision: interaction.revision, action: "submit", answers: { file: "README.md" } });
  coordinator.resume(sessionId);
  await coordinator.waitForIdle();
  expect(store.getRun(accepted.run.id).status).toBe("completed");
  expect(requests).toHaveLength(2);
  expect(JSON.stringify(requests[1])).toContain("README.md");
  expect(interactionService.pending(sessionId)).toBeNull();
  expect(store.listToolCalls(sessionId)).toHaveLength(1);
  expect(store.getToolCall(sessionId, interaction.toolCallId).status).toBe("completed");
}, 20_000);

it.each(["permission", "input"] as const)("expires pending %s after a runtime restart without executing tools", async (kind) => {
  askHuman = kind === "input";
  if (askHuman) store.updateSession(sessionId, { profileId: "synax" });
  const accepted = await coordinator.submitAsync(sessionId, { message: "Wait for approval" }, `restart-${kind}`);
  await coordinator.waitForIdle();
  expect(store.getRun(accepted.run.id).status).toBe(kind === "input" ? "waiting_input" : "waiting_permission");
  const oldPid = Number(process.env.SYNAX_RUNTIME_SIDECAR_PID);
  process.kill(oldPid, "SIGKILL");
  await vi.waitFor(() => expect(Number(process.env.SYNAX_RUNTIME_SIDECAR_PID)).not.toBe(oldPid), { timeout: 10_000 });
  store.reset();
  const { recoverRuntime } = await import("../runtime-recovery.js");
  const recovery = await recoverRuntime("restarted-host");
  expect(recovery.resumable).toEqual([]);
  await store.hydrateSession(sessionId, true);
  expect(store.getRun(accepted.run.id).status).toBe("interrupted");
  expect(store.getSession(sessionId)).toMatchObject({ status: "paused", activeRunId: null, pendingResumeToken: null });
  expect(interactionService.pending(sessionId)).toBeNull();
  expect(permissionPolicy.list(sessionId).some(item => item.action === "ask" && !item.resolvedAt)).toBe(false);
  expect(requests).toHaveLength(1);
  expect(store.listToolCalls(sessionId).some(call => call.status === "completed")).toBe(false);
  await expect(recoverRuntime("restarted-host")).resolves.toMatchObject({ resumable: [] });
  const next = await coordinator.submitAsync(sessionId, { message: "Continue" }, `continue-${kind}`);
  expect(next.run.id).not.toBe(accepted.run.id);
  await coordinator.waitForIdle();
  expect(store.getRun(next.run.id).status).toBe("completed");
  expect(requests).toHaveLength(2);
}, 25_000);

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

it("keeps an acknowledged step context in memory and immutable across retries", async () => {
  const bridge = await import("../rust-agent-loop-client.js");
  const contextWriter = vi.spyOn(bridge, "sendRustStepContext");
  scenario = "restart";
  const accepted = await coordinator.submitAsync(sessionId, { message: "Wait for context replay" }, "context-replay");
  const runId = accepted.run.id;
  await vi.waitFor(() => expect(requests).toHaveLength(1));
  const run = store.getRun(runId);
  const step = store.listRunSteps(runId)[0];
  expect(step.metadata.rustPreparedContext).toBeUndefined();
  const { loopId: _loopId, executionContext: _executionContext, ...context } = contextWriter.mock.calls[0][0];
  contextWriter.mockRestore();
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

it.each([false, true])("delivers user images and tool-returned images through the Rust loop (large=%s)", async (large) => {
  scenario = "media";
  const gateway = await import("../../../infrastructure/llm-runtime/gateway.js");
  const actual = gateway.resolveGatewaySelection;
  const selection = vi.spyOn(gateway, "resolveGatewaySelection").mockImplementation(async (...args) => {
    const resolved = await actual(...args);
    return { ...resolved, modelDef: { ...resolved.modelDef, inputModalities: ["text", "image"] } };
  });
  try {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=", "base64");
    const bytes = large ? Buffer.concat([png, Buffer.alloc(600 * 1024, 65)]) : png;
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
}, 30_000);

it("interrupts an active run after Rust is killed and starts a new run only on user input", async () => {
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
  expect(store.getRun(accepted.run.id)).toMatchObject({ status: "interrupted", metadata: { rustLoopId: loopId } });
  expect(store.getSession(sessionId)).toMatchObject({ status: "paused", activeRunId: null, pendingResumeToken: null });
  expect(store.listRunSteps(accepted.run.id)).toHaveLength(1);
  expect(store.listMessages(sessionId).filter(message => message.role === "assistant").map(message => message.content)).toContain("Partial before restart");
  expect(requests).toHaveLength(1);
  scenario = "normal";
  const next = await coordinator.submitAsync(sessionId, { message: "Continue" }, "runtime-after-crash");
  expect(next.run.id).not.toBe(accepted.run.id);
  await coordinator.waitForIdle();
  expect(store.getRun(next.run.id).status).toBe("completed");
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
    const at = new Date().toISOString();
    store.appendRun({ id: "old-complete-run", sessionId, status: "completed", startedAt: at, completedAt: at,
      triggerMessageId: "pinned-request", currentStep: 1, stopReason: "stop", model: "fixture", metadata: {} });
    store.appendRunStep({ id: "old-complete-step", sessionId, runId: "old-complete-run", index: 1, status: "completed",
      model: "fixture", startedAt: at, completedAt: at, finishReason: "stop", metadata: {} });
    const accepted = await coordinator.submitAsync(sessionId, { message: "Summarize the remaining work", maxTokens: 256 }, "context-native");
    await coordinator.waitForIdle();
    expect(store.getRun(accepted.run.id).status, JSON.stringify(store.getRun(accepted.run.id))).toBe("completed");
    await store.hydrateSession(sessionId, true);
    const { readCheckpointHead } = await import("../checkpoint-service.js");
    const compacted = (await readCheckpointHead(sessionId)).checkpoint!;
    expect(compacted.summary.completedWork).toContain("Earlier inspected history");
    expect(compacted.throughStepId).toBe("old-complete-step");
    expect(store.getRun(compacted.compactionRunId).metadata.kind).toBe("context-compaction");
    const summaryRequests = requests.filter(body => JSON.stringify(body).includes("Maintain a structured conversation checkpoint"));
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

it("compacts repeatedly inside an active run and closes its execution lease", async () => {
  scenario = "active-compact";
  const gateway = await import("../../../infrastructure/llm-runtime/gateway.js");
  const actual = gateway.resolveGatewaySelection;
  const selection = vi.spyOn(gateway, "resolveGatewaySelection").mockImplementation(async (...args) => {
    const resolved = await actual(...args);
    return { ...resolved, modelDef: { ...resolved.modelDef, contextLimit: 30_000, maxTokens: 256 } };
  });
  try {
    const accepted = await coordinator.submitAsync(sessionId, { message: "Keep USER_INVARIANT and inspect files", maxTokens: 256 }, "active-compaction");
    await coordinator.waitForIdle();
    const { readCheckpointHead } = await import("../checkpoint-service.js");
    const head = await readCheckpointHead(sessionId);
    expect(head.checkpoint).not.toBeNull();
    await store.hydrateSession(sessionId, true);
    const run = store.getRun(accepted.run.id);
    expect(run.status, JSON.stringify(run)).toBe("completed");
    expect(store.listRuns(sessionId).filter(item => item.metadata.kind === "context-compaction" && item.status === "completed").length).toBeGreaterThanOrEqual(2);
    expect(store.getRunStep(head.checkpoint!.throughStepId).runId).toBe(run.id);
    expect(store.listRunSteps(run.id)).toHaveLength(4);
    expect(store.listToolCalls(sessionId).filter(call => call.toolId === "file.list" && call.status === "completed")).toHaveLength(3);
    expect((await _rfProbe.controlState(sessionId) as { executionLease?: { closed?: boolean } }).executionLease?.closed).toBe(true);
    const next = await coordinator.submitAsync(sessionId, { message: "Continue using the same tools", maxTokens: 256 }, "after-active-compaction");
    await coordinator.waitForIdle();
    expect(store.getRun(next.run.id).status).toBe("completed");
    expect(JSON.stringify(requests.at(-1))).toContain("USER_INVARIANT");
  } finally { selection.mockRestore(); }
}, 60_000);

it("settles an accepted manual compaction when there is no completed history", async () => {
  store.updateSession(sessionId, { status: "completed", activeRunId: null });
  const { sessionLiveBus } = await import("../session-live-bus.js");
  const events: string[] = [];
  const release = sessionLiveBus.subscribe(sessionId, event => events.push(event.type));
  const cleanup = (sessionProcessManager as unknown as { resourceCleanup: Map<string, string[]> }).resourceCleanup;
  cleanup.set("previous-worker", [sessionId]);
  const cleanupTimer = setTimeout(() => cleanup.delete("previous-worker"), 100);
  try {
    await sessionProcessManager.beginContextCompaction(sessionId);
    await vi.waitFor(async () => {
      expect(events).toContain("context_compacted");
      expect((await _rfProbe.controlState(sessionId) as { runtimeControl?: unknown }).runtimeControl).toBeNull();
    }, { timeout: 10000 });
    expect(requests).toHaveLength(0);
  } finally { release(); clearTimeout(cleanupTimer); cleanup.delete("previous-worker"); }
}, 15_000);

it("runs manual compaction inside the original session and releases its durable admission lock", async () => {
  scenario = "compact";
  const at = new Date().toISOString();
  store.updateSession(sessionId, { status: "completed", activeRunId: null });
  store.appendMessage({ id: "manual-history", sessionId, runId: "manual-old-run", stepId: "manual-old-step", role: "assistant",
    content: "Historical evidence with USER_INVARIANT. ".repeat(1200), metadata: {}, createdAt: at });
  store.appendRun({ id: "manual-old-run", sessionId, status: "completed", startedAt: at, completedAt: at,
    triggerMessageId: null, currentStep: 1, stopReason: "stop", model: "fixture", metadata: {} });
  store.appendRunStep({ id: "manual-old-step", sessionId, runId: "manual-old-run", index: 1, status: "completed",
    model: "fixture", startedAt: at, completedAt: at, finishReason: "stop", metadata: {} });
  const { readCheckpointHead } = await import("../checkpoint-service.js");
  const { runtimeFacade } = await import("../sidecar/runtime-facade.js");
  expect(await sessionProcessManager.beginContextCompaction(sessionId)).toMatchObject({ accepted: true });
  await vi.waitFor(async () => {
    const head = await readCheckpointHead(sessionId);
    expect(head.active?.status).toBe("completed");
    expect(head.checkpoint?.throughStepId).toBe("manual-old-step");
    const control = await runtimeFacade.controlState(sessionId) as { runtimeControl?: unknown };
    expect(control.runtimeControl).toBeNull();
  }, { timeout: 15_000, interval: 50 });
  await store.hydrateSession(sessionId, true);
  const special = store.listRuns(sessionId).filter(run => run.metadata.kind === "context-compaction");
  expect(special).toHaveLength(1);
  expect(special[0]).toMatchObject({ sessionId, status: "completed", triggerMessageId: null });
  expect(store.listMessages(sessionId).some(message => message.id === "manual-history")).toBe(true);
  expect(store.listMessages(sessionId).filter(message => message.metadata.source === "context_compaction")).toHaveLength(1);
}, 20_000);

it("repairs a provider context rejection once through the same session checkpoint barrier", async () => {
  scenario = "overflow";
  const at = new Date().toISOString();
  store.appendRun({ id:"overflow-old-run",sessionId,status:"completed",startedAt:at,completedAt:at,triggerMessageId:null,currentStep:1,stopReason:"stop",model:"fixture",metadata:{} });
  store.appendMessage({ id:"overflow-history",sessionId,runId:"overflow-old-run",stepId:"overflow-old-step",role:"assistant",
    content:"Historical evidence. ".repeat(4000),metadata:{},createdAt:at });
  store.appendRunStep({id:"overflow-old-step",sessionId,runId:"overflow-old-run",index:1,status:"completed",model:"fixture",startedAt:at,completedAt:at,finishReason:"stop",metadata:{}});
  const accepted = await coordinator.submitAsync(sessionId,{message:"Continue",maxTokens:8192},"provider-overflow");
  await coordinator.waitForIdle();
  expect(store.getRun(accepted.run.id).status,JSON.stringify(store.getRun(accepted.run.id))).toBe("completed");
  expect(rejectedContextRequests).toBe(2);
  const {readCheckpointHead}=await import("../checkpoint-service.js");
  expect((await readCheckpointHead(sessionId)).checkpoint?.throughStepId).toBe("overflow-old-step");
  expect(store.listMessages(sessionId).filter(message=>message.role==="user")).toHaveLength(1);
},30_000);

it("keeps an admitted native run going past 32 steps and ignores legacy maxSteps", async () => {
  scenario = "long";
  const accepted = await coordinator.submitAsync(sessionId, { message: "Continue until all reads finish", maxSteps: 1 }, "unlimited-native");
  await coordinator.waitForIdle();
  expect(store.getRun(accepted.run.id).status, JSON.stringify(store.getRun(accepted.run.id))).toBe("completed");
  expect(requests).toHaveLength(35);
  expect(store.listRunSteps(accepted.run.id)).toHaveLength(35);
  expect(store.listToolCalls(sessionId).filter(call => call.toolId === "file.list" && call.status === "completed")).toHaveLength(34);
// This is a 35-round durability check, not a latency benchmark.
}, 90_000);
