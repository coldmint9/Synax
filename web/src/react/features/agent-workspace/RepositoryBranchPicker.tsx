import { useEffect, useRef, useState } from "react";
import { ListBox, Popover } from "@heroui/react";
import { Check, GitBranch, LoaderCircle, Search } from "lucide-react";
import {
  agentRuntimeApi,
  type SessionGitBranches,
} from "../../../lib/api/agentRuntime";
import { useLocale } from "../../../hooks/useLocale";
import { refreshWorkspace } from "./workspaceRefresh";

export function RepositoryBranchPicker({
  sessionId,
  rootId,
  branch,
  disabled,
  onSwitched,
}: {
  sessionId: string;
  rootId?: string;
  branch: string;
  disabled?: boolean;
  onSwitched: () => void;
}) {
  const { locale } = useLocale();
  const zh = locale === "zh";
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [data, setData] = useState<SessionGitBranches | null>(null);
  const [loading, setLoading] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const mutating = useRef(false);
  useEffect(() => {
    if (!open) return;
    // The dialog restores focus after mounting; focus search after that step.
    const frame = requestAnimationFrame(() => searchRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);
  useEffect(
    () => () => {
      generation.current++;
    },
    [sessionId, rootId],
  );

  async function load() {
    const request = ++generation.current;
    setLoading(true);
    setError(null);
    setData(null);
    try {
      const result = await agentRuntimeApi.listSessionBranches(
        sessionId,
        rootId,
      );
      if (request === generation.current) setData(result);
    } catch (err) {
      if (request === generation.current)
        setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }
  async function select(name: string) {
    if (mutating.current || name === data?.current) return;
    const request = ++generation.current;
    mutating.current = true;
    setSwitching(true);
    setOpen(false);
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
  const search = query.trim().toLocaleLowerCase();
  const visibleBranches =
    data?.branches.filter((item) =>
      item.name.toLocaleLowerCase().includes(search),
    ) ?? [];
  const searchLabel = zh ? "搜索分支" : "Search branches";

  return (
    <>
      <Popover
        isOpen={open}
        onOpenChange={(value) => {
          setOpen(value);
          if (value) {
            setQuery("");
            void load();
          }
        }}
      >
        <Popover.Trigger<"button">
          render={(props) => <button {...props} type="button" />}
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
        </Popover.Trigger>
        <Popover.Content
          className="ws-branch-popover"
          placement="bottom start"
          offset={6}
        >
          <Popover.Dialog
            aria-label={zh ? "切换 Git 分支" : "Switch Git branch"}
            className="ws-branch-dialog"
          >
            <label className="ws-branch-search">
              <Search size={15} aria-hidden />
              <input
                ref={searchRef}
                type="search"
                aria-label={searchLabel}
                placeholder={searchLabel}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "ArrowDown" && event.key !== "ArrowUp")
                    return;
                  const options =
                    listRef.current?.querySelectorAll<HTMLElement>(
                      '[role="option"]:not([aria-disabled="true"])',
                    );
                  if (!options?.length) return;
                  event.preventDefault();
                  options[
                    event.key === "ArrowDown" ? 0 : options.length - 1
                  ].focus();
                }}
              />
            </label>
            <p className="ws-branch-heading">{zh ? "分支" : "Branches"}</p>
            {loading ? (
              <p role="status" className="ws-branch-empty">
                {zh ? "加载分支…" : "Loading branches…"}
              </p>
            ) : error ? (
              <p role="alert" className="ws-branch-error">
                {error}
              </p>
            ) : visibleBranches.length ? (
              <ListBox
                ref={listRef}
                className="ws-branch-list"
                aria-label={zh ? "Git 分支" : "Git branches"}
                selectionMode="single"
                selectionBehavior="replace"
                selectedKeys={new Set(data?.current ? [data.current] : [])}
                onAction={(key) => void select(String(key))}
              >
                {visibleBranches.map((item) => (
                  <ListBox.Item
                    key={item.name}
                    id={item.name}
                    textValue={item.name}
                    aria-label={item.name}
                    aria-description={
                      item.occupied
                        ? zh
                          ? "已被工作树占用"
                          : "In another worktree"
                        : undefined
                    }
                    isDisabled={item.occupied || switching}
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
                  </ListBox.Item>
                ))}
              </ListBox>
            ) : (
              <p role="status" className="ws-branch-empty">
                {data?.branches.length
                  ? zh
                    ? "没有匹配的分支"
                    : "No matching branches"
                  : zh
                    ? "没有可切换的本地分支"
                    : "No local branches"}
              </p>
            )}
          </Popover.Dialog>
        </Popover.Content>
      </Popover>
      {error && !open && (
        <p role="alert" className="ws-branch-error">
          {error}
        </p>
      )}
    </>
  );
}
