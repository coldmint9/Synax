import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { ChevronRight, Plus } from 'lucide-react'
import { Button } from '@heroui/react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { useAgentSessionStore } from '../features/sessions/agentSessionStore'
import { useSessionDetailPolling } from '../features/sessions/useSessionDetailPolling'
import { useSessionLiveStream } from '../features/sessions/useSessionLiveStream'
import { useLocale } from '../../hooks/useLocale'
import { SessionTranscript } from '../features/sessions/SessionTranscript'

import { SessionWorkspacePanel } from '../features/sessions/SessionWorkspacePanel'
import { SessionListPanel } from '../features/sessions/SessionListPanel'
import { SessionComposer } from '../features/sessions/SessionComposer'
import { useSessionRouteSync } from '../features/sessions/useSessionRouteSync'
import { isNewSessionPath, newSessionPath, resolveAgentViewMode } from '../features/sessions/sessionRoutes'
import type { SessionListView } from '../features/sessions/sessionBuckets'
import { SkillMarketplacePanel } from '../features/skills/SkillMarketplacePanel'
import { useSessionWorkspaceStore } from '../features/sessions/sessionWorkspaceStore'

const LEFT_PANEL_DEFAULT = 260
const LEFT_PANEL_MIN = 210
const LEFT_PANEL_MAX = 420
const RIGHT_PANEL_DEFAULT = 220
const RIGHT_PANEL_MIN = 190
const RIGHT_PANEL_MAX = 420
const LEFT_PANEL_STORAGE_KEY = 'synax-sessions-left-panel'
const RIGHT_PANEL_STORAGE_KEY = 'synax-sessions-right-panel'

type PanelSide = 'left' | 'right'

function readPanelWidth(key: string, fallback: number, min: number, max: number): number {
  if (typeof window === 'undefined') return fallback
  const value = Number(window.localStorage.getItem(key))
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
      <ChevronRight size={12} />
    </button>
  )
}

const SessionDetailSidebar = memo(function SessionDetailSidebar({
  width,
  maximized,
  onResize,
  onToggleMaximize,
}: {
  width: number
  maximized: boolean
  onResize: (event: React.PointerEvent<HTMLDivElement>) => void
  onToggleMaximize: () => void
}) {
  const selectedSessionId = useAgentSessionStore(s => s.selectedSessionId)

  return (
    <aside
      className={`relative shrink-0 border-l border-border/40 bg-background/50 ${maximized ? 'min-w-0 flex-1' : 'hidden xl:block'}`}
      style={maximized ? undefined : { width }}
    >
      <SessionWorkspacePanel
        sessionId={selectedSessionId}
        maximized={maximized}
        onToggleMaximize={onToggleMaximize}
      />
      {!maximized && (
        <div className="session-panel-resizer session-panel-resizer--right" onPointerDown={onResize} role="separator" aria-orientation="vertical" />
      )}
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
  const agentViewMode = resolveAgentViewMode(location.pathname)

  useSessionRouteSync(listView, projectId)

  const agentSessionId = useAgentSessionStore(s => s.selectedSessionId)
  const agentPanelOpen = useAgentSessionStore(s => s.panelOpen)
  const workspaceMaximized = useSessionWorkspaceStore(s => s.maximized)
  const setWorkspaceMaximized = useSessionWorkspaceStore(s => s.setMaximized)

  useSessionLiveStream(agentPanelOpen ? agentSessionId : null)

  const isNewDraft = listView === 'sessions' && isNewSessionPath(location.pathname)
  const showTranscript = agentPanelOpen && agentSessionId
  const canCreateSession = listView === 'sessions' && Boolean(projectId)

  return (
    <div className="agent-page-shell flex h-full min-h-0">
      {agentViewMode === 'sessions' ? (
        <>
          <aside
            className={`session-panel-host session-panel-host--left relative shrink-0 transition-[width] duration-200 ${leftPanel.collapsed ? 'overflow-visible' : 'overflow-hidden border-r border-border/40'}`}
            data-collapsed={leftPanel.collapsed ? 'true' : undefined}
            style={{ width: leftPanel.collapsed ? 0 : leftPanel.width }}
          >
            <LeftPanelCollapseButton collapsed={leftPanel.collapsed} onToggle={() => leftPanel.setCollapsed(value => !value)} />
            {!leftPanel.collapsed && (
              <>
                <SessionListPanel listView={listView} projectId={projectId} />
                <div className="session-panel-resizer session-panel-resizer--left" onPointerDown={leftPanel.startResize} role="separator" aria-orientation="vertical" />
              </>
            )}
          </aside>

          {showTranscript ? (
            <>
              {!workspaceMaximized && (
                <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                  <SessionTranscript />
                </div>
              )}
              <SessionDetailSidebar
                width={rightPanel.width}
                maximized={workspaceMaximized}
                onResize={rightPanel.startResize}
                onToggleMaximize={() => setWorkspaceMaximized(!workspaceMaximized)}
              />
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
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
          <SkillMarketplacePanel />
        </div>
      )}
    </div>
  )
})
