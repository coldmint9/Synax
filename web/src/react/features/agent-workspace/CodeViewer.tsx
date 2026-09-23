import { useWorkspaceRefresh } from "./workspaceRefresh";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, RefreshCw, Save } from "lucide-react";
import {
  agentRuntimeApi,
  type SessionEnvironmentInputSource,
} from "../../../lib/api/agentRuntime";
import { runtimeMedia } from "../../../lib/api/runtimeMedia";
import { highlightCode, languageForPath } from "./codeHighlight";
import { FileTypeIcon } from "./FileTypeIcon";
import { FileViewer } from "../../components/file-viewer/FileViewer";
import { WikiMarkdown } from "../wiki/WikiMarkdown";
import "../wiki/wiki-theme.css";
import {
  getWorkspaceDraft,
  registerWorkspaceSaveHandler,
  setWorkspaceDraft,
  useSessionWorkspaceStore,
} from "./state/sessionWorkspaceStore";

type FilePreviewKind = "text" | "markdown" | "html" | "svg" | "image";

const RASTER_IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "bmp",
  "ico",
]);

function previewKindForPath(path: string): FilePreviewKind {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  if (RASTER_IMAGE_EXTENSIONS.has(extension)) return "image";
  if (extension === "svg") return "svg";
  if (extension === "html" || extension === "htm") return "html";
  if (extension === "md" || extension === "markdown") return "markdown";
  return "text";
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
  const [mediaBlob, setMediaBlob] = useState<Blob | null>(null);
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [highlighted, setHighlighted] = useState<{
    content: string;
    path: string;
    html: string;
  } | null>(null);
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
  const previewKind = inputSource
    ? inputSource.assetId
      ? previewKindForPath(inputSource.label)
      : "text"
    : previewKindForPath(path);

  useEffect(() => {
    contentRef.current = content;
  }, [content]);

  const editable = Boolean(
    tabId && !inputSource && !truncated && previewKind !== "image",
  );

  const load = useCallback(async () => {
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    setLoading(true);
    setError(null);
    setMediaBlob(null);
    try {
      if (inputSource?.assetId) {
        const blob = await runtimeMedia.blob(inputSource.assetId);
        if (requestRef.current !== requestId) return;
        if (previewKind === "image") {
          setMediaBlob(blob);
          setContent("");
          contentRef.current = "";
        } else {
          setMediaBlob(null);
          const note = `${inputSource.label}\n\n该附件类型暂不支持内联预览，请使用工具栏的下载按钮查看原文件。`;
          setContent(note);
          contentRef.current = note;
        }
        setTruncated(false);
        setDirty(false);
        dirtyRef.current = false;
        if (tabId) setTabDirty(sessionId, tabId, false);
        return;
      }
      if (!inputSource && previewKind === "image") {
        const blob = await agentRuntimeApi.getSessionEnvironmentFileMedia(
          sessionId,
          path,
          rootId,
        );
        if (requestRef.current !== requestId) return;
        setMediaBlob(blob);
        setContent("");
        contentRef.current = "";
        setTruncated(false);
        setDirty(false);
        dirtyRef.current = false;
        if (tabId) setTabDirty(sessionId, tabId, false);
        return;
      }
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
      setContent(nextContent);
      contentRef.current = nextContent;
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
  }, [path, sessionId, rootId, inputSource, tabId, setTabDirty, previewKind]);

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

  useEffect(() => {
    if (loading || error) {
      setMediaUrl(null);
      return;
    }
    const blob =
      previewKind === "image"
        ? mediaBlob
        : previewKind === "svg"
          ? new Blob([content], { type: "image/svg+xml" })
          : null;
    if (!blob) {
      setMediaUrl(null);
      return;
    }
    const url = URL.createObjectURL(blob);
    setMediaUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [content, error, loading, mediaBlob, previewKind]);

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

  // Highlight the current draft, not just the original file read. An older
  // asynchronous result must never cover newer text (or another file).
  useEffect(() => {
    if (loading || error || previewKind === "image") return;
    let cancelled = false;
    void highlightCode(content, path).then(
      (html) => {
        if (!cancelled) setHighlighted({ content, path, html });
      },
      () => {
        if (!cancelled) setHighlighted(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [content, path, loading, error, previewKind]);
  const html =
    highlighted?.content === content && highlighted.path === path
      ? highlighted.html
      : undefined;

  const lineCount = useMemo(
    () => (content ? content.split("\n").length : 0),
    [content],
  );
  const language = languageForPath(path);
  const canPreview = previewKind !== "text";
  const canShowSource =
    previewKind === "html" ||
    previewKind === "markdown" ||
    previewKind === "svg";
  const showPreview = canPreview && view === "preview";
  // Markdown scrolls in the body; embedded previews and the editor own their scrolling.
  const hasNestedViewport = showPreview ? previewKind !== "markdown" : editable;
  const formatLabel =
    previewKind === "image"
      ? (mediaBlob?.type.split("/")[1] ?? "image")
      : previewKind === "svg"
        ? "svg"
        : language;

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
          {formatLabel}
        </span>
        {canShowSource && (
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
        {inputSource?.assetId && (
          <a
            className="inline-flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
            href={`/api/agent-runtime/assets/${encodeURIComponent(inputSource.assetId)}/content`}
            download={inputSource.label}
            aria-label="下载附件"
            title="下载附件"
          >
            <Download size={11} />
          </a>
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
        className={`code-viewer-body session-workspace-scroll min-h-0 flex-1 ${hasNestedViewport ? "flex flex-col overflow-hidden" : "overflow-auto"}`}
      >
        {loading ? (
          <div className="file-viewer-status">读取中…</div>
        ) : error ? (
          <div className="file-viewer-status file-viewer-status--error">
            {error}
          </div>
        ) : showPreview ? (
          previewKind === "html" ? (
            <iframe
              title={`HTML 预览：${path}`}
              className="min-h-0 w-full flex-1 border-0 bg-white"
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
              srcDoc={content}
            />
          ) : previewKind === "image" || previewKind === "svg" ? (
            <div
              className="file-viewer-media flex min-h-0 flex-1 items-center justify-center overflow-auto p-4"
              role="region"
              aria-label={`${previewKind === "svg" ? "SVG" : "图片"}预览：${path}`}
            >
              {mediaUrl ? (
                <img
                  src={mediaUrl}
                  alt={path.split(/[\\/]/).pop() ?? path}
                  className="file-viewer-media-image block max-h-full max-w-full object-contain"
                />
              ) : (
                <div className="file-viewer-status">生成预览中…</div>
              )}
            </div>
          ) : (
            <article className="file-viewer-markdown wiki-doc mx-auto w-full px-5 py-4">
              <div className="wiki-markdown">
                <WikiMarkdown content={content} />
              </div>
            </article>
          )
        ) : (
          <FileViewer
            mode="text"
            key={`${sessionId}:${rootId ?? ""}:${path}`}
            path={path}
            content={content}
            html={html}
            onChange={editable ? updateContent : undefined}
          />
        )}
      </div>
    </div>
  );
});
