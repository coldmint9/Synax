import { useEffect, useRef, useState } from "react";
import { Undo2, Redo2, X } from "lucide-react";
import type { MergeFile, MergeFileSave } from "../../../../../services/local-node/modules/git-mr/contracts";
import { Dialog, DialogPanel, DialogTitle } from "../ui/Dialog";
import { ThreeWayMergeEditor } from "./ThreeWayMergeEditor";
import { TextFileContent } from "./TextFileContent";
import { canResolve, createMergeModel, decideRows, editMergeResult, hasConflictMarkers, hydrateMergeResolutionState, serializeMergeResolutionState, type MergeModel, type MergeDecision } from "./mergeModel";
import "./fileViewer.css";

export interface MergeFileViewerProps {
  file: MergeFile;
  onSave: (input: MergeFileSave) => Promise<void>;
  onClose: () => void;
  readOnly?: boolean;
}
export function MergeFileViewer({ file, onSave, onClose, readOnly }: MergeFileViewerProps) {
  const oversized = Math.max(file.result.length, file.base.length, file.target.length, file.source.length) > 1024 * 1024 || Math.max(...[file.result, file.base, file.target, file.source].map(text => text.split("\n").length)) > 5000;
  const textMode = file.kind === "text" && !oversized;
  const [model, setModel] = useState<MergeModel>(() => textMode ? createMergeModel(file) : { text: "", rows: [], version: 0 });
  const [past, setPast] = useState<MergeModel[]>([]);
  const [future, setFuture] = useState<MergeModel[]>([]);
  const [baseOpen, setBaseOpen] = useState(false);
  const [choice, setChoice] = useState<MergeFileSave["choice"]>();
  const [saving, setSaving] = useState(false);
  const [restoring, setRestoring] = useState(Boolean(file.resolutionState && textMode));
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [dirty, setDirty] = useState(false);
  const [closePrompt, setClosePrompt] = useState(false);
  const [stale, setStale] = useState(false);
  const revision = useRef(file.revision);
  const saved = useRef({ text: model.text, choice: undefined as MergeFileSave["choice"] });
  const submitted = useRef<{ text: string; choice?: MergeFileSave["choice"] } | null>(null);
  const initial = useRef(file);
  const pending = new Set(model.rows.filter(row => !row.reviewed).map(row => row.block)).size;
  const blocked = Boolean(readOnly || saving || restoring || stale);
  const resolvable = textMode ? canResolve(model) : Boolean(choice);

  useEffect(() => {
    let active = true;
    if (!textMode || !initial.current.resolutionState) { setRestoring(false); return; }
    void hydrateMergeResolutionState(initial.current).then(restored => {
      if (!active) return;
      if (restored) { setModel(restored); saved.current.text = restored.text; }
      else setNotice("草稿决定无法恢复，请复核冲突块后再标记解决。");
    }).catch(() => { if (active) setNotice("草稿决定无法恢复，请复核当前结果。"); }).finally(() => { if (active) setRestoring(false); });
    return () => { active = false; };
  }, [textMode]);
  useEffect(() => {
    if (revision.current === file.revision) return;
    if (submitted.current && (textMode ? file.result === submitted.current.text : true)) {
      revision.current = file.revision; submitted.current = null; return;
    }
    if (!dirty) {
      revision.current = file.revision;
      const next = textMode ? createMergeModel(file) : { text: "", rows: [], version: 0 };
      setModel(next); setPast([]); setFuture([]); setChoice(undefined); saved.current = { text: next.text, choice: undefined };
    } else { setStale(true); setError("文件版本已更新，当前编辑已保留。请复制编辑结果后重新打开文件，核对最新内容。"); }
  }, [file, textMode, dirty]);
  const update = (next: MergeModel) => {
    if (blocked) return;
    setPast(value => [...value.slice(-99), model]); setFuture([]); setModel(next); setDirty(true); setNotice("");
  };
  const decide = (ids: string[], action: MergeDecision) => {
    if (blocked) return;
    try {
      if (action === "target-source" || action === "source-target") {
        const rows = model.rows.filter(row => ids.includes(row.id));
        if (!rows.length || rows.some(row => !row.mapped)) throw new Error("冲突范围已改变，请撤销编辑或手动编辑结果。");
        const target = rows.map(row => row.target).join("");
        const source = rows.map(row => row.source).join("");
        const [first, second] = action === "target-source" ? [target, source] : [source, target];
        const replacement = first + (first && second && !first.endsWith("\n") ? "\n" : "") + second;
        const next = editMergeResult(model, model.text.slice(0, rows[0].start) + replacement + model.text.slice(rows[rows.length - 1].end));
        update(next);
      } else update(decideRows(model, ids, action));
      setError("");
    } catch (err) { setError(String(err)); }
  };
  const undo = () => {
    if (blocked || !past.length) return;
    setFuture(value => [model, ...value]); setModel(past[past.length - 1]); setPast(value => value.slice(0, -1)); setDirty(true);
  };
  const redo = () => {
    if (blocked || !future.length) return;
    setPast(value => [...value, model]); setModel(future[0]); setFuture(value => value.slice(1)); setDirty(true);
  };
  const requestClose = () => { if (saving) return; if (dirty) setClosePrompt(true); else onClose(); };
  const save = async (resolve: boolean, closeAfter = false) => {
    if (blocked || (resolve && !resolvable)) return;
    setSaving(true); setError("");
    try {
      const resolutionState = textMode ? await serializeMergeResolutionState(model, file) : undefined;
      submitted.current = { text: model.text, choice };
      await onSave({ expectedRevision: revision.current, ...(textMode ? { content: model.text, ...(resolutionState ? { resolutionState } : {}) } : { choice }), resolve });
      saved.current = { text: model.text, choice }; setDirty(false);
      setNotice(resolve ? "已标记解决" : "草稿已保存");
      if (resolve || closeAfter) onClose();
    } catch (err) { submitted.current = null; setError(err instanceof Error ? err.message : String(err)); }
    finally { setSaving(false); }
  };
  return <Dialog open onClose={requestClose} dismissible={!saving} className="merge-editor-dialog">
    <DialogPanel className="shared-file-dialog idea-merge-dialog" onKeyDown={event => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") { event.preventDefault(); if (event.shiftKey) redo(); else undo(); }
    }}>
      <header className="shared-file-header"><div><DialogTitle>{file.path}</DialogTitle><p>{file.targetLabel || "本地版本"} → {file.sourceLabel || "来源版本"} · {pending} 个冲突块待确认</p></div><button onClick={requestClose} aria-label="关闭合并编辑器"><X size={18} /></button></header>
      <div className="shared-file-toolbar"><button disabled={blocked || !past.length} onClick={undo}><Undo2 size={14} />撤销</button><button disabled={blocked || !future.length} onClick={redo}><Redo2 size={14} />重做</button><button aria-expanded={baseOpen} onClick={() => setBaseOpen(value => !value)}>查看 Base</button><span className="merge-toolbar-hint">左：本地 · 中：合并结果 · 右：来源</span></div>
      {baseOpen && <section className="idea-base-view"><strong>{file.baseLabel || "共同祖先 · Base"}</strong><TextFileContent path={file.path} content={file.base} /></section>}
      {restoring ? <p role="status">正在恢复草稿…</p> : textMode ? <ThreeWayMergeEditor file={file} model={model} blocked={blocked} onEdit={text => update(editMergeResult(model, text))} onDecide={decide} /> : <section className="shared-file-structural"><p>{oversized ? "此文件超过 1 MB 或 5000 行，请选择完整版本处理。" : file.reason || "二进制或结构冲突，请选择完整文件版本。"}</p><div className="shared-file-toolbar">{(["target", "source", "delete"] as const).map(side => <button key={side} disabled={blocked || (side === "target" && !file.targetExists) || (side === "source" && !file.sourceExists)} aria-pressed={choice === side} onClick={() => { setChoice(side); setDirty(true); }}>{side === "target" ? "采用本地完整文件" : side === "source" ? "采用来源完整文件" : "删除文件"}</button>)}</div></section>}
      {model.markerError && <p className="shared-file-error" role="alert">{model.markerError}</p>}
      {textMode && hasConflictMarkers(model.text) && <p className="shared-file-error">结果仍有冲突标记，不能标记解决。</p>}
      {error && <p role="alert" className="shared-file-error">{error}</p>}
      <footer className="shared-file-footer"><span role="status">{saving ? "保存中…" : notice || (dirty ? "有未保存更改" : "已载入")}</span><button disabled={blocked} onClick={() => void save(false)}>保存草稿</button><button className="shared-file-primary" disabled={blocked || !resolvable} onClick={() => void save(true)}>标记文件已解决</button></footer>
      <Dialog open={closePrompt} onClose={() => setClosePrompt(false)}><DialogPanel><DialogTitle>保存合并草稿？</DialogTitle><p>当前编辑尚未保存。</p><div className="shared-file-toolbar"><button disabled={saving} onClick={() => setClosePrompt(false)}>继续编辑</button><button disabled={saving} onClick={onClose}>放弃更改</button><button disabled={blocked} onClick={() => void save(false, true)}>保存并关闭</button></div></DialogPanel></Dialog>
    </DialogPanel>
  </Dialog>;
}
