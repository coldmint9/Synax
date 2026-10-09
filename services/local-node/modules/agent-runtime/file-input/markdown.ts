import { fromMarkdown } from "mdast-util-from-markdown";
import type { RootContent, Definition } from "mdast";
import { decodeCharacterFile, type FileParser, type ParsedDocument } from "./registry.js";
import { fetchRemoteImage } from "./remote-image.js";

export const markdownImage: FileParser = {
  id: "markdown",
  supports: (input) => input.mediaType === "text/markdown" || /\.(md|markdown|mdown)$/i.test(input.filename),
  async parse(input): Promise<ParsedDocument> {
    const text = decodeCharacterFile(input.bytes);
    if (text === undefined || text.length > 100_000) throw new Error("Markdown 编码无效或超过 100000 字符。");
    const tree = fromMarkdown(text);
    const definitions = new Map<string, Definition>();
    const nodes: RootContent[] = [];
    function visit(node: RootContent) {
      nodes.push(node);
      if (node.type === "definition" && !definitions.has(node.identifier)) definitions.set(node.identifier, node);
      if ("children" in node) for (const child of node.children) visit(child);
    }
    tree.children.forEach(visit);
    const refs = new Map<string, { alt: string; line: number }>();
    for (const node of nodes) {
      const url = node.type === "image" ? node.url : node.type === "imageReference" ? definitions.get(node.identifier)?.url : undefined;
      if (url && !refs.has(url)) refs.set(url, { alt: "alt" in node ? node.alt ?? "" : "", line: node.position?.start.line ?? 1 });
    }
    const images: NonNullable<ParsedDocument["images"]> = [];
    const warnings: string[] = [];
    let total = 0, attempted = 0;
    for (const [url, ref] of refs) {
      if (!input.visual || (!input.loadImage && !/^https?:\/\//i.test(url))) {
        warnings.push(`Markdown 图片未识别：${url}（${!input.visual ? "当前模型不支持图片输入" : "请用 media.read 的 path 读取原 Markdown 文件以解析本地图片"}）。`);
        continue;
      }
      if (attempted++ >= Math.min(10, input.visual.maxPages)) {
        warnings.push("其余 Markdown 图片超过本次图片数量限制，未识别。"); break;
      }
      try {
        const original = input.loadImage
          ? await input.loadImage(url)
          : (await fetchRemoteImage(url, Math.min(10 * 1024 * 1024, input.visual.maxImageBytes))).bytes;
        if (original.length > Math.min(10 * 1024 * 1024, input.visual.maxImageBytes)) throw new Error("图片超过大小限制");
        const bytes = Buffer.from(original);
        if (bytes.length > input.visual.maxImageBytes || total + bytes.length > input.visual.maxTotalBytes) throw new Error("图片超过模型输入容量");
        total += bytes.length;
        const mediaType = bytes[0] === 137 && bytes[1] === 80 ? "image/png" : bytes[0] === 255 && bytes[1] === 216 ? "image/jpeg" : bytes.toString("ascii", 0, 4) === "RIFF" ? "image/webp" : "image/png";
        images.push({ page: images.length + 1, bytes, mediaType, context: `文件：${input.filename}，第 ${ref.line} 行图片：${url}；说明：${ref.alt}。请结合文档前后文分析。` });
      } catch (error) {
        warnings.push(`Markdown 图片未识别：${url}（${error instanceof Error ? error.message : String(error)}）。`);
      }
    }
    return { text, images, warnings };
  },
};
