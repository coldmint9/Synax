import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeftRight,
  Check,
  Folder,
  MoreHorizontal,
  Plus,
  Trash2,
} from "lucide-react";
import {
  quickMergeApi,
  type QuickMergeBoard,
  type QuickMergeGroup,
  type QuickMergeRule,
  type QuickMergeStep,
  type QuickMergeStatus,
} from "../../adapters/transport/quickMerge";
import "./quickMerge.css";

const FEATURE = /^(?:feature(?:\/|$)|codex\/)/;
const RELEASE = /^(?:test|beta)(?:\/|$)/;

export function quickMergeError(source: string, target: string, existing: QuickMergeRule[]): string | null {
  if (!source.trim() || !target.trim()) return "请填写源分支与目标分支。";
  if (source === target) return "源分支与目标分支不能相同。";
  if (FEATURE.test(target) && RELEASE.test(source)) return "不能将 test 或 beta 合入功能分支。";
  if (existing.some((rule) => rule.source === source && rule.target === target))
    return "该分组已有相同指令。";
  return null;
}

export function canSwap(rule: { source: string; target: string }): boolean {
  // Reversing is always offered; a direction the repository policy rejects is
  // reported when the rule runs, not by silently disabling the control.
  return rule.source !== rule.target;
}

function timeLabel(at?: string): string {
  if (!at) return "";
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

const TONE: Record<QuickMergeStatus, string> = {
  idle: "",
  merged: "ok",
  pushed: "ok",
  conflicted: "fail",
  failed: "fail",
};

interface Props {
  projectId: string;
  rootId?: string;
  /** Rules saved before a root was pinned belong to the project's primary root. */
  primaryRoot?: boolean;
  branches: string[];
  onOpenMerge: (mrId: string) => void;
}

export function QuickMergeBoardView({ projectId, rootId, primaryRoot, branches, onOpenMerge }: Props) {
  const [board, setBoard] = useState<QuickMergeBoard>({ groups: [], rules: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [editor, setEditor] = useState<string | null>(null);
  const [draft, setDraft] = useState({ source: "", target: "" });
  const [formError, setFormError] = useState("");
  const [nameEdit, setNameEdit] = useState<{ id: string; value: string } | null>(null);
  const [confirm, setConfirm] = useState<{ kind: "group" | "rule"; id: string } | null>(null);
  const [traces, setTraces] = useState<Record<string, QuickMergeStep[]>>({});
  const [openTrace, setOpenTrace] = useState<Record<string, boolean>>({});
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const next = await quickMergeApi.board(projectId);
      if (!alive.current) return;
      setBoard(next);
      setError("");
    } catch (err) {
      if (!alive.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    alive.current = true;
    setLoading(true);
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  const groups = useMemo(
    () =>
      board.groups.filter(
        (group) => !rootId || group.rootId === rootId || (!group.rootId && primaryRoot),
      ),
    [board.groups, rootId, primaryRoot],
  );
  const rules = useMemo(
    () =>
      board.rules.filter(
        (rule) => !rootId || rule.rootId === rootId || (!rule.rootId && primaryRoot),
      ),
    [board.rules, rootId, primaryRoot],
  );

  const patchRule = (next: QuickMergeRule) =>
    setBoard((current) => ({
      ...current,
      rules: current.rules.map((rule) => (rule.id === next.id ? { ...rule, ...next } : rule)),
    }));

  async function run(rule: QuickMergeRule, kind: "merge" | "push") {
    if (busy) return;
    setBusy(rule.id);
    setError("");
    setConfirm(null);
    try {
      const view = kind === "merge"
        ? await quickMergeApi.merge(projectId, rule.id, rootId)
        : await quickMergeApi.push(projectId, rule.id, rootId);
      patchRule(view);
      if (view.steps?.length) {
        setTraces((current) => ({ ...current, [rule.id]: view.steps! }));
        setOpenTrace((current) => ({ ...current, [rule.id]: true }));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function swap(rule: QuickMergeRule) {
    if (busy || !canSwap(rule)) return;
    setBusy(rule.id);
    setError("");
    try {
      patchRule(await quickMergeApi.updateRule(projectId, rule.id, {
        source: rule.target,
        target: rule.source,
      }));
      setTraces((current) => ({ ...current, [rule.id]: [] }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function addRule(group: QuickMergeGroup) {
    if (busy) return;
    const source = draft.source.trim();
    const target = draft.target.trim();
    const groupRules = board.rules.filter((rule) => rule.groupId === group.id);
    const problem = quickMergeError(source, target, groupRules);
    if (problem) {
      setFormError(problem);
      return;
    }
    setBusy(group.id);
    try {
      const created = await quickMergeApi.createRule(projectId, {
        groupId: group.id,
        rootId,
        source,
        target,
      });
      setBoard((current) => ({ ...current, rules: [...current.rules, created] }));
      setDraft({ source: "", target: "" });
      setFormError("");
      setEditor(null);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function removeRule(ruleId: string) {
    setBusy(ruleId);
    try {
      await quickMergeApi.deleteRule(projectId, ruleId);
      setBoard((current) => ({
        ...current,
        rules: current.rules.filter((rule) => rule.id !== ruleId),
      }));
      setConfirm(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function createGroup() {
    if (busy) return;
    const name = (nameEdit?.value ?? "").trim();
    if (!name) return;
    setBusy("new");
    try {
      const group = await quickMergeApi.createGroup(projectId, { name, rootId });
      setBoard((current) => ({ ...current, groups: [...current.groups, group] }));
      setNameEdit(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function renameGroup(id: string) {
    if (busy) return;
    const name = (nameEdit?.value ?? "").trim();
    if (!name) return;
    setBusy(id);
    try {
      const group = await quickMergeApi.renameGroup(projectId, id, name);
      setBoard((current) => ({
        ...current,
        groups: current.groups.map((item) => (item.id === id ? group : item)),
      }));
      setNameEdit(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function removeGroup(id: string) {
    setBusy(id);
    try {
      await quickMergeApi.deleteGroup(projectId, id);
      setBoard((current) => ({
        ...current,
        groups: current.groups.filter((group) => group.id !== id),
        rules: current.rules.filter((rule) => rule.groupId !== id),
      }));
      setConfirm(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  const total = rules.length;

  return (
    <div className="qm-board">
      <div className="qm-toolrow">
        <button
          type="button"
          className="qm-ghostbtn"
          onClick={() => setNameEdit({ id: "new", value: "" })}
        >
          <Plus size={13} aria-hidden="true" />
          新建分组
        </button>
        <span className="qm-count">
          {groups.length} 个分组 · {total} 条指令
        </span>
      </div>

      {error && (
        <p className="qm-error" role="alert">
          {error}
        </p>
      )}

      {loading ? (
        <p className="qm-empty" role="status">正在读取快捷合并…</p>
      ) : (
        <div className="qm-groups">
          {groups.map((group) => {
            const groupRules = rules.filter((rule) => rule.groupId === group.id);
            return (
              <section className="qm-group" key={group.id} data-group={group.id}>
                <header className="qm-ghead">
                  {nameEdit?.id === group.id ? (
                    <div className="qm-nameedit">
                      <input
                        autoFocus
                        className="qm-input"
                        value={nameEdit.value}
                        aria-label="分组名称"
                        onChange={(event) => setNameEdit({ id: group.id, value: event.target.value })}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") void renameGroup(group.id);
                          if (event.key === "Escape") setNameEdit(null);
                        }}
                      />
                      <button type="button" className="qm-iconbtn" aria-label="保存分组名称" disabled={busy !== null} onClick={() => void renameGroup(group.id)}>
                        <Check size={13} aria-hidden="true" />
                      </button>
                      <button type="button" className="qm-iconbtn" aria-label="取消重命名" onClick={() => setNameEdit(null)}>
                        ×
                      </button>
                    </div>
                  ) : (
                    <>
                      <span className="qm-gicon" aria-hidden="true">
                        <Folder size={14} strokeWidth={1.7} />
                      </span>
                      <h3>{group.name}</h3>
                      <span className="qm-chip">{groupRules.length} 条</span>
                      {confirm?.kind === "group" && confirm.id === group.id ? (
                        <div className="qm-gconfirm">
                          <span>连同 {groupRules.length} 条指令删除</span>
                          <button type="button" className="qm-btn" onClick={() => setConfirm(null)}>取消</button>
                          <button type="button" className="qm-btn qm-btn--danger" onClick={() => void removeGroup(group.id)}>
                            删除分组
                          </button>
                        </div>
                      ) : (
                        <div className="qm-gtools">
                          <button
                            type="button"
                            className="qm-iconbtn"
                            aria-label={`分组操作：${group.name}`}
                            aria-expanded={menu === group.id}
                            onClick={() => setMenu(menu === group.id ? null : group.id)}
                          >
                            <MoreHorizontal size={15} aria-hidden="true" />
                          </button>
                          {menu === group.id && (
                            <div className="qm-menu">
                              <button
                                type="button"
                                onClick={() => {
                                  setMenu(null);
                                  setNameEdit({ id: group.id, value: group.name });
                                }}
                              >
                                重命名
                              </button>
                              <button
                                type="button"
                                className="qm-danger"
                                onClick={() => {
                                  setMenu(null);
                                  setConfirm({ kind: "group", id: group.id });
                                }}
                              >
                                删除分组
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </header>

                <ul className="qm-rules">
                  {groupRules.map((rule) => (
                    <RuleRow
                      key={rule.id}
                      rule={rule}
                      busy={busy !== null}
                      confirming={confirm?.kind === "rule" && confirm.id === rule.id}
                      trace={traces[rule.id]}
                      traceOpen={!!openTrace[rule.id]}
                      onSwap={() => void swap(rule)}
                      onMerge={() => void run(rule, "merge")}
                      onPush={() => void run(rule, "push")}
                      onDelete={() => setConfirm({ kind: "rule", id: rule.id })}
                      onCancelDelete={() => setConfirm(null)}
                      onConfirmDelete={() => void removeRule(rule.id)}
                      onToggleTrace={() =>
                        setOpenTrace((current) => ({ ...current, [rule.id]: !current[rule.id] }))
                      }
                      onResolve={() => rule.mrId && onOpenMerge(rule.mrId)}
                    />
                  ))}
                </ul>

                <div className="qm-gfoot">
                  {editor === group.id ? (
                    <div className="qm-editor">
                      <div className="qm-editor-row">
                        <input
                          autoFocus
                          className="qm-input"
                          placeholder="源分支"
                          aria-label="源分支"
                          list={`qm-branches-${group.id}`}
                          value={draft.source}
                          onChange={(event) => {
                            setDraft((current) => ({ ...current, source: event.target.value }));
                            setFormError("");
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Escape") {
                              setEditor(null);
                              setFormError("");
                            }
                          }}
                        />
                        <ArrowLeftRight size={13} className="qm-arrow" aria-hidden="true" />
                        <input
                          className="qm-input"
                          placeholder="目标分支"
                          aria-label="目标分支"
                          list={`qm-branches-${group.id}`}
                          value={draft.target}
                          onChange={(event) => {
                            setDraft((current) => ({ ...current, target: event.target.value }));
                            setFormError("");
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") void addRule(group);
                            if (event.key === "Escape") {
                              setEditor(null);
                              setFormError("");
                            }
                          }}
                        />
                        <datalist id={`qm-branches-${group.id}`}>
                          {branches.map((name) => (
                            <option key={name} value={name} />
                          ))}
                        </datalist>
                        <button type="button" className="qm-btn qm-btn--lead" disabled={busy !== null} onClick={() => void addRule(group)}>
                          保存
                        </button>
                        <button
                          type="button"
                          className="qm-btn"
                          onClick={() => {
                            setEditor(null);
                            setFormError("");
                          }}
                        >
                          取消
                        </button>
                      </div>
                      {formError && <p className="qm-formerror" role="alert">{formError}</p>}
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="qm-addrule"
                      onClick={() => {
                        setEditor(group.id);
                        setDraft({ source: "", target: "" });
                        setFormError("");
                      }}
                    >
                      <Plus size={13} aria-hidden="true" />
                      新增指令
                    </button>
                  )}
                </div>
              </section>
            );
          })}

          {nameEdit?.id === "new" && (
            <section className="qm-group">
              <header className="qm-ghead">
                <div className="qm-nameedit">
                  <input
                    autoFocus
                    className="qm-input"
                    placeholder="分组名称"
                    aria-label="分组名称"
                    value={nameEdit.value}
                    onChange={(event) => setNameEdit({ id: "new", value: event.target.value })}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void createGroup();
                      if (event.key === "Escape") setNameEdit(null);
                    }}
                  />
                  <button type="button" className="qm-iconbtn" aria-label="保存分组" disabled={busy !== null} onClick={() => void createGroup()}>
                    <Check size={13} aria-hidden="true" />
                  </button>
                  <button type="button" className="qm-iconbtn" aria-label="取消新建分组" onClick={() => setNameEdit(null)}>
                    ×
                  </button>
                </div>
              </header>
            </section>
          )}

          {!groups.length && !nameEdit && (
            <div className="qm-empty">
              <span>还没有分组</span>
              <button type="button" className="qm-btn qm-btn--lead" onClick={() => setNameEdit({ id: "new", value: "" })}>
                <Plus size={13} aria-hidden="true" />
                新建分组
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface RuleRowProps {
  rule: QuickMergeRule;
  busy: boolean;
  confirming: boolean;
  trace?: QuickMergeStep[];
  traceOpen: boolean;
  onSwap: () => void;
  onMerge: () => void;
  onPush: () => void;
  onDelete: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
  onToggleTrace: () => void;
  onResolve: () => void;
}

function RuleRow({
  rule,
  busy,
  confirming,
  trace,
  traceOpen,
  onSwap,
  onMerge,
  onPush,
  onDelete,
  onCancelDelete,
  onConfirmDelete,
  onToggleTrace,
  onResolve,
}: RuleRowProps) {
  const conflicted = rule.status === "conflicted";
  const lead = (rule.ahead ?? 0) > 0 ? "push" : "merge";
  const tone = TONE[rule.status];
  const message = rule.message ?? (rule.status === "merged" ? "已合并" : rule.status === "pushed" ? "已推送" : "");
  const at = timeLabel(rule.lastAt);

  return (
    <li className={`qm-rule${confirming ? " qm-rule--confirm" : ""}${conflicted ? " qm-rule--conflict" : ""}`}>
      <div className="qm-main">
        <span className="qm-ref" title={rule.source}>{rule.source}</span>
        <button
          type="button"
          className="qm-swap"
          disabled={busy || !canSwap(rule) || conflicted}
          aria-label={`对调方向：变为 ${rule.target} → ${rule.source}`}
          title="对调方向"
          onClick={onSwap}
        >
          <ArrowLeftRight size={14} aria-hidden="true" />
        </button>
        <span className="qm-ref qm-ref--dst" title={rule.target}>{rule.target}</span>

        <div className="qm-actions">
          {confirming ? (
            <>
              <button type="button" className="qm-btn" disabled={busy} onClick={onCancelDelete}>取消</button>
              <button type="button" className="qm-btn qm-btn--danger" disabled={busy} onClick={onConfirmDelete}>删除</button>
            </>
          ) : (
            <>
              {conflicted ? (
                <button type="button" className="qm-btn qm-btn--lead" onClick={onResolve}>解决冲突</button>
              ) : (
                <button
                  type="button"
                  className={`qm-btn${lead === "merge" ? " qm-btn--lead" : ""}`}
                  disabled={busy}
                  onClick={onMerge}
                >
                  合并
                </button>
              )}
              <button
                type="button"
                className={`qm-btn${lead === "push" && !conflicted ? " qm-btn--lead" : ""}`}
                disabled={busy || conflicted}
                title={conflicted ? "先解决冲突" : undefined}
                onClick={onPush}
              >
                推送
                {!!rule.ahead && <span className="qm-ahead">{rule.ahead}</span>}
              </button>
            </>
          )}
        </div>

        {!confirming && (
          <button type="button" className="qm-delicon" disabled={busy} aria-label="删除指令" title="删除指令" onClick={onDelete}>
            <Trash2 size={14} aria-hidden="true" />
          </button>
        )}
      </div>

      {confirming ? (
        <div className="qm-status qm-status--warn">删除后运行记录一并移除</div>
      ) : message ? (
        <button
          type="button"
          className={`qm-status qm-status--${tone}${trace?.length ? " qm-status--clickable" : ""}`}
          disabled={!trace?.length}
          aria-expanded={!!trace?.length && traceOpen}
          onClick={onToggleTrace}
        >
          {tone === "ok" ? <Check size={12} aria-hidden="true" /> : <AlertTriangle size={12} aria-hidden="true" />}
          <span>{message}</span>
          {at && <time>{at}</time>}
        </button>
      ) : null}

      {trace?.length && traceOpen && (
        <ol className="qm-steps">
          {trace.map((step, index) => (
            <li key={`${step.command}-${index}`} className={`qm-step qm-step--${step.status}`}>
              {step.status === "ok" ? <Check size={12} aria-hidden="true" /> : <AlertTriangle size={12} aria-hidden="true" />}
              <code>{step.command}</code>
              <span>{step.detail}</span>
            </li>
          ))}
        </ol>
      )}
    </li>
  );
}
