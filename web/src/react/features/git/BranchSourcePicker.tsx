import { useState } from "react";
import { Check, ChevronDown, GitBranch, Search } from "lucide-react";
import type { MergeBranchCandidate } from "../../../../../api/services/git-mr/contracts";
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
  const [open, setOpen] = useState(false),
    [search, setSearch] = useState("");
  const filtered = branches.filter((branch) =>
    branch.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
  );
  return (
    <div className="mr-source-picker">
      <button
        type="button"
        className="mr-source-trigger"
        aria-expanded={open}
        aria-controls="mr-source-options"
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        <GitBranch size={15} aria-hidden />
        添加源分支
        <ChevronDown size={14} aria-hidden />
      </button>
      {open && (
        <section
          id="mr-source-options"
          className="mr-source-options"
          aria-label="可选源分支"
        >
          <label className="mr-source-search">
            <Search size={15} aria-hidden />
            <span className="sr-only">搜索源分支</span>
            <input
              type="search"
              placeholder="搜索分支名称"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          {loading && (
            <p className="mr-picker-status" role="status">
              正在核验祖先与合并规则…
            </p>
          )}
          {error && (
            <div className="mr-picker-status" role="alert">
              {error}
              <button type="button" onClick={onRetry}>
                重新核验
              </button>
            </div>
          )}
          <ul className="mr-branch-options">
            {filtered.map((branch) => {
              const added = selected.includes(branch.name);
              const unavailable =
                !branch.enabled || added || loading || !!error;
              return (
                <li key={branch.name} data-disabled={unavailable}>
                  <button
                    type="button"
                    disabled={unavailable}
                    aria-label={`添加 ${branch.name}`}
                    aria-describedby={`mr-branch-info-${branches.indexOf(branch)}`}
                    onClick={() => onAdd(branch.name)}
                  >
                    {added ? (
                      <Check size={15} aria-hidden />
                    ) : (
                      <GitBranch size={15} aria-hidden />
                    )}
                    <span>
                      <strong>{branch.name}</strong>
                      <small id={`mr-branch-info-${branches.indexOf(branch)}`}>
                        {ancestorLabel(branch)}
                      </small>
                    </span>
                    <span className="mr-branch-reason">
                      {branch.detail ?? (added ? "已加入队列" : "可合入")}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {!loading && !error && !filtered.length && (
            <p className="mr-picker-status">没有匹配的分支</p>
          )}
          <p className="mr-picker-footnote">
            灰色分支不可添加；可手动处理的内容冲突不会禁选。
          </p>
        </section>
      )}
    </div>
  );
}
