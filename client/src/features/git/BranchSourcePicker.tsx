import { useId, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  GitBranch,
  Loader2,
  Search,
  X,
} from "lucide-react";
import type { MergeBranchCandidate } from "../../../../services/local-node/modules/git-mr/contracts";
import {
  Popover,
  PopoverButton,
  PopoverPanel,
} from "../../shared/ui/ui/Popover";
import { Button } from "../../shared/ui/ui/Button";
export function ancestorLabel(branch: MergeBranchCandidate): string {
  const ancestor = branch.ancestor;
  if (ancestor.evidence === "creation_record")
    return `祖先来源：${ancestor.branch} · ${ancestor.oid?.slice(0, 8)}（创建记录）`;
  if (ancestor.evidence === "merge_base")
    return `与 ${ancestor.branch} 共同祖先 · ${ancestor.oid?.slice(0, 8)}`;
  return "祖先来源未记录";
}
interface Props {
  branches: MergeBranchCandidate[];
  selected: string[];
  loading: boolean;
  disabled: boolean;
  error: string;
  onAdd: (name: string) => void;
  onRetry: () => void;
}
export function BranchSourcePicker({
  branches,
  selected,
  loading,
  disabled,
  error,
  onAdd,
  onRetry,
}: Props) {
  const [search, setSearch] = useState("");
  const id = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const filtered = branches.filter((branch) =>
    branch.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
  );
  return (
    <Popover className="!flex w-full">
      {({ close }) => (
        <>
          <PopoverButton
            type="button"
            className="mr-branch-picker-trigger flex h-9 w-full items-center justify-center gap-2 rounded-lg border text-xs disabled:cursor-not-allowed disabled:opacity-45"
            disabled={disabled}
            onClick={() => setSearch("")}
          >
            <GitBranch size={14} aria-hidden="true" />
            添加源分支
            <ChevronDown size={13} aria-hidden="true" />
          </PopoverButton>
          <PopoverPanel
            focus
            className="mr-branch-picker-panel !w-[420px] !max-w-[calc(100vw-32px)] !rounded-2xl !p-0 backdrop-blur-[5px]"
            aria-label="可选源分支"
            onKeyDownCapture={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                close();
              }
            }}
          >
            <label className="flex items-center gap-2 border-b border-[var(--ui-line)] px-4 py-3 text-[var(--ui-subtle)]">
              <Search size={15} aria-hidden="true" />
              <span className="sr-only">搜索源分支</span>
              <input
                ref={searchRef}
                autoFocus
                type="search"
                placeholder="搜索分支名称"
                className="min-w-0 flex-1 bg-transparent text-xs text-[var(--ui-text)] outline-none"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              <button
                type="button"
                className="grid size-6 place-items-center rounded-md hover:bg-[var(--ui-panel-soft)]"
                aria-label="关闭源分支列表"
                onClick={() => close()}
              >
                <X size={13} />
              </button>
            </label>
            {loading && (
              <p
                className="flex items-center gap-2 px-4 py-3 text-xs text-[var(--ui-subtle)]"
                role="status"
              >
                <Loader2
                  size={13}
                  className="animate-spin motion-reduce:animate-none"
                />
                正在核验祖先与合并规则…
              </p>
            )}
            {error && (
              <div
                className="flex items-center gap-3 px-4 py-3 text-xs"
                role="alert"
              >
                {error}
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={onRetry}
                >
                  重新核验
                </Button>
              </div>
            )}
            <ul className="max-h-64 overflow-y-auto overscroll-contain p-1.5">
              {filtered.map((branch, index) => {
                const added = selected.includes(branch.name);
                const unavailable =
                  disabled ||
                  !branch.enabled ||
                  added ||
                  loading ||
                  Boolean(error);
                return (
                  <li key={branch.name}>
                    <button
                      type="button"
                      disabled={unavailable}
                      className="mr-branch-choice flex w-full items-start gap-2.5 rounded-xl px-3 py-2.5 text-left enabled:hover:bg-[var(--ui-panel-soft)] disabled:cursor-not-allowed"
                      aria-label={`添加 ${branch.name}`}
                      aria-describedby={`${id}-${index}`}
                      onClick={() => {
                        onAdd(branch.name);
                        searchRef.current?.focus({ preventScroll: true });
                      }}
                    >
                      {added ? (
                        <Check
                          size={15}
                          aria-hidden="true"
                          className="mt-0.5 shrink-0 text-[var(--theme-success)]"
                        />
                      ) : (
                        <GitBranch
                          size={15}
                          aria-hidden="true"
                          className="mt-0.5 shrink-0"
                        />
                      )}
                      <span className="min-w-0 flex-1">
                        <strong className="block truncate text-xs font-medium">
                          {branch.name}
                        </strong>
                        <small
                          id={`${id}-${index}`}
                          className="mt-1 block text-[10px] leading-4 text-[var(--ui-subtle)]"
                        >
                          {ancestorLabel(branch)}
                        </small>
                      </span>
                      <span className="max-w-24 shrink-0 text-right text-[10px] leading-4 text-[var(--ui-subtle)]">
                        {added ? "已加入队列" : (branch.detail ?? "可合入")}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {!loading && !error && !filtered.length && (
              <p className="px-4 py-8 text-center text-xs text-[var(--ui-subtle)]">
                没有匹配的分支
              </p>
            )}
            <p className="border-t border-[var(--ui-line)] px-4 py-3 text-[10px] leading-4 text-[var(--ui-subtle)]">
              灰色分支不可添加；可手动处理的内容冲突不会禁选。
            </p>
          </PopoverPanel>
        </>
      )}
    </Popover>
  );
}
