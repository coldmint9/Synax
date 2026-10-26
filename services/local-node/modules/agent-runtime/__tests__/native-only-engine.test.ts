import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
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

it("injects Maven guidance into the actual native system prompt only while a pom.xml exists", () => {
  const session = agentSessionRuntime.create({ ...executorInput, workDir: workspace });
  const prepare = () => buildNativeStepContext(session.id, {}, "Check the build", 1).systemPrompt;
  expect(prepare()).not.toContain("## Maven build optimization");
  fs.writeFileSync(path.join(workspace, "pom.xml"), "<project />");
  const prompt = prepare();
  expect(prompt).toContain("## Maven build optimization");
  expect(prompt).toContain("-pl <module> -am test");
  expect(store.getSession(session.id).sessionMetadata?.latestSystemPrompt).toBe(prompt);
  fs.unlinkSync(path.join(workspace, "pom.xml"));
  expect(prepare()).not.toContain("## Maven build optimization");
});
