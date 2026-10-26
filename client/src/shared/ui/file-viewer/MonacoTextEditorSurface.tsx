import { useEffect, useRef, useState } from "react";
import { applyMonacoTheme, monaco, languageForPath } from "./monacoRuntime";
import type { MonacoTextEditorProps } from "./MonacoTextEditor";

export default function MonacoTextEditorSurface(props: MonacoTextEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const instance = useRef<{
    model: monaco.editor.ITextModel;
    editor: monaco.editor.IStandaloneCodeEditor;
    update(): void;
  } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true,
      updating = false,
      changed = false;
    let model: monaco.editor.ITextModel | undefined,
      editor: monaco.editor.IStandaloneCodeEditor | undefined;
    let lastSent = latest.current.content;
    let frame = 0;
    let observer: ResizeObserver | undefined,
      theme: MutationObserver | undefined;
    let onFindShortcut: ((event: KeyboardEvent) => void) | undefined;
    const disposables: monaco.IDisposable[] = [];
    const flush = () => {
      if (!model || !changed || !latest.current.onChange) return;
      changed = false;
      lastSent = model.getValue();
      latest.current.onChange(lastSent);
    };
    const layout = () => {
      if (!alive || document.visibilityState === "hidden" || frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        editor?.layout();
      });
    };
    const visibility = () => {
      if (document.visibilityState === "hidden") {
        flush();
        cancelAnimationFrame(frame);
        frame = 0;
      } else layout();
    };
    const update = () => {
      if (!editor || !model) return;
      editor.updateOptions({ readOnly: !latest.current.onChange });
      // Echoes of a flushed edit must never reset the model's undo history.
      if (latest.current.content === lastSent) return;
      if (changed) {
        flush();
        return;
      }
      lastSent = latest.current.content;
      if (model.getValue() === lastSent) return;
      const view = editor.saveViewState();
      updating = true;
      try {
        model.setValue(lastSent);
      } finally {
        updating = false;
      }
      if (view) editor.restoreViewState(view);
    };
    latest.current.registerFlush?.(flush);
    const initialize = async () => {
      let language = "plaintext";
      if (
        !latest.current.plainText &&
        latest.current.content.length <= 4 * 1024 * 1024
      ) {
        try {
          language = await languageForPath(latest.current.path);
        } catch {
          /* a text editor remains usable without its tokenizer */
        }
      }
      if (!alive || !host.current) return;
      lastSent = latest.current.content;
      model = monaco.editor.createModel(
        lastSent,
        language,
        monaco.Uri.from({
          scheme: "synax-text",
          authority: crypto.randomUUID(),
          path: `/${latest.current.path}`,
        }),
      );
      editor = monaco.editor.create(host.current, {
        model,
        readOnly: !latest.current.onChange,
        automaticLayout: false,
        minimap: { enabled: false },
        wordWrap: "off",
        scrollBeyondLastLine: false,
        smoothScrolling: false,
        largeFileOptimizations: true,
        maxTokenizationLineLength: 20_000,
        folding: lastSent.length <= 4 * 1024 * 1024,
        fontFamily: "Liberation Mono, SFMono-Regular, Consolas, monospace",
        fontSize: 13,
        lineHeight: 21,
        ariaLabel:
          latest.current.ariaLabel ||
          `${latest.current.onChange ? "编辑文件" : "查看文件"} ${latest.current.path}`,
      });
      instance.current = { model, editor, update };
      const toggleFind = () => {
        const controller = editor?.getContribution?.(
          "editor.contrib.findController",
        ) as
          | {
              getState?: () => { isRevealed?: boolean };
              closeFindWidget?: () => void;
            }
          | undefined;
        const state = controller?.getState?.();
        if (state?.isRevealed) {
          controller?.closeFindWidget?.();
        } else {
          editor?.trigger(
            "keyboard",
            "editor.action.startFindReplaceAction",
            null,
          );
        }
      };
      latest.current.registerFindToggle?.(toggleFind);
      onFindShortcut = (event: KeyboardEvent) => {
        if (
          !(event.metaKey || event.ctrlKey) ||
          event.key.toLowerCase() !== "f"
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        toggleFind();
      };
      host.current.addEventListener("keydown", onFindShortcut, true);
      disposables.push(
        model.onDidChangeContent(() => {
          if (updating || !latest.current.onChange) return;
          if (!changed) latest.current.onDirty?.();
          // Keep edits in the piece-tree model. Serialize the full file only at
          // blur/save/tab-close boundaries, never once per key or timer tick.
          changed = true;
        }),
      );
      disposables.push(editor.onDidBlurEditorWidget(flush));
      disposables.push(
        editor.addAction({
          id: "synax-save-file",
          label: "保存文件",
          keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
          run: () => {
            flush();
            latest.current.onSave?.();
          },
        }),
      );
      const applyTheme = () => {
        applyMonacoTheme(host.current ?? undefined);
      };
      applyTheme();
      theme = new MutationObserver(applyTheme);
      theme.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class", "data-theme", "data-color-scheme", "style"],
      });
      if (typeof ResizeObserver !== "undefined") {
        observer = new ResizeObserver(layout);
        observer.observe(host.current);
      } else window.addEventListener("resize", layout);
      document.addEventListener("visibilitychange", visibility);
      layout();
    };
    void initialize().catch((cause) => {
      if (alive)
        setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => {
      flush();
      alive = false;
      instance.current = null;
      latest.current.registerFlush?.(null);
      latest.current.registerFindToggle?.(null);
      cancelAnimationFrame(frame);
      observer?.disconnect();
      theme?.disconnect();
      if (onFindShortcut) {
        host.current?.removeEventListener("keydown", onFindShortcut, true);
      }
      window.removeEventListener("resize", layout);
      document.removeEventListener("visibilitychange", visibility);
      for (const disposable of disposables) disposable.dispose();
      editor?.dispose();
      model?.dispose();
    };
  }, []);
  useEffect(() => {
    instance.current?.update();
  }, [props.content, props.onChange]);
  return (
    <div className="synax-monaco-text-container">
      {error && <p role="alert">{error}</p>}
      <div ref={host} className="synax-monaco-text-editor" />
    </div>
  );
}
