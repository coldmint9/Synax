import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as orchestrator from "../subagent-orchestrator.js";
import { agentSessionRuntime } from "../session-runtime.js";
import { agentRuntimeStore as store } from "../session-store.js";
import { toolRegistry } from "../tool-registry.js";
import { ensureSynaxAgentRegistered } from "../synax/index.js";
import { buildConsecutiveFailureReminder } from "../loop-guards.js";
import { resetAgentRuntimeFixtures, explorerSessionInput } from "./agent-runtime-fixtures.js";

const releases: Array<() => void> = [];
beforeEach(async () => {
  await resetAgentRuntimeFixtures();
  ensureSynaxAgentRegistered();
  vi.spyOn(orchestrator, "runChildToCompletion").mockImplementation((childSessionId, spec) =>
    new Promise(resolve => releases.push(() => resolve({ childSessionId, spec, status: "completed", summary: "done", error: null }))));
});
afterEach(async () => {
  releases.splice(0).forEach(release => release());
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  vi.restoreAllMocks();
});
function tree() {
  const parent = agentSessionRuntime.create({ projectId: "project-alpha", profileId: "synax", prompt: "Parent",
    permissionTier: "unrestricted", sessionMetadata: { mode: "chat" } });
  const child = agentSessionRuntime.create({ ...explorerSessionInput, parentSessionId: parent.id });
  store.updateSession(child.id, { status: "completed" });
  return { parent, child };
}

it("persists a non-error terminal receipt without sending, queueing or restarting a busy child", async () => {
  const { parent, child } = tree();
  const args = { action: "message", childSessionId: child.id, message: "First instruction" };
  expect((await toolRegistry.execute(parent.id, "subagent.lifecycle", args)).record.status).toBe("completed");
  store.updateSession(child.id, { status: "running" });
  const before = structuredClone(store.getSession(child.id));
  const messages = store.listMessages(child.id);
  const result = await toolRegistry.execute(parent.id, "subagent.lifecycle", { ...args, message: "Finish now" });
  expect(result.record).toMatchObject({ status: "blocked", error: null, outputRef: {
    code: "SUBAGENT_BUSY", reason: "subagent_running", status: "not_executed", childSessionId: child.id,
    accepted: false, queued: false, nextActions: ["wait", "pause"],
  } });
  expect(result.record.endedAt).not.toBeNull();
  expect(result.toolResult?.result).toEqual(result.record.outputRef);
  expect(store.getSession(child.id)).toEqual(before);
  expect(store.listMessages(child.id)).toEqual(messages);
  expect(orchestrator.runChildToCompletion).toHaveBeenCalledTimes(1);
  expect(store.listEvents(parent.id)).toEqual(expect.arrayContaining([expect.objectContaining({
    type: "tool_result", payload: expect.objectContaining({ toolCallId: result.record.id, status: "blocked" }),
  })]));
  await store.flushSession(parent.id);
  await store.hydrateExecutionSession(parent.id, true);
  expect(store.getToolCall(parent.id, result.record.id)).toMatchObject({ status: "blocked", error: null, outputRef: result.record.outputRef });
  expect(buildConsecutiveFailureReminder(Array.from({ length: 3 }, (_, i) => ({ ...result.record, id: `busy-${i}`, stepId: `step-${i}` })))).toBeNull();
});

it("accepts a new instruction once the child has settled, even if the session row trails", async () => {
  const { parent, child } = tree();
  const args = { action: "message", childSessionId: child.id, message: "First instruction" };
  await toolRegistry.execute(parent.id, "subagent.lifecycle", args);
  store.updateSession(child.id, { status: "running" });
  store.updateSessionMetadata(child.id, { subagentTask: { state: "completed" } });
  const next = await toolRegistry.execute(parent.id, "subagent.lifecycle", { ...args, message: "Follow up" });
  expect(next.record.status).toBe("completed");
  expect(store.getSession(child.id).prompt).toBe("Follow up");
  expect(orchestrator.runChildToCompletion).toHaveBeenCalledTimes(2);
});

it.each(["queued", "running", "waiting_permission", "waiting_input"] as const)(
  "does not message an unsettled %s child owned by another worker", async status => {
    const { parent, child } = tree();
    store.updateSession(child.id, { status });
    const before = structuredClone(store.getSession(child.id));
    const result = await toolRegistry.execute(parent.id, "subagent.lifecycle", {
      action: "message", childSessionId: child.id, message: "Must not be sent",
    });
    expect(result.record).toMatchObject({ status: "blocked", error: null, outputRef: { accepted: false, queued: false } });
    expect(orchestrator.runChildToCompletion).not.toHaveBeenCalled();
    expect(store.getSession(child.id)).toEqual(before);
  },
);

it("retains real validation and ownership errors instead of converting all errors to blocked", async () => {
  const { parent, child } = tree();
  for (const args of [
    { action: "message", childSessionId: child.id },
    { action: "message", childSessionId: "missing-child", message: "Hello" },
    { action: "message", childSessionId: parent.id, message: "Hello" },
  ]) expect((await toolRegistry.execute(parent.id, "subagent.lifecycle", args)).record.status).toBe("failed");
  expect(orchestrator.runChildToCompletion).not.toHaveBeenCalled();
});
