import { GitBranch, Globe2, MessageSquare, Tag } from "lucide-react";
import type { GitAssociations } from "../../../../services/local-node/modules/git-epic-contracts";
import {
  Popover,
  PopoverButton,
  PopoverPanel,
} from "../../shared/ui/ui/Popover";
import {
  HistoryContextTarget,
  type HistoryActionSelection,
} from "./GitHistoryActions";

export function GitHistoryRefs({
  refs,
  associations,
  onAction,
  onOpenSessions,
  expanded = false,
}: {
  refs: string[];
  associations: GitAssociations | null;
  onAction: (selection: HistoryActionSelection) => void;
  onOpenSessions?: (ref: string) => void;
  expanded?: boolean;
}) {
  if (!refs.length) return null;
  const renderRef = (ref: string) => {
    const fullRef = ref.startsWith("refs/") ? ref : `refs/heads/${ref}`;
    const count =
      associations?.branches.find((branch) => branch.ref === fullRef)?.sessions
        .length ?? 0;
    const Icon = fullRef.startsWith("refs/tags/")
      ? Tag
      : fullRef.startsWith("refs/remotes/")
        ? Globe2
        : GitBranch;
    return (
      <span className="inline-flex min-w-0 items-center gap-1" key={ref}>
        <HistoryContextTarget target={fullRef} onAction={onAction}>
          <Icon size={12} aria-hidden="true" className="shrink-0" />
          <span className="truncate">
            {ref.replace(/^refs\/(heads|remotes|tags)\//, "")}
          </span>
        </HistoryContextTarget>
        {onOpenSessions && count > 0 && (
          <button
            type="button"
            className="git-control inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] text-[var(--ui-subtle)] hover:bg-[var(--ui-accent-soft)]"
            title={`${count} 个未归档会话`}
            onClick={() => onOpenSessions(fullRef)}
          >
            <MessageSquare size={11} aria-hidden="true" />
            {count}
          </button>
        )}
      </span>
    );
  };
  return (
    <div
      className={`history-tree-ref-list flex min-w-0 items-center gap-1.5 ${expanded ? "flex-wrap" : ""}`}
    >
      {(expanded ? refs : refs.slice(0, 1)).map(renderRef)}
      {!expanded && refs.length > 1 && (
        <Popover className="shrink-0">
          <PopoverButton
            className="git-control h-7 rounded-md px-1.5 text-[11px] text-[var(--ui-subtle)] hover:bg-[var(--ui-accent-soft)]"
            aria-label={`查看另外 ${refs.length - 1} 个引用`}
          >
            +{refs.length - 1}
          </PopoverButton>
          <PopoverPanel className="git-ref-popover flex max-w-80 flex-col gap-2 rounded-2xl p-3 backdrop-blur-[5px]">
            <span className="px-1 text-[11px] text-[var(--ui-subtle)]">
              此提交的引用
            </span>
            {refs.map(renderRef)}
          </PopoverPanel>
        </Popover>
      )}
    </div>
  );
}
