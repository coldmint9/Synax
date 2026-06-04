import { useState, useEffect } from 'react'
import { Surface } from '@heroui/react'
import { useSessionList } from './useSessionList'
import { SessionListHeader } from './SessionListHeader'
import { SessionFilterChips } from './SessionFilterChips'
import { SessionTimeGroups } from './SessionTimeGroups'
import { SessionDeleteDialog } from './SessionDeleteDialog'
import { SessionClearInactiveDialog } from './SessionClearInactiveDialog'
import { useDebugConsole } from '../debug-console/debugConsoleStore'

export function SessionListPanel() {
  const list = useSessionList()
  const projectId = useDebugConsole(s => s.projectId)

  // Delete modal state
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)

  // Clear inactive modal
  const [showClear, setShowClear] = useState(false)

  // Initial load + reload when project changes
  useEffect(() => { void list.refresh() }, [projectId])

  // Derive delete title
  const deleteTitle = deleteId
    ? (list.groups.flatMap(g => g.sessions).find(n => n.session.id === deleteId)?.session.title
      ?? list.groups.flatMap(g => g.sessions).find(n => n.session.id === deleteId)?.session.prompt.slice(0, 50) ?? '')
    : ''

  return (
    <Surface className="flex h-full flex-col bg-background" variant="default">
      <SessionListHeader
        totalCount={list.totalCount}
        searchQuery={list.searchQuery}
        onSearchChange={list.setSearchQuery}
        onRefresh={() => { void list.refresh() }}
        onClearInactive={() => setShowClear(true)}
        isRefreshing={false}
      />
      <SessionFilterChips
        value={list.statusFilter}
        onChange={list.setStatusFilter}
        countByStatus={list.countByStatus}
        totalCount={list.totalCount}
      />
      <SessionTimeGroups
        groups={list.groups}
        selectedId={list.selectedId}
        isLoadingMore={list.isLoadingMore}
        hasMore={list.hasMore}
        onSelect={list.select}
        onToggleGroup={list.toggleGroup}
        onToggleExpand={list.toggleExpand}
        onLoadMore={() => { void list.loadMore() }}
        onDelete={id => setDeleteId(id)}
      />

      {/* Delete confirmation modal */}
      <SessionDeleteDialog
        isOpen={deleteId !== null}
        sessionTitle={deleteTitle}
        isDeleting={deleting}
        onConfirm={async () => {
          const id = deleteId
          if (!id) return
          setDeleting(true)
          try { await list.deleteSession(id); setDeleteId(null); void list.refresh() }
          catch (err) { console.error('[DeleteSession]', err) }
          finally { setDeleting(false) }
        }}
        onClose={() => { if (!deleting) setDeleteId(null) }}
      />

      {/* Clear inactive modal */}
      <SessionClearInactiveDialog
        isOpen={showClear}
        projectId={projectId}
        onClose={() => setShowClear(false)}
        onCleared={() => { void list.refresh() }}
      />

      {/* Connection status */}
      <div className="flex items-center gap-1.5 px-3 py-1.5 border-t border-border/20 text-[9px] text-muted-foreground">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-green-500" />
        Connected
      </div>
    </Surface>
  )
}
