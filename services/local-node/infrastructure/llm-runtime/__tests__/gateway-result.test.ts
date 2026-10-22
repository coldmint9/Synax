import { afterEach, expect, it } from "vitest";
import { collectGatewayResult, gatewayResult } from "../gateway-result.js";
import { llmHooks, type LlmHookEvent } from "../llm-hooks.js";
import type { ProviderEvent } from "../contracts.js";

afterEach(() => llmHooks.unregister("native-result-test"));
async function* events(...values: ProviderEvent[]) { yield* values; }

it("preserves native protocol usage, structured results and lifecycle hooks", async () => {
  const hooks: LlmHookEvent[] = [];
  llmHooks.register({ id: "native-result-test", handler: event => { hooks.push(event); } });
  const result = await collectGatewayResult(gatewayResult(events(
    { type: "text-delta", id: "t", delta: '{"ok":true}' },
    { type: "structured-output", value: { ok: true } },
    { type: "usage", usage: { source: "native", protocol: "openai-responses", inputTokens: 7, outputTokens: 3,
      raw: { input_tokens: 7, prompt_tokens: 999, output_tokens: 3, input_tokens_details: { cached_tokens: 0 }, prompt_cache_hit_tokens: 5 } } },
    { type: "finish", finishReason: "stop" },
  ), { purpose: "fixture", messages: [] }, "fixture", "local", { boundary: "native-bridge" }));
  expect(result).toMatchObject({ text: '{"ok":true}', output: { ok: true }, usage: { inputTokens: 7, outputTokens: 3, cachedInputTokens: 0,
    normalization: { source: "native", protocol: "openai-responses" } } });
  expect(result.providerMetadata).toMatchObject({ synax: { cacheDiagnostics: { boundary: "native-bridge", firstTokenMs: expect.any(Number) } } });
  expect(hooks.map(event => event.type)).toEqual(["generation:start", "step:start", "step:finish", "generation:finish"]);
});

it("does not report successful completion for an interrupted native stream", async () => {
  await expect(collectGatewayResult(gatewayResult(events({ type: "text-delta", id: "t", delta: "partial" }),
    { purpose: "fixture", messages: [] }, "fixture", "local"))).rejects.toThrow("without completion");
});

it("closes the native iterator when a host consumer stops reading", async () => {
  let closed = false;
  const native = (async function* (): AsyncGenerator<ProviderEvent> {
    try { yield { type: "text-delta", id: "t", delta: "partial" }; }
    finally { closed = true; }
  })();
  const stream = gatewayResult(native, { purpose: "fixture", messages: [] }, "fixture", "local");
  for await (const _event of stream.fullStream) break;
  expect(closed).toBe(true);
  await expect(stream.result).rejects.toThrow("cancelled");
});
