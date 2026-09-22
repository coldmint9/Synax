import { createHash } from "node:crypto";
import { agentRuntimeStore as store } from "./session-store.js";
import type { AgentRuntimeMessage } from "./contracts.js";
import { parseVisualization } from "./visualization-manifest.js";

export interface InlineVisualizationMetadata {
  id: string;
  html?: string;
  error?: string;
  /** Original message offsets keep the preview between the surrounding paragraphs. */
  start: number;
  end: number;
}

/** No source reads, builds or jobs: freeze the fragment on its existing message once. */
export function persistInlineVisualization(
  message: AgentRuntimeMessage,
  signal?: AbortSignal,
): void {
  if (
    message.role !== "assistant" ||
    message.metadata.partial ||
    message.metadata.type === "thinking" ||
    message.metadata.kind === "thought"
  )
    return;
  if (!message.content.includes("synax-visualize")) return;
  signal?.throwIfAborted();
  const persisted = store.getMessage(message.sessionId, message.id);
  if (
    !persisted ||
    persisted.role !== "assistant" ||
    persisted.content !== message.content ||
    persisted.metadata.partial
  )
    return;
  if (persisted.metadata.source === "inline_visualization") {
    message.metadata = persisted.metadata;
    return;
  }
  const declaration = parseVisualization(message.content);
  if (!declaration) return;
  const hash = createHash("sha256")
    .update(message.content)
    .digest("hex")
    .slice(0, 16);
  const updated = store.attachVisualizationMetadata(message, {
    source: "inline_visualization",
    visualizationOrigin: message.metadata.source,
    visualization: {
      id: `${message.id}:${hash}`,
      ...declaration,
    } satisfies InlineVisualizationMetadata,
  });
  if (updated) message.metadata = updated.metadata;
}
