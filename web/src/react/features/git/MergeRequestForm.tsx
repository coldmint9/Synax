import { useState, useEffect, useRef, type FormEvent } from "react";
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import type {
  GitWorkspaceSummary,
  ProjectWorkspaceRoot,
} from "../../../lib/api/project";
import type { MergeRequestInput, MergeStrategy } from "../../../lib/api/gitMr";
import { DialogOverlay } from "../../components/DialogOverlay";
import { moveSource, validateInput } from "./mergeUi";
interface Props {
  roots: ProjectWorkspaceRoot[];
  rootId: string;
  workspace: GitWorkspaceSummary | null;
  onRootChange: (id: string) => void;
  onClose: () => void;
  onSubmit: (input: MergeRequestInput, presetName?: string) => Promise<void>;
}
export function MergeRequestForm({
  roots,
  rootId,
  workspace,
  onRootChange,
  onClose,
  onSubmit,
}: Props) {
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
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      const input: MergeRequestInput = {
        title: title.trim(),
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
            <label>
              标题
              <input
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="例如：合入本周功能"
                maxLength={200}
                required
              />
            </label>
            <label>
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
                {!roots.length && <option value="">项目默认仓库</option>}
                {roots.map((root) => (
                  <option
                    key={root.id}
                    value={root.id}
                    disabled={root.status !== "available"}
                  >
                    {root.name} · {root.path}
                  </option>
                ))}
              </select>
            </label>
            <div className="mr-form-columns">
              <label>
                目标分支
                <select
                  value={target}
                  required
                  onChange={(e) => {
                    setTarget(e.target.value);
                    setSources(
                      sources.filter((source) => source !== e.target.value),
                    );
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
              <label>
                合并策略
                <select
                  value={strategy}
                  onChange={(e) => setStrategy(e.target.value as MergeStrategy)}
                >
                  <option value="merge_commit">Merge commit</option>
                  <option value="squash">Squash</option>
                  <option value="ff_only">Fast-forward only</option>
                </select>
              </label>
            </div>
            <p className="mr-muted">
              {
                {
                  merge_commit: "保留源分支历史，为每个源分支生成合并提交。",
                  squash: "将每个源分支的变更压缩为一个提交，按下方顺序累积。",
                  ff_only: "仅允许快进；目标与源分支出现分叉时停止。",
                }[strategy]
              }
            </p>
            <label>
              添加源分支
              <select
                value=""
                disabled={!target || sources.length >= 30}
                onChange={(e) => {
                  if (e.target.value) setSources([...sources, e.target.value]);
                }}
              >
                <option value="">按执行顺序添加分支</option>
                {branches
                  .filter(
                    (branch) =>
                      branch.name !== target && !sources.includes(branch.name),
                  )
                  .map((branch) => (
                    <option key={branch.name} value={branch.name}>
                      {branch.name}
                    </option>
                  ))}
              </select>
            </label>
            <p className="mr-muted">
              各源分支按下方顺序依次合入目标的累计结果。后续分支在前序完成后评估。
            </p>
            <ol className="mr-sources">
              {sources.map((source, index) => (
                <li key={source}>
                  <span>
                    {index + 1}. <code>{source}</code>
                  </span>
                  <div className="mr-actions">
                    <button
                      type="button"
                      aria-label={`上移 ${source}`}
                      disabled={index === 0}
                      onClick={() => setSources(moveSource(sources, index, -1))}
                    >
                      <ArrowUp size={15} />
                    </button>
                    <button
                      type="button"
                      aria-label={`下移 ${source}`}
                      disabled={index === sources.length - 1}
                      onClick={() => setSources(moveSource(sources, index, 1))}
                    >
                      <ArrowDown size={15} />
                    </button>
                    <button
                      type="button"
                      aria-label={`移除 ${source}`}
                      onClick={() =>
                        setSources(sources.filter((item) => item !== source))
                      }
                    >
                      <X size={15} />
                    </button>
                  </div>
                </li>
              ))}
            </ol>
            {selectedTarget?.checkedOutPath && (
              <p className="mr-notice">
                目标当前检出于 <code>{selectedTarget.checkedOutPath}</code>
                。完成时需要明确允许更新，并通过工作树状态检查。
              </p>
            )}
            <label className="mr-check">
              <input
                type="checkbox"
                checked={allowCheckedOutTarget}
                onChange={(e) => setAllowCheckedOutTarget(e.target.checked)}
              />
              允许更新已检出的目标分支（工作树必须干净）
            </label>
            <div className="mr-row">
              <h3>验证检查</h3>
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
              程序会在候选工作树中直接执行；参数逐项传入。
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
              <>
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
                  预设运行时，检查通过后自动更新本地目标
                </label>
              </>
            )}
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
              disabled={busy || !workspace}
            >
              {busy ? "正在创建…" : "创建并准备合并"}
            </button>
          </footer>
        </form>
      </section>
    </DialogOverlay>
  );
}
