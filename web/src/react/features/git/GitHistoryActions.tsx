import { useState, type ReactNode } from "react";
import type {
  GitActionInput,
  GitActionResult,
  GitHistoryAction,
} from "../../../../../api/services/git-history-contracts";
import { projectApi } from "../../../lib/api/project";
import { useContextMenu } from "../../components/context-menu/ContextMenuProvider";
import {
  Dialog,
  DialogPanel,
  DialogTitle,
  DialogBody,
  DialogFooter,
} from "../../components/ui/Dialog";
import { Button } from "../../components/ui/Button";
import type { ContextMenuEntry } from "../../components/context-menu/types";

export interface HistoryActionSelection {
  action: GitHistoryAction;
  target?: string;
}
export function HistoryContextTarget({
  target,
  children,
  row,
  selected,
  onSelect,
  onAction,
  label,
}: {
  target: string;
  children: ReactNode;
  label?: string;
  row?: boolean;
  selected?: boolean;
  onSelect?: () => void;
  onAction: (selection: HistoryActionSelection) => void;
}) {
  const entries: ContextMenuEntry[] = [
    {
      type: "action",
      id: "copy",
      label: "复制完整引用 / Commit ID",
      run: () => navigator.clipboard.writeText(target),
    },
    ...(onSelect
      ? [
          {
            type: "action" as const,
            id: "details",
            label: "查看提交详情",
            run: onSelect,
          },
        ]
      : []),
    { type: "separator" },
    ...(
      [
        ["merge", "Merge 到当前分支…"],
        ["rebase", "将当前分支 Rebase 到此处…"],
        ["cherry-pick", "Cherry-pick 到当前分支…"],
        ["reset", "Reset HEAD 到此处…"],
      ] as const
    ).map(([action, label]) => ({
      type: "action" as const,
      id: action,
      label,
      danger: action === "reset",
      restoreFocus: false,
      run: () => onAction({ action, target }),
    })),
    ...(target.startsWith("refs/remotes/")
      ? [
          {
            type: "action" as const,
            id: "track",
            label: "创建本地跟踪分支…",
            restoreFocus: false,
            run: () => onAction({ action: "track", target }),
          },
        ]
      : []),
  ];
  const menu = useContextMenu(() => ({ label: target, entries }));
  const handlers = {
    onContextMenu: menu.onContextMenu,
    onKeyDown: menu.onKeyDown,
  };
  return row ? (
    <tr
      {...handlers}
      tabIndex={0}
      data-selected={selected || undefined}
      onKeyDown={(event) => {
        menu.onKeyDown(event);
        if (event.defaultPrevented) return;
        if (
          event.target === event.currentTarget &&
          (event.key === "Enter" || event.key === " ")
        ) {
          event.preventDefault();
          onSelect?.();
        }
        if (
          (event.key === "ArrowDown" || event.key === "ArrowUp") &&
          (event.target === event.currentTarget ||
            (event.target as HTMLElement).classList.contains(
              "history-table-title-button",
            ))
        ) {
          event.preventDefault();
          const next =
            event.key === "ArrowDown"
              ? event.currentTarget.nextElementSibling
              : event.currentTarget.previousElementSibling;
          next
            ?.querySelector<HTMLButtonElement>(".history-table-title-button")
            ?.focus();
        }
      }}
      onClick={(event) => {
        if (!(event.target as HTMLElement).closest("button, a, input")) {
          event.currentTarget.focus({ preventScroll: true });
          onSelect?.();
        }
      }}
      className={selected ? "history-table-row-selected" : undefined}
    >
      {children}
    </tr>
  ) : (
    <button
      {...handlers}
      type="button"
      className={
        label ? "git-control history-row-menu" : "git-control history-tree-ref"
      }
      aria-label={label}
      title={label ?? target}
      onClick={(event) => menu.openFromAnchor(event.currentTarget)}
    >
      {children}
    </button>
  );
}

export function GitHistoryActionDialog({
  projectId,
  rootId,
  head,
  worktree,
  selection,
  onClose,
  onDone,
}: {
  projectId: string;
  rootId?: string;
  head: string;
  worktree: string;
  selection: HistoryActionSelection;
  onClose: () => void;
  onDone: (result: GitActionResult) => void;
}) {
  const [mode, setMode] = useState<GitActionInput["resetMode"]>("mixed");
  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const execute = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await projectApi.gitAction(projectId, {
        ...selection,
        rootId,
        expectedHead: head,
        confirmed: true,
        resetMode: mode,
        branch,
      });
      onDone(result);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      dismissible={!busy}
      backdropClassName="backdrop-blur-[5px]"
    >
      <DialogPanel className="max-w-xl">
        <DialogTitle>{selection.action} · 确认 Git 操作</DialogTitle>
        <DialogBody>
          <p>
            工作树：<code>{worktree}</code>
          </p>
          <p>
            当前 HEAD：<code>{head}</code>
          </p>
          {selection.target && (
            <p>
              目标：<code>{selection.target}</code>
            </p>
          )}
          {selection.action === "merge" && (
            <p>将目标提交合并到这个工作树的当前分支。</p>
          )}
          {selection.action === "rebase" && (
            <p>将当前分支的提交重放到目标之上，这会改变这些提交的 ID。</p>
          )}
          {selection.action === "cherry-pick" && (
            <p>把目标提交的改动应用到当前分支。</p>
          )}
          {selection.action === "abort" && (
            <p>
              中止当前操作并恢复操作前状态，操作期间的冲突解决改动将被撤销。
            </p>
          )}
          {selection.action === "reset" && (
            <label>
              Reset 模式{" "}
              <select
                value={mode}
                onChange={(e) =>
                  setMode(e.target.value as GitActionInput["resetMode"])
                }
              >
                <option value="soft">Soft · 保留暂存区和文件</option>
                <option value="mixed">Mixed · 保留文件，重置暂存区</option>
                <option value="hard">Hard · 重置暂存区和文件</option>
              </select>
              <p>
                {mode === "hard"
                  ? "当前分支会移到目标，工作树和暂存区将匹配目标提交。"
                  : "当前分支会移到目标提交。"}
              </p>
            </label>
          )}
          {selection.action === "track" && (
            <label>
              新本地分支名称{" "}
              <input
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
              />
            </label>
          )}
          {error && <p role="alert">{error}</p>}
        </DialogBody>
        <DialogFooter>
          <Button onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button
            onClick={() => void execute()}
            disabled={busy || (selection.action === "track" && !branch.trim())}
          >
            {busy ? "执行中…" : "确认执行"}
          </Button>
        </DialogFooter>
      </DialogPanel>
    </Dialog>
  );
}
