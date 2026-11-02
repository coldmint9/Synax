import type { RuntimeContentPart } from "../../adapters/transport/runtimeMedia";
import type { ToolCallView } from "./buildInterleavedTurns";

export type ImageContentPart = Extract<RuntimeContentPart, { type: "image" }>;

/** Extra row height a thumbnail strip adds below one activity line. */
export const TOOL_CALL_MEDIA_STRIP_HEIGHT = 46;

/**
 * Images a call read or produced.
 *
 * `media.read` returns the parsed visuals and `media.generate` returns its
 * output assets in `contentParts`, so one reference list covers both read and
 * output images. Parallel calls often share a reference (a preview asset that
 * is also the final output), and deduping keeps one thumbnail per asset.
 */
export function toolCallImageParts(
  calls: readonly Pick<ToolCallView, "contentParts">[],
): ImageContentPart[] {
  const seen = new Set<string>();
  const parts: ImageContentPart[] = [];
  for (const call of calls) {
    for (const part of call.contentParts ?? []) {
      if (part.type !== "image" || seen.has(part.assetId)) continue;
      seen.add(part.assetId);
      parts.push(part);
    }
  }
  return parts;
}
