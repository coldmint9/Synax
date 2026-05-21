import type { SourceBinding } from './coordinates'
import type { ProjectSummary } from '../react/state/shellStore'

/**
 * Branch label for header UI: uses active coordinates binding when it is git,
 * otherwise the project's configured branch for GitHub/GitLab imports.
 */
export function headerGitBranchLabel(
  project: ProjectSummary | null | undefined,
  forestSource: SourceBinding,
): string | null {
  const gitManaged =
    project?.source?.kind === 'github' ||
    project?.source?.kind === 'gitlab' ||
    project?.source?.kind === 'localPath' ||
    forestSource.kind === 'git' ||
    forestSource.kind === 'localPath'

  if (!gitManaged) return null

  if (forestSource.kind === 'git' || forestSource.kind === 'localPath') {
    const b = forestSource.branch?.trim()
    if (b) return b
  }

  if (project?.source?.kind === 'github' || project?.source?.kind === 'gitlab') {
    const b = project.source.branch?.trim()
    if (b) return b
  }

  return null
}
