import { describe, expect, it } from "vitest";
import { getStrategy } from "../providers/provider-strategy.js";
import { applyPromptCachePolicy, resolvePromptCaching } from "../cache-policy.js";
import { chatCacheOptions } from "../chat-cache.js";
import type { LlmGatewayMessage, LlmGatewayRequest } from "../types.js";

describe("getStrategy object mode", () => {
  it("enables structuredOutputs for openai-compatible providers (custom-api)", () => {
    const strategy = getStrategy("@ai-sdk/openai-compatible");
    expect(strategy.modelOptions({ kind: "object" })).toEqual({
      structuredOutputs: true,
    });
    expect(strategy.modelOptions({ kind: "text" })).toBeUndefined();
  });

  it("enables structuredOutputs for native openai and deepseek", () => {
    expect(
      getStrategy("@ai-sdk/openai").modelOptions({ kind: "object" }),
    ).toEqual({ structuredOutputs: true });
    expect(
      getStrategy("@ai-sdk/deepseek").modelOptions({ kind: "object" }),
    ).toEqual({ structuredOutputs: true });
  });

  it("does not set structuredOutputs for anthropic text/object (native API)", () => {
    expect(
      getStrategy("@ai-sdk/anthropic").modelOptions({ kind: "object" }),
    ).toBeUndefined();
  });
});

import type { ResolvedModelSelection } from "../types.js";

function cacheSelection(
  npm: string,
  apiFormat: ResolvedModelSelection["apiFormat"],
  promptCaching?: unknown,
): ResolvedModelSelection {
  return {
    model: "private/model",
    providerId: "private",
    modelId: "model",
    apiFormat,
    provider: {
      id: "private",
      label: "Private",
      npm,
      api: "https://not-anthropic.invalid",
      env: [],
      supported: true,
      models: [],
    },
    modelDef: { id: "model", label: "Model" },
    config: { providerId: "private", options: { promptCaching } },
  };
}

function cacheRequest(): LlmGatewayRequest {
  return {
    cacheControl: true,
    hookContext: { sessionId: "session" },
  } as unknown as LlmGatewayRequest;
}

const stablePrefix = (): LlmGatewayMessage[] => [
  { role: "system", content: "stable" },
];

// Caching is no longer gated by a per-adapter boolean. These assertions go
// through the real gates — the Anthropic marker policy and the Chat capability
// matrix — so the reported capability and the wire behavior cannot drift.
describe("provider prompt caching capability", () => {
  it.each([undefined, "auto", "on"])(
    "supports native Messages on any custom host with %s",
    (mode) => {
      const selection = cacheSelection("@ai-sdk/anthropic", "anthropic", mode);
      const { messages } = applyPromptCachePolicy(stablePrefix(), {
        selection,
      });
      expect(messages[0].providerOptions?.anthropic?.cacheControl).toEqual({
        type: "ephemeral",
      });
    },
  );

  it("respects off even for the built-in Anthropic connection", () => {
    const selection = cacheSelection("@ai-sdk/anthropic", "anthropic", "off");
    selection.providerId = "anthropic";
    const { messages } = applyPromptCachePolicy(stablePrefix(), { selection });
    expect(messages[0].providerOptions?.anthropic?.cacheControl).toBeUndefined();
  });

  it.each(["@ai-sdk/google", "@ai-sdk/xai", "", "unknown"])(
    "never invents a Chat cache key for unsupported adapter %s",
    (npm) => {
      const selection = cacheSelection(npm, "openai", "on");
      selection.providerId = "anthropic";
      selection.config.baseUrl = "https://anthropic.com";
      expect(chatCacheOptions(selection, cacheRequest())).toBeUndefined();
    },
  );

  it("sends the Chat cache key for compatible adapters without an opt-in", () => {
    const selection = cacheSelection(
      "@ai-sdk/openai-compatible",
      "openai",
      "auto",
    );
    expect(chatCacheOptions(selection, cacheRequest())).toEqual({
      private: { prompt_cache_key: expect.stringMatching(/^synax:chat:v1:/) },
    });
  });

  it.each(["openai", "openai-responses"] as const)(
    "does not enable Anthropic fields on %s",
    (apiFormat) => {
      const selection = cacheSelection("@ai-sdk/anthropic", apiFormat, "on");
      const { messages } = applyPromptCachePolicy(stablePrefix(), {
        selection,
      });
      expect(messages[0].providerOptions?.anthropic).toBeUndefined();
    },
  );

  it.each([null, true, "yes", 1, {}])(
    "strictly rejects invalid policy %j for every adapter",
    (value) => {
      expect(() => resolvePromptCaching(value)).toThrow("options.promptCaching");
      for (const npm of ["@ai-sdk/anthropic", "@ai-sdk/openai", "unknown"]) {
        const selection = cacheSelection(npm, "anthropic", value);
        expect(() =>
          applyPromptCachePolicy(stablePrefix(), { selection }),
        ).toThrow("options.promptCaching");
      }
    },
  );
});
