import { Worker } from "node:worker_threads";
import { runtimeAsset } from "../../../infrastructure/runtime/runtime-paths.js";
import {
  CODE_LIMITS,
  type CodeLimits,
  type CodeResult,
  type ExecuteCodeInput,
} from "./contracts.js";

// Global per agent-process admission limit, in addition to per-execution tool limits.
let activeWorkers = 0;
const MAX_WORKERS = 2;
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
): Promise<CodeResult> {
  const start = Date.now();
  const limits = limitsFor(input.limits);
  const base = { stdout: "", truncated: false, durationMs: 0 };
  if (input.signal?.aborted)
    return { ...base, status: "cancelled", error: "Execution cancelled." };
  if (Buffer.byteLength(input.code) > limits.maxCodeBytes)
    return { ...base, status: "failed", error: "Code exceeds the byte limit." };
  if (activeWorkers >= MAX_WORKERS)
    return {
      ...base,
      status: "unavailable",
      error: "Code Mode is busy. Use direct tools or retry later.",
    };
  let worker: Worker;
  try {
    worker = new Worker(
      runtimeAsset(import.meta.url, "./worker.mjs", "workers/code-mode.cjs"),
      {
        workerData: { code: input.code, limits },
        execArgv: [],
        env: {},
        stdout: true,
        stderr: true,
        resourceLimits: {
          maxOldGenerationSizeMb: 96,
          maxYoungGenerationSizeMb: 16,
          stackSizeMb: 4,
        },
      },
    );
  } catch {
    return {
      ...base,
      status: "unavailable",
      error: "Code Mode worker is unavailable. Use direct tools.",
    };
  }
  activeWorkers++;
  // QuickJS diagnostics must not fill an unread worker stream.
  worker.stdout?.resume();
  worker.stderr?.resume();
  const controller = new AbortController();
  let done = false;
  let calls = 0;
  let inFlight = 0;
  const seen = new Set<number>();
  return new Promise<CodeResult>((resolve) => {
    const finish = (result: Omit<CodeResult, "durationMs">) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", cancel);
      controller.abort();
      void worker.terminate().finally(() => {
        activeWorkers--;
        resolve({ ...result, durationMs: Date.now() - start });
      });
    };
    const fail = (error: string) =>
      finish({ ...base, status: "failed", error });
    const cancel = () =>
      finish({ ...base, status: "cancelled", error: "Execution cancelled." });
    const timer = setTimeout(
      () =>
        finish({
          ...base,
          status: "timed_out",
          error: "Code Mode execution deadline exceeded.",
        }),
      limits.timeoutMs,
    );
    input.signal?.addEventListener("abort", cancel, { once: true });
    if (input.signal?.aborted) cancel();
    worker.on("error", () =>
      finish({
        ...base,
        status: "unavailable",
        error: "Code Mode worker failed. Use direct tools.",
      }),
    );
    worker.on("exit", () => {
      if (!done) fail("Code Mode worker exited unexpectedly.");
    });
    worker.on("message", (message) => {
      if (done) return;
      if (message.type === "result") {
        if (
          typeof message.json !== "string" ||
          Buffer.byteLength(message.json) >
            limits.maxOutputBytes + limits.maxLogBytes + 2048
        )
          return fail(
            "Execution result exceeds the byte limit. Return a smaller summary.",
          );
        try {
          const result = JSON.parse(message.json);
          if (inFlight)
            return fail(
              "Unawaited tool calls are not supported. Await every tools.call.",
            );
          if (result.status !== "completed" && result.status !== "failed")
            return fail("Invalid worker result.");
          finish({ ...base, ...result });
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
      if (inFlight >= limits.maxConcurrentCalls)
        return fail("Nested tool concurrency limit exceeded.");
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
      inFlight++;
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
          worker.postMessage({ type: "reply", id: message.id, json });
        })
        .catch((error) => {
          if (!done)
            worker.postMessage({
              type: "reply",
              id: message.id,
              error: String(
                error instanceof Error ? error.message : error,
              ).slice(0, 1000),
            });
        })
        .finally(() => {
          inFlight--;
        });
    });
  });
}
