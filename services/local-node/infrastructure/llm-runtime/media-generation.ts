import type { RuntimeProvider, ResolvedProviderConfig } from "./types.js";
import { generateOpenAIImages, type ImageGenerationOptions, type ImageInputFile, type ImageGenerationResult, type GeneratedImage } from "./image-generation.js";
export interface MediaProviderSelection { modelId?: string; provider: RuntimeProvider; config: ResolvedProviderConfig }
export async function generateProviderImages(selection: MediaProviderSelection, options: ImageGenerationOptions, input: {
  images?: ImageInputFile[]; mask?: ImageInputFile; signal?: AbortSignal; onPartial?: (image: GeneratedImage) => Promise<void>;
} = {}): Promise<ImageGenerationResult> {
  return generateOpenAIImages(selection, options, input);
}
