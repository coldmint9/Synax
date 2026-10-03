import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateProviderImages } from "../media-generation.js";
import { imageGenerationOptionsSchema } from "../image-generation.js";
import type { MediaProviderSelection } from "../media-generation.js";

const fixture = vi.hoisted(() => ({
  calls: [] as any[],
  models: [] as string[],
  supportsImage: true,
}));
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
  "base64",
);
vi.mock("../providers/provider-registry.js", () => ({
  instantiateProvider: async () =>
    fixture.supportsImage
      ? {
          imageModel: (modelId: string) => {
            fixture.models.push(modelId);
            return {
              specificationVersion: "v4",
              provider: "fixture.image",
              modelId,
              maxImagesPerCall: 10,
              doGenerate: async (args: unknown) => {
                fixture.calls.push(args);
                return {
                  images: [png],
                  warnings: [],
                  usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
                  response: { timestamp: new Date(), modelId },
                };
              },
            };
          },
        }
      : {},
}));
const selection: MediaProviderSelection = {
  provider: {
    id: "vendor",
    label: "Vendor",
    npm: "@ai-sdk/google",
    env: [],
    supported: true,
    models: [],
  },
  config: { providerId: "vendor", apiKey: "fixture" },
};
beforeEach(() => {
  fixture.calls = [];
  fixture.models = [];
  fixture.supportsImage = true;
});
describe("model-independent media adapters", () => {
  it("uses the provider image factory for unknown models and preserves reference bytes and custom options", async () => {
    const options = imageGenerationOptionsSchema.parse({
      model: "vendor-future-image-v9",
      prompt: "Edit",
      size: "512x512",
      aspectRatio: "1:1",
      seed: 4,
      providerOptions: { google: { customControl: true } },
      stream: false,
    });
    const result = await generateProviderImages(selection, options, {
      images: [{ bytes: png, mediaType: "image/png", filename: "input.png" }],
    });
    expect(fixture.models).toEqual(["vendor-future-image-v9"]);
    expect(fixture.calls[0]).toMatchObject({
      prompt: "Edit",
      size: "512x512",
      seed: 4,
      providerOptions: { google: { customControl: true } },
      files: [{ type: "file", data: png }],
    });
    expect(result.images[0]).toMatchObject({
      mediaType: "image/png",
      bytes: png,
    });
    expect(result.usage?.totalTokens).toBe(3);
  });
  it("fails explicitly for unsupported operations instead of using a chat model", async () => {
    fixture.supportsImage = false;
    await expect(
      generateProviderImages(
        selection,
        imageGenerationOptionsSchema.parse({ model: "future", prompt: "Draw" }),
      ),
    ).rejects.toThrow("no image generation adapter");
    expect(fixture.models).toHaveLength(0);
  });
  it("does not silently drop requested SDK streaming", async () => {
    await expect(
      generateProviderImages(
        selection,
        imageGenerationOptionsSchema.parse({
          model: "future",
          prompt: "Draw",
          stream: true,
        }),
      ),
    ).rejects.toThrow("does not expose partial-image streaming");
  });
});
