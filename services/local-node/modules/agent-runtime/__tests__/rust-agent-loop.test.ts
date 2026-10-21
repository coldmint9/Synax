import http, { type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { RustRuntimeSupervisor } from "../../../infrastructure/runtime/rust-sidecar.js";
import { streamRustAgentLoop, type RustAgentLoopEvent } from "../rust-agent-loop-client.js";

type Protocol = "openai" | "openai-responses" | "anthropic";
type WireRequest = { url: string; body: Record<string, unknown> };
let supervisor: RustRuntimeSupervisor;
let root: string;
let baseUrl: string;
let respond: (request: WireRequest, response: ServerResponse) => void;
const requests: WireRequest[] = [];
const loops: string[] = [];
const upstream = http.createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  const wire = { url: request.url!, body: JSON.parse(body) as Record<string, unknown> };
  requests.push(wire);
  respond(wire, response);
});
const protocols: Protocol[] = ["openai", "openai-responses", "anthropic"];

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "synax-rust-loop-test-"));
  supervisor = new RustRuntimeSupervisor({ dataRoot: root, restartDelaysMs: Array(10).fill(10) });
  await supervisor.start();
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`;
});
afterEach(async () => {
  for (const loopId of loops.splice(0)) await post("/agent-loop/cancel", { loopId });
  upstream.closeAllConnections();
  requests.length = 0;
});
afterAll(async () => {
  await supervisor?.stop();
  await new Promise<void>(resolve => upstream.close(() => resolve()));
  if (root) await rm(root, { recursive: true, force: true });
});
function post(route: string, body: unknown) {
  return fetch(`http://127.0.0.1:${process.env.SYNAX_RUNTIME_PROVIDER_PORT}${route}`, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.SYNAX_RUNTIME_SIDECAR_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
}
function input(apiFormat: Protocol, maxSteps = 3) {
  return { apiFormat, baseUrl, apiKey: "fixture-key", model: "fixture", maxSteps,
    prompt: [{ role: "user", content: [{ type: "text", text: "Run both tools, then answer." }] }],
    tools: [{ name: "echo", description: "echo", inputSchema: { type: "object", properties: { value: { type: "string" } } } }],
  };
}
async function start(protocol: Protocol, maxSteps = 3) {
  const response = await post("/agent-loop/start", input(protocol, maxSteps));
  expect(response.status).toBe(200);
  const { loopId } = await response.json() as { loopId: string };
  loops.push(loopId);
  return loopId;
}
function observe(loopId: string, after = 0, timeout = 5000) {
  return streamRustAgentLoop({ ...input("openai"), loopId, after }, AbortSignal.timeout(timeout));
}
async function collect(stream: AsyncGenerator<RustAgentLoopEvent>) {
  const events: RustAgentLoopEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}
function event(response: ServerResponse, type: string, payload: object) {
  response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
}
function chat(response: ServerResponse, delta: object, finish: string | null = null) {
  response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture", created: 0,
    choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
}
function begin(protocol: Protocol, response: ServerResponse) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  if (protocol === "anthropic") event(response, "message_start", { message: { id: "fixture", role: "assistant", model: "fixture", content: [], usage: { input_tokens: 2, output_tokens: 0 } } });
}
function text(protocol: Protocol, response: ServerResponse, value: string) {
  if (protocol === "openai") chat(response, { content: value });
  else if (protocol === "openai-responses") {
    event(response, "response.output_item.added", { output_index: 1, item: { id: "msg_fixture", type: "message", role: "assistant", content: [] } });
    event(response, "response.output_text.delta", { output_index: 1, item_id: "msg_fixture", content_index: 0, delta: value });
    event(response, "response.output_item.done", { output_index: 1, item: { id: "msg_fixture", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: value, annotations: [] }] } });
  }
  else {
    event(response, "content_block_start", { index: 1, content_block: { type: "text", text: "" } });
    event(response, "content_block_delta", { index: 1, delta: { type: "text_delta", text: value } });
    event(response, "content_block_stop", { index: 1 });
  }
}
function reasoning(protocol: Protocol, response: ServerResponse) {
  if (protocol === "openai") chat(response, { reasoning_content: "Consider both tools." });
  else if (protocol === "openai-responses") {
    event(response, "response.output_item.added", { output_index: 0, item: { id: "rs_fixture", type: "reasoning", summary: [] } });
    event(response, "response.reasoning_summary_text.delta", { output_index: 0, delta: "Consider both tools." });
    event(response, "response.output_item.done", { output_index: 0, item: { id: "rs_fixture", type: "reasoning", encrypted_content: "opaque-fixture", summary: [{ type: "summary_text", text: "Consider both tools." }] } });
  } else {
    event(response, "content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } });
    event(response, "content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "Consider both tools." } });
    event(response, "content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "signed-fixture" } });
    event(response, "content_block_stop", { index: 0 });
  }
}
function tool(protocol: Protocol, response: ServerResponse, index: number, args = '{"value":"ok"}', name = "echo") {
  const id = `call_${index}`;
  if (protocol === "openai") chat(response, { tool_calls: [{ index, id, type: "function", function: { name, arguments: args } }] });
  else if (protocol === "openai-responses") {
    event(response, "response.output_item.added", { output_index: index + 2, item: { type: "function_call", id: `fc_${index}`, call_id: id, name } });
    event(response, "response.function_call_arguments.delta", { output_index: index + 2, item_id: `fc_${index}`, delta: args });
    event(response, "response.output_item.done", { output_index: index + 2, item: { type: "function_call", id: `fc_${index}`, call_id: id, name, arguments: args, status: "completed" } });
  } else {
    event(response, "content_block_start", { index: index + 2, content_block: { type: "tool_use", id, name, input: {} } });
    event(response, "content_block_delta", { index: index + 2, delta: { type: "input_json_delta", partial_json: args } });
    event(response, "content_block_stop", { index: index + 2 });
  }
}
function end(protocol: Protocol, response: ServerResponse, tools = false) {
  if (protocol === "openai") {
    chat(response, {}, tools ? "tool_calls" : "stop");
    response.end("data: [DONE]\n\n");
  } else if (protocol === "openai-responses") {
    event(response, "response.completed", { response: { usage: { input_tokens: 2, output_tokens: 3 } } });
    response.end();
  } else {
    event(response, "message_delta", { delta: { stop_reason: tools ? "tool_use" : "end_turn" }, usage: { output_tokens: 3 } });
    event(response, "message_stop", {});
    response.end();
  }
}

it.each(protocols)("%s streams before upstream completion and replays only unacknowledged output", async protocol => {
  let finish!: () => void;
  respond = (_request, response) => {
    begin(protocol, response);
    text(protocol, response, "First token");
    finish = () => end(protocol, response);
  };
  const id = await start(protocol);
  const stream = observe(id);
  const seen: RustAgentLoopEvent[] = [];
  for await (const e of stream) {
    seen.push(e);
    if (e.type === "text-delta") {
      expect(e.delta).toBe("First token");
      expect(e.outputTokens).toBeGreaterThan(0);
      break;
    }
  }
  // The observer has detached while the upstream is still open.
  expect(seen.some(e => e.type === "done")).toBe(false);
  finish();
  const rest = await collect(observe(id, seen.at(-1)!.sequence));
  expect(rest.at(-1)?.type).toBe("done");
  expect(rest.some(e => e.type === "text-delta")).toBe(false);
  const all = [...seen, ...rest];
  expect(all.map(e => e.sequence)).toEqual(all.map((_, i) => i + 1));
  // The host owns handled output now; a loop is not a second history store.
  await expect(collect(observe(id))).rejects.toThrow("event cursor expired");
  expect(requests).toHaveLength(1);
});

it("drains five concurrent streams without retaining handled token history", async () => {
  respond = async (request, response) => {
    begin("openai", response);
    for (let index = 0; index < 40; index++) {
      text("openai", response, `${request.body.model}:${index}😀 `);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    end("openai", response);
  };
  const outputs = await Promise.all(Array.from({ length: 5 }, async (_, index) => {
    const received: RustAgentLoopEvent[] = [];
    let id = "";
    for await (const current of streamRustAgentLoop({ ...input("openai"), model: `fixture-${index}` },
      AbortSignal.timeout(15_000), loop => { id = loop; loops.push(loop); })) received.push(current);
    expect(received.at(-1)?.type).toBe("done");
    expect(received.map(event => event.sequence)).toEqual(received.map((_, i) => i + 1));
    expect(received.filter(event => event.type === "text-delta").map(event => event.delta).join(""))
      .toBe(Array.from({ length: 40 }, (_, i) => `fixture-${index}:${i}😀 `).join(""));
    await expect(collect(observe(id))).rejects.toThrow("event cursor expired");
    return received;
  }));
  expect(outputs).toHaveLength(5);
  expect(requests).toHaveLength(5);
}, 20_000);

it("recovers unacknowledged text after an event socket disconnect without rerunning the model", async () => {
  respond = (_request, response) => {
    begin("openai", response);
    for (const delta of ["开头😀", "中间内容", "最后一段"]) text("openai", response, delta);
    end("openai", response);
  };
  const originalFetch = globalThis.fetch;
  const cursors: number[] = [];
  let severed = false;
  const patched = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
    const response = await originalFetch(url, options);
    if (!String(url).includes("/agent-loop/events?")) return response;
    cursors.push(Number(new URL(String(url)).searchParams.get("after")));
    if (severed || !response.body) return response;
    const reader = response.body.getReader();
    let buffered = Buffer.alloc(0);
    let cutoff = false;
    return new Response(new ReadableStream({
      async pull(controller) {
        if (cutoff) { controller.error(new TypeError("fixture socket disconnected")); return; }
        const next = await reader.read();
        if (next.done) { controller.close(); return; }
        buffered = Buffer.concat([buffered, next.value]);
        let offset = 0;
        let newline: number;
        while ((newline = buffered.indexOf(10, offset)) !== -1) {
          const event = JSON.parse(buffered.subarray(offset, newline).toString());
          offset = newline + 1;
          if (event.type === "text-delta") {
            cutoff = true; severed = true;
            controller.enqueue(buffered.subarray(0, offset));
            await reader.cancel();
            return;
          }
        }
        if (offset) { controller.enqueue(buffered.subarray(0, offset)); buffered = buffered.subarray(offset); }
      },
      cancel() { return reader.cancel(); },
    }));
  });
  try {
    const received: RustAgentLoopEvent[] = [];
    for await (const current of streamRustAgentLoop(input("openai"), AbortSignal.timeout(10_000), id => { loops.push(id); }))
      received.push(current);
    expect(severed).toBe(true);
    expect(cursors).toHaveLength(2);
    expect(cursors[1]).toBeGreaterThan(0);
    expect(received.filter(event => event.type === "text-delta").map(event => event.delta).join(""))
      .toBe("开头😀中间内容最后一段");
    expect(received.map(event => event.sequence)).toEqual(received.map((_, i) => i + 1));
    expect(received.at(-1)?.type).toBe("done");
    expect(requests).toHaveLength(1);
  } finally { patched.mockRestore(); }
});

it.each(protocols)("%s preserves the assistant turn and accepts reordered, idempotent tool results", async protocol => {
  respond = (_request, response) => {
    begin(protocol, response);
    if (requests.length === 1) {
      reasoning(protocol, response); text(protocol, response, "Before tools.");
      tool(protocol, response, 0); tool(protocol, response, 1); end(protocol, response, true);
    } else { text(protocol, response, "Finished."); end(protocol, response); }
  };
  const id = await start(protocol);
  const stream = observe(id);
  let cursor = 0;
  const calls: RustAgentLoopEvent[] = [];
  const reasoningEvents: RustAgentLoopEvent[] = [];
  for await (const e of stream) {
    cursor = e.sequence!;
    if (e.type === "reasoning-delta") reasoningEvents.push(e);
    if (e.type === "tool-call") calls.push(e);
    if (calls.length === 2) break;
  }
  expect(calls.map(e => e.toolCallId)).toEqual(["call_0", "call_1"]);
  expect(reasoningEvents[0]?.thinkingTokens).toBeGreaterThan(0);
  expect((await post("/agent-loop/tool-result", { loopId: id, toolCallId: "unknown", result: {} })).status).toBe(409);
  for (const call of calls.toReversed()) {
    const payload = { loopId: id, toolCallId: call.toolCallId, result: { echoed: call.toolCallId } };
    expect((await post("/agent-loop/tool-result", payload)).status).toBe(200);
    expect((await post("/agent-loop/tool-result", payload)).status).toBe(200);
    expect((await post("/agent-loop/tool-result", { ...payload, result: "conflict" })).status).toBe(409);
  }
  const rest = await collect(observe(id, cursor));
  expect(rest.at(-1)?.type).toBe("done");
  expect(rest.filter(e => e.type === "step-started").map(e => e.step)).toEqual([2]);
  expect(requests).toHaveLength(2);
  expect(requests[1].url).toBe(protocol === "openai" ? "/v1/chat/completions" : protocol === "openai-responses" ? "/v1/responses" : "/v1/messages");
  const history = JSON.stringify(requests[1].body);
  expect(history).toContain("Before tools.");
  expect(history).toContain("Consider both tools.");
  expect(history).toContain('echoed');
  if (protocol === "anthropic") expect(history).toContain("signed-fixture");
  if (protocol === "openai-responses") expect(history).toContain("opaque-fixture");
});

it.each([undefined, 1])("continues beyond former step limits (legacy maxSteps=%s)", async maxSteps => {
  const rounds = maxSteps === undefined ? 40 : 260;
  respond = (_request, response) => {
    begin("openai", response);
    if (requests.length <= rounds) {
      chat(response, { tool_calls: [{ index: 0, id: `round-${requests.length}`, type: "function", function: { name: "echo", arguments: '{"value":"ok"}' } }] });
      end("openai", response, true);
    } else { text("openai", response, "Finished all requested work."); end("openai", response); }
  };
  const started = await post("/agent-loop/start", { ...input("openai"), maxSteps });
  expect(started.status).toBe(200);
  const { loopId } = await started.json(); loops.push(loopId);
  const events: RustAgentLoopEvent[] = [];
  for await (const event of observe(loopId, 0, 60_000)) {
    events.push(event);
    if (event.type === "tool-call") {
      expect((await post("/agent-loop/tool-result", { loopId, toolCallId: event.toolCallId, result: "ok" })).status).toBe(200);
    }
  }
  expect(events.filter(event => event.type === "error")).toEqual([]);
  expect(events.filter(event => event.type === "step-started")).toHaveLength(rounds + 1);
  expect(events.at(-1)?.type).toBe("done");
  expect(requests).toHaveLength(rounds + 1);
}, 60_000);

it("cancellation stops upstream and resolves only after the terminal event exists", async () => {
  let disconnected = false;
  respond = (_request, response) => {
    begin("openai", response); text("openai", response, "In progress");
    response.on("close", () => { disconnected = true; });
  };
  const id = await start("openai");
  let cursor = 0;
  for await (const e of observe(id)) { cursor = e.sequence!; if (e.type === "text-delta") break; }
  expect((await post("/agent-loop/cancel", { loopId: id })).status).toBe(200);
  const events = await collect(observe(id, cursor));
  expect(events.at(-1)?.type).toBe("cancelled");
  expect(events.some(e => e.type === "done")).toBe(false);
  await vi.waitFor(() => expect(disconnected).toBe(true));
});

it.each(protocols)("%s stops after two argument correction retries without executing malformed tools", async protocol => {
  respond = (_request, response) => { begin(protocol, response); tool(protocol, response, 0, '{"bad":'); end(protocol, response, true); };
  const events = await collect(observe(await start(protocol)));
  expect(events.at(-1)?.type).toBe("error");
  expect(events.at(-1)?.error).toContain("tool 'echo'");
  expect(events.at(-1)?.error).toContain("call_0");
  expect(events.at(-1)?.error).toContain("EOF while parsing a value at line 1 column 7");
  expect(events.some(e => e.type === "tool-call")).toBe(false);
  expect(requests).toHaveLength(3);
  expect(events.filter(e => e.type === "step-restarted")).toHaveLength(2);
});

it.each(protocols)("%s regenerates malformed arguments before delivering any tool from the batch", async protocol => {
  respond = (_request, response) => {
    begin(protocol, response);
    if (requests.length === 1) {
      text(protocol, response, "Discard this partial answer.");
      tool(protocol, response, 0);
      tool(protocol, response, 1, '{"value":"private-incomplete');
      end(protocol, response, true);
    } else if (requests.length === 2) {
      tool(protocol, response, 0, '{"value":"corrected"}');
      end(protocol, response, true);
    } else { text(protocol, response, "Finished."); end(protocol, response); }
  };
  const id = await start(protocol);
  const events: RustAgentLoopEvent[] = [];
  for await (const e of observe(id)) {
    events.push(e);
    if (e.type === "tool-call") {
      expect(e.input).toEqual({ value: "corrected" });
      expect((await post("/agent-loop/tool-result", { loopId: id, toolCallId: e.toolCallId, result: "ok" })).status).toBe(200);
    }
  }
  expect(events.at(-1)?.type).toBe("done");
  expect(events.filter(e => e.type === "tool-call")).toHaveLength(1);
  expect(events.filter(e => e.type === "step-restarted")).toMatchObject([
    { step: 1, reason: "invalid_tool_arguments", maxRetries: 2 },
  ]);
  const retry = JSON.stringify(requests[1].body);
  expect(retry).toContain("No tools from this response were executed");
  expect(retry).toContain("complete JSON object");
  expect(retry).not.toContain("private-incomplete");
  expect(retry).not.toContain("Discard this partial answer");
  expect(requests).toHaveLength(3);
});

it.each(protocols)("%s repairs literal control characters in long code tool arguments", async protocol => {
  respond = (_request, response) => {
    begin(protocol, response);
    if (requests.length === 1) {
      tool(protocol, response, 0, '{"content":"line one\nline two","path":"game.html"}');
      end(protocol, response, true);
    } else { text(protocol, response, "Finished."); end(protocol, response); }
  };
  const id = await start(protocol);
  const events: RustAgentLoopEvent[] = [];
  for await (const e of observe(id)) {
    events.push(e);
    if (e.type === "tool-call") {
      expect(e.input).toEqual({ content: "line one\nline two", path: "game.html" });
      expect((await post("/agent-loop/tool-result", { loopId: id, toolCallId: e.toolCallId, result: "ok" })).status).toBe(200);
    }
  }
  expect(events.at(-1)?.type).toBe("done");
  expect(events.filter(e => e.type === "step-restarted")).toHaveLength(0);
  expect(requests).toHaveLength(2);
});

it("does not retry unrelated provider failures as invalid arguments", async () => {
  respond = (_request, response) => {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "Invalid API key", type: "authentication_error" } }));
  };
  const events = await collect(observe(await start("openai")));
  expect(events.at(-1)?.type).toBe("error");
  expect(requests).toHaveLength(1);
  expect(events.some(e => e.type === "step-restarted")).toBe(false);
});

async function crashAndRestartSidecar() {
  const generation = supervisor.generation;
  supervisor.process.kill("SIGKILL");
  await vi.waitFor(() => expect(supervisor.generation).toBeGreaterThan(generation), { timeout: 10_000 });
  await supervisor.waitUntilReady();
}

it.each(protocols)("%s resumes a durable tool checkpoint after a sidecar crash", async protocol => {
  respond = (_request, response) => {
    begin(protocol, response);
    if (requests.length === 1) {
      reasoning(protocol, response); text(protocol, response, "Before crash.");
      tool(protocol, response, 0); tool(protocol, response, 1); end(protocol, response, true);
    } else { text(protocol, response, "Recovered."); end(protocol, response); }
  };
  const id = await start(protocol, 1);
  let cursor = 0;
  const calls: RustAgentLoopEvent[] = [];
  for await (const e of observe(id)) {
    cursor = e.sequence!;
    if (e.type === "tool-call") calls.push(e);
    if (calls.length === 2) break;
  }
  const first = { loopId: id, toolCallId: "call_1", result: "saved before crash" };
  expect((await post("/agent-loop/tool-result", first)).status).toBe(200);
  await crashAndRestartSidecar();
  // Result acceptance itself survives restart, even before execution resumes.
  expect((await post("/agent-loop/tool-result", first)).status).toBe(200);
  expect((await post("/agent-loop/tool-result", { ...first, result: "changed" })).status).toBe(409);
  expect((await post("/agent-loop/resume", { ...input(protocol, 1), loopId: id })).status).toBe(200);
  expect((await post("/agent-loop/tool-result", { loopId: id, toolCallId: "call_0", result: "after crash" })).status).toBe(200);
  const rest = await collect(observe(id, cursor));
  expect(rest.at(-1)?.type).toBe("done");
  expect(requests).toHaveLength(2);
  const history = JSON.stringify(requests[1].body);
  expect(history).toContain("Before crash.");
  expect(history).toContain("saved before crash");
  expect(history).toContain("after crash");
  if (protocol === "anthropic") expect(history).toContain("signed-fixture");
  if (protocol === "openai-responses") expect(history).toContain("opaque-fixture");
  const all = await collect(observe(id));
  expect(all.filter(e => e.type === "tool-call")).toHaveLength(2);
  expect(all.map(e => e.sequence)).toEqual(all.map((_, i) => i + 1));
}, 15_000);

it("replays terminal events after restart without restarting the provider", async () => {
  respond = (_request, response) => { begin("openai", response); text("openai", response, "Completed"); end("openai", response); };
  const id = await start("openai");
  const completed = await collect(observe(id));
  await crashAndRestartSidecar();
  expect(await collect(observe(id))).toEqual(completed);
  expect(requests).toHaveLength(1);
}, 15_000);

it("retries an interrupted model step with an explicit reset event", async () => {
  respond = (_request, response) => {
    begin("openai", response);
    text("openai", response, requests.length === 1 ? "Incomplete attempt" : "Recovered answer");
    if (requests.length > 1) end("openai", response);
  };
  const id = await start("openai");
  let cursor = 0;
  for await (const e of observe(id)) {
    cursor = e.sequence!;
    if (e.type === "text-delta") break;
  }
  await crashAndRestartSidecar();
  expect((await post("/agent-loop/resume", { ...input("openai"), loopId: id })).status).toBe(200);
  const recovered = await collect(observe(id, cursor));
  expect(recovered[0]).toMatchObject({ type: "step-restarted", step: 1 });
  expect(recovered.filter(e => e.type === "text-delta").map(e => e.delta).join("")).toBe("Recovered answer");
  expect(recovered.at(-1)?.type).toBe("done");
  expect(requests).toHaveLength(2);
}, 15_000);

it("deduplicates concurrent starts and replays the same identity after restart", async () => {
  respond = (_request, response) => { begin("openai", response); text("openai", response, "One execution"); end("openai", response); };
  const request = { ...input("openai"), requestId: `start-${crypto.randomUUID()}` };
  const responses = await Promise.all([post("/agent-loop/start", request), post("/agent-loop/start", request)]);
  expect(responses.map(response => response.status)).toEqual([200, 200]);
  const [a, b] = await Promise.all(responses.map(response => response.json())) as Array<{ loopId: string }>;
  expect(a.loopId).toBe(b.loopId);
  loops.push(a.loopId);
  const completed = await collect(observe(a.loopId));
  expect(completed.at(-1)?.type).toBe("done");
  expect(requests).toHaveLength(1);
  expect((await post("/agent-loop/start", { ...request, model: "changed" })).status).toBe(400);
  await crashAndRestartSidecar();
  const replayed = await post("/agent-loop/start", request);
  expect(replayed.status).toBe(200);
  expect(await replayed.json()).toEqual({ loopId: a.loopId });
  expect(await collect(observe(a.loopId))).toEqual(completed);
  expect(requests).toHaveLength(1);
}, 15_000);

it("automatically reconnects an owned stream at the same provider port", async () => {
  respond = (_request, response) => {
    begin("openai", response);
    text("openai", response, requests.length === 1 ? "Interrupted prefix" : "Recovered automatically");
    if (requests.length > 1) end("openai", response);
  };
  const originalPort = process.env.SYNAX_RUNTIME_PROVIDER_PORT;
  const events: RustAgentLoopEvent[] = [];
  let killed = false;
  for await (const event of streamRustAgentLoop(input("openai"), AbortSignal.timeout(10_000), id => { loops.push(id); })) {
    events.push(event);
    if (!killed && event.type === "text-delta") {
      killed = true;
      await crashAndRestartSidecar();
      expect(process.env.SYNAX_RUNTIME_PROVIDER_PORT).toBe(originalPort);
    }
  }
  expect(events.at(-1)?.type).toBe("done");
  expect(events.filter(event => event.type === "step-restarted")).toHaveLength(1);
  expect(events.filter(event => event.type === "text-delta").map(event => event.delta)).toEqual(["Interrupted prefix", "Recovered automatically"]);
  expect(events.map(event => event.sequence)).toEqual(events.map((_, i) => i + 1));
  expect(requests).toHaveLength(2);
}, 15_000);

function largeHistory() {
  return [
    { role: "system", content: "Keep SYSTEM_RULE exactly." },
    { role: "user", content: "Preserve USER_REQUIREMENT exactly; do not infer approval." },
    { role: "assistant", content: "Earlier findings. ".repeat(900) },
    { role: "user", content: "Preserve SECOND_REQUIREMENT verbatim." },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "old-call", toolName: "echo", input: {} }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "old-call", output: "old tool evidence ".repeat(1500) }] },
    { role: "assistant", content: "Recent complete answer, preserve verbatim." },
    { role: "user", content: "LATEST_REQUIREMENT stays exactly." },
  ];
}

it.each(protocols)("%s compacts in Rust without losing pinned input or splitting tool exchanges", async protocol => {
  let summaries = 0;
  respond = (request, response) => {
    const summarizing = JSON.stringify(request.body).includes("You maintain a conversation checkpoint.");
    if (summarizing) summaries++;
    begin(protocol, response);
    text(protocol, response, summarizing ? "Earlier findings and evidence remain relevant. Work is unfinished." : "Final after checkpoint.");
    end(protocol, response);
  };
  const response = await post("/agent-loop/start", { ...input(protocol), prompt: largeHistory(),
    contextPolicy: { contextLimit: 3000, outputReserve: 128, keepRecentMessages: 2 } });
  expect(response.status).toBe(200);
  const { loopId } = await response.json() as { loopId: string };
  loops.push(loopId);
  const events = await collect(observe(loopId));
  expect(events.at(-1)?.type, JSON.stringify(events.at(-1))).toBe("done");
  expect(events.filter(event => event.type === "context-composition").at(-1)?.composition?.total).toBeLessThanOrEqual(2872);
  expect(summaries).toBeGreaterThan(1);
  const compacted = events.filter(event => event.type === "context-compacted");
  expect(compacted).toHaveLength(1);
  expect(compacted[0].compressedTokens).toBeLessThan(compacted[0].originalTokens!);
  expect(compacted[0].compressedTokens).toBeLessThanOrEqual(2872);
  expect(events.filter(event => event.type === "compaction-call-started")).toHaveLength(summaries);
  expect(events.filter(event => event.type === "compaction-call-finished")).toHaveLength(summaries);
  const finalBody = JSON.stringify(requests.at(-1)!.body);
  for (const required of ["SYSTEM_RULE", "USER_REQUIREMENT", "SECOND_REQUIREMENT", "LATEST_REQUIREMENT", "Recent complete answer"]) expect(finalBody).toContain(required);
  expect(finalBody).toContain("<context-summary>");
  expect(finalBody).not.toContain("old-call");
  expect(events.filter(event => event.type === "text-delta").map(event => event.delta).join("")).toBe("Final after checkpoint.");
}, 15_000);

it("blocks required context that cannot fit before any upstream request", async () => {
  respond = (_request, response) => { response.writeHead(500); response.end("Must not dispatch"); };
  const response = await post("/agent-loop/start", { ...input("openai"),
    prompt: [{ role: "user", content: "Required input ".repeat(5000) }],
    contextPolicy: { contextLimit: 1024, outputReserve: 128, keepRecentMessages: 2 } });
  const { loopId } = await response.json() as { loopId: string };
  loops.push(loopId);
  const events = await collect(observe(loopId));
  expect(events.at(-1)).toMatchObject({ type: "error", error: expect.stringContaining("context_blocked") });
  expect(requests).toHaveLength(0);
});

it("does not substitute an empty or truncated summary for retained history", async () => {
  respond = (_request, response) => { begin("openai", response); end("openai", response); };
  const response = await post("/agent-loop/start", { ...input("openai"), prompt: largeHistory(),
    contextPolicy: { contextLimit: 3000, outputReserve: 128, keepRecentMessages: 2 } });
  const { loopId } = await response.json() as { loopId: string };
  loops.push(loopId);
  const events = await collect(observe(loopId));
  expect(events.at(-1)).toMatchObject({ type: "error", error: expect.stringContaining("complete checkpoint") });
  expect(events.some(event => event.type === "context-compacted" || event.type === "done")).toBe(false);
  expect(requests).toHaveLength(1);
});

it("resumes compaction from the last committed summary chunk after a crash", async () => {
  let recover = false;
  let summaryCalls = 0;
  respond = (request, response) => {
    const summarizing = JSON.stringify(request.body).includes("You maintain a conversation checkpoint.");
    if (summarizing) summaryCalls++;
    begin("openai", response);
    if (summarizing && summaryCalls > 1 && !recover) return;
    text("openai", response, summarizing ? "Retained earlier evidence and next actions." : "Recovered final answer.");
    end("openai", response);
  };
  const events: RustAgentLoopEvent[] = [];
  const request = { ...input("openai"), prompt: largeHistory(),
    contextPolicy: { contextLimit: 3000, outputReserve: 128, keepRecentMessages: 2 } };
  for await (const event of streamRustAgentLoop(request, AbortSignal.timeout(15_000), id => { loops.push(id); })) {
    events.push(event);
    if (!recover && event.type === "compaction-call-finished") {
      recover = true;
      await crashAndRestartSidecar();
    }
  }
  expect(events.at(-1)?.type, JSON.stringify(events.at(-1))).toBe("done");
  expect(events.filter(event => event.type === "context-compacted")).toHaveLength(1);
  expect(events.filter(event => event.type === "compaction-call-finished" && event.chunk === 1)).toHaveLength(1);
  const completed = events.filter(event => event.type === "compaction-call-finished");
  expect(new Set(completed.map(event => event.requestId)).size).toBe(completed.length);
  expect(events.filter(event => event.type === "text-delta").map(event => event.delta)).toEqual(["Recovered final answer."]);
  expect(JSON.stringify(requests.at(-1)!.body)).toContain("USER_REQUIREMENT");
  expect(events.map(event => event.sequence)).toEqual(events.map((_, index) => index + 1));
}, 20_000);

it.each(protocols)("%s normalizes legacy dotted tool names at the Rust boundary and preserves dispatch", async protocol => {
  respond = (_request, response) => {
    const body = requests.at(-1)!.body as any;
    const name = protocol === "openai" ? body.tools[0].function.name : body.tools[0].name;
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Invalid tools[0].name: expected ^[a-zA-Z0-9_-]+$" } }));
      return;
    }
    begin(protocol, response);
    if (requests.length === 1) {
      tool(protocol, response, 0, '{"value":"safe"}', name); end(protocol, response, true);
    } else { text(protocol, response, "Completed with a valid wire name."); end(protocol, response); }
  };
  const request = { ...input(protocol), tools: [{ ...input(protocol).tools[0], name: "file.read" }] };
  const started = await post("/agent-loop/start", request);
  expect(started.status).toBe(200);
  const { loopId } = await started.json(); loops.push(loopId);
  const events = [];
  for await (const current of observe(loopId)) {
    events.push(current);
    if (current.type === "tool-call") {
      expect(current.toolName).toBe("file.read");
      expect(current.input).toEqual({ value: "safe" });
      expect((await post("/agent-loop/tool-result", { loopId, toolCallId: current.toolCallId, result: "read-only fixture" })).status).toBe(200);
    }
  }
  expect(events.at(-1)?.type, JSON.stringify(events.at(-1))).toBe("done");
  expect(requests).toHaveLength(2);
  const first = requests[0].body as any;
  const second = requests[1].body as any;
  const wireName = protocol === "openai" ? first.tools[0].function.name : first.tools[0].name;
  expect(wireName).not.toBe("file.read");
  expect(JSON.stringify(second)).toContain(wireName);
  expect(JSON.stringify(second)).not.toContain('"name":"file.read"');
});
