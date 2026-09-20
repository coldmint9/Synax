import { useWorkspaceRefresh } from "./workspaceRefresh";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { agentRuntimeApi } from "../../../lib/api/agentRuntime";
import { highlightCode, languageForPath } from "./codeHighlight";
import { FileTypeIcon } from "./FileTypeIcon";
import { WikiMarkdown } from "../wiki/WikiMarkdown";
import "../wiki/wiki-theme.css";

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
}: {
  sessionId: string;
  path: string;
  rootId?: string;
}) {
  const [view, setView] = useState<"preview" | "source">("preview");
  const [content, setContent] = useState("");
  const [html, setHtml] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Guards against a slow read for a previous file overwriting the current one.
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    setLoading(true);
    setError(null);
    try {
      const result = await (rootId
        ? agentRuntimeApi.getSessionEnvironmentFile(
            sessionId,
            path,
            "input",
            rootId,
          )
        : agentRuntimeApi.getSessionEnvironmentFile(sessionId, path, "input"));
      const text = result.content ?? "";
      const nextHtml = await highlightCode(text, path);
      if (requestRef.current !== requestId) return;
      setContent(text);
      setHtml(nextHtml);
    } catch (err) {
      if (requestRef.current !== requestId) return;
      setError(err instanceof Error ? err.message : "读取文件失败");
    } finally {
      if (requestRef.current === requestId) setLoading(false);
    }
  }, [path, sessionId, rootId]);

  useWorkspaceRefresh(sessionId, load, rootId);

  useEffect(() => {
    void load();
    return () => {
      requestRef.current += 1;
    };
  }, [load]);

  useEffect(() => {
    setView("preview");
  }, [sessionId, path, rootId]);

  const lineCount = useMemo(
    () => (content ? content.split("\n").length : 0),
    [content],
  );
  const language = languageForPath(path);
  const canPreview = language === "html" || language === "markdown";
  const showPreview = canPreview && view === "preview";

  return (
    <div className="code-viewer flex min-h-0 flex-1 flex-col">
      <div className="file-viewer-toolbar flex shrink-0 items-center gap-1.5 border-b border-border/30 bg-secondary/20 px-2.5 py-1.5">
        <FileTypeIcon path={path} />
        <span
          className="min-w-0 flex-1 truncate font-mono text-[10px] text-foreground"
          title={path}
        >
          {path}
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
