import { useState, useEffect, type FormEvent } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowRight,
  GitBranch,
  GitMerge,
  ShieldCheck,
  ChevronDown,
  ChevronRight,
  Layers2,
  GitCommitHorizontal,
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
import {
  Dialog,
  DialogContainer,
  DialogPanel,
  DialogTitle,
  DialogDescription,
} from "../../components/ui/Dialog";
import { Button } from "../../components/ui/Button";
import "./mergeRequest.css";
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
  const strategies = [
    {
      value: "merge_commit",
      label: "Merge commit",
      description: "保留每个源分支的历史",
      icon: GitMerge,
    },
    {
      value: "squash",
      label: "Squash",
      description: "每个源分支压缩为一个提交",
      icon: Layers2,
    },
    {
      value: "ff_only",
      label: "Fast-forward only",
      description: "仅接受可以连续快进的分支",
      icon: GitCommitHorizontal,
    },
  ] as const;

  return (
    <Dialog
      open
      onClose={onClose}
      dismissible={!busy}
      backdropClassName="!bg-black/25 backdrop-blur-[5px]"
      className="mr-compose-root"
    >
      <DialogContainer size="lg" className="!max-w-[800px]">
        <DialogPanel className="mr-compose-panel !gap-0 overflow-hidden !rounded-[22px] !p-0">
          <form
            onSubmit={submit}
            aria-busy={busy}
            className="mr-compose-form flex min-h-0 flex-col"
          >
            <header className="flex shrink-0 items-start gap-3.5 px-6 pt-6 pb-5 sm:px-7">
              <span
                className="mr-compose-mark grid size-10 shrink-0 place-items-center rounded-xl"
                aria-hidden="true"
              >
                <GitMerge size={20} strokeWidth={1.6} />
              </span>
              <div className="min-w-0 flex-1">
                <DialogTitle className="!text-[18px] !font-semibold !tracking-tight">
                  新建本地合并请求
                </DialogTitle>
                <DialogDescription className="!mt-1.5 !text-xs !leading-5">
                  在独立工作树中准备合并，审阅后再更新本地目标。
                </DialogDescription>
              </div>
              <Button
                type="button"
                iconOnly
                variant="ghost"
                size="md"
                aria-label="关闭新建合并请求"
                onClick={onClose}
                disabled={busy}
              >
                <X size={17} aria-hidden="true" />
              </Button>
            </header>
            <div className="mr-compose-scroll min-h-0 overflow-y-auto overscroll-contain px-6 pb-6 sm:px-7">
              <fieldset
                disabled={busy}
                className="m-0 grid min-w-0 gap-5 border-0 p-0"
              >
                {roots.length > 1 && (
                  <label className="mr-compose-field">
                    仓库
                    <select
                      className="mr-compose-input"
                      value={rootId}
                      onChange={(event) => {
                        onRootChange(event.target.value);
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
                  className="mr-compose-flow"
                  role="group"
                  aria-label="源分支合入目标分支"
                >
                  <section className="mr-compose-source min-w-0 rounded-2xl p-4">
                    <div className="flex items-center gap-2 text-[13px] font-medium">
                      <GitBranch size={15} aria-hidden="true" />
                      <h3>源分支</h3>
                      {sources.length > 0 && (
                        <span className="mr-compose-count ml-auto">
                          {sources.length}
                        </span>
                      )}
                    </div>
                    {!sources.length ? (
                      <div className="mr-compose-source-empty flex min-h-24 flex-col items-center justify-center gap-1.5 py-4 text-center">
                        <span className="text-xs">还未添加源分支</span>
                        <span className="text-[11px]">
                          {target
                            ? "从分支列表选择要合入的改动"
                            : "先选择目标分支"}
                        </span>
                      </div>
                    ) : (
                      <ol className="mr-compose-queue my-3 grid gap-1.5">
                        {sources.map((source, index) => {
                          const metadata = context?.branches.find(
                            (branch) => branch.name === source,
                          );
                          const invalid = invalidSources.find(
                            (branch) => branch.name === source,
                          );
                          return (
                            <li
                              key={source}
                              data-invalid={Boolean(invalid)}
                              className="flex min-w-0 items-center gap-2 rounded-xl p-2"
                            >
                              <span className="mr-compose-order grid size-5 shrink-0 place-items-center rounded-full text-[10px]">
                                {index + 1}
                              </span>
                              <div className="min-w-0 flex-1">
                                <strong
                                  className="block truncate text-xs font-medium"
                                  title={source}
                                >
                                  {source}
                                </strong>
                                {metadata && (
                                  <span
                                    className="mr-compose-ancestor mt-1 block truncate text-[10px]"
                                    title={ancestorLabel(metadata)}
                                  >
                                    {ancestorLabel(metadata)}
                                  </span>
                                )}
                                {invalid && (
                                  <span className="mt-1 block text-[11px] text-[var(--theme-danger)]">
                                    {invalid.detail}
                                  </span>
                                )}
                              </div>
                              <div className="flex shrink-0 items-center gap-0.5">
                                <Button
                                  type="button"
                                  iconOnly
                                  size="xs"
                                  variant="ghost"
                                  disabled={busy || index === 0}
                                  aria-label={`上移 ${source}`}
                                  onClick={() =>
                                    setSources(moveSource(sources, index, -1))
                                  }
                                >
                                  <ArrowUp size={12} />
                                </Button>
                                <Button
                                  type="button"
                                  iconOnly
                                  size="xs"
                                  variant="ghost"
                                  disabled={
                                    busy || index === sources.length - 1
                                  }
                                  aria-label={`下移 ${source}`}
                                  onClick={() =>
                                    setSources(moveSource(sources, index, 1))
                                  }
                                >
                                  <ArrowDown size={12} />
                                </Button>
                                <Button
                                  type="button"
                                  iconOnly
                                  size="xs"
                                  variant="ghost"
                                  disabled={busy}
                                  aria-label={`移除 ${source}`}
                                  onClick={() =>
                                    setSources(
                                      sources.filter((item) => item !== source),
                                    )
                                  }
                                >
                                  <X size={12} />
                                </Button>
                              </div>
                            </li>
                          );
                        })}
                      </ol>
                    )}
                    <BranchSourcePicker
                      key={target}
                      branches={availableBranches}
                      selected={sources}
                      loading={checkingBranches}
                      disabled={busy || !target || sources.length >= 30}
                      error={eligibilityError}
                      onRetry={() => setRetry((value) => value + 1)}
                      onAdd={(name) => {
                        if (
                          context?.branches.find(
                            (branch) => branch.name === name,
                          )?.enabled &&
                          !sources.includes(name)
                        )
                          setSources([...sources, name]);
                      }}
                    />
                    {sources.length > 1 && (
                      <p className="mt-2 text-[10px] text-[var(--ui-subtle)]">
                        按队列顺序，从上到下合入
                      </p>
                    )}
                  </section>
                  <div
                    className="mr-compose-direction grid place-items-center"
                    aria-label="合入"
                  >
                    <span className="grid size-8 place-items-center rounded-full border border-[var(--ui-line)] bg-[var(--ui-panel)]">
                      <ArrowRight size={16} aria-hidden="true" />
                    </span>
                  </div>
                  <section className="mr-compose-target min-w-0 rounded-2xl border border-[var(--ui-line)] p-4">
                    <label className="mr-compose-field">
                      <span className="flex items-center gap-2 text-[13px]">
                        <GitMerge size={15} aria-hidden="true" />
                        目标分支
                      </span>
                      <span className="relative mt-3 block">
                        <select
                          data-autofocus
                          aria-label="目标分支"
                          className="mr-compose-input w-full appearance-none !pr-9"
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
                        <ChevronDown
                          size={14}
                          aria-hidden="true"
                          className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-[var(--ui-subtle)]"
                        />
                      </span>
                    </label>
                    <p className="mt-3 text-[11px] leading-5 text-[var(--ui-subtle)]">
                      接收所选源分支的累计结果
                    </p>
                    {selectedTarget && (
                      <code className="mt-2 block text-[10px] text-[var(--ui-subtle)]">
                        HEAD{" "}
                        {(context?.targetOid ?? selectedTarget.head).slice(
                          0,
                          8,
                        )}
                      </code>
                    )}
                  </section>
                </div>
                {eligibilityError && (
                  <div className="mr-compose-notice" role="alert">
                    <span>{eligibilityError}</span>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setRetry((value) => value + 1)}
                    >
                      重试
                    </Button>
                  </div>
                )}
                {invalidSources.length > 0 && (
                  <p className="mr-compose-notice" role="alert">
                    请移除不可合入的源分支。
                  </p>
                )}
                <fieldset className="mr-compose-strategy m-0 min-w-0 border-0 p-0">
                  <legend className="mb-2.5 text-xs font-medium">
                    合并策略
                  </legend>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                    {strategies.map((option) => {
                      const Icon = option.icon;
                      return (
                        <label
                          key={option.value}
                          className="mr-strategy-option relative flex min-w-0 cursor-pointer flex-col gap-2 rounded-xl border p-3"
                          data-selected={strategy === option.value}
                        >
                          <input
                            className="peer sr-only"
                            type="radio"
                            name="mergeStrategy"
                            value={option.value}
                            checked={strategy === option.value}
                            onChange={() => setStrategy(option.value)}
                            aria-label={option.label}
                            disabled={busy}
                          />
                          <span className="flex items-center gap-2 text-xs font-medium">
                            <Icon size={14} aria-hidden="true" />
                            {option.label}
                            <span
                              className="mr-strategy-dot ml-auto size-3 shrink-0 rounded-full border"
                              aria-hidden="true"
                            />
                          </span>
                          <span className="text-[10px] leading-4 text-[var(--ui-subtle)]">
                            {option.description}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </fieldset>
                <details className="mr-compose-advanced group rounded-xl border border-[var(--ui-line)]">
                  <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-xs font-medium">
                    <ChevronRight
                      size={14}
                      className="transition-transform group-open:rotate-90 motion-reduce:transition-none"
                      aria-hidden="true"
                    />
                    <span>更多设置</span>
                    <span className="ml-auto text-[11px] font-normal text-[var(--ui-subtle)]">
                      标题、检查和自动化
                    </span>
                  </summary>
                  <div className="grid gap-5 border-t border-[var(--ui-line)] p-4">
                    <label className="mr-compose-field">
                      标题（可选）
                      <input
                        className="mr-compose-input"
                        value={title}
                        onChange={(event) => setTitle(event.target.value)}
                        placeholder={
                          sources.length && target
                            ? `${sources.join("、")} → ${target}`
                            : "自动使用源分支与目标分支生成标题"
                        }
                        maxLength={200}
                      />
                    </label>
                    {selectedTarget?.checkedOutPath && (
                      <p className="mr-compose-notice !text-[11px]">
                        目标当前检出于{" "}
                        <code className="break-all">
                          {selectedTarget.checkedOutPath}
                        </code>
                        。
                      </p>
                    )}
                    <label className="mr-compose-check">
                      <input
                        type="checkbox"
                        checked={allowCheckedOutTarget}
                        onChange={(event) =>
                          setAllowCheckedOutTarget(event.target.checked)
                        }
                      />
                      <span>允许更新已检出的目标分支</span>
                    </label>
                    <section className="grid gap-3" aria-label="验证检查">
                      <div className="flex items-center justify-between gap-3">
                        <h3 className="text-xs font-medium">验证检查</h3>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={busy}
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
                          <Plus size={13} aria-hidden="true" />
                          添加检查
                        </Button>
                      </div>
                      <p className="text-[11px] leading-5 text-[var(--ui-subtle)]">
                        在候选工作树中执行，全部通过后才能自动更新目标。
                      </p>
                      {checks.map((check, index) => (
                        <div
                          className="mr-compose-check-row rounded-xl bg-[var(--ui-panel-soft)] p-3"
                          key={check.id}
                        >
                          <label className="mr-compose-field">
                            程序 {index + 1}
                            <input
                              className="mr-compose-input"
                              value={check.executable}
                              placeholder="npm"
                              required
                              onChange={(event) =>
                                setChecks(
                                  checks.map((item) =>
                                    item.id === check.id
                                      ? {
                                          ...item,
                                          executable: event.target.value,
                                        }
                                      : item,
                                  ),
                                )
                              }
                            />
                          </label>
                          <label className="mr-compose-field">
                            参数（JSON 数组）
                            <input
                              className="mr-compose-input font-mono"
                              value={check.args}
                              placeholder={'["test"]'}
                              required
                              onChange={(event) =>
                                setChecks(
                                  checks.map((item) =>
                                    item.id === check.id
                                      ? { ...item, args: event.target.value }
                                      : item,
                                  ),
                                )
                              }
                            />
                          </label>
                          <label className="mr-compose-field">
                            超时（秒）
                            <input
                              className="mr-compose-input"
                              type="number"
                              min="1"
                              max="600"
                              value={check.timeout}
                              required
                              onChange={(event) =>
                                setChecks(
                                  checks.map((item) =>
                                    item.id === check.id
                                      ? { ...item, timeout: event.target.value }
                                      : item,
                                  ),
                                )
                              }
                            />
                          </label>
                          <Button
                            type="button"
                            variant="ghost"
                            iconOnly
                            size="md"
                            disabled={busy}
                            aria-label={`移除检查 ${index + 1}`}
                            onClick={() =>
                              setChecks(
                                checks.filter((item) => item.id !== check.id),
                              )
                            }
                          >
                            <X size={14} />
                          </Button>
                        </div>
                      ))}
                    </section>
                    <label className="mr-compose-check">
                      <input
                        type="checkbox"
                        checked={savePreset}
                        onChange={(event) =>
                          setSavePreset(event.target.checked)
                        }
                      />
                      <span>保存为一键预设</span>
                    </label>
                    {savePreset && (
                      <div className="grid gap-4 rounded-xl bg-[var(--ui-panel-soft)] p-4">
                        <label className="mr-compose-field">
                          预设名称
                          <input
                            className="mr-compose-input"
                            value={presetName}
                            onChange={(event) =>
                              setPresetName(event.target.value)
                            }
                            maxLength={120}
                            required
                          />
                        </label>
                        <label className="mr-compose-check">
                          <input
                            type="checkbox"
                            checked={autoFinalize}
                            onChange={(event) =>
                              setAutoFinalize(event.target.checked)
                            }
                          />
                          <span>检查通过后自动合入</span>
                        </label>
                      </div>
                    )}
                  </div>
                </details>
              </fieldset>
              {error && (
                <p role="alert" className="mr-compose-notice mt-4">
                  {error}
                </p>
              )}
            </div>
            <footer className="mr-compose-footer flex shrink-0 flex-wrap items-center gap-3 border-t border-[var(--ui-line)] px-6 py-4 sm:px-7">
              <span className="mr-compose-safety mr-auto inline-flex items-center gap-1.5 text-[11px] text-[var(--ui-subtle)]">
                <ShieldCheck size={14} aria-hidden="true" />
                不会推送远端或删除源分支
              </span>
              <div className="ml-auto flex items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="lg"
                  className="!rounded-xl"
                  onClick={onClose}
                  disabled={busy}
                >
                  取消
                </Button>
                <Button
                  variant="primary"
                  size="lg"
                  className="!rounded-xl"
                  type="submit"
                  pending={busy}
                  disabled={
                    busy ||
                    !workspace ||
                    !context ||
                    !sources.length ||
                    invalidSources.length > 0
                  }
                >
                  {busy ? "正在创建…" : "创建并准备合并"}
                  {!busy && <ArrowRight size={14} aria-hidden="true" />}
                </Button>
              </div>
            </footer>
          </form>
        </DialogPanel>
      </DialogContainer>
    </Dialog>
  );
}
