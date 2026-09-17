import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { FileDiff } from 'lucide-react'
import { agentRuntimeApi, type SessionEnvironmentFile } from '../../../lib/api/agentRuntime'
import { useAgentSessionStore } from './agentSessionStore'
import { FileTypeIcon } from './FileTypeIcon'
import { openWorkspaceDiff } from './sessionWorkspaceStore'

/** Poll cadence is a drift safety net only: write tool results invalidate the
 *  server cache, and the toolCalls upsert retriggers an immediate reload below. */
const RUNNING_REFRESH_MS = 30_000
const IDLE_REFRESH_MS = 30_000

function statusLabel(status: SessionEnvironmentFile['status']): string {
  switch (status) {
    case 'added': return '新增'
    case 'modified': return '修改'
    case 'deleted': return '删除'
    case 'renamed': return '重命名'
    case 'untracked': return '新增'
    default: return '变更'
  }
}

/**
 * Floating summary of the files this session's agent has written so far.
 *
 * The list is attributed server-side from the session's own write tool calls,
 * so hand edits the user made in the same checkout are not counted. It is
 * driven by the live tool-call stream (which changes the moment an edit lands)
 * plus a slow poll that picks up diff sizes.
 */
export const SessionFileChangeIsland = memo(function SessionFileChangeIsland({
  sessionId,
  isRunning,
}: {
  sessionId: string
  isRunning: boolean
}) {
  const [files, setFiles] = useState<SessionEnvironmentFile[]>([])
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const pillRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  // Tool call count is a live signal from the session stream; a completed edit
  // bumps it and we refresh immediately instead of waiting for the poll.
  const toolCallCount = useAgentSessionStore(state => state.toolCalls.length)

  useEffect(() => {
    setFiles([])
    setOpen(false)
  }, [sessionId])

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const environment = await agentRuntimeApi.getSessionEnvironment(sessionId)
        if (!cancelled) setFiles(environment.agentChangedFiles ?? [])
      } catch {
        // Keep the previous summary; a transient failure should not blank it.
      }
    }
    void load()
    const timer = window.setInterval(
      () => void load(),
      isRunning ? RUNNING_REFRESH_MS : IDLE_REFRESH_MS,
    )
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [sessionId, isRunning, toolCallCount])

  useLayoutEffect(() => {
    if (!open) return
    const positionMenu = () => {
      const pill = pillRef.current?.getBoundingClientRect()
      const menu = menuRef.current
      if (!pill || !menu) return

      const gap = 6
      const edge = 12
      const above = Math.max(0, pill.top - gap - edge)
      const below = Math.max(0, window.innerHeight - pill.bottom - gap - edge)
      const placeAbove = above >= Math.min(menu.scrollHeight, 256) || above >= below
      const available = placeAbove ? above : below
      const height = Math.min(menu.scrollHeight, 256, available)
      const width = menu.getBoundingClientRect().width
      menu.style.maxHeight = `${Math.min(256, available)}px`
      menu.style.top = `${placeAbove ? pill.top - gap - height : pill.bottom + gap}px`
      menu.style.left = `${Math.max(edge, Math.min(pill.left + pill.width / 2 - width / 2, window.innerWidth - edge - width))}px`
    }

    positionMenu()
    window.addEventListener('resize', positionMenu)
    window.addEventListener('scroll', positionMenu, true)
    return () => {
      window.removeEventListener('resize', positionMenu)
      window.removeEventListener('scroll', positionMenu, true)
    }
  }, [open, files])

  useEffect(() => {
    if (!open) return
    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node) && !menuRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
        pillRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  if (files.length === 0) return null

  const additions = files.reduce((sum, file) => sum + file.additions, 0)
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0)

  return (
    <div ref={rootRef} className="session-file-island">
      <button
        ref={pillRef}
        type="button"
        className="session-file-island-pill"
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`${files.length} 个文件已更改`}
        title={files.map(file => file.path).join('\n')}
        onClick={() => setOpen(value => !value)}
      >
        <FileDiff size={12} className="session-file-island-icon" />
        <span className="session-file-island-label">{files.length} 个文件已更改</span>
        {additions > 0 ? <span className="session-file-island-add">+{additions}</span> : null}
        {deletions > 0 ? <span className="session-file-island-del">-{deletions}</span> : null}
      </button>

      {open ? createPortal(
        <div ref={menuRef} className="session-file-island-menu" role="menu">
          {files.map(file => (
            <button
              key={file.path}
              type="button"
              role="menuitem"
              className="session-file-island-row"
              title={file.path}
              onClick={() => {
                openWorkspaceDiff(sessionId, file.path)
                setOpen(false)
              }}
            >
              <FileTypeIcon path={file.path} />
              <span className="session-file-island-status">{statusLabel(file.status)}</span>
              <span className="session-file-island-path">{file.path}</span>
              <span className="session-file-island-stats">
                {file.additions > 0 ? <span className="session-file-island-add">+{file.additions}</span> : null}
                {file.deletions > 0 ? <span className="session-file-island-del">-{file.deletions}</span> : null}
              </span>
            </button>
          ))}
        </div>,
        document.body,
      ) : null}
    </div>
  )
})
