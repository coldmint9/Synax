import { useWorkspaceRefresh } from "./workspaceRefresh";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw, Save } from "lucide-react";
import {
  agentRuntimeApi,
  type SessionEnvironmentInputSource,
} from "../../../lib/api/agentRuntime";
import { highlightCode, languageForPath } from "./codeHighlight";
import { FileTypeIcon } from "./FileTypeIcon";
import { WikiMarkdown } from "../wiki/WikiMarkdown";
import "../wiki/wiki-theme.css";
import {
  getWorkspaceDraft,
  registerWorkspaceSaveHandler,
  setWorkspaceDraft,
  useSessionWorkspaceStore,
} from "./state/sessionWorkspaceStore";

function LineNumbers({ count }: { count: number }) {
  const lines = useMemo(
    () => Array.from({ length: count }, (_, i) => i + 1),
    [count],
  );
  return (
    <div
      aria-hidden
      className="code-viewer-line-numbers select-none text-right font-mono text-[11px] leading-[1.5]"
    >
      {lines.map((line) => (
        <div key={line}>{line}</div>
      ))}
    </div>
  );
}

export const CodeViewer = memo(function CodeViewer({
  sessionId,
  path,
  rootId,
  inputSource,
  tabId,
}: {
  sessionId: string;
  path: string;
  rootId?: string;
  inputSource?: SessionEnvironmentInputSource;
  tabId?: string;
}) {
  const [view, setView] = useState<"preview" | "source">("preview");
  const [content, setContent] = useState("");
  const [html, setHtml] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  // Guards against a slow read for a previous file overwriting the current one.
  const requestRef = useRef(0);
  const contentRef = useRef(content);
  const dirtyRef = useRef(false);
  const setTabDirty = useSessionWorkspaceStore((state) => state.setTabDirty);

  useEffect(() => {
    contentRef.current = content;
  }, [content]);

  const editable = Boolean(tabId && !inputSource && !truncated);

  const load = useCallback(async () => {
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    setLoading(true);
    setError(null);
    try {
      const result = inputSource
        ? inputSource.toolCallId
          ? await agentRuntimeApi.getSessionInputSource(
              sessionId,
              inputSource.toolCallId,
            )
          : {
              content: `${inputSource.label}\n\n此输入源没有保留可预览的读取结果。 / No recorded content is available for this input source.`,
              truncated: false,
            }
        : await (rootId
            ? agentRuntimeApi.getSessionEnvironmentFile(
                sessionId,
                path,
                "input",
                rootId,
              )
            : agentRuntimeApi.getSessionEnvironmentFile(
                sessionId,
                path,
                "input",
              ));
      const text = result.content ?? "";
      if (requestRef.current !== requestId) return;
      const draft = tabId ? getWorkspaceDraft(tabId) : undefined;
      const nextContent = draft ?? text;
      const nextDirty = draft !== undefined && draft !== text;
      const nextHtml = await highlightCode(nextContent, path);
      if (requestRef.current !== requestId) return;
      setContent(nextContent);
      contentRef.current = nextContent;
      setHtml(nextHtml);
      setTruncated(result.truncated);
      setDirty(nextDirty);
      dirtyRef.current = nextDirty;
      if (tabId) setTabDirty(sessionId, tabId, nextDirty);
    } catch (err) {
      if (requestRef.current !== requestId) return;
      setError(err instanceof Error ? err.message : "读取文件失败");
    } finally {
      if (requestRef.current === requestId) setLoading(false);
    }
  }, [path, sessionId, rootId, inputSource, tabId, setTabDirty]);

  const save = useCallback(async (): Promise<boolean> => {
    if (!editable || !tabId) return false;
    setSaving(true);
    setSaveError(null);
    try {
      await agentRuntimeApi.saveSessionEnvironmentFile(
        sessionId,
        path,
        contentRef.current,
        rootId,
      );
      setWorkspaceDraft(tabId, contentRef.current);
      // A saved draft is retained so switching tabs does not re-read stale data.
      setDirty(false);
      dirtyRef.current = false;
      setTabDirty(sessionId, tabId, false);
      return true;
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "保存文件失败");
      return false;
    } finally {
      setSaving(false);
    }
  }, [editable, path, rootId, sessionId, setTabDirty, tabId]);

  useWorkspaceRefresh(
    sessionId,
    () => {
      if (!dirtyRef.current) void load();
    },
    rootId,
  );

  useEffect(() => {
    void load();
    return () => {
      requestRef.current += 1;
    };
  }, [load]);

  useEffect(() => {
    setView("preview");
  }, [sessionId, path, rootId]);

  useEffect(() => {
    if (!tabId || !editable) return;
    // Keep the handler alive while the tab is inactive. Only the tab store
    // removes it when the user actually closes the tab.
    registerWorkspaceSaveHandler(tabId, save);
  }, [editable, save, tabId]);

  useEffect(() => {
    if (!tabId || !editable) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s")
        return;
      event.preventDefault();
      void save();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editable, save, tabId]);

  const lineCount = useMemo(
    () => (content ? content.split("\n").length : 0),
    [content],
  );
  const language = languageForPath(path);
  const canPreview = language === "html" || language === "markdown";
  const showPreview = canPreview && view === "preview";

  const updateContent = (next: string) => {
    setContent(next);
    contentRef.current = next;
    const nextDirty = true;
    setDirty(nextDirty);
    dirtyRef.current = nextDirty;
    if (tabId) {
      setWorkspaceDraft(tabId, next);
      setTabDirty(sessionId, tabId, true);
    }
  };

  return (
    <div className="code-viewer flex min-h-0 flex-1 flex-col">
      <div className="file-viewer-toolbar flex shrink-0 items-center gap-1.5 border-b border-border/30 bg-secondary/20 px-2.5 py-1.5">
        <FileTypeIcon path={path} />
        <span
          className="min-w-0 flex-1 truncate font-mono text-[10px] text-foreground"
          title={inputSource?.label ?? path}
        >
          {inputSource?.label ?? path}
          {dirty && <span className="ml-1 text-warning">●</span>}
        </span>
        <span className="rounded bg-secondary/60 px-1.5 py-0.5 text-[9px] uppercase text-muted-foreground">
          {language}
        </span>
        {canPreview && (
          <div
            className="flex shrink-0 gap-0.5 rounded bg-secondary/40 p-0.5"
            role="group"
            aria-label="文件查看模式"
          >
            {(["preview", "source"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={view === mode}
                onClick={() => setView(mode)}
                className={`rounded px-2 py-0.5 text-[10px] ${view === mode ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
              >
                {mode === "preview" ? "预览" : "源码"}
              </button>
            ))}
          </div>
        )}
        {editable && (
          <button
            type="button"
            className="inline-flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-secondary/60 hover:text-foreground disabled:opacity-40"
            onClick={() => void save()}
            disabled={!dirty || saving}
            aria-label="保存文件"
            title="保存 (⌘S)"
          >
            <Save size={11} className={saving ? "animate-pulse" : ""} />
          </button>
        )}
        <button
          type="button"
          className="inline-flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
          onClick={() => void load()}
          aria-label="刷新文件"
          title="刷新文件"
        >
          <RefreshCw size={11} className={loading ? "animate-spin" : ""} />
        </button>
      </div>
      {!loading && !error && truncated && (
        <p role="status" className="px-3 py-1 text-xs text-muted-foreground">
          内容较长，仅显示前 1 MB，暂不支持编辑。 / Preview limited to the first
          1 MB; editing is disabled.
        </p>
      )}
      {saveError && (
        <p role="alert" className="px-3 py-1 text-xs text-danger">
          {saveError}
        </p>
      )}
      <div
        className={`code-viewer-body session-workspace-scroll min-h-0 flex-1 ${showPreview && language === "html" ? "flex flex-col overflow-hidden" : "overflow-auto"}`}
      >
        {loading ? (
          <div className="file-viewer-status">读取中…</div>
        ) : error ? (
          <div className="file-viewer-status file-viewer-status--error">
            {error}
          </div>
        ) : showPreview ? (
          language === "html" ? (
            <iframe
              title={`HTML 预览：${path}`}
              className="min-h-0 w-full flex-1 border-0 bg-white"
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
              srcDoc={content}
            />
          ) : (
            <article className="file-viewer-markdown wiki-doc mx-auto w-full px-5 py-4">
              <div className="wiki-markdown">
                <WikiMarkdown content={content} />
              </div>
            </article>
          )
        ) : editable ? (
          <textarea
            aria-label={`编辑文件 ${path}`}
            className="code-viewer-editor min-h-full w-full resize-none border-0 bg-transparent px-3 py-2 font-mono text-[11px] leading-[1.5] outline-none"
            value={content}
            spellCheck={false}
            onChange={(event) => updateContent(event.target.value)}
          />
        ) : (
          <div className="flex min-w-max items-stretch">
            <div className="code-viewer-gutter sticky left-0 z-10 px-2 py-2">
              <LineNumbers count={lineCount} />
            </div>
            <div
              className="code-viewer-content min-w-max px-3 py-2 font-mono text-[11px] leading-[1.5]"
              dangerouslySetInnerHTML={{ __html: html }}
            />
          </div>
        )}
      </div>
    </div>
  );
});
