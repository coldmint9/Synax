import { useEffect, useRef } from 'react'
import { useParams } from 'react-router-dom'
import { useAgentSessionStore } from './agentSessionStore'
import { AgentConversationView } from './AgentConversationView'
import { SessionGoalComposer } from './SessionGoalComposer'
import { SessionNavigationPanel } from './SessionNavigationPanel'
import { isGoalSession } from './sessionBuckets'

export function SessionTranscript() {
  const scrollRef = useRef<HTMLDivElement>(null)
  const { projectId = '' } = useParams()

  const session = useAgentSessionStore((s) => {
    const id = s.selectedSessionId
    return id ? s.sessions.find(ss => ss.id === id) : undefined
  })
  const runs = useAgentSessionStore((s) => s.runs)
  const steps = useAgentSessionStore((s) => s.steps)
  const toolCalls = useAgentSessionStore((s) => s.toolCalls)
  const messages = useAgentSessionStore((s) => s.messages)
  const childSessions = useAgentSessionStore((s) => {
    const id = s.selectedSessionId
    return id ? s.childSessions[id] : undefined
  })
  const pauseSession = useAgentSessionStore((s) => s.pauseSession)
  const resumeSession = useAgentSessionStore((s) => s.resumeSession)
  const streamingStepId = useAgentSessionStore((s) => s.streamingStepId)
  const streamingText = useAgentSessionStore((s) => s.streamingText)
  const streamingThinking = useAgentSessionStore((s) => s.streamingThinking)
  const streamingToolCalls = useAgentSessionStore((s) => s.streamingToolCalls)
  const streamingCompletedSteps = useAgentSessionStore((s) => s.streamingCompletedSteps)
  const permissions = useAgentSessionStore((s) => s.permissions)
  const replyPermission = useAgentSessionStore((s) => s.replyPermission)

  const showGoalComposer = Boolean(session && isGoalSession(session))

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [scrollRef, steps.length, messages.length, streamingText, streamingThinking, streamingToolCalls.length])

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
            streamingStepId={streamingStepId}
            streamingText={streamingText}
            streamingThinking={streamingThinking}
            streamingToolCalls={streamingToolCalls}
            streamingCompletedSteps={streamingCompletedSteps}
            permissions={permissions}
            onReplyPermission={replyPermission}
            scrollContainerRef={scrollRef}
          />
        </div>
        <SessionNavigationPanel scrollRootRef={scrollRef} />
      </div>
      {showGoalComposer && session && (
        <SessionGoalComposer session={session} projectId={projectId} />
      )}
    </div>
  )
}
