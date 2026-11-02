import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { executorInput, resetAgentRuntimeFixtures } from "./agent-runtime-fixtures.js";
import { agentSessionRuntime } from "../session-runtime.js";
import { agentRuntimeStore as store } from "../session-store.js";
import { agentRuntimeRoutes } from "../../../transport/http/agent-runtime.js";
import { buildNativeStepContext } from "../native-step-context.js";
import { executeBackendSession } from "../backend-execution.js";
import { streamAgentSession } from "../agent-stream-proxy.js";
import { readBackendBinding } from "../backends/backend-binding.js";
import { runCoordinator } from "../run-coordinator.js";
import type { CreateSessionRequest } from "../contracts.js";
import { ensureSynaxAgentRegistered } from "../synax/index.js";
import { workRuntime } from "../work-runtime.js";
import { DATA_ROOT } from '../../../infrastructure/runtime/env.js';
import { updateProjectSettings } from '../../../infrastructure/runtime/config/project-settings-store.js';
import { updateGlobalConfig } from '../../../infrastructure/runtime/config/config-store.js';

let workspace: string;
beforeEach(async () => {
  await resetAgentRuntimeFixtures();
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "synax-native-only-"));
});
afterEach(() => fs.rmSync(workspace, { recursive: true, force: true }));

it("advertises only Synax and rejects every retired engine before creating a session", async () => {
  const list = await agentRuntimeRoutes.request("http://localhost/backends");
  expect((await list.json()).items.map((item: { id: string }) => item.id)).toEqual(["native"]);
  for (const backendId of ["codex", "claude-code", "opencode-acp", "cursor-acp", "codex-acp", "pi-acp"]) {
    const input = { ...executorInput, workDir: workspace, backendId };
    const response = await agentRuntimeRoutes.request("http://localhost/sessions", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
    });
    expect(response.status, backendId).toBe(400);
    expect(() => agentSessionRuntime.create(input as CreateSessionRequest)).toThrow(/removed/);
  }
  expect((await agentRuntimeRoutes.request("http://localhost/backends/codex/models")).status).toBe(404);
});

it("keeps retired history readable, blocks both execution paths, and permits lifecycle cleanup", async () => {
  const session = agentSessionRuntime.create({ ...executorInput, workDir: workspace });
  store.updateSession(session.id, { status: "completed" });
  store.updateSessionMetadata(session.id, { backend: { version: 1, id: "codex", model: null, workDir: workspace } });
  await store.flushSession(session.id);
  expect(readBackendBinding(store.getSession(session.id)).id).toBe("codex");
  await expect(executeBackendSession(session.id, "turn", {}).next()).rejects.toThrow(/removed/);
  await expect(streamAgentSession(session.id, "turn", {}).next()).rejects.toThrow(/removed/);
  await expect(runCoordinator.interrupt(session.id, "Archive retired history")).resolves.toBeUndefined();
});

it("does not reinterpret an unbound ACP history as a native conversation", () => {
  const session = agentSessionRuntime.create({ ...executorInput, workDir: workspace });
  const legacy = { ...session, sessionMetadata: { acp: { engineModel: "pi-acp/default" } } };
  expect(readBackendBinding(legacy).id).toBe("pi-acp");
});

it("injects Maven guidance into the actual native system prompt only while a pom.xml exists", async () => {
  const session = agentSessionRuntime.create({ ...executorInput, workDir: workspace });
  const prepare = async () => (await buildNativeStepContext(session.id, {}, "Check the build", 1)).systemPrompt;
  expect(await prepare()).not.toContain("## Maven build optimization");
  fs.writeFileSync(path.join(workspace, "pom.xml"), "<project />");
  const prompt = await prepare();
  expect(prompt).toContain("## Maven build optimization");
  expect(prompt).toContain("-pl <module> -am test");
  expect(store.getSession(session.id).sessionMetadata?.latestSystemPrompt).toBe(prompt);
  fs.unlinkSync(path.join(workspace, "pom.xml"));
  expect(await prepare()).not.toContain("## Maven build optimization");
});

it("advertises only configured model refs on the delegation tool definition", async () => {
  ensureSynaxAgentRegistered();
  const session = agentSessionRuntime.create({ projectId: "project-alpha", profileId: "synax", prompt: "Delegate", workDir: workspace,
    permissionTier: "unrestricted", sessionMetadata: { mode: "chat" } });
  const description = async () => ((await buildNativeStepContext(session.id, {}, "Delegate", 1)).tools as
    Array<{ runtimeName: string; description: string }>).find(tool => tool.runtimeName === "subagent.delegate")?.description ?? "";
  expect(await description()).toContain("no chat model is configured");
  updateGlobalConfig({ providerConnections: { openai: {
    providerId: "openai", apiKey: "sk-test", baseUrl: "https://api.openai.com/v1" } } }, "runtime-test-fixture");
  const configured = await description();
  expect(configured).toContain("openai/gpt-4o-mini");
  expect(configured).toContain("profile.thinkingMode");
});



it("keeps Goal and Work progress in the runtime tail while system instructions and tools stay stable", async () => {
  ensureSynaxAgentRegistered();
  const session = agentSessionRuntime.create({ ...executorInput, profileId: "synax", workDir: workspace,
    sessionMetadata: { mode: "goal", goal: { objective: "Fix cache", status: "executing" } } });
  const work = vi.spyOn(workRuntime, "prompt").mockReturnValue("Work evidence: first receipt");
  try {
    const first = await buildNativeStepContext(session.id, {}, "Fix cache", 1);
    store.updateSessionMetadata(session.id, { goal: { objective: "Fix cache", status: "executing", acceptedCriteria: ["Cache preserved"] } });
    work.mockReturnValue("Work evidence: first and second receipts");
    const next = await buildNativeStepContext(session.id, {}, "Fix cache", 2);
    expect(next.systemPrompt).toBe(first.systemPrompt);
    expect(next.tools).toEqual(first.tools);
    expect(next.systemPrompt).not.toContain("Work evidence:");
    expect(next.systemPrompt).not.toContain("Goal status:");
    expect(first.runtimeSections.join("\n")).toContain("Work evidence: first receipt");
    expect(next.runtimeSections.join("\n")).toContain("Work evidence: first and second receipts");
    expect(next.runtimeSections.join("\n")).toContain("Goal status: executing");
  } finally { work.mockRestore(); }
});
