// Run after npm run build. Exercises the actual self-contained production worker.
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { fileURLToPath, URL } from "node:url";
import { setTimeout, clearTimeout } from "node:timers";
import process from "node:process";
import console from "node:console";
const worker = new Worker(
  fileURLToPath(
    new URL("../server-dist/workers/code-mode.cjs", import.meta.url),
  ),
  {
    workerData: {
      code: 'const values=await Promise.all([tools.call("fixture.read",{}),tools.call("fixture.read",{})]); return {sum:values[0]+values[1],node:typeof process};',
      limits: {
        timeoutMs: 5000,
        memoryBytes: 32 * 1024 * 1024,
        maxInputBytes: 32000,
        maxOutputBytes: 16000,
        maxLogBytes: 4000,
      },
    },
  },
);
let calls = 0;
const timer = setTimeout(() => {
  void worker.terminate();
  process.exitCode = 1;
  console.error("Code Mode bundle timed out.");
}, 6000);
worker.on("message", (message) => {
  if (message.type === "call") {
    calls++;
    assert.equal(message.toolId, "fixture.read");
    worker.postMessage({ type: "reply", id: message.id, json: "21" });
    return;
  }
  try {
    const result = JSON.parse(message.json);
    assert.equal(result.status, "completed");
    assert.deepEqual(result.value, { sum: 42, node: "undefined" });
    assert.equal(calls, 2);
    console.log(
      "Code Mode production worker: PASS (embedded WASM, async RPC, no Node globals)",
    );
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
    void worker.terminate();
  }
});
worker.on("error", (error) => {
  clearTimeout(timer);
  console.error(error);
  process.exitCode = 1;
});
