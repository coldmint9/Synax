import { useState } from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import { InteractiveFrame } from "../../shared/interactive";
import { VisualizationLoading } from "./VisualizationLoading";
import { VisualizationViewer } from "./VisualizationViewer";
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

/** Chat-specific shell: collapse, viewer entry, copy, loading art and layout. */
function VisualizationInstance({
  visualization,
}: {
  visualization: InlineVisualizationReference;
}) {
  const [error, setError] = useState(visualization.error ?? "");
  const [ready, setReady] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [viewing, setViewing] = useState(false);
  const { id, html, title, mode } = visualization;
  // A saved snapshot can be missing without carrying an error. Never leave the
  // preview spinning: say what happened and how to recover.
  const missing = !html && !error;
  const failed = Boolean(error) || missing;
  const label = title || "交互预览";

  // Collapsed previews keep their place in the transcript as one small card.
  // The blurred artwork stands in for the hidden document; clicking restores
  // the live frame.
  if (collapsed) {
    return (
      <div
        className="inline-visualization"
        data-visualization-id={id}
        data-collapsed="true"
      >
        <button
          type="button"
          className="inline-visualization__collapsed"
          onClick={() => setCollapsed(false)}
          aria-label={`展开预览：${label}`}
          title="展开预览"
        >
          <span className="inline-visualization__collapsed-thumb" aria-hidden="true">
            <span className="inline-visualization__collapsed-art" />
          </span>
          <span className="inline-visualization__collapsed-text">
            <span className="inline-visualization__collapsed-title">{label}</span>
            <span className="inline-visualization__collapsed-hint">
              已折叠 · 点击展开
            </span>
          </span>
        </button>
      </div>
    );
  }

  return (
    <div
      className="inline-visualization"
      data-visualization-id={id}
      data-mode={mode}
      aria-busy={!ready && !failed}
    >
      {failed ? (
        <div className="inline-visualization__error" data-error-toast="off" role="alert">
          <strong>预览不可用</strong>
          <span>{error || "预览内容缺失，请让助手重新生成。"}</span>
        </div>
      ) : (
        <div className="inline-visualization__surface">
          <InteractiveFrame
            id={id}
            html={html!}
            title={label}
            className="inline-visualization__frame-host"
            onReady={() => setReady(true)}
            onError={setError}
          />
          {!ready && <VisualizationLoading compact />}
          <div
            className="inline-visualization__controls"
            role="group"
            aria-label="预览操作"
          >
            <button
              type="button"
              className="inline-visualization__control"
              onClick={() => setCollapsed(true)}
              aria-label="折叠预览"
              title="折叠预览"
            >
              <Minimize2 size={14} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="inline-visualization__control"
              onClick={() => setViewing(true)}
              aria-label="在查看器中打开预览"
              title="在查看器中打开"
            >
              <Maximize2 size={14} aria-hidden="true" />
            </button>
          </div>
        </div>
      )}
      {viewing && (
        <VisualizationViewer
          visualization={{
            id,
            html: html!,
            title: label,
            ...(mode ? { mode } : {}),
          }}
          onClose={() => setViewing(false)}
        />
      )}
    </div>
  );
}
