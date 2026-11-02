import { afterEach, expect, it, vi } from "vitest";
import { runWithExecutionContext } from "../../../infrastructure/runtime/execution-context.js";
import { toolResourcePolicy, withToolResource } from "../resource-admission.js";
import type { RegisteredTool, ToolExecutionInput } from "../contracts.js";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const context = { sessionId: "s", runId: "r", epoch: "e", hostId: "h" };
const input = { sessionId: "s", runId: "r", toolCallId: "t", args: {} } as ToolExecutionInput;

it.each(["agent.execute", "code.run"])("reserves code capacity for %s without retaining its child's I/O capacity", async id => {
  vi.stubEnv("SYNAX_RUNTIME_PROVIDER_PORT", "1234");
  vi.stubEnv("SYNAX_RUNTIME_SIDECAR_TOKEN", "test");
  const held = new Map<string, string>();
  const admitted: string[] = [];
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    const body = JSON.parse(String(options?.body));
    if (url.endsWith("/release")) {
      expect(held.delete(body.id)).toBe(true);
      return Response.json({ ok: true });
    }
    // Model one slot in each pool; parent and child must never compete for it.
    if ([...held.values()].includes(body.request.resource)) throw new Error("Parent retained the child's resource capacity.");
    held.set(body.request.id, body.request.resource);
    admitted.push(body.request.resource);
    return Response.json({ state: "running", startedAt: Date.now(), deadline: Date.now() + 5_000, queuedAt: Date.now(), queueWaitMs: 0 });
  });
  vi.stubGlobal("fetch", fetcher);
  const result = await runWithExecutionContext(context, () => withToolResource(
    { id, category: "read", mutability: "read" } as RegisteredTool, input, () => {}, () => withToolResource(
      { id: "file.read", category: "read", mutability: "read" } as RegisteredTool, input, () => {}, async () => "contents",
    ),
  ));
  expect(result).toBe("contents");
  expect(fetcher).toHaveBeenCalledTimes(4);
  expect(admitted).toEqual(["code", "io"]);
  expect(held.size).toBe(0);
});

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
  expect(toolResourcePolicy(tool, { timeoutMs })).toEqual({ resource: id === "verification.run" ? "cpu" : "command", timeoutMs: expected });
});

it.each(["agent.execute", "code.run"])("places %s in the global Code Mode pool", id => {
  expect(toolResourcePolicy({ id, category: "read", mutability: "read" } as RegisteredTool, {}))
    .toEqual({ resource: "code", timeoutMs: 60_000 });
});

it.each([
  "rg -n \"without_attachments\" runtime-sidecar/src | head",
  "cd runtime-sidecar && rg -n \"pub struct Reasoning\" src | head",
  "find runtime-sidecar/src -maxdepth 2 -type f | head",
  "git status --short",
  "git -C /tmp/repo --no-pager diff --stat | head",
  "cd client && sed -n 1,100p src/example.tsx",
])("classifies read-only bash inspection as search capacity: %s", command => {
  expect(toolResourcePolicy({ id: "bash", category: "shell", mutability: "read" } as RegisteredTool, { command }))
    .toEqual({ resource: "search", timeoutMs: 35_000 });
});

it.each([
  "cargo test --lib",
  "node scripts/runtime-sidecar-cargo.mjs build --release",
  "npm run test:agent-runtime",
  "cd client && npx cross-env NODE_ENV=test npx vitest run file.test.ts | tail -60",
  "NODE_ENV=test node ../node_modules/vitest/vitest.mjs run example.test.ts",
  "npm --prefix client run build",
  "pnpm exec tsc --noEmit",
])("isolates build and test workloads from ordinary commands: %s", command => {
  expect(toolResourcePolicy({ id: "bash", category: "shell", mutability: "read" } as RegisteredTool, { command }))
    .toEqual({ resource: "cpu", timeoutMs: 630_000 });
});

it.each([
  "rg needle src > output.txt",
  "rg needle src | tee output.txt",
  "rg --pre=python needle src",
  "rg --hostname-bin /tmp/script needle src",
  "find src -type f -delete",
  "find src -exec touch marker ;",
  "awk 'BEGIN {system(\"touch marker\")}'",
  "cat $(touch marker)",
  "cat `touch marker`",
  "rg needle src & unknown-job",
  "env node -e 'process.exit(1)'",
  "git branch new-branch",
  "/tmp/rg needle src",
  "sed -i '' s/a/b/ file",
  "sed -n '1w target' file",
  "sed -n -f script file",
  "git diff --output=patch",
  "git -c alias.read='!touch marker' read",
  "echo 'vitest run test.ts'",
])("keeps unknown or mutating shell programs in command capacity: %s", command => {
  expect(toolResourcePolicy({ id: "bash", category: "shell", mutability: "read" } as RegisteredTool, { command }))
    .toEqual({ resource: "command", timeoutMs: 630_000 });
});

it.each(["mcp", "external_execution"])("keeps %s requests out of local command capacity", category => {
  expect(toolResourcePolicy({ id: "external", category, mutability: "read" } as RegisteredTool, {}))
    .toEqual({ resource: "external", timeoutMs: 300_000 });
});

it("bounds resource queue waiting and releases the request without starting the command", async () => {
  vi.useFakeTimers();
  vi.stubEnv("SYNAX_RUNTIME_PROVIDER_PORT", "1234"); vi.stubEnv("SYNAX_RUNTIME_SIDECAR_TOKEN", "test");
  const action = vi.fn();
  const operations: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, options: RequestInit) => {
    const operation = url.split("/").at(-1)!;
    operations.push(operation);
    if (operation === "release") return Response.json({ ok: true });
    const { request } = JSON.parse(String(options.body));
    expect(request.expiresAt - Date.now()).toBeLessThanOrEqual(60_000);
    return new Promise<Response>((resolve, reject) => {
      const tick = setTimeout(() => resolve(Response.json({ state: "queued" })), 25_000);
      options.signal?.addEventListener("abort", () => { clearTimeout(tick); reject(options.signal?.reason); }, { once: true });
    });
  }));
  const pending = runWithExecutionContext(context, () => withToolResource(
    { id: "bash", category: "shell", mutability: "read" } as RegisteredTool,
    input, () => {}, action,
  ));
  const rejected = expect(pending).rejects.toMatchObject({ code: "RESOURCE_QUEUE_TIMEOUT" });
  await vi.advanceTimersByTimeAsync(60_000);
  await rejected;
  expect(action).not.toHaveBeenCalled();
  expect(operations.at(-1)).toBe("release");
});

it("reports a server queue timeout as a retryable admission failure without executing", async () => {
  vi.stubEnv("SYNAX_RUNTIME_PROVIDER_PORT", "1234"); vi.stubEnv("SYNAX_RUNTIME_SIDECAR_TOKEN", "test");
  const action = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ state: "queue_timeout" })));
  await expect(runWithExecutionContext(context, () => withToolResource(
    { id: "bash", category: "shell", mutability: "read" } as RegisteredTool,
    input, () => {}, action,
  ))).rejects.toMatchObject({ code: "RESOURCE_QUEUE_TIMEOUT" });
  expect(action).not.toHaveBeenCalled();
});

it("keeps an explicit async request queued beyond 60s and cancels without starting it", async () => {
  vi.useFakeTimers();
  vi.stubEnv("SYNAX_RUNTIME_PROVIDER_PORT", "1234"); vi.stubEnv("SYNAX_RUNTIME_SIDECAR_TOKEN", "test");
  const action = vi.fn();
  const operations: string[] = [];
  const abort = new AbortController();
  let first = true;
  vi.stubGlobal("fetch", vi.fn(async (url: string, options: RequestInit) => {
    const operation = url.split("/").at(-1)!;
    operations.push(operation);
    if (operation === "release") return Response.json({ ok: true });
    if (first) {
      const { request } = JSON.parse(String(options.body));
      expect(request.expiresAt - Date.now()).toBe(300_000);
      first = false;
    }
    return new Promise<Response>((resolve, reject) => {
      const tick = setTimeout(() => resolve(Response.json({ state: "queued" })), 25_000);
      options.signal?.addEventListener("abort", () => { clearTimeout(tick); reject(options.signal?.reason); }, { once: true });
    });
  }));
  const pending = runWithExecutionContext(context, () => withToolResource(
    { id: "bash", category: "shell", mutability: "read" } as RegisteredTool,
    { ...input, args: { command: "sleep 1", async: true }, abortSignal: abort.signal }, () => {}, action,
  ));
  const rejected = expect(pending).rejects.toThrow("cancel queued task");
  await vi.advanceTimersByTimeAsync(65_000);
  expect(action).not.toHaveBeenCalled();
  expect(operations).not.toContain("release");
  abort.abort(new Error("cancel queued task"));
  await rejected;
  expect(operations.at(-1)).toBe("release");
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
