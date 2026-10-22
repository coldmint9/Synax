/** Attachments stay outside text summaries, including nested tool/native media. */
const ATTACHMENT_TYPES = new Set([
  "image", "file", "document", "audio", "video", "attachment",
  "image_url", "input_image", "output_image", "input_file", "input_audio",
  "image-data", "file-data", "file-url",
]);

export function hasContextAttachment(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasContextAttachment);
  const record = value as Record<string, unknown>;
  if (typeof record.type === "string" && ATTACHMENT_TYPES.has(record.type))
    return true;
  return Object.values(record).some(hasContextAttachment);
}
