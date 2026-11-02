import { expect, it, vi } from "vitest";
import { LoopComposition } from "./loop-composition.js";
import type { AgentRuntimeStore } from "../session-store.js";
import type { ToolRegistry } from "../tool-registry.js";

vi.mock("../code-mode/policy.js", () => ({ canComposeTool: () => false }));

it.each(["background", "assessment_required"])("continues the tool batch only after an explicit async decision (%s)", async state => {
  let step = { metadata: {} as Record<string, unknown> };
  const store = {
    getRunStep: () => step,
    updateRunStep: (_id: string, patch: typeof step) => { step = patch; },
    getSession: () => ({ id: "session", sessionMetadata: {} }),
  };
  const execute = vi.fn(async (_session: string, toolId: string) => ({
    record: { id: toolId, status: toolId === "bash" ? "running" : "completed" },
    toolResult: { result: toolId === "bash" ? { state, commandTaskId: "bash" } : {}, artifacts: [], displaySummary: "fixture" },
  }));
  const registry = { getForSession: () => ({ mutability: "read" }), execute };
  const composition = new LoopComposition(store as unknown as AgentRuntimeStore, registry as unknown as ToolRegistry);
  const calls = [
    { id: "command", toolId: "bash", args: { command: "build", async: state === "background" } },
    { id: "next", toolId: "task.list", args: {} },
  ];
  await composition.execute("session", "run", "step", calls);
  expect(execute.mock.calls.map(([, tool]) => tool)).toEqual(state === "background" ? ["bash", "task.list"] : ["bash"]);
  await composition.execute("session", "run", "step", calls);
  expect(execute).toHaveBeenCalledTimes(state === "background" ? 2 : 1);
});


it.each([false, true])("does not replay a blocked receipt or execute its dependent tail (recovery=%s)", async recovery => {
  const calls = [
    { id: "message", toolId: "subagent.lifecycle", args: {} },
    { id: "dependent", toolId: "task.update", args: {} },
  ];
  const record = { id: "busy", status: "blocked", outputRef: { accepted: false } };
  let step = { metadata: recovery ? { composition: { version: 1, operations: [
    { call: calls[0], state: "running", recordId: "busy" }, { call: calls[1], state: "queued" },
  ] } } as Record<string, unknown> : {} as Record<string, unknown> };
  const store = {
    getRunStep: () => step,
    updateRunStep: (_id: string, patch: typeof step) => { step = patch; },
    getSession: () => ({ id: "session", sessionMetadata: {} }),
    getToolCall: () => record,
  };
  const execute = vi.fn(async () => ({ record }));
  const registry = { getForSession: () => ({ mutability: "task" }), execute };
  const composition = new LoopComposition(store as unknown as AgentRuntimeStore, registry as unknown as ToolRegistry);
  expect(await composition.execute("session", "run", "step", calls)).toEqual([{ call: calls[0], exec: { record } }]);
  await composition.execute("session", "run", "step", calls);
  expect(execute).toHaveBeenCalledTimes(recovery ? 0 : 1);
  expect(step.metadata.composition).toMatchObject({ operations: [
    { state: "settled", recordId: "busy" }, { state: "cancelled" },
  ] });
});
