import { requestMedia, type MediaFile } from "./media-client.js";
import { z } from "zod/v4";
import type { ResolvedProviderConfig, RuntimeProvider } from "./types.js";

export const imageGenerationOptionsSchema = z.object({
  api: z
    .enum(["auto", "images", "responses", "native", "sdk"])
    .default("auto")
    .describe(
      "auto selects an adapter. images/responses require an OpenAI-compatible provider; native uses the native image adapter; sdk is a legacy alias. responses requires n=1. Native adapters reject stream=true and partialImages; Images/Responses reject aspectRatio and seed.",
    ),
  model: z.string().trim().min(1).max(256).default("gpt-image-2.5-sunburst"),
  prompt: z.string().trim().min(1).max(32_000),
  n: z.number().int().min(1).max(10).default(1).describe("Image count; api=responses requires exactly 1. Use api=images for batches."),
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
    }, "Use auto or a positive WIDTHxHEIGHT.")
    .describe("auto or positive WIDTHxHEIGHT, e.g. 1024x1024. For GPT Image 2 on Images/Responses: multiples of 16, at most 3840 per edge, ratio 1:3 to 3:1, and 655360-8294400 total pixels. Native adapter sizes depend on the model."),
  quality: z.string().min(1).max(64).default("auto").describe("Model-dependent quality. Responses accepts auto, low, medium, high, xhigh or max."),
  background: z.enum(["auto", "opaque", "transparent"]).default("auto"),
  outputFormat: z.enum(["png", "jpeg", "webp"]).default("png"),
  outputCompression: z.number().int().min(0).max(100).optional().describe("Images/Responses compression requires outputFormat jpeg or webp; omit for png."),
  moderation: z.enum(["auto", "low"]).optional(),
  inputFidelity: z.enum(["high", "low"]).optional().describe("Edit fidelity; Images/Responses require at least one reference image when supplied."),
  stream: z.boolean().optional().describe("Images/Responses default to streaming. Native adapters require false or omission; true is rejected."),
  partialImages: z.number().int().min(0).max(3).optional().describe("Preview count for Images/Responses with streaming enabled; rejected by Native adapters or stream=false."),
  aspectRatio: z
    .string()
    .regex(/^\d+:\d+$/)
    .optional()
    .describe("WIDTH:HEIGHT for native models supporting aspect ratios. Images/Responses reject this; use size there."),
  seed: z.number().int().optional().describe("Native model seed when supported. Images/Responses reject this field."),
  providerOptions: z
    .record(z.string(), z.record(z.string(), z.json()))
    .optional()
    .describe("Provider namespaces mapped to parameter objects, e.g. { openai: { parameter: value } }. Values must be JSON; do not pass a flat parameter map."),
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
/** Validate host assets and delegate the complete media operation to Rust. */
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
  const args = { ...parsed, stream: parsed.stream ?? !["sdk", "native"].includes(parsed.api) };
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

  const wireFile = (file: ImageInputFile): MediaFile => ({ data: file.bytes.toString("base64"), mediaType: file.mediaType, filename: file.filename });
  const imageFile = (file: MediaFile): GeneratedImage => ({ bytes: Buffer.from(file.data, "base64"), mediaType: file.mediaType,
    format: file.format ?? args.outputFormat, ...(file.revisedPrompt ? { revisedPrompt: file.revisedPrompt } : {}) });
  const result = await requestMedia(provider, "images", args, {
    files: images.map(wireFile), mask: input.mask && wireFile(input.mask), signal: input.signal,
    onPartial: async file => { await input.onPartial?.(imageFile(file)); },
  });
  return { images: (result.files ?? []).map(imageFile), usage: result.usage, warnings: result.warnings };
}
