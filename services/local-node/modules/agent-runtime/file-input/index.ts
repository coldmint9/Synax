import "./builtin-parsers.js";
import { getAsset, readAsset, createAsset } from "../media-assets.js";
import {
  contentText,
  type RuntimeAsset,
  type RuntimeContentPart,
  type InputCapabilities,
} from "../content-parts.js";
import { AgentRuntimeError } from "../runtime-errors.js";
import {
  isNativeVisual,
  parseFileInput,
  MAX_PARSED_CHARACTERS,
  type ParsedFile,
} from "./registry.js";
export {
  registerFileParser,
  parseFileInput,
  decodeCharacterFile,
} from "./registry.js";
export type { FileParser, FileParserInput, ParsedFile } from "./registry.js";
export async function parseAssetInput(
  asset: RuntimeAsset,
  visual?: import("./registry.js").FileParserInput["visual"],
): Promise<ParsedFile> {
  return parseFileInput({
    filename: asset.filename,
    mediaType: asset.mediaType,
    bytes: await readAsset(asset.id, asset.projectId),
    visual,
  });
}
export async function resolveFileParts(
  parts: RuntimeContentPart[],
  projectId?: string,
  capability?: InputCapabilities,
): Promise<RuntimeContentPart[]> {
  const output: RuntimeContentPart[] = [];
  let remainingPages = Math.max(
    0,
    Math.min(10, capability?.maxFiles ?? 10) -
      parts.filter(
        (p) =>
          p.type !== "text" &&
          isNativeVisual(getAsset(p.assetId, projectId).mediaType),
      ).length,
  );
  let remainingBytes = Math.max(
    0,
    (capability?.maxTotalBytes ?? 20 * 1024 * 1024) -
      parts.reduce(
        (sum, p) =>
          sum +
          (p.type !== "text" &&
          isNativeVisual(getAsset(p.assetId, projectId).mediaType)
            ? getAsset(p.assetId, projectId).size
            : 0),
        0,
      ),
  );
  const supportsImages =
    capability?.verified &&
    capability.modalities.includes("image") &&
    (!capability.mediaTypes?.length ||
      capability.mediaTypes.some(
        (type) => type === "image/png" || type === "image/*",
      ));
  for (const part of parts) {
    if (part.type === "text") {
      output.push(part);
      continue;
    }
    const asset = getAsset(part.assetId, projectId);
    if (isNativeVisual(asset.mediaType)) {
      output.push(part);
      continue;
    }
    const parsed = await parseAssetInput(
      asset,
      supportsImages
        ? {
            maxPages: remainingPages,
            maxImageBytes: capability.maxFileBytes,
            maxTotalBytes: remainingBytes,
          }
        : undefined,
    );
    output.push({
      type: "text",
      text: parsed.text,
      attachmentName: asset.filename,
    });
    for (const image of parsed.images ?? []) {
      const rendered = await createAsset(
        asset.projectId,
        `${asset.filename}.page-${image.page}.png`,
        Buffer.from(image.bytes),
        image.mediaType,
      );
      output.push({
        type: "text",
        text: `文件：${asset.filename}，第 ${image.page} 页完整页面图像。请结合该页文字和前后文分析图片、流程图及其关系。`,
      });
      output.push({ type: "image", assetId: rendered.id, detail: "high" });
      remainingPages--;
      remainingBytes -= image.bytes.length;
    }
  }
  if (contentText(output).length > MAX_PARSED_CHARACTERS)
    throw new AgentRuntimeError(
      "输入及文件解析文字合计超过 100000 字符，请拆分后发送。",
      "FILE_TEXT_TOO_LARGE",
      413,
    );
  return output;
}
