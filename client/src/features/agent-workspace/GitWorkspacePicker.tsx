import { useEffect, useMemo, useState } from "react";
import {
  Combobox,
  ComboboxInput,
  ComboboxOption,
  ComboboxOptions,
  type PopoverPanelProps,
} from "@headlessui/react";
import { Popover, PopoverButton, PopoverPanel } from "@/shared/ui/ui/Popover";
import { Tooltip } from "@/shared/ui/ui/Tooltip";
import { Check, GitBranch, GitFork, LoaderCircle, Search } from "lucide-react";
import type { GitWorkspaceSelection } from "../../adapters/transport/agentRuntime";
import { projectApi, type GitWorkspaceSummary } from "../../adapters/transport/project";
import { useLocale } from "../../shared/hooks/useLocale";
import "./agentControls.css";
import "./workspaceHill.css";

interface Props {
  projectId: string;
  value: GitWorkspaceSelection;
  disabled: boolean;
  onChange: (selection: GitWorkspaceSelection) => void;
  /** "hill" docks the trigger on the composer's top edge; "chip" keeps the toolbar chip. */
  variant?: "chip" | "hill";
  /** Overrides the panel anchor. The mound opens downwards so it clears the welcome title. */
  panelAnchor?: PopoverPanelProps<"div">["anchor"];
}

type WorkspaceOption = {
  id: string;
  label: string;
  detail: string;
  meta: string;
  group: "new" | "default" | "worktree" | "branch";
};

function selectionId(selection: GitWorkspaceSelection): string {
  if (selection.kind === "default") return "default";
  if (selection.kind === "new-worktree") return "new-worktree";
  return selection.kind === "branch"
    ? `branch:${selection.branch}`
    : `worktree:${selection.path}`;
}

function selectionFromId(id: string): GitWorkspaceSelection | null {
  if (id === "default") return { kind: "default" };
  if (id === "new-worktree") return { kind: "new-worktree" };
  if (id.startsWith("branch:"))
    return { kind: "branch", branch: id.slice("branch:".length) };
  if (id.startsWith("worktree:"))
    return { kind: "worktree", path: id.slice("worktree:".length) };
  return null;
}

export function GitWorkspacePicker(props: Props) {
  return (
    <Popover key={props.projectId}>
      {({ open, close }) => (
        <GitWorkspacePickerContent {...props} open={open} close={close} />
      )}
    </Popover>
  );
}

function GitWorkspacePickerContent({
  projectId,
  value,
  disabled,
  onChange,
  variant = "chip",
  panelAnchor,
  open,
  close,
}: Props & { open: boolean; close: () => void }) {
  const { locale } = useLocale();
  const zh = locale === "zh";
  const isHill = variant === "hill";
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState<GitWorkspaceSummary | null>(null);

  useEffect(() => {
    if (open) setQuery("");
  }, [open]);
  useEffect(() => {
    if (disabled && open) close();
  }, [disabled, open, close]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setSummary(null);
    void projectApi
      .listGitWorkspaces(projectId)
      .then((result) => {
        if (active) setSummary(result);
      })
      .catch(() => {
        if (active) setSummary(null);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [projectId]);

  const options = useMemo<WorkspaceOption[]>(() => {
    if (!summary) return [];
    const worktrees: WorkspaceOption[] = summary.worktrees
      .filter((item) => !item.prunable)
      .map((item) => ({
      id: `worktree:${item.path}`,
      label: item.branch ?? item.head.slice(0, 8),
      detail: item.path,
      meta: [
        item.primary
          ? zh ? "主工作树" : "Primary worktree"
          : zh ? "工作树" : "Worktree",
        item.detached ? (zh ? "尚未创建分支" : "No branch yet") : null,
        `HEAD ${item.head.slice(0, 8)}`,
        item.dirty ? (zh ? "有未提交修改" : "Dirty") : null,
      ].filter(Boolean).join(" · "),
      group: "worktree",
    }));
    const branches: WorkspaceOption[] = summary.branches
      .filter((item) => !item.checkedOutPath)
      .map((item) => ({
        id: `branch:${item.name}`,
        label: item.name,
        detail: zh ? "新会话将使用托管工作树" : "A managed worktree will be used",
        meta: item.upstream ?? `HEAD ${item.head.slice(0, 8)}`,
        group: "branch",
      }));
    return [
      {
        id: "new-worktree",
        label: zh ? "新工作树上开始" : "Start in a new worktree",
        detail: zh ? "从当前 HEAD 创建，暂不创建分支" : "From current HEAD · no branch yet",
        meta: "",
        group: "new",
      },
      {
        id: "default",
        label: zh ? "项目默认工作区" : "Project default",
        detail: summary.defaultPath,
        meta: zh ? "项目配置的默认目录" : "Project configured default",
        group: "default",
      },
      ...worktrees,
      ...branches,
    ];
  }, [summary, zh]);

  if (!loading && !summary) return null;
  const selectedId = selectionId(value);
  const selected = options.find((option) => option.id === selectedId);
  const label = selected?.label ?? (zh ? "项目默认工作区" : "Project default");
  const search = query.trim().toLocaleLowerCase();
  const filtered = options.filter((option) =>
    `${option.label} ${option.meta} ${option.detail}`.toLocaleLowerCase().includes(search),
  );
  const groups = ["new", "default", "worktree", "branch"] as const;
  const headings = {
    new: "",
    default: zh ? "工作区" : "Workspace",
    worktree: zh ? "工作树" : "Worktrees",
    branch: zh ? "可用分支" : "Available branches",
  };

  return (
    <>
      <Tooltip
        delay={400}
        content={<>{zh ? "选择新会话的工作区" : "Choose a workspace for this session"}</>}
      >
        <PopoverButton
          disabled={disabled || loading}
          aria-label={zh ? "Git 工作区" : "Git workspace"}
          className={
            isHill
              ? "workspace-hill"
              : "agent-dock-composer-chip agent-mode-trigger"
          }
        >
          {loading ? (
            <LoaderCircle
              size={isHill ? 13 : 11}
              className="animate-spin"
              aria-hidden
            />
          ) : (
            <GitBranch size={isHill ? 13 : 11} aria-hidden />
          )}
          <span>{label}</span>
        </PopoverButton>
      </Tooltip>
      <PopoverPanel
        anchor={
          panelAnchor ??
          (isHill
            ? { to: "bottom start", gap: 10, padding: 8 }
            : { to: "top end", gap: 8, padding: 8 })
        }
        focus
        role="dialog"
        aria-label={zh ? "Git 工作区" : "Git workspace"}
        className="git-workspace-popover"
        onKeyDownCapture={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            close();
          }
        }}
      >
        <Combobox
          value={selectedId}
          onChange={(id) => {
            const next = selectionFromId(id ?? "");
            if (!next || disabled) return;
            close();
            onChange(next);
          }}
          immediate
          disabled={disabled || loading}
        >
          <div className="git-workspace-search">
            <Search size={15} aria-hidden />
            <ComboboxInput
              autoFocus
              type="search"
              aria-label={zh ? "搜索工作区" : "Search workspaces"}
              placeholder={zh ? "搜索工作区或分支" : "Search workspaces or branches"}
              displayValue={() => query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <ComboboxOptions
            static
            modal={false}
            aria-label={zh ? "工作区选项" : "Workspace options"}
            className="git-workspace-list"
          >
            {groups.map((group) => {
              const items = filtered.filter((item) => item.group === group);
              if (!items.length) return null;
              return (
                <div key={group} className="git-workspace-group" role="presentation">
                  {headings[group] && <p className="git-workspace-heading">{headings[group]}</p>}
                  {items.map((option) => (
                    <ComboboxOption
                      key={option.id}
                      value={option.id}
                      aria-label={option.label}
                      className="git-workspace-option"
                    >
                      {({ selected: isSelected }) => (
                        <>
                          {option.group === "new" ? (
                            <GitFork size={16} aria-hidden className="git-workspace-option-icon" />
                          ) : (
                            <GitBranch size={16} aria-hidden className="git-workspace-option-icon" />
                          )}
                          <span className="git-workspace-option-copy">
                            <span className="git-workspace-option-label" title={option.label}>
                              {option.label}
                            </span>
                            <small title={option.detail}>{option.detail}</small>
                            {option.meta && <small>{option.meta}</small>}
                          </span>
                          {isSelected && <Check size={16} aria-label={zh ? "当前选择" : "Selected"} className="git-workspace-check" />}
                        </>
                      )}
                    </ComboboxOption>
                  ))}
                </div>
              );
            })}
          </ComboboxOptions>
          {!filtered.length && !loading && (
            <p role="status" className="git-workspace-empty">
              {zh ? "没有匹配的工作区" : "No matching workspaces"}
            </p>
          )}
        </Combobox>
      </PopoverPanel>
    </>
  );
}
