import {
  Dialog,
  DialogBackdrop,
  DialogPanel,
  DialogTitle,
} from "@headlessui/react";
import { Check, Download, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { currentTheme, InteractiveFrame, interactiveDocument } from "../../shared/interactive";
import { saveHtmlFileToUserLocation } from "../../shared/lib/save-html-file";
import { useNotificationStore } from "../../shared/state/notificationStore";
import { VisualizationLoading } from "./VisualizationLoading";
import "./visualizations.css";
import type { InlineVisualizationReference } from "./InlineVisualization";

/**
 * Full-screen viewer for one inline preview.
 *
 * The transcript keeps its own frame; this is a second sandboxed instance with
 * its own token, so opening the viewer never re-parents or restarts the chat
 * preview. Escape, backdrop dismissal and focus restore come from the dialog
 * primitive.
 */
export function VisualizationViewer({
  visualization,
  onClose,
}: {
  visualization: InlineVisualizationReference;
  onClose: () => void;
}) {
  const [error, setError] = useState(visualization.error ?? "");
  const [ready, setReady] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState(false);
  const exportTimer = useRef<number>(undefined);
  const { id, html } = visualization;
  const label = visualization.title || "交互预览";
  // The exported file is standalone, so it carries its own runtime identity.
  const exportToken = useMemo(
    () => globalThis.crypto?.randomUUID?.() ?? `export-${Date.now()}`,
    [],
  );

  useEffect(
    () => () => {
      if (exportTimer.current) window.clearTimeout(exportTimer.current);
    },
    [],
  );

  async function exportFile() {
    if (!html || exporting) return;
    setExporting(true);
    try {
      const documentHtml = interactiveDocument(html, {
        id,
        token: exportToken,
        theme: currentTheme(),
        locale: document.documentElement.lang || "zh-CN",
      });
      const outcome = await saveHtmlFileToUserLocation({
        title: label,
        html: documentHtml,
      });
      if (outcome !== "saved") return;
      setExported(true);
      exportTimer.current = window.setTimeout(() => setExported(false), 1800);
    } catch (cause) {
      useNotificationStore.getState().push({
        type: "error",
        message: "导出失败",
        detail: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setExporting(false);
    }
  }

  return (
    <Dialog open onClose={onClose} className="visualization-viewer">
      <DialogBackdrop className="visualization-viewer__backdrop" />
      <div className="visualization-viewer__viewport">
        <DialogPanel className="visualization-viewer__panel">
          <header className="visualization-viewer__bar">
            <DialogTitle className="visualization-viewer__title">
              {label}
            </DialogTitle>
            <button
              type="button"
              className="visualization-viewer__action"
              onClick={() => void exportFile()}
              disabled={!html || exporting}
              aria-label="导出为 HTML 文件"
              title="导出为 HTML 文件"
            >
              {exported ? (
                <Check size={16} aria-hidden="true" />
              ) : (
                <Download size={16} aria-hidden="true" />
              )}
            </button>
            <button
              autoFocus
              type="button"
              className="visualization-viewer__close"
              onClick={onClose}
              aria-label="关闭查看器"
              title="关闭 (Esc)"
            >
              <X size={16} aria-hidden="true" />
            </button>
            <span className="sr-only" aria-live="polite" data-export-status="">
              {exported ? "已导出为 HTML 文件" : ""}
            </span>
          </header>
          <div className="visualization-viewer__stage">
            {error ? (
              <div
                className="inline-visualization__error"
                data-error-toast="off"
                role="alert"
              >
                <strong>预览不可用</strong>
                <span>{error}</span>
              </div>
            ) : (
              <>
                <InteractiveFrame
                  id={id}
                  html={html ?? ""}
                  title={label}
                  className="visualization-viewer__frame-host"
                  maxHeight={20_000}
                  onReady={() => setReady(true)}
                  onError={setError}
                />
                {!ready && <VisualizationLoading />}
              </>
            )}
          </div>
        </DialogPanel>
      </div>
    </Dialog>
  );
}
