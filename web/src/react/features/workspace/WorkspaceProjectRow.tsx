import type { ReactNode } from 'react'
import { FolderCode, Pin } from 'lucide-react'
import { useWorkspaceCopy } from './workspaceCopy'
import './workspaceProjects.css'

export function WorkspaceProjectRow({
  name,
  path,
  primary,
  missing,
  children
}: {
  name: string
  path: string
  primary?: boolean
  missing?: boolean
  children?: ReactNode
}) {
  const c = useWorkspaceCopy()
  return (
    <div
      className="workspace-project-row"
      data-primary={primary || undefined}
      data-missing={missing || undefined}
      role="listitem"
    >
      <span className="workspace-project-icon">
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
