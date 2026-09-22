import { fromMarkdown } from "mdast-util-from-markdown";
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
  error?: string;
  start: number;
  end: number;
}

/** Syntax validation is not a sandbox. The renderer enforces CSP and an opaque origin. */
function fragmentError(html: string): string | undefined {
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

/** Only complete top-level fences in a successful assistant reply are declarations. */
export function parseVisualization(
  content: string,
): VisualizationDeclaration | null {
  if (
    !content.includes("synax-visualize") ||
    Buffer.byteLength(content) > MAX_REPLY_BYTES
  )
    return null;
  const lines = content.split(/\r?\n/);
  const blocks = fromMarkdown(content).children.filter((node) => {
    if (
      node.type !== "code" ||
      node.lang !== "synax-visualize" ||
      node.meta ||
      !node.position
    )
      return false;
    const { start, end } = node.position;
    const opening = /^ {0,3}(`{3,}|~{3,})synax-visualize\s*$/.exec(
      lines[start.line - 1],
    );
    return (
      opening &&
      end.line > start.line &&
      new RegExp(`^ {0,3}${opening[1][0]}{${opening[1].length},}\\s*$`).test(
        lines[end.line - 1],
      )
    );
  });
  const first = blocks[0];
  if (!first || first.type !== "code") return null;
  const html = first.value.trim();
  const error =
    blocks.length > 1
      ? "每条回复只能包含一个交互预览，请重新生成。"
      : fragmentError(html);
  return {
    ...(error ? { error } : { html }),
    start: first.position!.start.offset!,
    end: first.position!.end.offset!,
  };
}

// Keep detailed design guidance in the discoverable skill, not duplicated in every turn.
export const VISUALIZATION_AUTHORING_INSTRUCTIONS = `For a requested inline prototype or visualization, load the builtin visualize skill when available. Emit at most one complete top-level synax-visualize fenced block containing a self-contained HTML/CSS/JavaScript fragment. No file reference, React compilation or publishing step. Do not use this protocol for ordinary source-code examples. The host renders only successful completed assistant replies in an isolated, offline preview.`;
