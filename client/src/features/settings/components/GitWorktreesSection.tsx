import { Link } from "react-router-dom";
import { ArrowUpRight, GitBranch } from "lucide-react";
import { SettingsCard } from "./SettingsCard";

/** Keep existing entry points discoverable while Git owns repository operations. */
export function GitWorktreesSection({ projectId }: { projectId: string }) {
  return <SettingsCard title="Git 工作树" icon={GitBranch} description="在 Git 页面中创建、查看和清理独立工作目录">
    <Link className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2 text-sm text-primary hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring" to={`/projects/${encodeURIComponent(projectId)}/git?view=worktrees`}>
      在 Git 中管理工作树 <ArrowUpRight size={14} aria-hidden="true" />
    </Link>
  </SettingsCard>;
}
