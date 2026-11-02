import { codeWorkerPool, type CodeWorkerPool } from "./worker-pool.js";
import { AsyncResource } from "node:async_hooks";
import {
  CODE_LIMITS,
  type CodeLimits,
  type CodeResult,
  type ExecuteCodeInput,
} from "./contracts.js";

function limitsFor(overrides: Partial<CodeLimits> = {}): CodeLimits {
  return Object.fromEntries(
    Object.entries(CODE_LIMITS).map(([key, ceiling]) => {
      const requested = overrides[key as keyof CodeLimits];
      return [
        key,
        typeof requested === "number" && Number.isFinite(requested)
          ? Math.max(1, Math.min(ceiling, Math.floor(requested)))
          : ceiling,
      ];
    }),
  ) as CodeLimits;
}
export async function executeCode(
  input: ExecuteCodeInput,
  pool: CodeWorkerPool = codeWorkerPool,
): Promise<CodeResult> {
  const start = performance.now();
  const limits = limitsFor(input.limits);
  const base = { stdout: "", truncated: false };
  let queueWaitMs = 0;
  const measured = (result: Omit<CodeResult, "durationMs" | "queueWaitMs">): CodeResult => ({
    ...result, queueWaitMs, durationMs: performance.now() - start,
  });
  if (input.signal?.aborted)
    return measured({ ...base, status: "cancelled", error: "Execution cancelled." });
  if (Buffer.byteLength(input.code) > limits.maxCodeBytes)
    return measured({ ...base, status: "failed", error: "Code exceeds the byte limit." });
  const admission = await pool.acquire(limits.queueTimeoutMs, input.signal);
  queueWaitMs = performance.now() - start;
  if (admission.status !== "acquired")
    return measured({ ...base, ...admission });
  const { lease } = admission;
  const { worker, runId } = lease;
  // Cancellation can win after admission resolved but before this continuation.
  if (input.signal?.aborted || lease.signal.aborted) {
    await lease.release();
    return measured({ ...base, status: "cancelled", error: "Execution cancelled before worker startup." });
  }
  if (worker.threadId < 0) {
    await lease.release();
    return measured({ ...base, status: "unavailable", error: "Code Mode worker exited before execution." });
  }
  const controller = new AbortController();
  // Worker message events retain the thread's creation context. Bind each run
  // so tool permissions, execution leases and traces follow the current caller.
  const task = new AsyncResource("SynaxCodeModeRun");
  let done = false;
  let calls = 0;
  let inFlight = 0;
  let exclusive = false;
  const queue: Array<{ toolId: string; run: (parallel: boolean) => void }> = [];
  const seen = new Set<number>();
  return new Promise<CodeResult>((resolve) => {
    const pump = () => {
      while (!done && !exclusive && inFlight < limits.maxConcurrentCalls && queue.length) {
        let parallel = false;
        try { parallel = input.canParallelTool?.(queue[0].toolId) === true; }
        catch { /* Failed classification stays exclusive; execution reports the error. */ }
        if (done) return;
        if (!parallel && inFlight) return;
        queue.shift()!.run(parallel);
      }
    };
    const finish = (result: Omit<CodeResult, "durationMs" | "queueWaitMs">, reuse?: { wasmBytes: number }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", cancel);
      lease.signal.removeEventListener("abort", cancel);
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
      controller.abort();
      queue.length = 0;
      void lease.release(reuse).then(() => {
        task.emitDestroy();
        resolve(measured(result));
      });
    };
    const fail = (error: string) =>
      finish({ ...base, status: "failed", error });
    const cancel = task.bind(() =>
      finish({ ...base, status: "cancelled", error: "Execution cancelled." }));
    const timer = setTimeout(
      () =>
        finish({
          ...base,
          status: "timed_out",
          error: "Code Mode execution deadline exceeded.",
        }),
      limits.timeoutMs,
    );
    const onError = task.bind(() =>
      finish({
        ...base,
        status: "unavailable",
        error: "Code Mode worker failed. Use direct tools.",
      }));
    const onExit = task.bind(() => {
      if (!done) fail("Code Mode worker exited unexpectedly.");
    });
    const onMessage = task.bind((message: { type: string; runId: number; id: number; json: string; toolId: string; reusable?: boolean; wasmBytes?: number }) => {
      if (done) return;
      if (!message || !Number.isSafeInteger(message.runId)) {
        fail("Code Mode worker protocol mismatch. Rebuild the matching host and worker.");
        return;
      }
      if (message.runId !== runId) return;
      if (message.type === "result") {
        if (
          typeof message.json !== "string" ||
          Buffer.byteLength(message.json) >
            // JSON escapes may expand each log byte into six bytes (\u0000).
            // The value already counts serialized bytes; logs count raw UTF-8.
            limits.maxOutputBytes + limits.maxLogBytes * 6 + 2048
        )
          return fail(
            "Execution result exceeds the byte limit. Return a smaller summary.",
          );
        try {
          const result = JSON.parse(message.json);
          if (result.status === "completed" && (inFlight || queue.length))
            return fail(
              "Unawaited tool calls are not supported. Await every tools.call.",
            );
          if (!["completed", "failed", "timed_out"].includes(result.status))
            return fail("Invalid worker result.");
          if (result.status === "completed" &&
              Buffer.byteLength(JSON.stringify(result.value ?? null)) > limits.maxOutputBytes)
            return fail("Final return exceeds the storage byte limit. Do not replay completed writes.");
          finish({ ...base, ...result }, result.status === "completed" && message.reusable === true
            ? { wasmBytes: message.wasmBytes ?? 0 } : undefined);
        } catch {
          fail("Invalid worker result.");
        }
        return;
      }
      if (
        message.type !== "call" ||
        !Number.isSafeInteger(message.id) ||
        seen.has(message.id)
      )
        return fail("Invalid tool bridge message.");
      if (++calls > limits.maxCalls)
        return fail("Nested tool call limit exceeded.");
      if (
        typeof message.toolId !== "string" ||
        message.toolId.length > 256 ||
        typeof message.json !== "string" ||
        Buffer.byteLength(message.json) > limits.maxInputBytes
      )
        return fail("Invalid or oversized tool arguments.");
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(message.json);
        if (!args || typeof args !== "object" || Array.isArray(args))
          throw new Error();
      } catch {
        return fail("Tool arguments must be a JSON object.");
      }
      seen.add(message.id);
      queue.push({ toolId: message.toolId, run: (parallel) => {
        inFlight++;
        exclusive = !parallel;
        void Promise.resolve()
          .then(() => {
            controller.signal.throwIfAborted();
            return input.callTool(message.toolId, args, controller.signal);
          })
          .then((value) => {
            if (done) return;
            const json = JSON.stringify(value ?? null);
            if (Buffer.byteLength(json) > limits.maxToolResultBytes)
              throw new Error(
                "Tool result exceeds the Code Mode byte limit. Narrow the query or use direct tools.",
              );
            worker.postMessage({ type: "reply", runId, id: message.id, json });
          })
          .catch((error) => {
            if (!done)
              worker.postMessage({
                type: "reply",
                runId,
                id: message.id,
                error: String(
                  error instanceof Error ? error.message : error,
                ).slice(0, 1000),
              });
          })
          .finally(() => {
            inFlight--;
            if (!parallel) exclusive = false;
            pump();
          });
      } });
      pump();
    });
    worker.on("message", onMessage);
    worker.once("error", onError);
    worker.once("exit", onExit);
    input.signal?.addEventListener("abort", cancel, { once: true });
    lease.signal.addEventListener("abort", cancel, { once: true });
    if (input.signal?.aborted || lease.signal.aborted) cancel();
    if (!done) {
      try { worker.postMessage({ type: "run", runId, code: input.code, limits }); }
      catch { fail("Could not start Code Mode worker."); }
    }
  });
}
