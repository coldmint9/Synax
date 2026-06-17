import type { SessionTreeNode } from './sessionGrouping'
import { getSessionDisplayTitle } from './useSessionDisplayTitle'

interface Props {
  node: SessionTreeNode
  depth?: number
  selectedId: string | null
  onSelect: (sessionId: string) => void
}

export function GroupedSessionTreeItem({ node, depth = 0, selectedId, onSelect }: Props) {
  const { session } = node
  const active = session.id === selectedId

  return (
    <>
      <li
        className={`list-row ${active ? 'list-row--active' : ''}`}
        style={{ paddingLeft: `${8 + depth * 12}px` }}
        onClick={() => onSelect(session.id)}
      >
        {/* Title: always visible */}
        <span className="flex-1 truncate font-medium" title={getSessionDisplayTitle(session)}>
          {getSessionDisplayTitle(session).slice(0, 40)}
        </span>
        {/* Detail info: only visible when active */}
        {active && (
          <span className="truncate max-w-[60px] text-right text-[9px] text-muted-foreground">
            {session.status}
          </span>
        )}
      </li>
      {node.children.map(child => (
        <GroupedSessionTreeItem
          key={child.session.id}
          node={child}
          depth={depth + 1}
          selectedId={selectedId}
          onSelect={onSelect}
        />
      ))}
    </>
  )
}
