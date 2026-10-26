import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeAll, expect, it } from "vitest";
import { ensureTestRuntime } from "../../../../test-fixtures/rust-runtime.js";
import { streamProvider } from "../native-client.js";
import type { ProviderRequest } from "../contracts.js";
import { streamRustAgentLoop } from "../../../modules/agent-runtime/rust-agent-loop-client.js";
import { executePipeline } from "../pipeline.js";
import { z } from "zod";

beforeAll(ensureTestRuntime);
const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections(); server.close(() => resolve());
  })));
});
type Protocol = "openai" | "openai-responses" | "anthropic";
async function fixture(protocol: Protocol, failures: number[] = [], maxRetries?: number) {
  const requests: Array<{ url: string; headers: http.IncomingHttpHeaders; body: any }> = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url!, headers: req.headers, body: JSON.parse(body) });
    const failure = failures[requests.length - 1];
    if (failure === -1) { res.destroy(); return; }
    if (failure) {
      res.writeHead(failure, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "fixture upstream failure" } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const event = (type: string, value: object) => res.write(`data: ${JSON.stringify({ type, ...value })}\n\n`);
    if (protocol === "openai") {
      const base = { id: "chat_fixture", object: "chat.completion.chunk", created: 0, model: "fixture" };
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: '{"ok":true}' }, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 3 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    } else if (protocol === "openai-responses") {
      const item = { type: "message", id: "message_fixture", role: "assistant", status: "completed", content: [{ type: "output_text", text: '{"ok":true}', annotations: [] }] };
      event("response.output_item.added", { output_index: 0, item: { ...item, content: [] } });
      event("response.output_text.delta", { output_index: 0, content_index: 0, item_id: item.id, delta: '{"ok":true}' });
      event("response.output_item.done", { output_index: 0, item });
      event("response.completed", { response: { id: "resp_fixture", model: "fixture", status: "completed", output: [item], usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 } } });
      res.end();
    } else {
      event("message_start", { message: { id: "msg_fixture", model: "fixture", type: "message", role: "assistant", content: [], usage: { input_tokens: 7, output_tokens: 0 } } });
      event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      event("content_block_delta", { index: 0, delta: { type: "text_delta", text: '{"ok":true}' } });
      event("content_block_stop", { index: 0 });
      event("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } });
      event("message_stop", {}); res.end();
    }
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const model: ProviderRequest = { providerId: "custom-api:parity", apiFormat: protocol,
    baseUrl, apiKey: "test-key", headers: { "x-fixture": "custom-header" }, maxRetries, model: "fixture", prompt: [] };
  return { requests, model, baseUrl };
}
async function consume(model: ProviderRequest, options: Partial<ProviderRequest> = {}) {
  const events = [];
  for await (const event of streamProvider({ ...model, prompt: [{ role: "user", content: [{ type: "text", text: "Respond in JSON" }] }], ...options })) events.push(event);
  expect(events.flatMap(event => event.type === "text-delta" ? [event.delta] : []).join("")).toBe('{"ok":true}');
  expect(events.find(event => event.type === "usage")).toMatchObject({ usage: { inputTokens: 7, outputTokens: 3 } });
  expect(events.at(-1)).toMatchObject({ type: "finish" });
}

it.each<[Protocol, number]>([["openai", 429], ["openai-responses", 599], ["anthropic", 501]])(
  "%s retries HTTP %s before streaming a successful response", async (protocol, status) => {
    const { model, requests } = await fixture(protocol, [status]);
    await consume(model, {});
    expect(requests).toHaveLength(2);
    expect(requests[1].body).toEqual(requests[0].body);
  }, 10_000,
);

it("recovers from a dropped upstream connection inside Rust", async () => {
  const { model, requests } = await fixture("openai", [-1]);
  await consume(model);
  expect(requests).toHaveLength(2);
}, 10_000);

it('preserves a disabled retry budget and the HTTP status across the Rust bridge', async () => {
  const { model, requests } = await fixture('openai', [503], 0);
  await expect(consume(model))
    .rejects.toMatchObject({ statusCode: 503 });
  expect(requests).toHaveLength(1);
});

it('does not retry authentication failures', async () => {
  const { model, requests } = await fixture('anthropic', [401]);
  await expect(consume(model))
    .rejects.toMatchObject({ statusCode: 401 });
  expect(requests).toHaveLength(1);
});

it('prevents Node from retrying again after the Rust budget is exhausted', async () => {
  const { model, requests } = await fixture('openai', [503, 429], 1);
  await expect(consume(model))
    .rejects.toMatchObject({ statusCode: 429, isRetryable: false, message: expect.stringContaining('retried 1 times') });
  expect(requests).toHaveLength(2);
}, 10_000);

it('the native Rust loop reports retries and recovers from an upstream failure', async () => {
  const { baseUrl, requests } = await fixture('openai', [503]);
  const events = [];
  for await (const event of streamRustAgentLoop({ apiFormat: 'openai', baseUrl, apiKey: 'fixture', model: 'fixture',
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] })) events.push(event);
  expect(events.filter(event => event.type === 'error')).toEqual([]);
  expect(events.filter(event => event.type === 'retry_status').map(event => event.retry?.phase))
    .toEqual(['waiting', 'retrying', 'recovered']);
  expect(events.find(event => event.type === 'retry_status')?.retry).toMatchObject({ maxRetries: 10, attempt: 1, reason: 'upstream' });
  expect(events.at(-1)?.type).toBe('done');
  expect(requests).toHaveLength(2);
}, 10_000);

it.each<Protocol>(["openai", "openai-responses", "anthropic"])("%s sends sampling, schema, images and custom headers through Rust", async protocol => {
  const { model, requests } = await fixture(protocol);
  await consume(model, {
    temperature: 0.25, ...(protocol !== "anthropic" ? { topP: 0.85 } : {}), maxOutputTokens: 1024,
    ...(protocol !== "openai-responses" ? { stopSequences: ["END"] } : {}),
    responseFormat: { type: "json", name: "Result", schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } },
    prompt: [{ role: "user", content: [{ type: "text", text: "Describe the image as JSON" }, { type: "file", mediaType: "image/png", data: { type: "data", data: new Uint8Array([137, 80, 78, 71]) } }] }],
  });
  expect(requests).toHaveLength(1);
  const request = requests[0];
  expect(request.headers["x-fixture"]).toBe("custom-header");
  expect(request.body).toMatchObject({ temperature: 0.25, stream: true, model: "fixture" });
  if (protocol !== "anthropic") expect(request.body.top_p).toBe(0.85);
  expect(JSON.stringify(request.body)).toContain("iVBORw==");
  expect(JSON.stringify(request.body)).toContain('"ok":{"type":"boolean"}');
  if (protocol === "anthropic") {
    expect(request.url).toBe("/v1/messages");
    expect(request.headers["x-api-key"]).toBe("test-key");
    expect(request.body).toMatchObject({ max_tokens: 1024, stop_sequences: ["END"] });
  } else {
    expect(request.headers.authorization).toBe("Bearer test-key");
    if (protocol === "openai") {
      expect(request.url).toBe("/v1/chat/completions");
      expect(request.body.stop).toEqual(["END"]);
      expect(request.body.max_completion_tokens ?? request.body.max_tokens).toBe(1024);
    } else {
      expect(request.url).toBe("/v1/responses");
      expect(request.body).toMatchObject({ max_output_tokens: 1024 });
    }
  }
});

it.each<Protocol>(["openai", "openai-responses", "anthropic"])("%s preserves required and disabled tool choice", async protocol => {
  const { model, requests } = await fixture(protocol);
  for (const type of ["required", "none"] as const) {
    await consume(model, { tools: [{ type: "function", name: "inspect", description: "Inspect", inputSchema: { type: "object", properties: {} } }], toolChoice: { type }, maxOutputTokens: 1024 });
  }
  expect(requests[0].body.tool_choice).toEqual(protocol === "anthropic" ? { type: "any" } : "required");
  expect(requests[1].body.tool_choice).toEqual(protocol === "anthropic" ? { type: "none" } : "none");
});

it("passes connection reasoning options without sending SDK-only fields", async () => {
  const { model, requests } = await fixture("openai-responses");
  await consume(model, { providerOptions: { openai: { forceReasoning: true, passThroughUnsupportedFiles: true },
    "custom-api:parity": { reasoningEffort: "high", parallelToolCalls: false, promptCacheKey: "stable-key", store: false } } });
  expect(requests[0].body).toMatchObject({ reasoning: { effort: "high" }, parallel_tool_calls: false, prompt_cache_key: "stable-key", store: false });
  expect(requests[0].body).not.toHaveProperty("forceReasoning");
  expect(requests[0].body).not.toHaveProperty("passThroughUnsupportedFiles");
});

it("cancels an idle upstream when the downstream reader is cancelled", async () => {
  let closed!: () => void;
  const upstreamClosed = new Promise<void>(resolve => { closed = resolve; });
  const server = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain the request */ }
    res.on("close", closed);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ id: "idle", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }] })}\n\n`);
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const model: ProviderRequest = { providerId: "test", apiFormat: "openai", apiKey: "never-return-this-key", model: "fixture",
    headers: { "x-private": "never-return-this-header" }, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    prompt: [{ role: "user", content: [{ type: "text", text: "wait" }] }] };
  const stream = streamProvider(model);
  for await (const event of stream) {
    expect(JSON.stringify(event)).not.toContain("never-return");
    if (event.type === "text-delta") break;
  }
  await upstreamClosed;
}, 5000);

it("supports Messages top-p without a conflicting temperature", async () => {
  const { model, requests } = await fixture("anthropic");
  await consume(model, { topP: 0.6 });
  expect(requests[0].body.top_p).toBe(0.6);
  expect(requests[0].body).not.toHaveProperty("temperature");
  expect(requests[0].body.max_tokens).toBeGreaterThan(0);
});

it("uses a model-aware mandatory Messages cap and preserves explicit overrides", async () => {
  const { model, requests } = await fixture("anthropic");
  await consume(model, { requiredMaxOutputTokens: 128_000 });
  await consume(model, { requiredMaxOutputTokens: 128_000, maxOutputTokens: 1024 });
  expect(requests.map(request => request.body.max_tokens)).toEqual([128_000, 1024]);
});

it("sends only an explicit modern total-output cap on compatible Chat endpoints", async () => {
  const { model, requests } = await fixture("openai");
  await consume(model, { outputTokenParameter: "max_completion_tokens" });
  await consume(model, { outputTokenParameter: "max_completion_tokens", maxOutputTokens: 65_536 });
  expect(requests[0].body).not.toHaveProperty("max_completion_tokens");
  expect(requests[1].body.max_completion_tokens).toBe(65_536);
  for (const request of requests) expect(request.body).not.toHaveProperty("max_tokens");
});

it("never leaks a required-protocol fallback into Responses requests", async () => {
  const { model, requests } = await fixture("openai-responses");
  await consume(model, { requiredMaxOutputTokens: 128_000, outputTokenParameter: "max_completion_tokens" });
  expect(requests[0].body).not.toHaveProperty("max_output_tokens");
  expect(requests[0].body).not.toHaveProperty("max_completion_tokens");
  expect(requests[0].body).not.toHaveProperty("max_tokens");
});

it("parses structured output in Rust and validates the business shape in Node", async () => {
  const { baseUrl, requests } = await fixture("openai-responses");
  const result = await executePipeline({ purpose: "fixture", messages: [{ role: "user", content: "Return json" }] }, {
    model: "fixture/model", modelId: "fixture", providerId: "fixture", apiFormat: "openai-responses",
    provider: { id: "fixture", label: "Fixture", npm: "@ai-sdk/openai", env: [], supported: true, models: [] },
    modelDef: { id: "fixture", label: "Fixture" }, config: { providerId: "fixture", baseUrl, apiKey: "fixture" },
  }, { kind: "object", schema: z.object({ ok: z.boolean() }) });
  expect(result).toMatchObject({ output: { ok: true } });
  expect(requests[0].body.text.format.schema.properties).toEqual({ ok: { type: "boolean" } });
});
