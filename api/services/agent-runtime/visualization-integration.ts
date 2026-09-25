import { createHash } from "node:crypto";
import { agentRuntimeStore as store } from "./session-store.js";
import type { AgentRuntimeMessage } from "./contracts.js";
import { parseVisualization, fragmentError } from "./visualization-manifest.js";
import { hasVisualization, visualizationBlocks } from "./visualization-protocol.js";
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

export const GOAL_PREVIEW_MARKER = "[交互预览]";

/** Reuse validated, persisted snapshots only; never reopen source paths. */
export function persistedVisualizationAppendix(
  messages: AgentRuntimeMessage[],
  runIds: ReadonlySet<string>,
): { content: string; visualizations: InlineVisualizationMetadata[] } {
  let content = "";
  let bytes = 0;
  const visualizations: InlineVisualizationMetadata[] = [];
  for (const message of messages) {
    if (
      message.role !== "assistant" || !message.runId ||
      !runIds.has(message.runId) || message.metadata.partial ||
      message.metadata.source !== "inline_visualization" ||
      visualizations.length >= 8
    ) continue;
    const value = message.metadata.visualization;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const preview = value as Record<string, unknown>;
    if (
      !Number.isInteger(preview.start) || !Number.isInteger(preview.end) ||
      !visualizationBlocks(message.content).some(
        (block) => block.complete && block.start === preview.start && block.end === preview.end,
      ) || typeof preview.id !== "string" || !preview.id ||
      (typeof preview.html !== "string" && typeof preview.error !== "string") ||
      (typeof preview.html === "string" && (!preview.html.trim() || fragmentError(preview.html)))
    ) continue;
    const size = typeof preview.html === "string" ? Buffer.byteLength(preview.html) : 0;
    if (size > 1_000_000 || bytes + size > 4_000_000) continue;
    bytes += size;
    content += `\n\n${GOAL_PREVIEW_MARKER}`;
    visualizations.push({
      id: `goal-final:${message.id}`,
      ...(typeof preview.html === "string" ? { html: preview.html } : {}),
      ...(typeof preview.error === "string" ? { error: preview.error.slice(0, 300) } : {}),
      ...(typeof preview.title === "string" ? { title: preview.title.slice(0, 250) } : {}),
      ...(preview.mode === "wide" ? { mode: "wide" } : {}),
      start: content.length - GOAL_PREVIEW_MARKER.length,
      end: content.length,
    });
  }
  return { content, visualizations };
}

/** Resolve one fragment once, then render from metadata only. No compilation or jobs.
 * Once the assistant message exists, snapshotting is deliberately non-cancellable. */
export function persistInlineVisualization(
  message: AgentRuntimeMessage,
  _signal?: AbortSignal,
): void {
  if (
    message.role !== "assistant" ||
    message.metadata.partial ||
    message.metadata.type === "thinking" ||
    message.metadata.kind === "thought"
  )
    return;
  if (!hasVisualization(message.content)) return;
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
