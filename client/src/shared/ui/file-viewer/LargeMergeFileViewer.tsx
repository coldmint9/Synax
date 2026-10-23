import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, LoaderCircle, X } from "lucide-react";
import { Dialog, DialogPanel, DialogTitle } from "../ui/Dialog";
import { MonacoTextEditor } from "./MonacoTextEditor";
import type { MergeFileViewerProps } from "./MergeFileViewer";
import type {
  MergeFileSlice,
  MergeFileSide,
} from "../../../../../services/local-node/modules/git-mr/contracts";

export type MergeDocumentSide = MergeFileSide;
export type MergeDocumentSlice = MergeFileSlice;
export type ReadMergeDocumentSlice = (
  side: MergeDocumentSide,
  byteOffset: number,
  maxBytes: number,
  expectedRevision: string,
  signal: AbortSignal,
) => Promise<MergeDocumentSlice>;
const PAGE_BYTES = 64 * 1024;
const sideLabels: Record<MergeDocumentSide, string> = {
  base: "共同祖先",
  target: "目标版本",
  result: "合并结果",
  source: "来源版本",
};

/** A single bounded model for oversized files. Byte paging is explicitly a
 * read-only view and can never become a merge result or a file save payload. */
export default function LargeMergeFileViewer(props: MergeFileViewerProps) {
  const [side, setSide] = useState<MergeDocumentSide>("result");
  const [slice, setSlice] = useState<
    | (MergeDocumentSlice & { side: MergeDocumentSide; fileRevision: string })
    | null
  >(null);
  const [offset, setOffset] = useState("0");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const current = useRef(props);
  current.current = props;
  const load = async (selected: MergeDocumentSide, start: number) => {
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    const token = ++generation.current;
    const expectedRevision = current.current.file.revision;
    setLoading(true);
    setError("");
    try {
      if (!current.current.readSlice)
        throw new Error(
          "此入口暂不支持读取后续片段。请从会话合并任务打开该文件。",
        );
      const value = await current.current.readSlice(
        selected,
        start,
        PAGE_BYTES,
        expectedRevision,
        next.signal,
      );
      if (next.signal.aborted || token !== generation.current) return;
      if (
        value.revision !== expectedRevision ||
        current.current.file.revision !== expectedRevision
      )
        throw new Error("文件版本已变化，请重新打开最新文件后继续浏览。");
      setSlice({
        ...value,
        side: selected,
        fileRevision: expectedRevision,
      });
      setOffset(String(value.byteOffset));
    } catch (cause) {
      if (!next.signal.aborted && token === generation.current)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!next.signal.aborted && token === generation.current)
        setLoading(false);
    }
  };
  useEffect(() => {
    setSlice(null);
    setOffset("0");
    void load(side, 0);
    return () => {
      generation.current++;
      controller.current?.abort();
    };
  }, [props.file.id, props.file.revision, side]);
  const shown =
    slice?.side === side && slice.fileRevision === props.file.revision
      ? slice
      : null;
  const jump = () => {
    const value = Number(offset);
    if (
      !Number.isSafeInteger(value) ||
      value < 0 ||
      (slice && value > slice.totalBytes)
    ) {
      setError("请输入文件范围内的非负字节位置。");
      return;
    }
    void load(side, value);
  };
  return (
    <Dialog open onClose={props.onClose} className="merge-editor-dialog">
      <DialogPanel className="shared-file-dialog idea-merge-dialog synax-monaco-dialog">
        <div className="synax-monaco-merge-workbench">
          <header className="synax-monaco-merge-header">
            <div className="synax-monaco-merge-title">
              <DialogTitle>{props.file.path}</DialogTitle>
              <span>大文件按需预览 · 只读片段</span>
            </div>
            <button aria-label="关闭合并编辑器" onClick={props.onClose}>
              <X size={18} />
            </button>
          </header>
          <div className="synax-monaco-merge-toolbar synax-monaco-range-toolbar">
            <label>
              版本
              <select
                aria-label="预览文件版本"
                value={side}
                onChange={(event) =>
                  setSide(event.target.value as MergeDocumentSide)
                }
              >
                {Object.entries(sideLabels).map(([value, label]) => (
                  <option value={value} key={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <button
              aria-label="上一片段"
              disabled={loading || !slice || slice.byteOffset === 0}
              onClick={() =>
                void load(
                  side,
                  Math.max(0, (slice?.byteOffset ?? 0) - PAGE_BYTES),
                )
              }
            >
              <ChevronLeft size={15} />
            </button>
            <button
              aria-label="下一片段"
              disabled={loading || !slice || slice.eof}
              onClick={() => void load(side, slice!.nextByteOffset)}
            >
              <ChevronRight size={15} />
            </button>
            <label>
              字节位置
              <input
                aria-label="预览字节位置"
                inputMode="numeric"
                value={offset}
                onChange={(event) => setOffset(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") jump();
                }}
              />
            </label>
            <button disabled={loading} onClick={jump}>
              跳转
            </button>
            <span>
              {slice
                ? `${slice.byteOffset.toLocaleString()}–${slice.nextByteOffset.toLocaleString()} / ${slice.totalBytes.toLocaleString()} 字节`
                : "载入片段"}
            </span>
          </div>
          {error && (
            <p className="synax-monaco-merge-error" role="alert">
              {error}
            </p>
          )}
          <div className="synax-monaco-range-content">
            <MonacoTextEditor
              key={`${side}:${props.file.revision}`}
              path={props.file.path}
              plainText
              content={shown?.content ?? props.file[side]}
              ariaLabel={`${sideLabels[side]}只读片段 ${props.file.path}`}
            />
          </div>
          <footer className="synax-monaco-merge-footer">
            <span role="status">
              {loading && (
                <LoaderCircle className="conversation-git-spin" size={14} />
              )}
              {loading ? "加载片段…" : "片段仅用于浏览，不会作为合并结果保存。"}
            </span>
            {props.controls}
          </footer>
        </div>
      </DialogPanel>
    </Dialog>
  );
}
