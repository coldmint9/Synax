import { generateImage, type ImageModel } from "ai";
import type { RuntimeProvider, ResolvedProviderConfig } from "./types.js";
import { instantiateProvider } from "./providers/provider-registry.js";
import {
  generateOpenAIImages,
  type ImageGenerationOptions,
  type ImageInputFile,
  type ImageGenerationResult,
  type GeneratedImage,
} from "./image-generation.js";

export interface MediaProviderSelection {
  modelId?: string;
  provider: RuntimeProvider;
  config: ResolvedProviderConfig;
}

/** Provider-native SDK dispatch, with explicit adapters for richer wire protocols. */
export async function generateProviderImages(
  selection: MediaProviderSelection,
  options: ImageGenerationOptions,
  input: {
    images?: ImageInputFile[];
    mask?: ImageInputFile;
    signal?: AbortSignal;
    onPartial?: (image: GeneratedImage) => Promise<void>;
  } = {},
): Promise<ImageGenerationResult> {
  const openai = ["@ai-sdk/openai", "@ai-sdk/openai-compatible"].includes(
    selection.provider.npm ?? "",
  );
  if (
    options.api === "responses" ||
    options.api === "images" ||
    (options.api === "auto" &&
      openai &&
      !/^(?:dall-e-|chatgpt-image-)/.test(options.model))
  ) {
    if (!openai)
      throw new Error(
        "The selected provider does not implement the OpenAI Images/Responses protocol. Use api=sdk.",
      );
    return generateOpenAIImages(selection, options, input);
  }
  if (options.stream === true || options.partialImages !== undefined)
    throw new Error(
      "This SDK image adapter does not expose partial-image streaming. Use stream=false or an Images/Responses provider.",
    );
  const client = (await instantiateProvider(
    selection.provider,
    selection.config,
  )) as { imageModel?: (model: string) => ImageModel };
  if (typeof client.imageModel !== "function")
    throw new Error(
      `Provider '${selection.provider.id}' has no image generation adapter.`,
    );
  const namespace =
    selection.provider.npm === "@ai-sdk/openai-compatible"
      ? selection.provider.id
      : selection.provider.npm?.split("/").pop();
  const controls = {
    ...(options.quality !== "auto" ? { quality: options.quality } : {}),
    ...(options.background !== "auto"
      ? { background: options.background }
      : {}),
    outputFormat: options.outputFormat,
    ...(options.outputCompression !== undefined
      ? { outputCompression: options.outputCompression }
      : {}),
    ...(options.moderation ? { moderation: options.moderation } : {}),
    ...(options.inputFidelity ? { inputFidelity: options.inputFidelity } : {}),
  };
  const result = await generateImage({
    model: client.imageModel(options.model),
    prompt: input.images?.length
      ? {
          text: options.prompt,
          images: input.images.map((image) => image.bytes),
          ...(input.mask ? { mask: input.mask.bytes } : {}),
        }
      : options.prompt,
    n: options.n,
    size:
      options.size === "auto"
        ? undefined
        : (options.size as `${number}x${number}`),
    aspectRatio: options.aspectRatio as `${number}:${number}` | undefined,
    seed: options.seed,
    providerOptions: {
      ...(namespace ? { [namespace]: controls } : {}),
      ...options.providerOptions,
    },
    abortSignal: input.signal,
    maxRetries: 0,
  });
  // Keep warnings visible; a provider may not implement every optional control.
  return {
    images: result.images.map((image) => ({
      bytes: Buffer.from(image.uint8Array),
      mediaType: image.mediaType,
      format: image.mediaType.split("/")[1] ?? "bin",
    })),
    usage: { ...result.usage },
    warnings: result.warnings,
  };
}
