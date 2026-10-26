import { afterEach, expect, it, vi } from "vitest";
import { ToolRegistry } from "../tool-registry.js";
import { agentRuntimeStore as store } from "../session-store.js";
import { agentSessionRuntime } from "../session-runtime.js";
import { executorInput, resetAgentRuntimeFixtures } from "./agent-runtime-fixtures.js";
import { COMMAND_MONITOR_MS } from "../command-tasks.js";
import type { ToolExecutionResult } from "../contracts.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setSessionWorkspaceRoot, clearSessionWorkspaceRoot } from "../tools/workspace.js";

afterEach(() => vi.restoreAllMocks());

it.each([false, true])("keeps the original execution alive through independent work and aggregation (async=%s)", async (asynchronous) => {
  await resetAgentRuntimeFixtures();
  const session = agentSessionRuntime.create({ ...executorInput, permissionTier: "unrestricted" });
  const run = store.appendRun({ id: "monitored-run", sessionId: session.id, status: "running", startedAt: new Date().toISOString(),
    completedAt: null, triggerMessageId: null, currentStep: 1, stopReason: null, model: null, metadata: {} });
  store.updateSession(session.id, { activeRunId: run.id, status: "running" });
  const registry = new ToolRegistry();
  let complete!: (result: ToolExecutionResult) => void;
  const command = new Promise<ToolExecutionResult>(resolve => { complete = resolve; });
  let commandSignal: AbortSignal | undefined;
  registry.register({ ...registry.get("bash"), execute: input => {
    commandSignal = input.abortSignal;
    input.onCommandStarted?.();
    return command;
  } });
  const realTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: (...args: unknown[]) => void, timeout?: number, ...args: unknown[]) =>
    realTimeout(handler, timeout === COMMAND_MONITOR_MS ? 10 : timeout, ...args)) as typeof setTimeout);
  const options = { runId: run.id };
  const monitored = await registry.execute(session.id, "bash", { command: "echo fixture", async: asynchronous,
    ...(asynchronous ? { timeoutMs: 1_000 } : {}) }, options);
  expect(monitored.record.status).toBe("running");
  expect(commandSignal?.aborted).toBe(false);
  if (!asynchronous) {
    const blocked = await registry.execute(session.id, "task.list", {}, options);
    expect(blocked.record.status).toBe("denied");
    expect(blocked.record.error).toContain("command.manage");
    const detached = await registry.execute(session.id, "command.manage", {
      commandTaskId: monitored.record.id, action: "background", reason: "The pending check does not change task metadata", nextStep: "Inspect task list",
    }, options);
    expect(detached.record.status).toBe("completed");
  }
  expect((await registry.execute(session.id, "task.list", {}, options)).record.status).toBe("completed");
  expect(store.getToolCall(session.id, monitored.record.id).status).toBe("running");
  complete({ result: { exitCode: 0, stdout: "verified once" }, displaySummary: "Command completed", artifacts: [] });
  await vi.waitFor(() => expect(store.getToolCall(session.id, monitored.record.id).status).toBe("completed"), { timeout: 10_000 });
  expect(registry.commandTasks.stepContext(session.id, run.id, 3)).toContain("verified once");
  expect(store.listMessages(session.id).filter(message => message.metadata.source === "command_completion")).toHaveLength(1);
  expect(store.listToolCalls(session.id).filter(call => call.toolId === "bash")).toHaveLength(1);
  await registry.commandTasks.stopRun(run.id);
}, 30_000);

it("runs a real async shell once, captures stdout/stderr and honors explicit wait", async () => {
  await resetAgentRuntimeFixtures();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "synax-async-bash-"));
  const session = agentSessionRuntime.create({ ...executorInput, permissionTier: "unrestricted" });
  setSessionWorkspaceRoot(session.id, root);
  const run = store.appendRun({ id: "async-shell-run", sessionId: session.id, status: "running", startedAt: new Date().toISOString(),
    completedAt: null, triggerMessageId: null, currentStep: 1, stopReason: null, model: null, metadata: {} });
  store.updateSession(session.id, { activeRunId: run.id, status: "running" });
  const registry = new ToolRegistry();
  // A filesystem barrier proves the tool returned while the actual process
  // was still executing, without a fragile wall-clock latency assertion.
  fs.writeFileSync(path.join(root, "command.cjs"), `const fs = require('node:fs');
fs.appendFileSync('starts', 'started\\n');
const timer = setInterval(() => {
  if (!fs.existsSync('release')) return;
  clearInterval(timer);
  console.log('async stdout; CI=' + process.env.CI);
  console.error('async stderr');
}, 10);
`);
  try {
    const handoff = await registry.execute(session.id, "bash", { command: "node command.cjs", async: true, timeoutMs: 15_000 }, { runId: run.id });
    expect(handoff.record.status).toBe("running");
    expect(handoff.toolResult?.result).toMatchObject({ commandTaskId: handoff.record.id, state: "background", async: true });
    await vi.waitFor(() => expect(fs.existsSync(path.join(root, "starts"))).toBe(true), { timeout: 10_000 });
    expect(store.getToolCall(session.id, handoff.record.id).status).toBe("running");
    fs.writeFileSync(path.join(root, "release"), "ready");
    const waited = await registry.execute(session.id, "command.manage", { commandTaskId: handoff.record.id,
      action: "wait", reason: "Need the command result for aggregation" }, { runId: run.id });
    expect(waited.record.status).toBe("completed");
    expect(waited.toolResult?.result).toMatchObject({ status: "completed", result: {
      exitCode: 0, stdout: "async stdout; CI=1\n", stderr: "async stderr\n",
    } });
    expect(fs.readFileSync(path.join(root, "starts"), "utf8")).toBe("started\n");
    expect(registry.commandTasks.stepContext(session.id, run.id, 2)).toContain("async stdout");
    expect(registry.commandTasks.stepContext(session.id, run.id, 3)).toBeNull();
  } finally {
    await registry.commandTasks.stopRun(run.id);
    clearSessionWorkspaceRoot(session.id);
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
