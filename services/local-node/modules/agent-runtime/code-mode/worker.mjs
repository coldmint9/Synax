import { Buffer } from "node:buffer";
import { setImmediate, clearImmediate } from "node:timers";
import { parentPort } from "node:worker_threads";
// Only the trusted bootstrap persists. Every run owns a fresh QuickJS runtime
// and context; no guest globals, handles or callbacks survive the cleanup ACK.
import variant from "@jitl/quickjs-singlefile-cjs-release-sync";
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";

let modulePromise;
let current;
const failure = error => ({ status: "failed", error, stdout: "", truncated: false });

async function execute({ runId, code, limits }, owner) {
  const QuickJS = await (modulePromise ??= newQuickJSWASMModuleFromVariant(variant));
  const deadline = performance.now() + limits.timeoutMs;
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(limits.memoryBytes);
  runtime.setMaxStackSize(512 * 1024);
  let interrupted = false;
  runtime.setInterruptHandler(() => {
    interrupted ||= performance.now() >= deadline;
    return interrupted;
  });
  const vm = runtime.newContext();
  const pending = new Map();
  let sequence = 0;
  let completed = false;
  let evaluation;
  let pumpTick;

  const finish = (result, successful = false) => {
    if (completed) return;
    if (interrupted || performance.now() >= deadline) {
      result = { ...failure("Code Mode execution deadline exceeded."), status: "timed_out" };
      successful = false;
    }
    completed = true;
    clearImmediate(pumpTick);
    owner.reply = undefined;
    // Cleanup runs outside evalCode/callFunction/executePendingJobs stacks.
    setImmediate(() => {
      let reusable = successful && pending.size === 0 && !runtime.hasPendingJob();
      try {
        for (const deferred of pending.values()) deferred.dispose();
        pending.clear();
        evaluation?.value?.dispose();
        vm.dispose();
        runtime.dispose();
      } catch {
        // A cleanup assertion or OOM poisons this module. The host retires the
        // entire thread even when the user's completed result is still valid.
        reusable = false;
      }
      current = undefined;
      parentPort.postMessage({ type: "result", runId, json: JSON.stringify(result),
        reusable, wasmBytes: QuickJS.getWasmMemory().buffer.byteLength });
    });
  };
  const sendFailure = message => finish(failure(message));
  const hostCall = vm.newFunction("hostCall", (id, args) => {
    if (completed) return { error: vm.newError("Execution already ended.") };
    if (vm.typeof(id) !== "string" || vm.typeof(args) !== "string")
      return { error: vm.newError("Invalid tool call.") };
    const toolId = vm.getString(id);
    const json = vm.getString(args);
    if (toolId.length > 256 || json.length > limits.maxInputBytes)
      return { error: vm.newError("Tool arguments exceed the limit.") };
    const deferred = vm.newPromise();
    const callId = ++sequence;
    pending.set(callId, deferred);
    parentPort.postMessage({ type: "call", runId, id: callId, toolId, json });
    return deferred.handle;
  });
  vm.setProp(vm.global, "__hostCall", hostCall);
  hostCall.dispose();
  // Capture the JSON intrinsics before guest code can modify globals. Everything
  // crossing the host boundary is a bounded string, not a guest object/getter.
  const setup = vm.evalCode(`(() => {
  const stringify = JSON.stringify.bind(JSON), parse = JSON.parse.bind(JSON);
  const host = globalThis.__hostCall;
  delete globalThis.__hostCall;
  let stdout = '', truncated = false;
  const log = (...args) => {
    if (stdout.length >= ${limits.maxLogBytes}) { truncated = true; return; }
    const line = args.map(x => typeof x === 'string' ? x : stringify(x)).join(' ') + '\\n';
    const remaining = ${limits.maxLogBytes} - stdout.length;
    truncated ||= line.length > remaining;
    stdout += line.slice(0, remaining);
  };
  const tools = Object.freeze({call: async (id, args = {}) => {
    if (typeof id !== 'string' || !args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Expected tool ID and JSON object.');
    const json = stringify(args);
    if (json.length > ${limits.maxInputBytes}) throw new Error('Tool arguments exceed the limit.');
    return parse(await host(id, json));
  }});
  const console = Object.freeze({log, warn: log, error: log});
  return async (fn) => {
    try {
      const value = await fn(tools, console);
      const json = stringify(value === undefined ? null : value);
      if (typeof json !== 'string') throw new Error('Final return must be JSON serializable.');
      if (json.length > ${limits.maxOutputBytes}) throw new Error('Final return exceeds the ${limits.maxOutputBytes}-byte storage ceiling. Select fewer fields or split the output. Completed tool operations are not rolled back; do not replay writes.');
      return stringify({status:'completed', value: parse(json), stdout, truncated});
    } catch (error) {
      return stringify({status:'failed', error: String(error?.message || error).slice(0,1000), stdout, truncated});
    }
  };
})()`);
  if (setup.error) {
    setup.error.dispose();
    sendFailure("Cannot initialize Code Mode sandbox.");
  } else {
    const fn = vm.evalCode(
      `(async function(tools, console) {\n"use strict";\n${code}\n})`, "code-mode.js",
    );
    if (fn.error) {
      fn.error.dispose();
      sendFailure("Invalid JavaScript. Provide an async function body, not TypeScript or a module.");
    } else {
      evaluation = vm.callFunction(setup.value, vm.undefined, fn.value);
      fn.value.dispose();
      if (evaluation.error) {
        evaluation.error.dispose();
        evaluation = undefined;
        sendFailure("Code Mode evaluation failed.");
      }
    }
    setup.value.dispose();
  }

  function pump() {
    clearImmediate(pumpTick);
    pumpTick = undefined;
    if (completed || !evaluation?.value) return;
    try {
      const jobs = runtime.executePendingJobs(100);
      if (jobs.error) {
        jobs.error.dispose();
        sendFailure("Code Mode job failed or resource limit exceeded.");
        return;
      }
      const state = vm.getPromiseState(evaluation.value);
      if (state.type === "fulfilled") {
        if (vm.typeof(state.value) !== "string") {
          state.value.dispose();
          sendFailure("Invalid execution result.");
          return;
        }
        const json = vm.getString(state.value);
        state.value.dispose();
        const result = JSON.parse(json);
        if (Buffer.byteLength(JSON.stringify(result.value ?? null)) > limits.maxOutputBytes) {
          sendFailure(`Final return exceeds the ${limits.maxOutputBytes}-byte storage ceiling. Completed tool operations are not rolled back; do not replay writes.`);
          return;
        }
        if (Buffer.byteLength(result.stdout) > limits.maxLogBytes) {
          result.stdout = Buffer.from(result.stdout).subarray(0, limits.maxLogBytes).toString("utf8").replace(/\uFFFD$/, "");
          result.truncated = true;
        }
        finish(result, result.status === "completed");
      } else if (state.type === "rejected") {
        state.error.dispose();
        sendFailure("Code Mode promise failed or memory limit exceeded.");
      } else if (runtime.hasPendingJob()) pumpTick = setImmediate(pump);
    } catch {
      sendFailure("Code Mode job failed or resource limit exceeded.");
    }
  }
  owner.reply = message => {
    if (completed) return;
    const deferred = pending.get(message.id);
    if (!deferred) return;
    pending.delete(message.id);
    try {
      const value = message.error ? vm.newError(message.error) : vm.newString(message.json);
      try {
        if (message.error) deferred.reject(value);
        else deferred.resolve(value);
      } finally { value.dispose(); deferred.dispose(); }
      pump();
    } catch { sendFailure("Could not deliver the tool result to Code Mode."); }
  };
  pump();
}

parentPort.on("message", message => {
  if (message?.type === "reply") {
    if (message.runId === current?.runId) current.reply?.(message);
    return;
  }
  if (message?.type !== "run" || current || !Number.isSafeInteger(message.runId)) return;
  const owner = { runId: message.runId, reply: undefined };
  current = owner;
  void execute(message, owner).catch(() => {
    current = undefined;
    parentPort.postMessage({ type: "result", runId: message.runId, reusable: false,
      json: JSON.stringify(failure("Sandbox initialization or resource limit failure.")) });
  });
});
