import { AgentRuntimeError } from "./runtime-errors.js";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import { type RuntimeContentPart } from "./content-parts.js";
import { getAsset, readAsset, assetPath } from "./media-assets.js";
import type { StreamTurnRequest } from "./contracts.js";
import { resolveFileParts } from "./file-input/index.js";
export async function codexMediaInput(
  input: StreamTurnRequest,
  text: string,
): Promise<unknown[]> {
  const parts = await resolveFileParts(input.contentParts ?? [{ type: "text", text }]);
  if (parts.some((p) => p.type !== "text" && p.type !== "image"))
    throw new AgentRuntimeError(
      "Codex only supports text and image attachments.",
      "UNSUPPORTED_MEDIA",
      422,
    );
  for (const part of parts)
    if (part.type !== "text") await readAsset(part.assetId);
  return parts.map((p) =>
    p.type === "text"
      ? { type: "text", text: p.text }
      : { type: "localImage", path: assetPath(p.assetId) },
  );
}
export async function claudeMediaInput(
  input: StreamTurnRequest,
  text: string,
): Promise<any> {
  if (!input.contentParts) return text;
  const parts = await resolveFileParts(input.contentParts);
  if (parts.some((p) => p.type !== "text" && p.type !== "image"))
    throw new AgentRuntimeError(
      "Claude Code only supports text and image attachments.",
      "UNSUPPORTED_MEDIA",
      422,
    );
  return Promise.all(
    parts.map(async (p) =>
      p.type === "text"
        ? p
        : {
            type: "image",
            source: {
              type: "base64",
              media_type: getAsset(p.assetId).mediaType,
              data: (await readAsset(p.assetId)).toString("base64"),
            },
          },
    ),
  );
}
export async function acpMediaInput(
  parts: RuntimeContentPart[],
  text: string,
): Promise<ContentBlock[]> {
  if (!parts.length) return [{ type: "text", text }];
  parts = await resolveFileParts(parts);
  return (await Promise.all(
    parts.map(async (p) => {
      if (p.type === "text") return p;
      const asset = getAsset(p.assetId),
        bytes = await readAsset(p.assetId);
      if (p.type === "image" || p.type === "audio")
        return {
          type: p.type,
          data: bytes.toString("base64"),
          mimeType: asset.mediaType,
        };
      return {
        type: "resource",
        resource: {
          uri: `synax-asset:${asset.id}`,
          mimeType: asset.mediaType,
          ...(asset.mediaType.startsWith("text/")
            ? { text: bytes.toString("utf8") }
            : { blob: bytes.toString("base64") }),
        },
      };
    }),
  )) as ContentBlock[];
}
