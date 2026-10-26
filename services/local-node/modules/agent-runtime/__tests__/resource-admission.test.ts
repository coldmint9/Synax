import { afterEach, expect, it, vi } from "vitest";
import { runWithExecutionContext } from "../../../infrastructure/runtime/execution-context.js";
import { toolResourcePolicy, withToolResource } from "../resource-admission.js";
import type { RegisteredTool, ToolExecutionInput } from "../contracts.js";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const context = { sessionId: "s", runId: "r", epoch: "e", hostId: "h" };
const input = { sessionId: "s", runId: "r", toolCallId: "t", args: {} } as ToolExecutionInput;

it.each([
  ["bash", undefined, 630_000],
  ["verification.run", undefined, 630_000],
  ["bash", 450_000, 480_000],
  ["bash", 120_000, 150_000],
  ["verification.run", 1_000, 31_000],
  ["bash", 1, 31_000],
  ["bash", 900_000, 630_000],
  ["bash", Number.NaN, 630_000],
])("allows command setup and cleanup for %s timeout %s", (id, timeoutMs, expected) => {
  const tool = { id, category: "shell", mutability: "read" } as RegisteredTool;
  expect(toolResourcePolicy(tool, { timeoutMs })).toEqual({ resource: "command", timeoutMs: expected });
});

it("keeps a timed-out tool's lease until its cooperative cleanup settles", async () => {
  vi.useFakeTimers();
  vi.stubEnv("SYNAX_RUNTIME_PROVIDER_PORT", "1234"); vi.stubEnv("SYNAX_RUNTIME_SIDECAR_TOKEN", "test");
  const operations: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    operations.push(url.split("/").at(-1)!);
    return Response.json({ state: "running", startedAt: Date.now(), deadline: Date.now() + 100, queuedAt: Date.now(), queueWaitMs: 0 });
  }));
  let enter!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  let finish!: () => void;
  const cleanup = new Promise<void>(resolve => { finish = resolve; });
  let toolSignal: AbortSignal | undefined;
  const pending = runWithExecutionContext(context, () => withToolResource({ id: "file.read", category: "read", mutability: "read" } as RegisteredTool,
    input, () => {}, async signal => { toolSignal = signal; enter(); await cleanup; return "settled"; }));
  const rejected = expect(pending).rejects.toThrow("Tool execution exceeded");
  await entered;
  await vi.advanceTimersByTimeAsync(100);
  expect(toolSignal?.aborted).toBe(true);
  expect(operations).toEqual(["wait"]);
  finish();
  await rejected;
  expect(operations).toEqual(["wait", "release"]);
});

it("waits for the underlying tool to stop before releasing its lease", async () => {
  vi.stubEnv("SYNAX_RUNTIME_PROVIDER_PORT", "1234"); vi.stubEnv("SYNAX_RUNTIME_SIDECAR_TOKEN", "test");
  let stop!: () => void; let entered!: () => void;
  const started = new Promise<void>(yes => { entered = yes; });
  const stopped = new Promise<void>(yes => { stop = yes; });
  const operations: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    operations.push(url.split("/").at(-1)!);
    return Response.json({ state: "running", startedAt: Date.now(), deadline: Date.now() + 60_000, queuedAt: Date.now(), queueWaitMs: 0 });
  }));
  const abort = new AbortController();
  const pending = runWithExecutionContext(context, () => withToolResource({ id: "file.read", category: "read", mutability: "read" } as RegisteredTool,
    { ...input, abortSignal: abort.signal }, () => {}, async () => { entered(); await stopped; return "result"; }));
  await started; abort.abort();
  expect(operations).toEqual(["wait"]);
  stop(); await pending;
  expect(operations).toEqual(["wait", "release"]);
});

it("does not reserve an execution slot while a parent waits for a child", async () => {
  const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
  const result = await runWithExecutionContext(context, () => withToolResource({ id: "task.wait", category: "task", mutability: "task" } as RegisteredTool,
    input, () => {}, async () => "child finished"));
  expect(result).toBe("child finished"); expect(fetchMock).not.toHaveBeenCalled();
});
