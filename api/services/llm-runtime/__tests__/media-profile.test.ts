import { describe, expect, it } from "vitest";
import {
  ADAPTER_MEDIA_PROFILES,
  ENDPOINT_MEDIA_PROFILES,
  resolveMediaProfile,
} from "../providers/media-profile.js";
import { registeredAdapterPackages } from "../providers/provider-registry.js";

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

describe("media profile coverage", () => {
  it("declares media for every adapter the runtime can instantiate", () => {
    // A new adapter without a media declaration used to discard every declared
    // modality at runtime; this guard turns that into a test failure.
    const missing = registeredAdapterPackages().filter(
      (npm) => !(npm in ADAPTER_MEDIA_PROFILES),
    );
    expect(missing).toEqual([]);
  });

  it("keeps no stale or empty adapter entries", () => {
    const registered = new Set(registeredAdapterPackages());
    for (const [npm, profile] of Object.entries(ADAPTER_MEDIA_PROFILES)) {
      expect(registered.has(npm), `${npm} is not a registered adapter`).toBe(
        true,
      );
      expect(
        Boolean(profile.carriers?.length) || profile.unverified === true,
        `${npm} needs carriers or an explicit unverified marker`,
      ).toBe(true);
    }
  });

  it("documents every endpoint profile", () => {
    for (const endpoint of ENDPOINT_MEDIA_PROFILES) {
      expect(endpoint.doc).toMatch(/^https:\/\//);
      expect(endpoint.restrict.carriers.length).toBeGreaterThan(0);
    }
  });
});

describe("media profile resolution", () => {
  it("narrows DeepSeek Responses input to images at the documented limits", () => {
    const profile = resolveMediaProfile({
      npm: "@ai-sdk/open-responses",
      apiFormat: "openai-responses",
      providerId: "custom-api:deepseek",
      modelId: "deepseek-flash",
      baseUrl: "https://api.deepseek.com",
    });

    expect(profile.endpointIds).toEqual(["deepseek"]);
    // The adapter can carry documents, the endpoint cannot: images survive.
    expect(profile.carriers).toEqual(["text", "image"]);
    expect(profile.mediaTypes).toEqual(IMAGE_TYPES);
    expect(profile.limits).toEqual({
      maxFileBytes: 32 * 1024 * 1024,
      maxTotalBytes: 48 * 1024 * 1024,
      // The adapter caps a request at 500 attachments, the endpoint allows 600.
      maxFiles: 500,
    });
  });

  it("narrows a non-DeepSeek Responses connection only by its adapter", () => {
    const profile = resolveMediaProfile({
      npm: "@ai-sdk/open-responses",
      apiFormat: "openai-responses",
      providerId: "custom-api:gateway",
      modelId: "gpt-5-codex",
      baseUrl: "https://gateway.example/v1",
    });

    expect(profile.endpointIds).toEqual([]);
    expect(profile.carriers).toContain("file");
    expect(profile.mediaTypes).toContain("application/pdf");
  });

  it("applies the DeepSeek endpoint limits to the Chat protocol too", () => {
    const profile = resolveMediaProfile({
      npm: "@ai-sdk/deepseek",
      apiFormat: "openai",
      providerId: "custom-api:deepseek",
      modelId: "deepseek-chat",
      baseUrl: "https://api.deepseek.com",
    });

    expect(profile.endpointIds).toEqual(["deepseek"]);
    expect(profile.limits.maxFileBytes).toBe(32 * 1024 * 1024);
    expect(profile.limits.maxTotalBytes).toBe(48 * 1024 * 1024);
  });

  it("reports unverified adapters without a carrier list", () => {
    const profile = resolveMediaProfile({ npm: "@ai-sdk/cerebras" });

    expect(profile.carriers).toBeUndefined();
    expect(profile.endpointIds).toEqual([]);
  });
});
