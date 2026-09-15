import { describe, expect, it } from "vitest";
import { getStrategy } from "../providers/provider-strategy.js";

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

describe("provider prompt caching capability", () => {
  it.each([undefined, "auto", "on"])(
    "supports native Messages on any custom host with %s",
    (mode) => {
      const selection = cacheSelection("@ai-sdk/anthropic", "anthropic", mode);
      expect(
        getStrategy(selection.provider.npm).supportsCacheControl(selection),
      ).toBe(true);
    },
  );

  it("respects off even for the built-in Anthropic connection", () => {
    const selection = cacheSelection("@ai-sdk/anthropic", "anthropic", "off");
    selection.providerId = "anthropic";
    expect(
      getStrategy(selection.provider.npm).supportsCacheControl(selection),
    ).toBe(false);
  });

  it.each([
    "@ai-sdk/openai",
    "@ai-sdk/openai-compatible",
    "@ai-sdk/google",
    undefined,
  ])("cannot force unsupported adapter %s on", (npm) => {
    const selection = cacheSelection(npm ?? "", "anthropic", "on");
    selection.providerId = "anthropic";
    selection.config.baseUrl = "https://anthropic.com";
    expect(getStrategy(npm).supportsCacheControl(selection)).toBe(false);
  });

  it.each(["openai", "openai-responses"] as const)(
    "does not enable Anthropic fields on %s",
    (apiFormat) => {
      const selection = cacheSelection("@ai-sdk/anthropic", apiFormat, "on");
      expect(
        getStrategy(selection.provider.npm).supportsCacheControl(selection),
      ).toBe(false);
    },
  );

  it.each([null, true, "yes", 1, {}])(
    "strictly rejects invalid policy %j for every adapter",
    (value) => {
      for (const npm of ["@ai-sdk/anthropic", "@ai-sdk/openai", "unknown"]) {
        const selection = cacheSelection(npm, "anthropic", value);
        expect(() => getStrategy(npm).supportsCacheControl(selection)).toThrow(
          "options.promptCaching",
        );
      }
    },
  );
});
