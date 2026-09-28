import { useEffect, useRef, useState, type FormEvent } from "react";
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
} from "@/react/components/ui/Popover";
import { Check, GitBranch, LoaderCircle, Plus, Search, X } from "lucide-react";
import {
  agentRuntimeApi,
  type SessionGitBranches,
} from "../../../lib/api/agentRuntime";
import { useLocale } from "../../../hooks/useLocale";
import { refreshWorkspace } from "./workspaceRefresh";

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
  const [data, setData] = useState<SessionGitBranches | null>(null);
  const [loading, setLoading] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
    setLoading(true);
    setError(null);
    setData(null);
    void agentRuntimeApi
      .listSessionBranches(sessionId, rootId)
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
  }, [open, sessionId, rootId]);

  async function select(name: string | null) {
    if (!name || disabled || mutating.current) return;
    const option = data?.branches.find((item) => item.name === name);
    if (!option || option.occupied) return;
    close();
    if (name === data?.current) return;
    const request = ++generation.current;
    mutating.current = true;
    setSwitching(true);
    setError(null);
    try {
      const result = await agentRuntimeApi.switchSessionBranch(
        sessionId,
        name,
        rootId,
      );
      if (request === generation.current) {
        setData(result);
        refreshWorkspace(sessionId, rootId);
        onSwitched();
      }
    } catch (err) {
      if (request === generation.current)
        setError(err instanceof Error ? err.message : String(err));
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

  const search = query.trim().toLocaleLowerCase();
  const visibleBranches =
    data?.branches
      .filter((item) => item.name.toLocaleLowerCase().includes(search))
      .sort((a, b) => {
        const rank = (item: typeof a) =>
          item.name === "main" || item.name === "master"
            ? 0
            : item.current
              ? 1
              : 2;
        return rank(a) - rank(b) || a.name.localeCompare(b.name);
      }) ?? [];
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
            <p className="ws-branch-heading">{zh ? "分支" : "Branches"}</p>
            <ComboboxOptions
              modal={false}
              static
              className="ws-branch-list"
              aria-label={zh ? "Git 分支" : "Git branches"}
            >
              {!loading &&
                !error &&
                visibleBranches.map((item) => (
                  <ComboboxOption
                    key={item.name}
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
                  >
                    <GitBranch
                      size={16}
                      className="ws-branch-option-icon"
                      aria-hidden
                    />
                    <span className="ws-branch-copy">
                      <span className="ws-branch-name" title={item.name}>
                        {item.name}
                      </span>
                      {item.current && Boolean(data?.dirtyFileCount) && (
                        <small>
                          {zh
                            ? `未提交：${data!.dirtyFileCount} 个文件`
                            : `Uncommitted: ${data!.dirtyFileCount} ${data!.dirtyFileCount === 1 ? "file" : "files"}`}
                        </small>
                      )}
                      {item.occupied && (
                        <small>
                          {zh ? "已被工作树占用" : "In another worktree"}
                        </small>
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
                ))}
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
              !visibleBranches.length && (
                <p role="status" className="ws-branch-empty">
                  {data?.branches.length
                    ? zh
                      ? "没有匹配的分支"
                      : "No matching branches"
                    : zh
                      ? "没有可切换的本地分支"
                      : "No local branches"}
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
      {error && !open && (
        <p role="alert" className="ws-branch-error">
          {error}
        </p>
      )}
    </>
  );
}
