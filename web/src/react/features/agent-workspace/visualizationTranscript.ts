import {
  hasVisualization,
  visualizationBlocks,
} from "../../../../../api/services/agent-runtime/visualization-protocol";
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
  if (!hasVisualization(content)) return content;
  const blocks = visualizationBlocks(content, true);
  let text = content;
  for (const block of blocks.reverse()) {
    text =
      text.slice(0, block.start) +
      (pending ? "正在生成交互预览…" : "交互预览未生成，请让助手重新生成。") +
      text.slice(block.end);
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
  if (message.metadata.purpose === "work_result" &&
      Array.isArray(message.metadata.visualizations) &&
      !message.metadata.partial) {
    const result: ReplyPart[] = [];
    let cursor = 0;
    for (const value of message.metadata.visualizations) {
      if (!value || typeof value !== "object" || Array.isArray(value)) return fallback();
      const item = value as Record<string, unknown>;
      const html = typeof item.html === "string" ? item.html : undefined;
      if (typeof item.id !== "string" || !item.id ||
          (!html && typeof item.error !== "string") ||
          (html !== undefined && !html.trim()) ||
          new TextEncoder().encode(html).length > 1_000_000 ||
          !Number.isInteger(item.start) || !Number.isInteger(item.end)) return fallback();
      const start = item.start as number, end = item.end as number;
      if (start < cursor || end <= start || end > message.content.length ||
          message.content.slice(start, end) !== "[交互预览]") return fallback();
      result.push(...text(hideVisualizationSource(message.content.slice(cursor, start))));
      result.push({ type: "visualization", messageId: message.id, reference: {
        id: item.id,
        html,
        ...(typeof item.title === "string" ? { title: item.title.slice(0, 250) } : {}),
        ...(item.mode === "wide" ? { mode: "wide" as const } : {}),
      } });
      cursor = end;
    }
    return [...result, ...text(hideVisualizationSource(message.content.slice(cursor)))];
  }
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
    ...(typeof item.title === "string"
      ? { title: item.title.slice(0, 250) }
      : {}),
    ...(item.mode === "wide" ? { mode: "wide" as const } : {}),
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
