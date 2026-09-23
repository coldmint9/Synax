import { useWorkspaceRefresh } from "./workspaceRefresh";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileDiff, RefreshCw } from "lucide-react";

import { agentRuntimeApi } from "../../../lib/api/agentRuntime";
import {
  renderLines,
  highlightHunks,
  type ParsedDiff,
} from "../../components/file-viewer/UnifiedDiffContent";
import { FileViewer } from "../../components/file-viewer/FileViewer";
import { FileTypeIcon } from "./FileTypeIcon";

export const DiffViewer = memo(function DiffViewer({
  sessionId,
  path,
  rootId,
}: {
  sessionId: string;
  path: string;
  rootId?: string;
}) {
  const [parsed, setParsed] = useState<ParsedDiff>({ lines: [], hunks: [] });
  const [lineHtml, setLineHtml] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Guards against a slow response for a previous file overwriting the current one.
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
            "diff",
            rootId,
          )
        : agentRuntimeApi.getSessionEnvironmentFile(sessionId, path, "diff"));
      if (requestRef.current !== requestId) return;
      const next = renderLines(result.content ?? "");
      setParsed(next);
      setLineHtml({});
      // Paint the rows first and let syntax colors land right after, so a large
      // diff never sits behind a blank highlighting pass.
      setLoading(false);
      const html = await highlightHunks(next.hunks, path);
      if (requestRef.current !== requestId) return;
      setLineHtml(html);
    } catch (err) {
      if (requestRef.current !== requestId) return;
      setError(err instanceof Error ? err.message : "读取 diff 失败");
      setLoading(false);
    }
  }, [path, sessionId, rootId]);

  useWorkspaceRefresh(sessionId, load, rootId);

  useEffect(() => {
    void load();
    return () => {
      requestRef.current += 1;
    };
  }, [load]);

  const stats = useMemo(() => {
    let added = 0;
    let removed = 0;
    for (const line of parsed.lines) {
      if (line.type === "add") added += 1;
      else if (line.type === "del") removed += 1;
    }
    return { added, removed };
  }, [parsed]);

  return (
    <div className="diff-viewer flex min-h-0 flex-1 flex-col">
      <div className="file-viewer-toolbar flex shrink-0 items-center gap-1.5 border-b border-border/30 bg-secondary/20 px-2.5 py-1.5">
        <FileTypeIcon path={path} />
        <span
          className="min-w-0 flex-1 truncate font-mono text-[10px] text-foreground"
          title={path}
        >
          {path}
        </span>
        {stats.added > 0 || stats.removed > 0 ? (
          <span className="diff-stats font-mono text-[10px]">
            <span className="diff-stat diff-stat--add">+{stats.added}</span>
            <span className="diff-stat diff-stat--del">-{stats.removed}</span>
          </span>
        ) : null}
        <button
          type="button"
          className="inline-flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
          onClick={() => void load()}
          aria-label="刷新 diff"
          title="刷新 diff"
        >
          <RefreshCw size={11} className={loading ? "animate-spin" : ""} />
        </button>
      </div>
      <div className="diff-viewer-body session-workspace-scroll min-h-0 flex-1 overflow-auto">
        {loading ? (
          <div className="file-viewer-status">读取中…</div>
        ) : error ? (
          <div className="file-viewer-status file-viewer-status--error">
            {error}
          </div>
        ) : parsed.lines.length === 0 ? (
          <div className="file-viewer-status flex items-center justify-center gap-1.5">
            <FileDiff size={12} />
            该文件与 HEAD 相比没有差异
          </div>
        ) : (
          <FileViewer mode="diff" parsed={parsed} lineHtml={lineHtml} />
        )}
      </div>
    </div>
  );
});
