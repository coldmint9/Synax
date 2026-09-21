import { describe, expect, it } from "vitest";
import { formatModelDisplayName } from "../useProviderNames";
import type { ProviderDef } from "../../../../lib/contracts/config";

const providers = [
  {
    id: "custom-api:1789630765113",
    label: "智谱",
    status: "live",
    kind: "api",
    caps: { canFollowUp: true, canCancel: true },
    models: [],
  },
  {
    id: "claude-acp",
    label: "Claude Code",
    status: "live",
    kind: "acp",
    caps: { canFollowUp: true, canCancel: true },
    models: [],
  },
] as unknown as ProviderDef[];

describe("formatModelDisplayName", () => {
  it("replaces the internal provider id prefix with the provider name", () => {
    expect(
      formatModelDisplayName("custom-api:1789630765113/glm-5.3", providers),
    ).toBe("智谱/glm-5.3");
    expect(formatModelDisplayName("claude-acp/claude-sonnet-4", providers)).toBe(
      "Claude Code/claude-sonnet-4",
    );
  });

  it("keeps the raw reference when the provider is unknown", () => {
    expect(formatModelDisplayName("custom-api:gone/glm-5.3", providers)).toBe(
      "custom-api:gone/glm-5.3",
    );
  });

  it("passes through models without a provider prefix", () => {
    expect(formatModelDisplayName("glm-5.3", providers)).toBe("glm-5.3");
    expect(formatModelDisplayName(null, providers)).toBeNull();
  });
});
