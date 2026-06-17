import { useEffect, useRef } from 'react'
import { useParams } from 'react-router-dom'
import { useShallow } from 'zustand/react/shallow'
import { useAgentSessionStore } from './agentSessionStore'
import { AgentConversationView } from './AgentConversationView'
import { SessionGoalComposer } from './SessionGoalComposer'
import { SessionLiveTurn } from './SessionLiveTurn'
import { SessionNavigationPanel } from './SessionNavigationPanel'
import { isGoalSession } from './sessionBuckets'

function useSessionTranscriptStatic() {
  return useAgentSessionStore(useShallow(s => {
    const id = s.selectedSessionId
    return {
      session: id ? s.sessions.find(ss => ss.id === id) : undefined,
      runs: s.runs,
      steps: s.steps,
      toolCalls: s.toolCalls,
      messages: s.messages,
      childSessions: id ? s.childSessions[id] : undefined,
      streamingStepId: s.streamingStepId,
      pauseSession: s.pauseSession,
      resumeSession: s.resumeSession,
    }
  }))
}

function useSessionLiveState() {
  return useAgentSessionStore(useShallow(s => ({
    steps: s.steps,
    streamingStepId: s.streamingStepId,
    streamingText: s.streamingText,
    streamingThinking: s.streamingThinking,
    streamingToolCalls: s.streamingToolCalls,
    streamingCompletedSteps: s.streamingCompletedSteps,
    permissions: s.permissions,
    replyPermission: s.replyPermission,
  })))
}

function SessionLiveTurnLayer({
  scrollContainerRef,
}: {
  scrollContainerRef: React.RefObject<HTMLDivElement | null>
}) {
  const liveState = useSessionLiveState()
  return (
    <SessionLiveTurn
      steps={liveState.steps}
      streamingStepId={liveState.streamingStepId}
      streamingText={liveState.streamingText}
      streamingThinking={liveState.streamingThinking}
      streamingToolCalls={liveState.streamingToolCalls}
      streamingCompletedSteps={liveState.streamingCompletedSteps}
      permissions={liveState.permissions}
      onReplyPermission={liveState.replyPermission}
      scrollContainerRef={scrollContainerRef}
    />
  )
}

export function SessionTranscript() {
  const scrollRef = useRef<HTMLDivElement>(null)
  const { projectId = '' } = useParams()

  const {
    session,
    runs,
    steps,
    toolCalls,
    messages,
    childSessions,
    streamingStepId,
    pauseSession,
    resumeSession,
  } = useSessionTranscriptStatic()

  const showGoalComposer = Boolean(session && isGoalSession(session))
  const streamingStep = streamingStepId ? steps.find(s => s.id === streamingStepId) : undefined
  const showLiveBlock = Boolean(streamingStepId) && (!streamingStep || streamingStep.status === 'running')

  useEffect(() => {
    if (!scrollRef.current) return
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [session?.id])

  return (
    <div className="session-chat flex min-h-0 flex-1 flex-col">
      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} className="h-full overflow-y-auto">
          <AgentConversationView
            session={session}
            runs={runs}
            steps={steps}
            toolCalls={toolCalls}
            messages={messages}
            childSessions={childSessions}
            onPause={pauseSession}
            onResume={(id) => resumeSession(id)}
            excludeStepId={showLiveBlock ? streamingStepId : null}
            liveTurn={<SessionLiveTurnLayer scrollContainerRef={scrollRef} />}
          />
        </div>
        <SessionNavigationPanel scrollRootRef={scrollRef} />
      </div>
      {showGoalComposer && session ? (
        <SessionGoalComposer session={session} projectId={projectId} />
      ) : null}
    </div>
  )
}
