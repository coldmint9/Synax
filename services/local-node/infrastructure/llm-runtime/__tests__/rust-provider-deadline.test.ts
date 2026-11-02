import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { ensureTestRuntime } from "../../../../test-fixtures/rust-runtime.js";
import { streamProvider } from "../native-client.js";
import type { ProviderEvent, ProviderRequest } from "../contracts.js";

// Scale the production 45s / 300s budgets without changing their ordering.
const firstResponseMs = 500;
const idleMs = 2000;
const contentDelayMs = 1000;
type ProviderDeltaEvent = Extract<ProviderEvent, {
  type: "text-delta" | "reasoning-delta" | "reasoning-signature";
}>;
beforeAll(async () => {
  vi.stubEnv("AGENT_LLM_FIRST_EVENT_TIMEOUT_MS", String(firstResponseMs));
  vi.stubEnv("AGENT_LLM_STREAM_IDLE_TIMEOUT_MS", String(idleMs));
  await ensureTestRuntime();
});
afterAll(() => vi.unstubAllEnvs());

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});

async function fixture(reply: (res: http.ServerResponse) => void) {
  let requests = 0;
  const server = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain the request */ }
    requests++;
    reply(res);
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const request: ProviderRequest = {
    providerId: "test:deadline", apiFormat: "openai-responses", model: "fixture", apiKey: "fixture",
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, maxRetries: 0,
    prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  };
  return { request, requests: () => requests };
}

function event(res: http.ServerResponse, type: string, value: object) {
  res.write(`data: ${JSON.stringify({ type, ...value })}\n\n`);
}

function complete(res: http.ServerResponse) {
  const item = { type: "message", id: "msg_fixture", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: "ok", annotations: [] }] };
  event(res, "response.output_item.added", { output_index: 0, item: { ...item, content: [] } });
  event(res, "response.output_text.delta", { output_index: 0, content_index: 0, item_id: item.id, delta: "ok" });
  event(res, "response.output_item.done", { output_index: 0, item });
  event(res, "response.completed", { response: { id: "resp_fixture", model: "fixture", status: "completed", output: [item] } });
  res.end();
}

async function consume(request: ProviderRequest) {
  const events: ProviderEvent[] = [];
  for await (const item of streamProvider(request)) events.push(item);
  return events;
}

it.each(["headers", "lifecycle", "heartbeat"] as const)(
  "does not apply the connection deadline to delayed content after %s", async prelude => {
    const upstream = await fixture(res => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();
      if (prelude === "lifecycle") {
        event(res, "response.created", { response: { id: "resp_fixture", status: "in_progress", output: [] } });
        event(res, "response.in_progress", { response: { id: "resp_fixture", status: "in_progress", output: [] } });
      }
      const heartbeat = prelude === "heartbeat" ? setInterval(() => res.write(": ping\n\n"), 100) : undefined;
      const timer = setTimeout(() => complete(res), contentDelayMs);
      res.on("close", () => { clearTimeout(timer); clearInterval(heartbeat); });
    });
    const events = await consume(upstream.request);
    expect(events
      .filter((item): item is ProviderDeltaEvent => item.type === "text-delta")
      .map(item => item.delta)
      .join(""))
      .toBe("ok");
    expect(events.at(-1)?.type).toBe("finish");
    expect(events.some(item => item.type === "retry_status")).toBe(false);
    expect(upstream.requests()).toBe(1);
  }, 10_000,
);

it("still bounds an upstream that never returns response headers", async () => {
  const upstream = await fixture(() => { /* connected, but no HTTP response */ });
  await expect(consume(upstream.request)).rejects.toThrow(`no events for ${firstResponseMs}ms`);
  expect(upstream.requests()).toBe(1);
}, 10_000);

it("still bounds a silent body after response headers using the stream idle budget", async () => {
  const upstream = await fixture(res => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.flushHeaders();
  });
  await expect(consume(upstream.request)).rejects.toThrow(`no events for ${idleMs}ms`);
  expect(upstream.requests()).toBe(1);
}, 10_000);
