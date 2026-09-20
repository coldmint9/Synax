import { z } from "zod/v4";
import { assertSessionMediaBudget } from "./media-context.js";
import type { RegisteredTool } from "../contracts.js";
import type { RuntimeContentPart } from "../content-parts.js";
import { createAsset } from "../media-assets.js";
import { agentRuntimeStore as store } from "../session-store.js";
import { sessionLiveBus } from "../session-live-bus.js";
import {
  resolveSessionMediaProvider,
  loadSessionMedia,
} from "./media-context.js";
import {
  imageGenerationOptionsSchema,
  type GeneratedImage,
  type ImageInputFile,
} from "../../llm-runtime/image-generation.js";
import { generateProviderImages } from "../../llm-runtime/media-generation.js";

const assetId = z.string().regex(/^asset_[a-f0-9]{32}$/);
export const mediaGenerateSchema = imageGenerationOptionsSchema
  .extend({
    providerId: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Configured media provider. Defaults to the current conversation provider.",
      ),
    images: z
      .array(assetId)
      .max(16)
      .optional()
      .describe(
        "Reference image asset IDs attached to this session. Omit to generate from scratch; supply to edit. Use media.read first for workspace files.",
      ),
    mask: assetId
      .optional()
      .describe(
        "PNG mask asset ID; transparent pixels are edited. Must match the first image dimensions.",
      ),
  })
  .strict();

export const mediaGenerateTool: RegisteredTool = {
  id: "media.generate",
  label: "Generate or edit images",
  description:
    "Generate or edit images using a configured provider and any supported image model ID. Supports reference assets, masks, quality, dimensions, output format, and providerOptions. api=auto uses OpenAI Images for compatible connections or the provider SDK; api=responses uses the conversation model's hosted image tool. Streaming and controls depend on the selected adapter. Returns downloadable assets reusable with media.read or further edits. OpenAI examples: gpt-image-2.5-sunburst and gpt-image-2.5-flare. For other providers specify the image model explicitly.",
  category: "task",
  internalGate: "network",
  mutability: "task",
  resumeBehavior: "none",
  inputSchema: mediaGenerateSchema,
  async execute(input) {
    const args = mediaGenerateSchema.parse(input.args);
    const session = store.getSession(input.sessionId);
    assertSessionMediaBudget(input.sessionId, [
      ...(args.images ?? []),
      ...(args.mask ? [args.mask] : []),
    ]);
    const loadImage = async (id: string): Promise<ImageInputFile> => {
      const { asset, bytes } = await loadSessionMedia(input.sessionId, id);
      return { bytes, filename: asset.filename, mediaType: asset.mediaType };
    };
    const images = await Promise.all((args.images ?? []).map(loadImage));
    const mask = args.mask ? await loadImage(args.mask) : undefined;
    const selection = await resolveSessionMediaProvider(input, args.providerId);
    if (
      !(input.args as Record<string, unknown>).model &&
      !["@ai-sdk/openai", "@ai-sdk/openai-compatible"].includes(
        selection.provider.npm ?? "",
      )
    )
      throw new Error("Specify an image model from the selected provider.");
    let previewIndex = 0;
    const saveImage = (image: GeneratedImage, suffix: string) =>
      createAsset(
        session.projectId,
        `${args.model}-${input.toolCallId}-${suffix}.${image.format}`,
        image.bytes,
        image.mediaType,
      );
    const generated = await generateProviderImages(selection, args, {
      images,
      mask,
      signal: input.abortSignal,
      onPartial: async (image) => {
        input.abortSignal?.throwIfAborted();
        const asset = await saveImage(image, `preview-${++previewIndex}`);
        const record = store.updateToolCall(input.sessionId, input.toolCallId, {
          contentParts: [{ type: "image", assetId: asset.id }],
          outputSummary: `Generating image… (preview ${previewIndex})`,
        });
        if (input.stepId)
          sessionLiveBus.emit(input.sessionId, {
            type: "tool_result",
            stepId: input.stepId,
            toolCall: record,
          });
      },
    });
    input.abortSignal?.throwIfAborted();
    const assets = await Promise.all(
      generated.images.map((image, index) =>
        saveImage(image, String(index + 1)),
      ),
    );
    const contentParts: RuntimeContentPart[] = assets.map((asset) => ({
      type: "image",
      assetId: asset.id,
    }));
    return {
      result: {
        model: args.model,
        providerId: selection.provider.id,
        assets,
        usage: generated.usage,
        warnings: generated.warnings,
        revisedPrompts: generated.images.map(
          (image) => image.revisedPrompt ?? null,
        ),
      },
      contentParts,
      displaySummary: `${images.length ? "Edited" : "Generated"} ${assets.length} image(s) with ${args.model}`,
      artifacts: [],
    };
  },
};
