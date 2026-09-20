import { describe, expect, it } from "vitest";
import { buildLoopToolSet } from "../../agent-runtime/loop-ai-tools.js";
import {
  isNativeWebSearchUnsupportedError,
  markNativeWebSearchUnsupported,
  routeNativeWebSearchTools,
} from "../native-web-search.js";
import type { ResolvedModelSelection } from "../types.js";
import type { WebSearchConfig } from "../../../lib/config/config-types.js";

const config: WebSearchConfig = {
  routing: "auto",
  remote: { externalWebAccess: true, searchContextSize: "high" },
  local: { engine: "duckduckgo", auth: { type: "none" } },
};

function selection(modelId = "native-search-test"): ResolvedModelSelection {
  return {
    model: `openai/${modelId}`,
    providerId: "openai",
    modelId,
    apiFormat: "openai-responses",
    provider: {
      id: "openai",
      label: "OpenAI",
      npm: "@ai-sdk/openai",
      api: "https://api.openai.com/v1",
      env: [],
      supported: true,
      models: [],
    },
    modelDef: { id: modelId, label: modelId },
    config: { providerId: "openai", baseUrl: "https://api.openai.com/v1" },
  };
}

function tools() {
  return buildLoopToolSet([
    {
      id: "webSearch",
      label: "Web Search",
      description: "Search",
      category: "read",
      mutability: "read",
      resumeBehavior: "auto",
    },
  ]);
}

describe("native Responses web search routing", () => {
  it("replaces the local function with the provider-executed Responses tool", () => {
    const result = routeNativeWebSearchTools(
      tools(),
      selection(),
      false,
      config,
    );
    const modelName = result.tools.resolveModelToolName("webSearch")!;
    expect(result.native).toBe(true);
    expect(result.tools.tools[modelName]).toMatchObject({
      type: "provider",
      isProviderExecuted: true,
      id: "openai.web_search",
      args: { externalWebAccess: true, searchContextSize: "high" },
    });
  });

  it("uses the local tool for non-Responses protocols and remembered unsupported endpoints", () => {
    const chat = { ...selection("chat"), apiFormat: "openai" as const };
    expect(routeNativeWebSearchTools(tools(), chat, false, config).native).toBe(
      false,
    );

    const unsupported = selection("unsupported-search");
    const first = routeNativeWebSearchTools(
      tools(),
      unsupported,
      false,
      config,
    );
    markNativeWebSearchUnsupported(first.capabilityKey);
    expect(
      routeNativeWebSearchTools(tools(), unsupported, false, config).native,
    ).toBe(false);
  });

  it("recognizes only explicit native web-search capability failures", () => {
    expect(
      isNativeWebSearchUnsupportedError(
        new Error("Unsupported tool type: web_search"),
      ),
    ).toBe(true);
    expect(isNativeWebSearchUnsupportedError(new Error("rate limit"))).toBe(
      false,
    );
  });
});
