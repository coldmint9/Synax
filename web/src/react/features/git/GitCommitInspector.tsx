import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  Copy,
  FileCode2,
  GitCommitHorizontal,
  Loader2,
  X,
} from "lucide-react";
import type {
  GitCommitDetail,
  GitCommitSummary,
} from "../../../lib/api/project";
import { useMediaQuery } from "../../../hooks/useMediaQuery";
import { Drawer, DialogPanel, DialogTitle } from "../../components/ui/Dialog";
import { Button } from "../../components/ui/Button";

export function GitCommitInspector({
  commit,
  detail,
  error,
  loading,
  refs,
  onClose,
  onRetry,
  onPrevious,
  onNext,
}: {
  commit: GitCommitSummary;
  detail: GitCommitDetail | null;
  error: string;
  loading: boolean;
  refs: ReactNode;
  onClose: () => void;
  onRetry: () => void;
  onPrevious?: () => void;
  onNext?: () => void;
}) {
  const mobile = useMediaQuery("(max-width: 1023px)");
  const closeRef = useRef<HTMLButtonElement>(null);
  const [copyResult, setCopyResult] = useState<{
    id: string;
    message: string;
  } | null>(null);
  const copyStatus = copyResult?.id === commit.id ? copyResult.message : "";
  useEffect(() => {
    if (mobile) return;
    closeRef.current?.focus({ preventScroll: true });
  }, [mobile]);
  useEffect(() => {
    if (mobile) return;
    const escape = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        !event.defaultPrevented &&
        !document.querySelector(
          '[role="dialog"], [role="menu"], [data-slot="popover"]',
        )
      ) {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [mobile, onClose]);
  async function copy() {
    const id = commit.id;
    try {
      await navigator.clipboard.writeText(id);
      setCopyResult({ id, message: "已复制 Commit ID" });
    } catch {
      setCopyResult({ id, message: "复制失败，请手动选择下方 Commit ID" });
    }
  }
  const title = (
    <span className="flex items-center gap-2 text-[13px] font-medium">
      <GitCommitHorizontal size={17} aria-hidden="true" />
      提交详情
    </span>
  );
  const content = (
    <>
      <header className="flex h-16 shrink-0 items-center justify-between gap-3 border-b border-[var(--ui-line)] px-5">
        {mobile ? (
          <DialogTitle>{title}</DialogTitle>
        ) : (
          <h2 id="git-inspector-title">{title}</h2>
        )}
        <div className="flex items-center gap-1">
          <Button
            className="git-control"
            iconOnly
            variant="ghost"
            size="sm"
            disabled={!onPrevious}
            onClick={onPrevious}
            aria-label="上一个提交"
          >
            <ArrowUp size={15} />
          </Button>
          <Button
            className="git-control"
            iconOnly
            variant="ghost"
            size="sm"
            disabled={!onNext}
            onClick={onNext}
            aria-label="下一个提交"
          >
            <ArrowDown size={15} />
          </Button>
          <span
            className="mx-1 h-4 w-px bg-[var(--ui-line)]"
            aria-hidden="true"
          />
          <Button
            ref={closeRef}
            className="git-control"
            iconOnly
            variant="ghost"
            size="sm"
            onClick={onClose}
            aria-label="关闭提交详情"
          >
            <X size={16} />
          </Button>
        </div>
      </header>
      <div
        className="git-inspector-body min-h-0 flex-1 overflow-y-auto overscroll-contain p-5"
        key={commit.id}
      >
        <h3 className="text-base leading-relaxed font-semibold break-words">
          {commit.subject || "无提交说明"}
        </h3>
        <div className="mt-3">{refs}</div>
        <div className="mt-5 flex items-start gap-2 rounded-xl bg-[var(--ui-canvas)] p-3">
          <code className="min-w-0 flex-1 select-all text-[11px] leading-6 break-all text-[var(--ui-subtle)]">
            {commit.id}
          </code>
          <Button
            className="git-control"
            iconOnly
            variant="ghost"
            size="sm"
            onClick={() => void copy()}
            aria-label="复制 Commit ID"
          >
            {copyStatus.startsWith("已复制") ? (
              <Check size={14} />
            ) : (
              <Copy size={14} />
            )}
          </Button>
        </div>
        <span
          role="status"
          className={
            copyStatus
              ? "mt-2 block text-xs text-[var(--ui-subtle)]"
              : "sr-only"
          }
        >
          {copyStatus}
        </span>
        <dl className="git-inspector-meta mt-5 grid grid-cols-[56px_minmax(0,1fr)] gap-x-3 gap-y-3 text-xs">
          <dt>作者</dt>
          <dd>
            {detail?.author ?? commit.author}
            {detail && (
              <span className="mt-1 block break-all text-[var(--ui-subtle)]">
                {detail.authorEmail}
              </span>
            )}
          </dd>
          <dt>时间</dt>
          <dd>
            <time dateTime={commit.authoredAt}>
              {new Date(commit.authoredAt).toLocaleString("zh-CN")}
            </time>
          </dd>
          {detail && (
            <>
              <dt>提交者</dt>
              <dd>
                {detail.committer}
                <span className="mt-1 block break-all text-[var(--ui-subtle)]">
                  {detail.committerEmail}
                </span>
                <time
                  className="mt-1 block text-[var(--ui-subtle)]"
                  dateTime={detail.committedAt}
                >
                  {new Date(detail.committedAt).toLocaleString("zh-CN")}
                </time>
              </dd>
            </>
          )}
          <dt>父提交</dt>
          <dd className="flex flex-wrap gap-2">
            {commit.parents.length
              ? commit.parents.map((parent) => (
                  <code key={parent} title={parent}>
                    {parent.slice(0, 8)}
                  </code>
                ))
              : "初始提交"}
          </dd>
        </dl>
        {loading && (
          <div
            role="status"
            className="flex items-center gap-2 py-8 text-xs text-[var(--ui-subtle)]"
          >
            <Loader2
              size={15}
              className="animate-spin motion-reduce:animate-none"
            />
            正在加载提交详情…
          </div>
        )}
        {error && (
          <div
            role="alert"
            className="mt-6 rounded-xl bg-[var(--ui-canvas)] p-4 text-xs"
          >
            <p>{error}</p>
            <Button className="git-control mt-3" size="sm" onClick={onRetry}>
              重试详情
            </Button>
          </div>
        )}
        {detail && (
          <>
            {detail.message.trim() !== commit.subject.trim() && (
              <pre className="mt-6 whitespace-pre-wrap break-words font-sans text-xs leading-6 text-[var(--ui-subtle)]">
                {detail.message}
              </pre>
            )}
            <section className="mt-7" aria-label="改动文件">
              <h4 className="mb-3 flex items-center gap-2 text-xs font-medium">
                <FileCode2 size={14} aria-hidden="true" />
                改动文件
                <span className="text-[var(--ui-subtle)]">
                  {detail.files.length}
                </span>
              </h4>
              <ul className="divide-y divide-[var(--ui-line)]">
                {detail.files.map((file) => (
                  <li
                    className="flex items-start gap-3 py-2.5 text-xs"
                    key={file.path}
                  >
                    <code
                      className="git-file-status"
                      data-status={file.status[0]}
                    >
                      {file.status}
                    </code>
                    <span className="min-w-0 break-all leading-5">
                      {file.previousPath && (
                        <span className="text-[var(--ui-subtle)]">
                          {file.previousPath} →{" "}
                        </span>
                      )}
                      {file.path}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
            <details className="mt-6" open>
              <summary className="cursor-pointer text-xs font-medium">
                文本差异
              </summary>
              <pre
                className="git-commit-diff mt-3 overflow-x-auto rounded-xl bg-[var(--ui-canvas)] py-3 text-[11px] leading-5"
                tabIndex={0}
                aria-label="提交文本差异"
              >
                {(detail.diff || "没有文本改动")
                  .split("\n")
                  .map((line, index) => (
                    <span
                      key={index}
                      className="block min-w-max px-3"
                      data-diff={
                        line.startsWith("+++") || line.startsWith("---")
                          ? "header"
                          : line.startsWith("+")
                            ? "add"
                            : line.startsWith("-")
                              ? "remove"
                              : line.startsWith("@@")
                                ? "hunk"
                                : undefined
                      }
                    >
                      {line || " "}
                      {"\n"}
                    </span>
                  ))}
              </pre>
            </details>
          </>
        )}
      </div>
    </>
  );
  if (mobile)
    return (
      <Drawer
        open
        onClose={onClose}
        backdropClassName="backdrop-blur-[5px]"
        className="git-inspector-drawer"
      >
        <DialogPanel className="git-inspector-panel !w-[min(100%,480px)] !gap-0 !p-0">
          {content}
        </DialogPanel>
      </Drawer>
    );
  return (
    <aside
      className="git-commit-inspector flex min-h-0 flex-col overflow-hidden rounded-[20px] border border-[var(--ui-line)] bg-[var(--ui-panel)]"
      aria-labelledby="git-inspector-title"
    >
      {content}
    </aside>
  );
}
