import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { streamRustAgentLoop, type RustAgentLoopEvent } from "../rust-agent-loop-client.js";

const input = { apiFormat: "openai", model: "fixture", prompt: [], loopId: "loop" };
const encode = (events: RustAgentLoopEvent[]) => new TextEncoder().encode(events.map(event => JSON.stringify(event) + "\n").join(""));
const record = (sequence: number, type = "text-delta"): RustAgentLoopEvent => ({ type, sequence, loopId: "loop", delta: `片段${sequence}😀` });
const acknowledgements: number[] = [];
const subscriptions: number[] = [];
let observe: (cursor: number) => Response;

beforeEach(() => {
  acknowledgements.length = 0;
  subscriptions.length = 0;
  vi.stubEnv("SYNAX_RUNTIME_PROVIDER_PORT", "12345");
  vi.stubEnv("SYNAX_RUNTIME_SIDECAR_TOKEN", "fixture");
  vi.stubGlobal("fetch", vi.fn(async (url: string, options: RequestInit) => {
    const path = new URL(url);
    if (path.pathname === "/agent-loop/ack") {
      acknowledgements.push(JSON.parse(String(options.body)).through);
      return Response.json({ ok: true });
    }
    if (path.pathname === "/agent-loop/events") {
      const after = Number(path.searchParams.get("after"));
      subscriptions.push(after);
      return observe(after);
    }
    throw new Error(`Unexpected bridge call ${url}`);
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it("acknowledges processed batches and drains the tail without changing event order", async () => {
  observe = () => new Response(encode(Array.from({ length: 70 }, (_, i) => record(i + 1, i === 69 ? "done" : "text-delta"))));
  const received: number[] = [];
  for await (const event of streamRustAgentLoop(input)) {
    received.push(event.sequence!);
    expect(acknowledgements.every(cursor => cursor < event.sequence!)).toBe(true);
  }
  expect(received).toEqual(Array.from({ length: 70 }, (_, i) => i + 1));
  expect(acknowledgements).toEqual([32, 64, 70]);
});

it("does not release a large event until the consumer finishes handling it", async () => {
  observe = () => new Response(encode([{ ...record(1), delta: "大".repeat(32 * 1024) }, record(2, "done")]));
  const stream = streamRustAgentLoop(input);
  expect((await stream.next()).value?.sequence).toBe(1);
  expect(acknowledgements).toEqual([]);
  expect((await stream.next()).value?.sequence).toBe(2);
  expect(acknowledgements).toEqual([1]);
  await stream.return(undefined);
  expect(acknowledgements).toEqual([1]);
});

it("keeps a permission boundary until resumption supplies the handled cursor", async () => {
  observe = after => new Response(encode(after === 0
    ? [record(1, "step-started"), { ...record(2, "tool-call"), toolCallId: "permission" }, { ...record(3, "tool-call"), toolCallId: "next" }]
    : [{ ...record(3, "tool-call"), toolCallId: "next" }, record(4, "done")]));
  for await (const event of streamRustAgentLoop(input)) {
    if (event.type === "tool-call") break;
  }
  expect(acknowledgements).toEqual([1]);
  const resumed: RustAgentLoopEvent[] = [];
  for await (const event of streamRustAgentLoop({ ...input, after: 2 })) resumed.push(event);
  expect(subscriptions).toEqual([0, 2]);
  expect(acknowledgements).toEqual([1, 2, 4]);
  expect(resumed.filter(event => event.type === "tool-call").map(event => event.toolCallId)).toEqual(["next"]);
});

it("reconnects at the processed cursor without losing or repeating text and tools", async () => {
  observe = after => {
    if (after > 0) return new Response(encode([record(3), { ...record(4, "tool-call"), toolCallId: "once" }, record(5, "done")]));
    let sent = false;
    return new Response(new ReadableStream({ pull(controller) {
      if (sent) controller.error(new TypeError("socket closed"));
      else { sent = true; controller.enqueue(encode([record(1), record(2), record(3)])); }
    } }));
  };
  const received: RustAgentLoopEvent[] = [];
  for await (const event of streamRustAgentLoop(input)) received.push(event);
  expect(received.map(event => event.sequence)).toEqual([1, 2, 3, 4, 5]);
  expect(received.filter(event => event.type === "text-delta").map(event => event.delta).join(""))
    .toBe("片段1😀片段2😀片段3😀");
  expect(received.filter(event => event.type === "tool-call")).toHaveLength(1);
  expect(subscriptions).toEqual([0, 3]);
  expect(acknowledgements).toEqual([3, 5]);
});

it("retries a lost ACK response using the same cursor", async () => {
  observe = () => new Response(encode([record(1), record(2, "done")]));
  const normalFetch = globalThis.fetch;
  let failed = false;
  vi.stubGlobal("fetch", vi.fn(async (url: string, options: RequestInit) => {
    const response = await normalFetch(url, options);
    if (url.endsWith("/ack") && !failed) { failed = true; throw new TypeError("lost ACK response"); }
    return response;
  }));
  const received: number[] = [];
  for await (const event of streamRustAgentLoop(input)) received.push(event.sequence!);
  expect(received).toEqual([1, 2]);
  expect(acknowledgements).toEqual([2, 2]);
});

it("never acknowledges a gap or an interrupted consumer's current event", async () => {
  observe = () => new Response(encode([record(1), record(3)]));
  const stream = streamRustAgentLoop(input);
  await stream.next();
  await expect(stream.next()).rejects.toThrow("cursor gap");
  expect(acknowledgements).toEqual([1]);
  acknowledgements.length = 0;
  observe = () => new Response(encode([record(1), record(2)]));
  const controller = new AbortController();
  const interrupted = streamRustAgentLoop(input, controller.signal);
  await interrupted.next();
  controller.abort();
  await interrupted.return(undefined);
  expect(acknowledgements).toEqual([]);
});

it("honors a pipelined consumer's completed-delivery fence", async () => {
  observe = () => new Response(encode(Array.from({ length: 70 }, (_, i) => record(i + 1, i === 69 ? "done" : "text-delta"))));
  let through = 0;
  for await (const event of streamRustAgentLoop(input, undefined, undefined, () => through)) {
    // Work on event 2 remains in flight while later events are observed.
    through = event.sequence! < 50 ? 1 : event.sequence!;
    if (event.sequence === 49) expect(acknowledgements).toEqual([1]);
  }
  expect(acknowledgements[0]).toBe(1);
  expect(acknowledgements.at(-1)).toBe(70);
});
