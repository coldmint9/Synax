import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeUsage, normalizeResultUsage } from "../usage.js";

import { generateText, streamText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createAnthropic } from "@ai-sdk/anthropic";
import type {
  LanguageModelV4,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from "@ai-sdk/provider";
import { aggregateUsage, whitelistRawUsage } from "../usage.js";
import { applyUsageMiddleware } from "../middleware/usage.js";
import { buildHookCallbacks } from "../middleware/hook-callbacks.js";
import { llmHooks, type LlmHookEvent } from "../llm-hooks.js";
import {
  usageFromAcpPrompt,
  usageFromAcpUpdate,
  readUsageInputTokens,
  readUsageOutputTokens,
} from "../../agent-runtime/acp-engine/acp-usage.js";
const gateway = vi.hoisted(() => ({ createGatewayStream: vi.fn() }));
vi.mock("../gateway.js", () => gateway);
import { streamLoopModelStep } from "../../agent-runtime/loop-model-stream.js";
import { buildLoopToolSet } from "../../agent-runtime/loop-ai-tools.js";

afterEach(() => llmHooks.unregister("usage-test"));
const normalized = (value: unknown) => normalizeUsage(value)!;

describe("source-aware usage", () => {
  it("uses raw compatible cache hits over SDK synthetic zero", () => {
    expect(
      normalizeUsage({
        inputTokens: 10000,
        inputTokenDetails: { cacheReadTokens: 0 },
        raw: { prompt_tokens: 10000, prompt_cache_hit_tokens: 8000 },
      })?.cachedInputTokens,
    ).toBe(8000);
  });
});

describe("presence, validation and provenance", () => {
  it("honors a raw standard zero before a positive custom alias", () => {
    const u = normalized({
      raw: {
        prompt_tokens: 10000,
        prompt_tokens_details: { cached_tokens: 0 },
        prompt_cache_hit_tokens: 8000,
      },
    });
    expect(u.cachedInputTokens).toBe(0);
    expect(u.normalization.cacheRead).toEqual({
      status: "known",
      value: 0,
      source: "raw:prompt_tokens_details.cached_tokens",
      rawPresent: true,
    });
  });
  it.each([
    null,
    "8000",
    -1,
    1.5,
    Infinity,
    NaN,
    {},
    Number.MAX_SAFE_INTEGER + 1,
  ])("does not hide invalid standard fields (%s)", (value) => {
    const u = normalized({
      cachedInputTokens: 6000,
      raw: {
        prompt_tokens_details: { cached_tokens: value },
        prompt_cache_hit_tokens: 8000,
      },
    });
    expect(u.cachedInputTokens).toBeUndefined();
    expect(u.normalization.cacheRead).toMatchObject({
      status: "unknown",
      rawPresent: true,
    });
  });
  it("does not count inherited fields as wire evidence", () => {
    const u = normalized({
      raw: {
        prompt_tokens_details: Object.create({ cached_tokens: 0 }),
        prompt_cache_hit_tokens: 8000,
      },
    });
    expect(u.cachedInputTokens).toBe(8000);
  });
  it("keeps missing, invalid and ambiguous old SDK zero unknown", () => {
    for (const u of [
      {},
      { inputTokens: "100" },
      { cachedInputTokens: 0 },
      { inputTokenDetails: { cacheReadTokens: 0 } },
    ]) {
      expect(normalized(u).normalization.cacheRead.status).toBe("unknown");
    }
    expect(normalizeUsage(undefined)).toBeUndefined();
    expect(normalizeUsage([])).toBeUndefined();
    expect(
      normalized({ inputTokens: -3, outputTokens: NaN }).totalTokens,
    ).toBeUndefined();
  });
  it("does not retain arbitrary wire content", () => {
    const raw = whitelistRawUsage({
      prompt_tokens: 100,
      prompt_cache_hit_tokens: "SECRET",
      content: "SECRET",
      prompt_tokens_details: { cached_tokens: 80, content: "SECRET" },
    });
    expect(raw).toEqual({
      prompt_tokens: 100,
      prompt_cache_hit_tokens: null,
      prompt_tokens_details: { cached_tokens: 80 },
    });
    expect(JSON.stringify(raw)).not.toContain("SECRET");
  });
  it("is idempotent even after JSON persistence", () => {
    const first = normalized({
      raw: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 8000,
        cache_creation_input_tokens: 1000,
      },
    });
    expect(first.inputTokens).toBe(9100);
    expect(normalizeUsage(first)).toBe(first);
    const saved = JSON.parse(JSON.stringify(first));
    expect(normalizeUsage(saved)).toEqual(saved);
  });
  it("adds Anthropic raw components once and never re-adds to SDK totals", () => {
    const raw = {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 8000,
      cache_creation_input_tokens: 1000,
      cache_creation: {
        ephemeral_5m_input_tokens: 1000,
        ephemeral_1h_input_tokens: 0,
      },
    };
    expect(normalized({ raw }).inputTokens).toBe(9100);
    expect(normalized({ inputTokens: 9100, raw }).inputTokens).toBe(9100);
    expect(
      normalizeUsage(
        { inputTokens: 9100, cachedInputTokens: 8000, cacheWriteTokens: 1000 },
        { protocol: "anthropic", source: "sdk" },
      )?.inputTokens,
    ).toBe(9100);
    expect(
      normalizeUsage(
        { input_tokens: 100, cache_read_input_tokens: 8000 },
        { protocol: "anthropic" },
      )?.inputTokens,
    ).toBeUndefined();
  });
  it("derives cache writes only with all detail components and prefers a present total", () => {
    const cache_creation = {
      ephemeral_5m_input_tokens: 20,
      ephemeral_1h_input_tokens: 30,
    };
    expect(normalized({ raw: { cache_creation } }).cacheWriteTokens).toBe(50);
    expect(
      normalized({ raw: { cache_creation, cache_creation_input_tokens: 0 } })
        .cacheWriteTokens,
    ).toBe(0);
    expect(
      normalized({ raw: { cache_creation: { ephemeral_5m_input_tokens: 20 } } })
        .cacheWriteTokens,
    ).toBeUndefined();
  });
  it("keeps Responses input inclusive and reasoning separate from output", () => {
    const u = normalized({
      raw: {
        input_tokens: 10000,
        input_tokens_details: { cached_tokens: 8000 },
        output_tokens: 100,
        output_tokens_details: { reasoning_tokens: 75 },
      },
    });
    expect(u).toMatchObject({
      inputTokens: 10000,
      cachedInputTokens: 8000,
      outputTokens: 100,
      reasoningTokens: 75,
      totalTokens: 10100,
    });
  });
  it("aggregates steps strictly instead of counting finish usage twice", () => {
    const a = normalized({
      inputTokens: 100,
      outputTokens: 10,
      cachedInputTokens: 80,
    });
    const b = normalized({
      inputTokens: 1000,
      outputTokens: 20,
      cachedInputTokens: 20,
    });
    expect(aggregateUsage([a, b])).toMatchObject({
      inputTokens: 1100,
      outputTokens: 30,
      cachedInputTokens: 100,
    });
    expect(
      aggregateUsage([a, normalized({ inputTokens: 200 })])?.cachedInputTokens,
    ).toBeUndefined();
    expect(aggregateUsage([a])).toBe(a);
  });
});

describe("ACP and CLI compatibility", () => {
  it("recognizes explicit ACP cache zero and cache writes without adding to input", () => {
    const u = normalized(
      usageFromAcpPrompt({
        inputTokens: 10000,
        outputTokens: 20,
        totalTokens: 10020,
        cachedReadTokens: 0,
        cachedWriteTokens: 50,
        thoughtTokens: 5,
      }),
    );
    expect(u).toMatchObject({
      inputTokens: 10000,
      cachedInputTokens: 0,
      cacheWriteTokens: 50,
      reasoningTokens: 5,
    });
    expect(u.normalization.cacheRead.status).toBe("known");
  });
  it.each(["codex", "claude-code", "cli"])(
    "recognizes %s aliases and already inclusive input",
    (source) => {
      const u = normalized({
        source,
        inputTokens: 10000,
        outputTokens: 20,
        cachedInputTokens: 0,
        cacheWriteTokens: 50,
      });
      expect(u).toMatchObject({
        inputTokens: 10000,
        cachedInputTokens: 0,
        cacheWriteTokens: 50,
      });
      expect(u.normalization.source).toBe("cli");
    },
  );
  it("supports old raw records via the same readers", () => {
    expect(
      readUsageInputTokens({
        prompt_tokens: 10000,
        prompt_cache_hit_tokens: 8000,
      }),
    ).toBe(10000);
    expect(
      readUsageInputTokens({
        input_tokens: 100,
        cache_read_input_tokens: 8000,
        cache_creation_input_tokens: 1000,
      }),
    ).toBe(9100);
    expect(readUsageOutputTokens({ completion_tokens: 20 })).toBe(20);
    expect(readUsageInputTokens({ used: 42000 })).toBe(42000);
    expect(readUsageInputTokens({ inputTokens: -1 })).toBe(0);
  });
  it("keeps ACP context occupancy separate with cache availability unknown", () => {
    const u = normalized(usageFromAcpUpdate({ used: 42000, size: 200000 }));
    expect(u.inputTokens).toBe(42000);
    expect(u.contextWindowSize).toBe(200000);
    expect(u.outputTokens).toBeUndefined();
    expect(u.normalization.cacheRead.status).toBe("unknown");
  });
});

function sse(events: unknown[]) {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") +
      "data: [DONE]\n\n",
    { headers: { "Content-Type": "text/event-stream" } },
  );
}
function compatible(usage: Record<string, unknown>, streaming = true) {
  const provider = createOpenAICompatible({
    name: "fixture",
    baseURL: "https://fixture.invalid/v1",
    fetch: async () =>
      streaming
        ? sse([
            {
              id: "fixture",
              object: "chat.completion.chunk",
              created: 1,
              model: "fixture",
              choices: [
                { index: 0, delta: { content: "ok" }, finish_reason: null },
              ],
            },
            {
              id: "fixture",
              object: "chat.completion.chunk",
              created: 1,
              model: "fixture",
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              usage: { completion_tokens: 20, ...usage },
            },
          ])
        : new Response(
            JSON.stringify({
              id: "fixture",
              object: "chat.completion",
              created: 1,
              model: "fixture",
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: "ok" },
                  finish_reason: "stop",
                },
              ],
              usage: { completion_tokens: 20, ...usage },
            }),
            { headers: { "Content-Type": "application/json" } },
          ),
  });
  return applyUsageMiddleware(provider.chatModel("fixture"), {
    protocol: "openai-chat",
    adapter: "@ai-sdk/openai-compatible",
  });
}

describe("actual SDK boundary with mocked transports", () => {
  it("preserves custom raw usage through streaming SDK normalization and hooks/persistence agree", async () => {
    const events: LlmHookEvent[] = [];
    llmHooks.register({
      id: "usage-test",
      handler: (event) => {
        events.push(event);
      },
    });
    const result = streamText({
      model: compatible({
        prompt_tokens: 10000,
        prompt_cache_hit_tokens: 8000,
        ignored: "SECRET",
      }),
      prompt: "fixture",
      maxRetries: 0,
      ...buildHookCallbacks({ purpose: "executor", messages: [] }),
    });
    gateway.createGatewayStream.mockResolvedValue(result);
    const loopEvents = [];
    for await (const event of streamLoopModelStep({
      request: { purpose: "executor", messages: [] },
      tools: buildLoopToolSet([]),
      model: "fixture",
    }))
      loopEvents.push(event);
    const persisted = loopEvents.find(
      (event) => event.type === "step_complete",
    );
    expect(persisted?.type).toBe("step_complete");
    if (persisted?.type !== "step_complete")
      throw new Error("Missing completion");
    expect(persisted.step.usage).toMatchObject({
      inputTokens: 10000,
      cachedInputTokens: 8000,
    });
    expect(loopEvents.filter((event) => event.type === "usage")).toHaveLength(
      1,
    );
    expect(loopEvents).toContainEqual({
      type: "usage",
      usage: expect.objectContaining({
        inputTokens: 10000,
        cachedInputTokens: 8000,
      }),
    });
    const stepHook = events.find((event) => event.type === "step:finish");
    const endHook = events.find((event) => event.type === "generation:finish");
    expect(stepHook?.type === "step:finish" && stepHook.usage).toEqual(
      persisted.step.usage,
    );
    expect(endHook?.type === "generation:finish" && endHook.totalUsage).toEqual(
      persisted.step.usage,
    );
    expect(JSON.stringify(persisted.step.providerMetadata)).not.toContain(
      "SECRET",
    );
    expect(persisted.step.providerMetadata?.synaxUsage).toMatchObject({
      version: 1,
      protocol: "openai-chat",
      adapter: "@ai-sdk/openai-compatible",
      raw: { prompt_cache_hit_tokens: 8000 },
    });
  });
  it("captures unstripped nonstream response usage and hook totals", async () => {
    const events: LlmHookEvent[] = [];
    llmHooks.register({
      id: "usage-test",
      handler: (event) => {
        events.push(event);
      },
    });
    const result = await generateText({
      model: compatible(
        { prompt_tokens: 10000, prompt_cache_hit_tokens: 8000 },
        false,
      ),
      prompt: "fixture",
      maxRetries: 0,
      ...buildHookCallbacks({ purpose: "executor", messages: [] }),
    });
    const u = normalizeUsage(result.usage, {
      providerMetadata: result.providerMetadata,
    });
    expect(u?.cachedInputTokens).toBe(8000);
    expect(
      events.find((event) => event.type === "generation:finish"),
    ).toMatchObject({ totalUsage: { cachedInputTokens: 8000 } });
  });
  it("does not confuse missing wire fields with adapter synthetic zero", async () => {
    const result = streamText({
      model: compatible({}),
      prompt: "fixture",
      maxRetries: 0,
    });
    await result.consumeStream();
    const u = normalizeUsage(await result.usage, {
      providerMetadata: await result.providerMetadata,
    });
    expect(u?.inputTokens).toBeUndefined();
    expect(u?.normalization.cacheRead).toMatchObject({
      status: "unknown",
      rawPresent: false,
    });
  });
  it("honors a standard zero from the real adapter", async () => {
    const result = streamText({
      model: compatible({
        prompt_tokens: 10000,
        prompt_tokens_details: { cached_tokens: 0 },
        prompt_cache_hit_tokens: 8000,
      }),
      prompt: "fixture",
      maxRetries: 0,
    });
    await result.consumeStream();
    expect(
      normalizeUsage(await result.usage, {
        providerMetadata: await result.providerMetadata,
      })?.cachedInputTokens,
    ).toBe(0);
  });
  it("merges Anthropic start/delta fragments before SDK synthesizes totals", async () => {
    const anthropic = createAnthropic({
      apiKey: "fixture",
      fetch: async () =>
        new Response(
          [
            {
              type: "message_start",
              message: {
                id: "msg_1",
                type: "message",
                role: "assistant",
                model: "claude-fixture",
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: {
                  input_tokens: 100,
                  output_tokens: 0,
                  cache_read_input_tokens: 8000,
                  cache_creation_input_tokens: 1000,
                },
              },
            },
            {
              type: "content_block_start",
              index: 0,
              content_block: { type: "text", text: "" },
            },
            {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: "ok" },
            },
            { type: "content_block_stop", index: 0 },
            {
              type: "message_delta",
              delta: { stop_reason: "end_turn", stop_sequence: null },
              usage: { output_tokens: 20 },
            },
            { type: "message_stop" },
          ]
            .map(
              (event) =>
                `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
            )
            .join(""),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
    });
    const result = streamText({
      model: applyUsageMiddleware(anthropic("claude-fixture"), {
        protocol: "anthropic",
      }),
      maxOutputTokens: 100,
      prompt: "fixture",
      maxRetries: 0,
    });
    await result.consumeStream();
    const u = normalizeUsage(await result.usage, {
      providerMetadata: await result.providerMetadata,
    });
    expect(u).toMatchObject({
      inputTokens: 9100,
      outputTokens: 20,
      cachedInputTokens: 8000,
      cacheWriteTokens: 1000,
    });
  });
});

const sdkUsage: LanguageModelV4Usage = {
  inputTokens: {
    total: 10000,
    noCache: 10000,
    cacheRead: 0,
    cacheWrite: undefined,
  },
  outputTokens: { total: 20, text: 20, reasoning: undefined },
};
function fakeModel(parts: () => LanguageModelV4StreamPart[]): LanguageModelV4 {
  return {
    specificationVersion: "v4",
    provider: "fixture",
    modelId: "fixture",
    supportedUrls: {},
    doGenerate: async () => ({
      content: [],
      finishReason: { unified: "stop", raw: "stop" },
      usage: sdkUsage,
      warnings: [],
    }),
    doStream: async (options) => {
      expect(options.includeRawChunks).toBe(true);
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const part of parts()) controller.enqueue(part);
            controller.close();
          },
        }),
      };
    },
  };
}
async function modelUsage(model: LanguageModelV4) {
  const result = streamText({ model, prompt: "fixture", maxRetries: 0 });
  await result.consumeStream();
  return normalizeUsage(await result.usage, {
    providerMetadata: await result.providerMetadata,
  });
}
describe("attempt-local evidence", () => {
  it("does not leak raw fields across reused model attempts or concurrent requests", async () => {
    let attempt = 0;
    const model = applyUsageMiddleware(
      fakeModel(() => {
        const index = attempt++;
        return [
          {
            type: "raw",
            rawValue: {
              usage:
                index === 0
                  ? { prompt_tokens: 10000, prompt_cache_hit_tokens: 8000 }
                  : { prompt_tokens: 10000 },
            },
          },
          {
            type: "finish",
            finishReason: { unified: "stop", raw: "stop" },
            usage: sdkUsage,
            providerMetadata: { fixture: { retained: true } },
          },
        ];
      }),
      { protocol: "openai-chat" },
    );
    const [a, b] = await Promise.all([modelUsage(model), modelUsage(model)]);
    expect(a?.cachedInputTokens).toBe(8000);
    expect(b?.cachedInputTokens).toBeUndefined();
    expect((await modelUsage(model))?.cachedInputTokens).toBeUndefined();
  });
  it("lets an invalid raw standard field block positive SDK/custom fallbacks", async () => {
    const model = applyUsageMiddleware(
      fakeModel(() => [
        {
          type: "raw",
          rawValue: {
            usage: {
              prompt_tokens: 10000,
              prompt_tokens_details: { cached_tokens: "SECRET" },
              prompt_cache_hit_tokens: 8000,
            },
          },
        },
        {
          type: "finish",
          finishReason: { unified: "stop", raw: "stop" },
          usage: sdkUsage,
        },
      ]),
    );
    expect((await modelUsage(model))?.normalization.cacheRead).toMatchObject({
      status: "unknown",
      rawPresent: true,
    });
  });
});

describe("generation aggregation and namespace composition", () => {
  it("never applies the last step raw usage to a multi-step SDK total", () => {
    const events: LlmHookEvent[] = [];
    llmHooks.register({
      id: "usage-test",
      handler: (event) => {
        events.push(event);
      },
    });
    const callbacks = buildHookCallbacks({ purpose: "executor", messages: [] });
    const steps = [
      {
        usage: {
          inputTokens: 100,
          outputTokens: 10,
          inputTokenDetails: { cacheReadTokens: 0 },
        },
        providerMetadata: {
          synaxUsage: {
            version: 1,
            raw: {
              prompt_tokens: 100,
              completion_tokens: 10,
              prompt_cache_hit_tokens: 80,
            },
          },
        },
      },
      {
        usage: {
          inputTokens: 1000,
          outputTokens: 20,
          inputTokenDetails: { cacheReadTokens: 0 },
        },
        providerMetadata: {
          synaxUsage: {
            version: 1,
            raw: {
              prompt_tokens: 1000,
              completion_tokens: 20,
              prompt_cache_hit_tokens: 100,
            },
          },
        },
      },
    ];
    callbacks.onEnd({
      steps,
      totalUsage: { inputTokens: 1100, outputTokens: 30, cachedInputTokens: 0 },
      providerMetadata: steps[1].providerMetadata,
    } as unknown as Parameters<typeof callbacks.onEnd>[0]);
    expect(events[0]).toMatchObject({
      type: "generation:finish",
      totalUsage: {
        inputTokens: 1100,
        outputTokens: 30,
        cachedInputTokens: 180,
      },
    });
    callbacks.onEnd({
      steps: [...steps, { usage: undefined }],
      totalUsage: { inputTokens: 1100, outputTokens: 30 },
    } as unknown as Parameters<typeof callbacks.onEnd>[0]);
    const last = events[1];
    expect(
      last.type === "generation:finish" && last.totalUsage?.cachedInputTokens,
    ).toBeUndefined();
  });
  it("preserves existing synax diagnostics and other provider metadata", async () => {
    const providerMetadata = {
      synax: { diagnostics: { id: "keep-me" } },
      anthropic: { signature: "keep-too" },
    };
    const model = applyUsageMiddleware(
      fakeModel(() => [
        {
          type: "raw",
          rawValue: {
            usage: { prompt_tokens: 10000, prompt_cache_hit_tokens: 8000 },
          },
        },
        {
          type: "finish",
          finishReason: { unified: "stop", raw: "stop" },
          usage: sdkUsage,
          providerMetadata,
        },
      ]),
    );
    const result = streamText({ model, prompt: "fixture", maxRetries: 0 });
    await result.consumeStream();
    expect(await result.providerMetadata).toMatchObject(providerMetadata);
    expect((await result.providerMetadata)?.synaxUsage).toMatchObject({
      version: 1,
      raw: { prompt_cache_hit_tokens: 8000 },
    });
    expect(providerMetadata).not.toHaveProperty("synaxUsage");
  });
  it("does not treat SDK-generated raw defaults as wire evidence when raw events omitted usage", async () => {
    const model = applyUsageMiddleware(
      fakeModel(() => [
        { type: "raw", rawValue: { type: "message_stop" } },
        {
          type: "finish",
          finishReason: { unified: "stop", raw: "stop" },
          usage: {
            ...sdkUsage,
            raw: { cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          },
        },
      ]),
      { protocol: "anthropic" },
    );
    expect((await modelUsage(model))?.normalization.cacheRead).toMatchObject({
      status: "unknown",
      rawPresent: false,
    });
  });
  it("keeps explicitly reported legacy totals without inventing missing input/output", () => {
    const u = normalized({ totalTokens: 100, normalization: { version: 1 } });
    expect(u.totalTokens).toBe(100);
    expect(u.inputTokens).toBeUndefined();
    expect(u.outputTokens).toBeUndefined();
  });
});

describe("Responses raw completion evidence", () => {
  it("captures nested response usage, replacing repeated cumulative fragments instead of summing", async () => {
    const rawValue = {
      type: "response.completed",
      response: {
        output: [{ text: "SECRET" }],
        usage: {
          input_tokens: 10000,
          input_tokens_details: { cached_tokens: 8000 },
          output_tokens: 20,
        },
      },
    };
    const model = applyUsageMiddleware(
      fakeModel(() => [
        { type: "raw", rawValue },
        { type: "raw", rawValue },
        {
          type: "finish",
          finishReason: { unified: "stop", raw: "stop" },
          usage: sdkUsage,
        },
      ]),
      { protocol: "openai-responses" },
    );
    const u = await modelUsage(model);
    expect(u).toMatchObject({
      inputTokens: 10000,
      outputTokens: 20,
      cachedInputTokens: 8000,
    });
    expect(JSON.stringify(u)).not.toContain("SECRET");
  });
});

describe("auxiliary result usage normalization", () => {
  const first = {
    usage: {
      inputTokens: 100,
      outputTokens: 10,
      inputTokenDetails: { cacheReadTokens: 0 },
    },
    providerMetadata: {
      synaxUsage: {
        version: 1,
        protocol: "openai-chat",
        adapter: "@ai-sdk/openai-compatible",
        raw: {
          prompt_tokens: 100,
          completion_tokens: 10,
          prompt_cache_hit_tokens: 80,
        },
      },
    },
  };
  const second = {
    usage: {
      inputTokens: 1000,
      outputTokens: 20,
      inputTokenDetails: { cacheReadTokens: 0 },
    },
    providerMetadata: {
      synaxUsage: {
        version: 1,
        raw: {
          prompt_tokens: 1000,
          completion_tokens: 20,
          prompt_cache_hit_tokens: 100,
        },
      },
    },
  };
  it("normalizes each actual step with its own metadata and aggregates once", () => {
    const u = normalizeResultUsage({
      steps: [first, second],
      usage: second.usage,
      totalUsage: { inputTokens: 1100, outputTokens: 30, cachedInputTokens: 0 },
      providerMetadata: second.providerMetadata,
    });
    expect(u).toMatchObject({
      inputTokens: 1100,
      outputTokens: 30,
      cachedInputTokens: 180,
    });
    expect(u?.normalization.cacheRead).toMatchObject({
      status: "known",
      source: "steps",
    });
  });
  it("keeps missing step components unknown instead of dropping a sample or using SDK totals", () => {
    const u = normalizeResultUsage({
      steps: [first, {}],
      totalUsage: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 80 },
    });
    expect(u?.inputTokens).toBeUndefined();
    expect(u?.cachedInputTokens).toBeUndefined();
    expect(u?.normalization.cacheRead.status).toBe("unknown");
    expect(u?.normalization.protocol).toBeUndefined();
    expect(u?.normalization.adapter).toBeUndefined();
    expect(u).not.toHaveProperty("measuredAt");
    expect(u).not.toHaveProperty("durationMs");
  });
  it("retains single-step provenance and never fills absent timing", () => {
    const u = normalizeResultUsage({ steps: [first] });
    expect(u).toEqual(
      normalizeUsage(first.usage, {
        source: "sdk",
        providerMetadata: first.providerMetadata,
      }),
    );
    expect(u?.normalization).toMatchObject({
      protocol: "openai-chat",
      adapter: "@ai-sdk/openai-compatible",
    });
    expect(u).not.toHaveProperty("measuredAt");
    expect(u).not.toHaveProperty("durationMs");
  });
  it.each([undefined, []])(
    "falls back to explicit single-result usage only when steps are absent/empty (%s)",
    (steps) => {
      const u = normalizeResultUsage({
        steps,
        ...first,
        totalUsage: { inputTokens: 99999, outputTokens: 99999 },
      });
      expect(u).toMatchObject({
        inputTokens: 100,
        outputTokens: 10,
        cachedInputTokens: 80,
      });
    },
  );
  it("never applies last-step metadata to a totals-only fallback", () => {
    const u = normalizeResultUsage({
      totalUsage: { inputTokens: 1100, outputTokens: 30, cachedInputTokens: 0 },
      providerMetadata: second.providerMetadata,
    });
    expect(u).toMatchObject({ inputTokens: 1100, outputTokens: 30 });
    expect(u?.cachedInputTokens).toBeUndefined();
    expect(u?.normalization.cacheRead.status).toBe("unknown");
    expect(u?.normalization.adapter).toBeUndefined();
    expect(u?.normalization.protocol).toBeUndefined();
  });
  it("returns absent usage rather than inventing an auxiliary measurement", () => {
    expect(normalizeResultUsage({})).toBeUndefined();
    expect(
      normalizeResultUsage({
        steps: [],
        providerMetadata: first.providerMetadata,
      }),
    ).toBeUndefined();
  });
});

describe("auxiliary protocol authority", () => {
  it.each(["openai-responses", "openai"])(
    "does not infer Anthropic from custom fields under explicit %s",
    (protocol) => {
      const raw = {
        input_tokens: 10000,
        output_tokens: 20,
        input_tokens_details: { cached_tokens: 0 },
        cache_creation_input_tokens: 2000,
      };
      const expected = {
        inputTokens: 10000,
        cachedInputTokens: 0,
        normalization: {
          inputSemantics: "total",
          cacheRead: {
            status: "known",
            source: "raw:input_tokens_details.cached_tokens",
          },
        },
      };
      expect(normalizeUsage({ raw }, { protocol })).toMatchObject(expected);
      expect(
        normalizeResultUsage({
          steps: [
            {
              usage: { inputTokens: 10000, outputTokens: 20 },
              providerMetadata: { synaxUsage: { version: 1, protocol, raw } },
            },
          ],
        }),
      ).toMatchObject(expected);
      // Even a positive Anthropic-shaped read must not override the protocol's zero.
      expect(
        normalizeUsage(
          { raw: { ...raw, cache_read_input_tokens: 500 } },
          { protocol },
        ),
      ).toMatchObject(expected);
    },
  );
  it("still infers Anthropic for Claude CLI raw usage without a protocol", () => {
    const u = normalizeUsage({
      source: "claude-code",
      raw: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 8000,
        cache_creation_input_tokens: 2000,
      },
    });
    expect(u).toMatchObject({
      inputTokens: 10100,
      cachedInputTokens: 8000,
      cacheWriteTokens: 2000,
      normalization: {
        source: "cli",
        inputSemantics: "uncached",
        cacheRead: { source: "raw:cache_read_input_tokens" },
      },
    });
    expect(u?.normalization.protocol).toBeUndefined();
  });
});

describe("protocol-specific standard-field precedence", () => {
  const mixed = {
    input_tokens: 10000,
    input_tokens_details: { cached_tokens: 0 },
    prompt_tokens: 123,
    prompt_tokens_details: { cached_tokens: 999 },
  };
  it.each([
    ["openai-responses", 10000, 0, "input_tokens"],
    ["openai", 123, 999, "prompt_tokens"],
    ["openai-chat", 123, 999, "prompt_tokens"],
  ] as const)(
    "prefers the standard fields of %s in direct and auxiliary normalization",
    (protocol, inputTokens, cachedInputTokens, field) => {
      const expected = {
        inputTokens,
        cachedInputTokens,
        normalization: {
          input: { source: `raw:${field}` },
          cacheRead: { source: `raw:${field}_details.cached_tokens` },
        },
      };
      expect(normalizeUsage({ raw: mixed }, { protocol })).toMatchObject(
        expected,
      );
      expect(
        normalizeResultUsage({
          steps: [
            {
              usage: {},
              providerMetadata: {
                synaxUsage: { version: 1, protocol, raw: mixed },
              },
            },
          ],
        }),
      ).toMatchObject(expected);
    },
  );
  it("retains the generic Chat-first fallback for legacy records without a protocol", () => {
    expect(normalizeUsage({ raw: mixed })).toMatchObject({
      inputTokens: 123,
      cachedInputTokens: 999,
    });
  });
  it("does not hide present invalid Responses fields with unrelated valid Chat fields", () => {
    const u = normalizeUsage(
      {
        raw: {
          ...mixed,
          input_tokens: null,
          input_tokens_details: { cached_tokens: null },
        },
      },
      { protocol: "openai-responses" },
    );
    expect(u?.inputTokens).toBeUndefined();
    expect(u?.cachedInputTokens).toBeUndefined();
    expect(u?.normalization.input).toMatchObject({
      status: "unknown",
      source: "raw:input_tokens",
      rawPresent: true,
    });
    expect(u?.normalization.cacheRead).toMatchObject({
      status: "unknown",
      source: "raw:input_tokens_details.cached_tokens",
      rawPresent: true,
    });
  });
});
