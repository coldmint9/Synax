import { describe, expect, it } from "vitest";
import type {
  GlobalConfig,
  ProviderDef,
} from "../../../../shared/contracts/config";
import {
  buildAgentModelOptions,
  formatModelReference,
  pickDefaultModelSelection,
} from "../modelSelection";

const baseGlobalConfig: GlobalConfig = {
  version: 1,
  providers: [],
  defaultProviderId: "cursor-acp",
  defaultApiProviderId: "openai",
  enabledAcpProviderIds: ["cursor-acp"],
  providerConnections: {},
  limits: { maxAgentsPerProject: 1, agentTimeoutMs: 1 },
  features: { allowProjectConnectionOverride: true },
  updatedAt: "2026-01-01T00:00:00.000Z",
  updatedBy: "test",
};

const cursorProvider: ProviderDef = {
  id: "cursor-acp",
  label: "Cursor ACP",
  status: "live",
  kind: "acp",
  caps: { canFollowUp: true, canCancel: true },
  models: [{ id: "cursor-default", label: "Cursor Default", isDefault: true }],
};

describe("buildAgentModelOptions", () => {
  it("prefers a chat model over an implicit media-only default", () => {
    const options = [
      { kind: "api" as const, providerId: "studio", modelId: "image", label: "Image", capability: "image_generation" as const },
      { kind: "api" as const, providerId: "studio", modelId: "chat", label: "Chat", capability: "chat" as const },
    ];
    expect(pickDefaultModelSelection(options, {providerId:"studio",modelId:"image"})).toEqual(options[1]);
    expect(pickDefaultModelSelection([options[0]])).toEqual(options[0]);
  });
  it("ignores persisted ACP definitions instead of offering a removed runtime", () => {
    expect(buildAgentModelOptions(baseGlobalConfig, [cursorProvider])).toEqual({ apiModels: [] });
    expect(buildAgentModelOptions(null, [cursorProvider])).toEqual({ apiModels: [] });
  });
  it("keeps provider-qualified API references without duplicating their prefix", () => {
    expect(formatModelReference("openai", "fixture")).toBe("openai/fixture");
    expect(formatModelReference("custom-api:gateway", "custom-api:gateway/model")).toBe("custom-api:gateway/model");
    expect(formatModelReference(null, "model")).toBe("model");
    expect(formatModelReference("openai", null)).toBeUndefined();
  });
  it("exposes configured image and video models as capability-aware options", () => {
    const provider: ProviderDef = {
      id: "custom-api:media",
      label: "Media Provider",
      status: "live",
      kind: "api",
      caps: { canFollowUp: true, canCancel: true },
      models: [
        {
          id: "multi-model",
          label: "Multi Model",
          capabilities: ["chat", "image_generation", "video_generation"],
          media: {
            operations: ["text-to-image", "image-to-image", "text-to-video", "image-to-video"],
          },
        },
      ],
    };
    const options = buildAgentModelOptions(
      { ...baseGlobalConfig, providerConnections: { "custom-api:media": { providerId: "custom-api:media", apiKeyMasked: "***" } } },
      [provider],
    ).apiModels;
    expect(options.map((option) => option.capability)).toEqual([
      "chat",
      "image_generation",
      "video_generation",
    ]);
  });
});
