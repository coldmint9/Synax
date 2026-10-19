import { AgentRuntimeError } from "./runtime-errors.js";
import { type InputCapabilities } from "./content-parts.js";
import { assetPath, materializeAsset } from "./media-assets.js";
import type { StreamTurnRequest } from "./contracts.js";
import { resolveFileParts } from "./file-input/index.js";
export async function codexMediaInput(
  input: StreamTurnRequest,
  text: string,
  capability?: InputCapabilities,
): Promise<unknown[]> {
  const parts = await resolveFileParts(input.contentParts ?? [{ type: "text", text }], undefined, capability);
  if (parts.some((p) => p.type !== "text" && p.type !== "image"))
    throw new AgentRuntimeError(
      "Codex only supports text and image attachments.",
      "UNSUPPORTED_MEDIA",
      422,
    );
  for (const part of parts)
    if (part.type !== "text") await materializeAsset(part.assetId);
  return parts.map((p) =>
    p.type === "text"
      ? { type: "text", text: p.text }
      : { type: "localImage", path: assetPath(p.assetId) },
  );
}
