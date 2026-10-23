import { useLocale } from "../../shared/hooks/useLocale";
import "./workspaceGitCountBadges.css";

export interface WorkspaceGitChangeFile {
  path: string;
  untracked?: boolean;
  status?: string;
}

export interface WorkspaceGitChangeCounts {
  uncommitted: number;
  untracked: number;
}

// Both Git and the directory index return slash-separated relative paths.
// A literal backslash can be part of a POSIX filename, so leave it intact.
const normalizePath = (value: string) => value.replace(/^\.\//, "").replace(/\/+$/, "");
const isUntracked = (file: WorkspaceGitChangeFile) => file.untracked || file.status === "untracked";

export function countWorkspaceGitFiles(
  files: readonly WorkspaceGitChangeFile[],
  directoryPath?: string,
): WorkspaceGitChangeCounts {
  const directory = normalizePath(directoryPath ?? "");
  let uncommitted = 0;
  let untracked = 0;
  for (const file of files) {
    const filePath = normalizePath(file.path);
    if (directory && filePath !== directory && !filePath.startsWith(`${directory}/`)) continue;
    if (isUntracked(file)) untracked += 1;
    else uncommitted += 1;
  }
  return { uncommitted, untracked };
}

/** Index each ancestor once per Git snapshot, never rescan all files per row. */
export function indexWorkspaceGitCounts(files: readonly WorkspaceGitChangeFile[]): ReadonlyMap<string, WorkspaceGitChangeCounts> {
  const counts = new Map<string, WorkspaceGitChangeCounts>();
  for (const file of files) {
    const kind = isUntracked(file) ? "untracked" : "uncommitted";
    const parts = normalizePath(file.path).split("/");
    let directory = "";
    for (let depth = 0; depth < parts.length; depth++) {
      if (depth > 0) directory += `${directory ? "/" : ""}${parts[depth - 1]}`;
      const value = counts.get(directory) ?? { uncommitted: 0, untracked: 0 };
      value[kind]++;
      counts.set(directory, value);
    }
  }
  return counts;
}

export function WorkspaceGitCountBadges({
  counts,
  className = "",
}: {
  counts?: WorkspaceGitChangeCounts;
  className?: string;
}) {
  const zh = useLocale().locale === "zh";
  if (!counts || (counts.uncommitted === 0 && counts.untracked === 0)) return null;
  const uncommittedLabel = zh ? `未提交 ${counts.uncommitted} 个文件` : `${counts.uncommitted} uncommitted files`;
  const untrackedLabel = zh ? `未跟踪 ${counts.untracked} 个文件` : `${counts.untracked} untracked files`;
  const label = [
    counts.uncommitted ? uncommittedLabel : "",
    counts.untracked ? untrackedLabel : "",
  ].filter(Boolean).join(zh ? "，" : ", ");
  return <span className={`workspace-git-count-badges ${className}`.trim()} role="img" aria-label={label}>
    {counts.uncommitted > 0 && <span className="workspace-git-count-badge workspace-git-count-badge--uncommitted" title={uncommittedLabel}>{counts.uncommitted}</span>}
    {counts.untracked > 0 && <span className="workspace-git-count-badge workspace-git-count-badge--untracked" title={untrackedLabel}>{counts.untracked}</span>}
  </span>;
}
