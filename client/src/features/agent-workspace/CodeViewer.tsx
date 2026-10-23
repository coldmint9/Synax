import { useWorkspaceRefresh } from "./workspaceRefresh";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, Save } from "lucide-react";
import {
  agentRuntimeApi,
  type SessionEnvironmentInputSource,
} from "../../adapters/transport/agentRuntime";
import { runtimeMedia } from "../../adapters/transport/runtimeMedia";
import { languageForPath } from "./codeHighlight";
import { FileTypeIcon } from "./FileTypeIcon";
import { FileViewer } from "../../shared/ui/file-viewer/FileViewer";
import { MarkdownRenderer } from "../../shared/ui/markdown/MarkdownRenderer";
import { useWorkspaceMarkdownImages } from "./WorkspaceMarkdownImage";
import {
  getWorkspaceDraft,
  clearWorkspaceDraft,
  acquireWorkspaceDraftLease,
  isWorkspaceDraftLeaseActive,
  registerWorkspaceSaveHandler,
  setWorkspaceDraft,
  useSessionWorkspaceStore,
} from "./state/sessionWorkspaceStore";

type FilePreviewKind =
  | "text"
  | "markdown"
  | "html"
  | "svg"
  | "image"
  | "pdf"
  | "audio"
  | "video";

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

const MARKDOWN_EXTENSIONS = new Set(["md", "markdown", "mdown"]);

/**
 * Filenames may carry a query/hash suffix (for example
 * `doc.md?version=2`), so the extension is read from the path segment only.
 */
function extensionOfPath(path: string): string {
  const name = (path.split(/[\\/]/).pop() ?? "").split(/[?#]/)[0];
  const separator = name.lastIndexOf(".");
  return separator > 0 ? name.slice(separator + 1).toLowerCase() : "";
}

/** `text/…` attachments are readable text, but only some of them render richly. */
function isTextAttachmentMediaType(mediaType: string): boolean {
  const normalized = mediaType.split(";")[0].trim().toLowerCase();
  return normalized.startsWith("text/") || normalized === "application/json";
}

function previewKindForPath(path: string): FilePreviewKind {
  const extension = extensionOfPath(path);
  if (RASTER_IMAGE_EXTENSIONS.has(extension)) return "image";
  if (extension === "svg") return "svg";
  if (extension === "pdf") return "pdf";
  if (["mp3", "wav", "ogg", "m4a", "aac", "flac"].includes(extension))
    return "audio";
  if (["mp4", "webm", "mov", "mkv", "avi", "m4v"].includes(extension))
    return "video";
  if (extension === "html" || extension === "htm") return "html";
  if (MARKDOWN_EXTENSIONS.has(extension)) return "markdown";
  return "text";
}

/**
 * Attachment previews need the asset's own media type: `image/svg+xml` must
 * not be decoded as text, while `text/plain` Markdown (the type the runtime
 * detects for `.md` files) has to be rendered instead of being rejected as an
 * unsupported attachment.
 */
function previewKindForAttachment(
  label: string,
  mediaType: string | undefined,
): FilePreviewKind {
  const normalized = mediaType?.split(";")[0].trim().toLowerCase() ?? "";
  if (normalized === "image/svg+xml") return "svg";
  if (normalized === "application/pdf") return "pdf";
  if (normalized.startsWith("audio/")) return "audio";
  if (normalized.startsWith("video/")) return "video";
  if (normalized.startsWith("image/")) return "image";
  if (!normalized) return previewKindForPath(label);
  if (!isTextAttachmentMediaType(normalized)) return "text";
  const byMediaType = previewKindForPath(label);
  if (byMediaType === "text" && MARKDOWN_EXTENSIONS.has(extensionOfPath(label)))
    return "markdown";
  return byMediaType;
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
  const [loading, setLoading] = useState(true);
  const [loadedIdentity, setLoadedIdentity] = useState("");
  const [saving, setSaving] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [attachmentMediaType, setAttachmentMediaType] = useState<string | null>(
    null,
  );
  // Guards against a slow read for a previous file overwriting the current one.
  const requestRef = useRef(0);
  const contentRef = useRef(content);
  const dirtyRef = useRef(false);
  const editorFlush = useRef<(() => void) | null>(null);
  const saveFlight = useRef<{
    identity: string;
    promise: Promise<boolean>;
  } | null>(null);
  const mounted = useRef(true);
  const identity = `${sessionId}:${rootId ?? ""}:${path}:${tabId ?? ""}:${inputSource?.assetId ?? inputSource?.toolCallId ?? ""}`;
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const dataCurrent = loadedIdentity === identity;
  const setTabDirty = useSessionWorkspaceStore((state) => state.setTabDirty);
  const draftLease = useMemo(
    () => (tabId ? acquireWorkspaceDraftLease(sessionId, tabId) : undefined),
    [sessionId, tabId],
  );
  // The declared media type of the attachment currently being read; avoids
  // rendering (or rejecting) an asset while another one's type is still set.
  const pendingMediaTypeRef = useRef<string | null>(null);
  const previewKind = inputSource
    ? inputSource.assetId
      ? previewKindForAttachment(
          inputSource.label,
          attachmentMediaType ?? undefined,
        )
      : inputSource.toolCallId
        ? previewKindForPath(inputSource.label)
        : "text"
    : previewKindForPath(path);
  const markdownImages = useWorkspaceMarkdownImages({
    sessionId,
    path,
    rootId,
  });

  useEffect(() => {
    contentRef.current = content;
  }, [content]);

  const editable = Boolean(
    tabId &&
    !inputSource &&
    !truncated &&
    !["image", "pdf", "audio", "video"].includes(previewKind),
  );

  const load = useCallback(async () => {
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    setLoading(true);
    setError(null);
    setMediaBlob(null);
    try {
      if (inputSource?.assetId) {
        pendingMediaTypeRef.current = null;
        const blob = await runtimeMedia.blob(inputSource.assetId);
        if (requestRef.current !== requestId) return;
        if (blob.type) pendingMediaTypeRef.current = blob.type;
        // Trust MIME before the filename. SVG source is still displayed only
        // through an inert image; Markdown and HTML retain their preview modes.
        const attachmentKind = previewKindForAttachment(
          inputSource.label,
          blob.type,
        );
        if (["text", "markdown", "html", "svg"].includes(attachmentKind)) {
          const text = await blob.text();
          if (requestRef.current !== requestId) return;
          setAttachmentMediaType(pendingMediaTypeRef.current);
          setMediaBlob(null);
          setContent(text);
          contentRef.current = text;
        } else {
          setAttachmentMediaType(pendingMediaTypeRef.current);
          setMediaBlob(blob);
          setContent("");
          contentRef.current = "";
        }
        setTruncated(false);
        setDirty(false);
        dirtyRef.current = false;
        if (tabId) setTabDirty(sessionId, tabId, false);
        setLoadedIdentity(identity);
        return;
      }
      if (
        !inputSource &&
        ["image", "pdf", "audio", "video"].includes(previewKind)
      ) {
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
        setLoadedIdentity(identity);
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
      const draft = tabId
        ? getWorkspaceDraft(sessionId, tabId, draftLease)
        : undefined;
      const nextContent = draft ?? text;
      const nextDirty = draft !== undefined && draft !== text;
      setContent(nextContent);
      contentRef.current = nextContent;
      setTruncated(result.truncated);
      setDirty(nextDirty);
      dirtyRef.current = nextDirty;
      if (tabId) setTabDirty(sessionId, tabId, nextDirty);
      setLoadedIdentity(identity);
    } catch (err) {
      if (requestRef.current !== requestId) return;
      setError(err instanceof Error ? err.message : "读取文件失败");
    } finally {
      if (requestRef.current === requestId) setLoading(false);
    }
  }, [identity, path, sessionId, rootId, inputSource, tabId, setTabDirty]);

  const save = useCallback(async (): Promise<boolean> => {
    // A reused CodeViewer instance can receive a new path while its read is
    // pending. Never allow the previous model buffer to be written to the new
    // path, even when a stale dirty flag or the global save handler fires.
    if (
      !editable ||
      !tabId ||
      loading ||
      !dataCurrent ||
      !draftLease ||
      !isWorkspaceDraftLeaseActive(sessionId, tabId, draftLease)
    )
      return false;
    const currentView = mounted.current && identityRef.current === identity;
    if (currentView) editorFlush.current?.();
    if (saveFlight.current?.identity === identity)
      return saveFlight.current.promise;
    const submitted = currentView
      ? contentRef.current
      : getWorkspaceDraft(sessionId, tabId, draftLease);
    if (submitted === undefined) return false;
    if (currentView) {
      setSaving(true);
      setSaveError(null);
    }
    const operation = (async () => {
      try {
        await agentRuntimeApi.saveSessionEnvironmentFile(
          sessionId,
          path,
          submitted,
          rootId,
        );
        if (!isWorkspaceDraftLeaseActive(sessionId, tabId, draftLease))
          return true;
        const stillCurrent =
          mounted.current && identityRef.current === identity;
        if (stillCurrent) editorFlush.current?.();
        const latestDraft = stillCurrent
          ? contentRef.current
          : (getWorkspaceDraft(sessionId, tabId, draftLease) ?? submitted);
        const stillDirty = latestDraft !== submitted;
        if (stillDirty)
          setWorkspaceDraft(sessionId, tabId, latestDraft, draftLease);
        else clearWorkspaceDraft(sessionId, tabId);
        if (stillCurrent) {
          setDirty(stillDirty);
          dirtyRef.current = stillDirty;
        }
        setTabDirty(sessionId, tabId, stillDirty);
        return !stillDirty;
      } catch (err) {
        if (mounted.current && identityRef.current === identity)
          setSaveError(err instanceof Error ? err.message : "保存文件失败");
        return false;
      } finally {
        if (mounted.current && identityRef.current === identity)
          setSaving(false);
      }
    })();
    saveFlight.current = { identity, promise: operation };
    try {
      return await operation;
    } finally {
      if (saveFlight.current?.promise === operation) saveFlight.current = null;
    }
  }, [
    dataCurrent,
    draftLease,
    editable,
    identity,
    loading,
    path,
    rootId,
    sessionId,
    setTabDirty,
    tabId,
  ]);

  useEffect(() => {
    if (loading || error || !dataCurrent) {
      setMediaUrl(null);
      return;
    }
    const blob = ["image", "pdf", "audio", "video"].includes(previewKind)
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
  }, [content, dataCurrent, error, loading, mediaBlob, previewKind]);

  useWorkspaceRefresh(
    sessionId,
    () => {
      if (!dirtyRef.current) void load();
    },
    rootId,
  );

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
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
    registerWorkspaceSaveHandler(sessionId, tabId, save, draftLease);
  }, [draftLease, editable, save, sessionId, tabId]);

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
  }, [draftLease, editable, save, sessionId, tabId]);

  const language = languageForPath(path);
  const canPreview = previewKind !== "text";
  const canShowSource =
    previewKind === "html" ||
    previewKind === "markdown" ||
    previewKind === "svg";
  const showPreview = canPreview && view === "preview";
  // Markdown scrolls in the body; embedded previews and the editor own their scrolling.
  const hasNestedViewport = showPreview ? previewKind !== "markdown" : true;
  const formatLabel =
    previewKind === "image" ||
    previewKind === "audio" ||
    previewKind === "video"
      ? (mediaBlob?.type.split("/")[1] ?? "image")
      : previewKind === "svg"
        ? "svg"
        : language;

  const updateContent = (next: string) => {
    if (
      tabId &&
      draftLease &&
      !isWorkspaceDraftLeaseActive(sessionId, tabId, draftLease)
    )
      return;
    setContent(next);
    contentRef.current = next;
    const nextDirty = true;
    setDirty(nextDirty);
    dirtyRef.current = nextDirty;
    if (tabId) {
      setWorkspaceDraft(sessionId, tabId, next, draftLease);
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
            disabled={!dirty || saving || loading || !dataCurrent}
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
        {loading || (!dataCurrent && !error) ? (
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
          ) : previewKind === "image" ||
            previewKind === "svg" ||
            previewKind === "pdf" ||
            previewKind === "audio" ||
            previewKind === "video" ? (
            <div
              className="file-viewer-media flex min-h-0 flex-1 items-center justify-center overflow-auto p-4"
              role="region"
              aria-label={`${previewKind === "svg" ? "SVG" : previewKind === "audio" ? "音频" : previewKind === "video" ? "视频" : "图片"}预览：${path}`}
            >
              {mediaUrl ? (
                previewKind === "pdf" ? (
                  <iframe
                    title={`PDF 预览：${path}`}
                    src={mediaUrl}
                    className="h-full min-h-[70vh] w-full border-0"
                  />
                ) : previewKind === "audio" ? (
                  <audio
                    title={`音频预览：${path}`}
                    src={mediaUrl}
                    controls
                    preload="metadata"
                  />
                ) : previewKind === "video" ? (
                  <video
                    title={`视频预览：${path}`}
                    src={mediaUrl}
                    controls
                    preload="metadata"
                    className="max-h-full max-w-full"
                  />
                ) : (
                  <img
                    src={mediaUrl}
                    alt={path.split(/[\\/]/).pop() ?? path}
                    className="file-viewer-media-image block max-h-full max-w-full object-contain"
                  />
                )
              ) : (
                <div className="file-viewer-status">生成预览中…</div>
              )}
            </div>
          ) : (
            <article className="file-viewer-markdown mx-auto w-full px-5 py-4">
              <MarkdownRenderer
                content={content}
                className="feed-prose"
                conversationClass={false}
                components={markdownImages.components}
                urlTransform={markdownImages.urlTransform}
              />
            </article>
          )
        ) : (
          <FileViewer
            mode="text"
            key={`${sessionId}:${rootId ?? ""}:${path}`}
            path={path}
            content={content}
            onChange={editable ? updateContent : undefined}
            onDirty={
              editable
                ? () => {
                    dirtyRef.current = true;
                    setDirty(true);
                    if (tabId) setTabDirty(sessionId, tabId, true);
                  }
                : undefined
            }
            onSave={() => void save()}
            registerFlush={(flush) => {
              editorFlush.current = flush;
            }}
          />
        )}
      </div>
    </div>
  );
});
