import { useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, ChevronDown, ChevronUp, X } from "lucide-react";
import type { MergeFile } from "../../../../../api/services/git-mr/contracts";
import { type MergeModel, type MergeDecision, type MergeRow } from "./mergeModel";
import { alignMergeDocuments } from "./mergeAlignment";
import {
  MergeCodePane,
  MERGE_LINE_HEIGHT,
  type MergePaneHandle,
} from "./MergeCodePane";
import { normalizeEditorText, rawOffsetToEditor } from "./mergeEditorText";

export function ThreeWayMergeEditor({ file, model, blocked, onEdit, onDecide }: {
  file: MergeFile; model: MergeModel; blocked: boolean;
  onEdit: (text: string) => void; onDecide: (ids: string[], action: MergeDecision) => void;
}) {
  const blocks = useMemo(() => {
    const grouped = new Map<number, MergeRow[]>();
    for (const row of model.rows) grouped.set(row.block, [...(grouped.get(row.block) ?? []), row]);
    return [...grouped].map(([id, rows]) => ({ id, rows }));
  }, [model.rows]);
  const alignment = useMemo(() => alignMergeDocuments(file.target, model.text, file.source), [file.target, model.text, file.source]);
  const [active, setActive] = useState(0);
  const editors = useRef<(MergePaneHandle | null)[]>([]);
  const gutters = useRef<(HTMLDivElement | null)[]>([]);
  const scrollLock = useRef(false);
  const texts = [file.target, model.text, file.source];
  const current = blocks[Math.min(active, Math.max(0, blocks.length - 1))];
  const pending = blocks.filter(block => block.rows.some(row => !row.reviewed)).length;
  const lineAt = (offset: number) => normalizeEditorText(model.text.slice(0, offset)).split("\n").length - 1;
  const visualRanges = blocks.map(block => {
    const startLine = lineAt(block.rows[0].start);
    const endLine = lineAt(block.rows[block.rows.length - 1].end);
    const leadingGap = alignment.gaps[1].find(gap => gap.beforeLine === startLine)?.rows ?? 0;
    const start = (alignment.lineRows[1][startLine] ?? 0) - leadingGap;
    const end = Math.max(start + 1, alignment.lineRows[1][endLine] ?? alignment.rowCount);
    return { start, end };
  });
  const paintGutter = (side: number, top: number) => {
    if (gutters.current[side]) gutters.current[side]!.style.transform = `translateY(${-top}px)`;
  };
  const synchronize = (source: MergePaneHandle) => {
    const side = editors.current.indexOf(source);
    if (side < 0) return;
    paintGutter(side, source.scrollDOM.scrollTop);
    if (scrollLock.current) return;
    scrollLock.current = true;
    editors.current.forEach((editor, index) => {
      if (!editor || editor === source) return;
      editor.scrollDOM.scrollTop = source.scrollDOM.scrollTop;
      editor.scrollDOM.scrollLeft = source.scrollDOM.scrollLeft;
      paintGutter(index, editor.scrollDOM.scrollTop);
    });
    requestAnimationFrame(() => { scrollLock.current = false; });
  };
  const locate = (index: number) => {
    const block = blocks[index], range = visualRanges[index];
    if (!block || !range) return;
    setActive(index);
    const result = editors.current[1];
    if (result) {
      result.setSelection(
        rawOffsetToEditor(model.text, block.rows[0].start),
        rawOffsetToEditor(model.text, block.rows[block.rows.length - 1].end),
      );
      result.focus();
    }
    editors.current.forEach((editor, side) => {
      if (!editor) return;
      editor.scrollDOM.scrollTop = Math.max(0, (range.start - 4) * MERGE_LINE_HEIGHT);
      paintGutter(side, editor.scrollDOM.scrollTop);
    });
  };
  const decide = (action: MergeDecision) => { if (current) onDecide(current.rows.map(row => row.id), action); };
  return <div className="merge-editor-workspace">
    <div className="merge-block-toolbar">
      <button title="上一个冲突" disabled={!blocks.length} onClick={() => locate((active - 1 + blocks.length) % blocks.length)}><ChevronUp size={15} /></button>
      <button title="下一个冲突" disabled={!blocks.length} onClick={() => locate((active + 1) % blocks.length)}><ChevronDown size={15} /></button>
      <span>{blocks.length ? `冲突 ${Math.min(active + 1, blocks.length)} / ${blocks.length}` : "无冲突"} · {pending} 个未解决</span>
      {current && <><button disabled={blocked || current.rows.some(row => !row.mapped)} onClick={() => decide("target")}><ArrowRight size={14} />采用左侧</button><button disabled={blocked || current.rows.some(row => !row.mapped)} onClick={() => decide("source")}><ArrowLeft size={14} />采用右侧</button><button disabled={blocked || current.rows.some(row => !row.mapped)} onClick={() => decide("target-source")}>保留双方</button><button disabled={blocked} onClick={() => decide("confirm")}><Check size={14} />确认当前结果</button><button disabled={blocked || current.rows.some(row => !row.mapped)} onClick={() => decide("reset")}>重置此块</button></>}
    </div>
    <div className="merge-three-columns">
      {texts.map((text, side) => {
        const changedLines = alignment.lineRows[side].flatMap((row, line) => visualRanges.some(range => row >= range.start && row < range.end) ? [line] : []);
        return <section className={`merge-code-pane merge-code-pane-${side}`} key={side} aria-label={side === 0 ? "本地版本" : side === 1 ? "合并结果" : "来源版本"}>
          <header><strong>{side === 0 ? "本地版本" : side === 1 ? "合并结果" : "来源版本"}</strong><span title={side === 0 ? file.targetLabel : side === 2 ? file.sourceLabel : undefined}>{side === 0 ? file.targetLabel || "Target" : side === 2 ? file.sourceLabel || "Source" : "可编辑"}</span></header>
          <div className="merge-code-surface">
            <MergeCodePane text={text} label={side === 1 ? `编辑合并结果 ${file.path}` : side === 0 ? "本地版本代码" : "来源版本代码"} readOnly={side !== 1 || blocked} gaps={alignment.gaps[side]} changedLines={changedLines} onReady={editor => { editors.current[side] = editor; }} onScroll={synchronize} onChange={onEdit} />
            <div className="merge-block-gutter"><div className="merge-block-gutter-inner" ref={element => { gutters.current[side] = element; }}>{blocks.map((block, index) => <div key={block.id} className={`merge-inline-block ${block.rows.every(row => row.reviewed) ? "is-resolved" : ""}`} style={{ top: visualRanges[index].start * MERGE_LINE_HEIGHT }}>
              <button title={side === 0 ? `采用左侧冲突 ${index + 1}` : side === 2 ? `采用右侧冲突 ${index + 1}` : `确认冲突 ${index + 1} 当前结果`} disabled={blocked || (side !== 1 && block.rows.some(row => !row.mapped))} onClick={() => onDecide(block.rows.map(row => row.id), side === 0 ? "target" : side === 2 ? "source" : "confirm")}>{side === 0 ? <ArrowRight size={13} /> : side === 2 ? <ArrowLeft size={13} /> : <Check size={13} />}</button>
            </div>)}</div></div>
          </div>
        </section>;
      })}
    </div>
    <div className="merge-conflict-strip" aria-label="冲突块">
      {blocks.map((block, index) => <div key={block.id} className={index === active ? "is-active" : ""}>
        <button onClick={() => locate(index)}>{block.rows.every(row => row.reviewed) ? <Check size={12} /> : <span className="merge-pending-dot" />}冲突 {index + 1}</button>
        <button title="接受左侧冲突块" disabled={blocked || block.rows.some(row => !row.mapped)} onClick={() => onDecide(block.rows.map(row => row.id), "target")}><ArrowRight size={13} /></button>
        <button title="接受右侧冲突块" disabled={blocked || block.rows.some(row => !row.mapped)} onClick={() => onDecide(block.rows.map(row => row.id), "source")}><ArrowLeft size={13} /></button>
        <button title="忽略两侧变更并确认当前结果" disabled={blocked} onClick={() => onDecide(block.rows.map(row => row.id), "confirm")}><X size={13} /></button>
      </div>)}
    </div>
  </div>;
}
