import { memo } from 'react'
import { Plus } from 'lucide-react'
import { Button } from '@heroui/react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { useAgentSessionStore } from '../features/sessions/agentSessionStore'
import { useSessionDetailPolling } from '../features/sessions/useSessionDetailPolling'
import { useSessionLiveStream } from '../features/sessions/useSessionLiveStream'
import { useLocale } from '../../hooks/useLocale'
import { SessionTranscript } from '../features/sessions/SessionTranscript'
import { SessionSystemPromptPanel } from '../features/sessions/SessionSystemPromptPanel'
import { SessionWorkspace } from '../features/sessions/SessionWorkspace'
import { SessionListPanel } from '../features/sessions/SessionListPanel'
import { SessionGoalComposer } from '../features/sessions/SessionGoalComposer'
import { useSessionRouteSync } from '../features/sessions/useSessionRouteSync'
import { isNewGoalSessionPath, newGoalSessionPath } from '../features/sessions/sessionRoutes'
import type { SessionListView } from '../features/sessions/sessionBuckets'

const SessionDetailSidebar = memo(function SessionDetailSidebar() {
  return (
    <aside className="hidden w-[220px] shrink-0 border-l border-border/40 bg-background/50 xl:block">
      <SessionSystemPromptPanel />
      <SessionWorkspace />
    </aside>
  )
})

export default memo(function SessionsPage() {
  useSessionDetailPolling()
  const { t } = useLocale()
  const navigate = useNavigate()
  const { projectId = '' } = useParams()
  const location = useLocation()
  const listView: SessionListView = location.pathname.includes('/sessions/workflows') ? 'workflow' : 'goal'

  useSessionRouteSync(listView)

  const agentSessionId = useAgentSessionStore(s => s.selectedSessionId)
  const agentPanelOpen = useAgentSessionStore(s => s.panelOpen)

  useSessionLiveStream(agentPanelOpen ? agentSessionId : null)

  const isNewDraft = listView === 'goal' && isNewGoalSessionPath(location.pathname)
  const showTranscript = agentPanelOpen && agentSessionId
  const canCreateSession = listView === 'goal' && Boolean(projectId)

  return (
    <div className="flex h-full min-h-0">
      <aside className="w-[260px] shrink-0 border-r border-border/40 overflow-hidden">
        <SessionListPanel listView={listView} projectId={projectId} />
      </aside>

      {showTranscript ? (
        <>
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            <SessionTranscript />
          </div>
          <SessionDetailSidebar />
        </>
      ) : isNewDraft ? (
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <SessionGoalComposer projectId={projectId} layout="centered" />
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
              onPress={() => navigate(newGoalSessionPath(projectId))}
            >
              <Plus size={14} />
              {t('sessionNew')}
            </Button>
          ) : null}
        </div>
      )}
    </div>
  )
})
