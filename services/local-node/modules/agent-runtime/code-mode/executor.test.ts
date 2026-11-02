import { describe, expect, it, vi } from "vitest";
import { executeCode } from "./executor.js";
import { CODE_WORKER_CAPACITY } from "./contracts.js";

const callTool = vi.fn(async (id: string, args: unknown) => ({ id, args }));
describe("Code Mode isolated executor", () => {
  it("waits for a worker without consuming the execution deadline", async () => {
    const held = Promise.withResolvers<void>();
    const started = Array.from({ length: CODE_WORKER_CAPACITY.active }, () => Promise.withResolvers<void>());
    const blockers = started.map(ready => executeCode({
      code: 'return await tools.call("hold", {});',
      callTool: async () => { ready.resolve(); await held.promise; return true; },
    }));
    await Promise.all(started.map(ready => ready.promise));
    const host = vi.fn(async () => "admitted");
    const queued = executeCode({
      code: 'return await tools.call("next", {});', callTool: host,
      limits: { timeoutMs: 1_000, queueTimeoutMs: 3_000 },
    });
    try {
      await new Promise(resolve => setTimeout(resolve, 1_100));
      expect(host).not.toHaveBeenCalled();
    } finally { held.resolve(); }
    const result = await queued;
    await Promise.all(blockers);
    expect(result).toMatchObject({ status: "completed", value: "admitted" });
    expect(result.queueWaitMs).toBeGreaterThanOrEqual(1_000);
    expect(result.durationMs).toBeGreaterThanOrEqual(result.queueWaitMs);
  });

  it("never starts cancelled, expired or overflowing queued programs", async () => {
    const held = Promise.withResolvers<void>();
    const started = Array.from({ length: CODE_WORKER_CAPACITY.active }, () => Promise.withResolvers<void>());
    const blockers = started.map(ready => executeCode({
      code: 'return await tools.call("hold", {});',
      callTool: async () => { ready.resolve(); await held.promise; return true; },
    }));
    await Promise.all(started.map(ready => ready.promise));
    const host = vi.fn(async () => true);
    const controller = new AbortController();
    const requests = Array.from({ length: CODE_WORKER_CAPACITY.waiting }, () => executeCode({
      code: 'return await tools.call("never", {});', callTool: host, signal: controller.signal,
    }));
    try {
      expect((await executeCode({ code: "return 1;", callTool: host })).status).toBe("unavailable");
      controller.abort();
      expect((await Promise.all(requests)).every(result => result.status === "cancelled")).toBe(true);
      const expired = await executeCode({
        code: 'return await tools.call("never", {});', callTool: host, limits: { queueTimeoutMs: 20 },
      });
      expect(expired.status).toBe("timed_out");
      expect(expired.error).toContain("No code or tools were executed");
      expect(host).not.toHaveBeenCalled();
    } finally { controller.abort(); held.resolve(); await Promise.all(blockers); }
    expect((await executeCode({ code: "return 42;", callTool: host })).value).toBe(42);
  });

  it("keeps writes exclusive between parallel read batches", async () => {
    const firstReads = Promise.withResolvers<void>();
    const events: string[] = [];
    let readers = 0, writer = false;
    const result = await executeCode({
      code: 'return await Promise.all([tools.call("read",{id:1}),tools.call("read",{id:2}),tools.call("write",{id:3}),tools.call("read",{id:4})]);',
      canParallelTool: id => id === "read",
      callTool: async (id, args) => {
        events.push(`start:${args.id}`);
        if (id === "write") {
          expect(readers).toBe(0);
          writer = true;
          await new Promise(resolve => setTimeout(resolve, 5));
          writer = false;
        } else {
          expect(writer).toBe(false);
          readers++;
          if (args.id === 2) firstReads.resolve();
          if ((args.id as number) < 3) await firstReads.promise;
          readers--;
        }
        events.push(`end:${args.id}`);
        return args.id;
      },
    });
    expect(result).toMatchObject({ status: "completed", value: [1, 2, 3, 4] });
    expect(events.indexOf("start:2")).toBeLessThan(events.indexOf("end:1"));
    expect(events.indexOf("start:3")).toBeGreaterThan(events.indexOf("end:2"));
    expect(events.indexOf("start:4")).toBeGreaterThan(events.indexOf("end:3"));
  });

  it("continues after a caught tool failure and treats unknown tools as exclusive", async () => {
    let active = 0, peak = 0;
    const result = await executeCode({
      code: 'try { await tools.call("fail",{}); } catch {} return await Promise.all([tools.call("unknown",{}),tools.call("unknown",{})]);',
      callTool: async id => {
        if (id === "fail") throw new Error("expected");
        active++; peak = Math.max(peak, active);
        await new Promise(resolve => setTimeout(resolve, 5));
        active--;
        return true;
      },
    });
    expect(result).toMatchObject({ status: "completed", value: [true, true] });
    expect(peak).toBe(1);
  });

  it("preserves Promise.all's original failure while cancelling its remaining reads", async () => {
    let pendingSignal: AbortSignal | undefined;
    const result = await executeCode({
      code: 'return await Promise.all([tools.call("pending",{}),tools.call("fail",{})]);',
      canParallelTool: () => true,
      callTool: async (id, _args, signal) => {
        if (id === "fail") throw new Error("source read failed");
        pendingSignal = signal;
        return new Promise(() => {});
      },
    });
    expect(result).toMatchObject({ status: "failed", error: "source read failed" });
    expect(pendingSignal?.aborted).toBe(true);
  });

  it("preserves near-ceiling returns when diagnostic logs require JSON escaping", async () => {
    const result = await executeCode({
      code: 'console.log(String.fromCharCode(0).repeat(3999)); return "x".repeat(999000);',
      callTool,
    });
    expect(result.status).toBe("completed");
    expect(result.value).toBe("x".repeat(999000));
    expect(Buffer.byteLength(result.stdout)).toBe(4000);
  });
  it("queues a full batch behind bounded host concurrency", async () => {
    let active = 0, peak = 0;
    const invoked: number[] = [];
    const result = await executeCode({
      code: 'return await Promise.all(Array.from({length:32}, (_,n) => tools.call("read",{n})));',
      limits: { maxConcurrentCalls: 2 },
      canParallelTool: () => true,
      callTool: async (_, args) => {
        active++; peak = Math.max(peak, active);
        invoked.push(args.n as number);
        await new Promise(resolve => setTimeout(resolve, 2));
        active--;
        return args.n;
      },
    });
    expect(result.status).toBe("completed");
    expect(result.value).toEqual(Array.from({ length: 32 }, (_, n) => n));
    expect(invoked).toHaveLength(32);
    expect(peak).toBe(2);
  });

  it("cancels queued calls without starting or replaying them", async () => {
    const controller = new AbortController();
    const host = vi.fn(async () => {
      controller.abort();
      await new Promise(resolve => setTimeout(resolve, 5));
      return 1;
    });
    const result = await executeCode({
      code: 'return await Promise.all(Array.from({length:8}, () => tools.call("read",{})));',
      signal: controller.signal, limits: { maxConcurrentCalls: 1 }, callTool: host,
    });
    expect(result.status).toBe("cancelled");
    expect(host).toHaveBeenCalledTimes(1);
  });

  it("evaluates an async body and awaits JSON-only host calls in parallel", async () => {
    const result = await executeCode({
      canParallelTool: () => true,
      code: 'return await Promise.all([tools.call("a", {n:1}), tools.call("b", {n:2})]);',
      callTool,
    });
    expect(result.status).toBe("completed");
    expect(result.value).toEqual([
      { id: "a", args: { n: 1 } },
      { id: "b", args: { n: 2 } },
    ]);
  });
  it("has no host globals or module loader, including constructor escapes", async () => {
    const result = await executeCode({
      code: 'return [typeof process, typeof require, typeof fetch, typeof WebAssembly, ({}).constructor.constructor("return typeof process")()];',
      callTool,
    });
    expect(result.value).toEqual(Array(5).fill("undefined"));
    expect(
      (await executeCode({ code: 'return await import("node:fs");', callTool }))
        .status,
    ).toBe("failed");
  });
  it("does not persist globals between runs", async () => {
    await executeCode({
      code: "globalThis.secret = 42; return true;",
      callTool,
    });
    expect(
      (await executeCode({ code: "return typeof secret;", callTool })).value,
    ).toBe("undefined");
  });
  it("bounds logs and rejects oversized/non-JSON results before crossing the boundary", async () => {
    expect(
      (
        await executeCode({
          code: 'return "a".repeat(10000);',
          callTool,
          limits: { maxOutputBytes: 1000 },
        })
      ).status,
    ).toBe("failed");
    expect(
      (await executeCode({ code: "const x={}; x.x=x; return x;", callTool }))
        .status,
    ).toBe("failed");
    const result = await executeCode({
      code: 'console.log("a".repeat(2000)); return 7;',
      callTool,
      limits: { maxLogBytes: 1000 },
    });
    expect(result.value).toBe(7);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(1000);
  });
  it("hard-stops infinite loops and pending promises", async () => {
    for (const code of [
      "while(true){}",
      "return await new Promise(()=>{});",
      "while(true) await Promise.resolve();",
    ]) {
      expect(
        (await executeCode({ code, callTool, limits: { timeoutMs: 800 } }))
          .status,
      ).toBe("timed_out");
    }
  });
  it("cancels an active tool and worker without waiting for an uncooperative host", async () => {
    const controller = new AbortController();
    let signal: AbortSignal | undefined;
    const result = await executeCode({
      code: 'return await tools.call("slow", {});',
      signal: controller.signal,
      callTool: async (_id, _args, nestedSignal) => {
        signal = nestedSignal;
        controller.abort();
        return new Promise(() => {});
      },
    });
    expect(result.status).toBe("cancelled");
    expect(signal?.aborted).toBe(true);
  });
  it("bounds calls and concurrency; no unawaited call starts after return", async () => {
    const host = vi.fn(async () => 1);
    const result = await executeCode({
      code: 'for(let i=0;i<5;i++) await tools.call("x", {}); return true;',
      callTool: host,
      limits: { maxCalls: 2 },
    });
    expect(result.status).toBe("failed");
    expect(host).toHaveBeenCalledTimes(2);
    const parallel = await executeCode({
      code: 'return await Promise.all(Array.from({length:10},()=>tools.call("x", {})));',
      callTool: async () => new Promise(resolve => setTimeout(() => resolve(1), 2)),
      limits: { maxConcurrentCalls: 2 },
    });
    expect(parallel.status).toBe("completed");
  });
  it("rejects oversized tool args, tool results and catches normal tool errors", async () => {
    const host = vi.fn(async () => "x".repeat(2000));
    expect(
      (
        await executeCode({
          code: 'return await tools.call("x", {s:"x".repeat(2000)});',
          callTool: host,
          limits: { maxInputBytes: 1000 },
        })
      ).status,
    ).toBe("failed");
    expect(host).not.toHaveBeenCalled();
    expect(
      (
        await executeCode({
          code: 'return await tools.call("x", {});',
          callTool: host,
          limits: { maxToolResultBytes: 1000 },
        })
      ).status,
    ).toBe("failed");
    expect(
      (
        await executeCode({
          code: 'try { await tools.call("x", {}); } catch(e) { return e.message; }',
          callTool: async () => {
            throw new Error("tool denied");
          },
        })
      ).value,
    ).toBe("tool denied");
  });
  it("handles syntax errors and memory exhaustion without harming the host", async () => {
    expect((await executeCode({ code: "return (((;", callTool })).status).toBe(
      "failed",
    );
    expect(
      (
        await executeCode({
          code: 'return new Array(1e7).fill("big");',
          callTool,
          limits: { memoryBytes: 4 * 1024 * 1024 },
        })
      ).status,
    ).toBe("failed");
    expect((await executeCode({ code: "return 2+2;", callTool })).value).toBe(
      4,
    );
  });
});
