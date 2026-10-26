import { useWorkspaceRefresh } from "./workspaceRefresh";
import { lazy, memo, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { FileDiff, FilePenLine, RefreshCw } from "lucide-react";
import { parsePatch } from "diff";

import { agentRuntimeApi } from "../../adapters/transport/agentRuntime";
import { FileTypeIcon } from "./FileTypeIcon";
import { renderLines } from "../../shared/ui/file-viewer/UnifiedDiffContent";
import { MonacoTextEditor } from "../../shared/ui/file-viewer/MonacoTextEditor";
import { replaceWorkspaceDiffWithFile } from "./state/sessionWorkspaceStore";

const MonacoDiffEditor = lazy(() =>
  import("../../shared/ui/file-viewer/MonacoDiffEditor"),
);

interface DiffSnapshot {
  original: string;
  modified: string;
  added: number;
  removed: number;
  raw: string | null;
  fileLabel?: string;
}

const EMPTY_SNAPSHOT: DiffSnapshot = {
  original: "",
  modified: "",
  added: 0,
  removed: 0,
  raw: null,
};

/** Reconstructs the text sides when an older runtime only returns a patch. */
function snapshotFromPatch(raw: string): DiffSnapshot {
  if (!raw.trim()) return EMPTY_SNAPSHOT;
  try {
    const files = parsePatch(raw);
    const original: string[] = [];
    const modified: string[] = [];
    let added = 0;
    let removed = 0;
    let codeLines = 0;
    for (const file of files) {
      for (const hunk of file.hunks) {
        for (const line of hunk.lines) {
          const prefix = line.slice(0, 1);
          const text = line.slice(1);
          if (prefix === " ") {
            original.push(text);
            modified.push(text);
            codeLines += 1;
          } else if (prefix === "-") {
            original.push(text);
            removed += 1;
            codeLines += 1;
          } else if (prefix === "+") {
            modified.push(text);
            added += 1;
            codeLines += 1;
          }
        }
      }
    }
    if (!codeLines) return { ...EMPTY_SNAPSHOT, raw };
    return {
      original: original.join("\n"),
      modified: modified.join("\n"),
      added,
      removed,
      raw: null,
    };
  } catch {
    return { ...EMPTY_SNAPSHOT, raw };
  }
}

function LoadingSurface({ label }: { label: string }) {
  return (
    <div className="file-viewer-status" role="status">
      {label}
    </div>
  );
}

export const DiffViewer = memo(function DiffViewer({
  sessionId,
  path,
  rootId,
}: {
  sessionId: string;
  path: string;
  rootId?: string;
}) {
  const [snapshot, setSnapshot] = useState<DiffSnapshot>(EMPTY_SNAPSHOT);
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

      const fallback = snapshotFromPatch(result.content ?? "");
      const parsed = renderLines(result.content ?? "");
      const added = parsed.lines.filter((line) => line.type === "add").length;
      const removed = parsed.lines.filter((line) => line.type === "del").length;
      const fileLabel = parsed.lines.find((line) => line.type === "file")?.text;
      setSnapshot({
        original: result.originalContent ?? fallback.original,
        modified: result.modifiedContent ?? fallback.modified,
        added,
        removed,
        raw: fallback.raw,
        fileLabel,
      });
      setLoading(false);
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

  const hasTextDiff = snapshot.original !== snapshot.modified;

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
        {snapshot.fileLabel ? (
          <span className="diff-rename-label truncate font-mono text-[10px] text-muted-foreground">
            {snapshot.fileLabel}
          </span>
        ) : null}
        {snapshot.added > 0 || snapshot.removed > 0 ? (
          <span className="diff-stats font-mono text-[10px]">
            <span className="diff-stat diff-stat--add">+{snapshot.added}</span>
            <span className="diff-stat diff-stat--del">-{snapshot.removed}</span>
          </span>
        ) : null}
        <button
          type="button"
          className="inline-flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
          onClick={() => replaceWorkspaceDiffWithFile(sessionId, path, rootId)}
          aria-label="打开文件"
          title="打开文件"
        >
          <FilePenLine size={11} />
        </button>
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
          <LoadingSurface label="读取中…" />
        ) : error ? (
          <div role="alert" className="file-viewer-status file-viewer-status--error">
            {error}
          </div>
        ) : snapshot.raw !== null ? (
          <Suspense fallback={<LoadingSurface label="加载 Monaco…" />}>
            <MonacoTextEditor
              path={`${path}.diff`}
              content={snapshot.raw}
              plainText
              ariaLabel={`查看 ${path} 的原始 diff`}
            />
          </Suspense>
        ) : !hasTextDiff ? (
          <div className="file-viewer-status flex items-center justify-center gap-1.5">
            <FileDiff size={12} />
            该文件与 HEAD 相比没有可显示的文本差异
          </div>
        ) : (
          <Suspense fallback={<LoadingSurface label="加载 Monaco diff…" />}>
            <MonacoDiffEditor
              path={path}
              original={snapshot.original}
              modified={snapshot.modified}
              ariaLabel={`查看 ${path} 的 Git diff`}
            />
          </Suspense>
        )}
      </div>
    </div>
  );
});
