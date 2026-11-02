import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import {
  Combobox,
  ComboboxInput,
  ComboboxOption,
  ComboboxOptions,
} from "@headlessui/react";
import {
  Popover,
  PopoverButton,
  PopoverPanel,
} from "@/shared/ui/ui/Popover";
import {
  Check,
  Cloud,
  GitBranch,
  GitMerge,
  LoaderCircle,
  Plus,
  Search,
  X,
} from "lucide-react";
import { AlertDialog, DialogContainer, DialogPanel, DialogTitle, DialogBody, DialogFooter } from "@/shared/ui/ui/Dialog";
import { Button } from "@/shared/ui/ui/Button";
import {
  agentRuntimeApi,
  type SessionGitBranches,
} from "../../adapters/transport/agentRuntime";
import { useLocale } from "../../shared/hooks/useLocale";
import { refreshWorkspace } from "./workspaceRefresh";
import { fetchStaleResource, readStaleResource, writeStaleResource } from "../../shared/lib/staleResource";
import { useOptionalContextMenu } from "../../shared/ui/context-menu/ContextMenuProvider";

interface Props {
  sessionId: string;
  rootId?: string;
  branch: string;
  disabled?: boolean;
  onSwitched: () => void;
  openRequest?: number;
}

export function RepositoryBranchPicker(props: Props) {
  return (
    <Popover key={`${props.sessionId}:${props.rootId ?? ""}`}>
      {({ open, close }) => (
        <BranchPickerContent {...props} open={open} close={close} />
      )}
    </Popover>
  );
}

function BranchPickerContent({
  sessionId,
  rootId,
  branch,
  disabled,
  onSwitched,
  openRequest,
  open,
  close,
}: Props & { open: boolean; close: () => void }) {
  const { locale } = useLocale();
  const zh = locale === "zh";
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [newBranch, setNewBranch] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const lastOpenRequest = useRef<number | undefined>(undefined);
  const cacheKey = `session-git-branches:${sessionId}:${rootId ?? ""}`;
  const [data, setData] = useState<SessionGitBranches | null>(() =>
    readStaleResource<SessionGitBranches>(cacheKey) ?? null,
  );
  const [loading, setLoading] = useState(() =>
    readStaleResource<SessionGitBranches>(cacheKey) === undefined,
  );
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [mergeOutcome, setMergeOutcome] = useState<string | null>(null);
  const generation = useRef(0);
  const mutating = useRef(false);

  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  useEffect(() => {
    if (disabled && open) close();
  }, [disabled, open, close]);
  useEffect(() => {
    if (!openRequest || lastOpenRequest.current === openRequest) return;
    lastOpenRequest.current = openRequest;
    // Open through the real trigger, not a second controlled overlay state.
    if (!open && !disabled && !switching) trigger.current?.click();
  }, [openRequest, open, disabled, switching]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setQuery("");
    setCreating(false);
    setNewBranch("");
    setCreateError(null);
    const cached = readStaleResource<SessionGitBranches>(cacheKey);
    setData(cached ?? null);
    setLoading(cached === undefined);
    setError(null);
    void fetchStaleResource(cacheKey, () =>
      agentRuntimeApi.listSessionBranches(sessionId, rootId),
    )
      .then((result) => {
        if (active) setData(result);
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [open, sessionId, rootId, cacheKey]);

  async function select(name: string | null) {
    if (!name || disabled || mutating.current) return;
    // A remote entry is a remote-tracking ref: the server checks it out as the
    // local branch it tracks, so it has no local state to compare here.
    const remote =
      data?.remoteBranches?.find((item) => item.name === name) ?? null;
    const option = remote
      ? null
      : data?.branches.find((item) => item.name === name);
    if (!remote && (!option || option.occupied)) return;
    if (!remote && name === data?.current) {
      close();
      return;
    }
    const transferChanges = Boolean(data?.dirtyFileCount);
    if (
      transferChanges &&
      !window.confirm(
        remote
          ? zh
            ? `当前有 ${data?.dirtyFileCount} 个未提交文件。是否将它们带到从“${remote.name}”签出的本地分支“${remote.branch}”？`
            : `There are ${data?.dirtyFileCount} uncommitted files. Carry them onto “${remote.branch}”, checked out from “${remote.name}”?`
          : zh
            ? `当前有 ${data?.dirtyFileCount} 个未提交文件。是否将这些改动转移到分支“${name}”？`
            : `There are ${data?.dirtyFileCount} uncommitted files. Transfer them to “${name}”?`,
      )
    )
      return;
    close();
    const request = ++generation.current;
    mutating.current = true;
    setSwitching(true);
    setSwitchError(null);
    try {
      const result = await agentRuntimeApi.switchSessionBranch(
        sessionId,
        name,
        rootId,
        transferChanges,
        Boolean(remote),
      );
      if (request === generation.current) {
        writeStaleResource(cacheKey, result);
        setData(result);
        refreshWorkspace(sessionId, rootId);
        onSwitched();
      }
    } catch (err) {
      if (request === generation.current) {
        setSwitchError(err instanceof Error ? err.message : String(err));
        // A failed stash restore can leave HEAD on the requested branch.
        refreshWorkspace(sessionId, rootId);
        onSwitched();
      }
    } finally {
      mutating.current = false;
      if (request === generation.current) setSwitching(false);
    }
  }

  async function createBranch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = newBranch.trim();
    if (!name || disabled || mutating.current) return;
    if (name !== newBranch) {
      setCreateError(zh ? "分支名称不能包含首尾空格" : "Remove leading or trailing spaces");
      return;
    }
    if (data?.branches.some((item) => item.name === name)) {
      setCreateError(zh ? "该分支已存在" : "Branch already exists");
      return;
    }
    const request = ++generation.current;
    mutating.current = true;
    setSwitching(true);
    setCreateError(null);
    try {
      const result = await agentRuntimeApi.createSessionBranch(
        sessionId,
        name,
        rootId,
      );
      if (request === generation.current) {
        writeStaleResource(cacheKey, result);
        setData(result);
        refreshWorkspace(sessionId, rootId);
        close();
        onSwitched();
      }
    } catch (err) {
      if (request === generation.current)
        setCreateError(err instanceof Error ? err.message : String(err));
    } finally {
      mutating.current = false;
      if (request === generation.current) setSwitching(false);
    }
  }

  /** Ordinary local merge from the branch right-click menu. Working-tree
   * conflicts stay where Git left them; the notice names the files. */
  async function mergeBranch(source: string) {
    if (disabled || mutating.current) return;
    const target = data?.current;
    if (!target || target === source) return;
    if (data?.dirtyFileCount) {
      setSwitchError(
        zh
          ? "工作区有未提交的改动，请先提交后再合并分支。"
          : "Commit uncommitted changes before merging branches.",
      );
      return;
    }
    const request = ++generation.current;
    mutating.current = true;
    setSwitching(true);
    setSwitchError(null);
    try {
      const result = await agentRuntimeApi.mergeSessionBranch(
        sessionId,
        source,
        rootId,
      );
      if (request !== generation.current) return;
      writeStaleResource(cacheKey, result);
      setData(result);
      refreshWorkspace(sessionId, rootId);
      onSwitched();
      const merged = result.merged;
      if (merged.status === "conflicted")
        setSwitchError(
          zh
            ? `已将 ${source} 合并到 ${target}，但存在 ${merged.files.length} 个冲突文件：\n${merged.files
                .slice(0, 20)
                .join("\n")}\n冲突标记保留在工作区，解决后提交即可。`
            : `Merged ${source} into ${target} with ${merged.files.length} conflicting files:\n${merged.files
                .slice(0, 20)
                .join("\n")}`,
        );
      else
        setMergeOutcome(
          merged.status === "merged"
            ? zh
              ? `已将 ${source} 合并到 ${target}`
              : `Merged ${source} into ${target}`
            : zh
              ? `${source} 已包含在 ${target} 中`
              : `${source} is already part of ${target}`,
        );
    } catch (err) {
      if (request === generation.current)
        setSwitchError(err instanceof Error ? err.message : String(err));
    } finally {
      mutating.current = false;
      if (request === generation.current) setSwitching(false);
    }
  }

  const headingId = useId();
  // One query filters both sections, so a name never has to be retyped to look
  // across local and remote branches.
  const search = query.trim().toLocaleLowerCase();
  const matches = (name: string) => name.toLocaleLowerCase().includes(search);
  const localBranches =
    data?.branches
      .filter((item) => matches(item.name))
      .sort((a, b) => {
        const rank = (item: typeof a) =>
          item.name === "main" || item.name === "master"
            ? 0
            : item.current
              ? 1
              : 2;
        return rank(a) - rank(b) || a.name.localeCompare(b.name);
      }) ?? [];
  const remoteBranches = (data?.remoteBranches ?? [])
    .filter((item) => matches(item.name) || matches(item.branch))
    .sort((a, b) => a.name.localeCompare(b.name));
  const visibleCount = localBranches.length + remoteBranches.length;
  const baseBranch = data?.current || null;
  const searchLabel = zh ? "搜索分支" : "Search branches";
  return (
    <>
      <PopoverButton
        ref={trigger}
        className="ws-branch-trigger"
        disabled={disabled || switching}
        title={branch || "HEAD"}
        aria-label={`${zh ? "切换 Git 分支" : "Switch Git branch"}: ${branch || "HEAD"}`}
      >
        <span className="ws-branch-icon" aria-hidden="true">
          {switching ? (
            <LoaderCircle size={12} className="animate-spin" />
          ) : (
            <GitBranch size={12} />
          )}
        </span>
        <span className="ws-branch-label">{branch || "HEAD"}</span>
      </PopoverButton>
      <PopoverPanel
        onKeyDownCapture={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            close();
          }
        }}
        className="ws-branch-popover"
        anchor={{ to: "bottom start", gap: 6, padding: 8 }}
        focus
        role="dialog"
        aria-label={zh ? "切换 Git 分支" : "Switch Git branch"}
      >
        <Combobox
          value={data?.current ?? null}
          onChange={(name) => void select(name)}
          immediate
          disabled={disabled || switching}
        >
          <div className="ws-branch-dialog">
            <label className="ws-branch-search">
              <Search size={15} aria-hidden />
              <ComboboxInput
                autoFocus
                type="search"
                aria-label={searchLabel}
                placeholder={searchLabel}
                displayValue={() => query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <ComboboxOptions
              modal={false}
              static
              className="ws-branch-list"
              aria-label={zh ? "Git 分支" : "Git branches"}
            >
              {!loading && !error && localBranches.length > 0 && (
                <div
                  role="group"
                  aria-labelledby={`${headingId}-local`}
                  className="ws-branch-group"
                >
                  <p id={`${headingId}-local`} className="ws-branch-heading">
                    {zh ? "本地" : "Local"}
                  </p>
                  {localBranches.map((item) => (
                    <LocalBranchOption
                      key={item.name}
                      item={item}
                      zh={zh}
                      dirtyFileCount={data?.dirtyFileCount ?? 0}
                      currentBranch={data?.current ?? ""}
                      switching={switching}
                      onCheckout={(name) => void select(name)}
                      onMerge={(name) => void mergeBranch(name)}
                    />
                  ))}
                </div>
              )}
              {!loading && !error && remoteBranches.length > 0 && (
                <div
                  role="group"
                  aria-labelledby={`${headingId}-remote`}
                  className="ws-branch-group"
                >
                  <p id={`${headingId}-remote`} className="ws-branch-heading">
                    {zh ? "远程" : "Remote"}
                  </p>
                  {remoteBranches.map((item) => (
                    <ComboboxOption
                      key={item.name}
                      value={item.name}
                      aria-label={item.name}
                      aria-description={
                        zh
                          ? `签出为本地分支 ${item.branch}`
                          : `Checks out as local branch ${item.branch}`
                      }
                      disabled={switching}
                      className="ws-branch-option"
                    >
                      <Cloud
                        size={16}
                        className="ws-branch-option-icon"
                        aria-hidden
                      />
                      <span className="ws-branch-copy">
                        <span className="ws-branch-name" title={item.name}>
                          {item.name}
                        </span>
                      </span>
                    </ComboboxOption>
                  ))}
                </div>
              )}
            </ComboboxOptions>
            {loading ? (
              <p role="status" className="ws-branch-empty">
                {zh ? "加载分支…" : "Loading branches…"}
              </p>
            ) : error ? (
              <p role="alert" className="ws-branch-error">
                {error}
              </p>
            ) : (
              !visibleCount && (
                <p role="status" className="ws-branch-empty">
                  {data?.branches.length || data?.remoteBranches?.length
                    ? zh
                      ? "没有匹配的分支"
                      : "No matching branches"
                    : zh
                      ? "没有可切换的分支"
                      : "No branches to check out"}
                </p>
              )
            )}
          </div>
        </Combobox>
        <div className="ws-branch-footer">
          {creating ? (
            <form
              className="ws-branch-create"
              onSubmit={(event) => void createBranch(event)}
            >
              <div className="ws-branch-create-row">
                <input
                  autoFocus
                  aria-label={zh ? "新分支名称" : "New branch name"}
                  placeholder={zh ? "新分支名称" : "New branch name"}
                  value={newBranch}
                  onChange={(event) => {
                    setNewBranch(event.target.value);
                    setCreateError(null);
                  }}
                  disabled={switching}
                  maxLength={1024}
                />
                <button type="submit" disabled={!newBranch.trim() || switching}>
                  {switching ? (
                    <LoaderCircle size={15} className="animate-spin" />
                  ) : (
                    <Check size={15} />
                  )}
                  <span className="sr-only">
                    {zh ? "创建并检出" : "Create and check out"}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setCreating(false);
                    setCreateError(null);
                  }}
                  disabled={switching}
                >
                  <X size={15} />
                  <span className="sr-only">{zh ? "取消" : "Cancel"}</span>
                </button>
              </div>
              {baseBranch && (
                <small>
                  {zh ? `从 ${baseBranch} 创建` : `Create from ${baseBranch}`}
                </small>
              )}
              {createError && (
                <p role="alert" className="ws-branch-create-error">
                  {createError}
                </p>
              )}
            </form>
          ) : (
            <button
              type="button"
              className="ws-branch-create-trigger"
              disabled={loading || Boolean(error) || !baseBranch || switching}
              title={
                !baseBranch && !loading
                  ? zh
                    ? "需要已检出的分支"
                    : "A checked-out branch is required"
                  : undefined
              }
              onClick={() => setCreating(true)}
            >
              <Plus size={17} aria-hidden />
              <span>{zh ? "创建并检出新分支…" : "Create and check out new branch…"}</span>
            </button>
          )}
        </div>
      </PopoverPanel>
      <AlertDialog open={switchError !== null} onClose={() => setSwitchError(null)}>
        <DialogContainer size="md">
          <DialogPanel>
          <DialogTitle>
            {zh ? "分支操作需要处理" : "Branch action needs attention"}
          </DialogTitle>
            <DialogBody>
              <p role="alert" className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{switchError}</p>
            </DialogBody>
            <DialogFooter>
              <Button autoFocus onClick={() => setSwitchError(null)}>
                {zh ? "知道了" : "OK"}
              </Button>
            </DialogFooter>
          </DialogPanel>
        </DialogContainer>
      </AlertDialog>
      <AlertDialog
        open={mergeOutcome !== null}
        onClose={() => setMergeOutcome(null)}
      >
        <DialogContainer size="md">
          <DialogPanel>
            <DialogTitle>{zh ? "分支合并结果" : "Merge result"}</DialogTitle>
            <DialogBody>
              <p role="status" className="flex items-center gap-2">
                <GitMerge size={14} aria-hidden />
                {mergeOutcome}
              </p>
            </DialogBody>
            <DialogFooter>
              <Button autoFocus onClick={() => setMergeOutcome(null)}>
                {zh ? "知道了" : "OK"}
              </Button>
            </DialogFooter>
          </DialogPanel>
        </DialogContainer>
      </AlertDialog>
    </>
  );
}

/** One local branch row. Right-click opens the branch actions: check out, or the
 * ordinary local merge that no longer needs a remote request. */
function LocalBranchOption({
  item,
  zh,
  dirtyFileCount,
  currentBranch,
  switching,
  onCheckout,
  onMerge,
}: {
  item: { name: string; current: boolean; occupied: boolean };
  zh: boolean;
  dirtyFileCount: number;
  currentBranch: string;
  switching: boolean;
  onCheckout: (name: string) => void;
  onMerge: (name: string) => void;
}) {
  const canCheckout = !item.current && !item.occupied;
  const canMerge = canCheckout && dirtyFileCount === 0;
  const menu = useOptionalContextMenu(() => ({
    label: item.name,
    entries: [
      {
        type: "action",
        id: "checkout",
        label: zh ? "签出此分支" : "Check out branch",
        disabled: !canCheckout,
        run: () => onCheckout(item.name),
      },
      {
        type: "action",
        id: "merge",
        label: zh
          ? `合并到 ${currentBranch || "当前分支"}`
          : `Merge into ${currentBranch || "current branch"}`,
        disabled: !canMerge,
        run: () => onMerge(item.name),
      },
    ],
  }));
  return (
    <ComboboxOption
      value={item.name}
      aria-label={item.name}
      aria-description={
        item.occupied
          ? zh
            ? "已被工作树占用"
            : "In another worktree"
          : undefined
      }
      disabled={item.occupied || switching}
      className="ws-branch-option"
      onContextMenu={menu.onContextMenu}
      onKeyDown={menu.onKeyDown}
    >
      <GitBranch size={16} className="ws-branch-option-icon" aria-hidden />
      <span className="ws-branch-copy">
        <span className="ws-branch-name" title={item.name}>
          {item.name}
        </span>
        {item.current && dirtyFileCount > 0 && (
          <small>
            {zh
              ? `未提交：${dirtyFileCount} 个文件`
              : `Uncommitted: ${dirtyFileCount} ${dirtyFileCount === 1 ? "file" : "files"}`}
          </small>
        )}
        {item.occupied && (
          <small>{zh ? "已被工作树占用" : "In another worktree"}</small>
        )}
      </span>
      {item.current && (
        <Check
          size={16}
          className="ws-branch-check"
          aria-label={zh ? "当前分支" : "Current branch"}
        />
      )}
    </ComboboxOption>
  );
}
