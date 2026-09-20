import type { RuntimeModel } from "./types.js";

// Official model contracts, independent of models.dev availability.
// https://developers.openai.com/api/docs/models/gpt-5.6-sol
// https://developers.openai.com/api/docs/guides/image-generation
export const GPT_IMAGE_MODELS = [
  "gpt-image-2.5-sunburst",
  "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst-2026-09-08",
  "gpt-image-2.5-flare-2026-09-08",
] as const;

export function isImageGenerationModel(id: string): boolean {
  return /^(?:gpt-image-|chatgpt-image-|dall-e-)/i.test(id);
}

export function openAIModelContract(
  id: string,
): Partial<RuntimeModel> | undefined {
  if (id === "gpt-5.6-sol" || id === "gpt-5.6") {
    return {
      inputModalities: ["text", "image", "file"],
      outputModalities: ["text"],
      contextLimit: 1_050_000,
      maxTokens: 128_000,
      reasoning: true,
      toolCall: true,
    };
  }
  if (GPT_IMAGE_MODELS.includes(id as (typeof GPT_IMAGE_MODELS)[number])) {
    return {
      inputModalities: ["text", "image"],
      outputModalities: ["image"],
      reasoning: false,
      toolCall: false,
    };
  }
}
