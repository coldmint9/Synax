import { describe, expect, it, vi } from "vitest";
import { serveProviderHttp } from "../../../../test-fixtures/provider-http.js";
import { generateProviderImages, type MediaProviderSelection } from "../media-generation.js";
import { imageGenerationOptionsSchema } from "../image-generation.js";
const png = Buffer.from("fixture-image");
const selection: MediaProviderSelection = {
  provider: { id: "fixture", label: "Fixture", npm: "@ai-sdk/openai", env: [], supported: true, models: [] },
  config: { providerId: "fixture", apiKey: "fixture" },
};
describe("native media adapters", () => {
  it("retries upstream 503 in Rust before returning the generated image", async () => {
    const receive = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: { message: "unavailable" } }, { status: 503 }))
      .mockImplementation(async () => Response.json({ data: [{ b64_json: png.toString("base64") }] }));
    const baseUrl = await serveProviderHttp(receive);
    const result = await generateProviderImages({ ...selection, config: { ...selection.config, baseUrl } },
      imageGenerationOptionsSchema.parse({ model: "fixture", prompt: "Draw", stream: false }));
    expect(result.images[0].bytes).toEqual(png);
    expect(receive).toHaveBeenCalledTimes(2);
  }, 10_000);
  it("sends custom models, references and provider options through the Rust image adapter", async () => {
    const receive = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ data: [{ b64_json: png.toString("base64") }], usage: { total_tokens: 3 } }));
    const baseUrl = await serveProviderHttp(receive);
    const result = await generateProviderImages({ ...selection, config: { ...selection.config, baseUrl } },
      imageGenerationOptionsSchema.parse({ model: "future-image", prompt: "Edit", stream: false, api: "native", providerOptions: { openai: { custom_control: true } } }),
      { images: [{ bytes: png, mediaType: "image/png", filename: "input.png" }] });
    expect(result.images[0].bytes).toEqual(png);
    const form = receive.mock.calls[0][1].body as FormData;
    expect(form.get("model")).toBe("future-image");
    expect(form.get("custom_control")).toBe("true");
    expect(Buffer.from(await (form.get("image[]") as File).arrayBuffer())).toEqual(png);
  });
  it("rejects unsupported native media providers before making an upstream request", async () => {
    const receive = vi.fn(async () => Response.json({}));
    const baseUrl = await serveProviderHttp(receive);
    await expect(generateProviderImages({ ...selection, provider: { ...selection.provider, npm: "@ai-sdk/google" }, config: { ...selection.config, baseUrl } },
      imageGenerationOptionsSchema.parse({ model: "future", prompt: "Draw" }))).rejects.toThrow("no native images adapter");
    expect(receive).not.toHaveBeenCalled();
  });
  it("does not silently discard streaming controls on a non-streaming image adapter", async () => {
    const receive = vi.fn(async () => Response.json({}));
    const baseUrl = await serveProviderHttp(receive);
    await expect(generateProviderImages({ ...selection, config: { ...selection.config, baseUrl } }, imageGenerationOptionsSchema.parse({ model: "future", prompt: "Draw", api: "native", stream: true })))
      .rejects.toThrow("does not expose partial-image streaming");
    expect(receive).not.toHaveBeenCalled();
  });
});
