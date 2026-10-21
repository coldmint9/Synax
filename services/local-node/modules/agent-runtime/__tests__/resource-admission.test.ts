import { afterEach, expect, it, vi } from "vitest";
import { runWithExecutionContext } from "../../../infrastructure/runtime/execution-context.js";
import { withToolResource } from "../resource-admission.js";
import type { RegisteredTool, ToolExecutionInput } from "../contracts.js";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const context = { sessionId: "s", runId: "r", epoch: "e", hostId: "h" };
const input = { sessionId: "s", runId: "r", toolCallId: "t", args: {} } as ToolExecutionInput;

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
  expect(operations).toEqual(["request"]);
  stop(); await pending;
  expect(operations).toEqual(["request", "release"]);
});

it("does not reserve an execution slot while a parent waits for a child", async () => {
  const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
  const result = await runWithExecutionContext(context, () => withToolResource({ id: "task.wait", category: "task", mutability: "task" } as RegisteredTool,
    input, () => {}, async () => "child finished"));
  expect(result).toBe("child finished"); expect(fetchMock).not.toHaveBeenCalled();
});
