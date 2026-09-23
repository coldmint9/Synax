import { z } from "zod";
import {
  hasVisualization,
  visualizationBlocks,
} from "./visualization-protocol.js";
import { parseFragment, type DefaultTreeAdapterMap } from "parse5";

export const MAX_VISUALIZATION_BYTES = 1_000_000;
const MAX_REPLY_BYTES = 2_000_000;
const FORBIDDEN_TAGS = new Set([
  "meta",
  "base",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "link",
]);

export interface VisualizationDeclaration {
  html?: string;
  sourcePath?: string;
  title?: string;
  mode?: "wide";
  error?: string;
  start: number;
  end: number;
}

/** Syntax validation is not a sandbox. The renderer enforces CSP and an opaque origin. */
export function fragmentError(html: string): string | undefined {
  if (!html.trim()) return "预览内容为空，请重新生成。";
  if (
    Buffer.byteLength(html) > MAX_VISUALIZATION_BYTES ||
    (html.match(/</g)?.length ?? 0) > 10_000
  )
    return "预览内容过大，请简化后重新生成（上限 1 MB）。";
  if (/<!doctype\s|<\s*\/?(?:html|head|body)(?:[\s/>])/i.test(html))
    return "预览需要 HTML 片段，不能包含完整页面外壳。";

  const pending: DefaultTreeAdapterMap["node"][] = [
    ...parseFragment(html).childNodes,
  ];
  while (pending.length) {
    const node = pending.pop()!;
    if (
      "tagName" in node &&
      (FORBIDDEN_TAGS.has(node.tagName) ||
        (node.tagName === "script" &&
          node.attrs.some((attr) => attr.name === "src")))
    )
      return "预览须自包含，不能嵌入外部页面或加载外部脚本。";
    if ("childNodes" in node) pending.push(...node.childNodes);
    if ("content" in node) pending.push(node.content);
  }
  return undefined;
}

const referenceSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => !value.includes("\0")),
    title: z.string().trim().min(1).max(250).optional(),
    mode: z.literal("wide").optional(),
  })
  .strict();

/** Recognize the actual visualize skill output, while retaining existing inline replies. */
export function parseVisualization(
  content: string,
): VisualizationDeclaration | null {
  if (
    !hasVisualization(content) ||
    Buffer.byteLength(content) > MAX_REPLY_BYTES
  )
    return null;
  const blocks = visualizationBlocks(content);
  const first = blocks[0];
  if (!first) return null;
  const position = { start: first.start, end: first.end };
  if (blocks.length > 1)
    return { ...position, error: "每条回复只能包含一个交互预览，请重新生成。" };
  if (first.kind === "reference") {
    try {
      const reference = referenceSchema.parse(JSON.parse(first.payload));
      return {
        ...position,
        sourcePath: reference.path,
        ...(reference.title ? { title: reference.title } : {}),
        ...(reference.mode ? { mode: reference.mode } : {}),
      };
    } catch {
      return { ...position, error: "预览引用格式不正确，请重新生成。" };
    }
  }
  const html = first.payload.trim();
  const error = fragmentError(html);
  return { ...position, ...(error ? { error } : { html }) };
}

export const VISUALIZATION_AUTHORING_INSTRUCTIONS = `Inline previews support visualize{"path":"/workspace/demo.html","mode":"wide"} (optional title). Use the visualize skill: one self-contained HTML fragment, ≤1 MB, inside authorized roots; no CDN/network or host-only APIs.`;
