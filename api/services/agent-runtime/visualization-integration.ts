import { createHash } from "node:crypto";
import { agentRuntimeStore as store } from "./session-store.js";
import type { AgentRuntimeMessage } from "./contracts.js";
import { parseVisualization, fragmentError } from "./visualization-manifest.js";
import { hasVisualization } from "./visualization-protocol.js";
import {
  readVisualizationFile,
  visualizationReadError,
} from "./visualization-file.js";
import { resolveSessionWorkspaceRoots } from "./tools/workspace.js";
import { workspaceRootHostPath } from "../project-workspace.js";

export interface InlineVisualizationMetadata {
  id: string;
  html?: string;
  title?: string;
  mode?: "wide";
  error?: string;
  /** Original message offsets keep the preview between the surrounding paragraphs. */
  start: number;
  end: number;
}

/** Resolve one fragment once, then render from metadata only. No compilation or jobs. */
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
  if (!hasVisualization(message.content)) return;
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
  const { sourcePath, ...preview } = declaration;
  if (sourcePath && !preview.error) {
    try {
      const session = store.getSession(message.sessionId);
      const roots = resolveSessionWorkspaceRoots(
        message.sessionId,
        session.projectId,
      )
        .filter((root) => root.status === "available")
        .map(workspaceRootHostPath);
      const html = readVisualizationFile(sourcePath, roots);
      const error = fragmentError(html);
      if (error) preview.error = error;
      else preview.html = html;
    } catch (error) {
      preview.error = visualizationReadError(error);
    }
  }
  signal?.throwIfAborted();
  const hash = createHash("sha256")
    .update(message.content)
    .digest("hex")
    .slice(0, 16);
  const updated = store.attachVisualizationMetadata(message, {
    source: "inline_visualization",
    visualizationOrigin: message.metadata.source,
    visualization: {
      id: `${message.id}:${hash}`,
      ...preview,
    } satisfies InlineVisualizationMetadata,
  });
  if (updated) message.metadata = updated.metadata;
}

/** Repair missed declarations on conversation reload, only for proven successful runs. */
export function hydrateCompletedVisualizations(
  messages: AgentRuntimeMessage[],
): void {
  for (const message of messages) {
    if (
      message.role !== "assistant" ||
      message.metadata.partial ||
      message.metadata.type === "thinking" ||
      message.metadata.kind === "thought" ||
      message.metadata.source === "inline_visualization" ||
      !message.runId ||
      !hasVisualization(message.content)
    )
      continue;
    try {
      const run = store.getRun(message.runId);
      if (run.sessionId !== message.sessionId || run.status !== "completed")
        continue;
    } catch {
      continue;
    }
    persistInlineVisualization(message);
  }
}
