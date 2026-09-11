import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react'
import { Button } from '@heroui/react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { useAgentSessionStore } from '../features/sessions/agentSessionStore'
import { useSessionDetailPolling } from '../features/sessions/useSessionDetailPolling'
import { useSessionLiveStream } from '../features/sessions/useSessionLiveStream'
import { useLocale } from '../../hooks/useLocale'
import { SessionTranscript } from '../features/sessions/SessionTranscript'
import { AgentCommandRail } from '../features/sessions/AgentCommandRail'

import { SessionWorkspacePanel } from '../features/sessions/SessionWorkspacePanel'
import { SessionListPanel } from '../features/sessions/SessionListPanel'
import { SessionComposer } from '../features/sessions/SessionComposer'
import { useSessionRouteSync } from '../features/sessions/useSessionRouteSync'
import { isNewSessionPath, newSessionPath } from '../features/sessions/sessionRoutes'
import type { SessionListView } from '../features/sessions/sessionBuckets'
import { useSessionWorkspace } from '../features/sessions/sessionWorkspaceStore'
import { useMediaQuery } from '../../hooks/useMediaQuery'

const LEFT_PANEL_DEFAULT = 260
const LEFT_PANEL_MIN = 210
const LEFT_PANEL_MAX = 420
const RIGHT_PANEL_DEFAULT = 320
const RIGHT_PANEL_MIN = 280
const RIGHT_PANEL_MAX = 420
const LEFT_PANEL_STORAGE_KEY = 'synax-sessions-left-panel'
const RIGHT_PANEL_STORAGE_KEY = 'synax-sessions-right-panel'

type PanelSide = 'left' | 'right'

function readPanelWidth(key: string, fallback: number, min: number, max: number): number {
  if (typeof window === 'undefined') return fallback
  const raw = window.localStorage.getItem(key)
  // `Number(null)` is 0, which used to pin first-load panels to their minimum
  // width instead of the default. Only a real, non-empty value wins.
  if (raw === null || raw.trim() === '') return fallback
  const value = Number(raw)
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
}

function useResizablePanel(side: PanelSide, defaultWidth: number, min: number, max: number) {
  const storageKey = side === 'left' ? LEFT_PANEL_STORAGE_KEY : RIGHT_PANEL_STORAGE_KEY
  const [width, setWidth] = useState(() => readPanelWidth(storageKey, defaultWidth, min, max))
  const [collapsed, setCollapsed] = useState(false)
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null)

  useEffect(() => {
    window.localStorage.setItem(storageKey, String(width))
  }, [storageKey, width])

  const startResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (collapsed) return
    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    dragRef.current = { startX: event.clientX, startWidth: width }

    const handleMove = (move: PointerEvent) => {
      const drag = dragRef.current
      if (!drag) return
      const delta = side === 'left' ? move.clientX - drag.startX : drag.startX - move.clientX
      setWidth(Math.min(max, Math.max(min, drag.startWidth + delta)))
    }
    const handleUp = () => {
      dragRef.current = null
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
    }
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp)
  }, [collapsed, max, min, side, width])

  return { width, collapsed, setCollapsed, startResize }
}

function LeftPanelCollapseButton({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-label={collapsed ? '展开左侧面板' : '收起左侧面板'}
      title={collapsed ? '展开面板' : '收起面板'}
      onClick={onToggle}
      className="session-panel-collapse session-panel-collapse--left"
    >
      {collapsed ? <ChevronRight size={12} /> : <ChevronLeft size={12} />}
    </button>
  )
}

const SessionDetailSidebar = memo(function SessionDetailSidebar({
  width,
  onResize,
}: {
  width: number
  onResize: (event: React.PointerEvent<HTMLDivElement>) => void
}) {
  const selectedSessionId = useAgentSessionStore(s => s.selectedSessionId)

  return (
    <aside className="session-workspace-sidebar session-workspace-sidebar--dock relative shrink-0" style={{ width }}>
      <SessionWorkspacePanel sessionId={selectedSessionId} mode="dashboard" />
      <div className="session-panel-resizer session-panel-resizer--right" onPointerDown={onResize} role="separator" aria-orientation="vertical" />
    </aside>
  )
})

export default memo(function SessionsPage() {
  useSessionDetailPolling()
  const { t } = useLocale()
  const navigate = useNavigate()
  const { projectId = '' } = useParams()
  const leftPanel = useResizablePanel('left', LEFT_PANEL_DEFAULT, LEFT_PANEL_MIN, LEFT_PANEL_MAX)
  const rightPanel = useResizablePanel('right', RIGHT_PANEL_DEFAULT, RIGHT_PANEL_MIN, RIGHT_PANEL_MAX)
  const location = useLocation()
  const listView: SessionListView = location.pathname.includes('/sessions/workflows') ? 'workflow' : 'sessions'

  useSessionRouteSync(listView, projectId)

  const agentSessionId = useAgentSessionStore(s => s.selectedSessionId)
  const agentPanelOpen = useAgentSessionStore(s => s.panelOpen)
  const workspaceState = useSessionWorkspace(agentSessionId)
  const hasWorkspaceContent = Boolean(workspaceState.activeTabId)
  const wideWorkspace = useMediaQuery('(min-width: 1280px)')

  useSessionLiveStream(agentPanelOpen ? agentSessionId : null)

  const isNewDraft = listView === 'sessions' && isNewSessionPath(location.pathname)
  const showTranscript = Boolean(agentPanelOpen && agentSessionId)
  const workspaceFullscreen = showTranscript && hasWorkspaceContent && workspaceState.presentation === 'focus'
  const canCreateSession = listView === 'sessions' && Boolean(projectId)

  const commandRailLeft = leftPanel.collapsed ? 0 : leftPanel.width
  const commandRailRight = showTranscript && wideWorkspace && !workspaceFullscreen ? rightPanel.width : 0

  // Keep the island centered in the space between the two side panels instead
  // of centering it against the viewport and letting it overlap the right rail.
  useEffect(() => {
    const root = document.documentElement
    const leftInset = leftPanel.collapsed ? 0 : leftPanel.width + 8
    const rightInset = showTranscript && wideWorkspace ? rightPanel.width + 18 : 0
    root.style.setProperty('--agent-header-shift', `${(leftInset - rightInset) / 2}px`)
    root.style.setProperty('--agent-header-left-inset', `${leftInset}px`)
    root.style.setProperty('--agent-header-right-inset', `${rightInset}px`)
    return () => {
      root.style.removeProperty('--agent-header-shift')
      root.style.removeProperty('--agent-header-left-inset')
      root.style.removeProperty('--agent-header-right-inset')
    }
  }, [leftPanel.collapsed, leftPanel.width, rightPanel.width, showTranscript, wideWorkspace])

  return (
    <div className="agent-page-shell relative flex h-full min-h-0">
      <>
          {!workspaceFullscreen && (
          <aside
            className={`session-panel-host session-panel-host--left relative shrink-0 transition-[width] duration-200 ${leftPanel.collapsed ? 'overflow-visible' : 'overflow-hidden'}`}
            data-collapsed={leftPanel.collapsed ? 'true' : undefined}
            style={{ width: leftPanel.collapsed ? 0 : leftPanel.width }}
          >
            {/* While the panel is open the control lives next to the SynaxCode
                title; the edge tab only exists to bring a collapsed panel back. */}
            {leftPanel.collapsed ? (
              <LeftPanelCollapseButton collapsed onToggle={() => leftPanel.setCollapsed(value => !value)} />
            ) : (
              <>
                <SessionListPanel
                  listView={listView}
                  projectId={projectId}
                  onCollapsePanel={() => leftPanel.setCollapsed(true)}
                />
                <div className="session-panel-resizer session-panel-resizer--left" onPointerDown={leftPanel.startResize} role="separator" aria-orientation="vertical" />
              </>
            )}
          </aside>
          )}

          {showTranscript ? (
            <>
              <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                {hasWorkspaceContent ? (
                  <SessionWorkspacePanel sessionId={agentSessionId} mode="content" />
                ) : (
                  <SessionTranscript />
                )}
              </div>
              {wideWorkspace && !workspaceFullscreen ? (
                <SessionDetailSidebar
                  width={rightPanel.width}
                  onResize={rightPanel.startResize}
                />
              ) : null}
            </>
          ) : isNewDraft ? (
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
              <SessionComposer projectId={projectId} layout="centered" />
            </div>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
              <p className="text-sm text-muted-foreground">
                {canCreateSession ? t('sessionSelectOrCreate') : t('sessionSelectHint')}
              </p>
              {canCreateSession ? (
                <Button
                  variant="secondary"
                  size="sm"
                  className="gap-1.5"
                  onPress={() => navigate(newSessionPath(projectId))}
                >
                  <Plus size={14} />
                  {t('sessionNew')}
                </Button>
              ) : null}
            </div>
          )}
      </>
      {showTranscript && agentSessionId && !hasWorkspaceContent ? (
        <AgentCommandRail
          sessionId={agentSessionId}
          projectId={projectId}
          focus={false}
          insetLeft={commandRailLeft}
          insetRight={commandRailRight}
        />
      ) : null}
    </div>
  )
})
