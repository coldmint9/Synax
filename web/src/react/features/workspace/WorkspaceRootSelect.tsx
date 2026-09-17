import { Label, ListBox, Select } from '@heroui/react'
import { FolderCode } from 'lucide-react'
import type { ProjectWorkspaceRoot } from '../../../lib/api/project'
import { useWorkspaceCopy } from './workspaceCopy'
import './workspaceProjects.css'

/** Full project identity stays visible even when several roots share a name. */
export function WorkspaceRootSelect({
  roots,
  value,
  onChange,
  disabled
}: {
  roots: ProjectWorkspaceRoot[]
  value: string
  onChange: (id: string) => void
  disabled?: boolean
}) {
  const c = useWorkspaceCopy()
  return (
    <Select
      value={value || null}
      onChange={(key) => {
        if (key) onChange(String(key))
      }}
      isDisabled={disabled || roots.length === 0}
      fullWidth
      className="workspace-root-select"
      placeholder={c.noRoots}
    >
      <Label>{c.members}</Label>
      <Select.Trigger>
        <FolderCode size={15} className="text-muted-foreground" />
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox aria-label={c.members}>
          {roots.map((root) => (
            <ListBox.Item
              key={root.id}
              id={root.id}
              textValue={root.name}
              isDisabled={root.status === 'missing'}
            >
              <div className="workspace-project-text">
                <div className="workspace-project-name">
                  <strong>{root.name}</strong>
                  {root.role === 'primary' && (
                    <span className="workspace-primary-badge">{c.primary}</span>
                  )}
                  {root.status === 'missing' && (
                    <span className="text-danger text-xs">{c.missing}</span>
                  )}
                </div>
                <span>{root.path}</span>
              </div>
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  )
}
