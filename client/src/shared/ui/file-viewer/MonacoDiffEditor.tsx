import { useEffect, useRef, useState } from "react";
import { applyMonacoTheme, languageForPath, monaco } from "./monacoRuntime";
import "./fileViewer.css";

export interface MonacoDiffEditorProps {
  path: string;
  original: string;
  modified: string;
  ariaLabel?: string;
}

/** Read-only Monaco diff surface shared by Git changes and future review views. */
export default function MonacoDiffEditor({
  path,
  original,
  modified,
  ariaLabel,
}: MonacoDiffEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    let frame = 0;
    let observer: ResizeObserver | undefined;
    let themeObserver: MutationObserver | undefined;
    let diffEditor: monaco.editor.IStandaloneDiffEditor | undefined;
    let originalModel: monaco.editor.ITextModel | undefined;
    let modifiedModel: monaco.editor.ITextModel | undefined;
    const disposables: monaco.IDisposable[] = [];

    const layout = () => {
      if (!alive || document.visibilityState === "hidden" || frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        diffEditor?.layout();
      });
    };

    const applyTheme = () => {
      applyMonacoTheme(host.current ?? undefined);
    };

    const initialize = async () => {
      let language = "plaintext";
      try {
        language = await languageForPath(path);
      } catch {
        /* Diff browsing remains useful without an optional tokenizer. */
      }
      if (!alive || !host.current) return;

      const identity = crypto.randomUUID();
      originalModel = monaco.editor.createModel(
        original,
        language,
        monaco.Uri.from({
          scheme: "synax-diff-original",
          authority: identity,
          path: `/${path}`,
        }),
      );
      modifiedModel = monaco.editor.createModel(
        modified,
        language,
        monaco.Uri.from({
          scheme: "synax-diff-modified",
          authority: identity,
          path: `/${path}`,
        }),
      );
      diffEditor = monaco.editor.createDiffEditor(host.current, {
        readOnly: true,
        originalEditable: false,
        automaticLayout: false,
        minimap: { enabled: false },
        wordWrap: "off",
        scrollBeyondLastLine: false,
        smoothScrolling: false,
        renderSideBySide: true,
        renderIndicators: true,
        renderOverviewRuler: true,
        diffAlgorithm: "advanced",
        hideUnchangedRegions: { enabled: false },
        fontFamily: "Liberation Mono, SFMono-Regular, Consolas, monospace",
        fontSize: 13,
        lineHeight: 21,
        padding: { top: 8, bottom: 8 },
        ariaLabel: ariaLabel ?? `查看 ${path} 的 Git diff`,
      });
      diffEditor.setModel({ original: originalModel, modified: modifiedModel });
      applyTheme();
      themeObserver = new MutationObserver(applyTheme);
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class", "data-theme", "data-color-scheme", "style"],
      });
      if (typeof ResizeObserver !== "undefined") {
        observer = new ResizeObserver(layout);
        observer.observe(host.current);
      } else {
        window.addEventListener("resize", layout);
      }
      document.addEventListener("visibilitychange", layout);
      layout();
    };

    void initialize().catch((cause) => {
      if (alive) setError(cause instanceof Error ? cause.message : String(cause));
    });

    return () => {
      alive = false;
      cancelAnimationFrame(frame);
      observer?.disconnect();
      themeObserver?.disconnect();
      window.removeEventListener("resize", layout);
      document.removeEventListener("visibilitychange", layout);
      for (const disposable of disposables) disposable.dispose();
      diffEditor?.dispose();
      originalModel?.dispose();
      modifiedModel?.dispose();
    };
  }, [ariaLabel, modified, original, path]);

  return (
    <div className="synax-monaco-diff-container">
      {error && <p role="alert">{error}</p>}
      <div ref={host} className="synax-monaco-diff-editor" />
    </div>
  );
}
