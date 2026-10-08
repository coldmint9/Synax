import { AgentRuntimeError } from "../runtime-errors.js";

export interface FileParserInput {
  filename: string;
  mediaType: string;
  bytes: Uint8Array;
  visual?: { maxPages: number; maxImageBytes: number; maxTotalBytes: number };
}
export interface ParsedDocument {
  text: string;
  images?: { page: number; bytes: Uint8Array; mediaType: "image/png" }[];
  warnings?: string[];
}
export interface ParsedFile extends ParsedDocument {
  parserId: string;
}
/** Trusted runtime extensions register parsers; skills may call media.read or return text through tools. */
export interface FileParser {
  id: string;
  supports(input: FileParserInput): boolean;
  parse(input: FileParserInput): Promise<string | ParsedDocument>;
}
export const MAX_PARSED_CHARACTERS = 100_000;
const parsers = new Map<string, FileParser>();
export function registerFileParser(parser: FileParser): () => void {
  if (!parser.id || parsers.has(parser.id))
    throw new Error(`Duplicate file parser: ${parser.id}`);
  parsers.set(parser.id, parser);
  return () => {
    if (parsers.get(parser.id) === parser) parsers.delete(parser.id);
  };
}
export function isNativeVisual(mediaType: string): boolean {
  return (
    (mediaType.startsWith("image/") && mediaType !== "image/svg+xml") ||
    mediaType.startsWith("video/")
  );
}
export function decodeCharacterFile(bytes: Uint8Array): string | undefined {
  let encoding = "utf-8";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = "utf-16le";
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = "utf-16be";
  try {
    const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    return /[\x00-\x08\x0b\x0e-\x1f\x7f]/.test(text) ? undefined : text;
  } catch {
    return undefined;
  }
}
export async function parseFileInput(
  input: FileParserInput,
): Promise<ParsedFile> {
  // Later registrations can replace a built-in format (for example PDF OCR).
  const parser = [...parsers.values()]
    .reverse()
    .find((candidate) => candidate.supports(input));
  let text: string | undefined;
  let document: ParsedDocument | undefined;
  try {
    const result = parser
      ? await parser.parse(input)
      : decodeCharacterFile(input.bytes);
    document = typeof result === "object" ? result : undefined;
    text = document ? document.text : (result as string | undefined);
  } catch (error) {
    if (error instanceof AgentRuntimeError) throw error;
    throw new AgentRuntimeError(
      `无法解析 ${input.filename}：${error instanceof Error ? error.message : String(error)}`,
      "FILE_PARSE_FAILED",
      422,
    );
  }
  if (text === undefined)
    throw new AgentRuntimeError(
      `不支持二进制文件 ${input.filename}。请注册文件解析器，或通过 skill/tool 转换为文字后输入。`,
      "UNSUPPORTED_FILE",
      422,
    );
  if (!text.trim() && !document?.images?.length && !document?.warnings?.length)
    throw new AgentRuntimeError(
      `${input.filename} 没有可读取的文字。扫描 PDF 请通过 OCR skill/tool 转换后输入。`,
      "FILE_TEXT_EMPTY",
      422,
    );
  const formatted = `文件：${input.filename}\n${text}${document?.warnings?.length ? `\n\n${document.warnings.join("\n")}\n请在回复中明确告知用户上述视觉内容未被识别，不要推测遗漏的图片或流程图内容。` : ""}`;
  if (formatted.length > MAX_PARSED_CHARACTERS)
    throw new AgentRuntimeError(
      `${input.filename} 解析文字超过 ${MAX_PARSED_CHARACTERS} 字符，请拆分文件或通过工具分段读取。`,
      "FILE_TEXT_TOO_LARGE",
      413,
    );
  return {
    ...document,
    text: formatted,
    parserId: parser?.id ?? "character-text",
  };
}
