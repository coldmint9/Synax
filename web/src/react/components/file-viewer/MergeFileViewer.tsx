import { useEffect, useId, useRef, useState } from "react";
import { X, Undo2, Redo2, ArrowLeft, ArrowRight } from "lucide-react";
import type {
  MergeFile,
  MergeFileSave,
} from "../../../../../api/services/git-mr/contracts";
import { DialogOverlay } from "../DialogOverlay";
import { MergeSideText } from "./MergeSideText";
import { TextFileContent } from "./TextFileContent";
import {
  canResolve,
  createMergeModel,
  decideRows,
  editMergeResult,
  editMergeRow,
  hasConflictMarkers,
  undoMergeRow,
  hydrateMergeResolutionState,
  serializeMergeResolutionState,
  type MergeDecision,
  type MergeModel,
} from "./mergeModel";
import "./fileViewer.css";

export interface MergeFileViewerProps {
  file: MergeFile;
  onSave: (input: MergeFileSave) => Promise<void>;
  onClose: () => void;
  readOnly?: boolean;
}
const actions: [MergeDecision, string][] = [
  ["target", "采用目标"],
  ["source", "采用源"],
  ["target-source", "目标 → 源"],
  ["source-target", "源 → 目标"],
  ["delete", "删除结果行"],
  ["base", "恢复 Base"],
  ["confirm", "确认选中行"],
  ["reset", "重置选中行"],
];

export function MergeFileViewer({
  file,
  onSave,
  onClose,
  readOnly,
}: MergeFileViewerProps) {
  const oversized =
    Math.max(
      file.result.length,
      file.base.length,
      file.target.length,
      file.source.length,
    ) >
      1024 * 1024 || file.result.split("\n").length > 5000;
  const textMode = file.kind === "text" && !oversized;
  const titleId = useId();
  const [model, setModel] = useState<MergeModel>(() =>
    textMode ? createMergeModel(file) : { text: "", rows: [], version: 0 },
  );
  const modelRef = useRef(model);
  modelRef.current = model;
  const [past, setPast] = useState<MergeModel[]>([]);
  const [future, setFuture] = useState<MergeModel[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const anchor = useRef<string | null>(null);
  const navigation = useRef<string | null>(null);
  const [baseOpen, setBaseOpen] = useState(false);
  const [fullOpen, setFullOpen] = useState(false);
  const [mobileSide, setMobileSide] = useState<"target" | "result" | "source">(
    "result",
  );
  const [restoring, setRestoring] = useState(Boolean(file.resolutionState));
  const fileRef = useRef(file);
  fileRef.current = file;
  const initialState = useRef({ file, version: model.version });
  const [choice, setChoice] = useState<MergeFileSave["choice"]>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [closePrompt, setClosePrompt] = useState(false);
  const [savedText, setSavedText] = useState(model.text);
  const [savedChoice, setSavedChoice] = useState<MergeFileSave["choice"]>();
  const [changed, setChanged] = useState(false);
  const revision = useRef(file.revision);
  const submitted = useRef<{
    text: string;
    choice?: MergeFileSave["choice"];
  } | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const dirty = changed || model.text !== savedText || choice !== savedChoice;
  const blocked = Boolean(readOnly || saving);
  const pending = model.rows.filter((row) => !row.reviewed).length;
  const resolvable = textMode ? canResolve(model) : Boolean(choice);
  const requestCloseRef = useRef(() => {});
  requestCloseRef.current = () => {
    if (saving) return;
    if (dirty) setClosePrompt(true);
    else closeRef.current();
  };

  useEffect(() => {
    let cancelled = false;
    const initial = initialState.current;
    if (!textMode || !initial.file.resolutionState) {
      setRestoring(false);
      return;
    }
    void hydrateMergeResolutionState(initial.file)
      .then((restored) => {
        if (
          cancelled ||
          fileRef.current.revision !== initial.file.revision ||
          fileRef.current.result !== initial.file.result ||
          fileRef.current.base !== initial.file.base ||
          fileRef.current.target !== initial.file.target ||
          fileRef.current.source !== initial.file.source ||
          modelRef.current.version !== initial.version
        )
          return;
        if (restored) {
          setModel(restored);
          setSavedText(restored.text);
          setNotice("已恢复草稿及逐行决定");
        } else setNotice("草稿行决定无效或已过期，请重新复核当前结果。");
      })
      .catch(() => {
        if (!cancelled) setNotice("无法恢复草稿行决定，请重新复核当前结果。");
      })
      .finally(() => {
        if (!cancelled) setRestoring(false);
      });
    return () => {
      cancelled = true;
    };
  }, [textMode]);

  useEffect(() => {
    if (revision.current === file.revision) return;
    revision.current = file.revision;
    if (
      submitted.current &&
      (!textMode || file.result === submitted.current.text)
    ) {
      bufferRevision.current = file.revision;
      submitted.current = null;
      setError("");
    } else {
      setError(
        "文件版本已更新。当前编辑已保留；请关闭并重新打开文件，核对最新内容后再保存。",
      );
    }
  }, [file.revision, file.result, textMode]);
  const bufferRevision = useRef(file.revision);

  useEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panel.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        requestCloseRef.current();
      }
      if (event.key !== "Tab") return;
      const visibility = new Map<HTMLElement, boolean>();
      const visible = (element: HTMLElement): boolean => {
        if (element === panel.current) return true;
        const cached = visibility.get(element);
        if (cached !== undefined) return cached;
        const style = window.getComputedStyle(element);
        const result =
          !element.hidden &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          (!element.parentElement || visible(element.parentElement));
        visibility.set(element, result);
        return result;
      };
      const items = Array.from(
        panel.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), [tabindex="0"]',
        ) ?? [],
      ).filter(
        (item) => visible(item) && item.getAttribute("aria-hidden") !== "true",
      );
      const first = items[0],
        last = items[items.length - 1];
      if (!first) {
        event.preventDefault();
        panel.current?.focus();
        return;
      }
      if (
        event.shiftKey &&
        (document.activeElement === first ||
          document.activeElement === panel.current)
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last ||
          document.activeElement === panel.current)
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", keydown, true);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", keydown, true);
      previous?.focus();
    };
  }, []);

  function update(next: MergeModel) {
    if (next === model) return;
    setPast((value) => [...value.slice(-99), model]);
    setFuture([]);
    setModel(next);
    setChanged(true);
    setNotice("");
  }
  function decide(ids: string[], action: MergeDecision) {
    try {
      update(decideRows(model, ids, action));
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败");
    }
  }
  function undo() {
    const previous = past[past.length - 1];
    if (!previous) return;
    setFuture((value) => [model, ...value]);
    setPast((value) => value.slice(0, -1));
    setModel({ ...previous, version: model.version + 1 });
    setChanged(true);
  }
  function redo() {
    const next = future[0];
    if (!next) return;
    setPast((value) => [...value, model]);
    setFuture((value) => value.slice(1));
    setModel({ ...next, version: model.version + 1 });
    setChanged(true);
  }
  function select(id: string, shift: boolean) {
    if (shift && anchor.current) {
      const a = model.rows.findIndex((row) => row.id === anchor.current),
        b = model.rows.findIndex((row) => row.id === id);
      setSelected((value) => [
        ...new Set([
          ...value,
          ...model.rows
            .slice(Math.min(a, b), Math.max(a, b) + 1)
            .map((row) => row.id),
        ]),
      ]);
    } else {
      setSelected((value) =>
        value.includes(id)
          ? value.filter((item) => item !== id)
          : [...value, id],
      );
      anchor.current = id;
    }
  }
  function navigatePending(direction: number) {
    const pendingRows = model.rows.filter((row) => !row.reviewed);
    if (!pendingRows.length) return;
    const index = pendingRows.findIndex((row) => row.id === navigation.current);
    const next =
      pendingRows[
        (index + direction + pendingRows.length) % pendingRows.length
      ];
    navigation.current = next.id;
    setFullOpen(false);
    setMobileSide("result");
    requestAnimationFrame(() =>
      document
        .getElementById(`${titleId}-${next.id}`)
        ?.scrollIntoView?.({ block: "center" }),
    );
  }
  async function save(resolve: boolean, closeAfter = false) {
    if (blocked || (resolve && !resolvable)) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const resolutionState = textMode
        ? await serializeMergeResolutionState(model, file)
        : undefined;
      submitted.current = { text: model.text, choice };
      await onSave({
        expectedRevision: bufferRevision.current,
        ...(textMode
          ? {
              content: model.text,
              ...(resolutionState ? { resolutionState } : {}),
            }
          : { choice }),
        resolve,
      });
      setSavedText(model.text);
      setSavedChoice(choice);
      setChanged(false);
      setNotice(
        resolve
          ? "已标记解决"
          : textMode && !resolutionState
            ? "草稿已保存；行决定未能保存（100 KB 限额或签名不可用），重新打开时需复核。"
            : "草稿及逐行决定已保存；未确认行仍需复核",
      );
      if (resolve || closeAfter) closeRef.current();
    } catch (err) {
      submitted.current = null;
      setError(
        err instanceof Error
          ? err.message
          : "保存失败，请重试。版本过期时请重新打开文件。",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <DialogOverlay className="shared-file-overlay">
      <div
        className="shared-file-dialog"
        data-mobile-side={mobileSide}
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (blocked || !(event.metaKey || event.ctrlKey)) return;
          if (event.key.toLowerCase() === "z") {
            event.preventDefault();
            if (event.shiftKey) redo();
            else undo();
          }
          if (event.key.toLowerCase() === "s") {
            event.preventDefault();
            void save(false);
          }
        }}
      >
        <header className="shared-file-header">
          <div className="min-w-0 flex-1">
            <h2
              id={titleId}
              className="truncate font-mono text-sm"
              title={file.path}
            >
              {file.path}
            </h2>
            <p className="text-xs text-muted-foreground">
              {file.conflicted ? "三方合并" : "合并候选文件"} ·{" "}
              {textMode
                ? `${pending} 行待确认`
                : file.kind === "binary"
                  ? "二进制文件"
                  : "结构冲突"}
            </p>
          </div>
          <button
            aria-label="关闭文件查看器"
            disabled={saving}
            onClick={() => requestCloseRef.current()}
          >
            <X size={18} />
          </button>
        </header>
        {error && (
          <p role="alert" className="shared-file-error">
            {error}
          </p>
        )}
        {restoring && (
          <p role="status" className="shared-file-notice">
            恢复草稿行决定中…
          </p>
        )}
        {notice && (
          <p role="status" className="shared-file-notice">
            {notice}
          </p>
        )}
        {textMode ? (
          <>
            <div
              className="shared-file-mobile-tabs"
              role="tablist"
              aria-label="合并文件栏"
            >
              {(["target", "result", "source"] as const).map((side) => (
                <button
                  key={side}
                  role="tab"
                  id={`${titleId}-tab-${side}`}
                  aria-selected={mobileSide === side}
                  aria-controls={`${titleId}-pane-${side}`}
                  tabIndex={mobileSide === side ? 0 : -1}
                  onClick={() => setMobileSide(side)}
                  onKeyDown={(event) => {
                    if (
                      !["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                        event.key,
                      )
                    )
                      return;
                    event.preventDefault();
                    const sides = ["target", "result", "source"] as const;
                    const next =
                      event.key === "Home"
                        ? "target"
                        : event.key === "End"
                          ? "source"
                          : sides[
                              (sides.indexOf(side) +
                                (event.key === "ArrowRight" ? 1 : 2)) %
                                3
                            ];
                    setMobileSide(next);
                    document.getElementById(`${titleId}-tab-${next}`)?.focus();
                  }}
                >
                  {side === "target"
                    ? "目标"
                    : side === "source"
                      ? "源"
                      : "结果"}
                </button>
              ))}
            </div>
            <div className="shared-file-toolbar">
              <button disabled={blocked || !past.length} onClick={undo}>
                <Undo2 size={14} />
                撤销
              </button>
              <button disabled={blocked || !future.length} onClick={redo}>
                <Redo2 size={14} />
                重做
              </button>
              <button
                aria-expanded={baseOpen}
                onClick={() => setBaseOpen((value) => !value)}
              >
                查看 Base
              </button>
              <button
                aria-pressed={fullOpen}
                onClick={() => setFullOpen((value) => !value)}
              >
                {fullOpen ? "逐行处理" : "编辑完整结果"}
              </button>
              <button disabled={!pending} onClick={() => navigatePending(-1)}>
                上一待处理行
              </button>
              <button disabled={!pending} onClick={() => navigatePending(1)}>
                下一待处理行
              </button>
            </div>
            {model.markerError && (
              <p role="alert" className="shared-file-error">
                {model.markerError}
              </p>
            )}
            {hasConflictMarkers(model.text) && (
              <p className="shared-file-error">
                结果中仍有冲突标记，不能标记解决。
              </p>
            )}
            {baseOpen && (
              <div className="shared-file-base">
                <h3>Base：{file.baseLabel || "Git index stage 1"}</h3>
                <TextFileContent path={file.path} content={file.base} />
              </div>
            )}
            <div className="shared-file-toolbar">
              <span>已选 {selected.length} 行</span>
              <button
                onClick={() => setSelected(model.rows.map((row) => row.id))}
              >
                选择全部冲突行
              </button>
              <button onClick={() => setSelected([])}>清除选择</button>
              {actions.map(([action, label]) => (
                <button
                  key={action}
                  disabled={
                    blocked ||
                    !selected.length ||
                    (action !== "confirm" &&
                      model.rows.some(
                        (row) => selected.includes(row.id) && !row.mapped,
                      )) ||
                    (action === "base" &&
                      model.rows.some(
                        (row) => selected.includes(row.id) && !row.baseKnown,
                      ))
                  }
                  onClick={() => decide(selected, action)}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="shared-file-hint">
              点击行号选择，Shift
              连选。两侧空白表示插入或删除；保留双方和手动编辑后需显式确认。已自动合入的非冲突内容保留在完整结果中。
            </p>
            <div
              id={`${titleId}-pane-target`}
              role="tabpanel"
              aria-labelledby={`${titleId}-tab-target`}
              className="shared-mobile-side shared-mobile-side--target"
            >
              <h3>{file.targetLabel || "目标 / 累计结果"}</h3>
              <TextFileContent path={file.path} content={file.target} />
            </div>
            <div
              id={`${titleId}-pane-source`}
              role="tabpanel"
              aria-labelledby={`${titleId}-tab-source`}
              className="shared-mobile-side shared-mobile-side--source"
            >
              <h3>{file.sourceLabel || "当前源分支"}</h3>
              <TextFileContent path={file.path} content={file.source} />
            </div>
            <div
              id={`${titleId}-pane-result`}
              role="tabpanel"
              aria-labelledby={`${titleId}-tab-result`}
              className="shared-merge-main-result"
            >
              {fullOpen || !model.rows.length ? (
                <div className="shared-file-result">
                  <TextFileContent
                    path={file.path}
                    content={model.text}
                    onChange={
                      blocked
                        ? undefined
                        : (value) => update(editMergeResult(model, value))
                    }
                  />
                </div>
              ) : (
                <div className="shared-merge-scroll">
                  <table className="shared-merge-table">
                    <thead>
                      <tr>
                        <th className="shared-merge-target">
                          目标 / 累计结果
                          {file.targetLabel ? ` · ${file.targetLabel}` : ""}
                        </th>
                        <th className="shared-merge-result">
                          合并结果（可编辑）
                        </th>
                        <th className="shared-merge-source">
                          当前源分支
                          {file.sourceLabel ? ` · ${file.sourceLabel}` : ""}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {model.rows.map((row, index) => (
                        <tr
                          key={row.id}
                          id={`${titleId}-${row.id}`}
                          data-row-id={row.id}
                          data-reviewed={row.reviewed}
                          className={
                            selected.includes(row.id) ? "is-selected" : ""
                          }
                        >
                          <td className="shared-merge-target">
                            <div className="shared-merge-cell">
                              <button
                                className="shared-merge-number"
                                aria-label={`选择冲突行 ${index + 1}`}
                                aria-pressed={selected.includes(row.id)}
                                onClick={(event) =>
                                  select(row.id, event.shiftKey)
                                }
                              >
                                {row.targetLine ?? "∅"}
                              </button>
                              <MergeSideText
                                target={row.target}
                                source={row.source}
                                side="target"
                              />
                              <button
                                disabled={blocked || !row.mapped}
                                aria-label={`采用目标第 ${row.targetLine ?? "空"} 行到冲突行 ${index + 1}`}
                                title="仅采用此目标行"
                                onClick={() => decide([row.id], "target")}
                              >
                                <ArrowRight size={15} />
                              </button>
                            </div>
                          </td>
                          <td className="shared-merge-result">
                            <div className="shared-merge-result-row">
                              {(index === 0 ||
                                model.rows[index - 1].block !== row.block) && (
                                <div className="shared-merge-block-actions">
                                  <button
                                    onClick={() =>
                                      setSelected(
                                        model.rows
                                          .filter(
                                            (item) => item.block === row.block,
                                          )
                                          .map((item) => item.id),
                                      )
                                    }
                                  >
                                    选择冲突块 {row.block}
                                  </button>
                                  <button
                                    disabled={
                                      blocked ||
                                      model.rows.some(
                                        (item) =>
                                          item.block === row.block &&
                                          !item.mapped,
                                      )
                                    }
                                    onClick={() =>
                                      decide(
                                        model.rows
                                          .filter(
                                            (item) => item.block === row.block,
                                          )
                                          .map((item) => item.id),
                                        "target",
                                      )
                                    }
                                  >
                                    采用目标块 {row.block}
                                  </button>
                                  <button
                                    disabled={
                                      blocked ||
                                      model.rows.some(
                                        (item) =>
                                          item.block === row.block &&
                                          !item.mapped,
                                      )
                                    }
                                    onClick={() =>
                                      decide(
                                        model.rows
                                          .filter(
                                            (item) => item.block === row.block,
                                          )
                                          .map((item) => item.id),
                                        "source",
                                      )
                                    }
                                  >
                                    采用源块 {row.block}
                                  </button>
                                </div>
                              )}

                              <div className="shared-merge-mobile-actions">
                                <button
                                  aria-pressed={selected.includes(row.id)}
                                  onClick={(event) =>
                                    select(row.id, event.shiftKey)
                                  }
                                >
                                  选择行 {index + 1}
                                </button>
                                <button
                                  disabled={blocked || !row.mapped}
                                  onClick={() => decide([row.id], "target")}
                                >
                                  采用目标行
                                </button>
                                <button
                                  disabled={blocked || !row.mapped}
                                  onClick={() => decide([row.id], "source")}
                                >
                                  采用源行
                                </button>
                              </div>
                              <span className="shared-merge-status">
                                冲突 {row.block} · 行 {index + 1} ·{" "}
                                {row.reviewed ? "已确认" : "待确认"}
                              </span>
                              {row.mapped ? (
                                <textarea
                                  aria-label={`编辑冲突行 ${index + 1}`}
                                  value={model.text.slice(row.start, row.end)}
                                  readOnly={blocked}
                                  rows={Math.min(
                                    10,
                                    Math.max(
                                      1,
                                      model.text
                                        .slice(row.start, row.end)
                                        .split("\n").length - 1,
                                    ),
                                  )}
                                  spellCheck={false}
                                  onChange={(event) =>
                                    update(
                                      editMergeRow(
                                        model,
                                        row.id,
                                        event.target.value,
                                      ),
                                    )
                                  }
                                />
                              ) : (
                                <p>
                                  手动编辑改变了行范围，请在完整结果中复核。
                                </p>
                              )}
                              <button
                                disabled={blocked || row.reviewed}
                                onClick={() => decide([row.id], "confirm")}
                                aria-label={`确认冲突行 ${index + 1}`}
                              >
                                确认此行
                              </button>
                              <button
                                disabled={
                                  blocked || !row.mapped || !past.length
                                }
                                aria-label={`撤销冲突行 ${index + 1}`}
                                onClick={() => {
                                  try {
                                    update(undoMergeRow(model, row.id, past));
                                  } catch (err) {
                                    setError(String(err));
                                  }
                                }}
                              >
                                撤销此行
                              </button>
                            </div>
                          </td>
                          <td className="shared-merge-source">
                            <div className="shared-merge-cell">
                              <button
                                disabled={blocked || !row.mapped}
                                aria-label={`采用源第 ${row.sourceLine ?? "空"} 行到冲突行 ${index + 1}`}
                                title="仅采用此来源行"
                                onClick={() => decide([row.id], "source")}
                              >
                                <ArrowLeft size={15} />
                              </button>
                              <MergeSideText
                                target={row.target}
                                source={row.source}
                                side="source"
                              />
                              <span className="shared-merge-number">
                                {row.sourceLine ?? "∅"}
                              </span>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="shared-file-structural">
            <p>
              {oversized
                ? "文件超过 1 MB 或 5000 行，已切换为整文件处理，避免阻塞界面。请明确选择完整文件的处理方式。"
                : file.reason ||
                  "此文件无法进行文本逐行合并，请明确选择完整文件的处理方式。"}
            </p>
            <div className="shared-file-toolbar">
              {(["target", "source", "delete"] as const).map((side) => (
                <button
                  key={side}
                  disabled={
                    blocked ||
                    (side === "target" && !file.targetExists) ||
                    (side === "source" && !file.sourceExists)
                  }
                  aria-pressed={choice === side}
                  onClick={() => {
                    setChoice(side);
                    setChanged(true);
                  }}
                >
                  {side === "delete"
                    ? "删除文件"
                    : side === "target"
                      ? "保留完整目标文件"
                      : "保留完整源文件"}
                </button>
              ))}
            </div>
            <p>
              目标：{file.targetExists ? "文件存在" : "文件不存在"} · 源：
              {file.sourceExists ? "文件存在" : "文件不存在"}
            </p>
          </div>
        )}
        {closePrompt && (
          <div className="shared-file-close-prompt" role="alert">
            <p>此文件有未保存的内容或冲突决定。</p>
            <button disabled={saving} onClick={() => void save(false, true)}>
              保存草稿并关闭
            </button>
            <button disabled={saving} onClick={onClose}>
              放弃未保存修改
            </button>
            <button disabled={saving} onClick={() => setClosePrompt(false)}>
              继续编辑
            </button>
          </div>
        )}
        <footer className="shared-file-footer">
          <span className="text-xs text-muted-foreground">
            {readOnly
              ? "只读"
              : saving
                ? "保存中…"
                : dirty
                  ? "有未保存修改"
                  : "已载入"}
          </span>
          <button
            disabled={blocked || (!textMode && !choice)}
            onClick={() => void save(false)}
          >
            保存草稿
          </button>
          <button
            className="shared-file-primary"
            disabled={blocked || !resolvable}
            onClick={() => void save(true)}
          >
            标记文件已解决
          </button>
        </footer>
      </div>
    </DialogOverlay>
  );
}
