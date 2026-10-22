import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { extensionStore } from "../../extensions/extension-store.js";
import { agentSessionRuntime } from "../session-runtime.js";
import { agentRuntimeStore as store } from "../session-store.js";
import { ToolRegistry } from "../tool-registry.js";
import { LoopComposition } from "../native-capabilities/loop-composition.js";
import { executorInput, explorerSessionInput, resetAgentRuntimeFixtures } from "./agent-runtime-fixtures.js";

let registry: ToolRegistry;
beforeEach(async () => {
  await resetAgentRuntimeFixtures();
  registry = new ToolRegistry();
});
afterEach(() => vi.restoreAllMocks());

it.each(["read", "file.glob", "grep.search", "mcp.disconnected.read"])(
  "records %s as a recoverable tool failure with the original provider identity",
  async (toolId) => {
    const session = agentSessionRuntime.create({ ...executorInput, permissionTier: "unrestricted" });
    const args = { file: "package.json" };
    const result = await registry.execute(session.id, toolId, args, { modelToolCallId: "provider-call" });
    expect(result.record).toMatchObject({
      toolId, modelToolCallId: "provider-call", inputRef: args,
      status: "failed", outputRef: { error: true, code: "TOOL_NOT_FOUND" },
    });
    expect(result.record.error).toContain("current tool");
    expect(result.record.endedAt).toBeTruthy();
    expect(store.listToolCalls(session.id)).toHaveLength(1);
    expect(store.listEvents(session.id)).toContainEqual(expect.objectContaining({
      type: "tool_result", payload: expect.objectContaining({ toolCallId: result.record.id, status: "failed" }),
    }));
    await store.flushSession(session.id);
    await store.hydrateSession(session.id, true);
    expect(store.getToolCall(session.id, result.record.id).outputRef).toMatchObject({ code: "TOOL_NOT_FOUND" });
    const corrected = await registry.execute(session.id, "file.read", { path: "package.json" });
    expect(corrected.record.status, corrected.record.error ?? "").toBe("completed");
  },
);

it("keeps a missing session and an unexpected provider failure fatal", async () => {
  await expect(registry.execute("ars_missing", "read", {})).rejects.toMatchObject({ code: "NOT_FOUND" });
  const session = agentSessionRuntime.create(explorerSessionInput);
  registry.registerProvider({ id: "broken", getTools() { throw new Error("provider storage failed"); }, getHooks: () => [] });
  await expect(registry.execute(session.id, "read", {})).rejects.toThrow("provider storage failed");
  expect(store.listToolCalls(session.id)).toHaveLength(0);
});

it("returns a denial if a project disables a tool after it was advertised", async () => {
  const session = agentSessionRuntime.create(explorerSessionInput);
  expect(registry.listForSession(session.id).some(tool => tool.id === "file.read")).toBe(true);
  extensionStore.setState(session.projectId, "tool", "file.read", { installed: true, enabled: false });
  const result = await registry.execute(session.id, "file.read", { path: "package.json" });
  expect(result.record).toMatchObject({ status: "denied", outputRef: { code: "PERMISSION_ERROR" } });
});

it("records a missing dynamic tool when its provider disconnects after discovery", async () => {
  const session = agentSessionRuntime.create(executorInput);
  const execute = vi.fn(() => ({ result: "unexpected", displaySummary: "unexpected", artifacts: [] }));
  const tool = { ...registry.get("file.read"), id: "mcp.fixture.read", execute };
  let connected = true;
  registry.registerProvider({ id: "fixture", getTools: () => connected ? [tool] : [], getHooks: () => [] });
  expect(registry.getForSession(session.id, tool.id)).toBe(tool);
  connected = false;
  expect((await registry.execute(session.id, tool.id, { path: "unused.txt" })).record).toMatchObject({
    status: "failed", toolId: tool.id, outputRef: { code: "TOOL_NOT_FOUND" },
  });
  expect(execute).not.toHaveBeenCalled();
});

it.each(["removed", "disabled"])("finishes an approved pending call whose tool was %s, without creating another receipt", async (change) => {
  const session = agentSessionRuntime.create(executorInput);
  const execute = vi.fn(() => ({ result: "unexpected", displaySummary: "unexpected", artifacts: [] }));
  registry.register({ ...registry.get("file.write"), execute });
  const pending = await registry.execute(session.id, "file.write", { path: "unused.txt", content: "unused" });
  expect(pending.record.status).toBe("pending");
  if (change === "removed") registry.unregister("file.write");
  else extensionStore.setState(session.projectId, "tool", "file.write", { installed: true, enabled: false });
  const result = await registry.resumePending(session.id, { ...pending.permission!, action: "allow" });
  expect(result.record).toMatchObject({ id: pending.record.id,
    status: change === "removed" ? "failed" : "denied",
    outputRef: { code: change === "removed" ? "TOOL_NOT_FOUND" : "PERMISSION_ERROR" },
  });
  expect(store.listToolCalls(session.id)).toHaveLength(1);
  expect(execute).not.toHaveBeenCalled();
  expect((await registry.resumePending(session.id, { ...pending.permission!, action: "allow" })).record.id).toBe(pending.record.id);
});

it("serializes an unknown operation in a composed batch and leaves dependent writes unexecuted", async () => {
  const session = agentSessionRuntime.create({ ...executorInput, permissionTier: "unrestricted" });
  const run = store.appendRun({ id: "run-resolution", sessionId: session.id, status: "running", model: null,
    startedAt: "2026-10-22T00:00:00Z", completedAt: null, triggerMessageId: null, currentStep: 1, stopReason: null, metadata: {} });
  const step = store.appendRunStep({ id: "step-resolution", sessionId: session.id, runId: run.id, index: 1, status: "running",
    model: null, startedAt: run.startedAt, completedAt: null, finishReason: null, metadata: {} });
  const execute = vi.fn(() => ({ result: "unexpected", displaySummary: "unexpected", artifacts: [] }));
  registry.register({ ...registry.get("file.write"), execute });
  const results = await new LoopComposition(store, registry).execute(session.id, run.id, step.id, [
    { id: "valid-read", toolId: "file.read", args: { path: "package.json" } },
    { id: "bad-read", toolId: "read", args: { file: "package.json" } },
    { id: "write", toolId: "file.write", args: { path: "unused.txt", content: "unused" } },
  ]);
  expect(results.map(result => result.exec.record.status)).toEqual(["completed", "failed"]);
  expect(execute).not.toHaveBeenCalled();
  expect(store.getRunStep(step.id).metadata.composition).toMatchObject({ operations: [
    { state: "settled" }, { state: "settled" }, { state: "cancelled" },
  ] });
});
