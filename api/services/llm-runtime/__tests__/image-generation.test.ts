import { afterEach, describe, expect, it, vi } from "vitest";
import {
  generateOpenAIImages,
  imageGenerationOptionsSchema as schema,
} from "../image-generation.js";
import { GPT_IMAGE_MODELS } from "../openai-models.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
  "base64",
);
const provider = {
  provider: { id: "gateway", env: [] },
  config: {
    providerId: "gateway",
    baseUrl: "http://localhost:9876/v1",
    apiKey: "fixture-key",
    options: { headers: { "X-Custom": "fixture" } },
  },
};
const file = { bytes: png, filename: "reference.png", mediaType: "image/png" };
const usage = {
  input_tokens: 3,
  output_tokens: 5,
  total_tokens: 8,
  input_tokens_details: { image_tokens: 2, text_tokens: 1 },
};
function json(n = 1) {
  return Response.json({
    data: Array.from({ length: n }, () => ({
      b64_json: png.toString("base64"),
    })),
    usage,
  });
}
function sse(events: unknown[]) {
  const text = events
    .map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`)
    .join("");
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream({
      start(controller) {
        // Include split UTF-8/JSON/SSE frame boundaries.
        for (let i = 0; i < bytes.length; i += 13)
          controller.enqueue(bytes.slice(i, i + 13));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}
afterEach(() => vi.unstubAllGlobals());

describe("GPT Image 2.5 wire contract", () => {
  it.each([false, true])(
    "routes hosted image generation through Responses (stream=%s)",
    async (stream) => {
      const item = {
        type: "image_generation_call",
        id: "ig_1",
        status: "completed",
        result: png.toString("base64"),
      };
      const response = {
        id: "resp_1",
        created_at: 1,
        model: "gpt-5.6-sol",
        status: "completed",
        output: [item],
        usage: { input_tokens: 3, output_tokens: 5, total_tokens: 8 },
      };
      const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) =>
        stream
          ? sse([
              {
                type: "response.created",
                response: { ...response, output: [] },
              },
              {
                type: "response.output_item.added",
                output_index: 0,
                item: { ...item, status: "in_progress", result: null },
              },
              {
                type: "response.image_generation_call.partial_image",
                item_id: "ig_1",
                output_index: 0,
                partial_image_index: 0,
                partial_image_b64: png.toString("base64"),
              },
              { type: "response.output_item.done", output_index: 0, item },
              { type: "response.completed", response },
            ])
          : Response.json(response),
      );
      vi.stubGlobal("fetch", fetcher);
      const onPartial = vi.fn(async (_image: unknown) => {});
      const result = await generateOpenAIImages(
        { ...provider, modelId: "gpt-5.6-sol" },
        schema.parse({
          api: "responses",
          model: "gpt-image-2.5-flare",
          prompt: "Edit this image",
          quality: "xhigh",
          stream,
        }),
        { images: [file], mask: file, onPartial },
      );
      const [url, request] = fetcher.mock.calls[0];
      expect(String(url)).toContain("/responses");
      const body = JSON.parse(String(request?.body));
      expect(body.model).toBe("gpt-5.6-sol");
      expect(body.tools[0]).toMatchObject({
        type: "image_generation",
        model: "gpt-image-2.5-flare",
        action: "edit",
        quality: "xhigh",
        input_image_mask: {
          image_url: `data:image/png;base64,${png.toString("base64")}`,
        },
      });
      expect(
        body.input[0].content.some((part: any) => part.type === "input_image"),
      ).toBe(true);
      expect(result.images[0].bytes).toEqual(png);
      expect(onPartial).toHaveBeenCalledTimes(stream ? 1 : 0);
    },
  );
  it.each(GPT_IMAGE_MODELS)(
    "generates with the exact model %s and retains image usage",
    async (model) => {
      const fetcher = vi.fn(async () => json(2));
      vi.stubGlobal("fetch", fetcher);
      const result = await generateOpenAIImages(
        provider,
        schema.parse({
          model,
          prompt: "Draw a fox",
          n: 2,
          stream: false,
          size: "1536x864",
          quality: "max",
          background: "transparent",
          outputFormat: "webp",
          outputCompression: 80,
          moderation: "low",
        }),
      );
      const [url, request] = fetcher.mock.calls[0] as unknown as [
        string,
        RequestInit,
      ];
      expect(url).toBe("http://localhost:9876/v1/images/generations");
      expect(JSON.parse(request.body as string)).toEqual({
        model,
        prompt: "Draw a fox",
        n: 2,
        stream: false,
        size: "1536x864",
        quality: "max",
        background: "transparent",
        output_format: "webp",
        output_compression: 80,
        moderation: "low",
      });
      expect(new Headers(request.headers).get("Authorization")).toBe(
        "Bearer fixture-key",
      );
      expect(new Headers(request.headers).get("X-Custom")).toBe("fixture");
      expect(result.images).toHaveLength(2);
      expect(result.images[0].bytes).toEqual(png);
      expect(result.usage).toEqual(usage);
    },
  );
  it.each(GPT_IMAGE_MODELS)(
    "edits with %s, multiple original files and a mask",
    async (model) => {
      const fetcher = vi.fn(async () => json());
      vi.stubGlobal("fetch", fetcher);
      await generateOpenAIImages(
        provider,
        schema.parse({
          model,
          prompt: "Edit only the masked region",
          stream: false,
          quality: "xhigh",
          inputFidelity: "high",
          moderation: "auto",
        }),
        { images: [file, { ...file, filename: "second.png" }], mask: file },
      );
      const [url, request] = fetcher.mock.calls[0] as unknown as [
        string,
        RequestInit,
      ];
      expect(url).toBe("http://localhost:9876/v1/images/edits");
      const form = await new Request(url, request).formData();
      expect(form.get("model")).toBe(model);
      expect(form.get("input_fidelity")).toBe("high");
      expect(form.get("quality")).toBe("xhigh");
      expect(form.get("moderation")).toBe("auto");
      expect(form.getAll("image[]")).toHaveLength(2);
      expect(
        Buffer.from(await (form.get("mask") as File).arrayBuffer()),
      ).toEqual(png);
      expect(
        Buffer.from(await (form.getAll("image[]")[1] as File).arrayBuffer()),
      ).toEqual(png);
    },
  );
  it.each(["image_generation", "image_edit"])(
    "delivers partial %s images and requires a final image",
    async (prefix) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          sse([
            {
              type: `${prefix}.partial_image`,
              b64_json: png.toString("base64"),
            },
            {
              type: `${prefix}.completed`,
              b64_json: png.toString("base64"),
              usage,
            },
          ]),
        ),
      );
      const onPartial = vi.fn(async (_image: unknown) => {});
      const result = await generateOpenAIImages(
        provider,
        schema.parse({ prompt: "Draw a fox", partialImages: 3 }),
        { onPartial, ...(prefix === "image_edit" ? { images: [file] } : {}) },
      );
      expect(onPartial).toHaveBeenCalledOnce();
      expect(onPartial.mock.calls[0][0]).toMatchObject({
        bytes: png,
        mediaType: "image/png",
      });
      expect(result.images).toHaveLength(1);
      expect(result.usage).toEqual(usage);
    },
  );
  it("rejects a disconnected stream after a preview and never retries generation", async () => {
    const fetcher = vi.fn(async () =>
      sse([
        {
          type: "image_generation.partial_image",
          b64_json: png.toString("base64"),
        },
      ]),
    );
    vi.stubGlobal("fetch", fetcher);
    await expect(
      generateOpenAIImages(provider, schema.parse({ prompt: "Draw" })),
    ).rejects.toThrow("before the complete");
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("preserves provider failures and cancellation", async () => {
    const fetcher = vi.fn(async () =>
      Response.json(
        { error: { message: "Image model access denied" } },
        { status: 403 },
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    await expect(
      generateOpenAIImages(provider, schema.parse({ prompt: "Draw" })),
    ).rejects.toThrow("Image API 403: Image model access denied");
    const signal = AbortSignal.abort(new Error("cancelled"));
    await expect(
      generateOpenAIImages(provider, schema.parse({ prompt: "Draw" }), {
        signal,
      }),
    ).rejects.toThrow("cancelled");
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([
    { background: "transparent", outputFormat: "jpeg" },
    { outputFormat: "png", outputCompression: 90 },
    { stream: false, partialImages: 1 },
    { inputFidelity: "high" },
  ])(
    "rejects incompatible options before making a request: %j",
    async (options) => {
      const fetcher = vi.fn();
      vi.stubGlobal("fetch", fetcher);
      await expect(
        generateOpenAIImages(
          provider,
          schema.parse({ prompt: "Draw", ...options }),
        ),
      ).rejects.toThrow();
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it("accepts custom model IDs without a whitelist", async () => {
    const fetcher = vi.fn(async () => json());
    vi.stubGlobal("fetch", fetcher);
    await generateOpenAIImages(
      provider,
      schema.parse({
        prompt: "Draw",
        model: "future-vision-model",
        size: "512x512",
        stream: false,
      }),
    );
    expect(
      JSON.parse(
        (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1]
          .body as string,
      ).model,
    ).toBe("future-vision-model");
  });
  it("validates model-specific limits only in the relevant adapter", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json()),
    );
    for (const size of ["1025x1024", "64x64", "3840x3840"])
      await expect(
        generateOpenAIImages(
          provider,
          schema.parse({ prompt: "Draw", size, stream: false }),
        ),
      ).rejects.toThrow("GPT Image 2 size");
    for (const size of ["3840x2160", "2160x3840", "1536x864"])
      await expect(
        generateOpenAIImages(
          provider,
          schema.parse({ prompt: "Draw", size, stream: false }),
        ),
      ).resolves.toHaveProperty("images");
  });
});
