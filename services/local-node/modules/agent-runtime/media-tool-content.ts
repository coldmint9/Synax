import { createAsset } from "./media-assets.js";
import {
  MAX_FILE_BYTES,
  modalityForMime,
  type RuntimeContentPart,
} from "./content-parts.js";
export async function importToolContent(
  projectId: string,
  content: unknown,
): Promise<RuntimeContentPart[]> {
  if (!Array.isArray(content)) return [];
  const parts: RuntimeContentPart[] = [];
  for (const value of content) {
    if (!value || typeof value !== "object") continue;
    const p = value as Record<string, any>;
    if (p.type === "text" && typeof p.text === "string") {
      parts.push({ type: "text", text: p.text });
      continue;
    }
    const resource = p.type === "resource" ? p.resource : undefined;
    if (resource && typeof resource.text === "string") {
      parts.push({ type: "text", text: resource.text });
      continue;
    }
    const base64 = ["image", "audio", "video", "file"].includes(p.type)
      ? (p.data ?? (p.source?.type === "base64" ? p.source.data : undefined))
      : resource?.blob;
    if (typeof base64 === "string") {
      if (base64.length > Math.ceil(MAX_FILE_BYTES / 3) * 4)
        throw new Error("Tool media exceeds 50 MiB.");
      const mime =
        p.mimeType ??
        p.source?.media_type ??
        resource?.mimeType ??
        "application/octet-stream";
      const filename =
        p.name ??
        `tool-${parts.length}.${({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "audio/wav": "wav", "audio/mpeg": "mp3", "application/pdf": "pdf" } as Record<string, string>)[mime] ?? "bin"}`;
      const asset = await createAsset(
        projectId,
        filename,
        Buffer.from(base64, "base64"),
        mime,
      );
      parts.push({ type: modalityForMime(asset.mediaType), assetId: asset.id });
    } else if (p.type === "resource_link")
      parts.push({
        type: "text",
        text: JSON.stringify({
          type: "resource_link",
          uri: p.uri,
          name: p.name,
          mimeType: p.mimeType,
        }),
      });
  }
  return parts;
}
export function hasInlineMedia(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasInlineMedia);
  if (!value || typeof value !== "object") return false;
  const p = value as Record<string, any>;
  if (
    ["image", "audio", "video", "file"].includes(p.type) &&
    (typeof p.data === "string" || p.source?.type === "base64")
  )
    return true;
  if (p.type === "resource" && typeof p.resource?.blob === "string")
    return true;
  return Object.values(p).some(hasInlineMedia);
}
export async function normalizeMediaPayload(
  projectId: string,
  value: unknown,
): Promise<{ value: unknown; contentParts: RuntimeContentPart[] }> {
  const parts: RuntimeContentPart[] = [];
  async function visit(value: unknown): Promise<unknown> {
    if (Array.isArray(value)) return Promise.all(value.map(visit));
    if (!value || typeof value !== "object") return value;
    const p = value as Record<string, any>;
    if (
      (["image", "audio", "video", "file"].includes(p.type) &&
        (typeof p.data === "string" || p.source?.type === "base64")) ||
      (p.type === "resource" && typeof p.resource?.blob === "string")
    ) {
      const imported = await importToolContent(projectId, [p]);
      parts.push(...imported);
      return { contentParts: imported };
    }
    const entries = await Promise.all(
      Object.entries(p).map(async ([key, v]) => [key, await visit(v)]),
    );
    return Object.fromEntries(entries);
  }
  return { value: await visit(value), contentParts: parts };
}
export function redactInlineMedia(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactInlineMedia);
  if (!value || typeof value !== "object") return value;
  const p = value as Record<string, any>;
  if (
    ["image", "audio", "video", "file"].includes(p.type) &&
    (typeof p.data === "string" || p.source?.type === "base64")
  )
    return {
      type: p.type,
      mediaType: p.mimeType ?? p.source?.media_type,
      mediaPending: true,
    };
  if (p.type === "resource" && typeof p.resource?.blob === "string")
    return { type: "resource", uri: p.resource.uri, mediaPending: true };
  return Object.fromEntries(
    Object.entries(p).map(([key, v]) => [key, redactInlineMedia(v)]),
  );
}
