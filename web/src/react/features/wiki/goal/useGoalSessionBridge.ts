import { useEffect } from 'react'
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
  const status = goalSession.status
  const isChat = goalDockState === 'expanded'

  useEffect(() => {
    if (!sessionId) return

    const releaseLive = addSessionLiveListener(sessionId, (event) => {
      useWikiStore.setState(s => ({
        goalSession: applyGoalLiveEvent(s.goalSession, event),
      }))

      const selected = useDebugConsole.getState().selectedSessionId
      if (selected === sessionId) {
        useDebugConsole.getState().applyLiveEvent(event)
      }
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
            if (useWikiStore.getState().goalDockState === 'working') {
              useWikiStore.getState().setGoalDockState('expanded')
            }
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

  useEffect(() => {
    if (status === 'waiting_permission' && goalDockState === 'working') {
      useWikiStore.getState().setGoalDockState('expanded')
    }
  }, [status, goalDockState])
}
