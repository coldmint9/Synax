import { useEffect } from 'react'
import { agentRuntimeApi } from '../../../../lib/api/agentRuntime'
import { subscribe } from '../../../../lib/api/runtimeEventBus'
import { addSessionLiveListener } from '../../../../lib/api/sessionLiveClient'
import { useDebugConsole } from '../../debug-console/debugConsoleStore'
import { useWikiStore } from '../../../state/wikiStore'
import {
  applyGoalLiveEvent,
  applyGoalSessionPatch,
  fetchGoalSessionPermissions,
} from './goalSessionStream'

export function useGoalSessionBridge(_projectId: string) {
  const goalSession = useWikiStore(s => s.goalSession)
  const goalDockState = useWikiStore(s => s.goalDockState)
  const sessionId = goalSession.sessionId
  const isChat = goalDockState === 'expanded'

  useEffect(() => {
    if (!sessionId) return

    void agentRuntimeApi.getSession(sessionId).then(({ session }) => {
      useWikiStore.setState(s => {
        if (s.goalSession.sessionId !== sessionId) return s
        return {
          goalSession: {
            ...s.goalSession,
            title: session.title ?? s.goalSession.title,
          },
        }
      })
    }).catch(() => {})

    const releaseLive = addSessionLiveListener(sessionId, (event) => {
      useWikiStore.setState(s => ({
        goalSession: applyGoalLiveEvent(s.goalSession, event),
      }))
    })

    return releaseLive
  }, [sessionId])

  useEffect(() => {
    if (!sessionId) return

    return subscribe({
      events: {
        session_changed: (event) => {
          const data = JSON.parse(event.data) as {
            sessionId: string
            patch?: Record<string, unknown>
          }
          if (data.sessionId !== sessionId || !data.patch) return

          useWikiStore.setState(s => ({
            goalSession: applyGoalSessionPatch(s.goalSession, data.patch!),
          }))

          const nextStatus = data.patch.status
          if (nextStatus === 'waiting_permission') {
            void fetchGoalSessionPermissions(sessionId).then(items => {
              useWikiStore.setState(s => ({
                goalSession: { ...s.goalSession, permissions: items },
              }))
            })
          }
          if (nextStatus === 'running') {
            void fetchGoalSessionPermissions(sessionId).then(items => {
              useWikiStore.setState(s => ({
                goalSession: { ...s.goalSession, permissions: items },
              }))
            })
          }

          const selected = useDebugConsole.getState().selectedSessionId
          if (selected === sessionId) {
            void useDebugConsole.getState().refreshDetail()
          }
        },
        session_step_completed: (event) => {
          const data = JSON.parse(event.data) as { sessionId: string }
          if (data.sessionId !== sessionId) return
          const selected = useDebugConsole.getState().selectedSessionId
          if (selected === sessionId) {
            void useDebugConsole.getState().refreshDetail()
          }
        },
      },
    })
  }, [sessionId])

  useEffect(() => {
    if (!sessionId || !isChat) return
    void fetchGoalSessionPermissions(sessionId).then(items => {
      useWikiStore.setState(s => ({
        goalSession: { ...s.goalSession, permissions: items },
      }))
    })
  }, [sessionId, isChat])
}
