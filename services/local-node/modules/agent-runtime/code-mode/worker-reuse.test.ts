import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeCode } from "./executor.js";
import { CodeWorkerPool } from "./worker-pool.js";

const pools: CodeWorkerPool[] = [];
const host = async (_id: string, args: Record<string, unknown>) => args;
function pool(options: ConstructorParameters<typeof CodeWorkerPool>[0] = {}) {
  const instance = new CodeWorkerPool(options);
  pools.push(instance);
  return instance;
}
afterEach(async () => { await Promise.all(pools.splice(0).map(instance => instance.close())); });

describe("Code Mode reusable sandbox", () => {
  it("runs tool policy and execution in the current caller's async context", async () => {
    const workers = pool();
    const context = new AsyncLocalStorage<string>();
    const policyContexts: Array<string | undefined> = [];
    for (const run of ["session-a/run-1", "session-b/run-2"]) {
      const result = await context.run(run, () => executeCode({
        code: 'return await tools.call("read",{});',
        canParallelTool: () => { policyContexts.push(context.getStore()); return true; },
        callTool: async () => context.getStore(),
      }, workers));
      expect(result).toMatchObject({ status: "completed", value: run });
    }
    expect(policyContexts).toEqual(["session-a/run-1", "session-b/run-2"]);
    expect(workers.snapshot().created).toBe(1);
  });
  it("reuses the thread while clearing globals, prototypes, logs and handles", async () => {
    const workers = pool();
    expect((await executeCode({ code: 'globalThis.secret=42; Object.prototype.leak=42; JSON.stringify=()=>"poison"; console.log("old log"); return 1;', callTool: host }, workers)).status).toBe("completed");
    const next = await executeCode({
      code: 'return {secret:typeof secret,leak:({}).leak??null,json:JSON.stringify({a:1}),tool:await tools.call("read",{a:2})};', callTool: host,
    }, workers);
    expect(next).toMatchObject({ status: "completed", stdout: "", value: { secret: "undefined", leak: null, json: '{"a":1}', tool: { a: 2 } } });
    expect(workers.snapshot()).toMatchObject({ created: 1, reused: 1, idle: 1 });
  });

  it("does not accumulate RPC handles or host event listeners across warm runs", async () => {
    const workers = pool();
    for (let i = 0; i < 100; i++) {
      const result = await executeCode({
        code: 'return (await Promise.all(Array.from({length:32},(_,n)=>tools.call("read",{n})))).length;',
        callTool: host, canParallelTool: () => true,
      }, workers);
      expect(result).toMatchObject({ status: "completed", value: 32 });
    }
    expect(workers.snapshot()).toMatchObject({ created: 1, reused: 99, idle: 1 });
    const borrowed = await workers.acquire(1_000);
    if (borrowed.status !== "acquired") throw new Error(borrowed.error);
    expect(borrowed.lease.worker.listenerCount("message")).toBe(0);
    expect(borrowed.lease.worker.listenerCount("error")).toBe(1);
    expect(borrowed.lease.worker.listenerCount("exit")).toBe(1);
    await borrowed.lease.release();
    expect(workers.snapshot().workers).toBe(0);
  });

  it("keeps both slots warm during sustained concurrent batches", async () => {
    const workers = pool();
    for (let round = 0; round < 4; round++) {
      const results = await Promise.all(Array.from({ length: 8 }, () => executeCode({
        code: 'return await tools.call("read",{});',
        callTool: async () => { await new Promise(resolve => setTimeout(resolve, 2)); return true; },
      }, workers)));
      expect(results.every(result => result.status === "completed")).toBe(true);
    }
    expect(workers.snapshot()).toMatchObject({ workers: 2, idle: 2, created: 2, reused: 30 });
  });

  it.each([
    ["return (((;", {}, "failed"],
    ['return new Array(1e7).fill("big");', { memoryBytes: 4 * 1024 * 1024 }, "failed"],
    ["while(true){}", { timeoutMs: 100 }, "timed_out"],
  ] as const)("retires a warm worker after a failed run: %s", async (code, limits, status) => {
    const workers = pool();
    await executeCode({ code: "return 1;", callTool: host }, workers);
    expect((await executeCode({ code, limits, callTool: host }, workers)).status).toBe(status);
    expect(workers.snapshot().workers).toBe(0);
    expect((await executeCode({ code: "return 2;", callTool: host }, workers)).value).toBe(2);
    expect(workers.snapshot().created).toBe(2);
  });

  it("retires a successful run whose WASM heap grew beyond the idle budget", async () => {
    const workers = pool();
    const result = await executeCode({ code: 'const bytes=new Uint8Array(20*1024*1024);bytes.fill(7);return bytes.length;', callTool: host }, workers);
    expect(result).toMatchObject({ status: "completed", value: 20 * 1024 * 1024 });
    expect(workers.snapshot().workers).toBe(0);
  });

  it("ignores a stale RPC reply on the same reused thread", async () => {
    const workers = pool();
    await executeCode({ code: "return true;", callTool: host }, workers);
    const borrowed = await workers.acquire(1_000);
    if (borrowed.status !== "acquired") throw new Error(borrowed.error);
    const { worker, runId } = borrowed.lease;
    await borrowed.lease.release({ wasmBytes: 16 * 1024 * 1024 });
    const ready = Promise.withResolvers<void>(), answer = Promise.withResolvers<string>();
    const pending = executeCode({ code: 'return await tools.call("read",{});', callTool: async () => { ready.resolve(); return answer.promise; } }, workers);
    await ready.promise;
    worker.postMessage({ type: "reply", runId, id: 1, json: '"stale"' });
    answer.resolve("current");
    expect(await pending).toMatchObject({ status: "completed", value: "current" });
    expect(workers.snapshot().created).toBe(1);
  });

  it("cancels the active run and queued programs when the pool closes", async () => {
    const workers = pool({ maxWorkers: 1 });
    const ready = Promise.withResolvers<void>(), late = Promise.withResolvers<string>();
    let nestedSignal: AbortSignal | undefined;
    const active = executeCode({ code: 'return await tools.call("read",{});', callTool: async (_id, _args, signal) => {
      nestedSignal = signal; ready.resolve(); return late.promise;
    } }, workers);
    await ready.promise;
    const queuedHost = vi.fn(host);
    const queued = executeCode({ code: 'return await tools.call("never",{});', callTool: queuedHost }, workers);
    await workers.close();
    expect((await active).status).toBe("cancelled");
    expect((await queued).status).toBe("cancelled");
    expect(queuedHost).not.toHaveBeenCalled();
    expect(nestedSignal?.aborted).toBe(true);
    late.resolve("too late");
    expect(workers.snapshot()).toMatchObject({ workers: 0, waiting: 0 });
  });

  it("does not launch a script if shutdown wins immediately after admission", async () => {
    const workers = pool();
    const called = vi.fn(host);
    const pending = executeCode({ code: 'return await tools.call("never",{});', callTool: called }, workers);
    await workers.close();
    expect((await pending).status).toBe("cancelled");
    expect(called).not.toHaveBeenCalled();
  });

  it("lets the owning Node process exit while its pool is idle", async () => {
    const executor = new URL("./executor.ts", import.meta.url).href;
    const result = await promisify(execFile)(process.execPath, ["--import", "tsx/esm", "--input-type=module", "--eval",
      `import {executeCode} from ${JSON.stringify(executor)}; const r=await executeCode({code:'return 42;',callTool:async()=>null}); console.log(r.value);`,
    ], { timeout: 5_000 });
    expect(result.stdout.trim()).toBe("42");
  });
});
