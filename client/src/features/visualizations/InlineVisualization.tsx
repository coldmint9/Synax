import { useState } from "react";
import { InteractiveFrame } from "../../shared/interactive";
import { VisualizationLoading } from "./VisualizationLoading";
import "./visualizations.css";
import type { AgentRuntimeMessage } from "../../adapters/transport/agentRuntime";

export interface InlineVisualizationReference {
  id: string;
  html?: string;
  title?: string;
  mode?: "wide";
  error?: string;
  /** A bounded history projection whose saved preview must be loaded on demand. */
  historyMessage?: AgentRuntimeMessage;
}

export function InlineVisualization({
  visualization,
}: {
  visualization: InlineVisualizationReference;
}) {
  return (
    <VisualizationInstance
      key={visualization.id}
      visualization={visualization}
    />
  );
}

/** Chat-specific shell: copy, loading art and layout around the shared container. */
function VisualizationInstance({
  visualization,
}: {
  visualization: InlineVisualizationReference;
}) {
  const [error, setError] = useState(visualization.error ?? "");
  const [ready, setReady] = useState(false);
  const { id, html, title, mode } = visualization;
  // A saved snapshot can be missing without carrying an error. Never leave the
  // preview spinning: say what happened and how to recover.
  const missing = !html && !error;
  const failed = Boolean(error) || missing;

  return (
    <div
      className="inline-visualization"
      data-visualization-id={id}
      data-mode={mode}
      aria-busy={!ready && !failed}
    >
      {failed ? (
        <div className="inline-visualization__error" role="alert">
          <strong>预览不可用</strong>
          <span>{error || "预览内容缺失，请让助手重新生成。"}</span>
        </div>
      ) : (
        <div className="inline-visualization__surface">
          <InteractiveFrame
            id={id}
            html={html!}
            title={title || "交互预览"}
            className="inline-visualization__frame-host"
            onReady={() => setReady(true)}
            onError={setError}
          />
          {!ready && <VisualizationLoading compact />}
        </div>
      )}
    </div>
  );
}
