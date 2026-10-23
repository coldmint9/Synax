import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, LoaderCircle, X } from "lucide-react";
import { Dialog, DialogPanel, DialogTitle } from "../ui/Dialog";
import type { MergeFileViewerProps } from "./MergeFileViewer";
import { languageForPath, monaco } from "./monacoRuntime";
import {
  mapMergeLine,
  type MergeAnalysis,
  type MergeAnalysisInput,
} from "./mergeWorkbenchAnalysis";
import "./fileViewer.css";

type Side = "target" | "result" | "source";
type Editors = Record<Side, monaco.editor.IStandaloneCodeEditor>;
type Models = Record<Side, monaco.editor.ITextModel>;
interface WorkbenchHandle {
  flush(): Promise<boolean>;
  navigate(direction: -1 | 1): void;
  refresh(): void;
  draft(): { content: string; revision: string } | undefined;
}

const sides: Side[] = ["target", "result", "source"];
const NORMAL_DOCUMENT_BYTES = 4 * 1024 * 1024;

function BaseDocument({ text, path }: { text: string; path: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return;
    const model = monaco.editor.createModel(text, "plaintext");
    const editor = monaco.editor.create(host.current, {
      model,
      readOnly: true,
      automaticLayout: false,
      minimap: { enabled: false },
      wordWrap: "off",
      scrollBeyondLastLine: false,
      fontSize: 12,
      lineHeight: 20,
      ariaLabel: `共同祖先 ${path}`,
    });
    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0;
          editor.layout();
        });
    });
    observer.observe(host.current);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      editor.dispose();
      model.dispose();
    };
  }, [text, path]);
  return <div className="synax-monaco-base-document" ref={host} />;
}

/** The model owns document and undo state. React owns only small UI metadata. */
export default function MonacoMergeWorkbench(props: MergeFileViewerProps) {
  const latest = useRef(props);
  latest.current = props;
  const root = useRef<HTMLDivElement>(null);
  const target = useRef<HTMLDivElement>(null);
  const result = useRef<HTMLDivElement>(null);
  const source = useRef<HTMLDivElement>(null);
  const handle = useRef<WorkbenchHandle | null>(null);
  const dirty = useRef(false);
  const [baseOpen, setBaseOpen] = useState(false);
  const [compactSide, setCompactSide] = useState<Side>("result");
  const [closePrompt, setClosePrompt] = useState(false);
  const [structuralChoice, setStructuralChoice] = useState<
    "target" | "source" | "delete"
  >();
  const [state, setState] = useState({
    loaded: false,
    saving: false,
    dirty: false,
    stale: false,
    error: "",
    notice: "加载编辑器…",
    conflicts: 0,
    active: 0,
    degraded: false,
  });

  useEffect(() => {
    let alive = true;
    let editors: Editors | undefined;
    let models: Models | undefined;
    let analysis: MergeAnalysis | undefined;
    let markerDecorations:
      | monaco.editor.IEditorDecorationsCollection
      | undefined;
    let worker: Worker | undefined;
    let workerBusy = false;
    let queuedAnalysis = false;
    let analysisTimer: ReturnType<typeof setTimeout> | undefined;
    let workerDeadline: ReturnType<typeof setTimeout> | undefined;
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    let savePromise: Promise<boolean> | undefined;
    let resizeFrame = 0;
    let scrollFrame = 0;
    let scrollSource: Side = "result";
    let synchronizing = false;
    const expectedScroll: Partial<Record<Side, number>> = {};
    let applying = false;
    let stale = false;
    let revision = latest.current.file.revision;
    let submitted: string | undefined;
    let savedContent = latest.current.file.result;
    let activeConflict = 0;
    let observer: ResizeObserver | undefined;
    let themeObserver: MutationObserver | undefined;
    let generation = 0;
    const disposables: monaco.IDisposable[] = [];
    const instance = crypto.randomUUID();
    const set = (patch: Partial<typeof state>) => {
      if (alive) setState((previous) => ({ ...previous, ...patch }));
    };
    const markDirty = () => {
      if (!dirty.current) {
        dirty.current = true;
        set({ dirty: true, notice: "草稿待保存" });
      }
    };

    const layout = () => {
      if (document.visibilityState === "hidden") return;
      if (resizeFrame) return;
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = 0;
        if (alive && editors) for (const side of sides) editors[side].layout();
      });
    };

    const terminateWorker = () => {
      clearTimeout(workerDeadline);
      workerDeadline = undefined;
      worker?.terminate();
      worker = undefined;
      workerBusy = false;
    };
    const scheduleAnalysis = () => {
      clearTimeout(analysisTimer);
      analysisTimer = setTimeout(() => {
        analysisTimer = undefined;
        requestAnalysis();
      }, 180);
    };
    const requestAnalysis = () => {
      if (!alive || !models) return;
      if (document.visibilityState === "hidden") {
        queuedAnalysis = true;
        return;
      }
      if (workerBusy) {
        queuedAnalysis = true;
        return;
      }
      const version = models.result.getVersionId();
      const skipAlignment = sides.some(
        (side) =>
          models![side].getValueLength() > NORMAL_DOCUMENT_BYTES ||
          models![side].getLineCount() > 80_000,
      );
      const input: MergeAnalysisInput = {
        generation: ++generation,
        version,
        target: skipAlignment ? "" : models.target.getValue(),
        result: models.result.getValue(),
        source: skipAlignment ? "" : models.source.getValue(),
        skipAlignment,
      };
      const failed = () => {
        terminateWorker();
        // No synchronous diff fallback: a failed worker must not freeze the UI.
        set({ degraded: true, notice: "对齐暂不可用，仍可浏览完整文件" });
        queuedAnalysis = false;
      };
      if (!worker) {
        try {
          worker = new Worker(
            new URL("./mergeWorkbenchAnalysis.worker.ts", import.meta.url),
            { type: "module" },
          );
          worker.onerror = failed;
          worker.onmessage = (
            event: MessageEvent<{ result?: MergeAnalysis; failed?: boolean }>,
          ) => {
            clearTimeout(workerDeadline);
            workerDeadline = undefined;
            workerBusy = false;
            const next = event.data.result;
            if (
              next &&
              alive &&
              models &&
              next.generation === generation &&
              next.version === models.result.getVersionId()
            ) {
              analysis = next;
              activeConflict = Math.min(
                activeConflict,
                Math.max(0, next.conflicts.length - 1),
              );
              markerDecorations?.set(
                next.conflicts.map((range) => ({
                  range: new monaco.Range(range.start, 1, range.end, 1),
                  options: {
                    isWholeLine: true,
                    className: "synax-merge-conflict-line",
                    overviewRuler: {
                      color: "#c58a30",
                      position: monaco.editor.OverviewRulerLane.Full,
                    },
                  },
                })),
              );
              set({
                conflicts: next.conflicts.length,
                active: activeConflict,
                degraded: next.degraded,
              });
            } else if (event.data.failed) failed();
            if (queuedAnalysis && alive) {
              queuedAnalysis = false;
              requestAnalysis();
            }
          };
        } catch {
          failed();
          return;
        }
      }
      workerBusy = true;
      workerDeadline = setTimeout(failed, 1500);
      worker.postMessage(input);
    };

    const flush = async (): Promise<boolean> => {
      clearTimeout(saveTimer);
      saveTimer = undefined;
      if (savePromise) {
        const saved = await savePromise;
        return saved && dirty.current ? flush() : saved;
      }
      if (!alive || !models || !dirty.current) return true;
      if (latest.current.readOnly || stale) return false;
      const content = models.result.getValue();
      if (content === savedContent) {
        dirty.current = false;
        set({ dirty: false, notice: "已保存" });
        return true;
      }
      submitted = content;
      set({ saving: true, error: "", notice: "保存中…" });
      const operation = (async () => {
        try {
          // Autosave never decides a merge. The dedicated agent validates and stages it.
          const saved = await latest.current.onSave({
            expectedRevision: revision,
            content,
            resolve: false,
          });
          if (saved?.revision) revision = saved.revision;
          savedContent = content;
          if (!alive || !models) return true;
          const current = latest.current.file;
          if (current.result === content) revision = current.revision;
          dirty.current = models.result.getValue() !== content;
          set({
            dirty: dirty.current,
            notice: dirty.current ? "草稿待保存" : "草稿已保存",
          });
          return true;
        } catch (error) {
          set({
            error: error instanceof Error ? error.message : String(error),
            notice: "保存失败；本地草稿已保留",
          });
          return false;
        } finally {
          submitted = undefined;
          if (alive) set({ saving: false });
        }
      })();
      savePromise = operation;
      const ok = await operation;
      if (savePromise === operation) savePromise = undefined;
      return ok;
    };
    const scheduleSave = () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        saveTimer = undefined;
        void flush().then((ok) => {
          if (ok && alive && dirty.current) scheduleSave();
        });
      }, 400);
    };
    const navigate = (direction: -1 | 1) => {
      if (!editors || !analysis?.conflicts.length) return;
      activeConflict =
        (activeConflict + direction + analysis.conflicts.length) %
        analysis.conflicts.length;
      const line = analysis.conflicts[activeConflict].start;
      set({ active: activeConflict });
      editors.result.revealLineInCenter(line);
      editors.result.setPosition({ lineNumber: line, column: 1 });
      editors.result.focus();
    };
    const refresh = () => {
      if (!models || !editors) return;
      const next = latest.current;
      editors.result.updateOptions({ readOnly: !!next.readOnly || stale });
      if (revision === next.file.revision) return;
      if (submitted !== undefined && next.file.result === submitted) {
        revision = next.file.revision;
        savedContent = submitted;
        return;
      }
      if (dirty.current) {
        stale = true;
        editors.result.updateOptions({ readOnly: true });
        set({
          stale: true,
          error: "文件已由其他操作更新；本地草稿已保留，关闭前可复制结果。",
        });
        return;
      }
      revision = next.file.revision;
      savedContent = next.file.result;
      applying = true;
      try {
        for (const side of sides) {
          if (models[side].getValue() !== next.file[side])
            models[side].setValue(next.file[side]);
        }
      } finally {
        applying = false;
      }
      set({ notice: "已载入最新检查点" });
      scheduleAnalysis();
    };
    const visibility = () => {
      if (document.visibilityState === "hidden") {
        cancelAnimationFrame(scrollFrame);
        scrollFrame = 0;
        cancelAnimationFrame(resizeFrame);
        resizeFrame = 0;
        clearTimeout(analysisTimer);
        analysisTimer = undefined;
        terminateWorker();
        queuedAnalysis = true;
      } else {
        layout();
        refresh();
        if (queuedAnalysis) {
          queuedAnalysis = false;
          requestAnalysis();
        }
      }
    };
    document.addEventListener("visibilitychange", visibility);
    handle.current = {
      flush,
      navigate,
      refresh,
      draft: () =>
        models ? { content: models.result.getValue(), revision } : undefined,
    };
    latest.current.registerDraftFlush?.(flush);

    const initialize = async () => {
      const initialFile = latest.current.file;
      if (initialFile.kind !== "text") {
        set({
          loaded: true,
          notice: initialFile.reason || "此文件由智能合并助手处理。",
        });
        return;
      }
      let language = "plaintext";
      const large =
        Math.max(
          initialFile.target.length,
          initialFile.result.length,
          initialFile.source.length,
        ) > NORMAL_DOCUMENT_BYTES;
      if (!large) {
        try {
          language = await languageForPath(initialFile.path);
        } catch {
          set({ notice: "语法服务暂不可用，使用纯文本显示" });
        }
      }
      if (!alive || !target.current || !result.current || !source.current)
        return;
      const file = latest.current.file;
      revision = file.revision;
      savedContent = file.result;
      const containers = {
        target: target.current,
        result: result.current,
        source: source.current,
      };
      const createdModels = {} as Models;
      const createdEditors = {} as Editors;
      models = createdModels;
      editors = createdEditors;
      for (const side of sides) {
        const uri = monaco.Uri.from({
          scheme: "synax-merge",
          authority: instance,
          path: `/${file.id}/${side}/${file.path}`,
          query: file.revision,
        });
        const model = monaco.editor.createModel(file[side], language, uri);
        createdModels[side] = model;
        createdEditors[side] = monaco.editor.create(containers[side], {
          model,
          readOnly: side !== "result" || !!latest.current.readOnly,
          automaticLayout: false,
          minimap: { enabled: false },
          smoothScrolling: false,
          wordWrap: "off",
          scrollBeyondLastLine: false,
          largeFileOptimizations: true,
          maxTokenizationLineLength: 20_000,
          renderWhitespace: "none",
          overviewRulerBorder: false,
          folding: !large,
          glyphMargin: false,
          lineNumbersMinChars: 4,
          fontSize: 13,
          lineHeight: 21,
          tabSize: 4,
          fontFamily: "Liberation Mono, SFMono-Regular, Consolas, monospace",
          padding: { top: 8, bottom: 8 },
          ariaLabel:
            side === "target"
              ? `目标版本 ${file.path}`
              : side === "source"
                ? `来源版本 ${file.path}`
                : `编辑合并结果 ${file.path}`,
        });
      }
      const applyTheme = () => {
        const color = getComputedStyle(root.current!)
          .getPropertyValue("--theme-text")
          .trim();
        const dark =
          document.documentElement.classList.contains("dark") ||
          document.documentElement.dataset.theme === "dark" ||
          (color.startsWith("#") && parseInt(color.slice(1, 3), 16) > 160);
        monaco.editor.setTheme(dark ? "vs-dark" : "vs");
      };
      applyTheme();
      themeObserver = new MutationObserver(applyTheme);
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class", "data-theme", "style"],
      });
      markerDecorations = createdEditors.result.createDecorationsCollection();
      disposables.push(
        createdModels.result.onDidChangeContent(() => {
          if (applying) return;
          markDirty();
          scheduleAnalysis();
          scheduleSave();
        }),
      );
      disposables.push(
        createdEditors.result.addAction({
          id: `merge-save-${instance}`,
          label: "保存合并草稿",
          keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
          run: () => flush().then(() => undefined),
        }),
      );
      for (const side of sides) {
        const editor = createdEditors[side];
        disposables.push(
          editor.addAction({
            id: `merge-next-${instance}-${side}`,
            label: "下一个冲突",
            keybindings: [monaco.KeyCode.F8],
            run: () => navigate(1),
          }),
        );
        disposables.push(
          editor.addAction({
            id: `merge-prev-${instance}-${side}`,
            label: "上一个冲突",
            keybindings: [monaco.KeyMod.Shift | monaco.KeyCode.F8],
            run: () => navigate(-1),
          }),
        );
        disposables.push(
          editor.onDidScrollChange((event) => {
            if (
              expectedScroll[side] !== undefined &&
              Math.abs(editor.getScrollTop() - expectedScroll[side]!) <= 1
            ) {
              delete expectedScroll[side];
              return;
            }
            delete expectedScroll[side];
            if (
              document.visibilityState === "hidden" ||
              synchronizing ||
              !event.scrollTopChanged
            )
              return;
            scrollSource = side;
            if (scrollFrame) return;
            scrollFrame = requestAnimationFrame(() => {
              scrollFrame = 0;
              if (!alive) return;
              const from = createdEditors[scrollSource];
              const first = from.getVisibleRanges()[0]?.startLineNumber;
              if (!first) return;
              const offset =
                from.getScrollTop() - from.getTopForLineNumber(first);
              const count = createdModels[scrollSource].getLineCount();
              const centerCount = createdModels.result.getLineCount();
              const mapping =
                analysis?.version === createdModels.result.getVersionId()
                  ? analysis
                  : undefined;
              const centerLine =
                scrollSource === "result"
                  ? first
                  : mapMergeLine(
                      first,
                      mapping?.[scrollSource] ?? [],
                      count,
                      centerCount,
                      true,
                    );
              synchronizing = true;
              try {
                for (const to of sides)
                  if (to !== scrollSource) {
                    const line =
                      to === "result"
                        ? centerLine
                        : mapMergeLine(
                            centerLine,
                            mapping?.[to] ?? [],
                            centerCount,
                            createdModels[to].getLineCount(),
                          );
                    const top = Math.max(
                      0,
                      createdEditors[to].getTopForLineNumber(line) + offset,
                    );
                    if (Math.abs(createdEditors[to].getScrollTop() - top) > 1) {
                      expectedScroll[to] = top;
                      createdEditors[to].setScrollTop(top);
                      expectedScroll[to] = createdEditors[to].getScrollTop();
                    }
                  }
              } finally {
                synchronizing = false;
              }
            });
          }),
        );
      }
      if (typeof ResizeObserver !== "undefined") {
        observer = new ResizeObserver(layout);
        observer.observe(target.current!);
        observer.observe(result.current!);
        observer.observe(source.current!);
      } else window.addEventListener("resize", layout);
      layout();
      requestAnalysis();
      set({
        loaded: true,
        notice: file.resolutionState
          ? "已恢复保存的正文；旧逐行决定由合并助手重新核验"
          : "已载入",
        degraded: large,
      });
    };
    void initialize().catch((error) =>
      set({
        error: error instanceof Error ? error.message : String(error),
        loaded: true,
      }),
    );
    return () => {
      alive = false;
      handle.current = null;
      dirty.current = false;
      latest.current.registerDraftFlush?.(null);
      clearTimeout(analysisTimer);
      clearTimeout(saveTimer);
      terminateWorker();
      cancelAnimationFrame(resizeFrame);
      cancelAnimationFrame(scrollFrame);
      observer?.disconnect();
      themeObserver?.disconnect();
      window.removeEventListener("resize", layout);
      document.removeEventListener("visibilitychange", visibility);
      for (const disposable of disposables) disposable.dispose();
      markerDecorations?.clear();
      // Editor disposal does not dispose its text model.
      if (editors)
        for (const editor of Object.values(editors)) editor.dispose();
      if (models) for (const model of Object.values(models)) model.dispose();
    };
  }, []);

  useEffect(() => {
    handle.current?.refresh();
  }, [props.file, props.readOnly]);
  const requestClose = () => {
    if (dirty.current) setClosePrompt(true);
    else props.onClose();
  };
  const saveAndClose = async () => {
    if (await handle.current?.flush()) props.onClose();
  };
  const confirmManual = async () => {
    if (props.readOnly || props.managed || state.saving) return;
    if (props.file.kind === "text" && !(await handle.current?.flush())) return;
    setState((previous) => ({ ...previous, saving: true, error: "" }));
    try {
      const draft = handle.current?.draft();
      const input =
        props.file.kind === "text"
          ? { content: draft?.content ?? props.file.result }
          : { choice: structuralChoice };
      await props.onSave({
        ...input,
        expectedRevision: draft?.revision ?? props.file.revision,
        resolve: true,
      });
      props.onClose();
    } catch (cause) {
      setState((previous) => ({
        ...previous,
        saving: false,
        error: cause instanceof Error ? cause.message : String(cause),
      }));
    }
  };
  return (
    <Dialog open onClose={requestClose} className="merge-editor-dialog">
      <DialogPanel className="shared-file-dialog idea-merge-dialog synax-monaco-dialog">
        <div ref={root} className="synax-monaco-merge-workbench">
          <header className="synax-monaco-merge-header">
            <div className="synax-monaco-merge-title">
              <DialogTitle>{props.file.path}</DialogTitle>
              <span>
                {props.file.sourceLabel || "来源版本"} →{" "}
                {props.file.targetLabel || "目标版本"}
              </span>
            </div>
            <button
              type="button"
              onClick={requestClose}
              aria-label="关闭合并编辑器"
            >
              <X size={18} />
            </button>
          </header>
          <div className="synax-monaco-merge-toolbar">
            <button
              type="button"
              disabled={!state.conflicts}
              onClick={() => handle.current?.navigate(-1)}
              aria-label="上一个冲突"
              title="Shift+F8"
            >
              <ChevronUp size={15} />
            </button>
            <button
              type="button"
              disabled={!state.conflicts}
              onClick={() => handle.current?.navigate(1)}
              aria-label="下一个冲突"
              title="F8"
            >
              <ChevronDown size={15} />
            </button>
            <span>
              {state.conflicts
                ? `冲突 ${state.active + 1} / ${state.conflicts}`
                : "无未处理的冲突标记"}
            </span>
            <button
              type="button"
              aria-expanded={baseOpen}
              onClick={() => setBaseOpen((value) => !value)}
            >
              查看 Base
            </button>
            <span className="synax-monaco-merge-hint">
              {props.readOnly
                ? props.file.editable === false
                  ? "大文件只读"
                  : props.managed
                    ? "智能合并中 · 只读"
                    : "只读查看"
                : "Cmd/Ctrl+S 保存草稿"}
              {state.degraded ? " · 简化显示" : ""}
            </span>
          </div>
          {baseOpen && (
            <section className="synax-monaco-base">
              <strong>{props.file.baseLabel || "共同祖先 · Base"}</strong>
              <BaseDocument text={props.file.base} path={props.file.path} />
            </section>
          )}
          {props.file.kind === "text" && (
            <div
              className="synax-monaco-compact-tabs"
              role="tablist"
              aria-label="查看版本"
            >
              {sides.map((side) => (
                <button
                  role="tab"
                  aria-selected={compactSide === side}
                  key={side}
                  onClick={() => setCompactSide(side)}
                >
                  {side === "target"
                    ? "目标"
                    : side === "result"
                      ? "结果"
                      : "来源"}
                </button>
              ))}
            </div>
          )}
          {props.file.kind === "text" ? (
            <div
              className="synax-monaco-merge-columns"
              data-compact-side={compactSide}
            >
              <section data-side="target">
                <header>
                  <strong>目标版本</strong>
                  <span>{props.file.targetLabel || "Target"}</span>
                </header>
                <div ref={target} />
              </section>
              <section data-side="result">
                <header>
                  <strong>合并结果</strong>
                  <span>
                    {props.readOnly || state.stale ? "只读" : "可编辑"}
                  </span>
                </header>
                <div ref={result} />
              </section>
              <section data-side="source">
                <header>
                  <strong>来源版本</strong>
                  <span>{props.file.sourceLabel || "Source"}</span>
                </header>
                <div ref={source} />
              </section>
            </div>
          ) : (
            <section className="synax-monaco-structural">
              <p>
                {props.file.reason || "二进制或结构冲突，由智能合并助手处理。"}
              </p>
              {!props.managed && (
                <label>
                  处理方式
                  <select
                    aria-label="结构冲突处理方式"
                    value={structuralChoice ?? ""}
                    disabled={props.readOnly}
                    onChange={(event) =>
                      setStructuralChoice(
                        event.target.value as "target" | "source" | "delete",
                      )
                    }
                  >
                    <option value="" disabled>
                      选择文件版本
                    </option>
                    <option value="target" disabled={!props.file.targetExists}>
                      目标版本
                    </option>
                    <option value="source" disabled={!props.file.sourceExists}>
                      来源版本
                    </option>
                    <option value="delete">删除文件</option>
                  </select>
                </label>
              )}
            </section>
          )}
          {state.error && (
            <p className="synax-monaco-merge-error" role="alert">
              {state.error}
            </p>
          )}
          <footer className="synax-monaco-merge-footer">
            <span role="status" aria-live="polite">
              {(!state.loaded || state.saving) && (
                <LoaderCircle className="conversation-git-spin" size={14} />
              )}
              {state.notice}
            </span>
            {props.controls}
            {!props.managed && !props.readOnly && (
              <button
                disabled={
                  state.saving ||
                  state.stale ||
                  (props.file.kind === "text"
                    ? !!state.conflicts
                    : !structuralChoice)
                }
                onClick={() => void confirmManual()}
              >
                确认当前结果
              </button>
            )}
          </footer>
        </div>
        <Dialog open={closePrompt} onClose={() => setClosePrompt(false)}>
          <DialogPanel>
            <DialogTitle>保留当前草稿？</DialogTitle>
            <p>草稿尚未保存成功，关闭后本地编辑将丢失。</p>
            <div className="shared-file-toolbar">
              <button onClick={() => setClosePrompt(false)}>继续编辑</button>
              <button disabled={state.saving} onClick={props.onClose}>
                放弃本地编辑
              </button>
              <button
                disabled={state.saving || !!props.readOnly || state.stale}
                onClick={() => void saveAndClose()}
              >
                保存并关闭
              </button>
            </div>
          </DialogPanel>
        </Dialog>
      </DialogPanel>
    </Dialog>
  );
}
