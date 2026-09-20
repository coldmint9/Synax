import { describe, expect, it, vi } from "vitest";
const gateway = vi.hoisted(() => ({
  createGatewayStreamForSelection: vi.fn(),
  resolveGatewaySelection: vi.fn(async () => ({
    model: "fixture/model",
    providerId: "fixture",
    modelId: "model",
    apiFormat: "anthropic",
    provider: {
      id: "fixture",
      label: "Fixture",
      env: [],
      supported: true,
      models: [],
    },
    modelDef: { id: "model", label: "Model" },
    config: { providerId: "fixture" },
  })),
}));
vi.mock("../../llm-runtime/gateway.js", () => gateway);
import type { LoopModelStreamEvent } from "../contracts.js";
import { streamLoopModelStep } from "../loop-model-stream.js";
import { buildLoopToolSet } from "../loop-ai-tools.js";

const input = {
  request: {
    purpose: "executor",
    messages: [{ role: "user" as const, content: "Inspect" }],
  },
  tools: buildLoopToolSet([]),
  mustFinalize: false,
  model: "fixture",
};
describe("provider protocol preservation", () => {
  it("retains native model file outputs and opaque media signatures in the completed step", async () => {
    const bytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
      "base64",
    );
    gateway.createGatewayStreamForSelection.mockResolvedValueOnce({
      fullStream: (async function* () {
        yield {
          type: "file",
          file: { uint8Array: bytes, mediaType: "image/png" },
          providerMetadata: {
            google: { thoughtSignature: "opaque-signature" },
          },
        };
        yield {
          type: "finish-step",
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 2 },
        };
        yield { type: "finish", finishReason: "stop" };
      })(),
    });
    const events: LoopModelStreamEvent[] = [];
    for await (const event of streamLoopModelStep({
      ...input,
      request: { ...input.request, projectId: "media-stream-test" },
    }))
      events.push(event);
    const completed = events.find((event) => event.type === "step_complete");
    expect(
      completed?.type === "step_complete" && completed.step.contentParts,
    ).toEqual([
      {
        type: "image",
        assetId: expect.stringMatching(/^asset_/),
        providerOptions: { google: { thoughtSignature: "opaque-signature" } },
      },
    ]);
  });
  it("falls back to the local webSearch function when a Responses endpoint rejects native web_search", async () => {
    gateway.resolveGatewaySelection.mockResolvedValueOnce({
      model: "fixture/native-web-search-fallback",
      providerId: "fixture",
      modelId: "native-web-search-fallback",
      apiFormat: "openai-responses",
      provider: {
        id: "fixture",
        label: "Fixture",
        npm: "@ai-sdk/openai",
        api: "https://fixture.example/v1",
        env: [],
        supported: true,
        models: [],
      },
      modelDef: { id: "native-web-search-fallback", label: "Model" },
      config: {
        providerId: "fixture",
        baseUrl: "https://fixture.example/v1",
      },
    } as never);
    gateway.createGatewayStreamForSelection
      .mockResolvedValueOnce({
        fullStream: (async function* () {
          yield {
            type: "error",
            error: new Error("Unsupported tool type: web_search"),
          };
        })(),
      })
      .mockResolvedValueOnce({
        fullStream: (async function* () {
          yield {
            type: "tool-call",
            toolCallId: "local-search",
            toolName: "webSearch",
            input: { query: "Synax" },
          };
          yield { type: "finish-step", finishReason: "tool-calls", usage: {} };
          yield { type: "finish", finishReason: "tool-calls", totalUsage: {} };
        })(),
      });

    const webTools = buildLoopToolSet([
      {
        id: "webSearch",
        label: "Web Search",
        description: "Search",
        category: "read",
        mutability: "read",
        resumeBehavior: "auto",
      },
    ]);
    const events: LoopModelStreamEvent[] = [];
    for await (const event of streamLoopModelStep({
      ...input,
      tools: webTools,
    }))
      events.push(event);

    const firstTools =
      gateway.createGatewayStreamForSelection.mock.calls.at(-2)?.[0].tools;
    const secondTools =
      gateway.createGatewayStreamForSelection.mock.calls.at(-1)?.[0].tools;
    expect(firstTools.webSearch).toMatchObject({ id: "openai.web_search" });
    expect(secondTools.webSearch).toMatchObject({
      metadata: { runtimeToolId: "webSearch" },
    });
    expect(secondTools.webSearch.id).toBeUndefined();
    const final = events.find((event) => event.type === "step_complete");
    expect(final?.type === "step_complete" && final.step.toolCalls).toEqual([
      {
        id: "local-search",
        toolId: "webSearch",
        args: { query: "Synax" },
      },
    ]);
  });

  it("preserves reasoning signatures, tool signatures and usage separately from visible output", async () => {
    gateway.createGatewayStreamForSelection.mockResolvedValue({
      fullStream: (async function* () {
        yield { type: "reasoning-start", id: "r" };
        yield { type: "reasoning-delta", id: "r", text: "reasoning" };
        yield {
          type: "reasoning-end",
          id: "r",
          providerMetadata: { anthropic: { signature: "signed-thinking" } },
        };
        yield {
          type: "tool-call",
          toolCallId: "call1",
          toolName: "file_read",
          input: { path: "a.ts" },
          providerMetadata: { google: { thoughtSignature: "signed-tool" } },
        };
        yield {
          type: "finish-step",
          finishReason: "tool-calls",
          usage: { inputTokens: 42, outputTokens: 9 },
        };
        yield { type: "finish", finishReason: "tool-calls" };
      })(),
    });
    const events = [];
    for await (const event of streamLoopModelStep(input)) events.push(event);
    const final = events.find((e) => e.type === "step_complete");
    expect(
      final?.type === "step_complete" && final.step.reasoningParts,
    ).toEqual([
      {
        text: "reasoning",
        providerMetadata: { anthropic: { signature: "signed-thinking" } },
      },
    ]);
    expect(
      final?.type === "step_complete" &&
        final.step.toolCallProviderMetadata?.call1,
    ).toEqual({ google: { thoughtSignature: "signed-tool" } });
    expect(
      events.some((e) => e.type === "usage" && e.usage.inputTokens === 42),
    ).toBe(true);
  });
  it("emits known usage before a later transport error rather than silently dropping it", async () => {
    gateway.createGatewayStreamForSelection.mockResolvedValue({
      fullStream: (async function* () {
        yield {
          type: "finish-step",
          finishReason: "stop",
          usage: { inputTokens: 100, outputTokens: 20 },
        };
        throw new Error("transport disconnected");
      })(),
    });
    const seen: LoopModelStreamEvent[] = [];
    await expect(
      (async () => {
        for await (const e of streamLoopModelStep(input)) seen.push(e);
      })(),
    ).rejects.toThrow("transport disconnected");
    expect(seen).toContainEqual({
      type: "usage",
      usage: expect.objectContaining({
        inputTokens: 100,
        outputTokens: 20,
        normalization: expect.objectContaining({ version: 1, source: "sdk" }),
      }),
    });
  });
});
