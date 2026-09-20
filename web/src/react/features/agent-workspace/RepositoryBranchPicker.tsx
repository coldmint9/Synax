import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button, Dropdown } from "@heroui/react";
import {
  Check,
  ChevronDown,
  Folder,
  GitBranch,
  LoaderCircle,
} from "lucide-react";
import {
  agentRuntimeApi,
  type SessionGitBranches,
} from "../../../lib/api/agentRuntime";
import { useLocale } from "../../../hooks/useLocale";
import { refreshWorkspace } from "./workspaceRefresh";
import {
  groupBranchDirectories,
  type BranchDirectoryEntry,
} from "./branchDirectory";

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
  function renderEntries(entries: BranchDirectoryEntry[]): ReactNode[] {
    return entries.map((entry) => {
      if (entry.kind === "directory") {
        return (
          <Dropdown.SubmenuTrigger key={`directory:${entry.path}`}>
            <Dropdown.Item
              id={`directory:${entry.path}`}
              textValue={entry.label}
            >
              <Folder size={13} aria-hidden />
              <span className="ws-branch-name" title={entry.path}>
                {entry.label}
              </span>
              {entry.current && (
                <Check
                  size={13}
                  aria-label={zh ? "包含当前分支" : "Contains current branch"}
                />
              )}
              <Dropdown.SubmenuIndicator />
            </Dropdown.Item>
            <Dropdown.Popover className="ws-branch-popover">
              <Dropdown.Menu
                aria-label={`${zh ? "分支目录" : "Branch directory"}: ${entry.path}`}
              >
                {renderEntries(entry.children)}
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown.SubmenuTrigger>
        );
      }
      const item = entry.branch;
      return (
        <Dropdown.Item
          key={item.name}
          id={item.name}
          textValue={entry.label}
          isDisabled={item.occupied || switching}
          onAction={() => void select(item.name)}
        >
          <span className="ws-branch-name" title={item.name}>
            {entry.label}
          </span>
          {item.current && (
            <Check size={13} aria-label={zh ? "当前分支" : "Current branch"} />
          )}
          {item.occupied && (
            <small>{zh ? "已被工作树占用" : "In another worktree"}</small>
          )}
        </Dropdown.Item>
      );
    });
  }
  return (
    <>
      <Dropdown
        isOpen={open}
        onOpenChange={(value) => {
          setOpen(value);
          if (value) void load();
        }}
      >
        <Button
          size="sm"
          variant="ghost"
          className="ws-branch-trigger"
          isDisabled={disabled || switching}
          aria-label={`${zh ? "切换 Git 分支" : "Switch Git branch"}: ${branch || "HEAD"}`}
        >
          {switching ? (
            <LoaderCircle size={12} className="animate-spin" />
          ) : (
            <GitBranch size={12} />
          )}
          <span>{branch || "HEAD"}</span>
          <ChevronDown size={10} />
        </Button>
        <Dropdown.Popover
          className="ws-branch-popover"
          placement="bottom start"
        >
          <Dropdown.Menu aria-label={zh ? "Git 分支" : "Git branches"}>
            {loading || !data?.branches.length ? (
              <Dropdown.Item id="loading" isDisabled textValue="loading">
                {loading
                  ? zh
                    ? "加载分支…"
                    : "Loading branches…"
                  : zh
                    ? "没有可切换的本地分支"
                    : "No local branches"}
              </Dropdown.Item>
            ) : (
              renderEntries(groupBranchDirectories(data.branches))
            )}
          </Dropdown.Menu>
          {error && open && (
            <p role="alert" className="ws-branch-error">
              {error}
            </p>
          )}
        </Dropdown.Popover>
      </Dropdown>
      {error && !open && (
        <p role="alert" className="ws-branch-error">
          {error}
        </p>
      )}
    </>
  );
}
