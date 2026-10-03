import { describe, expect, it, vi } from "vitest";
import { executeCode } from "./executor.js";

const callTool = vi.fn(async (id: string, args: unknown) => ({ id, args }));
describe("Code Mode isolated executor", () => {
  it("evaluates an async body and awaits JSON-only host calls in parallel", async () => {
    const result = await executeCode({
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
      callTool: async () => new Promise(() => {}),
      limits: { maxConcurrentCalls: 2 },
    });
    expect(parallel.status).toBe("failed");
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
