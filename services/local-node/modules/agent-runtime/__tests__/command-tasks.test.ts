import { afterEach, expect, it, vi } from "vitest";
import { CommandTasks, COMMAND_MONITOR_MS, pendingCommandReason } from "../command-tasks.js";
import type { AgentRun, AgentRuntimeMessage, ToolCallRecord, ToolExecutionInput } from "../contracts.js";
import type { AgentRuntimeStore } from "../session-store.js";
import type { ExecuteToolResult } from "../tool-registry.js";

afterEach(() => vi.useRealTimers());
function fixture() {
  vi.useFakeTimers();
  let run = { id: "run", sessionId: "session", metadata: {} } as AgentRun;
  let record = { id: "command", sessionId: "session", runId: "run", toolId: "bash", status: "running", outputRef: null } as ToolCallRecord;
  const messages: AgentRuntimeMessage[] = [];
  const store = {
    getRun: () => run,
    updateRun: (_id: string, patch: Partial<AgentRun>) => run = { ...run, ...patch },
    getToolCall: () => record,
    updateToolCall: (_sessionId: string, _id: string, patch: Partial<ToolCallRecord>) => record = { ...record, ...patch },
    listMessages: () => messages,
    appendMessage: (message: AgentRuntimeMessage) => { messages.push(message); return message; },
  };
  const manager = new CommandTasks(store as unknown as AgentRuntimeStore);
  let settle!: (result: ExecuteToolResult) => void;
  const closed = new Promise<ExecuteToolResult>(resolve => { settle = resolve; });
  const finish = (status: ToolCallRecord["status"] = "completed") => {
    record = { ...record, status, outputRef: { exitCode: status === "completed" ? 0 : null, stdout: "build output" } };
    settle({ record });
  };
  let executionSignal: AbortSignal | undefined;
  let start!: () => void;
  const execute = vi.fn((signal?: AbortSignal, started?: () => void) => {
    executionSignal = signal;
    start = () => started?.();
    return closed;
  });
  const manage = (action: string, extra: Record<string, unknown> = {}) => manager.tool().execute({
    sessionId: "session", runId: "run", stepId: "next-step", toolCallId: "manage", toolId: "command.manage",
    category: "context", mutability: "read", args: { commandTaskId: "command", action, reason: "Dependency assessment", ...extra },
  } satisfies ToolExecutionInput);
  return { store, manager, execute, manage, finish, start: () => start(), signal: () => executionSignal,
    fail: () => { record = { ...record, status: "failed", error: "Command cancelled" }; settle({ record }); },
    launch: (args: unknown = { command: "build" }, signal?: AbortSignal) => manager.execute(record, args, signal, execute) };
}

it("starts the 120s monitor after admission and yields a running receipt without completing the command", async () => {
  const f = fixture();
  const promise = f.launch();
  let returned = false;
  void promise.then(() => { returned = true; });
  await vi.advanceTimersByTimeAsync(COMMAND_MONITOR_MS * 2);
  expect(returned).toBe(false);
  f.start();
  await vi.advanceTimersByTimeAsync(COMMAND_MONITOR_MS - 1);
  expect(returned).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect((await promise).record.status).toBe("running");
  expect(f.signal()?.aborted).toBe(false);
  expect(f.manager.toolError("run", "file.write")).toContain("command.manage");
  expect(pendingCommandReason(f.store.getRun())).not.toBeNull();
  f.finish();
  await vi.advanceTimersByTimeAsync(0);
});

it("requires an independent next step before backgrounding and delivers completion exactly once", async () => {
  const f = fixture();
  const running = f.launch(); f.start();
  await vi.advanceTimersByTimeAsync(COMMAND_MONITOR_MS); await running;
  await expect(f.manage("background")).rejects.toThrow("independent nextStep");
  await f.manage("background", { nextStep: "Read unrelated documentation" });
  expect(f.manager.toolError("run", "file.read")).toBeNull();
  expect(f.manager.toolError("run", "goal.finish")).not.toBeNull();
  expect(f.manager.stepContext("session", "run", 2)).toContain('"state":"background"');
  f.finish(); await vi.advanceTimersByTimeAsync(0);
  expect(pendingCommandReason(f.store.getRun())).not.toBeNull();
  const context = f.manager.stepContext("session", "run", 3);
  expect(context).toContain("build output");
  expect(f.store.listMessages()).toHaveLength(1);
  expect(f.manager.stepContext("session", "run", 3)).toContain("build output");
  expect(f.store.listMessages()).toHaveLength(1);
  expect(f.manager.stepContext("session", "run", 4)).toBeNull();
  expect(pendingCommandReason(f.store.getRun())).toBeNull();
  expect(f.execute).toHaveBeenCalledTimes(1);
});

it("waits for a dependency and retains failure evidence", async () => {
  const f = fixture(); const running = f.launch(); f.start();
  await vi.advanceTimersByTimeAsync(COMMAND_MONITOR_MS); await running;
  let returned = false;
  const waiting = Promise.resolve(f.manage("wait")).then(result => { returned = true; return result; });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(returned).toBe(false);
  f.finish("failed");
  expect((await waiting).result).toMatchObject({ status: "failed" });
  expect(f.manager.stepContext("session", "run", 2)).toContain('"status":"failed"');
});

it("does not create a task for a fast command or an explicit short hard deadline", async () => {
  const fast = fixture(); const running = fast.launch(); fast.start();
  fast.finish(); await running;
  await vi.advanceTimersByTimeAsync(COMMAND_MONITOR_MS);
  expect(fast.store.getRun().metadata.commandTasks).toBeUndefined();
  const short = fixture(); const timed = short.launch({ command: "build", timeoutMs: 1_000 }); short.start();
  await vi.advanceTimersByTimeAsync(COMMAND_MONITOR_MS);
  expect(short.store.getRun().metadata.commandTasks).toBeUndefined();
  short.finish("failed"); await timed;
});

it("keeps cancellation ownership after handoff and waits for actual process close", async () => {
  const f = fixture(); const controller = new AbortController();
  const running = f.launch(undefined, controller.signal); f.start();
  await vi.advanceTimersByTimeAsync(COMMAND_MONITOR_MS); await running;
  await f.manage("background", { nextStep: "Read docs" });
  controller.abort();
  expect(f.signal()?.aborted).toBe(true);
  let stopped = false;
  const stopping = f.manager.stopRun("run").then(() => { stopped = true; });
  await vi.advanceTimersByTimeAsync(1);
  expect(stopped).toBe(false);
  f.finish("cancelled"); await stopping;
  expect(stopped).toBe(true);
});

it("cancel targets the owned command and rejects a foreign task", async () => {
  const f = fixture(); const running = f.launch(); f.start();
  await vi.advanceTimersByTimeAsync(COMMAND_MONITOR_MS); await running;
  await expect(f.manage("cancel", { commandTaskId: "other" })).rejects.toThrow("does not belong");
  const cancelled = f.manage("cancel");
  expect(f.signal()?.aborted).toBe(true);
  f.finish("cancelled"); await cancelled;
});

it("recovers a lost worker as interrupted without replaying the command", async () => {
  const f = fixture(); const running = f.launch(); f.start();
  await vi.advanceTimersByTimeAsync(COMMAND_MONITOR_MS); await running;
  const recovered = new CommandTasks(f.store as unknown as AgentRuntimeStore);
  expect(recovered.stepContext("session", "run", 3)).toContain("interrupted");
  expect(f.store.getToolCall().status).toBe("cancelled");
  expect(f.execute).toHaveBeenCalledTimes(1);
  f.finish("cancelled"); await vi.advanceTimersByTimeAsync(0);
});

it("replays the same protocol receipt even after a background command fails", async () => {
  const f = fixture(); const running = f.launch(); f.start();
  await vi.advanceTimersByTimeAsync(COMMAND_MONITOR_MS);
  const handoff = await running;
  f.finish("failed"); await vi.advanceTimersByTimeAsync(0);
  const replay = f.manager.receipt(f.store.getToolCall());
  expect(replay?.toolResult).toEqual(handoff.toolResult);
  expect(replay?.record.status).toBe("running");
  expect(f.store.getToolCall().status).toBe("failed");
  expect(f.manager.stepContext("session", "run", 3)).toContain('"status":"failed"');
});

it("replaces the monitoring placeholder with a cancellation error in the terminal receipt", async () => {
  const f = fixture(); const running = f.launch(); f.start();
  await vi.advanceTimersByTimeAsync(COMMAND_MONITOR_MS); await running;
  f.fail(); await vi.advanceTimersByTimeAsync(0);
  expect(f.store.getToolCall().outputRef).toEqual({ error: true, message: "Command cancelled" });
  expect(f.manager.stepContext("session", "run", 3)).toContain("Command cancelled");
});

it("hands off explicit async commands at startup, even with a short hard timeout, and reuses the completion queue", async () => {
  const f = fixture();
  const running = f.launch({ command: "build", async: true, timeoutMs: 1_000 });
  let returned = false;
  void running.then(() => { returned = true; });
  await vi.advanceTimersByTimeAsync(10);
  expect(returned).toBe(false); // Validation/admission must finish first.
  f.start();
  const handoff = await running;
  expect(handoff.record.status).toBe("running");
  expect(handoff.toolResult?.result).toMatchObject({ commandTaskId: "command", state: "background", elapsedMs: 0, async: true, completionHook: "next_step" });
  expect(f.manager.toolError("run", "file.read")).toBeNull();
  expect(f.manager.toolError("run", "goal.finish")).not.toBeNull();
  expect(vi.getTimerCount()).toBe(0);
  f.finish(); await vi.advanceTimersByTimeAsync(0);
  expect(f.manager.stepContext("session", "run", 2)).toContain("build output");
  expect(f.store.listMessages()).toHaveLength(1);
  expect(f.manager.stepContext("session", "run", 3)).toBeNull();
  expect(pendingCommandReason(f.store.getRun())).toBeNull();
  expect(f.execute).toHaveBeenCalledTimes(1);
});

it("async:false keeps foreground waiting and the existing 120s assessment", async () => {
  const f = fixture(); const running = f.launch({ command: "build", async: false }); f.start();
  let returned = false;
  void running.then(() => { returned = true; });
  await vi.advanceTimersByTimeAsync(COMMAND_MONITOR_MS - 1);
  expect(returned).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect((await running).toolResult?.result).toMatchObject({ state: "assessment_required", async: false });
  f.finish(); await vi.advanceTimersByTimeAsync(0);
});

it("wait and cancel control an explicitly asynchronous command without relaunching", async () => {
  const f = fixture(); const running = f.launch({ command: "build", async: true }); f.start(); await running;
  let waited = false;
  const waiting = Promise.resolve(f.manage("wait")).then(result => { waited = true; return result; });
  await vi.advanceTimersByTimeAsync(1);
  expect(waited).toBe(false);
  const cancellation = f.manage("cancel");
  expect(f.signal()?.aborted).toBe(true);
  f.fail(); await cancellation;
  expect((await waiting).result).toMatchObject({ status: "failed", error: "Command cancelled" });
  expect(f.store.getToolCall().outputRef).toEqual({ error: true, message: "Command cancelled" });
  expect(f.execute).toHaveBeenCalledTimes(1);
});

it("returns a pre-start failure without creating an async task", async () => {
  const f = fixture(); const running = f.launch({ command: "invalid", async: true });
  f.fail();
  expect((await running).record.status).toBe("failed");
  expect(f.store.getRun().metadata.commandTasks).toBeUndefined();
  expect(vi.getTimerCount()).toBe(0);
});
