import type { GeneratedFile } from "../../infrastructure/llm-runtime/contracts.js";
import { randomUUID } from "node:crypto";
import type { ProviderOptions } from "../../infrastructure/llm-runtime/contracts.js";
import { bindValidatedAssets, createAsset } from "./media-assets.js";
import {
  modalityForMime,
  runtimeContentPartSchema,
  type RuntimeContentPart,
} from "./content-parts.js";

/** Store binary output once; persistence, SSE and model history carry references only. */
export async function saveGeneratedMedia(
  projectId: string | undefined,
  file: Pick<GeneratedFile, "mediaType" | "uint8Array">,
  providerOptions?: ProviderOptions,
  sessionId?: string,
): Promise<RuntimeContentPart> {
  if (!projectId)
    throw new Error("Generated media requires a project context.");
  const extension =
    file.mediaType
      .split("/")[1]
      ?.replace(/[^a-z0-9]/gi, "")
      .slice(0, 20) || "bin";
  const asset = await createAsset(
    projectId,
    `generated-${randomUUID()}.${extension}`,
    Buffer.from(file.uint8Array),
    file.mediaType,
  );
  const part = runtimeContentPartSchema.parse({
    type: modalityForMime(asset.mediaType),
    assetId: asset.id,
    ...(providerOptions
      ? { providerOptions: JSON.parse(JSON.stringify(providerOptions)) }
      : {}),
  });
  if (sessionId) await bindValidatedAssets(sessionId, [asset]);
  return part;
}
