import { useState, useEffect, useRef, type FormEvent } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowRight,
  GitBranch,
  Plus,
  X,
} from "lucide-react";
import type {
  GitWorkspaceSummary,
  ProjectWorkspaceRoot,
} from "../../../lib/api/project";
import {
  gitMrApi,
  type MergeBranchOptions,
  type MergeRequestInput,
  type MergeStrategy,
} from "../../../lib/api/gitMr";
import { BranchSourcePicker, ancestorLabel } from "./BranchSourcePicker";
import { DialogOverlay } from "../../components/DialogOverlay";
import { moveSource, validateInput } from "./mergeUi";
interface Props {
  projectId: string;
  roots: ProjectWorkspaceRoot[];
  rootId: string;
  workspace: GitWorkspaceSummary | null;
  onRootChange: (id: string) => void;
  onClose: () => void;
  onSubmit: (input: MergeRequestInput, presetName?: string) => Promise<void>;
}
export function MergeRequestForm({
  projectId,
  roots,
  rootId,
  workspace,
  onRootChange,
  onClose,
  onSubmit,
}: Props) {
  const [branchOptions, setBranchOptions] = useState<{
    key: string;
    data: MergeBranchOptions;
  } | null>(null);
  const [branchError, setBranchError] = useState<{
    key: string;
    message: string;
  } | null>(null);
  const [retry, setRetry] = useState(0);
  const [title, setTitle] = useState("");
  const [target, setTarget] = useState("");
  const [sources, setSources] = useState<string[]>([]);
  const [strategy, setStrategy] = useState<MergeStrategy>("merge_commit");
  const [checks, setChecks] = useState<
    { id: string; executable: string; args: string; timeout: string }[]
  >([]);
  const [presetName, setPresetName] = useState("");
  const [savePreset, setSavePreset] = useState(false);
  const [autoFinalize, setAutoFinalize] = useState(false);
  const [allowCheckedOutTarget, setAllowCheckedOutTarget] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const latest = useRef({ busy, onClose });
  latest.current = { busy, onClose };
  useEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !latest.current.busy) {
        event.preventDefault();
        latest.current.onClose();
      }
      if (event.key !== "Tab") return;
      const items = Array.from(
        panel.current?.querySelectorAll<HTMLElement>(
          "button:not([disabled]), input:not([disabled]), select:not([disabled])",
        ) ?? [],
      ).filter((item) => !item.closest("fieldset[disabled]"));
      const first = items[0],
        last = items[items.length - 1];
      if (!first) {
        event.preventDefault();
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      previous?.focus();
    };
  }, []);
  const branches = workspace?.branches ?? [];
  const selectedTarget = branches.find((branch) => branch.name === target);
  const queryKey = JSON.stringify([
    projectId,
    rootId,
    target,
    strategy,
    strategy === "ff_only" ? sources : [],
    branches.map((branch) => [branch.name, branch.head]),
  ]);
  const context = branchOptions?.key === queryKey ? branchOptions.data : null;
  const eligibilityError =
    branchError?.key === queryKey ? branchError.message : "";
  const checkingBranches = !!target && !context && !eligibilityError;
  useEffect(() => {
    if (!target || !workspace) return;
    const controller = new AbortController();
    setBranchError(null);
    void gitMrApi
      .branchOptions(
        projectId,
        {
          rootId: rootId || undefined,
          target,
          strategy,
          sources: strategy === "ff_only" ? sources : [],
        },
        controller.signal,
      )
      .then((data) => {
        if (!controller.signal.aborted)
          setBranchOptions({ key: queryKey, data });
      })
      .catch((err) => {
        if (!controller.signal.aborted)
          setBranchError({
            key: queryKey,
            message: err instanceof Error ? err.message : String(err),
          });
      });
    return () => controller.abort();
  }, [queryKey, retry, !!workspace]);
  // In merge/squash mode appending a source does not require another ancestry fetch.
  // FF eligibility does depend on the ordered prefix, and is rechecked above.
  const invalidSources = context
    ? sources.flatMap((name) => {
        const explicit = context.invalidSources.find(
          (item) => item.name === name,
        );
        if (explicit) return [explicit];
        const candidate = context.branches.find((item) => item.name === name);
        return candidate?.enabled
          ? []
          : [
              {
                name,
                reason: candidate?.reason ?? ("invalid_queue" as const),
                detail: candidate?.detail ?? "分支已不存在，请刷新仓库",
              },
            ];
      })
    : [];
  const availableBranches =
    context?.branches ??
    branches.map((branch) => ({
      name: branch.name,
      oid: branch.head,
      ancestor: { evidence: "unknown" as const },
      mergeBaseOids: [],
      enabled: false,
      detail: "正在核验",
    }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      const input: MergeRequestInput = {
        title: title.trim() || `${sources.join("、")} → ${target}`,
        rootId: rootId || undefined,
        target,
        sources,
        strategy,
        autoFinalize: savePreset && autoFinalize,
        allowCheckedOutTarget,
        checks: checks.map((check) => {
          let args: unknown;
          try {
            args = JSON.parse(check.args);
          } catch {
            throw new Error('检查参数必须是 JSON 字符串数组，例如 ["test"]。');
          }
          if (
            !Array.isArray(args) ||
            args.some((arg) => typeof arg !== "string")
          )
            throw new Error("检查参数必须是 JSON 字符串数组。");
          const timeoutMs = Number(check.timeout) * 1000;
          if (
            !check.executable.trim() ||
            !Number.isFinite(timeoutMs) ||
            timeoutMs < 1000 ||
            timeoutMs > 600000 ||
            !Number.isInteger(timeoutMs)
          )
            throw new Error("请填写检查程序和1–600 秒内的超时。");
          return {
            id: check.id,
            executable: check.executable.trim(),
            args: args as string[],
            timeoutMs,
          };
        }),
      };
      const validation = validateInput(input);
      if (validation) throw new Error(validation);
      if (!context)
        throw new Error(eligibilityError || "分支规则正在核验，请稍候。");
      if (invalidSources.length)
        throw new Error("请移除不可合入的源分支，或调整目标、顺序与合并策略。");
      if (savePreset && !presetName.trim()) throw new Error("请填写预设名称。");
      setBusy(true);
      await onSubmit(input, savePreset ? presetName.trim() : undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <DialogOverlay className="mr-modal-backdrop">
      <section
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="mr-create-title"
        className="mr-create-dialog"
      >
        <header className="mr-row">
          <h2 id="mr-create-title">新建本地合并请求</h2>
          <button
            type="button"
            aria-label="关闭新建合并请求"
            onClick={onClose}
            disabled={busy}
          >
            <X size={18} />
          </button>
        </header>
        <p className="mr-muted">
          在独立工作树中按顺序合并，检查通过后更新本地目标分支。
        </p>
        <form onSubmit={submit} className="mr-form">
          <fieldset disabled={busy}>
            {roots.length > 1 && (
              <label className="mr-repository-select">
                仓库
                <select
                  value={rootId}
                  onChange={(e) => {
                    onRootChange(e.target.value);
                    setTarget("");
                    setSources([]);
                    setAllowCheckedOutTarget(false);
                  }}
                >
                  {roots.map((root) => (
                    <option
                      key={root.id}
                      value={root.id}
                      disabled={root.status !== "available"}
                    >
                      {root.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div
              className="mr-merge-flow"
              role="group"
              aria-label="源分支合入目标分支"
            >
              <div className="mr-flow-source">
                <div className="mr-flow-heading">
                  <GitBranch size={16} aria-hidden />
                  <strong>源分支</strong>
                  <span>
                    {sources.length
                      ? `${sources.length} 个`
                      : "先选择要合入的改动"}
                  </span>
                </div>
                {!sources.length && (
                  <p className="mr-flow-placeholder">
                    选择目标后，从列表添加源分支
                  </p>
                )}
                <ol className="mr-sources">
                  {sources.map((source, index) => {
                    const metadata = context?.branches.find(
                      (branch) => branch.name === source,
                    );
                    const invalid = invalidSources.find(
                      (branch) => branch.name === source,
                    );
                    return (
                      <li key={source} data-invalid={!!invalid}>
                        <span className="mr-source-number">{index + 1}</span>
                        <div className="mr-selected-source">
                          <code>{source}</code>
                          {metadata && <small>{ancestorLabel(metadata)}</small>}
                          {invalid && (
                            <small className="mr-source-invalid">
                              {invalid.detail}
                            </small>
                          )}
                        </div>
                        <div className="mr-actions">
                          <button
                            type="button"
                            aria-label={`上移 ${source}`}
                            disabled={index === 0}
                            onClick={() =>
                              setSources(moveSource(sources, index, -1))
                            }
                          >
                            <ArrowUp size={14} />
                          </button>
                          <button
                            type="button"
                            aria-label={`下移 ${source}`}
                            disabled={index === sources.length - 1}
                            onClick={() =>
                              setSources(moveSource(sources, index, 1))
                            }
                          >
                            <ArrowDown size={14} />
                          </button>
                          <button
                            type="button"
                            aria-label={`移除 ${source}`}
                            onClick={() =>
                              setSources(
                                sources.filter((item) => item !== source),
                              )
                            }
                          >
                            <X size={14} />
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ol>
                <BranchSourcePicker
                  branches={availableBranches}
                  selected={sources}
                  loading={checkingBranches}
                  disabled={!target || sources.length >= 30}
                  error={eligibilityError}
                  onRetry={() => setRetry((value) => value + 1)}
                  onAdd={(name) => {
                    if (
                      context?.branches.find((branch) => branch.name === name)
                        ?.enabled &&
                      !sources.includes(name)
                    )
                      setSources([...sources, name]);
                  }}
                />
              </div>
              <div className="mr-flow-arrow" aria-label="合入">
                <ArrowRight size={24} aria-hidden />
                <span>合入</span>
              </div>
              <div className="mr-flow-target">
                <label>
                  目标分支
                  <select
                    aria-label="目标分支"
                    value={target}
                    required
                    onChange={(event) => {
                      setTarget(event.target.value);
                      setSources([]);
                      setAllowCheckedOutTarget(false);
                    }}
                  >
                    <option value="">选择目标分支</option>
                    {branches.map((branch) => (
                      <option key={branch.name} value={branch.name}>
                        {branch.name}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="mr-flow-caption">接收所选源分支的累计结果</p>
                {selectedTarget && (
                  <code className="mr-target-oid">
                    目标 HEAD ·{" "}
                    {(context?.targetOid ?? selectedTarget.head).slice(0, 8)}
                  </code>
                )}
              </div>
            </div>
            {checkingBranches && (
              <p className="mr-muted" role="status">
                正在核验源分支…
              </p>
            )}
            {eligibilityError && (
              <p className="mr-notice" role="alert">
                {eligibilityError}
                <button
                  type="button"
                  onClick={() => setRetry((value) => value + 1)}
                >
                  重试
                </button>
              </p>
            )}
            {!!invalidSources.length && (
              <p className="mr-notice" role="alert">
                请移除不可合入的源分支。
              </p>
            )}
            <label className="mr-strategy-field">
              合并策略
              <select
                aria-label="合并策略"
                value={strategy}
                onChange={(event) =>
                  setStrategy(event.target.value as MergeStrategy)
                }
              >
                <option value="merge_commit">Merge commit</option>
                <option value="squash">Squash</option>
                <option value="ff_only">Fast-forward only</option>
              </select>
            </label>
            <p className="mr-muted mr-strategy-hint">
              {strategy === "merge_commit"
                ? "保留每个源分支的历史。"
                : strategy === "squash"
                  ? "每个源分支压缩为一个提交。"
                  : "只有可以连续快进的分支才能合入。"}
            </p>
            <details className="mr-advanced-settings">
              <summary>
                更多设置 <span>标题、检查和自动化</span>
              </summary>
              <div className="mr-advanced-body">
                <label>
                  标题（可选）
                  <input
                    autoFocus={!title}
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder={
                      sources.length && target
                        ? `${sources.join("、")} → ${target}`
                        : "合并请求标题"
                    }
                    maxLength={200}
                  />
                </label>
                {selectedTarget?.checkedOutPath && (
                  <p className="mr-notice">
                    目标当前检出于 <code>{selectedTarget.checkedOutPath}</code>
                    。
                  </p>
                )}
                <label className="mr-check">
                  <input
                    type="checkbox"
                    checked={allowCheckedOutTarget}
                    onChange={(e) => setAllowCheckedOutTarget(e.target.checked)}
                  />
                  允许更新已检出的目标分支
                </label>
                <div className="mr-row">
                  <h3>
                    验证检查 <span className="mr-muted">可选</span>
                  </h3>
                  <button
                    type="button"
                    disabled={checks.length >= 10}
                    onClick={() =>
                      setChecks([
                        ...checks,
                        {
                          id: crypto.randomUUID(),
                          executable: "",
                          args: "[]",
                          timeout: "300",
                        },
                      ])
                    }
                  >
                    <Plus size={14} />
                    添加检查
                  </button>
                </div>
                <p className="mr-muted">
                  检查会在候选工作树中执行，全部通过后才能自动更新目标。
                </p>
                {checks.map((check, index) => (
                  <div className="mr-check-config" key={check.id}>
                    <label>
                      程序 {index + 1}
                      <input
                        value={check.executable}
                        placeholder="npm"
                        required
                        onChange={(e) =>
                          setChecks(
                            checks.map((item) =>
                              item.id === check.id
                                ? { ...item, executable: e.target.value }
                                : item,
                            ),
                          )
                        }
                      />
                    </label>
                    <label>
                      参数（JSON 数组）
                      <input
                        value={check.args}
                        placeholder={'["test"]'}
                        required
                        onChange={(e) =>
                          setChecks(
                            checks.map((item) =>
                              item.id === check.id
                                ? { ...item, args: e.target.value }
                                : item,
                            ),
                          )
                        }
                      />
                    </label>
                    <label>
                      超时（秒）
                      <input
                        type="number"
                        min="1"
                        max="600"
                        value={check.timeout}
                        required
                        onChange={(e) =>
                          setChecks(
                            checks.map((item) =>
                              item.id === check.id
                                ? { ...item, timeout: e.target.value }
                                : item,
                            ),
                          )
                        }
                      />
                    </label>
                    <button
                      type="button"
                      aria-label={`移除检查 ${index + 1}`}
                      onClick={() =>
                        setChecks(checks.filter((item) => item.id !== check.id))
                      }
                    >
                      <X size={15} />
                    </button>
                  </div>
                ))}
                <label className="mr-check">
                  <input
                    type="checkbox"
                    checked={savePreset}
                    onChange={(e) => setSavePreset(e.target.checked)}
                  />
                  保存为一键预设
                </label>
                {savePreset && (
                  <div className="mr-preset-options">
                    <label>
                      预设名称
                      <input
                        value={presetName}
                        onChange={(e) => setPresetName(e.target.value)}
                        maxLength={120}
                        required
                      />
                    </label>
                    <label className="mr-check">
                      <input
                        type="checkbox"
                        checked={autoFinalize}
                        onChange={(e) => setAutoFinalize(e.target.checked)}
                      />
                      检查通过后自动合入
                    </label>
                  </div>
                )}
              </div>
            </details>
          </fieldset>
          {error && (
            <p role="alert" className="mr-error">
              {error}
            </p>
          )}
          <footer className="mr-actions">
            <button type="button" onClick={onClose} disabled={busy}>
              取消
            </button>
            <button
              className="mr-primary"
              type="submit"
              disabled={
                busy || !workspace || !context || invalidSources.length > 0
              }
            >
              {busy ? "正在创建…" : "创建并准备合并"}
            </button>
          </footer>
        </form>
      </section>
    </DialogOverlay>
  );
}
