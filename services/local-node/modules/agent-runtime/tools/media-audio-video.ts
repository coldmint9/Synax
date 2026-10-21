import { z } from "zod/v4";
import { assertSessionMediaBudget } from "./media-context.js";
import type {
  RegisteredTool,
  ToolExecutionInput,
  ToolExecutionResult,
} from "../contracts.js";
import { agentRuntimeStore } from "../session-store.js";
import { saveGeneratedMedia } from "../generated-media.js";
import { requestMedia } from "../../../infrastructure/llm-runtime/media-client.js";
import {
  resolveSessionMediaProvider,
  loadSessionMedia,
} from "./media-context.js";

const common = z.object({
  providerId: z.string().min(1).optional().describe("Configured provider ID; defaults to the current conversation provider. It must expose the capability needed by this operation."),
  model: z
    .string()
    .min(1)
    .max(256)
    .describe(
      "Exact model ID supported by the selected provider for this media operation.",
    ),
  providerOptions: z
    .record(z.string(), z.record(z.string(), z.json()))
    .optional()
    .describe("Provider-specific options grouped by namespace, e.g. {providerName: {optionName: value}}; values must be JSON."),
});
const assetId = z.string().regex(/^asset_[a-f0-9]{32}$/).describe("Asset ID attached to this session; use media.read to attach local files first.");
const speechSchema = common
  .extend({
    text: z.string().min(1).max(100_000),
    voice: z.string().optional(),
    outputFormat: z.enum(["mp3", "wav", "opus", "aac", "flac"]).optional(),
    instructions: z.string().optional(),
    speed: z.number().positive().optional(),
    language: z.string().optional(),
  })
  .strict();
const transcriptionSchema = common.extend({ audio: assetId }).strict();
const videoSchema = common
  .extend({
    prompt: z.string().min(1).max(32_000),
    image: assetId.optional(),
    references: z.array(assetId).max(16).optional(),
    frameImages: z
      .array(
        z.object({
          image: assetId,
          frameType: z.enum(["first_frame", "last_frame"]),
        }),
      )
      .max(2)
      .optional(),
    n: z.number().int().min(1).max(10).optional(),
    aspectRatio: z
      .string()
      .regex(/^\d+:\d+$|^adaptive$/)
      .optional(),
    resolution: z
      .string()
      .regex(/^\d+x\d+$/)
      .optional(),
    duration: z.number().positive().optional(),
    fps: z.number().positive().optional(),
    seed: z.number().int().optional(),
    generateAudio: z.boolean().optional(),
  })
  .strict();

async function saveOutput(
  input: ToolExecutionInput,
  files: Array<{ mediaType: string; uint8Array: Uint8Array }>,
  result: unknown,
  summary: string,
): Promise<ToolExecutionResult> {
  input.abortSignal?.throwIfAborted();
  const projectId = agentRuntimeStore.getSession(input.sessionId).projectId;
  return {
    contentParts: await Promise.all(
      files.map((file) => saveGeneratedMedia(projectId, file, undefined, input.sessionId)),
    ),
    result,
    displaySummary: summary,
    artifacts: [],
  };
}
const base = {
  category: "task",
  internalGate: "network",
  mutability: "task",
  resumeBehavior: "none",
} as const;

export const mediaAudioVideoTools: RegisteredTool[] = [
  {
    ...base,
    id: "media.speak",
    progressiveDetails: "The configured provider must expose speechModel and support the exact model ID. voice, speed, language and instructions depend on that provider; do not assume the conversation model supports speech.",
    label: "Generate speech",
    description:
      "Convert text to an audio asset with any configured provider exposing a speech model. Specify the exact model and optional voice, format, language and providerOptions. Returns playable, downloadable audio.",
    inputSchema: speechSchema,
    async execute(input) {
      const args = speechSchema.parse(input.args);
      const response = await requestMedia(await resolveSessionMediaProvider(input, args.providerId), "speech", args, { signal: input.abortSignal });
      return saveOutput(
        input,
        (response.files ?? []).map(file => ({ mediaType: file.mediaType, uint8Array: Buffer.from(file.data, "base64") })),
        { model: args.model, warnings: response.warnings },
        "Generated speech",
      );
    },
  },
  {
    ...base,
    id: "media.transcribe",
    progressiveDetails: "audio must be an audio/* asset attached to this session. The configured provider must expose transcriptionModel and support the exact model ID.",
    label: "Transcribe audio",
    description:
      "Transcribe a session audio asset with a configured transcription model. Returns text, language and timestamped segments when supported. Use media.read to attach a workspace audio file first.",
    inputSchema: transcriptionSchema,
    async execute(input) {
      const args = transcriptionSchema.parse(input.args);
      const audio = await loadSessionMedia(input.sessionId, args.audio);
      if (!audio.asset.mediaType.startsWith("audio/"))
        throw new Error("Transcription requires an audio asset.");
      const response = await requestMedia(await resolveSessionMediaProvider(input, args.providerId), "transcribe", args, {
        files: [{ data: audio.bytes.toString("base64"), mediaType: audio.asset.mediaType, filename: audio.asset.filename }], signal: input.abortSignal,
      });
      return {
        result: {
          text: response.text,
          language: response.language,
          segments: response.segments,
          durationInSeconds: response.durationInSeconds,
          warnings: response.warnings,
        },
        displaySummary: (response.text ?? "").slice(0, 1000),
        artifacts: [],
      };
    },
  },
  {
    ...base,
    id: "media.video",
    progressiveDetails: "Discover configured video models and supported controls with media.models first. All input assets must be attached to this session, with at most 100 MiB of combined reference bytes. image and frameImages require image/* assets; references may contain image/* or video/* assets. The provider must expose videoModel. Frame/input combinations and duration, resolution, fps and audio support depend on the selected model.",
    label: "Generate video",
    description:
      "Generate video using a configured provider exposing a video model. Supports text, an initial image, first/last frames, image/video references, duration, dimensions, audio and providerOptions as supported by that model. Returns playable, downloadable video. Generation may take several minutes.",
    inputSchema: videoSchema,
    async execute(input) {
      const args = videoSchema.parse(input.args);
      assertSessionMediaBudget(input.sessionId, [
        ...(args.references ?? []),
        ...(args.frameImages ?? []).map((frame) => frame.image),
        ...(args.image ? [args.image] : []),
      ]);
      const load = async (id: string, imageOnly = false) => {
        const value = await loadSessionMedia(input.sessionId, id);
        if (
          !value.asset.mediaType.startsWith("image/") &&
          (imageOnly || !value.asset.mediaType.startsWith("video/"))
        )
          throw new Error(
            "Video references require compatible image/video assets.",
          );
        return value;
      };
      const image = args.image ? await load(args.image, true) : undefined;
      const refs = await Promise.all(
        (args.references ?? []).map((id) => load(id)),
      );
      const frames = await Promise.all(
        (args.frameImages ?? []).map(async (frame) => ({
          image: (await load(frame.image, true)).bytes,
          frameType: frame.frameType,
        })),
      );
      const response = await requestMedia(await resolveSessionMediaProvider(input, args.providerId), "video", {
        ...args, frameImages: frames.map(frame => ({ ...frame, image: frame.image.toString("base64") })),
      }, { files: [...(image ? [image] : []), ...refs].map(ref => ({ data: ref.bytes.toString("base64"), mediaType: ref.asset.mediaType, filename: ref.asset.filename })), signal: input.abortSignal });
      return saveOutput(
        input,
        (response.files ?? []).map(file => ({ mediaType: file.mediaType, uint8Array: Buffer.from(file.data, "base64") })),
        { model: args.model, warnings: response.warnings },
        `Generated ${(response.files ?? []).length} video(s)`,
      );
    },
  },
];
