import { fromMarkdown } from "mdast-util-from-markdown";
import type { AgentRuntimeMessage } from "../../../lib/api/agentRuntime";
import type { InlineVisualizationReference } from "../visualizations/InlineVisualization";
export type { InlineVisualizationReference } from "../visualizations/InlineVisualization";

type ReplyPart =
  | { type: "text"; content: string; messageId: string }
  | {
      type: "visualization";
      reference: InlineVisualizationReference;
      messageId: string;
    };

/** Never expose large executable source while an assistant reply is streaming. */
export function hideVisualizationSource(
  content: string,
  pending = false,
): string {
  if (!content.includes("synax-visualize")) return content;
  const blocks = fromMarkdown(content).children.filter(
    (node) =>
      node.type === "code" && node.lang === "synax-visualize" && node.position,
  );
  let text = content;
  for (const block of blocks.reverse()) {
    text =
      text.slice(0, block.position!.start.offset) +
      (pending ? "正在生成交互预览…" : "交互预览未生成，请让助手重新生成。") +
      text.slice(block.position!.end.offset);
  }
  return text;
}

export function visualizationReplyParts(
  message: AgentRuntimeMessage,
): ReplyPart[] {
  const text = (content: string): ReplyPart[] =>
    content.trim() ? [{ type: "text", content, messageId: message.id }] : [];
  if (message.role !== "assistant") return text(message.content);
  const fallback = () => text(hideVisualizationSource(message.content));
  if (
    message.metadata.partial ||
    message.metadata.source !== "inline_visualization"
  )
    return fallback();
  const value = message.metadata.visualization;
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fallback();
  const item = value as Record<string, unknown>;
  if (
    typeof item.id !== "string" ||
    !item.id ||
    (typeof item.html !== "string" && typeof item.error !== "string") ||
    !Number.isInteger(item.start) ||
    !Number.isInteger(item.end)
  )
    return fallback();
  const start = item.start as number,
    end = item.end as number;
  if (start < 0 || end <= start || end > message.content.length)
    return fallback();
  const reference: InlineVisualizationReference = {
    id: item.id,
    ...(typeof item.html === "string" &&
    new TextEncoder().encode(item.html).length <= 1_000_000
      ? { html: item.html }
      : {}),
    ...(typeof item.error === "string"
      ? { error: item.error.slice(0, 300) }
      : {}),
  };
  if (!reference.html && !reference.error) return fallback();
  return [
    ...text(hideVisualizationSource(message.content.slice(0, start))),
    { type: "visualization", reference, messageId: message.id },
    ...text(hideVisualizationSource(message.content.slice(end))),
  ];
}
