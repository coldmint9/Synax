import { Buffer } from "node:buffer";
import { setImmediate } from "node:timers";
// Trusted worker bootstrap. Model code is evaluated ONLY inside QuickJS WASM,
// never by Node eval/vm. No Node objects, loaders, I/O or credentials enter it.
import { parentPort, workerData } from "node:worker_threads";
import variant from "@jitl/quickjs-singlefile-cjs-release-sync";
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";

async function main() {
  const { code, limits } = workerData;
  const deadline = Date.now() + limits.timeoutMs;
  const QuickJS = await newQuickJSWASMModuleFromVariant(variant);
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(limits.memoryBytes);
  runtime.setMaxStackSize(512 * 1024);
  runtime.setInterruptHandler(() => Date.now() >= deadline);
  const vm = runtime.newContext();
  const pending = new Map();
  let sequence = 0;
  let completed = false;
  let evaluation;
  const sendFailure = (message) => {
    if (completed) return;
    completed = true;
    parentPort.postMessage({
      type: "result",
      json: JSON.stringify({
        status: "failed",
        error: message,
        stdout: "",
        truncated: false,
      }),
    });
  };
  const hostCall = vm.newFunction("hostCall", (id, args) => {
    if (vm.typeof(id) !== "string" || vm.typeof(args) !== "string")
      return { error: vm.newError("Invalid tool call.") };
    const toolId = vm.getString(id);
    const json = vm.getString(args);
    if (toolId.length > 256 || json.length > limits.maxInputBytes)
      return { error: vm.newError("Tool arguments exceed the limit.") };
    const deferred = vm.newPromise();
    const callId = ++sequence;
    pending.set(callId, deferred);
    parentPort.postMessage({ type: "call", id: callId, toolId, json });
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
      if (typeof json !== 'string' || json.length > ${limits.maxOutputBytes}) throw new Error('Result exceeds the limit or is not JSON. Return a smaller summary.');
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
      `(async function(tools, console) {\n"use strict";\n${code}\n})`,
      "code-mode.js",
    );
    if (fn.error) {
      fn.error.dispose();
      sendFailure(
        "Invalid JavaScript. Provide an async function body, not TypeScript or a module.",
      );
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
    if (completed || !evaluation?.value) return;
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
      let json = vm.getString(state.value);
      state.value.dispose();
      // UTF-8 enforcement after guest-side character limits, still bounded.
      const result = JSON.parse(json);
      if (
        Buffer.byteLength(JSON.stringify(result.value ?? null)) >
        limits.maxOutputBytes
      ) {
        sendFailure("Result exceeds the byte limit.");
        return;
      }
      if (Buffer.byteLength(result.stdout) > limits.maxLogBytes) {
        result.stdout = Buffer.from(result.stdout)
          .subarray(0, limits.maxLogBytes)
          .toString("utf8")
          .replace(/\uFFFD$/, "");
        result.truncated = true;
        json = JSON.stringify(result);
      }
      completed = true;
      parentPort.postMessage({ type: "result", json });
    } else if (state.type === "rejected") {
      state.error.dispose();
      sendFailure("Code Mode promise failed or memory limit exceeded.");
    } else if (runtime.hasPendingJob()) setImmediate(pump);
  }
  parentPort.on("message", (message) => {
    if (completed || message.type !== "reply") return;
    const deferred = pending.get(message.id);
    if (!deferred) return;
    pending.delete(message.id);
    const value = message.error
      ? vm.newError(message.error)
      : vm.newString(message.json);
    if (message.error) deferred.reject(value);
    else deferred.resolve(value);
    value.dispose();
    pump();
  });
  pump();
  // The host terminates this one-shot worker on every terminal path, releasing the
  // complete WASM heap, deferred handles and context even after guest OOM/errors.
}
void main().catch(() => {
  parentPort.postMessage({
    type: "result",
    json: JSON.stringify({
      status: "failed",
      error: "Sandbox initialization or resource limit failure.",
      stdout: "",
      truncated: false,
    }),
  });
});
