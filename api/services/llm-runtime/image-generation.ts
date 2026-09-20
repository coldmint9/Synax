import { parseJsonEventStream } from "@ai-sdk/provider-utils";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, streamText } from "ai";
import { z } from "zod/v4";
import type { ResolvedProviderConfig, RuntimeProvider } from "./types.js";
import {
  MAX_FILE_BYTES,
  mediaSafeErrorText,
} from "../agent-runtime/content-parts.js";

export const imageGenerationOptionsSchema = z.object({
  api: z
    .enum(["auto", "images", "responses", "sdk"])
    .default("auto")
    .describe(
      "Use Images API for generation/edit batches, or Responses API for providers exposing the hosted image tool.",
    ),
  model: z.string().trim().min(1).max(256).default("gpt-image-2.5-sunburst"),
  prompt: z.string().trim().min(1).max(32_000),
  n: z.number().int().min(1).max(10).default(1),
  size: z
    .string()
    .default("auto")
    .refine((value) => {
      if (value === "auto") return true;
      if (!/^\d+x\d+$/.test(value)) return false;
      return value
        .split("x")
        .every(
          (edge) => Number.isSafeInteger(Number(edge)) && Number(edge) > 0,
        );
    }, "Use auto or a positive WIDTHxHEIGHT."),
  quality: z.string().min(1).max(64).default("auto"),
  background: z.enum(["auto", "opaque", "transparent"]).default("auto"),
  outputFormat: z.enum(["png", "jpeg", "webp"]).default("png"),
  outputCompression: z.number().int().min(0).max(100).optional(),
  moderation: z.enum(["auto", "low"]).optional(),
  inputFidelity: z.enum(["high", "low"]).optional(),
  stream: z.boolean().optional(),
  partialImages: z.number().int().min(0).max(3).optional(),
  aspectRatio: z
    .string()
    .regex(/^\d+:\d+$/)
    .optional(),
  seed: z.number().int().optional(),
  providerOptions: z
    .record(z.string(), z.record(z.string(), z.json()))
    .optional(),
});
export type ImageGenerationOptions = z.infer<
  typeof imageGenerationOptionsSchema
>;
export interface ImageInputFile {
  bytes: Buffer;
  mediaType: string;
  filename: string;
}
export interface GeneratedImage {
  bytes: Buffer;
  mediaType: string;
  format: string;
  revisedPrompt?: string;
}
export interface ImageGenerationResult {
  images: GeneratedImage[];
  usage?: Record<string, unknown>;
  warnings?: unknown[];
}
type ImageProvider = {
  modelId?: string;
  provider: Pick<RuntimeProvider, "id" | "api" | "env">;
  config: ResolvedProviderConfig;
};
const base64Schema = z
  .string()
  .min(1)
  .max(Math.ceil(MAX_FILE_BYTES / 3) * 4);
const imageSchema = z.object({
  b64_json: base64Schema,
  revised_prompt: z.string().optional(),
});
const responseSchema = z.object({
  data: z.array(imageSchema).min(1).max(10),
  output_format: z.enum(["png", "jpeg", "webp"]).optional(),
  usage: z.record(z.string(), z.unknown()).optional(),
});
const eventSchema = z.object({
  type: z.string(),
  b64_json: base64Schema.optional(),
  output_format: z.enum(["png", "jpeg", "webp"]).optional(),
  revised_prompt: z.string().optional(),
  usage: z.record(z.string(), z.unknown()).optional(),
  error: z.unknown().optional(),
  message: z.string().optional(),
});

/** Images API, including edits and partial-image SSE. No automatic retries of paid generation. */
export async function generateOpenAIImages(
  provider: ImageProvider,
  options: ImageGenerationOptions,
  input: {
    images?: ImageInputFile[];
    mask?: ImageInputFile;
    signal?: AbortSignal;
    onPartial?: (image: GeneratedImage) => Promise<void>;
  } = {},
): Promise<ImageGenerationResult> {
  const parsed = imageGenerationOptionsSchema.parse(options);
  const args = { ...parsed, stream: parsed.stream ?? true };
  if (args.api === "sdk")
    throw new Error("Use the SDK image adapter for api=sdk.");
  if (args.aspectRatio || args.seed !== undefined)
    throw new Error(
      "This image protocol uses size; aspectRatio and seed are not supported.",
    );
  if (/^gpt-image-2(?:[.-]|$)/.test(args.model) && args.size !== "auto") {
    const [w, h] = args.size.split("x").map(Number);
    if (
      w % 16 ||
      h % 16 ||
      Math.max(w, h) > 3840 ||
      Math.max(w, h) / Math.min(w, h) > 3 ||
      w * h < 655_360 ||
      w * h > 8_294_400
    )
      throw new Error(
        "GPT Image 2 size must use multiples of 16, at most 3840 per edge, a 1:3–3:1 ratio and 655360–8294400 pixels.",
      );
  }
  if (args.background === "transparent" && args.outputFormat === "jpeg")
    throw new Error("Transparent images require PNG or WebP.");
  if (args.outputCompression !== undefined && args.outputFormat === "png")
    throw new Error("Output compression requires JPEG or WebP.");
  if (!args.stream && args.partialImages !== undefined)
    throw new Error("partialImages requires streaming.");
  const images = input.images ?? [];
  if (images.length > 16)
    throw new Error("Image editing accepts at most 16 reference images.");
  if (!images.length && (input.mask || args.inputFidelity))
    throw new Error("A mask or inputFidelity requires reference images.");
  for (const file of [...images, ...(input.mask ? [input.mask] : [])]) {
    if (
      !["image/png", "image/jpeg", "image/webp"].includes(file.mediaType) ||
      !file.bytes.length ||
      file.bytes.length >= 50_000_000
    )
      throw new Error(
        "Image editing requires PNG, JPEG or WebP files smaller than 50 MB.",
      );
  }
  if (input.mask && input.mask.mediaType !== "image/png")
    throw new Error(
      "Use a PNG mask with an alpha channel and the same dimensions as the first image.",
    );

  const settings = provider.config.options ?? {};
  const baseURL = String(
    settings.baseURL ??
      provider.config.baseUrl ??
      provider.provider.api ??
      "https://api.openai.com/v1",
  ).replace(/\/$/, "");
  const apiKey =
    typeof settings.apiKey === "string"
      ? settings.apiKey
      : (provider.config.apiKey ??
        provider.provider.env.map((name) => process.env[name]).find(Boolean));
  const headers = new Headers();
  if (apiKey) headers.set("Authorization", `Bearer ${apiKey}`);
  if (typeof settings.organization === "string")
    headers.set("OpenAI-Organization", settings.organization);
  if (typeof settings.project === "string")
    headers.set("OpenAI-Project", settings.project);
  if (settings.headers && typeof settings.headers === "object") {
    for (const [key, value] of Object.entries(settings.headers))
      if (typeof value === "string") headers.set(key, value);
  }
  if (
    !headers.has("Authorization") &&
    new URL(baseURL).hostname === "api.openai.com"
  )
    throw new Error(
      `Missing API key for image provider '${provider.provider.id}'. Configure it in Settings.`,
    );
  if (args.api === "responses") {
    if (args.n !== 1)
      throw new Error(
        "Responses image generation produces one image per call. Use api=images for batches.",
      );
    const client = createOpenAI({
      baseURL,
      apiKey: apiKey ?? "synax-proxy",
      headers: Object.fromEntries(headers),
    });
    const tool = client.tools.imageGeneration({
      model: args.model,
      action: images.length ? "edit" : "generate",
      size: args.size,
      quality: z
        .enum(["auto", "low", "medium", "high", "xhigh", "max"])
        .parse(args.quality),
      background: args.background,
      outputFormat: args.outputFormat,
      outputCompression: args.outputCompression,
      moderation: args.moderation,
      inputFidelity: args.inputFidelity,
      partialImages: args.stream ? (args.partialImages ?? 1) : undefined,
      inputImageMask: input.mask
        ? {
            imageUrl: `data:${input.mask.mediaType};base64,${input.mask.bytes.toString("base64")}`,
          }
        : undefined,
    });
    const request = {
      model: client.responses(provider.modelId ?? "gpt-5.6-sol"),
      providerOptions: args.providerOptions,
      messages: [
        {
          role: "user" as const,
          content: [
            { type: "text" as const, text: args.prompt },
            ...images.map((image) => ({
              type: "file" as const,
              data: image.bytes,
              mediaType: image.mediaType,
              filename: image.filename,
            })),
          ],
        },
      ],
      tools: { image_generation: tool },
      toolChoice: {
        type: "tool" as const,
        toolName: "image_generation" as const,
      },
      abortSignal: input.signal,
      maxRetries: 0,
    };
    if (!args.stream) {
      const response = await generateText(request);
      const images = response.toolResults.map((result) =>
        decodeImage(
          {
            b64_json: z.object({ result: base64Schema }).parse(result.output)
              .result,
          },
          args.outputFormat,
        ),
      );
      if (images.length !== 1)
        throw new Error("Responses API did not return a completed image.");
      return { images, usage: { ...response.totalUsage } };
    }
    const stream = streamText({ ...request, includeRawChunks: true });
    const result: ImageGenerationResult = { images: [] };
    const completedImages = new Map<string, GeneratedImage>();
    let finished = false;
    for await (const event of stream.fullStream) {
      input.signal?.throwIfAborted();
      if (event.type === "error") throw event.error;
      if (event.type === "abort")
        throw new Error("Image generation was cancelled.");
      if (event.type === "tool-error")
        throw new Error(
          `Image generation failed: ${mediaSafeErrorText(event.error).slice(0, 1500)}`,
        );
      // Some AI SDK versions drop `preliminary` on provider tool results.
      // Raw protocol events distinguish previews from final images reliably.
      if (event.type === "raw") {
        const raw = event.rawValue as Record<string, any>;
        if (raw?.type === "response.image_generation_call.partial_image")
          await input.onPartial?.(
            decodeImage(
              { b64_json: base64Schema.parse(raw.partial_image_b64) },
              args.outputFormat,
            ),
          );
        const items =
          raw?.type === "response.output_item.done"
            ? [raw.item]
            : raw?.type === "response.completed" &&
                Array.isArray(raw.response?.output)
              ? raw.response.output
              : [];
        for (const item of items)
          if (
            item?.type === "image_generation_call" &&
            item.status === "completed"
          ) {
            completedImages.set(
              String(item.id),
              decodeImage(
                { b64_json: base64Schema.parse(item.result) },
                args.outputFormat,
              ),
            );
          }
      }
      if (event.type === "finish") {
        finished =
          event.finishReason !== "error" && event.finishReason !== "length";
        result.usage = { ...event.totalUsage };
      }
    }
    input.signal?.throwIfAborted();
    result.images = [...completedImages.values()];
    if (!finished || result.images.length !== 1)
      throw new Error("Responses image stream ended before completion.");
    return result;
  }
  const body = {
    ...args.providerOptions?.openai,
    model: args.model,
    prompt: args.prompt,
    n: args.n,
    size: args.size,
    quality: args.quality,
    background: args.background,
    output_format: args.outputFormat,
    output_compression: args.outputCompression,
    moderation: args.moderation,
    input_fidelity: args.inputFidelity,
    stream: args.stream,
    partial_images: args.stream ? (args.partialImages ?? 1) : undefined,
  };
  let payload: BodyInit;
  if (images.length) {
    const form = new FormData();
    for (const [key, value] of Object.entries(body))
      if (value !== undefined) form.set(key, String(value));
    for (const file of images)
      form.append(
        "image[]",
        new Blob([new Uint8Array(file.bytes)], { type: file.mediaType }),
        file.filename,
      );
    if (input.mask)
      form.set(
        "mask",
        new Blob([new Uint8Array(input.mask.bytes)], {
          type: input.mask.mediaType,
        }),
        input.mask.filename,
      );
    headers.delete("Content-Type");
    payload = form;
  } else {
    headers.set("Content-Type", "application/json");
    payload = JSON.stringify(body);
  }
  input.signal?.throwIfAborted();
  const response = await fetch(
    `${baseURL}/images/${images.length ? "edits" : "generations"}`,
    {
      method: "POST",
      headers,
      body: payload,
      signal: input.signal,
    },
  );
  if (!response.ok) {
    const error = (await response.json().catch(() => undefined)) as
      | { error?: { message?: string; code?: string } }
      | undefined;
    throw new Error(
      `Image API ${response.status}: ${mediaSafeErrorText(error?.error?.message ?? error?.error?.code ?? response.statusText).slice(0, 1500)}`,
    );
  }
  if (!args.stream) {
    const data = responseSchema.parse(await response.json());
    if (data.data.length !== args.n)
      throw new Error("Image API returned an incomplete image batch.");
    return {
      images: data.data.map((image) =>
        decodeImage(image, data.output_format ?? args.outputFormat),
      ),
      usage: data.usage,
    };
  }
  if (
    !response.body ||
    !response.headers.get("content-type")?.includes("text/event-stream")
  )
    throw new Error("Image API did not return the requested image stream.");
  const reader = parseJsonEventStream({
    stream: response.body,
    schema: eventSchema,
  }).getReader();
  const result: ImageGenerationResult = { images: [] };
  try {
    for (;;) {
      input.signal?.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      if (!next.value.success)
        throw new Error("Image API returned an invalid stream event.");
      const event = next.value.value;
      if (
        event.error ||
        event.type === "error" ||
        event.type.endsWith(".failed")
      )
        throw new Error(
          `Image generation failed: ${mediaSafeErrorText(event.message ?? (event.error && typeof event.error === "object" && "message" in event.error ? event.error.message : "provider error")).slice(0, 1500)}`,
        );
      if (
        ![
          "image_generation.partial_image",
          "image_edit.partial_image",
          "image_generation.completed",
          "image_edit.completed",
        ].includes(event.type)
      )
        continue;
      if (!event.b64_json)
        throw new Error("Image stream event has no image data.");
      const image = decodeImage(
        { b64_json: event.b64_json, revised_prompt: event.revised_prompt },
        event.output_format ?? args.outputFormat,
      );
      if (event.type.endsWith(".partial_image")) {
        await input.onPartial?.(image);
      } else {
        result.images.push(image);
        if (result.images.length > args.n)
          throw new Error("Image API returned too many images.");
        if (event.usage) result.usage = event.usage;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  input.signal?.throwIfAborted();
  if (result.images.length !== args.n)
    throw new Error(
      "Image stream ended before the complete image batch arrived.",
    );
  return result;
}

function decodeImage(
  image: z.infer<typeof imageSchema>,
  format: GeneratedImage["format"],
): GeneratedImage {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(image.b64_json))
    throw new Error("Image API returned invalid base64.");
  const bytes = Buffer.from(image.b64_json, "base64");
  if (!bytes.length || bytes.length > MAX_FILE_BYTES)
    throw new Error("Generated image exceeds the file limit.");
  return {
    bytes,
    format,
    mediaType: `image/${format}`,
    revisedPrompt: image.revised_prompt,
  };
}
