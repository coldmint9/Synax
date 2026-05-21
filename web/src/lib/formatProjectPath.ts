import type { ProjectSummary } from '../react/state/shellStore'

/** 用于侧栏、卡片等：展示仓库 URL、本地路径或空白项目 */
export function formatProjectPath(project: Pick<ProjectSummary, 'id' | 'source'>): string {
  const s = project.source
  if (!s || s.kind === 'scratch') return '空白项目'
  if (s.kind === 'localPath') return (s.localPath?.trim() || project.id)
  if (s.repo) return s.branch ? `${s.repo} · ${s.branch}` : s.repo
  return project.id
}
