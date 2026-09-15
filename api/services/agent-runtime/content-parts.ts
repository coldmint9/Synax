import { z } from "zod/v4";

export const INPUT_MODALITIES = [
  "text",
  "image",
  "audio",
  "video",
  "file",
] as const;
export type InputModality = (typeof INPUT_MODALITIES)[number];
export const runtimeContentPartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string().max(100_000) }),
  ...(["image", "audio", "video", "file"] as const).map((type) =>
    z.object({
      type: z.literal(type),
      assetId: z.string().regex(/^asset_[a-f0-9]{32}$/),
    }),
  ),
]);
export type RuntimeContentPart = z.infer<typeof runtimeContentPartSchema>;
export const contentPartsSchema = z
  .array(runtimeContentPartSchema)
  .max(100)
  .refine(
    (parts) => parts.filter((p) => p.type !== "text").length <= 10,
    "At most 10 files per input.",
  )
  .refine(
    (parts) => contentText(parts).length <= 100_000,
    "Text input exceeds 100,000 characters.",
  );
export interface RuntimeAsset {
  id: string;
  projectId: string;
  filename: string;
  mediaType: string;
  size: number;
  sha256: string;
  createdAt: string;
}
export interface InputCapabilities {
  modalities: InputModality[];
  verified: boolean;
  mediaTypes?: string[];
  maxFileBytes: number;
  maxTotalBytes: number;
  maxFiles: number;
}
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_INPUT_BYTES = 100 * 1024 * 1024;
export function contentText(parts: RuntimeContentPart[]): string {
  return parts
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}
export function inputParts(input: {
  contentParts?: RuntimeContentPart[];
  message?: string;
}): RuntimeContentPart[] {
  return (
    input.contentParts ??
    (input.message ? [{ type: "text", text: input.message }] : [])
  );
}
export function hasInput(input: {
  contentParts?: RuntimeContentPart[];
  message?: string;
}): boolean {
  return inputParts(input).some(
    (p) => p.type !== "text" || Boolean(p.text.trim()),
  );
}
export function normalizeInput<
  T extends { contentParts?: RuntimeContentPart[]; message?: string },
>(input: T): T {
  return input.contentParts
    ? {
        ...input,
        contentParts: contentPartsSchema.parse(input.contentParts),
        message: contentText(input.contentParts),
      }
    : input;
}
export function modalityForMime(mime: string): Exclude<InputModality, "text"> {
  return mime.startsWith("image/")
    ? "image"
    : mime.startsWith("audio/")
      ? "audio"
      : mime.startsWith("video/")
        ? "video"
        : "file";
}

export function mediaSafeErrorText(value: unknown): string {
  return String(value)
    .replace(/data:[^;\s]+;base64,[A-Za-z0-9+/=]+/g, "[media data omitted]")
    .replace(
      /("(?:data|blob|file_data)"\s*:\s*")[A-Za-z0-9+/=]{80,}/g,
      "$1[media data omitted]",
    );
}
