import { fromMarkdown } from "mdast-util-from-markdown";

export const VISUALIZATION_REFERENCE_START = "\uE200visualize\uE202";
const END = "\uE201";
export interface VisualizationBlock {
  kind: "fragment" | "reference";
  payload: string;
  start: number;
  end: number;
  complete: boolean;
}
export function hasVisualization(content: string): boolean {
  return (
    content.includes("synax-visualize") ||
    content.includes(VISUALIZATION_REFERENCE_START)
  );
}

/** Shared by finalization and streaming display; never executes or reads a path. */
export function visualizationBlocks(
  content: string,
  includeIncomplete = false,
): VisualizationBlock[] {
  if (!hasVisualization(content)) return [];
  const lines = content.split(/\r?\n/);
  const blocks: VisualizationBlock[] = [];
  for (const node of fromMarkdown(content).children) {
    if (!node.position) continue;
    const { start, end } = node.position;
    if (node.type === "code" && node.lang === "synax-visualize" && !node.meta) {
      const opening = /^ {0,3}(`{3,}|~{3,})synax-visualize\s*$/.exec(
        lines[start.line - 1],
      );
      if (!opening) continue;
      const complete =
        end.line > start.line &&
        new RegExp(`^ {0,3}${opening[1][0]}{${opening[1].length},}\\s*$`).test(
          lines[end.line - 1],
        );
      if (complete || includeIncomplete)
        blocks.push({
          kind: "fragment",
          payload: node.value,
          start: start.offset!,
          end: end.offset!,
          complete,
        });
    }
    if (node.type !== "paragraph") continue;
    const raw = content.slice(start.offset, end.offset);
    for (const match of raw.matchAll(
      /^ {0,3}\uE200visualize\uE202([^\r\n]*)[\t ]*$/gm,
    )) {
      const from = start.offset! + match.index!;
      const to = from + match[0].length;
      // Multiline inline code, links and emphasis can enclose an apparent standalone line.
      if (
        node.children.some(
          (child) =>
            child.type !== "text" &&
            child.position &&
            child.position.start.offset! <= from &&
            child.position.end.offset! >= to,
        )
      )
        continue;
      const body = match[1].trimEnd();
      const complete = body.endsWith(END);
      if (!complete && !includeIncomplete) continue;
      blocks.push({
        kind: "reference",
        payload: complete ? body.slice(0, -END.length) : body,
        start: from,
        end: to,
        complete,
      });
    }
  }
  return blocks.sort((a, b) => a.start - b.start);
}
