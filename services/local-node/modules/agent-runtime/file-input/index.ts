import "./builtin-parsers.js";
import { getAsset, readAsset } from "../media-assets.js";
import {
  contentText,
  type RuntimeAsset,
  type RuntimeContentPart,
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
): Promise<ParsedFile> {
  return parseFileInput({
    filename: asset.filename,
    mediaType: asset.mediaType,
    bytes: await readAsset(asset.id, asset.projectId),
  });
}
export async function resolveFileParts(
  parts: RuntimeContentPart[],
  projectId?: string,
): Promise<RuntimeContentPart[]> {
  const output: RuntimeContentPart[] = [];
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
    const parsed = await parseAssetInput(asset);
    output.push({
      type: "text",
      text: parsed.text,
      attachmentName: asset.filename,
    });
  }
  if (contentText(output).length > MAX_PARSED_CHARACTERS)
    throw new AgentRuntimeError(
      "输入及文件解析文字合计超过 100000 字符，请拆分后发送。",
      "FILE_TEXT_TOO_LARGE",
      413,
    );
  return output;
}
