import { expect, it } from "vitest";
import { toolEventStream } from "../backends/tool-event-stream.js";
import type { RustAgentLoopEvent } from "../rust-agent-loop-client.js";

function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }

it("finishes an independent read before a slow read and fences ACKs until both settle", async () => {
  const slow = deferred(); const fast = deferred(); const finish = deferred();
  async function* events(): AsyncGenerator<RustAgentLoopEvent> {
    yield { type: "tool-call", toolName: "file.read", toolCallId: "slow", sequence: 1 };
    yield { type: "tool-call", toolName: "file.read", toolCallId: "fast", sequence: 2 };
    await finish.promise;
    yield { type: "done", sequence: 3 };
  }
  const order: string[] = []; const progress = { through: 0 };
  const stream = toolEventStream(events(), { progress, shouldStop: () => false, abort: finish.resolve,
    execute: async event => {
      if (event.toolCallId === "slow") await slow.promise;
      order.push(event.toolCallId!);
      if (event.toolCallId === "fast") fast.resolve();
    },
  });
  const consuming = (async () => { for await (const _item of stream) { /* drain */ } })();
  await fast.promise;
  expect(order).toEqual(["fast"]); expect(progress.through).toBe(0);
  slow.resolve(); finish.resolve(); await consuming;
  expect(order).toEqual(["fast", "slow"]); expect(progress.through).toBe(3);
});

it("bounds reads and places writes behind an exclusive barrier", async () => {
  const started = deferred(); const release = deferred(); let active = 0; let peak = 0; const order: string[] = [];
  async function* events(): AsyncGenerator<RustAgentLoopEvent> {
    for (const [index, name] of ["file.read", "file.read", "file.write", "file.read"].entries())
      yield { type: "tool-call", toolName: name, toolCallId: String(index), sequence: index + 1 };
  }
  const consuming = (async () => {
    for await (const _item of toolEventStream(events(), { shouldStop: () => false, abort: () => {}, concurrency: 2,
      execute: async event => {
        active++; peak = Math.max(peak, active);
        if (event.toolName === "file.write") expect(active).toBe(1);
        if (event.toolCallId === "0" || event.toolCallId === "1") { if (active === 2) started.resolve(); await release.promise; }
        order.push(event.toolCallId!); active--;
      },
    })) { /* drain */ }
  })();
  await started.promise; expect(peak).toBe(2); release.resolve(); await consuming;
  expect(order).toEqual(["0", "1", "2", "3"]);
});
