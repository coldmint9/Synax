import type { ReactNode } from 'react'
import { FolderCode, Pin } from 'lucide-react'
import { useWorkspaceCopy } from './workspaceCopy'
import { getProjectThemeColor } from '../agent-workspace/projectThemeColor'
import './workspaceProjects.css'

export function WorkspaceProjectRow({
  name,
  path,
  projectId,
  primary,
  missing,
  children
}: {
  name: string
  path: string
  projectId?: string
  primary?: boolean
  missing?: boolean
  children?: ReactNode
}) {
  const c = useWorkspaceCopy()
  const projectColor = getProjectThemeColor(projectId)
  return (
    <div
      className="workspace-project-row"
      data-primary={primary || undefined}
      data-missing={missing || undefined}
      role="listitem"
    >
      <span className="workspace-project-icon" data-project-color={projectColor}>
        <FolderCode size={18} strokeWidth={1.5} />
      </span>
      <div className="workspace-project-text">
        <div className="workspace-project-name">
          <strong title={name}>{name}</strong>
          {primary && (
            <span className="workspace-primary-badge">
              <Pin size={10} />
              {c.primary}
            </span>
          )}
        </div>
        <span title={path}>{path}</span>
        {missing && <span className="workspace-missing">{c.missing}</span>}
      </div>
      {children && <div className="workspace-project-actions">{children}</div>}
    </div>
  )
}
