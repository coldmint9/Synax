import { describe, expect, it } from "vitest";
import { inferReasoningCapability, mapThinkingModeToReasoningEffort, resolvePreferredProviderAdapter } from "../thinking-mode-strategy.js";
describe("host thinking preference and catalog metadata", () => {
  it("maps UI preferences to neutral reasoning efforts", () => {
    expect(mapThinkingModeToReasoningEffort("deep")).toBe("max");
    expect(mapThinkingModeToReasoningEffort("standard")).toBe("high");
  });
  it("retains catalog capability hints without creating provider clients", () => {
    expect(inferReasoningCapability({ providerId: "custom", baseUrl: "https://api.deepseek.com" })).toBe(true);
    expect(inferReasoningCapability({ providerId: "custom", reasoning: false })).toBe(false);
    expect(resolvePreferredProviderAdapter({ providerId: "custom", baseUrl: "https://api.deepseek.com" })?.npm).toBe("@ai-sdk/deepseek");
    expect(resolvePreferredProviderAdapter({ providerId: "custom", baseUrl: "https://proxy.example.com/deepseek" })).toBeUndefined();
  });
});
